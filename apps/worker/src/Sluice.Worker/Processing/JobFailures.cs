namespace Sluice.Worker.Processing;

public abstract class JobFailureException(string code, string safeMessage, Exception? inner = null)
    : Exception(safeMessage, inner)
{
    public string Code { get; } = code;
    public string SafeMessage { get; } = safeMessage;
}

public sealed class RetryableJobException(string code, string safeMessage, Exception? inner = null)
    : JobFailureException(code, safeMessage, inner);

public sealed class PermanentJobException(string code, string safeMessage, Exception? inner = null)
    : JobFailureException(code, safeMessage, inner);

public enum JobCompletionState
{
    Completed,
    RetryScheduled,
    DeadLettered,
    LostLease
}

public static class JobStateRules
{
    public static JobCompletionState FromDatabaseResult(string result) =>
        result switch
        {
            "pending" => JobCompletionState.RetryScheduled,
            "dead_letter" => JobCompletionState.DeadLettered,
            "lost_lease" => JobCompletionState.LostLease,
            _ => throw new InvalidOperationException("The database returned an unknown job state.")
        };

    public static bool IsSupportedHandler(string jobType) =>
        jobType is "webhook.process" or "process_webhook" or "deliver_event" or
            "reconcile_provider";
}

public static class RetryBackoff
{
    public static int BaseDelaySeconds(int deliveryCount)
    {
        var exponent = Math.Clamp(deliveryCount - 1, 0, 30);
        return (int)Math.Min(3_600L, 5L << exponent);
    }

    public static TimeSpan PollFailureDelay(int consecutiveFailures, double jitterSample)
    {
        if (jitterSample is < 0 or >= 1)
        {
            throw new ArgumentOutOfRangeException(nameof(jitterSample));
        }
        var baseMilliseconds = Math.Min(30_000, 250 * (1 << Math.Clamp(consecutiveFailures, 0, 7)));
        return TimeSpan.FromMilliseconds(baseMilliseconds + (baseMilliseconds * 0.2 * jitterSample));
    }
}
