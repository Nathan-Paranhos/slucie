using Npgsql;
using Sluice.Worker.Processing;

namespace Sluice.Worker.Infrastructure;

public sealed class PostgresWakeSubscriber(
    NpgsqlDataSource dataSource,
    WakeSignal wakeSignal,
    ILogger<PostgresWakeSubscriber> logger) : BackgroundService
{
    private volatile bool _connected;
    public bool Connected => _connected;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var connection =
                    await dataSource.OpenConnectionAsync(stoppingToken);
                connection.Notification += OnNotification;
                try
                {
                    await using var listen = new NpgsqlCommand(
                        "LISTEN sluice_jobs; LISTEN sluice_notifications;",
                        connection);
                    await listen.ExecuteNonQueryAsync(stoppingToken);
                    failures = 0;
                    _connected = true;
                    logger.LogInformation("PostgreSQL LISTEN/NOTIFY wake-up subscriber connected");

                    while (!stoppingToken.IsCancellationRequested)
                    {
                        await connection.WaitAsync(stoppingToken);
                    }
                }
                finally
                {
                    connection.Notification -= OnNotification;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                failures++;
                logger.LogWarning(
                    "PostgreSQL LISTEN/NOTIFY unavailable; polling continues (exception_type={ExceptionType}, failures={Failures})",
                    error.GetType().Name,
                    failures);
            }
            finally
            {
                _connected = false;
            }

            try
            {
                await Task.Delay(
                    RetryBackoff.PollFailureDelay(failures, Random.Shared.NextDouble()),
                    stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }

        void OnNotification(object sender, NpgsqlNotificationEventArgs eventArgs)
        {
            PostgresNotificationRouter.Route(eventArgs.Channel, wakeSignal);
        }
    }
}

public static class PostgresNotificationRouter
{
    public static bool Route(string channel, WakeSignal wakeSignal)
    {
        switch (channel)
        {
            case "sluice_jobs":
                wakeSignal.SignalJobs();
                return true;
            case "sluice_notifications":
                wakeSignal.SignalNotifications();
                return true;
            default:
                return false;
        }
    }
}
