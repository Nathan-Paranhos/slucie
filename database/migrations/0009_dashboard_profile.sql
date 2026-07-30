\set ON_ERROR_STOP on

SET ROLE sluice_owner;
SET search_path = sluice, pg_catalog;

-- Identity writes remain function-only. This policy applies to the function
-- owner because the users table has FORCE ROW LEVEL SECURITY enabled.
DROP POLICY IF EXISTS users_owner_update_current_profile ON sluice.users;
CREATE POLICY users_owner_update_current_profile ON sluice.users
    FOR UPDATE TO sluice_owner
    USING (
        id = sluice.current_user_id()
        AND sluice.user_has_tenant_access(sluice.current_tenant_id())
    )
    WITH CHECK (
        id = sluice.current_user_id()
        AND status = 'active'
        AND sluice.user_has_tenant_access(sluice.current_tenant_id())
    );

CREATE OR REPLACE FUNCTION sluice.update_current_dashboard_profile(
    p_display_name text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid := sluice.current_user_id();
    v_display_name text := btrim(p_display_name);
BEGIN
    IF v_actor_id IS NULL
       OR sluice.current_tenant_id() IS NULL
       OR NOT sluice.user_has_tenant_access(sluice.current_tenant_id()) THEN
        RAISE EXCEPTION 'authenticated tenant context is required'
            USING ERRCODE = '42501';
    END IF;

    IF v_display_name IS NULL
       OR char_length(v_display_name) < 1
       OR char_length(v_display_name) > 100 THEN
        RAISE EXCEPTION 'display name must contain between 1 and 100 characters'
            USING ERRCODE = '22023';
    END IF;

    UPDATE sluice.users
       SET display_name = v_display_name
     WHERE id = v_actor_id
       AND status = 'active'
     RETURNING display_name INTO v_display_name;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'active dashboard user not found'
            USING ERRCODE = '42501';
    END IF;

    RETURN v_display_name;
END
$$;

REVOKE ALL ON FUNCTION sluice.update_current_dashboard_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sluice.update_current_dashboard_profile(text)
    TO sluice_dashboard;

RESET ROLE;
