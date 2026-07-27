\set ON_ERROR_STOP on

-- Sluice uses role groups so production deployments can attach their own LOGIN
-- roles without changing object grants. The container bootstrap turns the four
-- runtime roles into LOGIN roles only for local development.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sluice_owner') THEN
        CREATE ROLE sluice_owner NOLOGIN BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sluice_api') THEN
        CREATE ROLE sluice_api NOLOGIN NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sluice_worker') THEN
        CREATE ROLE sluice_worker NOLOGIN NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sluice_dashboard') THEN
        CREATE ROLE sluice_dashboard NOLOGIN NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sluice_maintenance') THEN
        CREATE ROLE sluice_maintenance NOLOGIN NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sluice_readonly') THEN
        CREATE ROLE sluice_readonly NOLOGIN NOBYPASSRLS;
    END IF;
END
$$;

ALTER ROLE sluice_owner BYPASSRLS;
ALTER ROLE sluice_api NOBYPASSRLS;
ALTER ROLE sluice_worker NOBYPASSRLS;
ALTER ROLE sluice_dashboard NOBYPASSRLS;
ALTER ROLE sluice_maintenance NOBYPASSRLS;
ALTER ROLE sluice_readonly NOBYPASSRLS;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE SCHEMA IF NOT EXISTS sluice AUTHORIZATION sluice_owner;
ALTER SCHEMA sluice OWNER TO sluice_owner;

REVOKE ALL ON SCHEMA sluice FROM PUBLIC;
GRANT USAGE ON SCHEMA sluice
    TO sluice_api, sluice_worker, sluice_dashboard, sluice_maintenance, sluice_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE sluice_owner IN SCHEMA sluice
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE sluice_owner IN SCHEMA sluice
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE sluice_owner IN SCHEMA sluice
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
