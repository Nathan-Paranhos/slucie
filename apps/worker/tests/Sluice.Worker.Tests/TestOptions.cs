using Sluice.Worker.Configuration;

namespace Sluice.Worker.Tests;

internal static class TestOptions
{
    public static WorkerOptions Create(byte[] key, int version = 1) =>
        new()
        {
            DatabaseConnectionString = "Host=localhost;Database=test;Username=test;Password=test",
            WorkerId = "test-worker",
            ActiveKeyVersion = version,
            MasterKeys = new Dictionary<int, byte[]> { [version] = key }
        };
}
