\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(required.name, ', ' ORDER BY required.name)
      INTO v_missing
      FROM (
          VALUES ('citext'), ('pg_cron'), ('pgcrypto'), ('plpgsql')
      ) AS required(name)
     WHERE NOT EXISTS (
         SELECT 1
         FROM pg_extension AS extension
         WHERE extension.extname = required.name
     );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'missing required extensions: %', v_missing;
    END IF;

    IF (
        SELECT count(*)
        FROM cron.job
        WHERE jobname IN (
            'sluice-retry-sweep',
            'sluice-notification-lease-sweep',
            'sluice-lgpd-purge',
            'sluice-usage-rollup',
            'sluice-reconciliation-enqueue'
        )
          AND active
    ) <> 5 THEN
        RAISE EXCEPTION 'expected five active Sluice pg_cron jobs';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'sluice_owner'
          AND rolbypassrls
          AND NOT rolcanlogin
    ) THEN
        RAISE EXCEPTION 'sluice_owner role contract is invalid';
    END IF;
    IF (
        SELECT count(*)
        FROM pg_roles
        WHERE rolname IN (
            'sluice_api',
            'sluice_worker',
            'sluice_dashboard',
            'sluice_readonly'
        )
          AND rolcanlogin
          AND NOT rolbypassrls
    ) <> 4 THEN
        RAISE EXCEPTION 'runtime LOGIN role contract is invalid';
    END IF;
END
$$;

SELECT
    set_config('test.tenant_id', gen_random_uuid()::text, false),
    set_config('test.other_tenant_id', gen_random_uuid()::text, false),
    set_config('test.owner_id', gen_random_uuid()::text, false),
    set_config('test.viewer_id', gen_random_uuid()::text, false),
    set_config('test.source_id', gen_random_uuid()::text, false),
    set_config('test.source_endpoint', gen_random_uuid()::text, false),
    set_config('test.admin_source_id', gen_random_uuid()::text, false),
    set_config('test.admin_source_endpoint', gen_random_uuid()::text, false),
    set_config('test.destination_id', gen_random_uuid()::text, false),
    set_config('test.pipeline_id', gen_random_uuid()::text, false);

SET ROLE sluice_owner;

INSERT INTO sluice.tenants (
    id,
    slug,
    name,
    raw_payload_retention_days
)
VALUES (
    current_setting('test.tenant_id')::uuid,
    (
        'contract-' ||
        left(replace(current_setting('test.tenant_id'), '-', ''), 20)
    )::public.citext,
    'Contract primary tenant',
    1
);

INSERT INTO sluice.tenants (id, slug, name)
VALUES (
    current_setting('test.other_tenant_id')::uuid,
    (
        'contract-' ||
        left(replace(current_setting('test.other_tenant_id'), '-', ''), 20)
    )::public.citext,
    'Contract isolation tenant'
);

INSERT INTO sluice.users (
    id,
    email,
    display_name,
    password_hash,
    status
)
VALUES
(
    current_setting('test.owner_id')::uuid,
    (
        'owner-' ||
        replace(current_setting('test.owner_id'), '-', '') ||
        '@contract.test'
    )::public.citext,
    'Contract Owner',
    '$argon2id$v=19$m=65536,t=3,p=1$contract$owner',
    'active'
),
(
    current_setting('test.viewer_id')::uuid,
    (
        'viewer-' ||
        replace(current_setting('test.viewer_id'), '-', '') ||
        '@contract.test'
    )::public.citext,
    'Contract Viewer',
    '$argon2id$v=19$m=65536,t=3,p=1$contract$viewer',
    'active'
);

INSERT INTO sluice.tenant_memberships (tenant_id, user_id, role)
VALUES
(
    current_setting('test.tenant_id')::uuid,
    current_setting('test.owner_id')::uuid,
    'owner'
),
(
    current_setting('test.tenant_id')::uuid,
    current_setting('test.viewer_id')::uuid,
    'viewer'
);

