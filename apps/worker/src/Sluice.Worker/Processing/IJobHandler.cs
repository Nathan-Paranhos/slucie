using Sluice.Worker.Models;

namespace Sluice.Worker.Processing;

public interface IJobHandler
{
    bool CanHandle(string jobType);
    Task HandleAsync(ClaimedJob job, CancellationToken cancellationToken);
}

public sealed class JobDispatcher(IEnumerable<IJobHandler> handlers)
{
    private readonly IReadOnlyList<IJobHandler> _handlers = handlers.ToArray();

    public Task DispatchAsync(ClaimedJob job, CancellationToken cancellationToken)
    {
        var handler = _handlers.FirstOrDefault(candidate => candidate.CanHandle(job.JobType));
        if (handler is null)
        {
            throw new PermanentJobException(
                "handler_not_found",
                "No worker handler is registered for this job type.");
        }
        return handler.HandleAsync(job, cancellationToken);
    }
}
