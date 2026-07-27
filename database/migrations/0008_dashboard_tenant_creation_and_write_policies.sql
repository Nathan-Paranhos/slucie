\set ON_ERROR_STOP on

SET ROLE sluice_owner;
SET search_path = sluice, pg_catalog;

-- Expose only the authorization decision for the current dashboard identity.
-- The more general is_tenant_admin(uuid, uuid) function remains private so a
-- dashboard session cannot probe another user's memberships.
CREATE OR REPLACE FUNCTION sluice.current_user_is_tenant_admin(
    p_tenant_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT sluice.is_tenant_admin(
        p_tenant_id,
        sluice.current_user_id()
    )
$$;

-- Argument order intentionally matches the dashboard contract:
-- admin_create_tenant(slug, name, retention_days).
CREATE OR REPLACE FUNCTION sluice.admin_create_tenant(
    p_slug text,
    p_name text,
    p_raw_payload_retention_days integer DEFAULT 90
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid := sluice.current_user_id();
    v_authorizing_tenant_id uuid := sluice.current_tenant_id();
    v_tenant_id uuid;
    v_slug text := lower(btrim(p_slug));
    v_name text := btrim(p_name);
BEGIN
    IF v_actor_id IS NULL OR v_authorizing_tenant_id IS NULL THEN
        RAISE EXCEPTION 'authenticated tenant context is required'
            USING ERRCODE = '42501';
    END IF;
    IF NOT sluice.is_tenant_admin(
        v_authorizing_tenant_id,
        v_actor_id
    ) THEN
        RAISE EXCEPTION 'tenant administrator permission required'
            USING ERRCODE = '42501';
    END IF;
    IF v_slug IS NULL
       OR v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
       OR char_length(v_slug) > 63 THEN
        RAISE EXCEPTION 'invalid tenant slug'
            USING ERRCODE = '22023',
                  HINT = 'Use 1-63 lowercase ASCII letters, digits, and single hyphens.';
    END IF;
    IF v_name IS NULL
       OR char_length(v_name) < 3
       OR char_length(v_name) > 160 THEN
        RAISE EXCEPTION 'tenant name must contain between 3 and 160 characters'
            USING ERRCODE = '22023';
    END IF;
    IF p_raw_payload_retention_days IS NULL
       OR p_raw_payload_retention_days NOT BETWEEN 1 AND 3650 THEN
        RAISE EXCEPTION 'retention days must be between 1 and 3650'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO sluice.tenants (
        slug,
        name,
        raw_payload_retention_days,
        dedupe_metadata_retention_days
    )
    VALUES (
        v_slug,
        v_name,
        p_raw_payload_retention_days,
        GREATEST(2555, p_raw_payload_retention_days)
    )
    RETURNING id INTO v_tenant_id;

    INSERT INTO sluice.tenant_memberships (
        tenant_id,
        user_id,
        role
    )
    VALUES (
        v_tenant_id,
        v_actor_id,
        'owner'
    );

    INSERT INTO sluice.audit_log (
        tenant_id,
        actor_type,
        actor_id,
        action,
        resource_type,
        resource_id,
        metadata
    )
    VALUES (
        v_tenant_id,
        'user',
        v_actor_id::text,
        'tenant.created',
        'tenant',
        v_tenant_id::text,
        jsonb_build_object(
            'authorizing_tenant_id', v_authorizing_tenant_id,
            'raw_payload_retention_days', p_raw_payload_retention_days
        )
    );

    RETURN v_tenant_id;
END
$$;

-- Dashboard reads are available to every active tenant member. Writes to
-- tenant-scoped resources require a current owner/admin membership in addition
-- to the application-level authorization check.
ALTER TABLE sluice.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sluice.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_dashboard_isolation ON sluice.tenants;
DROP POLICY IF EXISTS tenants_dashboard_select ON sluice.tenants;
CREATE POLICY tenants_dashboard_select ON sluice.tenants
    FOR SELECT TO sluice_dashboard
    USING (
        id = sluice.current_tenant_id()
        AND sluice.user_has_tenant_access(id)
    );

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'tenant_memberships',
        'webhook_sources',
        'destinations',
        'pipelines',
        'pipeline_destinations',
        'webhook_events',
        'jobs',
        'job_attempts',
        'job_delivery_effects',
        'audit_log',
        'notification_outbox',
        'reconciliation_checkpoints',
        'usage_rollups'
    ]
    LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_dashboard_isolation ON sluice.%I',
            table_name
        );
        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_dashboard_select ON sluice.%I',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY tenant_dashboard_select ON sluice.%I
             FOR SELECT TO sluice_dashboard
             USING (
                tenant_id = sluice.current_tenant_id()
                AND sluice.user_has_tenant_access(tenant_id)
             )',
            table_name
        );
    END LOOP;
