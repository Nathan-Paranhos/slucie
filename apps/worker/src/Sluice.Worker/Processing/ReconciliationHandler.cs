using System.Security.Cryptography;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Sluice.Worker.Configuration;
using Sluice.Worker.Data;
using Sluice.Worker.Diagnostics;
using Sluice.Worker.Models;
using Sluice.Worker.Security;

namespace Sluice.Worker.Processing;

public sealed class ReconciliationHandler(
    WorkerOptions options,
    WorkerRepository repository,
    EnvelopeCrypto crypto,
    SafeHttpTransport transport,
    WorkerMetrics metrics) : IJobHandler
{
    private const int MaxResponseBytes = 2 * 1024 * 1024;
    private static readonly HashSet<string> ForbiddenHeaders =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "Host",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
            "Keep-Alive",
            "Upgrade",
            "Proxy-Authorization",
            "Proxy-Authenticate",
            "Idempotency-Key"
        };

    public bool CanHandle(string jobType) => jobType == "reconcile_provider";

    public async Task HandleAsync(ClaimedJob job, CancellationToken cancellationToken)
    {
        var sourceId = ReadSourceId(job.Arguments.RootElement);
        ReconciliationSourceData? source = null;
        byte[]? sourceConfig = null;
        byte[]? cursor = null;
        try
        {
            source = await repository.LoadReconciliationSourceAsync(
                job.TenantId,
                sourceId,
                cancellationToken);
            if (!options.ReconciliationEndpoints.TryGetValue(source.Provider, out var fixedEndpoint))
            {
                throw new PermanentJobException(
                    "reconciliation_endpoint_missing",
                    "No fixed endpoint is configured for this provider.");
            }

            sourceConfig = crypto.Decrypt(
                source.ConfigEnvelope,
                EnvelopeCrypto.SourceConfigContext(job.TenantId, source.SourceId),
                source.KeyVersion);
            using var configuration = JsonDocument.Parse(sourceConfig);
            var reconciliation = ReadReconciliationConfig(configuration.RootElement);

            if (source.CursorEnvelope is not null)
            {
                if (source.CursorKeyVersion is null)
                {
                    throw new PermanentJobException(
                        "checkpoint_key_missing",
                        "The reconciliation checkpoint has inconsistent encryption metadata.");
                }
                cursor = crypto.Decrypt(
                    source.CursorEnvelope,
                    EnvelopeCrypto.ReconciliationCursorContext(job.TenantId, source.SourceId),
                    source.CursorKeyVersion);
            }

            var target = BuildTargetUri(
                fixedEndpoint,
                reconciliation,
                cursor is null ? null : Encoding.UTF8.GetString(cursor),
                job.Arguments.RootElement);
            var allowedHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                fixedEndpoint.IdnHost
            };
            using var request = BuildRequest(
                target,
                reconciliation,
                $"reconcile:{job.JobId:D}");

            HttpResponseMessage response;
            try
            {
                metrics.OutboundRequest();
                response = await transport.SendAsync(
                    request,
                    allowedHosts,
                    TimeSpan.FromMilliseconds(reconciliation.TimeoutMilliseconds),
                    cancellationToken);
            }
            catch (HttpRequestException error)
            {
                throw new RetryableJobException(
                    "reconciliation_unreachable",
                    "The provider reconciliation endpoint could not be reached safely.",
                    error);
            }
            catch (TimeoutException error)
            {
                throw new RetryableJobException(
                    "reconciliation_timeout",
                    "The provider reconciliation request exceeded its deadline.",
                    error);
            }

            byte[]? nextCursorEnvelope = null;
            try
            {
                using (response)
                {
                    var statusCode = (int)response.StatusCode;
                    if (!response.IsSuccessStatusCode)
                    {
                        if (statusCode is 408 or 425 or 429 || statusCode >= 500)
                        {
                            throw new RetryableJobException(
                                $"reconciliation_http_{statusCode}",
                                "The provider returned a retryable reconciliation status.");
                        }
                        throw new PermanentJobException(
                            $"reconciliation_http_{statusCode}",
                            "The provider rejected the reconciliation request.");
                    }

                    var responseBytes = await ReadBoundedAsync(
                        await response.Content.ReadAsStreamAsync(cancellationToken),
                        MaxResponseBytes,
                        cancellationToken);
                    try
                    {
                        var nextCursor = ReadNextCursor(
                            responseBytes,
                            reconciliation.NextCursorProperty);
                        if (nextCursor is not null)
                        {
                            var nextCursorBytes = Encoding.UTF8.GetBytes(nextCursor);
                            try
                            {
                                nextCursorEnvelope = crypto.Encrypt(
                                    nextCursorBytes,
                                    EnvelopeCrypto.ReconciliationCursorContext(
                                        job.TenantId,
                                        source.SourceId));
                            }
                            finally
                            {
                                CryptographicOperations.ZeroMemory(nextCursorBytes);
                            }
                        }
                    }
                    finally
                    {
                        CryptographicOperations.ZeroMemory(responseBytes);
                    }
                }

                if (!await repository.UpdateReconciliationCheckpointAsync(
                    job.TenantId,
                    source.SourceId,
                    nextCursorEnvelope,
                    nextCursorEnvelope is null ? null : options.ActiveKeyVersion,
                    succeeded: true,
                    safeError: null,
                    cancellationToken))
                {
                    throw new RetryableJobException(
                        "checkpoint_not_updated",
                        "The reconciliation checkpoint no longer exists.");
                }
            }
            finally
            {
                if (nextCursorEnvelope is not null)
                {
                    CryptographicOperations.ZeroMemory(nextCursorEnvelope);
                }
            }
        }
        catch (JobFailureException error)
        {
            if (source is not null)
            {
                await TryRecordFailureAsync(job.TenantId, source.SourceId, error, cancellationToken);
            }
            throw;
        }
        catch (JsonException error)
        {
            var failure = new PermanentJobException(
                "reconciliation_config_invalid",
                "The encrypted reconciliation configuration is invalid.",
                error);
            if (source is not null)
            {
                await TryRecordFailureAsync(job.TenantId, source.SourceId, failure, cancellationToken);
            }
            throw failure;
        }
        catch (CryptographicException error)
        {
            var failure = new PermanentJobException(
                "reconciliation_decrypt_failed",
                "The reconciliation configuration or checkpoint could not be authenticated.",
                error);
            if (source is not null)
            {
                await TryRecordFailureAsync(job.TenantId, source.SourceId, failure, cancellationToken);
            }
            throw failure;
        }
        finally
        {
            if (sourceConfig is not null)
            {
                CryptographicOperations.ZeroMemory(sourceConfig);
            }
            if (cursor is not null)
            {
                CryptographicOperations.ZeroMemory(cursor);
            }
            if (source is not null)
            {
                CryptographicOperations.ZeroMemory(source.ConfigEnvelope);
                if (source.CursorEnvelope is not null)
                {
                    CryptographicOperations.ZeroMemory(source.CursorEnvelope);
                }
            }
        }
    }

    private async Task TryRecordFailureAsync(
        Guid tenantId,
        Guid sourceId,
        JobFailureException failure,
        CancellationToken cancellationToken)
    {
        try
        {
            await repository.UpdateReconciliationCheckpointAsync(
                tenantId,
                sourceId,
                cursorEnvelope: null,
                keyVersion: null,
                succeeded: false,
                safeError: $"{failure.Code}: {failure.SafeMessage}",
                cancellationToken);
        }
        catch
        {
            // The job state transition remains the source of truth when the
            // advisory checkpoint error cannot be recorded.
        }
    }

    private static Guid ReadSourceId(JsonElement arguments)
    {
        if (arguments.ValueKind != JsonValueKind.Object ||
            !arguments.TryGetProperty("source_id", out var property) ||
            property.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(property.GetString(), out var sourceId))
        {
            throw new PermanentJobException(
                "source_id_invalid",
                "The reconciliation job has no valid source identifier.");
        }
        return sourceId;
    }

    private static ReconciliationConfig ReadReconciliationConfig(JsonElement root)
    {
        if (!root.TryGetProperty("provider", out var provider) ||
            provider.ValueKind != JsonValueKind.Object ||
            !provider.TryGetProperty("reconciliation", out var reconciliation) ||
            reconciliation.ValueKind != JsonValueKind.Object)
        {
            throw new PermanentJobException(
                "reconciliation_config_missing",
                "The source has no reconciliation configuration.");
        }

        var path = RequiredString(reconciliation, "path");
        if (Uri.TryCreate(path, UriKind.Absolute, out _) ||
            path.StartsWith("//", StringComparison.Ordinal))
        {
            throw new PermanentJobException(
                "reconciliation_path_invalid",
                "The reconciliation path must be relative to its fixed provider endpoint.");
        }

        var method = OptionalString(reconciliation, "method")?.ToUpperInvariant() ?? "GET";
        if (method is not ("GET" or "POST"))
        {
            throw new PermanentJobException(
                "reconciliation_method_invalid",
                "The reconciliation HTTP method is not allowed.");
        }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (reconciliation.TryGetProperty("headers", out var headerObject))
        {
            if (headerObject.ValueKind != JsonValueKind.Object)
            {
                throw new PermanentJobException(
                    "reconciliation_headers_invalid",
                    "Reconciliation headers must be an object.");
            }
            foreach (var header in headerObject.EnumerateObject())
            {
                if (ForbiddenHeaders.Contains(header.Name) ||
                    header.Value.ValueKind != JsonValueKind.String ||
                    ContainsLineBreak(header.Value.GetString()!))
                {
                    throw new PermanentJobException(
                        "reconciliation_header_rejected",
                        "The reconciliation configuration contains a prohibited header.");
                }
                headers.Add(header.Name, header.Value.GetString()!);
            }
        }

        return new ReconciliationConfig(
            path,
            method,
            headers,
            OptionalString(reconciliation, "cursorQueryParameter"),
            OptionalString(reconciliation, "windowStartQueryParameter"),
            OptionalString(reconciliation, "windowEndQueryParameter"),
            OptionalString(reconciliation, "nextCursorProperty") ?? "next_cursor",
            OptionalInteger(reconciliation, "timeoutMs", 10_000, 100, 120_000));
    }

    private static Uri BuildTargetUri(
        Uri fixedEndpoint,
        ReconciliationConfig config,
        string? cursor,
        JsonElement arguments)
    {
        var target = new Uri(fixedEndpoint, config.Path);
        if (!string.Equals(target.IdnHost, fixedEndpoint.IdnHost, StringComparison.OrdinalIgnoreCase) ||
            target.Scheme != Uri.UriSchemeHttps ||
            target.Port != fixedEndpoint.Port)
        {
            throw new PermanentJobException(
                "reconciliation_target_changed",
                "The reconciliation path escaped its fixed provider endpoint.");
        }

        var query = new List<KeyValuePair<string, string>>();
        if (!string.IsNullOrEmpty(cursor) && config.CursorQueryParameter is not null)
        {
            query.Add(new(config.CursorQueryParameter, cursor));
        }
        AddTimeArgument(query, arguments, "window_start", config.WindowStartQueryParameter);
        AddTimeArgument(query, arguments, "window_end", config.WindowEndQueryParameter);
        if (query.Count == 0)
        {
            return target;
        }

        var builder = new UriBuilder(target);
        var existing = builder.Query.TrimStart('?');
        var appended = string.Join(
            "&",
            query.Select(static pair =>
                $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));
        builder.Query = string.IsNullOrEmpty(existing) ? appended : $"{existing}&{appended}";
        return builder.Uri;
    }

    private static void AddTimeArgument(
        ICollection<KeyValuePair<string, string>> query,
        JsonElement arguments,
        string argumentName,
        string? queryName)
    {
        if (queryName is null ||
            !arguments.TryGetProperty(argumentName, out var value) ||
            value.ValueKind != JsonValueKind.String ||
            !DateTimeOffset.TryParse(
                value.GetString(),
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var timestamp))
        {
            return;
        }
        query.Add(new(queryName, timestamp.ToString("O", CultureInfo.InvariantCulture)));
    }

    private static HttpRequestMessage BuildRequest(
        Uri target,
        ReconciliationConfig config,
        string idempotencyKey)
    {
        var request = new HttpRequestMessage(new HttpMethod(config.Method), target);
        request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        foreach (var header in config.Headers)
        {
            if (!request.Headers.TryAddWithoutValidation(header.Key, header.Value))
            {
                request.Dispose();
                throw new PermanentJobException(
                    "reconciliation_header_invalid",
                    "A reconciliation header could not be represented safely.");
            }
        }
        if (config.Method == "POST")
        {
            request.Content = new ByteArrayContent([]);
        }
        return request;
    }

    private static string? ReadNextCursor(byte[] response, string propertyName)
    {
        using var document = JsonDocument.Parse(response);
        if (document.RootElement.ValueKind != JsonValueKind.Object ||
            !document.RootElement.TryGetProperty(propertyName, out var value) ||
            value.ValueKind == JsonValueKind.Null)
        {
            return null;
        }
        var cursor = value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : value.GetRawText();
        if (string.IsNullOrEmpty(cursor))
        {
            return null;
        }
        if (Encoding.UTF8.GetByteCount(cursor) > 4_096)
        {
            throw new PermanentJobException(
                "reconciliation_cursor_too_large",
                "The provider cursor exceeds the supported limit.");
        }
        return cursor;
    }

    private static async Task<byte[]> ReadBoundedAsync(
        Stream stream,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        try
        {
            while (true)
            {
                var read = await stream.ReadAsync(chunk, cancellationToken);
                if (read == 0)
                {
                    return buffer.ToArray();
                }
                if (buffer.Length + read > maximumBytes)
                {
                    throw new PermanentJobException(
                        "reconciliation_response_too_large",
                        "The provider response exceeds the supported limit.");
                }
                buffer.Write(chunk, 0, read);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(chunk);
        }
    }

    private static string RequiredString(JsonElement element, string propertyName) =>
        OptionalString(element, propertyName)
        ?? throw new PermanentJobException(
            "reconciliation_config_invalid",
            $"The reconciliation configuration is missing {propertyName}.");

    private static string? OptionalString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var property) &&
        property.ValueKind == JsonValueKind.String &&
        !string.IsNullOrWhiteSpace(property.GetString())
            ? property.GetString()
            : null;

    private static bool ContainsLineBreak(string value) =>
        value.Contains('\r', StringComparison.Ordinal) ||
        value.Contains('\n', StringComparison.Ordinal);

    private static int OptionalInteger(
        JsonElement element,
        string propertyName,
        int fallback,
        int minimum,
        int maximum)
    {
        if (!element.TryGetProperty(propertyName, out var property))
        {
            return fallback;
        }
        if (!property.TryGetInt32(out var value) || value < minimum || value > maximum)
        {
            throw new PermanentJobException(
                "reconciliation_config_invalid",
                $"The reconciliation configuration has an invalid {propertyName}.");
        }
        return value;
    }

    private sealed record ReconciliationConfig(
        string Path,
        string Method,
        IReadOnlyDictionary<string, string> Headers,
        string? CursorQueryParameter,
        string? WindowStartQueryParameter,
        string? WindowEndQueryParameter,
        string NextCursorProperty,
        int TimeoutMilliseconds);
}
