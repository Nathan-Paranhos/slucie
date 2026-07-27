#!/usr/bin/env bash
set -Eeuo pipefail

readonly tls_source_directory="/run/secrets"
readonly tls_runtime_directory="/var/lib/postgresql/tls"

if [[ -f "${tls_source_directory}/postgres_server_key" ]]; then
  install \
    --directory \
    --mode 0700 \
    --owner postgres \
    --group postgres \
    "${tls_runtime_directory}"
  install \
    --mode 0600 \
    --owner postgres \
    --group postgres \
    "${tls_source_directory}/postgres_server_key" \
    "${tls_runtime_directory}/server.key"
  install \
    --mode 0644 \
    --owner postgres \
    --group postgres \
    "${tls_source_directory}/postgres_server_cert" \
    "${tls_runtime_directory}/server.crt"
  install \
    --mode 0644 \
    --owner postgres \
    --group postgres \
    "${tls_source_directory}/postgres_ca_cert" \
    "${tls_runtime_directory}/ca.crt"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
