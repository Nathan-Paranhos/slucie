using Sluice.Worker.Infrastructure;

namespace Sluice.Worker.Tests;

public sealed class PostgresNotificationRouterTests
{
    [Fact]
    public async Task RoutesJobNotifications()
    {
        var wakeSignal = new WakeSignal();
        var observed = wakeSignal.WaitForJobsAsync(
            TimeSpan.FromSeconds(1),
            CancellationToken.None);

        Assert.True(PostgresNotificationRouter.Route("sluice_jobs", wakeSignal));
        await observed;
    }

    [Fact]
    public async Task RoutesOutboxNotifications()
    {
        var wakeSignal = new WakeSignal();
        var observed = wakeSignal.WaitForNotificationsAsync(
            TimeSpan.FromSeconds(1),
            CancellationToken.None);

        Assert.True(
            PostgresNotificationRouter.Route("sluice_notifications", wakeSignal));
        await observed;
    }

    [Fact]
    public void IgnoresUnknownChannels()
    {
        var wakeSignal = new WakeSignal();

        Assert.False(PostgresNotificationRouter.Route("other_channel", wakeSignal));
    }
}