END
$$;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'webhook_sources',
        'destinations',
        'pipelines',
        'pipeline_destinations'
    ]
    LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_dashboard_admin_insert ON sluice.%I',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY tenant_dashboard_admin_insert ON sluice.%I
             FOR INSERT TO sluice_dashboard
             WITH CHECK (
                tenant_id = sluice.current_tenant_id()
                AND sluice.current_user_is_tenant_admin(tenant_id)
             )',
            table_name
        );
        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_dashboard_admin_update ON sluice.%I',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY tenant_dashboard_admin_update ON sluice.%I
             FOR UPDATE TO sluice_dashboard
             USING (
                tenant_id = sluice.current_tenant_id()
                AND sluice.current_user_is_tenant_admin(tenant_id)
             )
             WITH CHECK (
                tenant_id = sluice.current_tenant_id()
                AND sluice.current_user_is_tenant_admin(tenant_id)
             )',
            table_name
        );
    END LOOP;
END
$$;

DROP POLICY IF EXISTS tenant_dashboard_admin_insert
    ON sluice.audit_log;
CREATE POLICY tenant_dashboard_admin_insert ON sluice.audit_log
    FOR INSERT TO sluice_dashboard
    WITH CHECK (
        tenant_id = sluice.current_tenant_id()
        AND sluice.current_user_is_tenant_admin(tenant_id)
        AND actor_type = 'user'
        AND actor_id = sluice.current_user_id()::text
    );

-- Tenant, identity, and membership mutations are function-only. Configuration
-- resources retain direct INSERT/UPDATE access for the dashboard, guarded by
-- the owner/admin policies above.
REVOKE INSERT, UPDATE ON
    sluice.tenants,
    sluice.users,
    sluice.tenant_memberships
FROM sluice_dashboard;

GRANT INSERT ON sluice.audit_log TO sluice_dashboard;

ALTER TABLE sluice.notification_outbox
    DROP CONSTRAINT IF EXISTS notification_outbox_lease_state_ck;
ALTER TABLE sluice.notification_outbox
    ADD CONSTRAINT notification_outbox_lease_state_ck CHECK (
        (
            status = 'processing'
            AND claimed_by IS NOT NULL
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND sent_at IS NULL
        )
        OR
        (
            status <> 'processing'
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
        )
    );

ALTER TABLE sluice.notification_outbox
    DROP CONSTRAINT IF EXISTS notification_outbox_terminal_state_ck;
ALTER TABLE sluice.notification_outbox
    ADD CONSTRAINT notification_outbox_terminal_state_ck CHECK (
        (status = 'sent' AND sent_at IS NOT NULL)
        OR
        (status <> 'sent' AND sent_at IS NULL)
    );

REVOKE ALL ON FUNCTION sluice.current_user_is_tenant_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.admin_create_tenant(
    text, text, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sluice.current_user_is_tenant_admin(uuid)
    TO sluice_dashboard;
GRANT EXECUTE ON FUNCTION sluice.admin_create_tenant(
    text, text, integer
) TO sluice_dashboard;

RESET ROLE;
