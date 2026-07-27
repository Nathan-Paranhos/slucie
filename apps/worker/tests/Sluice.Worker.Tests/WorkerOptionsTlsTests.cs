using Npgsql;
using Sluice.Worker.Configuration;

namespace Sluice.Worker.Tests;

public sealed class WorkerOptionsTlsTests
{
    private static readonly object EnvironmentLock = new();

    [Fact]
    public void TlsForcesVerifyFullAndDisablesTrustServerCertificate()
    {
        lock (EnvironmentLock)
        {
            var certificatePath = Path.GetTempFileName();
            try
            {
                File.WriteAllText(certificatePath, "validation-ca");
                using var environment = new EnvironmentScope(
                    RequiredEnvironment(
                        databaseSsl: "true",
                        caFile: certificatePath,
                        databaseUrl:
                            "Host=postgres;Database=sluice;Username=worker;Password=test;" +
                            "Trust Server Certificate=true"));

                var options = WorkerOptions.FromEnvironment();
                var connection = new NpgsqlConnectionStringBuilder(
                    options.DatabaseConnectionString);

                Assert.Equal(SslMode.VerifyFull, connection.SslMode);
                Assert.Equal(certificatePath, connection.RootCertificate);
                Assert.False(connection.ShouldSerialize("Trust Server Certificate"));
            }
            finally
            {
                File.Delete(certificatePath);
            }
        }
    }

    [Fact]
    public void TlsRequiresAReadableNonEmptyCaFile()
    {
        lock (EnvironmentLock)
        {
            var certificatePath = Path.GetTempFileName();
            try
            {
                using var environment = new EnvironmentScope(
                    RequiredEnvironment("true", certificatePath));

                var error = Assert.Throws<InvalidOperationException>(
                    WorkerOptions.FromEnvironment);

                Assert.Contains("non-empty readable CA", error.Message);
            }
            finally
            {
                File.Delete(certificatePath);
            }
        }
    }

    [Fact]
    public void PlaintextDevelopmentConfigurationIsPreservedWhenTlsIsDisabled()
    {
        lock (EnvironmentLock)
        {
            const string databaseUrl =
                "Host=localhost;Database=sluice;Username=worker;Password=test;SSL Mode=Disable";
            using var environment = new EnvironmentScope(
                RequiredEnvironment("false", null, databaseUrl));

            var options = WorkerOptions.FromEnvironment();
            var connection = new NpgsqlConnectionStringBuilder(
                options.DatabaseConnectionString);

            Assert.Equal(SslMode.Disable, connection.SslMode);
        }
    }

    private static Dictionary<string, string?> RequiredEnvironment(
        string databaseSsl,
        string? caFile,
        string databaseUrl =
            "Host=postgres;Database=sluice;Username=worker;Password=test")
    {
        return new Dictionary<string, string?>
        {
            ["SLUICE_WORKER_DATABASE_URL"] = databaseUrl,
            ["SLUICE_MASTER_KEYS"] =
                $"1:{Convert.ToBase64String(new byte[32])}",
            ["SLUICE_ACTIVE_KEY_VERSION"] = "1",
            ["DATABASE_SSL"] = databaseSsl,
            ["DATABASE_SSL_CA_FILE"] = caFile
        };
    }

    private sealed class EnvironmentScope : IDisposable
    {
        private readonly Dictionary<string, string?> _previous = [];

        public EnvironmentScope(IReadOnlyDictionary<string, string?> values)
        {
            foreach (var pair in values)
            {
                _previous[pair.Key] = Environment.GetEnvironmentVariable(pair.Key);
                Environment.SetEnvironmentVariable(pair.Key, pair.Value);
            }
        }

        public void Dispose()
        {
            foreach (var pair in _previous)
            {
                Environment.SetEnvironmentVariable(pair.Key, pair.Value);
            }
        }
    }
}
