using Sluice.Worker.Processing;

namespace Sluice.Worker.Tests;

public sealed class BackoffTests
{
    [Theory]
    [InlineData(1, 5)]
    [InlineData(2, 10)]
    [InlineData(3, 20)]
    [InlineData(8, 640)]
    [InlineData(20, 3600)]
    public void RetryBaseMatchesDatabaseContract(int deliveryCount, int expectedSeconds) =>
        Assert.Equal(expectedSeconds, RetryBackoff.BaseDelaySeconds(deliveryCount));

    [Fact]
    public void PollFailureBackoffIsBoundedAndJittered()
    {
        var low = RetryBackoff.PollFailureDelay(5, 0);
        var high = RetryBackoff.PollFailureDelay(5, 0.999);

        Assert.Equal(TimeSpan.FromSeconds(8), low);
        Assert.InRange(high.TotalMilliseconds, 8_000, 9_600);
        Assert.InRange(
            RetryBackoff.PollFailureDelay(100, 0.999).TotalMilliseconds,
            30_000,
            36_000);
    }

    [Theory]
    [InlineData(-0.1)]
    [InlineData(1.0)]
    public void RejectsInvalidJitterSamples(double sample) =>
        Assert.Throws<ArgumentOutOfRangeException>(
            () => RetryBackoff.PollFailureDelay(1, sample));
}
