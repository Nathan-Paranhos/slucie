\set ON_ERROR_STOP on

-- pg_cron runs these commands in separate sessions. Each target is a narrowly
-- scoped SECURITY DEFINER function; application roles receive no cron access.
SELECT cron.schedule(
    'sluice-retry-sweep',
    '* * * * *',
    $$SELECT * FROM sluice.sweep_expired_job_leases(1000);$$
);

SELECT cron.schedule(
    'sluice-lgpd-purge',
    '*/10 * * * *',
    $$SELECT sluice.purge_expired_payloads(1000);$$
);

SELECT cron.schedule(
    'sluice-notification-lease-sweep',
    '* * * * *',
    $$SELECT * FROM sluice.sweep_expired_notification_leases(1000);$$
);

SELECT cron.schedule(
    'sluice-usage-rollup',
    '*/5 * * * *',
    $$SELECT sluice.rollup_usage_metrics();$$
);

SELECT cron.schedule(
    'sluice-reconciliation-enqueue',
    '*/15 * * * *',
    $$SELECT sluice.enqueue_reconciliation_jobs();$$
);

REVOKE ALL ON SCHEMA cron FROM PUBLIC;
