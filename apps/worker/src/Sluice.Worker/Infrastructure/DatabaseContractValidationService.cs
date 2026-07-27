using Sluice.Worker.Data;

namespace Sluice.Worker.Infrastructure;

public sealed class DatabaseContractValidationService(
    WorkerRepository repository,
    ILogger<DatabaseContractValidationService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await repository.ValidateContractAsync(cancellationToken);
        logger.LogInformation("PostgreSQL worker contract validated");
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
