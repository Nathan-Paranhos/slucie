\set ON_ERROR_STOP on

SET ROLE sluice_owner;
SET search_path = sluice, pg_catalog;

CREATE OR REPLACE FUNCTION sluice.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION sluice.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- This helper is SECURITY DEFINER intentionally: evaluating membership must not
-- recursively invoke the membership table's own RLS policy. Its result is only
-- a boolean and execution is limited to runtime roles below.
CREATE OR REPLACE FUNCTION sluice.user_has_tenant_access(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM sluice.tenant_memberships AS membership
        JOIN sluice.users AS app_user
          ON app_user.id = membership.user_id
        WHERE membership.tenant_id = p_tenant_id
          AND membership.user_id = sluice.current_user_id()
          AND app_user.status = 'active'
    )
$$;

REVOKE ALL ON FUNCTION sluice.current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.user_has_tenant_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sluice.current_tenant_id()
    TO sluice_worker, sluice_dashboard, sluice_readonly;
GRANT EXECUTE ON FUNCTION sluice.current_user_id()
    TO sluice_dashboard;
GRANT EXECUTE ON FUNCTION sluice.user_has_tenant_access(uuid)
    TO sluice_dashboard;

ALTER TABLE sluice.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sluice.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_worker_isolation ON sluice.tenants;
CREATE POLICY tenants_worker_isolation ON sluice.tenants
    FOR SELECT TO sluice_worker, sluice_readonly
    USING (id = sluice.current_tenant_id());
DROP POLICY IF EXISTS tenants_dashboard_isolation ON sluice.tenants;
CREATE POLICY tenants_dashboard_isolation ON sluice.tenants
    FOR ALL TO sluice_dashboard
    USING (
        id = sluice.current_tenant_id()
        AND sluice.user_has_tenant_access(id)
    )
    WITH CHECK (
        id = sluice.current_tenant_id()
        AND sluice.user_has_tenant_access(id)
    );

ALTER TABLE sluice.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sluice.users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_self ON sluice.users;
CREATE POLICY users_self ON sluice.users
    FOR SELECT TO sluice_dashboard
    USING (id = sluice.current_user_id());
DROP POLICY IF EXISTS users_tenant_members ON sluice.users;
CREATE POLICY users_tenant_members ON sluice.users
    FOR SELECT TO sluice_dashboard
    USING (
        EXISTS (
            SELECT 1
            FROM sluice.tenant_memberships AS target_membership
            WHERE target_membership.tenant_id = sluice.current_tenant_id()
              AND target_membership.user_id = users.id
        )
        AND sluice.user_has_tenant_access(sluice.current_tenant_id())
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
        EXECUTE format('ALTER TABLE sluice.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE sluice.%I FORCE ROW LEVEL SECURITY', table_name);

        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_worker_isolation ON sluice.%I',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY tenant_worker_isolation ON sluice.%I
             FOR ALL TO sluice_worker, sluice_readonly
             USING (tenant_id = sluice.current_tenant_id())
             WITH CHECK (tenant_id = sluice.current_tenant_id())',
            table_name
        );

        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_dashboard_isolation ON sluice.%I',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY tenant_dashboard_isolation ON sluice.%I
             FOR ALL TO sluice_dashboard
             USING (
                tenant_id = sluice.current_tenant_id()
                AND sluice.user_has_tenant_access(tenant_id)
             )
             WITH CHECK (
                tenant_id = sluice.current_tenant_id()
                AND sluice.user_has_tenant_access(tenant_id)
             )',
            table_name
        );
    END LOOP;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA sluice FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sluice FROM PUBLIC;

-- Ingestion is function-only. No table access is granted to sluice_api.
GRANT SELECT ON
    sluice.webhook_sources,
    sluice.destinations,
    sluice.pipelines,
    sluice.pipeline_destinations,
    sluice.webhook_events,
    sluice.jobs,
    sluice.job_attempts,
    sluice.job_delivery_effects,
    sluice.reconciliation_checkpoints
TO sluice_worker;
GRANT INSERT, UPDATE ON
    sluice.job_delivery_effects,
    sluice.reconciliation_checkpoints
TO sluice_worker;

GRANT SELECT ON ALL TABLES IN SCHEMA sluice TO sluice_dashboard;
GRANT INSERT, UPDATE ON
    sluice.tenants,
    sluice.users,
    sluice.tenant_memberships,
    sluice.webhook_sources,
    sluice.destinations,
    sluice.pipelines,
    sluice.pipeline_destinations
TO sluice_dashboard;

GRANT SELECT ON ALL TABLES IN SCHEMA sluice TO sluice_readonly;

RESET ROLE;
