\set ON_ERROR_STOP on

SET ROLE sluice_owner;
SET search_path = sluice, pg_catalog;

CREATE OR REPLACE FUNCTION sluice.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END
$$;

CREATE TABLE IF NOT EXISTS sluice.tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug public.citext NOT NULL UNIQUE,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),
    raw_payload_retention_days smallint NOT NULL DEFAULT 90
        CHECK (raw_payload_retention_days BETWEEN 1 AND 3650),
    dedupe_metadata_retention_days integer NOT NULL DEFAULT 2555
        CHECK (dedupe_metadata_retention_days >= raw_payload_retention_days),
    default_max_attempts smallint NOT NULL DEFAULT 8
        CHECK (default_max_attempts BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, slug)
);

CREATE TABLE IF NOT EXISTS sluice.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email public.citext NOT NULL UNIQUE,
    display_name text NOT NULL,
    password_hash text,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('invited', 'active', 'disabled')),
    mfa_enabled boolean NOT NULL DEFAULT false,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS sluice.tenant_memberships (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, user_id),
    CONSTRAINT tenant_memberships_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT tenant_memberships_user_fk
        FOREIGN KEY (user_id) REFERENCES sluice.users (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.webhook_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    endpoint_key uuid NOT NULL DEFAULT gen_random_uuid(),
    provider text NOT NULL
        CHECK (provider IN ('asaas', 'pagbank', 'mercado_pago', 'pix', 'stripe', 'generic')),
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    signing_secret_envelope bytea NOT NULL,
    config_envelope bytea,
    key_version integer NOT NULL CHECK (key_version > 0),
    rate_limit_per_minute integer NOT NULL DEFAULT 600
        CHECK (rate_limit_per_minute BETWEEN 1 AND 1000000),
    max_body_bytes integer NOT NULL DEFAULT 1048576
        CHECK (max_body_bytes BETWEEN 1024 AND 10485760),
    reconciliation_enabled boolean NOT NULL DEFAULT true,
    reconciliation_window_hours smallint NOT NULL DEFAULT 48
        CHECK (reconciliation_window_hours BETWEEN 1 AND 168),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (endpoint_key),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, name),
    CONSTRAINT webhook_sources_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.destinations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('http', 'webhook', 'internal')),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    config_envelope bytea NOT NULL,
    key_version integer NOT NULL CHECK (key_version > 0),
    allowed_hosts text[] NOT NULL DEFAULT ARRAY[]::text[],
    timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 120000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, name),
    CONSTRAINT destinations_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.pipelines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'disabled')),
    event_type_filter text[] NOT NULL DEFAULT ARRAY[]::text[],
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, source_id, name),
    CONSTRAINT pipelines_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT pipelines_source_fk
        FOREIGN KEY (tenant_id, source_id)
        REFERENCES sluice.webhook_sources (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.pipeline_destinations (
    tenant_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    destination_id uuid NOT NULL,
    position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, pipeline_id, destination_id),
    UNIQUE (tenant_id, pipeline_id, position),
    CONSTRAINT pipeline_destinations_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT pipeline_destinations_pipeline_fk
        FOREIGN KEY (tenant_id, pipeline_id)
        REFERENCES sluice.pipelines (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT pipeline_destinations_destination_fk
        FOREIGN KEY (tenant_id, destination_id)
        REFERENCES sluice.destinations (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    pipeline_id uuid,
    external_event_id_hash bytea NOT NULL,
    external_event_id_envelope bytea,
    provider_event_type text NOT NULL,
    payload_hash bytea NOT NULL,
    raw_body_envelope bytea,
    key_version integer NOT NULL CHECK (key_version > 0),
    content_type text NOT NULL DEFAULT 'application/json',
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    sanitized_headers jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(sanitized_headers) = 'object'),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    purge_after timestamptz NOT NULL,
    payload_purged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, source_id, external_event_id_hash),
    CONSTRAINT webhook_events_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT webhook_events_source_fk
        FOREIGN KEY (tenant_id, source_id)
        REFERENCES sluice.webhook_sources (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT webhook_events_pipeline_fk
        FOREIGN KEY (tenant_id, pipeline_id)
        REFERENCES sluice.pipelines (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT webhook_events_envelope_state_ck CHECK (
        (raw_body_envelope IS NULL AND payload_purged_at IS NOT NULL)
        OR
        (raw_body_envelope IS NOT NULL AND payload_purged_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS sluice.jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    event_id uuid,
    pipeline_id uuid,
    destination_id uuid,
    job_type text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
    priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
    max_attempts smallint NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
    delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claimed_at timestamptz,
    claimed_by text,
    lease_token uuid,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    completed_at timestamptz,
    dead_lettered_at timestamptz,
    last_error_code text,
    last_error text,
    arguments jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(arguments) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, job_type, idempotency_key),
    CONSTRAINT jobs_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT jobs_event_fk
        FOREIGN KEY (tenant_id, event_id)
        REFERENCES sluice.webhook_events (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT jobs_pipeline_fk
        FOREIGN KEY (tenant_id, pipeline_id)
        REFERENCES sluice.pipelines (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT jobs_destination_fk
        FOREIGN KEY (tenant_id, destination_id)
        REFERENCES sluice.destinations (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT jobs_lease_state_ck CHECK (
        (status = 'processing'
            AND claimed_at IS NOT NULL
            AND claimed_by IS NOT NULL
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'processing'
            AND lease_token IS NULL
            AND lease_expires_at IS NULL)
    ),
    CONSTRAINT jobs_terminal_state_ck CHECK (
        (status = 'completed' AND completed_at IS NOT NULL AND dead_lettered_at IS NULL)
        OR
        (status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND completed_at IS NULL)
        OR
        (status IN ('pending', 'processing') AND completed_at IS NULL AND dead_lettered_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS sluice.job_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    lease_token uuid NOT NULL,
    worker_id text NOT NULL,
    status text NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'succeeded', 'failed', 'lease_expired', 'dead_lettered')),
    error_code text,
    error_message text,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    duration_ms bigint,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, job_id, attempt_number),
    UNIQUE (tenant_id, job_id, lease_token),
    CONSTRAINT job_attempts_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT job_attempts_job_fk
        FOREIGN KEY (tenant_id, job_id)
        REFERENCES sluice.jobs (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.job_delivery_effects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    job_id uuid NOT NULL,
    destination_id uuid,
    effect_key text NOT NULL,
    status text NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'applied', 'failed')),
    external_reference_hash bytea,
    response_code integer,
    reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    applied_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, effect_key),
    CONSTRAINT job_delivery_effects_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT job_delivery_effects_job_fk
        FOREIGN KEY (tenant_id, job_id)
        REFERENCES sluice.jobs (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT job_delivery_effects_destination_fk
        FOREIGN KEY (tenant_id, destination_id)
        REFERENCES sluice.destinations (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL,
    actor_type text NOT NULL
        CHECK (actor_type IN ('user', 'api', 'worker', 'scheduler', 'system')),
    actor_id text,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    request_id text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    CONSTRAINT audit_log_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.notification_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    job_id uuid,
    channel text NOT NULL CHECK (channel IN ('email', 'webhook', 'dashboard')),
    template_key text NOT NULL,
    dedupe_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(payload) = 'object'),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claimed_by text,
    lease_token uuid,
    lease_expires_at timestamptz,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, channel, dedupe_key),
    CONSTRAINT notification_outbox_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT notification_outbox_job_fk
        FOREIGN KEY (tenant_id, job_id)
        REFERENCES sluice.jobs (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sluice.reconciliation_checkpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    cursor_envelope bytea,
    key_version integer CHECK (key_version > 0),
    window_started_at timestamptz,
    window_ended_at timestamptz,
    last_enqueued_at timestamptz,
    last_succeeded_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, source_id),
    CONSTRAINT reconciliation_checkpoints_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT,
    CONSTRAINT reconciliation_checkpoints_source_fk
        FOREIGN KEY (tenant_id, source_id)
        REFERENCES sluice.webhook_sources (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT reconciliation_checkpoint_envelope_ck CHECK (
        (cursor_envelope IS NULL AND key_version IS NULL)
        OR
        (cursor_envelope IS NOT NULL AND key_version IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS sluice.usage_rollups (
    tenant_id uuid NOT NULL,
    bucket_start timestamptz NOT NULL,
    bucket_interval text NOT NULL DEFAULT 'hour'
        CHECK (bucket_interval IN ('hour', 'day', 'month')),
    events_received bigint NOT NULL DEFAULT 0 CHECK (events_received >= 0),
    bytes_ingested bigint NOT NULL DEFAULT 0 CHECK (bytes_ingested >= 0),
    jobs_created bigint NOT NULL DEFAULT 0 CHECK (jobs_created >= 0),
    jobs_completed bigint NOT NULL DEFAULT 0 CHECK (jobs_completed >= 0),
    jobs_retried bigint NOT NULL DEFAULT 0 CHECK (jobs_retried >= 0),
    jobs_dead_lettered bigint NOT NULL DEFAULT 0 CHECK (jobs_dead_lettered >= 0),
    processing_duration_ms bigint NOT NULL DEFAULT 0 CHECK (processing_duration_ms >= 0),
    calculated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, bucket_start, bucket_interval),
    CONSTRAINT usage_rollups_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES sluice.tenants (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS webhook_events_received_idx
    ON sluice.webhook_events (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_events_purge_idx
    ON sluice.webhook_events (purge_after, id)
    WHERE raw_body_envelope IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_claim_idx
    ON sluice.jobs (priority, available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS jobs_tenant_status_idx
    ON sluice.jobs (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_expired_lease_idx
    ON sluice.jobs (lease_expires_at, id)
    WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS job_attempts_job_idx
    ON sluice.job_attempts (tenant_id, job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS notification_outbox_claim_idx
    ON sluice.notification_outbox (available_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx
    ON sluice.audit_log (tenant_id, created_at DESC);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'tenants', 'users', 'tenant_memberships', 'webhook_sources',
        'destinations', 'pipelines', 'job_delivery_effects',
        'notification_outbox', 'reconciliation_checkpoints'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON sluice.%I',
                       table_name || '_touch_updated_at', table_name);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON sluice.%I
             FOR EACH ROW EXECUTE FUNCTION sluice.touch_updated_at()',
            table_name || '_touch_updated_at', table_name
        );
    END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION sluice.protect_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only'
        USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS audit_log_append_only ON sluice.audit_log;
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON sluice.audit_log
FOR EACH ROW EXECUTE FUNCTION sluice.protect_audit_log();

CREATE OR REPLACE FUNCTION sluice.validate_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id THEN
        RAISE EXCEPTION 'job identity is immutable' USING ERRCODE = '23514';
    END IF;

    IF OLD.status IN ('completed', 'dead_letter') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'terminal job cannot transition from %', OLD.status
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION 'invalid job transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'processing'
       AND NEW.status NOT IN ('processing', 'pending', 'completed', 'dead_letter') THEN
        RAISE EXCEPTION 'invalid job transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jobs_validate_transition ON sluice.jobs;
CREATE TRIGGER jobs_validate_transition
BEFORE UPDATE ON sluice.jobs
FOR EACH ROW EXECUTE FUNCTION sluice.validate_job_transition();

CREATE OR REPLACE FUNCTION sluice.audit_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO sluice.audit_log (
            tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata
        )
        VALUES (
            NEW.tenant_id,
            CASE
                WHEN NEW.claimed_by IS NOT NULL THEN 'worker'
                ELSE 'system'
            END,
            COALESCE(NEW.claimed_by, current_setting('app.actor_id', true)),
            'job.' || NEW.status,
            'job',
            NEW.id::text,
            jsonb_build_object(
                'from', OLD.status,
                'to', NEW.status,
                'delivery_count', NEW.delivery_count
            )
        );
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jobs_audit_transition ON sluice.jobs;
CREATE TRIGGER jobs_audit_transition
AFTER UPDATE OF status ON sluice.jobs
FOR EACH ROW EXECUTE FUNCTION sluice.audit_job_transition();

RESET ROLE;
