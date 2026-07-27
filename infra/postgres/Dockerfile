ARG POSTGRES_IMAGE=postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4
FROM ${POSTGRES_IMAGE}

ARG PG_MAJOR=17

RUN apt-get update \
    && apt-get install --yes --no-install-recommends "postgresql-${PG_MAJOR}-cron" \
    && rm -rf /var/lib/apt/lists/*

COPY infra/postgres/sluice-entrypoint.sh /usr/local/bin/sluice-postgres-entrypoint
COPY infra/postgres/pg_hba_tls.conf /etc/postgresql/sluice-pg_hba_tls.conf

RUN chmod 0755 /usr/local/bin/sluice-postgres-entrypoint \
    && chmod 0644 /etc/postgresql/sluice-pg_hba_tls.conf

LABEL org.opencontainers.image.title="Sluice PostgreSQL" \
      org.opencontainers.image.description="PostgreSQL with pg_cron for the Sluice data plane" \
      org.opencontainers.image.source="https://github.com/aithostech/sluice" \
      org.opencontainers.image.licenses="Apache-2.0"
