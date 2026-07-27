using System.Text.Json;

namespace Sluice.Worker.Models;

public sealed record ClaimedJob(
    Guid JobId,
    Guid TenantId,
    Guid? EventId,
    Guid? PipelineId,
    Guid? DestinationId,
    string JobType,
    string IdempotencyKey,
    short Priority,
    int DeliveryCount,
    short MaxAttempts,
    JsonDocument Arguments,
    Guid LeaseToken,
    DateTimeOffset LeaseExpiresAt,
    DateTimeOffset CreatedAt) : IDisposable
{
    public void Dispose() => Arguments.Dispose();
}

public sealed record WebhookEventData(
    Guid EventId,
    Guid SourceId,
    string ProviderEventType,
    byte[] ExternalEventIdHash,
    byte[] RawBodyEnvelope,
    byte[] PayloadHash,
    int KeyVersion,
    string ContentType);

public sealed record DestinationData(
    Guid DestinationId,
    Guid PipelineId,
    string Kind,
    byte[] ConfigEnvelope,
    int KeyVersion,
    IReadOnlySet<string> AllowedHosts,
    int TimeoutMilliseconds);

public sealed record DeliveryBundle(
    WebhookEventData Event,
    IReadOnlyList<DestinationData> Destinations);

public sealed record DeliveryEffect(Guid EffectId, string Status, bool Acquired);

public sealed record ReconciliationSourceData(
    Guid SourceId,
    string Provider,
    byte[] ConfigEnvelope,
    int KeyVersion,
    byte[]? CursorEnvelope,
    int? CursorKeyVersion);

public sealed record ClaimedNotification(
    Guid NotificationId,
    Guid TenantId,
    Guid? JobId,
    string Channel,
    string TemplateKey,
    JsonDocument Payload,
    Guid LeaseToken) : IDisposable
{
    public void Dispose() => Payload.Dispose();
}
