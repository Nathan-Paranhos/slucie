using System.Collections.Concurrent;
using Npgsql;
using Sluice.Worker.Configuration;
using Sluice.Worker.Data;
using Sluice.Worker.Diagnostics;
using Sluice.Worker.Infrastructure;
using Sluice.Worker.Models;

namespace Sluice.Worker.Processing;

public sealed class JobPumpService(
    WorkerOptions options,
    WorkerRepository repository,
    JobDispatcher dispatcher,
    WakeSignal wakeSignal,
    WorkerMetrics metrics,
    ILogger<JobPumpService> logger) : BackgroundService
{
    private readonly ConcurrentDictionary<Guid, Task> _inFlight = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var claimFailures = 0;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                RemoveCompleted();
                var capacity = options.Concurrency - _inFlight.Count;
                if (capacity <= 0)
                {
                    await WaitForCapacityAsync(stoppingToken);
                    continue;
                }

                IReadOnlyList<ClaimedJob> jobs;
                try
                {
                    // This call is intentionally not cancelled mid-claim. It is a
                    // short transaction and every committed claim must be handed
                    // to a processor, including during a shutdown race.
                    jobs = await repository.ClaimJobsAsync(
                        options.WorkerId,
                        Math.Min(options.ClaimBatchSize, capacity),
                        options.LeaseSeconds,
                        CancellationToken.None);
                    claimFailures = 0;
                }
                catch (Exception error) when (error is NpgsqlException or TimeoutException)
                {
                    claimFailures++;
                    logger.LogWarning(
                        "Job claim failed; retrying (exception_type={ExceptionType}, failures={Failures})",
                        error.GetType().Name,
                        claimFailures);
                    var delay = RetryBackoff.PollFailureDelay(
                        claimFailures,
                        Random.Shared.NextDouble());
                    await DelaySafelyAsync(delay, stoppingToken);
                    continue;
                }

                if (jobs.Count == 0)
                {
                    await wakeSignal.WaitForJobsAsync(
                        TimeSpan.FromMilliseconds(options.PollIntervalMilliseconds),
                        stoppingToken);
                    continue;
                }

                metrics.Claimed(jobs.Count);
                foreach (var job in jobs)
                {
                    var task = ProcessOneAsync(job);
                    if (!_inFlight.TryAdd(job.JobId, task))
                    {
                        job.Dispose();
                        throw new InvalidOperationException("The same job was claimed twice in one worker.");
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            await DrainAsync();
        }
    }

    private async Task ProcessOneAsync(ClaimedJob job)
    {
        try
        {
            using (job)
            using (metrics.TrackActive())
            using (logger.BeginScope(
                new Dictionary<string, object>
                {
                    ["job_id"] = job.JobId,
                    ["tenant_id"] = job.TenantId,
                    ["job_type"] = job.JobType,
                    ["delivery_count"] = job.DeliveryCount
                }))
            using (var leaseLost = new CancellationTokenSource())
            using (var heartbeatStop = new CancellationTokenSource())
            {
                var heartbeat = MaintainLeaseAsync(job, leaseLost, heartbeatStop.Token);
                try
                {
                    await dispatcher.DispatchAsync(job, leaseLost.Token);
                    if (leaseLost.IsCancellationRequested)
                    {
                        metrics.LostLease();
                        logger.LogWarning("Job handler stopped after its lease was lost");
                        return;
                    }

                    if (await repository.CompleteJobAsync(job, CancellationToken.None))
                    {
                        metrics.Completed(job.JobType);
                        logger.LogInformation("Job completed");
                    }
                    else
                    {
                        metrics.LostLease();
                        logger.LogWarning("Job result discarded because the lease fence rejected completion");
                    }
                }
                catch (OperationCanceledException) when (leaseLost.IsCancellationRequested)
                {
                    metrics.LostLease();
                    logger.LogWarning("Job cancelled after lease loss");
                }
                catch (PermanentJobException failure)
                {
                    metrics.Failed(failure.Code);
                    var state = await repository.DeadLetterJobAsync(
                        job,
                        failure.Code,
                        failure.SafeMessage,
                        CancellationToken.None);
                    LogFailureState(failure.Code, state);
                }
                catch (RetryableJobException failure)
                {
                    metrics.Failed(failure.Code);
                    var state = await repository.FailJobAsync(
                        job,
                        failure.Code,
                        failure.SafeMessage,
                        RetryBackoff.BaseDelaySeconds(job.DeliveryCount),
                        CancellationToken.None);
                    LogFailureState(failure.Code, state);
                }
                catch (Exception error)
                {
                    const string code = "handler_unexpected";
                    metrics.Failed(code);
                    logger.LogError(
                        "Job handler failed unexpectedly (exception_type={ExceptionType})",
                        error.GetType().Name);
                    var state = await repository.FailJobAsync(
                        job,
                        code,
                        "The handler failed unexpectedly.",
                        RetryBackoff.BaseDelaySeconds(job.DeliveryCount),
                        CancellationToken.None);
                    LogFailureState(code, state);
                }
                finally
                {
                    heartbeatStop.Cancel();
                    try
                    {
                        await heartbeat;
                    }
                    catch (OperationCanceledException)
                    {
                    }
                }
            }
        }
        catch (Exception error)
        {
            // A database outage while fencing the result must not fault the
            // pump. The still-processing row is recovered by lease expiry.
            logger.LogError(
                "Job processor could not persist its terminal state (job_id={JobId}, tenant_id={TenantId}, exception_type={ExceptionType})",
                job.JobId,
                job.TenantId,
                error.GetType().Name);
        }
    }

    private async Task MaintainLeaseAsync(
        ClaimedJob job,
        CancellationTokenSource leaseLost,
        CancellationToken cancellationToken)
    {
        var knownExpiry = job.LeaseExpiresAt;
        while (!cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(options.HeartbeatSeconds), cancellationToken);
            try
            {
                if (await repository.HeartbeatJobAsync(
                    job,
                    options.LeaseSeconds,
                    cancellationToken))
                {
                    knownExpiry = DateTimeOffset.UtcNow.AddSeconds(options.LeaseSeconds);
                    continue;
                }
                leaseLost.Cancel();
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error) when (error is NpgsqlException or TimeoutException)
            {
                logger.LogWarning(
                    "Job heartbeat failed (exception_type={ExceptionType})",
                    error.GetType().Name);
                if (DateTimeOffset.UtcNow >= knownExpiry)
                {
                    leaseLost.Cancel();
                    return;
                }
            }
        }
    }

    private void LogFailureState(string code, JobCompletionState state)
    {
        if (state == JobCompletionState.LostLease)
        {
            metrics.LostLease();
        }
        logger.LogWarning("Job failed (code={FailureCode}, resulting_state={State})", code, state);
    }

    private async Task WaitForCapacityAsync(CancellationToken cancellationToken)
    {
        var snapshot = _inFlight.Values.ToArray();
        if (snapshot.Length == 0)
        {
            return;
        }
        await Task.WhenAny(
            Task.WhenAny(snapshot),
            Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken));
    }

    private void RemoveCompleted()
    {
        foreach (var pair in _inFlight)
        {
            if (pair.Value.IsCompleted)
            {
                _inFlight.TryRemove(pair.Key, out _);
            }
        }
    }

    private async Task DrainAsync()
    {
        RemoveCompleted();
        var remaining = _inFlight.Values.ToArray();
        if (remaining.Length == 0)
        {
            return;
        }

        logger.LogInformation(
            "Stopping claims and draining in-flight jobs (count={Count}, timeout_seconds={Timeout})",
            remaining.Length,
            options.DrainSeconds);
        try
        {
            await Task.WhenAll(remaining)
                .WaitAsync(TimeSpan.FromSeconds(options.DrainSeconds));
            logger.LogInformation("Graceful worker drain completed");
        }
        catch (TimeoutException)
        {
            logger.LogWarning(
                "Graceful drain deadline reached; remaining jobs will be recovered by lease expiry");
        }
    }

    private static async Task DelaySafelyAsync(
        TimeSpan delay,
        CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(delay, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }
}
