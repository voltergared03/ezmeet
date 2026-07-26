#!/bin/sh
# Garely scheduler sidecar — runs the periodic jobs against the app's internal
# API. Replaces the old host-crontab step.
#
# busybox crond logs each job's full command line (at -d 8), so the CRON_SECRET
# must NOT live in the crontab. Instead we store it in a root-only file and a
# tiny wrapper reads it at run time; the crontab + crond log only ever show
# `run-cron-job <name>`, never the secret.
set -eu

: "${CRON_SECRET:?CRON_SECRET is required (set it in .env)}"
APP_URL="${CRON_TARGET_URL:-http://eam-meet:3000}"

# Secret lives in a root-only file, never on the crond command line.
printf '%s' "$CRON_SECRET" > /etc/cron-secret
chmod 600 /etc/cron-secret

# Wrapper: $1 = cron endpoint name. Reads the secret from the file at run time
# (APP_URL is baked in now). The response body — which carries no secret — is
# sent to the container log so `docker compose logs cron` stays useful.
mkdir -p /usr/local/bin   # busybox image ships without it
cat > /usr/local/bin/run-cron-job <<EOF
#!/bin/sh
set -eu
secret="\$(cat /etc/cron-secret)"
wget -qO- -T 180 "${APP_URL}/api/cron/\$1?secret=\${secret}" || echo "[cron] job \$1 failed"
echo
EOF
chmod +x /usr/local/bin/run-cron-job

# The RDP-v2 drive-redirection volume is created root-owned, but guacd runs as uid 1000 and
# must create per-user subdirs under it. Make it world-writable on start (idempotent) so file
# transfer works even if the named volume is ever recreated.
chmod 0777 /guac-drive 2>/dev/null || true

mkdir -p /var/spool/cron/crontabs
cat > /var/spool/cron/crontabs/root <<'EOF'
# min hour dom mon dow  command  (secret is injected by run-cron-job, not stored here)
*/5 * * * * /usr/local/bin/run-cron-job reminders   >/proc/1/fd/1 2>&1
0 9 * * 1   /usr/local/bin/run-cron-job digest      >/proc/1/fd/1 2>&1
0 3 * * *   /usr/local/bin/run-cron-job recordings  >/proc/1/fd/1 2>&1
0 * * * *   /usr/local/bin/run-cron-job reg-cleanup >/proc/1/fd/1 2>&1
*/30 * * * * /usr/local/bin/run-cron-job cleanup    >/proc/1/fd/1 2>&1
15 * * * *  /usr/local/bin/run-cron-job recurrence  >/proc/1/fd/1 2>&1
0 8 * * *   /usr/local/bin/run-cron-job base-reminders >/proc/1/fd/1 2>&1
*/10 * * * * /usr/local/bin/run-cron-job calendar-sync >/proc/1/fd/1 2>&1
*/30 * * * * /usr/local/bin/run-cron-job clickup-health >/proc/1/fd/1 2>&1
# Catch-up sweep for the ClickUp mirror: the webhook is fire-and-forget, so any missed
# delivery (redeploy, rate limit, disabled hook) would otherwise drift forever.
25 * * * *  /usr/local/bin/run-cron-job clickup-reconcile >/proc/1/fd/1 2>&1
# Release meeting reports stuck in "generating" because a process died mid-run.
*/10 * * * * /usr/local/bin/run-cron-job report-backstop >/proc/1/fd/1 2>&1
*/30 * * * * /usr/local/bin/run-cron-job linear-health >/proc/1/fd/1 2>&1
# Prune RDP-v2 file-transfer drive: delete staged files older than 7 days so the shared
# host disk (pgdata/recordings/backups) can't be exhausted by accumulated transfers.
30 4 * * *  find /guac-drive -type f -mtime +7 -exec rm -f {} \; >/proc/1/fd/1 2>&1
EOF

echo "[cron] scheduler started — jobs target ${APP_URL}"
exec crond -f -d 8 -c /var/spool/cron/crontabs
