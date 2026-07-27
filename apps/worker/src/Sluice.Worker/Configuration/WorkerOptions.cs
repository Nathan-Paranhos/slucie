using System.Text.Json;
using System.Globalization;
using System.Security.Cryptography;
using Npgsql;

namespace Sluice.Worker.Configuration;

public sealed class WorkerOptions
{
    public required string DatabaseConnectionString { get; init; }
    public string? RedisConnectionString { get; init; }
    public required string WorkerId { get; init; }
    public int Concurrency { get; init; } = 16;
    public int ClaimBatchSize { get; init; } = 20;
    public int LeaseSeconds { get; init; } = 60;
    public int HeartbeatSeconds { get; init; } = 20;
    public int PollIntervalMilliseconds { get; init; } = 2_000;
    public int DrainSeconds { get; init; } = 30;
    public string DiagnosticsUrl { get; init; } = "http://0.0.0.0:8080";
    public string? MetricsBearerToken { get; init; }
    public int ActiveKeyVersion { get; init; }
    public required IReadOnlyDictionary<int, byte[]> MasterKeys { get; init; }
    public IReadOnlyDictionary<string, Uri> ReconciliationEndpoints { get; init; } =
        new Dictionary<string, Uri>(StringComparer.Ordinal);
    public Uri? NotificationWebhookEndpoint { get; init; }
    public Uri? NotificationEmailEndpoint { get; init; }
    public IReadOnlySet<string> NotificationAllowedHosts { get; init; } =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    public int NotificationTimeoutMilliseconds { get; init; } = 10_000;

    public static WorkerOptions FromEnvironment()
    {
        var database = BuildDatabaseConnectionString();
        var concurrency = Integer("WORKER_CONCURRENCY", 16, 1, 500);
        var batch = Integer("WORKER_CLAIM_BATCH_SIZE", 20, 1, 500);
        var lease = Integer("WORKER_LEASE_SECONDS", 60, 10, 3_600);
        var heartbeat = Integer("WORKER_HEARTBEAT_SECONDS", Math.Max(5, lease / 3), 5, 3_600);
        if (heartbeat >= lease)
        {
            throw new InvalidOperationException("WORKER_HEARTBEAT_SECONDS must be lower than WORKER_LEASE_SECONDS.");
        }

        var keyring = ParseKeyring();
        var activeVersion = Integer(
            "SLUICE_ACTIVE_KEY_VERSION",
            Integer("SLUICE_MASTER_KEY_VERSION", 1, 1, int.MaxValue),
            1,
            int.MaxValue);
        if (!keyring.ContainsKey(activeVersion))
        {
            throw new InvalidOperationException("The active encryption key version is absent from the keyring.");
        }

        var endpoints = ParseEndpointMap(
            Environment.GetEnvironmentVariable("WORKER_RECONCILIATION_ENDPOINTS_JSON"));
        var webhook = OptionalHttpsUri("WORKER_NOTIFICATION_WEBHOOK_URL");
        var email = OptionalHttpsUri("WORKER_NOTIFICATION_EMAIL_URL");
        var notificationHosts = ParseHosts(
            Environment.GetEnvironmentVariable("WORKER_NOTIFICATION_ALLOWED_HOSTS"));
        if (webhook is not null)
        {
            notificationHosts.Add(webhook.IdnHost);
        }
        if (email is not null)
        {
            notificationHosts.Add(email.IdnHost);
        }

        return new WorkerOptions
        {
            DatabaseConnectionString = database,
            RedisConnectionString = EmptyToNull(Environment.GetEnvironmentVariable("REDIS_URL")),
            WorkerId = BuildWorkerId(Environment.GetEnvironmentVariable("WORKER_ID")),
            Concurrency = concurrency,
            ClaimBatchSize = Math.Min(batch, concurrency),
            LeaseSeconds = lease,
            HeartbeatSeconds = heartbeat,
            PollIntervalMilliseconds = Integer("WORKER_POLL_INTERVAL_MS", 2_000, 100, 60_000),
            DrainSeconds = Integer("WORKER_DRAIN_SECONDS", 30, 1, 300),
            DiagnosticsUrl =
                EmptyToNull(Environment.GetEnvironmentVariable("WORKER_DIAGNOSTICS_URL"))
                ?? "http://0.0.0.0:8080",
            MetricsBearerToken =
                EmptyToNull(Environment.GetEnvironmentVariable("WORKER_METRICS_BEARER_TOKEN")),
            ActiveKeyVersion = activeVersion,
            MasterKeys = keyring,
            ReconciliationEndpoints = endpoints,
            NotificationWebhookEndpoint = webhook,
            NotificationEmailEndpoint = email,
            NotificationAllowedHosts = notificationHosts,
            NotificationTimeoutMilliseconds =
                Integer("WORKER_NOTIFICATION_TIMEOUT_MS", 10_000, 100, 120_000)
        };
    }