INSERT INTO sluice.webhook_sources (
    id,
    tenant_id,
    endpoint_key,
    provider,
    name,
    signing_secret_envelope,
    config_envelope,
    key_version
)
VALUES (
    current_setting('test.source_id')::uuid,
    current_setting('test.tenant_id')::uuid,
    current_setting('test.source_endpoint')::uuid,
    'stripe',
    'Contract source',
    decode('0102', 'hex'),
    decode('0304', 'hex'),
    1
);

RESET ROLE;
SET ROLE sluice_dashboard;

SELECT set_config(
    'app.tenant_id',
    current_setting('test.tenant_id'),
    true
);
SELECT set_config(
    'app.user_id',
    current_setting('test.owner_id'),
    true
);

DO $$
BEGIN
    IF (SELECT count(*) FROM sluice.tenants) <> 1 THEN
        RAISE EXCEPTION 'dashboard tenant RLS did not isolate the current tenant';
    END IF;
    IF NOT sluice.current_user_is_tenant_admin(
        current_setting('test.tenant_id')::uuid
    ) THEN
        RAISE EXCEPTION 'owner was not recognized as tenant administrator';
    END IF;
    IF (
        SELECT count(*)
        FROM sluice.lookup_dashboard_login(
            upper(
                'owner-' ||
                replace(current_setting('test.owner_id'), '-', '') ||
                '@contract.test'
            )
        )
    ) <> 1 THEN
        RAISE EXCEPTION 'dashboard login lookup is not case insensitive';
    END IF;
END
$$;

SELECT set_config(
    'test.created_tenant_id',
    sluice.admin_create_tenant(
        'created-' ||
            left(replace(current_setting('test.tenant_id'), '-', ''), 20),
        'Contract-created tenant',
        3650
    )::text,
    false
);

SELECT set_config(
    'app.tenant_id',
    current_setting('test.created_tenant_id'),
    true
);
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM sluice.tenants
        WHERE id = current_setting('test.created_tenant_id')::uuid
          AND raw_payload_retention_days = 3650
          AND dedupe_metadata_retention_days = 3650
    ) THEN
        RAISE EXCEPTION 'admin_create_tenant did not preserve retention invariants';
    END IF;
END
$$;

SELECT set_config(
    'app.tenant_id',
    current_setting('test.tenant_id'),
    true
);

INSERT INTO sluice.webhook_sources (
    id,
    tenant_id,
    endpoint_key,
    provider,
    name,
    signing_secret_envelope,
    config_envelope,
    key_version
)
VALUES (
    current_setting('test.admin_source_id')::uuid,
    current_setting('test.tenant_id')::uuid,
    current_setting('test.admin_source_endpoint')::uuid,
    'generic',
    'Dashboard-created source',
    decode('0506', 'hex'),
    decode('0708', 'hex'),
    1
);

INSERT INTO sluice.destinations (
    id,
    tenant_id,
    name,
    kind,
    config_envelope,
    key_version,
    allowed_hosts
)
VALUES (
    current_setting('test.destination_id')::uuid,
    current_setting('test.tenant_id')::uuid,
    'Dashboard-created destination',
    'webhook',
    decode('090a', 'hex'),
    1,
    ARRAY['contract.test']::text[]
);

INSERT INTO sluice.pipelines (
    id,
    tenant_id,
    source_id,
    name
)
VALUES (
    current_setting('test.pipeline_id')::uuid,
    current_setting('test.tenant_id')::uuid,
    current_setting('test.source_id')::uuid,
    'Dashboard-created pipeline'
);

INSERT INTO sluice.pipeline_destinations (
    tenant_id,
    pipeline_id,
    destination_id,
    position
)
VALUES (
    current_setting('test.tenant_id')::uuid,
    current_setting('test.pipeline_id')::uuid,
    current_setting('test.destination_id')::uuid,
    0
);

INSERT INTO sluice.audit_log (
    tenant_id,
    actor_type,
    actor_id,
    action,
    resource_type,
    resource_id
)
VALUES (
    current_setting('test.tenant_id')::uuid,
    'user',
    current_setting('test.owner_id'),
    'contract.dashboard_write',
    'pipeline',
    current_setting('test.pipeline_id')
);

