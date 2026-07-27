#!/usr/bin/env bash
set -Eeuo pipefail

required_variables=(
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  SLUICE_API_DB_PASSWORD
  SLUICE_WORKER_DB_PASSWORD
  SLUICE_DASHBOARD_DB_PASSWORD
  SLUICE_READONLY_DB_PASSWORD
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required environment variable: ${variable_name}" >&2
    exit 1
  fi
done

psql_arguments=()
for migration in /migrations/*.sql; do
  echo "Queuing ${migration}"
  psql_arguments+=(--file "${migration}")
done

# A failed init script is followed by a container restart when restart policies
# are enabled. Applying every migration and the local LOGIN-role configuration
# in one transaction prevents that restart from exposing a partially migrated
# database as usable.
PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  --no-psqlrc \
  --single-transaction \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --set ON_ERROR_STOP=1 \
  --set api_password="${SLUICE_API_DB_PASSWORD}" \
  --set worker_password="${SLUICE_WORKER_DB_PASSWORD}" \
  --set dashboard_password="${SLUICE_DASHBOARD_DB_PASSWORD}" \
  --set readonly_password="${SLUICE_READONLY_DB_PASSWORD}" \
  --set database_name="${POSTGRES_DB}" \
  "${psql_arguments[@]}" \
  --file - <<'SQL'
ALTER ROLE sluice_api LOGIN PASSWORD :'api_password' CONNECTION LIMIT 100;
ALTER ROLE sluice_worker LOGIN PASSWORD :'worker_password' CONNECTION LIMIT 200;
ALTER ROLE sluice_dashboard LOGIN PASSWORD :'dashboard_password' CONNECTION LIMIT 50;
ALTER ROLE sluice_readonly LOGIN PASSWORD :'readonly_password' CONNECTION LIMIT 20;

ALTER ROLE sluice_api SET search_path = pg_catalog, sluice;
ALTER ROLE sluice_worker SET search_path = pg_catalog, sluice;
ALTER ROLE sluice_dashboard SET search_path = pg_catalog, sluice;
ALTER ROLE sluice_readonly SET search_path = pg_catalog, sluice;

ALTER ROLE sluice_api SET statement_timeout = '5s';
ALTER ROLE sluice_worker SET statement_timeout = '30s';
ALTER ROLE sluice_dashboard SET statement_timeout = '15s';
ALTER ROLE sluice_readonly SET statement_timeout = '30s';

GRANT CONNECT ON DATABASE :"database_name"
    TO sluice_api, sluice_worker, sluice_dashboard, sluice_readonly;
SQL
