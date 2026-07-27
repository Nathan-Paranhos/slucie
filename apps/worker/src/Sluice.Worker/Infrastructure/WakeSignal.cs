using System.Threading.Channels;

namespace Sluice.Worker.Infrastructure;

public sealed class WakeSignal
{
    private readonly Channel<bool> _jobs = CreateChannel();
    private readonly Channel<bool> _notifications = CreateChannel();

    public void SignalJobs() => _jobs.Writer.TryWrite(true);
    public void SignalNotifications() => _notifications.Writer.TryWrite(true);

    public Task WaitForJobsAsync(TimeSpan timeout, CancellationToken cancellationToken) =>
        WaitAsync(_jobs.Reader, timeout, cancellationToken);

    public Task WaitForNotificationsAsync(TimeSpan timeout, CancellationToken cancellationToken) =>
        WaitAsync(_notifications.Reader, timeout, cancellationToken);

    private static Channel<bool> CreateChannel() =>
        Channel.CreateBounded<bool>(
            new BoundedChannelOptions(1)
            {
                SingleReader = false,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.DropWrite
            });

    private static async Task WaitAsync(
        ChannelReader<bool> reader,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            await reader.ReadAsync(timeoutSource.Token);
            while (reader.TryRead(out _))
            {
            }
        }
        catch (OperationCanceledException) when (
            !cancellationToken.IsCancellationRequested &&
            timeoutSource.IsCancellationRequested)
        {
        }
    }
}