DO $$
BEGIN
    BEGIN
        PERFORM sluice.admin_set_membership(
            current_setting('test.tenant_id')::uuid,
            'owner-' ||
                replace(current_setting('test.owner_id'), '-', '') ||
                '@contract.test',
            'Contract Owner',
            'viewer'
        );
        RAISE EXCEPTION 'final owner was unexpectedly demoted';
    EXCEPTION
        WHEN SQLSTATE '55000' THEN
            NULL;
    END;
END
$$;

SELECT set_config(
    'app.user_id',
    current_setting('test.viewer_id'),
    true
);

DO $$
DECLARE
    v_rows integer;
BEGIN
    IF sluice.current_user_is_tenant_admin(
        current_setting('test.tenant_id')::uuid
    ) THEN
        RAISE EXCEPTION 'viewer was incorrectly recognized as administrator';
    END IF;

    UPDATE sluice.webhook_sources
       SET status = 'disabled'
     WHERE id = current_setting('test.source_id')::uuid;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'viewer unexpectedly updated a source';
    END IF;

    BEGIN
        INSERT INTO sluice.webhook_sources (
            tenant_id,
            provider,
            name,
            signing_secret_envelope,
            key_version
        )
        VALUES (
            current_setting('test.tenant_id')::uuid,
            'generic',
            'Forbidden viewer source',
            decode('0b', 'hex'),
            1
        );
        RAISE EXCEPTION 'viewer unexpectedly inserted a source';
    EXCEPTION
        WHEN insufficient_privilege THEN
            NULL;
    END;

    BEGIN
        PERFORM sluice.admin_create_tenant(
            'forbidden-' ||
                left(replace(current_setting('test.viewer_id'), '-', ''), 20),
            'Forbidden viewer tenant',
            90
        );
        RAISE EXCEPTION 'viewer unexpectedly created a tenant';
    EXCEPTION
        WHEN insufficient_privilege THEN
            NULL;
    END;
END
$$;

SELECT set_config(
    'app.user_id',
    current_setting('test.owner_id'),
    true
);
SELECT set_config(
    'app.tenant_id',
    current_setting('test.other_tenant_id'),
    true
);
DO $$
BEGIN
    IF (SELECT count(*) FROM sluice.webhook_sources) <> 0 THEN
        RAISE EXCEPTION 'cross-tenant source rows were visible';
    END IF;
END
$$;

RESET ROLE;
SET ROLE sluice_readonly;

SELECT set_config('app.tenant_id', '', true);
DO $$
BEGIN
    IF (SELECT count(*) FROM sluice.webhook_sources) <> 0 THEN
        RAISE EXCEPTION 'readonly role saw rows without tenant context';
    END IF;
END
$$;
SELECT set_config(
    'app.tenant_id',
    current_setting('test.tenant_id'),
    true
);
DO $$
BEGIN
    IF (SELECT count(*) FROM sluice.webhook_sources) <> 2 THEN
        RAISE EXCEPTION 'readonly tenant context did not expose expected rows';
    END IF;
    IF has_table_privilege(
        current_user,
        'sluice.webhook_sources',
        'INSERT'
    ) THEN
        RAISE EXCEPTION 'readonly role unexpectedly has write privileges';
    END IF;
END
$$;

RESET ROLE;
SET ROLE sluice_api;

DO $$
DECLARE
    v_result record;
    v_duplicate record;
    v_conflict record;
