using System.Data;
using System.Globalization;
using System.Text.Json;
using Npgsql;
using NpgsqlTypes;
using Sluice.Worker.Models;
using Sluice.Worker.Processing;

namespace Sluice.Worker.Data;

public sealed class WorkerRepository(NpgsqlDataSource dataSource)
{
    private static readonly string[] RequiredFunctions =
    [
        "sluice.claim_jobs(text,integer,integer,uuid)",
        "sluice.heartbeat_job(uuid,uuid,uuid,integer)",
        "sluice.complete_job(uuid,uuid,uuid)",
        "sluice.fail_job(uuid,uuid,uuid,text,text,integer)",
        "sluice.dead_letter_job(uuid,uuid,uuid,text,text)",
        "sluice.reserve_delivery_effect(uuid,uuid,uuid,text)",
        "sluice.mark_delivery_effect_applied(uuid,uuid,bytea,integer)",
        "sluice.update_reconciliation_checkpoint(uuid,uuid,bytea,integer,boolean,text)",
        "sluice.claim_notifications(text,integer,integer)",
        "sluice.complete_notification(uuid,uuid,uuid)",
        "sluice.fail_notification(uuid,uuid,uuid,text)"
    ];

    public async Task ValidateContractAsync(CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        foreach (var signature in RequiredFunctions)
        {
            await using var command = new NpgsqlCommand(
                "SELECT to_regprocedure(@signature) IS NOT NULL",
                connection);
            command.Parameters.AddWithValue("signature", NpgsqlDbType.Text, signature);
            if (await command.ExecuteScalarAsync(cancellationToken) is not true)
            {
                throw new InvalidOperationException(
                    $"Required database function '{signature}' is missing.");
            }
        }
    }

