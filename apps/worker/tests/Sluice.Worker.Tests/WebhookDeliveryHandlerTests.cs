using Sluice.Worker.Models;
using Sluice.Worker.Processing;

namespace Sluice.Worker.Tests;

public sealed class WebhookDeliveryHandlerTests
{
    [Fact]
    public void RejectsDeliveryBundleWithoutActiveDestinations()
    {
        var bundle = new DeliveryBundle(
            new WebhookEventData(
                Guid.NewGuid(),
                Guid.NewGuid(),
                "test.event",
                [],
                [],
                [],
                1,
                "application/json"),
            []);

        var failure = Assert.Throws<PermanentJobException>(
            () => WebhookDeliveryHandler.EnsureActiveDestinations(bundle));

        Assert.Equal("no_active_destinations", failure.Code);
        Assert.Equal("No active destinations match this delivery job.", failure.SafeMessage);
    }

    [Fact]
    public void AcceptsDeliveryBundleWithAnActiveDestination()
    {
        var bundle = new DeliveryBundle(
            new WebhookEventData(
                Guid.NewGuid(),
                Guid.NewGuid(),
                "test.event",
                [],
                [],
                [],
                1,
                "application/json"),
            [
                new DestinationData(
                    Guid.NewGuid(),
                    Guid.NewGuid(),
                    "webhook",
                    [],
                    1,
                    new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "example.com" },
                    5_000)
            ]);

        WebhookDeliveryHandler.EnsureActiveDestinations(bundle);
    }
}
