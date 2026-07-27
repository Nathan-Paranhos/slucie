using StackExchange.Redis;
using Sluice.Worker.Configuration;

namespace Sluice.Worker.Infrastructure;

public sealed class RedisWakeSubscriber(
    WorkerOptions options,
    WakeSignal wakeSignal,
    ILogger<RedisWakeSubscriber> logger) : BackgroundService
{
    private volatile bool _connected;
    public bool Connected => _connected;
    public bool Configured => options.RedisConnectionString is not null;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (options.RedisConnectionString is null)
        {
            logger.LogInformation("Redis wake-up subscriber is disabled; polling remains active");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var configuration = ConfigurationOptions.Parse(options.RedisConnectionString);
                configuration.AbortOnConnectFail = false;
                configuration.ConnectRetry = 2;
                configuration.ConnectTimeout = 3_000;
                configuration.SyncTimeout = 3_000;
                configuration.ClientName = options.WorkerId;
                await using var connection =
                    await ConnectionMultiplexer.ConnectAsync(configuration);
                var subscriber = connection.GetSubscriber();
                await subscriber.SubscribeAsync(
                    RedisChannel.Literal("sluice_jobs"),
                    (_, _) => wakeSignal.SignalJobs());
                await subscriber.SubscribeAsync(
                    RedisChannel.Literal("sluice_notifications"),
                    (_, _) => wakeSignal.SignalNotifications());
                _connected = true;
                logger.LogInformation("Redis wake-up subscriber connected");

                var disconnected = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                connection.ConnectionFailed += (_, _) => disconnected.TrySetResult();
                await disconnected.Task.WaitAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                logger.LogWarning(
                    "Redis wake-up unavailable; polling continues (exception_type={ExceptionType})",
                    error.GetType().Name);
            }
            finally
            {
                _connected = false;
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }
}