    public async Task<IReadOnlyList<ClaimedJob>> ClaimJobsAsync(
        string workerId,
        int limit,
        int leaseSeconds,
        CancellationToken cancellationToken)
    {
        var jobs = new List<ClaimedJob>(limit);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction =
            await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand(
                """
                SELECT
                    job_id,
                    tenant_id,
                    event_id,
                    pipeline_id,
                    destination_id,
                    job_type,
                    idempotency_key,
                    priority,
                    delivery_count,
                    max_attempts,
                    arguments::text,
                    lease_token,
                    lease_expires_at,
                    created_at
                FROM sluice.claim_jobs(
                    @worker_id::text,
                    @claim_limit::integer,
                    @lease_seconds::integer,
                    NULL::uuid
                )
                """,
                connection,
                transaction);
            command.Parameters.AddWithValue("worker_id", NpgsqlDbType.Text, workerId);
            command.Parameters.AddWithValue("claim_limit", NpgsqlDbType.Integer, limit);
            command.Parameters.AddWithValue("lease_seconds", NpgsqlDbType.Integer, leaseSeconds);

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                jobs.Add(new ClaimedJob(
                    reader.GetGuid(0),
                    reader.GetGuid(1),
                    reader.IsDBNull(2) ? null : reader.GetGuid(2),
                    reader.IsDBNull(3) ? null : reader.GetGuid(3),
                    reader.IsDBNull(4) ? null : reader.GetGuid(4),
                    reader.GetString(5),
                    reader.GetString(6),
                    reader.GetInt16(7),
                    reader.GetInt32(8),
                    reader.GetInt16(9),
                    JsonDocument.Parse(reader.GetString(10)),
                    reader.GetGuid(11),
                    Utc(reader.GetDateTime(12)),
                    Utc(reader.GetDateTime(13))));
            }
            await reader.CloseAsync();
            await transaction.CommitAsync(cancellationToken);
            return jobs;
        }
        catch
        {
            foreach (var job in jobs)
            {
                job.Dispose();
            }
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public Task<bool> HeartbeatJobAsync(
        ClaimedJob job,
        int extendSeconds,
        CancellationToken cancellationToken) =>
        ExecuteBooleanFunctionAsync(
            "SELECT sluice.heartbeat_job(@tenant_id, @job_id, @lease_token, @seconds)",
            [
                Uuid("tenant_id", job.TenantId),
                Uuid("job_id", job.JobId),
                Uuid("lease_token", job.LeaseToken),
                Integer("seconds", extendSeconds)
            ],
            cancellationToken);

    public Task<bool> CompleteJobAsync(ClaimedJob job, CancellationToken cancellationToken) =>
        ExecuteBooleanFunctionAsync(
            "SELECT sluice.complete_job(@tenant_id, @job_id, @lease_token)",
            [
                Uuid("tenant_id", job.TenantId),
                Uuid("job_id", job.JobId),
                Uuid("lease_token", job.LeaseToken)
            ],
            cancellationToken);

    public async Task<JobCompletionState> FailJobAsync(
        ClaimedJob job,
        string code,
        string safeMessage,
        int baseDelaySeconds,
        CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            SELECT sluice.fail_job(
                @tenant_id,
                @job_id,
                @lease_token,
                @error_code,
                @error_message,
                @delay_seconds
            )
            """,
            connection);
        command.Parameters.Add(Uuid("tenant_id", job.TenantId));
        command.Parameters.Add(Uuid("job_id", job.JobId));
        command.Parameters.Add(Uuid("lease_token", job.LeaseToken));
        command.Parameters.Add(Text("error_code", code, 128));
        command.Parameters.Add(Text("error_message", safeMessage, 2_000));
        command.Parameters.Add(Integer("delay_seconds", Math.Clamp(baseDelaySeconds, 0, 86_400)));
        var result = await command.ExecuteScalarAsync(cancellationToken) as string
            ?? throw new InvalidOperationException("fail_job returned no state.");
        return JobStateRules.FromDatabaseResult(result);
    }

    public async Task<JobCompletionState> DeadLetterJobAsync(
        ClaimedJob job,
        string code,
        string safeMessage,
        CancellationToken cancellationToken)
    {
        var completed = await ExecuteBooleanFunctionAsync(
            """
            SELECT sluice.dead_letter_job(
                @tenant_id,
                @job_id,
                @lease_token,
                @error_code,
                @error_message
            )
            """,
            [
                Uuid("tenant_id", job.TenantId),
                Uuid("job_id", job.JobId),
                Uuid("lease_token", job.LeaseToken),
                Text("error_code", code, 128),
                Text("error_message", safeMessage, 2_000)
            ],
            cancellationToken);
        return completed ? JobCompletionState.DeadLettered : JobCompletionState.LostLease;
    }

    public async Task<DeliveryBundle> LoadDeliveryBundleAsync(
        ClaimedJob job,
        CancellationToken cancellationToken)
    {
        if (job.EventId is null)
        {
            throw new PermanentJobException("event_missing", "The delivery job has no event.");
        }

        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction =
            await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetTenantAsync(connection, transaction, job.TenantId, cancellationToken);

        WebhookEventData? webhookEvent;
        await using (var command = new NpgsqlCommand(
            """
            SELECT
                event.id,
                event.source_id,
                event.provider_event_type,
                event.external_event_id_hash,
                event.raw_body_envelope,
                event.payload_hash,
                event.key_version,
                event.content_type
            FROM sluice.webhook_events AS event
            WHERE event.tenant_id = @tenant_id
              AND event.id = @event_id
            """,
            connection,
            transaction))
        {
            command.Parameters.Add(Uuid("tenant_id", job.TenantId));
            command.Parameters.Add(Uuid("event_id", job.EventId.Value));
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new PermanentJobException("event_not_found", "The webhook event is unavailable.");
            }
            if (reader.IsDBNull(4))
            {
                throw new PermanentJobException(
                    "payload_purged",
                    "The webhook payload was removed by the retention policy.");
            }
            webhookEvent = new WebhookEventData(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetFieldValue<byte[]>(3),
                reader.GetFieldValue<byte[]>(4),
                reader.GetFieldValue<byte[]>(5),
                reader.GetInt32(6),
                reader.GetString(7));
        }

        var destinations = new List<DestinationData>();
        await using (var command = new NpgsqlCommand(
            """
            SELECT
                destination.id,
                pipeline.id,
                destination.kind,
                destination.config_envelope,
                destination.key_version,
                destination.allowed_hosts,
                destination.timeout_ms
            FROM sluice.pipelines AS pipeline
            JOIN sluice.pipeline_destinations AS link
              ON link.tenant_id = pipeline.tenant_id
             AND link.pipeline_id = pipeline.id
             AND link.enabled
            JOIN sluice.destinations AS destination
              ON destination.tenant_id = link.tenant_id
             AND destination.id = link.destination_id
            WHERE pipeline.tenant_id = @tenant_id
              AND pipeline.source_id = @source_id
              AND pipeline.status = 'active'
              AND destination.status = 'active'
              AND (
                    cardinality(pipeline.event_type_filter) = 0
                    OR @event_type = ANY(pipeline.event_type_filter)
              )
              AND (@pipeline_id::uuid IS NULL OR pipeline.id = @pipeline_id)
              AND (@destination_id::uuid IS NULL OR destination.id = @destination_id)
            ORDER BY pipeline.id, link.position, destination.id
            """,
            connection,
            transaction))
        {
            command.Parameters.Add(Uuid("tenant_id", job.TenantId));
            command.Parameters.Add(Uuid("source_id", webhookEvent.SourceId));
            command.Parameters.Add(Text("event_type", webhookEvent.ProviderEventType, 10_000));
            command.Parameters.Add(NullableUuid("pipeline_id", job.PipelineId));
            command.Parameters.Add(NullableUuid("destination_id", job.DestinationId));
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                destinations.Add(new DestinationData(
                    reader.GetGuid(0),
                    reader.GetGuid(1),
                    reader.GetString(2),
                    reader.GetFieldValue<byte[]>(3),
                    reader.GetInt32(4),
                    new HashSet<string>(
                        reader.GetFieldValue<string[]>(5)
                            .Select(static host => new IdnMapping().GetAscii(host).ToLowerInvariant()),
                        StringComparer.OrdinalIgnoreCase),
                    reader.GetInt32(6)));
            }
        }

        await transaction.CommitAsync(cancellationToken);
        return new DeliveryBundle(webhookEvent, destinations);
    }

    public async Task<DeliveryEffect> ReserveDeliveryEffectAsync(
        ClaimedJob job,
        Guid destinationId,
        string effectKey,
        CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            SELECT effect_id, effect_status, acquired
            FROM sluice.reserve_delivery_effect(
                @tenant_id,
                @job_id,
                @destination_id,
                @effect_key
            )
            """,
            connection);
        command.Parameters.Add(Uuid("tenant_id", job.TenantId));
        command.Parameters.Add(Uuid("job_id", job.JobId));
        command.Parameters.Add(Uuid("destination_id", destinationId));
        command.Parameters.Add(Text("effect_key", effectKey, 2_000));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("reserve_delivery_effect returned no row.");
        }
        return new DeliveryEffect(reader.GetGuid(0), reader.GetString(1), reader.GetBoolean(2));
    }

    public Task<bool> MarkDeliveryEffectAppliedAsync(
        Guid tenantId,
        Guid effectId,
        byte[]? externalReferenceHash,
        int responseCode,
        CancellationToken cancellationToken) =>
        ExecuteBooleanFunctionAsync(
            """
            SELECT sluice.mark_delivery_effect_applied(
                @tenant_id,
                @effect_id,
                @reference_hash,
                @response_code
            )
            """,
            [
                Uuid("tenant_id", tenantId),
                Uuid("effect_id", effectId),
                NullableBytea("reference_hash", externalReferenceHash),
                Integer("response_code", responseCode)
            ],
            cancellationToken);

    public async Task<ReconciliationSourceData> LoadReconciliationSourceAsync(
        Guid tenantId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction =
            await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetTenantAsync(connection, transaction, tenantId, cancellationToken);
        await using var command = new NpgsqlCommand(
            """
            SELECT
                source.id,
                source.provider,
                source.config_envelope,
                source.key_version,
                checkpoint.cursor_envelope,
                checkpoint.key_version
            FROM sluice.webhook_sources AS source
            LEFT JOIN sluice.reconciliation_checkpoints AS checkpoint
              ON checkpoint.tenant_id = source.tenant_id
             AND checkpoint.source_id = source.id
            WHERE source.tenant_id = @tenant_id
              AND source.id = @source_id
              AND source.status = 'active'
              AND source.reconciliation_enabled
            """,
            connection,
            transaction);
        command.Parameters.Add(Uuid("tenant_id", tenantId));
        command.Parameters.Add(Uuid("source_id", sourceId));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new PermanentJobException(
                "source_not_found",
                "The reconciliation source is unavailable.");
        }
        var result = new ReconciliationSourceData(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.IsDBNull(2)
                ? throw new PermanentJobException(
                    "source_config_missing",
                    "The reconciliation source has no encrypted configuration.")
                : reader.GetFieldValue<byte[]>(2),
            reader.GetInt32(3),
            reader.IsDBNull(4) ? null : reader.GetFieldValue<byte[]>(4),
            reader.IsDBNull(5) ? null : reader.GetInt32(5));
        await reader.CloseAsync();
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    public Task<bool> UpdateReconciliationCheckpointAsync(
        Guid tenantId,
        Guid sourceId,
        byte[]? cursorEnvelope,
        int? keyVersion,
        bool succeeded,
        string? safeError,
        CancellationToken cancellationToken) =>
        ExecuteBooleanFunctionAsync(
            """
            SELECT sluice.update_reconciliation_checkpoint(
                @tenant_id,
                @source_id,
                @cursor_envelope,
                @key_version,
                @succeeded,
                @error
            )
            """,
            [
                Uuid("tenant_id", tenantId),
                Uuid("source_id", sourceId),
                NullableBytea("cursor_envelope", cursorEnvelope),
                NullableInteger("key_version", keyVersion),
                Boolean("succeeded", succeeded),
                NullableText("error", safeError, 2_000)
            ],
            cancellationToken);

    public async Task<IReadOnlyList<ClaimedNotification>> ClaimNotificationsAsync(
        string workerId,
        int limit,
        int leaseSeconds,
        CancellationToken cancellationToken)
    {
        var notifications = new List<ClaimedNotification>();
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction =
            await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await using var command = new NpgsqlCommand(
                """
                SELECT
                    notification_id,
                    tenant_id,
                    job_id,
                    channel,
                    template_key,
                    payload::text,
                    lease_token
                FROM sluice.claim_notifications(@worker_id, @claim_limit, @lease_seconds)
                """,
                connection,
                transaction);
            command.Parameters.Add(Text("worker_id", workerId, 128));
            command.Parameters.Add(Integer("claim_limit", limit));
            command.Parameters.Add(Integer("lease_seconds", leaseSeconds));
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                notifications.Add(new ClaimedNotification(
                    reader.GetGuid(0),
                    reader.GetGuid(1),
                    reader.IsDBNull(2) ? null : reader.GetGuid(2),
                    reader.GetString(3),
                    reader.GetString(4),
                    JsonDocument.Parse(reader.GetString(5)),
                    reader.GetGuid(6)));
            }
            await reader.CloseAsync();
            await transaction.CommitAsync(cancellationToken);
            return notifications;
        }
        catch
        {
            foreach (var notification in notifications)
            {
                notification.Dispose();
            }
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    public Task<bool> CompleteNotificationAsync(
        ClaimedNotification notification,
        CancellationToken cancellationToken) =>
        ExecuteBooleanFunctionAsync(
            "SELECT sluice.complete_notification(@tenant_id, @notification_id, @lease_token)",
            [
                Uuid("tenant_id", notification.TenantId),
                Uuid("notification_id", notification.NotificationId),
                Uuid("lease_token", notification.LeaseToken)
            ],
            cancellationToken);

    public async Task<string> FailNotificationAsync(
        ClaimedNotification notification,
        string safeError,
        CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            "SELECT sluice.fail_notification(@tenant_id, @notification_id, @lease_token, @error)",
            connection);
        command.Parameters.Add(Uuid("tenant_id", notification.TenantId));
        command.Parameters.Add(Uuid("notification_id", notification.NotificationId));
        command.Parameters.Add(Uuid("lease_token", notification.LeaseToken));
        command.Parameters.Add(Text("error", safeError, 2_000));
        return await command.ExecuteScalarAsync(cancellationToken) as string
            ?? throw new InvalidOperationException("fail_notification returned no state.");
    }

    public async Task<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
            await using var command = new NpgsqlCommand("SELECT 1", connection);
            return Convert.ToInt32(
                await command.ExecuteScalarAsync(cancellationToken),
                CultureInfo.InvariantCulture) == 1;
        }
        catch (Exception error) when (
            error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            return false;
        }
    }

    private async Task<bool> ExecuteBooleanFunctionAsync(
        string sql,
        IEnumerable<NpgsqlParameter> parameters,
        CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var parameter in parameters)
        {
            command.Parameters.Add(parameter);
        }
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    private static async Task SetTenantAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid tenantId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            "SELECT set_config('app.tenant_id', @tenant_id::text, true)",
            connection,
            transaction);
        command.Parameters.Add(Uuid("tenant_id", tenantId));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static NpgsqlParameter Uuid(string name, Guid value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value };

    private static NpgsqlParameter NullableUuid(string name, Guid? value) =>
        new(name, NpgsqlDbType.Uuid) { Value = value ?? (object)DBNull.Value };

    private static NpgsqlParameter Integer(string name, int value) =>
        new(name, NpgsqlDbType.Integer) { Value = value };

    private static NpgsqlParameter NullableInteger(string name, int? value) =>
        new(name, NpgsqlDbType.Integer) { Value = value ?? (object)DBNull.Value };

    private static NpgsqlParameter Boolean(string name, bool value) =>
        new(name, NpgsqlDbType.Boolean) { Value = value };

    private static NpgsqlParameter Text(string name, string value, int maximumLength) =>
        new(name, NpgsqlDbType.Text)
        {
            Value = value.Length <= maximumLength ? value : value[..maximumLength]
        };

    private static NpgsqlParameter NullableText(
        string name,
        string? value,
        int maximumLength) =>
        new(name, NpgsqlDbType.Text)
        {
            Value = value is null
                ? DBNull.Value
                : value.Length <= maximumLength
                    ? value
                    : value[..maximumLength]
        };

    private static NpgsqlParameter NullableBytea(string name, byte[]? value) =>
        new(name, NpgsqlDbType.Bytea) { Value = value ?? (object)DBNull.Value };

    private static DateTimeOffset Utc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
}
