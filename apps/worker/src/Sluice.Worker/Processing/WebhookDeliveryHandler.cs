using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Sluice.Worker.Data;
using Sluice.Worker.Diagnostics;
using Sluice.Worker.Models;
using Sluice.Worker.Security;

namespace Sluice.Worker.Processing;

public sealed class WebhookDeliveryHandler(
    WorkerRepository repository,
    EnvelopeCrypto crypto,
    SafeHttpTransport transport,
    WorkerMetrics metrics) : IJobHandler
{
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
            "Idempotency-Key",
            "X-Sluice-Event-Id"
        };

    public bool CanHandle(string jobType) =>
        jobType is "webhook.process" or "process_webhook" or "deliver_event";

    public async Task HandleAsync(ClaimedJob job, CancellationToken cancellationToken)
    {
        var bundle = await repository.LoadDeliveryBundleAsync(job, cancellationToken);
        byte[]? payload = null;
        try
        {
            payload = crypto.Decrypt(
                bundle.Event.RawBodyEnvelope,
                EnvelopeCrypto.WebhookBodyContext(
                    job.TenantId,
                    bundle.Event.SourceId,
                    bundle.Event.ExternalEventIdHash),
                bundle.Event.KeyVersion);
            var calculatedHash = SHA256.HashData(payload);
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(
                    calculatedHash,
                    bundle.Event.PayloadHash))
                {
                    throw new PermanentJobException(
                        "payload_hash_mismatch",
                        "The decrypted webhook payload failed its integrity check.");
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(calculatedHash);
            }

            foreach (var destination in bundle.Destinations)
            {
                await DeliverAsync(job, bundle.Event, destination, payload, cancellationToken);
            }
        }
        catch (CryptographicException error)
        {
            throw new PermanentJobException(
                "decrypt_failed",
                "An encrypted event or destination configuration could not be authenticated.",
                error);
        }
        finally
        {
            if (payload is not null)
            {
                CryptographicOperations.ZeroMemory(payload);
            }
            CryptographicOperations.ZeroMemory(bundle.Event.RawBodyEnvelope);
            foreach (var destination in bundle.Destinations)
            {
                CryptographicOperations.ZeroMemory(destination.ConfigEnvelope);
            }
        }
    }

    private async Task DeliverAsync(
        ClaimedJob job,
        WebhookEventData webhookEvent,
        DestinationData destination,
        byte[] payload,
        CancellationToken cancellationToken)
    {
        if (destination.AllowedHosts.Count == 0)
        {
            throw new PermanentJobException(
                "destination_allowlist_empty",
                "The destination has no outbound host allowlist.");
        }

        var effectKey = $"deliver:{webhookEvent.EventId:D}:{destination.DestinationId:D}";
        var effect = await repository.ReserveDeliveryEffectAsync(
            job,
            destination.DestinationId,
            effectKey,
            cancellationToken);
        if (string.Equals(effect.Status, "applied", StringComparison.Ordinal))
        {
            return;
        }

        byte[]? configBytes = null;
        try
        {
            configBytes = crypto.Decrypt(
                destination.ConfigEnvelope,
                EnvelopeCrypto.DestinationContext(job.TenantId, destination.DestinationId),
                destination.KeyVersion);
            using var config = JsonDocument.Parse(configBytes);
            using var request = BuildRequest(
                config.RootElement,
                webhookEvent,
                destination,
                payload,
                effectKey);

            HttpResponseMessage response;
            try
            {
                metrics.OutboundRequest();
                response = await transport.SendAsync(
                    request,
                    destination.AllowedHosts,
                    TimeSpan.FromMilliseconds(destination.TimeoutMilliseconds),
                    cancellationToken);
            }
            catch (HttpRequestException error)
            {
                throw new RetryableJobException(
                    "destination_unreachable",
                    "The destination could not be reached safely.",
                    error);
            }
            catch (TimeoutException error)
            {
                throw new RetryableJobException(
                    "destination_timeout",
                    "The destination exceeded its configured timeout.",
                    error);
            }

            using (response)
            {
                var code = (int)response.StatusCode;
                if (response.IsSuccessStatusCode)
                {
                    var referenceHash = HashExternalReference(response);
                    try
                    {
                        if (!await repository.MarkDeliveryEffectAppliedAsync(
                            job.TenantId,
                            effect.EffectId,
                            referenceHash,
                            code,
                            cancellationToken))
                        {
                            throw new RetryableJobException(
                                "effect_fencing_failed",
                                "The delivery succeeded but its effect ledger was not advanced.");
                        }
                    }
                    finally
                    {
                        if (referenceHash is not null)
                        {
                            CryptographicOperations.ZeroMemory(referenceHash);
                        }
                    }
                    return;
                }

                if (response.StatusCode is HttpStatusCode.RequestTimeout or
                    HttpStatusCode.TooManyRequests ||
                    code == 425 ||
                    code >= 500)
                {
                    throw new RetryableJobException(
                        $"destination_http_{code}",
                        "The destination returned a retryable HTTP status.");
                }

                throw new PermanentJobException(
                    $"destination_http_{code}",
                    "The destination rejected the webhook delivery.");
            }
        }
        catch (JsonException error)
        {
            throw new PermanentJobException(
                "destination_config_invalid",
                "The encrypted destination configuration is invalid.",
                error);
        }
        finally
        {
            if (configBytes is not null)
            {
                CryptographicOperations.ZeroMemory(configBytes);
            }
        }
    }

    private static HttpRequestMessage BuildRequest(
        JsonElement config,
        WebhookEventData webhookEvent,
        DestinationData destination,
        byte[] payload,
        string idempotencyKey)
    {
        if (config.ValueKind != JsonValueKind.Object ||
            !config.TryGetProperty("url", out var urlProperty) ||
            urlProperty.ValueKind != JsonValueKind.String ||
            !Uri.TryCreate(urlProperty.GetString(), UriKind.Absolute, out var uri))
        {
            throw new PermanentJobException(
                "destination_url_invalid",
                "The destination configuration has no valid URL.");
        }

        var methodName =
            config.TryGetProperty("method", out var methodProperty) &&
            methodProperty.ValueKind == JsonValueKind.String
                ? methodProperty.GetString()?.ToUpperInvariant()
                : "POST";
        if (methodName is not ("POST" or "PUT" or "PATCH"))
        {
            throw new PermanentJobException(
                "destination_method_invalid",
                "The destination HTTP method is not allowed.");
        }

        var request = new HttpRequestMessage(new HttpMethod(methodName), uri)
        {
            Content = new ByteArrayContent(payload)
        };
        request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        request.Headers.TryAddWithoutValidation("X-Sluice-Event-Id", webhookEvent.EventId.ToString("D"));

        var contentType =
            config.TryGetProperty("contentType", out var contentTypeProperty) &&
            contentTypeProperty.ValueKind == JsonValueKind.String
                ? contentTypeProperty.GetString()
                : webhookEvent.ContentType;
        if (!MediaTypeHeaderValue.TryParse(contentType, out var parsedContentType))
        {
            request.Dispose();
            throw new PermanentJobException(
                "destination_content_type_invalid",
                "The destination content type is invalid.");
        }
        request.Content.Headers.ContentType = parsedContentType;

        if (config.TryGetProperty("headers", out var headers))
        {
            if (headers.ValueKind != JsonValueKind.Object)
            {
                request.Dispose();
                throw new PermanentJobException(
                    "destination_headers_invalid",
                    "The destination headers must be an object.");
            }
            foreach (var header in headers.EnumerateObject())
            {
                if (ForbiddenHeaders.Contains(header.Name) ||
                    header.Value.ValueKind != JsonValueKind.String ||
                    ContainsLineBreak(header.Value.GetString()!) ||
                    !request.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString()))
                {
                    request.Dispose();
                    throw new PermanentJobException(
                        "destination_header_rejected",
                        "The destination configuration contains a prohibited header.");
                }
            }
        }

        try
        {
            SsrfGuard.ValidateUri(uri, destination.AllowedHosts);
        }
        catch (HttpRequestException error)
        {
            request.Dispose();
            throw new PermanentJobException(
                "destination_ssrf_rejected",
                "The destination URL violates the outbound network policy.",
                error);
        }
        return request;
    }

    private static bool ContainsLineBreak(string value) =>
        value.Contains('\r', StringComparison.Ordinal) ||
        value.Contains('\n', StringComparison.Ordinal);

    private static byte[]? HashExternalReference(HttpResponseMessage response)
    {
        var reference = response.Headers.Location?.ToString() ?? response.Headers.ETag?.Tag;
        if (string.IsNullOrEmpty(reference))
        {
            return null;
        }
        return SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(reference));
    }
}