BEGIN
    IF (
        SELECT count(*)
        FROM sluice.resolve_webhook_source(
            current_setting('test.source_endpoint')::uuid
        )
    ) <> 1 THEN
        RAISE EXCEPTION 'API could not resolve its active webhook source';
    END IF;
    IF has_table_privilege(
        current_user,
        'sluice.webhook_events',
        'SELECT'
    ) THEN
        RAISE EXCEPTION 'API unexpectedly has direct event table access';
    END IF;

    SELECT *
      INTO v_result
      FROM sluice.ingest_event_and_enqueue(
          current_setting('test.tenant_id')::uuid,
          current_setting('test.source_id')::uuid,
          decode(repeat('11', 32), 'hex'),
          decode('a1', 'hex'),
          'contract.completed',
          decode(repeat('21', 32), 'hex'),
          decode('b1', 'hex'),
          1,
          'application/json',
          '{"x-request-id":"contract-1"}'::jsonb,
          NULL,
          'deliver_event',
          'contract:complete',
          10::smallint,
          2::smallint
      );
    IF v_result.outcome <> 'inserted' THEN
        RAISE EXCEPTION 'first ingestion outcome was %', v_result.outcome;
    END IF;
    PERFORM set_config('test.complete_event_id', v_result.event_id::text, false);
    PERFORM set_config('test.complete_job_id', v_result.job_id::text, false);

    SELECT *
      INTO v_duplicate
      FROM sluice.ingest_event_and_enqueue(
          current_setting('test.tenant_id')::uuid,
          current_setting('test.source_id')::uuid,
          decode(repeat('11', 32), 'hex'),
          decode('a1', 'hex'),
          'contract.completed',
          decode(repeat('21', 32), 'hex'),
          decode('b1', 'hex'),
          1,
          'application/json',
          '{}'::jsonb,
          NULL,
          'deliver_event',
          'contract:complete',
          10::smallint,
          2::smallint
      );
    IF v_duplicate.outcome <> 'duplicate'
       OR v_duplicate.event_id <> v_result.event_id
       OR v_duplicate.job_id <> v_result.job_id THEN
        RAISE EXCEPTION 'deduplication contract failed';
    END IF;

    SELECT *
      INTO v_conflict
      FROM sluice.ingest_event_and_enqueue(
          current_setting('test.tenant_id')::uuid,
          current_setting('test.source_id')::uuid,
          decode(repeat('11', 32), 'hex'),
          decode('a1', 'hex'),
          'contract.completed',
          decode(repeat('22', 32), 'hex'),
          decode('b2', 'hex'),
          1,
          'application/json',
          '{}'::jsonb,
          NULL,
          'deliver_event',
          'contract:complete',
          10::smallint,
          2::smallint
      );
    IF v_conflict.outcome <> 'conflict'
       OR v_conflict.job_id IS NOT NULL THEN
        RAISE EXCEPTION 'dedupe payload-conflict contract failed';
    END IF;

    SELECT *
      INTO v_result
      FROM sluice.ingest_event_and_enqueue(
          current_setting('test.tenant_id')::uuid,
          current_setting('test.source_id')::uuid,
          decode(repeat('12', 32), 'hex'),
          decode('a2', 'hex'),
          'contract.failed',
          decode(repeat('23', 32), 'hex'),
          decode('b3', 'hex'),
          1,
          'application/json',
          '{}'::jsonb,
          NULL,
          'deliver_event',
          'contract:fail',
          20::smallint,
          2::smallint
      );
    PERFORM set_config('test.fail_job_id', v_result.job_id::text, false);

    SELECT *
      INTO v_result
      FROM sluice.ingest_event_and_enqueue(
          current_setting('test.tenant_id')::uuid,
          current_setting('test.source_id')::uuid,
          decode(repeat('13', 32), 'hex'),
          decode('a3', 'hex'),
          'contract.lease_expired',
          decode(repeat('24', 32), 'hex'),
          decode('b4', 'hex'),
          1,
          'application/json',
          '{}'::jsonb,
          NULL,
          'deliver_event',
          'contract:lease-expired',
          30::smallint,
          1::smallint
      );
    PERFORM set_config('test.sweep_job_id', v_result.job_id::text, false);

    BEGIN
        PERFORM 1
        FROM sluice.ingest_event_and_enqueue(
            current_setting('test.tenant_id')::uuid,
            current_setting('test.source_id')::uuid,
            decode(repeat('14', 32), 'hex'),
            decode('a4', 'hex'),
            'contract.idempotency_collision',
            decode(repeat('25', 32), 'hex'),
            decode('b5', 'hex'),
            1,
            'application/json',
            '{}'::jsonb,
            NULL,
            'deliver_event',
            'contract:complete',
            40::smallint,
            2::smallint
        );
        RAISE EXCEPTION 'job idempotency collision unexpectedly succeeded';
    EXCEPTION
        WHEN unique_violation THEN
            NULL;
    END;
