\set ON_ERROR_STOP on

SET ROLE sluice_owner;
SET search_path = sluice, pg_catalog;

CREATE OR REPLACE FUNCTION sluice.lookup_dashboard_login(p_email text)
RETURNS TABLE (
    user_id uuid,
    email public.citext,
    display_name text,
    password_hash text,
    status text,
    mfa_enabled boolean,
    memberships jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT
        app_user.id,
        app_user.email,
        app_user.display_name,
        app_user.password_hash,
        app_user.status,
        app_user.mfa_enabled,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'tenant_id', membership.tenant_id,
                    'tenant_slug', tenant.slug,
                    'tenant_name', tenant.name,
                    'tenant_status', tenant.status,
                    'role', membership.role
                )
                ORDER BY tenant.name
            ) FILTER (WHERE membership.tenant_id IS NOT NULL),
            '[]'::jsonb
        )
    FROM sluice.users AS app_user
    LEFT JOIN sluice.tenant_memberships AS membership
      ON membership.user_id = app_user.id
    LEFT JOIN sluice.tenants AS tenant
      ON tenant.id = membership.tenant_id
    WHERE public.citext_eq(
        app_user.email,
        btrim(p_email)::public.citext
    )
    GROUP BY
        app_user.id,
        app_user.email,
        app_user.display_name,
        app_user.password_hash,
        app_user.status,
        app_user.mfa_enabled
$$;

CREATE OR REPLACE FUNCTION sluice.is_tenant_admin(
    p_tenant_id uuid,
    p_user_id uuid DEFAULT sluice.current_user_id()
)
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
        JOIN sluice.tenants AS tenant
          ON tenant.id = membership.tenant_id
        WHERE membership.tenant_id = p_tenant_id
          AND membership.user_id = p_user_id
          AND membership.role IN ('owner', 'admin')
          AND app_user.status = 'active'
          AND tenant.status = 'active'
    )
$$;

CREATE OR REPLACE FUNCTION sluice.bootstrap_first_owner(
    p_email text,
    p_display_name text,
    p_password_hash text,
    p_tenant_slug text,
    p_tenant_name text
)
RETURNS TABLE (
    tenant_id uuid,
    user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_tenant_id uuid;
    v_user_id uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('sluice.bootstrap', 0));

    IF EXISTS (SELECT 1 FROM sluice.users)
       OR EXISTS (SELECT 1 FROM sluice.tenants) THEN
        RAISE EXCEPTION 'instance bootstrap has already been completed'
            USING ERRCODE = '55000';
    END IF;
    IF COALESCE(btrim(p_email), '') = ''
       OR COALESCE(btrim(p_display_name), '') = ''
       OR COALESCE(btrim(p_tenant_slug), '') = ''
       OR COALESCE(btrim(p_tenant_name), '') = '' THEN
        RAISE EXCEPTION 'bootstrap fields cannot be empty'
            USING ERRCODE = '22023';
    END IF;
    IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
        RAISE EXCEPTION 'password must be pre-hashed with Argon2id'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO sluice.tenants (slug, name)
    VALUES (lower(btrim(p_tenant_slug)), btrim(p_tenant_name))
    RETURNING id INTO v_tenant_id;

    INSERT INTO sluice.users (
        email, display_name, password_hash, status
    )
    VALUES (
        lower(btrim(p_email))::public.citext,
        btrim(p_display_name),
        p_password_hash,
        'active'
    )
    RETURNING id INTO v_user_id;

    INSERT INTO sluice.tenant_memberships (tenant_id, user_id, role)
    VALUES (v_tenant_id, v_user_id, 'owner');

    INSERT INTO sluice.audit_log (
        tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata
    )
    VALUES (
        v_tenant_id,
        'user',
        v_user_id::text,
        'instance.bootstrapped',
        'tenant',
        v_tenant_id::text,
        '{}'::jsonb
    );

    RETURN QUERY SELECT v_tenant_id, v_user_id;
END
$$;

