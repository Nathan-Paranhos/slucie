using Sluice.Worker.Processing;

namespace Sluice.Worker.Tests;

public sealed class JobStateTests
{
    [Theory]
    [InlineData("pending", JobCompletionState.RetryScheduled)]
    [InlineData("dead_letter", JobCompletionState.DeadLettered)]
    [InlineData("lost_lease", JobCompletionState.LostLease)]
    public void MapsDatabaseFailureStates(string databaseState, JobCompletionState expected) =>
        Assert.Equal(expected, JobStateRules.FromDatabaseResult(databaseState));

    [Theory]
    [InlineData("webhook.process")]
    [InlineData("process_webhook")]
    [InlineData("deliver_event")]
    [InlineData("reconcile_provider")]
    public void RecognizesSupportedHandlers(string jobType) =>
        Assert.True(JobStateRules.IsSupportedHandler(jobType));

    [Fact]
    public void RejectsUnknownDatabaseState() =>
        Assert.Throws<InvalidOperationException>(
            () => JobStateRules.FromDatabaseResult("completed"));
}