END
$$;

RESET ROLE;
SET ROLE sluice_worker;

SELECT set_config('app.tenant_id', '', true);

DO $$
DECLARE
    v_claim record;
    v_effect record;
    v_duplicate_effect record;
BEGIN
    IF (SELECT count(*) FROM sluice.jobs) <> 0 THEN
        RAISE EXCEPTION 'worker saw rows without tenant context';
    END IF;

    SELECT *
      INTO v_claim
      FROM sluice.claim_jobs(
          'contract-worker-complete',
          1,
          60,
          current_setting('test.tenant_id')::uuid
      );
    IF v_claim.job_id <> current_setting('test.complete_job_id')::uuid THEN
        RAISE EXCEPTION 'worker claimed an unexpected first job';
    END IF;
    IF sluice.heartbeat_job(
        v_claim.tenant_id,
        v_claim.job_id,
        '00000000-0000-0000-0000-000000000000',
        60
    ) THEN
        RAISE EXCEPTION 'heartbeat accepted a wrong fencing token';
    END IF;
    IF NOT sluice.heartbeat_job(
        v_claim.tenant_id,
        v_claim.job_id,
        v_claim.lease_token,
        60
    ) THEN
        RAISE EXCEPTION 'heartbeat rejected a valid lease';
    END IF;

    SELECT *
      INTO v_effect
      FROM sluice.reserve_delivery_effect(
          v_claim.tenant_id,
          v_claim.job_id,
          current_setting('test.destination_id')::uuid,
          'contract:effect'
      );
    SELECT *
      INTO v_duplicate_effect
      FROM sluice.reserve_delivery_effect(
          v_claim.tenant_id,
          v_claim.job_id,
          current_setting('test.destination_id')::uuid,
          'contract:effect'
      );
    IF NOT v_effect.acquired OR v_duplicate_effect.acquired THEN
        RAISE EXCEPTION 'delivery effect reservation was not idempotent';
    END IF;
    IF NOT sluice.mark_delivery_effect_applied(
        v_claim.tenant_id,
        v_effect.effect_id,
        decode(repeat('31', 32), 'hex'),
        200
    ) THEN
        RAISE EXCEPTION 'delivery effect could not be marked applied';
    END IF;

    IF sluice.complete_job(
        v_claim.tenant_id,
        v_claim.job_id,
        '00000000-0000-0000-0000-000000000000'
    ) THEN
        RAISE EXCEPTION 'completion accepted a wrong fencing token';
    END IF;
    IF NOT sluice.complete_job(
        v_claim.tenant_id,
        v_claim.job_id,
        v_claim.lease_token
    ) THEN
        RAISE EXCEPTION 'completion rejected a valid lease';
    END IF;
    IF sluice.complete_job(
        v_claim.tenant_id,
        v_claim.job_id,
        v_claim.lease_token
    ) THEN
        RAISE EXCEPTION 'completion accepted a stale lease';
    END IF;

    SELECT *
      INTO v_claim
      FROM sluice.claim_jobs(
          'contract-worker-fail',
          1,
          60,
          current_setting('test.tenant_id')::uuid
      );
    IF v_claim.job_id <> current_setting('test.fail_job_id')::uuid THEN
        RAISE EXCEPTION 'worker claimed an unexpected failure job';
    END IF;
    IF sluice.fail_job(
        v_claim.tenant_id,
        v_claim.job_id,
        v_claim.lease_token,
        'temporary',
        'contract retry',
        0
    ) <> 'pending' THEN
        RAISE EXCEPTION 'first failure was not requeued';
    END IF;

    SELECT *
      INTO v_claim
      FROM sluice.claim_jobs(
          'contract-worker-fail',
          1,
          60,
          current_setting('test.tenant_id')::uuid
      );
    IF v_claim.job_id <> current_setting('test.fail_job_id')::uuid
       OR v_claim.delivery_count <> 2 THEN
        RAISE EXCEPTION 'retry delivery was not reclaimed correctly';
    END IF;
    IF sluice.fail_job(
        v_claim.tenant_id,
        v_claim.job_id,
        v_claim.lease_token,
        'permanent',
        'contract dead-letter',
        0
    ) <> 'dead_letter' THEN
        RAISE EXCEPTION 'final failure was not dead-lettered';
    END IF;

    SELECT *
      INTO v_claim
      FROM sluice.claim_jobs(
          'contract-worker-expire',
          1,
          60,
          current_setting('test.tenant_id')::uuid
      );
    IF v_claim.job_id <> current_setting('test.sweep_job_id')::uuid THEN
        RAISE EXCEPTION 'worker claimed an unexpected lease-sweep job';
    END IF;
    PERFORM set_config('test.sweep_lease_token', v_claim.lease_token::text, false);