CREATE OR REPLACE FUNCTION sluice.admin_set_membership(
    p_tenant_id uuid,
    p_email text,
    p_display_name text,
    p_role text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid := sluice.current_user_id();
    v_actor_role text;
    v_user_id uuid;
    v_existing_role text;
    v_owner_count integer;
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_id is required' USING ERRCODE = '22004';
    END IF;
    IF COALESCE(btrim(p_email), '') = ''
       OR COALESCE(btrim(p_display_name), '') = '' THEN
        RAISE EXCEPTION 'email and display name are required'
            USING ERRCODE = '22023';
    END IF;
    IF char_length(btrim(p_email)) > 320
       OR char_length(btrim(p_display_name)) > 160 THEN
        RAISE EXCEPTION 'email or display name is too long'
            USING ERRCODE = '22023';
    END IF;
    IF p_role IS NULL
       OR p_role NOT IN ('owner', 'admin', 'operator', 'viewer') THEN
        RAISE EXCEPTION 'invalid membership role' USING ERRCODE = '22023';
    END IF;

    -- Serialize membership changes for a tenant so concurrent requests cannot
    -- both demote what each observed as the final owner.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('sluice.membership:' || p_tenant_id::text, 0)
    );

    SELECT role
      INTO v_actor_role
      FROM sluice.tenant_memberships
     WHERE tenant_id = p_tenant_id
       AND user_id = v_actor_id
       AND role IN ('owner', 'admin');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'tenant administrator permission required'
            USING ERRCODE = '42501';
    END IF;
    IF p_role = 'owner' AND v_actor_role <> 'owner' THEN
        RAISE EXCEPTION 'only an owner can grant owner membership'
            USING ERRCODE = '42501';
    END IF;

    INSERT INTO sluice.users (email, display_name, status)
    VALUES (
        lower(btrim(p_email))::public.citext,
        btrim(p_display_name),
        'invited'
    )
    ON CONFLICT (email) DO UPDATE
       SET display_name = CASE
               WHEN sluice.users.status = 'invited' THEN EXCLUDED.display_name
               ELSE sluice.users.display_name
           END
    RETURNING id INTO v_user_id;

    SELECT role
      INTO v_existing_role
      FROM sluice.tenant_memberships
     WHERE tenant_id = p_tenant_id
       AND user_id = v_user_id;

    IF v_existing_role = 'owner' AND v_actor_role <> 'owner' THEN
        RAISE EXCEPTION 'only an owner can change an owner membership'
            USING ERRCODE = '42501';
    END IF;

    IF v_existing_role = 'owner' AND p_role <> 'owner' THEN
        SELECT count(*)
          INTO v_owner_count
          FROM sluice.tenant_memberships
         WHERE tenant_id = p_tenant_id
           AND role = 'owner';

        IF v_owner_count <= 1 THEN
            RAISE EXCEPTION 'the final tenant owner cannot be demoted'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    INSERT INTO sluice.tenant_memberships (tenant_id, user_id, role)
    VALUES (p_tenant_id, v_user_id, p_role)
    ON CONFLICT (tenant_id, user_id) DO UPDATE
       SET role = EXCLUDED.role;

    INSERT INTO sluice.audit_log (
        tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata
    )
    VALUES (
        p_tenant_id,
        'user',
        v_actor_id::text,
        'membership.set',
        'user',
        v_user_id::text,
        jsonb_build_object(
            'previous_role', v_existing_role,
            'role', p_role
        )
    );

    RETURN v_user_id;
END
$$;

CREATE OR REPLACE FUNCTION sluice.admin_redrive_dead_letter(
    p_tenant_id uuid,
    p_job_id uuid,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid := sluice.current_user_id();
    v_old_job record;
    v_new_job_id uuid := gen_random_uuid();
BEGIN
    IF NOT sluice.is_tenant_admin(p_tenant_id, v_actor_id) THEN
        RAISE EXCEPTION 'tenant administrator permission required'
            USING ERRCODE = '42501';
    END IF;
    IF COALESCE(btrim(p_reason), '') = '' THEN
        RAISE EXCEPTION 'redrive reason is required' USING ERRCODE = '22023';
    END IF;

    SELECT job.*
      INTO v_old_job
      FROM sluice.jobs AS job
     WHERE job.tenant_id = p_tenant_id
       AND job.id = p_job_id
       AND job.status = 'dead_letter'
     FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'dead-letter job not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_old_job.event_id IS NOT NULL
       AND EXISTS (
           SELECT 1
           FROM sluice.webhook_events AS event
           WHERE event.tenant_id = p_tenant_id
             AND event.id = v_old_job.event_id
             AND event.raw_body_envelope IS NULL
       ) THEN
        RAISE EXCEPTION 'job payload was purged and cannot be redriven'
            USING ERRCODE = '55000';
    END IF;

    INSERT INTO sluice.jobs (
        id,
        tenant_id,
        event_id,
        pipeline_id,
        destination_id,
        job_type,
        idempotency_key,
        status,
        priority,
        max_attempts,
        available_at,
        arguments
    )
    VALUES (
        v_new_job_id,
        p_tenant_id,
        v_old_job.event_id,
        v_old_job.pipeline_id,
        v_old_job.destination_id,
        v_old_job.job_type,
        'redrive:' || p_job_id::text || ':' || v_new_job_id::text,
        'pending',
        v_old_job.priority,
        v_old_job.max_attempts,
        clock_timestamp(),
        v_old_job.arguments || jsonb_build_object('redrive_of', p_job_id)
    );

    INSERT INTO sluice.audit_log (
        tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata
    )
    VALUES (
        p_tenant_id,
        'user',
        v_actor_id::text,
        'job.redriven',
        'job',
        v_new_job_id::text,
        jsonb_build_object(
            'original_job_id', p_job_id,
            'reason', left(btrim(p_reason), 500)
        )
    );

    PERFORM pg_notify(
        'sluice_jobs',
        jsonb_build_object('tenant_id', p_tenant_id, 'job_id', v_new_job_id)::text
    );
    RETURN v_new_job_id;
END
$$;

REVOKE ALL ON FUNCTION sluice.lookup_dashboard_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.is_tenant_admin(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.bootstrap_first_owner(
    text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.admin_set_membership(
    uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION sluice.admin_redrive_dead_letter(
    uuid, uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sluice.lookup_dashboard_login(text)
    TO sluice_dashboard;
GRANT EXECUTE ON FUNCTION sluice.bootstrap_first_owner(
    text, text, text, text, text
) TO sluice_dashboard;
GRANT EXECUTE ON FUNCTION sluice.admin_set_membership(
    uuid, text, text, text
) TO sluice_dashboard;
GRANT EXECUTE ON FUNCTION sluice.admin_redrive_dead_letter(
    uuid, uuid, text
) TO sluice_dashboard;

RESET ROLE;