    private static Dictionary<int, byte[]> ParseKeyring()
    {
        var result = new Dictionary<int, byte[]>();
        var raw = EmptyToNull(Environment.GetEnvironmentVariable("SLUICE_MASTER_KEYS"));
        if (raw is not null)
        {
            foreach (var entry in raw.Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                var separator = entry.IndexOf(':', StringComparison.Ordinal);
                if (separator <= 0 ||
                    !int.TryParse(entry.AsSpan(0, separator), out var version) ||
                    version <= 0)
                {
                    throw new InvalidOperationException(
                        "SLUICE_MASTER_KEYS entries must use positive-version:base64.");
                }
                AddKey(result, version, entry[(separator + 1)..]);
            }
        }
        else
        {
            var version = Integer("SLUICE_MASTER_KEY_VERSION", 1, 1, int.MaxValue);
            AddKey(result, version, Required("SLUICE_MASTER_KEY_BASE64"));
        }

        return result;
    }

    private static string BuildDatabaseConnectionString()
    {
        var connectionString = Required("SLUICE_WORKER_DATABASE_URL");
        var tls = OptionalBoolean("DATABASE_SSL", false);
        if (!tls)
        {
            return connectionString;
        }

        var rootCertificate = Required("DATABASE_SSL_CA_FILE");
        try
        {
            using var stream = File.Open(
                rootCertificate,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read);
            if (stream.Length == 0)
            {
                throw new InvalidOperationException(
                    "DATABASE_SSL_CA_FILE must point to a non-empty readable CA certificate.");
            }
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new InvalidOperationException(
                "DATABASE_SSL_CA_FILE must point to a non-empty readable CA certificate.",
                error);
        }

        var builder = new NpgsqlConnectionStringBuilder(connectionString)
        {
            SslMode = SslMode.VerifyFull,
            RootCertificate = rootCertificate
        };
        builder.Remove("Trust Server Certificate");
        return builder.ConnectionString;
    }

    private static void AddKey(IDictionary<int, byte[]> result, int version, string encoded)
    {
        byte[] key;
        try
        {
            key = Convert.FromBase64String(encoded);
        }
        catch (FormatException error)
        {
            throw new InvalidOperationException("An encryption key is not valid Base64.", error);
        }

        if (key.Length != 32 || !result.TryAdd(version, key))
        {
            CryptographicOperations.ZeroMemory(key);
            throw new InvalidOperationException(
                "Every encryption key must be unique and contain exactly 32 decoded bytes.");
        }
    }

    private static Dictionary<string, Uri> ParseEndpointMap(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new Dictionary<string, Uri>(StringComparer.Ordinal);
        }

        var values = JsonSerializer.Deserialize<Dictionary<string, string>>(raw)
            ?? throw new InvalidOperationException(
                "WORKER_RECONCILIATION_ENDPOINTS_JSON must be a JSON object.");
        var result = new Dictionary<string, Uri>(StringComparer.Ordinal);
        foreach (var pair in values)
        {
            if (!Uri.TryCreate(pair.Value, UriKind.Absolute, out var uri) ||
                uri.Scheme != Uri.UriSchemeHttps ||
                !string.IsNullOrEmpty(uri.UserInfo))
            {
                throw new InvalidOperationException(
                    $"The fixed reconciliation endpoint for '{pair.Key}' must be an HTTPS URL.");
            }
            result.Add(pair.Key, uri);
        }
        return result;
    }

    private static HashSet<string> ParseHosts(string? raw) =>
        new(
            (raw ?? string.Empty)
                .Split([',', ';'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Select(static value => new IdnMapping().GetAscii(value).ToLowerInvariant()),
            StringComparer.OrdinalIgnoreCase);

    private static Uri? OptionalHttpsUri(string name)
    {
        var value = EmptyToNull(Environment.GetEnvironmentVariable(name));
        if (value is null)
        {
            return null;
        }
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(uri.UserInfo))
        {
            throw new InvalidOperationException($"{name} must be an absolute HTTPS URL.");
        }
        return uri;
    }

    private static int Integer(string name, int fallback, int minimum, int maximum)
    {
        var raw = EmptyToNull(Environment.GetEnvironmentVariable(name));
        if (raw is null)
        {
            return fallback;
        }
        if (!int.TryParse(raw, out var value) || value < minimum || value > maximum)
        {
            throw new InvalidOperationException($"{name} must be between {minimum} and {maximum}.");
        }
        return value;
    }

    private static bool OptionalBoolean(string name, bool fallback)
    {
        var raw = EmptyToNull(Environment.GetEnvironmentVariable(name));
        if (raw is null)
        {
            return fallback;
        }
        if (!bool.TryParse(raw, out var value))
        {
            throw new InvalidOperationException($"{name} must be true or false.");
        }
        return value;
    }

    private static string Required(string name) =>
        EmptyToNull(Environment.GetEnvironmentVariable(name))
        ?? throw new InvalidOperationException($"{name} is required.");

    private static string BuildWorkerId(string? configured)
    {
        var prefix = EmptyToNull(configured) ?? Environment.MachineName;
        var safe = new string(prefix.Where(static c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_').ToArray());
        if (safe.Length == 0)
        {
            safe = "worker";
        }
        var candidate =
            $"{safe[..Math.Min(safe.Length, 48)]}-{Environment.ProcessId}-{Guid.NewGuid():N}";
        return candidate[..Math.Min(96, candidate.Length)];
    }

    private static string? EmptyToNull(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
