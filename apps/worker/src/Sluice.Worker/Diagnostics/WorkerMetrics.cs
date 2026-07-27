using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Sluice.Worker.Diagnostics;

public sealed class WorkerMetrics
{
    private readonly ConcurrentDictionary<string, long> _completed = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _failed = new(StringComparer.Ordinal);
    private long _claimed;
    private long _lostLeases;
    private long _outboundRequests;
    private long _notifications;
    private long _active;
    private long _lastClaimUnixSeconds;

    public void Claimed(int count)
    {
        Interlocked.Add(ref _claimed, count);
        Interlocked.Exchange(ref _lastClaimUnixSeconds, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    }

    public IDisposable TrackActive()
    {
        Interlocked.Increment(ref _active);
        return new ActiveLease(this);
    }

    public void Completed(string jobType) =>
        _completed.AddOrUpdate(Normalize(jobType), 1, static (_, current) => current + 1);

    public void Failed(string code) =>
        _failed.AddOrUpdate(Normalize(code), 1, static (_, current) => current + 1);

    public void LostLease() => Interlocked.Increment(ref _lostLeases);
    public void OutboundRequest() => Interlocked.Increment(ref _outboundRequests);
    public void Notification() => Interlocked.Increment(ref _notifications);

    public string RenderPrometheus()
    {
        var output = new StringBuilder(1_024);
        Append(output, "sluice_worker_jobs_claimed_total", Interlocked.Read(ref _claimed));
        Append(output, "sluice_worker_jobs_active", Interlocked.Read(ref _active));
        Append(output, "sluice_worker_leases_lost_total", Interlocked.Read(ref _lostLeases));
        Append(output, "sluice_worker_outbound_requests_total", Interlocked.Read(ref _outboundRequests));
        Append(output, "sluice_worker_notifications_total", Interlocked.Read(ref _notifications));
        Append(
            output,
            "sluice_worker_last_claim_timestamp_seconds",
            Interlocked.Read(ref _lastClaimUnixSeconds));
        foreach (var pair in _completed.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
        {
            output.Append("sluice_worker_jobs_completed_total{job_type=\"")
                .Append(pair.Key)
                .Append("\"} ")
                .Append(pair.Value.ToString(CultureInfo.InvariantCulture))
                .Append('\n');
        }
        foreach (var pair in _failed.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
        {
            output.Append("sluice_worker_jobs_failed_total{code=\"")
                .Append(pair.Key)
                .Append("\"} ")
                .Append(pair.Value.ToString(CultureInfo.InvariantCulture))
                .Append('\n');
        }
        return output.ToString();
    }

    private static void Append(StringBuilder output, string name, long value) =>
        output.Append(name)
            .Append(' ')
            .Append(value.ToString(CultureInfo.InvariantCulture))
            .Append('\n');

    private static string Normalize(string value)
    {
        var result = new string(
            value.Take(96)
                .Select(static character =>
                    char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '-'
                        ? character
                        : '_')
                .ToArray());
        return result.Length == 0 ? "unknown" : result;
    }

    private sealed class ActiveLease : IDisposable
    {
        private WorkerMetrics? _owner;

        public ActiveLease(WorkerMetrics owner) => _owner = owner;

        public void Dispose()
        {
            var owner = Interlocked.Exchange(ref _owner, null);
            if (owner is not null)
            {
                Interlocked.Decrement(ref owner._active);
            }
        }
    }
}