END
$$;

RESET ROLE;
SET ROLE sluice_owner;

UPDATE sluice.jobs
   SET lease_expires_at = clock_timestamp() - interval '1 second'
 WHERE id = current_setting('test.sweep_job_id')::uuid;

RESET ROLE;
SET ROLE sluice_maintenance;

DO $$
DECLARE
    v_sweep record;
BEGIN
    SELECT *
      INTO v_sweep
      FROM sluice.sweep_expired_job_leases(100);
    IF v_sweep.jobs_requeued <> 0 OR v_sweep.jobs_dead_lettered <> 1 THEN
        RAISE EXCEPTION 'job lease sweep returned unexpected counts: %, %',
            v_sweep.jobs_requeued,
            v_sweep.jobs_dead_lettered;
    END IF;
END
$$;

RESET ROLE;
SET ROLE sluice_worker;

DO $$
DECLARE
    v_notification record;
BEGIN
    IF sluice.complete_job(
        current_setting('test.tenant_id')::uuid,
        current_setting('test.sweep_job_id')::uuid,
        current_setting('test.sweep_lease_token')::uuid
    ) THEN
        RAISE EXCEPTION 'expired worker completed a swept job';
    END IF;

    SELECT *
      INTO v_notification
      FROM sluice.claim_notifications(
          'contract-notifier-expire',
          1,
          60
      );
    IF v_notification.notification_id IS NULL THEN
        RAISE EXCEPTION 'dead-letter notification was not durable';
    END IF;
    PERFORM set_config(
        'test.notification_id',
        v_notification.notification_id::text,
        false
    );
    PERFORM set_config(
        'test.notification_lease_token',
        v_notification.lease_token::text,
        false
    );
END
$$;

RESET ROLE;
SET ROLE sluice_owner;

UPDATE sluice.notification_outbox
   SET lease_expires_at = clock_timestamp() - interval '1 second'
 WHERE id = current_setting('test.notification_id')::uuid;

RESET ROLE;
SET ROLE sluice_maintenance;

DO $$
DECLARE
    v_sweep record;
BEGIN
    SELECT *
      INTO v_sweep
      FROM sluice.sweep_expired_notification_leases(100);
    IF v_sweep.notifications_requeued <> 1
       OR v_sweep.notifications_failed <> 0 THEN
        RAISE EXCEPTION 'notification lease sweep returned unexpected counts';
    END IF;
END
$$;

RESET ROLE;
SET ROLE sluice_worker;

DO $$
BEGIN
    IF sluice.complete_notification(
        current_setting('test.tenant_id')::uuid,
        current_setting('test.notification_id')::uuid,
        current_setting('test.notification_lease_token')::uuid
    ) THEN
        RAISE EXCEPTION 'expired notifier completed a swept notification';
    END IF;
END
$$;

RESET ROLE;
SET ROLE sluice_owner;

