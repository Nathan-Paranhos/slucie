\set ON_ERROR_STOP on

SET ROLE sluice_owner;
SET search_path = sluice, pg_catalog;

CREATE OR REPLACE FUNCTION sluice.resolve_webhook_source(p_endpoint_key uuid)
RETURNS TABLE (
    tenant_id uuid,
    source_id uuid,
    provider text,
    signing_secret_envelope bytea,
    config_envelope bytea,
    key_version integer,
    rate_limit_per_minute integer,
    max_body_bytes integer,
    raw_payload_retention_days smallint,
    reconciliation_enabled boolean,
    reconciliation_window_hours smallint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT
        source.tenant_id,
        source.id,
        source.provider,
        source.signing_secret_envelope,
        source.config_envelope,
        source.key_version,
        source.rate_limit_per_minute,
        source.max_body_bytes,
        tenant.raw_payload_retention_days,
        source.reconciliation_enabled,
        source.reconciliation_window_hours
    FROM sluice.webhook_sources AS source
    JOIN sluice.tenants AS tenant
      ON tenant.id = source.tenant_id
    WHERE source.endpoint_key = p_endpoint_key
      AND source.status = 'active'
      AND tenant.status = 'active'
$$;

CREATE OR REPLACE FUNCTION sluice.ingest_event_and_enqueue(
    p_tenant_id uuid,
    p_source_id uuid,
    p_external_event_id_hash bytea,
    p_external_event_id_ciphertext bytea,
    p_provider_event_type text,
    p_payload_hash bytea,
    p_raw_body_ciphertext bytea,
    p_key_version integer,
    p_content_type text,
    p_sanitized_headers jsonb,
    p_purge_after timestamptz,
    p_job_type text,
    p_idempotency_key text,
    p_priority smallint,
    p_max_attempts smallint
)
RETURNS TABLE (
    outcome text,
    event_id uuid,
    job_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_event_id uuid;
    v_job_id uuid;
    v_existing_payload_hash bytea;
    v_retention_days smallint;
    v_policy_purge_after timestamptz;
    v_inserted boolean := false;
    v_now timestamptz := clock_timestamp();
BEGIN
    IF p_tenant_id IS NULL OR p_source_id IS NULL THEN
        RAISE EXCEPTION 'tenant_id and source_id are required'
            USING ERRCODE = '22004';
    END IF;
    IF p_external_event_id_hash IS NULL
       OR octet_length(p_external_event_id_hash) <> 32 THEN
        RAISE EXCEPTION 'external_event_id_hash must be a 32-byte SHA-256 digest'
            USING ERRCODE = '22023';
    END IF;
    IF p_payload_hash IS NULL OR octet_length(p_payload_hash) <> 32 THEN
        RAISE EXCEPTION 'payload_hash must be a 32-byte SHA-256 digest'
            USING ERRCODE = '22023';
    END IF;
    IF p_raw_body_ciphertext IS NULL OR octet_length(p_raw_body_ciphertext) = 0 THEN
        RAISE EXCEPTION 'raw body envelope is required'
            USING ERRCODE = '22023';
    END IF;
    IF p_external_event_id_ciphertext IS NOT NULL
       AND octet_length(p_external_event_id_ciphertext) = 0 THEN
        RAISE EXCEPTION 'external event id envelope cannot be empty'
            USING ERRCODE = '22023';
    END IF;
    IF p_key_version IS NULL OR p_key_version <= 0 THEN
        RAISE EXCEPTION 'key_version must be positive' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(btrim(p_provider_event_type), '') = ''
       OR COALESCE(btrim(p_job_type), '') = ''
       OR COALESCE(btrim(p_idempotency_key), '') = '' THEN
        RAISE EXCEPTION 'event type, job type and idempotency key are required'
            USING ERRCODE = '22023';
    END IF;
    IF p_priority NOT BETWEEN 0 AND 1000 THEN
        RAISE EXCEPTION 'priority must be between 0 and 1000'
            USING ERRCODE = '22023';
    END IF;
    IF p_max_attempts NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'max_attempts must be between 1 and 100'
            USING ERRCODE = '22023';
    END IF;
    IF p_sanitized_headers IS NULL
       OR jsonb_typeof(p_sanitized_headers) <> 'object' THEN
        RAISE EXCEPTION 'sanitized_headers must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    SELECT tenant.raw_payload_retention_days
      INTO v_retention_days
      FROM sluice.webhook_sources AS source
      JOIN sluice.tenants AS tenant
        ON tenant.id = source.tenant_id
     WHERE source.id = p_source_id
       AND source.tenant_id = p_tenant_id
       AND source.status = 'active'
       AND tenant.status = 'active'
     FOR SHARE OF source, tenant;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'active source does not belong to active tenant'
            USING ERRCODE = '42501';
    END IF;

    -- Retention is authoritative in the database. p_purge_after is accepted for
    -- API compatibility, but it can never extend or shorten the tenant policy.
    v_policy_purge_after := v_now + make_interval(days => v_retention_days);
    IF p_purge_after IS NOT NULL
       AND abs(extract(epoch FROM (p_purge_after - v_policy_purge_after))) > 300 THEN
        RAISE EXCEPTION 'purge_after differs from tenant retention policy'
            USING ERRCODE = '22023',
                  HINT = 'Use the retention_days value returned by resolve_webhook_source.';
    END IF;

    INSERT INTO sluice.webhook_events (
        tenant_id,
        source_id,
        external_event_id_hash,
        external_event_id_envelope,
        provider_event_type,
        payload_hash,
        raw_body_envelope,
        key_version,
        content_type,
        sanitized_headers,
        received_at,
        purge_after
    )
    VALUES (
        p_tenant_id,
        p_source_id,
        p_external_event_id_hash,
        p_external_event_id_ciphertext,
        p_provider_event_type,
        p_payload_hash,
        p_raw_body_ciphertext,
        p_key_version,
        COALESCE(NULLIF(btrim(p_content_type), ''), 'application/json'),
        p_sanitized_headers,
        v_now,
        v_policy_purge_after
    )
    ON CONFLICT (tenant_id, source_id, external_event_id_hash) DO NOTHING
    RETURNING id INTO v_event_id;

    v_inserted := v_event_id IS NOT NULL;

    IF NOT v_inserted THEN
        SELECT existing.id, existing.payload_hash
          INTO v_event_id, v_existing_payload_hash
          FROM sluice.webhook_events AS existing
         WHERE existing.tenant_id = p_tenant_id
           AND existing.source_id = p_source_id
           AND existing.external_event_id_hash = p_external_event_id_hash;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'deduplication race could not resolve existing event'
                USING ERRCODE = '40001';
        END IF;

        IF v_existing_payload_hash <> p_payload_hash THEN
            INSERT INTO sluice.audit_log (
                tenant_id, actor_type, action, resource_type, resource_id, metadata
            )
            VALUES (
                p_tenant_id,
                'api',
                'webhook_event.dedupe_conflict',
                'webhook_event',
                v_event_id::text,
                jsonb_build_object('source_id', p_source_id)
            );

            RETURN QUERY SELECT 'conflict'::text, v_event_id, NULL::uuid;
            RETURN;
        END IF;

        SELECT existing_job.id
          INTO v_job_id
          FROM sluice.jobs AS existing_job
         WHERE existing_job.tenant_id = p_tenant_id
           AND existing_job.event_id = v_event_id
           AND existing_job.job_type = p_job_type
         ORDER BY existing_job.created_at, existing_job.id
         LIMIT 1;

        RETURN QUERY SELECT 'duplicate'::text, v_event_id, v_job_id;
        RETURN;
    END IF;

    INSERT INTO sluice.jobs (
        tenant_id,
        event_id,
        job_type,
        idempotency_key,
        status,
        priority,
        max_attempts,
        available_at
    )
    VALUES (
        p_tenant_id,
        v_event_id,
        p_job_type,
        p_idempotency_key,
        'pending',
        p_priority,
        p_max_attempts,
        v_now
    )
    ON CONFLICT (tenant_id, job_type, idempotency_key) DO NOTHING
    RETURNING id INTO v_job_id;

    IF v_job_id IS NULL THEN
        -- The event insert and initial job are one logical operation. Reusing an
        -- idempotency key for another event is a caller error, so rollback both.
        RAISE EXCEPTION 'job idempotency key already belongs to another event'
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO sluice.audit_log (
        tenant_id, actor_type, action, resource_type, resource_id, metadata
    )
    VALUES (
        p_tenant_id,
        'api',
        'webhook_event.accepted',
        'webhook_event',
        v_event_id::text,
        jsonb_build_object('source_id', p_source_id, 'job_id', v_job_id)
    );

    PERFORM pg_notify(
        'sluice_jobs',
        jsonb_build_object('tenant_id', p_tenant_id, 'job_id', v_job_id)::text
    );

    RETURN QUERY SELECT 'inserted'::text, v_event_id, v_job_id;
END
$$;

CREATE OR REPLACE FUNCTION sluice.claim_jobs(
    p_worker_id text,
    p_limit integer DEFAULT 20,
    p_lease_seconds integer DEFAULT 60,
    p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (
    job_id uuid,
    tenant_id uuid,
    event_id uuid,
    pipeline_id uuid,
    destination_id uuid,
    job_type text,
    idempotency_key text,
    priority smallint,
    delivery_count integer,
    max_attempts smallint,
    arguments jsonb,
    lease_token uuid,
    lease_expires_at timestamptz,
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF COALESCE(btrim(p_worker_id), '') = '' THEN
        RAISE EXCEPTION 'worker_id is required' USING ERRCODE = '22023';
    END IF;
    IF p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'limit must be between 1 and 500' USING ERRCODE = '22023';
    END IF;
    IF p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
        RAISE EXCEPTION 'lease must be between 5 and 3600 seconds'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS MATERIALIZED (
        SELECT queued.tenant_id, queued.id
        FROM sluice.jobs AS queued
        JOIN sluice.tenants AS tenant
          ON tenant.id = queued.tenant_id
        WHERE queued.status = 'pending'
          AND queued.available_at <= clock_timestamp()
          AND tenant.status = 'active'
          AND (p_tenant_id IS NULL OR queued.tenant_id = p_tenant_id)
        ORDER BY queued.priority ASC, queued.available_at ASC,
                 queued.created_at ASC, queued.id ASC
        LIMIT p_limit
        FOR UPDATE OF queued SKIP LOCKED
    ),
    claimed AS (
        UPDATE sluice.jobs AS target
           SET status = 'processing',
               delivery_count = target.delivery_count + 1,
               claimed_at = clock_timestamp(),
               claimed_by = p_worker_id,
               lease_token = gen_random_uuid(),
               lease_expires_at = clock_timestamp()
                   + make_interval(secs => p_lease_seconds),
               heartbeat_at = clock_timestamp(),
               last_error_code = NULL,
               last_error = NULL
          FROM candidates
         WHERE target.tenant_id = candidates.tenant_id
           AND target.id = candidates.id
        RETURNING
            target.id,
            target.tenant_id,
            target.event_id,
            target.pipeline_id,
            target.destination_id,
            target.job_type,
            target.idempotency_key,
            target.priority,
            target.delivery_count,
            target.max_attempts,
            target.arguments,
            target.lease_token,
            target.lease_expires_at,
            target.created_at
    ),
    attempts AS (
        INSERT INTO sluice.job_attempts (
            tenant_id,
            job_id,
            attempt_number,
            lease_token,
            worker_id,
            status,
            started_at
        )
        SELECT
            claimed.tenant_id,
            claimed.id,
            claimed.delivery_count,
            claimed.lease_token,
            p_worker_id,
            'processing',
            clock_timestamp()
        FROM claimed
        RETURNING 1
    )
    SELECT
        claimed.id,
        claimed.tenant_id,
        claimed.event_id,
        claimed.pipeline_id,
        claimed.destination_id,
        claimed.job_type,
        claimed.idempotency_key,
        claimed.priority,
        claimed.delivery_count,
        claimed.max_attempts,
        claimed.arguments,
        claimed.lease_token,
        claimed.lease_expires_at,
        claimed.created_at
    FROM claimed
    CROSS JOIN LATERAL (SELECT count(*) FROM attempts) AS ensure_attempts;
END
$$;

CREATE OR REPLACE FUNCTION sluice.heartbeat_job(
    p_tenant_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_extend_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_updated integer;
BEGIN
    IF p_extend_seconds NOT BETWEEN 5 AND 3600 THEN
        RAISE EXCEPTION 'lease extension must be between 5 and 3600 seconds'
            USING ERRCODE = '22023';
    END IF;

    UPDATE sluice.jobs
       SET heartbeat_at = clock_timestamp(),
           lease_expires_at = clock_timestamp()
               + make_interval(secs => p_extend_seconds)
     WHERE tenant_id = p_tenant_id
       AND id = p_job_id
       AND status = 'processing'
       AND lease_token = p_lease_token
       AND lease_expires_at > clock_timestamp();

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END
$$;

CREATE OR REPLACE FUNCTION sluice.complete_job(
    p_tenant_id uuid,
    p_job_id uuid,
    p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_updated integer;
    v_finished_at timestamptz := clock_timestamp();
BEGIN
    UPDATE sluice.jobs
       SET status = 'completed',
           completed_at = v_finished_at,
           lease_token = NULL,
           lease_expires_at = NULL,
           heartbeat_at = v_finished_at,
           last_error_code = NULL,
           last_error = NULL
     WHERE tenant_id = p_tenant_id
       AND id = p_job_id
       AND status = 'processing'
       AND lease_token = p_lease_token
       AND lease_expires_at > v_finished_at;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RETURN false;
    END IF;

    UPDATE sluice.job_attempts
       SET status = 'succeeded',
           finished_at = v_finished_at,
           duration_ms = GREATEST(
               0,
               floor(extract(epoch FROM (v_finished_at - started_at)) * 1000)::bigint
           )
     WHERE tenant_id = p_tenant_id
       AND job_id = p_job_id
       AND lease_token = p_lease_token
       AND status = 'processing';

    RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION sluice.retry_job(
    p_tenant_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_error_code text,
    p_error_message text,
    p_delay_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_updated integer;
    v_finished_at timestamptz := clock_timestamp();
BEGIN
    IF p_delay_seconds NOT BETWEEN 0 AND 86400 THEN
        RAISE EXCEPTION 'retry delay must be between 0 and 86400 seconds'
            USING ERRCODE = '22023';
    END IF;

    UPDATE sluice.jobs
       SET status = 'pending',
           available_at = v_finished_at + make_interval(secs => p_delay_seconds),
           lease_token = NULL,
           lease_expires_at = NULL,
           heartbeat_at = v_finished_at,
           last_error_code = left(p_error_code, 128),
           last_error = left(p_error_message, 2000)
     WHERE tenant_id = p_tenant_id
       AND id = p_job_id
       AND status = 'processing'
       AND lease_token = p_lease_token
       AND lease_expires_at > v_finished_at
       AND delivery_count < max_attempts;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RETURN false;
    END IF;

    UPDATE sluice.job_attempts
       SET status = 'failed',
           error_code = left(p_error_code, 128),
           error_message = left(p_error_message, 2000),
           finished_at = v_finished_at,
           duration_ms = GREATEST(
               0,
               floor(extract(epoch FROM (v_finished_at - started_at)) * 1000)::bigint
           )
     WHERE tenant_id = p_tenant_id
       AND job_id = p_job_id
       AND lease_token = p_lease_token
       AND status = 'processing';

    PERFORM pg_notify(
        'sluice_jobs',
        jsonb_build_object('tenant_id', p_tenant_id, 'job_id', p_job_id)::text
    );
    RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION sluice.dead_letter_job(
    p_tenant_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_error_code text,
    p_error_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_updated integer;
    v_finished_at timestamptz := clock_timestamp();
    v_job_type text;
BEGIN
    UPDATE sluice.jobs
       SET status = 'dead_letter',
           dead_lettered_at = v_finished_at,
           lease_token = NULL,
           lease_expires_at = NULL,
           heartbeat_at = v_finished_at,
           last_error_code = left(p_error_code, 128),
           last_error = left(p_error_message, 2000)
     WHERE tenant_id = p_tenant_id
       AND id = p_job_id
       AND status = 'processing'
       AND lease_token = p_lease_token
       AND lease_expires_at > v_finished_at
    RETURNING job_type INTO v_job_type;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RETURN false;
    END IF;

    UPDATE sluice.job_attempts
       SET status = 'dead_lettered',
           error_code = left(p_error_code, 128),
           error_message = left(p_error_message, 2000),
           finished_at = v_finished_at,
           duration_ms = GREATEST(
               0,
               floor(extract(epoch FROM (v_finished_at - started_at)) * 1000)::bigint
           )
     WHERE tenant_id = p_tenant_id
       AND job_id = p_job_id
       AND lease_token = p_lease_token
       AND status = 'processing';

    INSERT INTO sluice.notification_outbox (
        tenant_id,
        job_id,
        channel,
        template_key,
        dedupe_key,
        payload
    )
    VALUES (
        p_tenant_id,
        p_job_id,
        'dashboard',
        'job.dead_letter',
        'job-dead-letter:' || p_job_id::text,
        jsonb_build_object(
            'job_id', p_job_id,
            'job_type', v_job_type,
            'error_code', left(p_error_code, 128)
        )
    )
    ON CONFLICT (tenant_id, channel, dedupe_key) DO NOTHING;

    PERFORM pg_notify(
        'sluice_notifications',
        jsonb_build_object('tenant_id', p_tenant_id, 'job_id', p_job_id)::text
    );
    RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION sluice.fail_job(
    p_tenant_id uuid,
    p_job_id uuid,
    p_lease_token uuid,
    p_error_code text,
    p_error_message text,
    p_retry_delay_seconds integer DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_delivery_count integer;
    v_max_attempts smallint;
    v_delay integer;
BEGIN
    SELECT delivery_count, max_attempts
      INTO v_delivery_count, v_max_attempts
      FROM sluice.jobs
     WHERE tenant_id = p_tenant_id
       AND id = p_job_id
       AND status = 'processing'
       AND lease_token = p_lease_token
       AND lease_expires_at > clock_timestamp()
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'lost_lease';
    END IF;

    IF v_delivery_count >= v_max_attempts THEN
        IF sluice.dead_letter_job(
            p_tenant_id,
            p_job_id,
            p_lease_token,
            p_error_code,
            p_error_message
        ) THEN
            RETURN 'dead_letter';
        END IF;
        RETURN 'lost_lease';
    END IF;

    v_delay := COALESCE(
        p_retry_delay_seconds,
        LEAST(3600, (5 * power(2::numeric, GREATEST(v_delivery_count - 1, 0)))::integer)
    );
    -- Up to 20% jitter prevents synchronized retries. The selected delay is
    -- persisted in available_at and therefore does not need Redis.
    v_delay := LEAST(86400, v_delay + floor(random() * GREATEST(1, v_delay / 5))::integer);

    IF sluice.retry_job(
        p_tenant_id,
        p_job_id,
        p_lease_token,
        p_error_code,
        p_error_message,
        v_delay
    ) THEN
        RETURN 'pending';
    END IF;
    RETURN 'lost_lease';
END
$$;

CREATE OR REPLACE FUNCTION sluice.reserve_delivery_effect(
    p_tenant_id uuid,
    p_job_id uuid,
    p_destination_id uuid,
    p_effect_key text
)
RETURNS TABLE (
    effect_id uuid,
    effect_status text,
    acquired boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_effect_id uuid;
    v_status text;
BEGIN
    IF COALESCE(btrim(p_effect_key), '') = '' THEN
        RAISE EXCEPTION 'effect key is required' USING ERRCODE = '22023';
    END IF;

    INSERT INTO sluice.job_delivery_effects (
        tenant_id, job_id, destination_id, effect_key, status
    )
    SELECT p_tenant_id, p_job_id, p_destination_id, p_effect_key, 'reserved'
    FROM sluice.jobs AS job
    WHERE job.tenant_id = p_tenant_id
      AND job.id = p_job_id
      AND job.status = 'processing'
    ON CONFLICT (tenant_id, effect_key) DO NOTHING
    RETURNING id, status INTO v_effect_id, v_status;

    IF v_effect_id IS NOT NULL THEN
        RETURN QUERY SELECT v_effect_id, v_status, true;
        RETURN;
    END IF;

    SELECT effect.id, effect.status
      INTO v_effect_id, v_status
      FROM sluice.job_delivery_effects AS effect
     WHERE effect.tenant_id = p_tenant_id
       AND effect.effect_key = p_effect_key;

    RETURN QUERY SELECT v_effect_id, v_status, false;
END
$$;

CREATE OR REPLACE FUNCTION sluice.mark_delivery_effect_applied(
    p_tenant_id uuid,
    p_effect_id uuid,
    p_external_reference_hash bytea DEFAULT NULL,
    p_response_code integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_updated integer;
BEGIN
    UPDATE sluice.job_delivery_effects
       SET status = 'applied',
           external_reference_hash = p_external_reference_hash,
           response_code = p_response_code,
           applied_at = clock_timestamp()
     WHERE tenant_id = p_tenant_id
       AND id = p_effect_id
       AND status = 'reserved';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END
$$;

REVOKE ALL ON FUNCTION sluice.resolve_webhook_source(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.ingest_event_and_enqueue(
    uuid, uuid, bytea, bytea, text, bytea, bytea, integer, text, jsonb,
    timestamptz, text, text, smallint, smallint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.claim_jobs(text, integer, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.heartbeat_job(uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.complete_job(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.retry_job(uuid, uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.dead_letter_job(uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.fail_job(uuid, uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.reserve_delivery_effect(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.mark_delivery_effect_applied(
    uuid, uuid, bytea, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sluice.resolve_webhook_source(uuid) TO sluice_api;
GRANT EXECUTE ON FUNCTION sluice.ingest_event_and_enqueue(
    uuid, uuid, bytea, bytea, text, bytea, bytea, integer, text, jsonb,
    timestamptz, text, text, smallint, smallint
) TO sluice_api;

GRANT EXECUTE ON FUNCTION sluice.claim_jobs(text, integer, integer, uuid)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.heartbeat_job(uuid, uuid, uuid, integer)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.complete_job(uuid, uuid, uuid)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.retry_job(uuid, uuid, uuid, text, text, integer)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.dead_letter_job(uuid, uuid, uuid, text, text)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.fail_job(uuid, uuid, uuid, text, text, integer)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.reserve_delivery_effect(uuid, uuid, uuid, text)
    TO sluice_worker;
GRANT EXECUTE ON FUNCTION sluice.mark_delivery_effect_applied(
    uuid, uuid, bytea, integer
) TO sluice_worker;

RESET ROLE;
