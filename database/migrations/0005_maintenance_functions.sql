\set ON_ERROR_STOP on

SET ROLE sluice_owner;
SET search_path = sluice, pg_catalog;

CREATE OR REPLACE FUNCTION sluice.sweep_expired_job_leases(
    p_batch_size integer DEFAULT 500
)
RETURNS TABLE (
    jobs_requeued integer,
    jobs_dead_lettered integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_job record;
    v_requeued integer := 0;
    v_dead integer := 0;
    v_now timestamptz := clock_timestamp();
    v_delay integer;
BEGIN
    IF p_batch_size NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'batch size must be between 1 and 5000'
            USING ERRCODE = '22023';
    END IF;

    FOR v_job IN
        SELECT
            job.id,
            job.tenant_id,
            job.job_type,
            job.delivery_count,
            job.max_attempts,
            job.lease_token
        FROM sluice.jobs AS job
        WHERE job.status = 'processing'
          AND job.lease_expires_at <= v_now
        ORDER BY job.lease_expires_at, job.id
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        IF v_job.delivery_count >= v_job.max_attempts THEN
            UPDATE sluice.jobs
               SET status = 'dead_letter',
                   dead_lettered_at = v_now,
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   heartbeat_at = v_now,
                   last_error_code = 'lease_expired',
                   last_error = 'Worker lease expired on final delivery'
             WHERE tenant_id = v_job.tenant_id
               AND id = v_job.id
               AND status = 'processing'
               AND lease_token = v_job.lease_token;

            UPDATE sluice.job_attempts
               SET status = 'dead_lettered',
                   error_code = 'lease_expired',
                   error_message = 'Worker lease expired on final delivery',
                   finished_at = v_now,
                   duration_ms = GREATEST(
                       0,
                       floor(extract(epoch FROM (v_now - started_at)) * 1000)::bigint
                   )
             WHERE tenant_id = v_job.tenant_id
               AND job_id = v_job.id
               AND lease_token = v_job.lease_token
               AND status = 'processing';

            INSERT INTO sluice.notification_outbox (
                tenant_id, job_id, channel, template_key, dedupe_key, payload
            )
            VALUES (
                v_job.tenant_id,
                v_job.id,
                'dashboard',
                'job.dead_letter',
                'job-dead-letter:' || v_job.id::text,
                jsonb_build_object(
                    'job_id', v_job.id,
                    'job_type', v_job.job_type,
                    'error_code', 'lease_expired'
                )
            )
            ON CONFLICT (tenant_id, channel, dedupe_key) DO NOTHING;

            v_dead := v_dead + 1;
        ELSE
            v_delay := LEAST(
                3600,
                (5 * power(2::numeric, GREATEST(v_job.delivery_count - 1, 0)))::integer
            );

            UPDATE sluice.jobs
               SET status = 'pending',
                   available_at = v_now + make_interval(secs => v_delay),
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   heartbeat_at = v_now,
                   last_error_code = 'lease_expired',
                   last_error = 'Worker lease expired; delivery was safely requeued'
             WHERE tenant_id = v_job.tenant_id
               AND id = v_job.id
               AND status = 'processing'
               AND lease_token = v_job.lease_token;

            UPDATE sluice.job_attempts
               SET status = 'lease_expired',
                   error_code = 'lease_expired',
                   error_message = 'Worker lease expired; delivery was safely requeued',
                   finished_at = v_now,
                   duration_ms = GREATEST(
                       0,
                       floor(extract(epoch FROM (v_now - started_at)) * 1000)::bigint
                   )
             WHERE tenant_id = v_job.tenant_id
               AND job_id = v_job.id
               AND lease_token = v_job.lease_token
               AND status = 'processing';

            v_requeued := v_requeued + 1;
        END IF;
    END LOOP;

    IF v_requeued > 0 THEN
        PERFORM pg_notify('sluice_jobs', '{"reason":"lease_sweep"}');
    END IF;
    IF v_dead > 0 THEN
        PERFORM pg_notify('sluice_notifications', '{"reason":"dead_letter"}');
    END IF;

    RETURN QUERY SELECT v_requeued, v_dead;
END
$$;

CREATE OR REPLACE FUNCTION sluice.purge_expired_payloads(
    p_batch_size integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_event record;
    v_purged integer := 0;
    v_now timestamptz := clock_timestamp();
BEGIN
    IF p_batch_size NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'batch size must be between 1 and 5000'
            USING ERRCODE = '22023';
    END IF;

    FOR v_event IN
        SELECT event.id, event.tenant_id
        FROM sluice.webhook_events AS event
        WHERE event.raw_body_envelope IS NOT NULL
          AND event.purge_after <= v_now
        ORDER BY event.purge_after, event.id
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE sluice.webhook_events
           SET raw_body_envelope = NULL,
               external_event_id_envelope = NULL,
               sanitized_headers = '{}'::jsonb,
               payload_purged_at = v_now
         WHERE tenant_id = v_event.tenant_id
           AND id = v_event.id;

        -- Job arguments must never copy raw payloads. Scrubbing them as a
        -- defense in depth also protects deployments that added custom handlers.
        UPDATE sluice.jobs
           SET arguments = jsonb_build_object(
                   'event_id', v_event.id,
                   'payload_purged', true
               ),
               last_error = CASE
                   WHEN last_error IS NULL THEN NULL
                   ELSE '[redacted by retention policy]'
               END
         WHERE tenant_id = v_event.tenant_id
           AND event_id = v_event.id;

        UPDATE sluice.job_attempts AS attempt
           SET error_message = CASE
                   WHEN attempt.error_message IS NULL THEN NULL
                   ELSE '[redacted by retention policy]'
               END
          FROM sluice.jobs AS job
         WHERE job.tenant_id = v_event.tenant_id
           AND job.event_id = v_event.id
           AND attempt.tenant_id = job.tenant_id
           AND attempt.job_id = job.id;

        INSERT INTO sluice.audit_log (
            tenant_id, actor_type, action, resource_type, resource_id, metadata
        )
        VALUES (
            v_event.tenant_id,
            'scheduler',
            'webhook_event.payload_purged',
            'webhook_event',
            v_event.id::text,
            jsonb_build_object('dedupe_metadata_retained', true)
        );

        v_purged := v_purged + 1;
    END LOOP;

    RETURN v_purged;
END
$$;

CREATE OR REPLACE FUNCTION sluice.rollup_usage_metrics(
    p_from timestamptz DEFAULT date_trunc('hour', clock_timestamp()) - interval '2 hours',
    p_to timestamptz DEFAULT date_trunc('hour', clock_timestamp()) + interval '1 hour'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_rows integer;
BEGIN
    IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
        RAISE EXCEPTION 'invalid rollup interval' USING ERRCODE = '22023';
    END IF;
    IF p_to - p_from > interval '90 days' THEN
        RAISE EXCEPTION 'a single rollup run cannot exceed 90 days'
            USING ERRCODE = '22023';
    END IF;

    WITH buckets AS (
        SELECT
            tenant.id AS tenant_id,
            series.bucket_start
        FROM sluice.tenants AS tenant
        CROSS JOIN LATERAL generate_series(
            date_trunc('hour', p_from),
            date_trunc('hour', p_to - interval '1 microsecond'),
            interval '1 hour'
        ) AS series(bucket_start)
    ),
    calculated AS (
        SELECT
            bucket.tenant_id,
            bucket.bucket_start,
            COALESCE(event_stats.events_received, 0) AS events_received,
            COALESCE(event_stats.bytes_ingested, 0) AS bytes_ingested,
            COALESCE(job_stats.jobs_created, 0) AS jobs_created,
            COALESCE(job_stats.jobs_completed, 0) AS jobs_completed,
            COALESCE(job_stats.jobs_dead_lettered, 0) AS jobs_dead_lettered,
            COALESCE(attempt_stats.jobs_retried, 0) AS jobs_retried,
            COALESCE(attempt_stats.processing_duration_ms, 0) AS processing_duration_ms
        FROM buckets AS bucket
        LEFT JOIN LATERAL (
            SELECT
                count(*)::bigint AS events_received,
                COALESCE(sum(octet_length(event.raw_body_envelope)), 0)::bigint
                    AS bytes_ingested
            FROM sluice.webhook_events AS event
            WHERE event.tenant_id = bucket.tenant_id
              AND event.received_at >= bucket.bucket_start
              AND event.received_at < bucket.bucket_start + interval '1 hour'
        ) AS event_stats ON true
        LEFT JOIN LATERAL (
            SELECT
            count(*) FILTER (
                WHERE job.created_at >= bucket.bucket_start
                  AND job.created_at < bucket.bucket_start + interval '1 hour'
            )::bigint AS jobs_created,
                count(*) FILTER (
                    WHERE job.completed_at >= bucket.bucket_start
                      AND job.completed_at < bucket.bucket_start + interval '1 hour'
                )::bigint AS jobs_completed,
                count(*) FILTER (
                    WHERE job.dead_lettered_at >= bucket.bucket_start
                      AND job.dead_lettered_at < bucket.bucket_start + interval '1 hour'
                )::bigint AS jobs_dead_lettered
            FROM sluice.jobs AS job
            WHERE job.tenant_id = bucket.tenant_id
              AND (
                  (job.created_at >= bucket.bucket_start
                   AND job.created_at < bucket.bucket_start + interval '1 hour')
                  OR
                  (job.completed_at >= bucket.bucket_start
                   AND job.completed_at < bucket.bucket_start + interval '1 hour')
                  OR
                  (job.dead_lettered_at >= bucket.bucket_start
                   AND job.dead_lettered_at < bucket.bucket_start + interval '1 hour')
              )
        ) AS job_stats ON true
        LEFT JOIN LATERAL (
            SELECT
                count(*) FILTER (WHERE attempt.attempt_number > 1)::bigint
                    AS jobs_retried,
                COALESCE(sum(attempt.duration_ms), 0)::bigint
                    AS processing_duration_ms
            FROM sluice.job_attempts AS attempt
            WHERE attempt.tenant_id = bucket.tenant_id
              AND attempt.started_at >= bucket.bucket_start
              AND attempt.started_at < bucket.bucket_start + interval '1 hour'
        ) AS attempt_stats ON true
    )
    INSERT INTO sluice.usage_rollups (
        tenant_id,
        bucket_start,
        bucket_interval,
        events_received,
        bytes_ingested,
        jobs_created,
        jobs_completed,
        jobs_retried,
        jobs_dead_lettered,
        processing_duration_ms,
        calculated_at
    )
    SELECT
        calculated.tenant_id,
        calculated.bucket_start,
        'hour',
        calculated.events_received,
        calculated.bytes_ingested,
        calculated.jobs_created,
        calculated.jobs_completed,
        calculated.jobs_retried,
        calculated.jobs_dead_lettered,
        calculated.processing_duration_ms,
        clock_timestamp()
    FROM calculated
    ON CONFLICT (tenant_id, bucket_start, bucket_interval) DO UPDATE
       SET events_received = EXCLUDED.events_received,
           bytes_ingested = EXCLUDED.bytes_ingested,
           jobs_created = EXCLUDED.jobs_created,
           jobs_completed = EXCLUDED.jobs_completed,
           jobs_retried = EXCLUDED.jobs_retried,
           jobs_dead_lettered = EXCLUDED.jobs_dead_lettered,
           processing_duration_ms = EXCLUDED.processing_duration_ms,
           calculated_at = EXCLUDED.calculated_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END
$$;

CREATE OR REPLACE FUNCTION sluice.enqueue_reconciliation_jobs(
    p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_source record;
    v_job_id uuid;
    v_count integer := 0;
    v_window_start timestamptz;
    v_bucket bigint;
BEGIN
    v_bucket := floor(extract(epoch FROM p_now) / 900)::bigint;

    FOR v_source IN
        SELECT
            source.id AS source_id,
            source.tenant_id,
            source.reconciliation_window_hours,
            tenant.default_max_attempts
        FROM sluice.webhook_sources AS source
        JOIN sluice.tenants AS tenant
          ON tenant.id = source.tenant_id
        WHERE source.status = 'active'
          AND source.reconciliation_enabled
          AND tenant.status = 'active'
        ORDER BY source.tenant_id, source.id
    LOOP
        v_window_start := p_now
            - make_interval(hours => v_source.reconciliation_window_hours);

        INSERT INTO sluice.jobs (
            tenant_id,
            job_type,
            idempotency_key,
            status,
            priority,
            max_attempts,
            available_at,
            arguments
        )
        VALUES (
            v_source.tenant_id,
            'reconcile_provider',
            'reconcile:' || v_source.source_id::text || ':' || v_bucket::text,
            'pending',
            200,
            v_source.default_max_attempts,
            p_now,
            jsonb_build_object(
                'source_id', v_source.source_id,
                'window_start', v_window_start,
                'window_end', p_now
            )
        )
        ON CONFLICT (tenant_id, job_type, idempotency_key) DO NOTHING
        RETURNING id INTO v_job_id;

        INSERT INTO sluice.reconciliation_checkpoints (
            tenant_id,
            source_id,
            window_started_at,
            window_ended_at,
            last_enqueued_at
        )
        VALUES (
            v_source.tenant_id,
            v_source.source_id,
            v_window_start,
            p_now,
            CASE WHEN v_job_id IS NULL THEN NULL ELSE p_now END
        )
        ON CONFLICT (tenant_id, source_id) DO UPDATE
           SET window_started_at = EXCLUDED.window_started_at,
               window_ended_at = EXCLUDED.window_ended_at,
               last_enqueued_at = COALESCE(
                   EXCLUDED.last_enqueued_at,
                   sluice.reconciliation_checkpoints.last_enqueued_at
               );

        IF v_job_id IS NOT NULL THEN
            INSERT INTO sluice.audit_log (
                tenant_id, actor_type, action, resource_type, resource_id, metadata
            )
            VALUES (
                v_source.tenant_id,
                'scheduler',
                'reconciliation.enqueued',
                'job',
                v_job_id::text,
                jsonb_build_object('source_id', v_source.source_id)
            );
            v_count := v_count + 1;
        END IF;
        v_job_id := NULL;
    END LOOP;

    IF v_count > 0 THEN
        PERFORM pg_notify('sluice_jobs', '{"reason":"reconciliation"}');
    END IF;
    RETURN v_count;
END
$$;

CREATE OR REPLACE FUNCTION sluice.update_reconciliation_checkpoint(
    p_tenant_id uuid,
    p_source_id uuid,
    p_cursor_envelope bytea,
    p_key_version integer,
    p_succeeded boolean,
    p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_updated integer;
BEGIN
    IF (p_cursor_envelope IS NULL) <> (p_key_version IS NULL) THEN
        RAISE EXCEPTION 'cursor envelope and key version must be supplied together'
            USING ERRCODE = '22023';
    END IF;

    UPDATE sluice.reconciliation_checkpoints
       SET cursor_envelope = COALESCE(
               p_cursor_envelope,
               reconciliation_checkpoints.cursor_envelope
           ),
           key_version = COALESCE(
               p_key_version,
               reconciliation_checkpoints.key_version
           ),
           last_succeeded_at = CASE
               WHEN p_succeeded THEN clock_timestamp()
               ELSE last_succeeded_at
           END,
           last_error = CASE
               WHEN p_succeeded THEN NULL
               ELSE left(p_error, 2000)
           END
     WHERE tenant_id = p_tenant_id
       AND source_id = p_source_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END
$$;

CREATE OR REPLACE FUNCTION sluice.claim_notifications(
    p_worker_id text,
    p_limit integer DEFAULT 20,
    p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
    notification_id uuid,
    tenant_id uuid,
    job_id uuid,
    channel text,
    template_key text,
    payload jsonb,
    lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF COALESCE(btrim(p_worker_id), '') = '' THEN
        RAISE EXCEPTION 'worker_id is required' USING ERRCODE = '22023';
    END IF;
    IF p_limit NOT BETWEEN 1 AND 500 OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
        RAISE EXCEPTION 'invalid claim bounds' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT outbox.tenant_id, outbox.id
        FROM sluice.notification_outbox AS outbox
        WHERE outbox.status = 'pending'
          AND outbox.available_at <= clock_timestamp()
        ORDER BY outbox.available_at, outbox.created_at, outbox.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE sluice.notification_outbox AS target
       SET status = 'processing',
           attempts = target.attempts + 1,
           claimed_by = p_worker_id,
           lease_token = gen_random_uuid(),
           lease_expires_at = clock_timestamp()
               + make_interval(secs => p_lease_seconds)
      FROM candidates
     WHERE target.tenant_id = candidates.tenant_id
       AND target.id = candidates.id
    RETURNING
        target.id,
        target.tenant_id,
        target.job_id,
        target.channel,
        target.template_key,
        target.payload,
        target.lease_token;
END
$$;

CREATE OR REPLACE FUNCTION sluice.complete_notification(
    p_tenant_id uuid,
    p_notification_id uuid,
    p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_updated integer;
BEGIN
    UPDATE sluice.notification_outbox
       SET status = 'sent',
           sent_at = clock_timestamp(),
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = NULL
     WHERE tenant_id = p_tenant_id
       AND id = p_notification_id
       AND status = 'processing'
       AND lease_token = p_lease_token
       AND lease_expires_at > clock_timestamp();

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END
$$;

CREATE OR REPLACE FUNCTION sluice.fail_notification(
    p_tenant_id uuid,
    p_notification_id uuid,
    p_lease_token uuid,
    p_error text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_attempts integer;
    v_delay integer;
    v_now timestamptz := clock_timestamp();
BEGIN
    SELECT attempts
      INTO v_attempts
      FROM sluice.notification_outbox
     WHERE tenant_id = p_tenant_id
       AND id = p_notification_id
       AND status = 'processing'
       AND lease_token = p_lease_token
       AND lease_expires_at > v_now
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'lost_lease';
    END IF;

    IF v_attempts >= 10 THEN
        UPDATE sluice.notification_outbox
           SET status = 'failed',
               lease_token = NULL,
               lease_expires_at = NULL,
               last_error = left(p_error, 2000)
         WHERE tenant_id = p_tenant_id
           AND id = p_notification_id;
        RETURN 'failed';
    END IF;

    v_delay := LEAST(3600, 15 * power(2::numeric, v_attempts - 1)::integer);
    UPDATE sluice.notification_outbox
       SET status = 'pending',
           available_at = v_now + make_interval(secs => v_delay),
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = left(p_error, 2000)
     WHERE tenant_id = p_tenant_id
       AND id = p_notification_id;
    RETURN 'pending';
END
$$;

CREATE OR REPLACE FUNCTION sluice.sweep_expired_notification_leases(
    p_batch_size integer DEFAULT 500
)
RETURNS TABLE (
    notifications_requeued integer,
    notifications_failed integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_notification record;
    v_requeued integer := 0;
    v_failed integer := 0;
    v_delay integer;
    v_now timestamptz := clock_timestamp();
BEGIN
    IF p_batch_size NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'batch size must be between 1 and 5000'
            USING ERRCODE = '22023';
    END IF;

    FOR v_notification IN
        SELECT outbox.id, outbox.tenant_id, outbox.attempts
        FROM sluice.notification_outbox AS outbox
        WHERE outbox.status = 'processing'
          AND outbox.lease_expires_at <= v_now
        ORDER BY outbox.lease_expires_at, outbox.id
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        IF v_notification.attempts >= 10 THEN
            UPDATE sluice.notification_outbox
               SET status = 'failed',
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   last_error = 'Notification worker lease expired on final delivery'
             WHERE tenant_id = v_notification.tenant_id
               AND id = v_notification.id
               AND status = 'processing';
            v_failed := v_failed + 1;
        ELSE
            v_delay := LEAST(
                3600,
                15 * power(
                    2::numeric,
                    GREATEST(v_notification.attempts - 1, 0)
                )::integer
            );
            UPDATE sluice.notification_outbox
               SET status = 'pending',
                   available_at = v_now + make_interval(secs => v_delay),
                   lease_token = NULL,
                   lease_expires_at = NULL,
                   last_error = 'Notification worker lease expired; delivery was requeued'
             WHERE tenant_id = v_notification.tenant_id
               AND id = v_notification.id
               AND status = 'processing';
            v_requeued := v_requeued + 1;
        END IF;
    END LOOP;

    IF v_requeued > 0 THEN
        PERFORM pg_notify(
            'sluice_notifications',
            '{"reason":"lease_sweep"}'
        );
    END IF;

    RETURN QUERY SELECT v_requeued, v_failed;
END
$$;

REVOKE ALL ON FUNCTION sluice.sweep_expired_job_leases(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.purge_expired_payloads(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.rollup_usage_metrics(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.enqueue_reconciliation_jobs(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.update_reconciliation_checkpoint(
    uuid, uuid, bytea, integer, boolean, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.claim_notifications(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.complete_notification(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.fail_notification(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.sweep_expired_notification_leases(integer)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sluice.sweep_expired_job_leases(integer)
    TO sluice_maintenance;
GRANT EXECUTE ON FUNCTION sluice.purge_expired_payloads(integer)
    TO sluice_maintenance;
GRANT EXECUTE ON FUNCTION sluice.rollup_usage_metrics(timestamptz, timestamptz)
    TO sluice_maintenance;
GRANT EXECUTE ON FUNCTION sluice.enqueue_reconciliation_jobs(timestamptz)
    TO sluice_maintenance;
GRANT EXECUTE ON FUNCTION sluice.sweep_expired_notification_leases(integer)
    TO sluice_maintenance;

GRANT EXECUTE ON FUNCTION sluice.update_reconciliation_checkpoint(
    uuid, uuid, bytea, integer, boolean, text
) TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.claim_notifications(text, integer, integer)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.complete_notification(uuid, uuid, uuid)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.fail_notification(uuid, uuid, uuid, text)
    TO sluice_worker;

RESET ROLE;