UPDATE sluice.notification_outbox
   SET available_at = clock_timestamp()
 WHERE id = current_setting('test.notification_id')::uuid;
UPDATE sluice.notification_outbox
   SET available_at = clock_timestamp() + interval '1 hour'
 WHERE id <> current_setting('test.notification_id')::uuid
   AND status = 'pending';

RESET ROLE;
SET ROLE sluice_worker;

DO $$
DECLARE
    v_notification record;
BEGIN
    SELECT *
      INTO v_notification
      FROM sluice.claim_notifications(
          'contract-notifier-complete',
          1,
          60
      );
    IF v_notification.notification_id <>
       current_setting('test.notification_id')::uuid THEN
        RAISE EXCEPTION 'expected notification was not reclaimed';
    END IF;
    IF NOT sluice.complete_notification(
        v_notification.tenant_id,
        v_notification.notification_id,
        v_notification.lease_token
    ) THEN
        RAISE EXCEPTION 'valid notification completion failed';
    END IF;
END
$$;

RESET ROLE;
SET ROLE sluice_owner;

UPDATE sluice.webhook_events
   SET purge_after = clock_timestamp() - interval '1 second'
 WHERE id = current_setting('test.complete_event_id')::uuid;
UPDATE sluice.jobs
   SET arguments = '{"raw":"must be scrubbed"}'::jsonb,
       last_error = 'must be scrubbed'
 WHERE id = current_setting('test.complete_job_id')::uuid;

RESET ROLE;
SET ROLE sluice_maintenance;

DO $$
DECLARE
    v_purged integer;
    v_rollups integer;
    v_reconciliations integer;
BEGIN
    v_purged := sluice.purge_expired_payloads(100);
    IF v_purged <> 1 THEN
        RAISE EXCEPTION 'expected one payload purge, got %', v_purged;
    END IF;

    v_rollups := sluice.rollup_usage_metrics(
        date_trunc('hour', clock_timestamp()),
        date_trunc('hour', clock_timestamp()) + interval '1 hour'
    );
    IF v_rollups < 1 THEN
        RAISE EXCEPTION 'usage rollup did not write any rows';
    END IF;

    v_reconciliations := sluice.enqueue_reconciliation_jobs(
        clock_timestamp()
    );
    IF v_reconciliations < 2 THEN
        RAISE EXCEPTION 'reconciliation jobs were not enqueued for active sources';
    END IF;
END
$$;

RESET ROLE;
SET ROLE sluice_owner;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM sluice.webhook_events
        WHERE id = current_setting('test.complete_event_id')::uuid
          AND raw_body_envelope IS NULL
          AND external_event_id_envelope IS NULL
          AND sanitized_headers = '{}'::jsonb
          AND payload_purged_at IS NOT NULL
          AND external_event_id_hash = decode(repeat('11', 32), 'hex')
          AND payload_hash = decode(repeat('21', 32), 'hex')
    ) THEN
        RAISE EXCEPTION 'payload purge did not preserve only dedupe metadata';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM sluice.jobs
        WHERE id = current_setting('test.complete_job_id')::uuid
          AND arguments = jsonb_build_object(
              'event_id',
              current_setting('test.complete_event_id')::uuid,
              'payload_purged',
              true
          )
          AND last_error = '[redacted by retention policy]'
    ) THEN
        RAISE EXCEPTION 'payload purge did not scrub job copies';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM sluice.usage_rollups
        WHERE tenant_id = current_setting('test.tenant_id')::uuid
          AND bucket_start = date_trunc('hour', clock_timestamp())
          AND events_received = 3
          AND jobs_created = 3
          AND jobs_completed = 1
          AND jobs_dead_lettered = 2
    ) THEN
        RAISE EXCEPTION 'usage rollup counts are incorrect';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM sluice.webhook_events
        WHERE external_event_id_hash = decode(repeat('14', 32), 'hex')
    ) THEN
        RAISE EXCEPTION 'idempotency collision left a partial event';
    END IF;
END
$$;

RESET ROLE;
ROLLBACK;

\echo 'Sluice database contract tests passed.'
