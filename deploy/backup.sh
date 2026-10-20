#!/bin/sh
# Backs up the two databases of the deploy/ stack: guide_engine (customers'
# guides, pages, events, members) and keycloak (the users and realm settings
# that sign them in). Losing either one loses the service, so both are dumped
# together, as `pg_dump -Fc` files (compressed, restorable table by table with
# pg_restore) named <database>-<UTC timestamp>.dump in BACKUP_DIR.
#
# Runs in the stock postgres:16 image, which already has pg_dump and a shell,
# so there is nothing to install or keep patched. The `backup` service in
# docker-compose.yml starts it without arguments:
#
#   backup.sh        loop forever: one backup a day at BACKUP_AT (HH:MM, UTC)
#   backup.sh now    one backup, then exit — before a migration, for example:
#                    docker compose run --rm backup now
#
# Environment (the compose file sets these from .env):
#   PGHOST / PGUSER / PGPASSWORD   how pg_dump connects; the superuser, so RLS
#                                  and ownership never hide rows from the dump
#   BACKUP_DIR         where dumps go (default /backups, the ./backups bind mount)
#   BACKUP_DATABASES   space-separated list (default "guide_engine keycloak")
#   BACKUP_AT          daily run time, HH:MM in UTC (default 03:00)
#   BACKUP_KEEP_DAYS   dumps older than this are deleted after each run (default 14)
#   BACKUP_COPY_CMD    optional: a shell command run after each successful dump
#                      with the dump's path as $1, for an off-host copy
#                      (e.g. `rclone copy "$1" remote:bucket`). Unset: no copy.
#
# A failed dump ends the run with a non-zero exit (the container restarts and
# waits for the next slot; `docker compose ps` / `logs backup` show it). One
# log line per database per run, so the log doubles as a backup register.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_DATABASES=${BACKUP_DATABASES:-guide_engine keycloak}
BACKUP_AT=${BACKUP_AT:-03:00}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

# Dumps every database, prunes old dumps, runs the copy hook. Exits non-zero on
# the first failure, so nothing downstream mistakes a partial run for a good one.
run_backup() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  for db in $BACKUP_DATABASES; do
    file="$BACKUP_DIR/$db-$stamp.dump"
    # Dump to a temporary name first: a file that carries the final name is
    # always a complete dump, never one that pg_dump died halfway through.
    if ! pg_dump --format=custom --dbname="$db" --file="$file.part"; then
      rm -f "$file.part"
      log "FAILED $db (pg_dump exited non-zero)"
      exit 1
    fi
    mv "$file.part" "$file"
    log "ok $db -> $file ($(du -k "$file" | cut -f1) KiB)"
    if [ -n "${BACKUP_COPY_CMD:-}" ]; then
      # The operator's command runs under sh with the dump path as $1, so it
      # can place the argument wherever its tool needs it.
      if sh -c "$BACKUP_COPY_CMD" backup-copy "$file"; then
        log "copied $file (BACKUP_COPY_CMD)"
      else
        log "FAILED copy of $file (BACKUP_COPY_CMD exited non-zero)"
        exit 1
      fi
    fi
  done
  # Retention: by modification time, so a dump copied in from elsewhere with its
  # original date ages like the others. `.part` leftovers are never this old
  # unless a run crashed, in which case they are junk too.
  pruned=$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.part' \) \
    -mtime +"$BACKUP_KEEP_DAYS" -print -delete | wc -l)
  log "pruned $pruned dump(s) older than $BACKUP_KEEP_DAYS days"
}

# Seconds until the next BACKUP_AT in UTC (today's if still ahead, else tomorrow's).
seconds_until_next_run() {
  now=$(date -u +%s)
  next=$(date -u -d "today $BACKUP_AT" +%s)
  if [ "$next" -le "$now" ]; then
    next=$(date -u -d "tomorrow $BACKUP_AT" +%s)
  fi
  echo $((next - now))
}

mkdir -p "$BACKUP_DIR"

case "${1:-}" in
  now)
    run_backup
    ;;
  '')
    log "scheduled daily at $BACKUP_AT UTC, keeping $BACKUP_KEEP_DAYS days, databases: $BACKUP_DATABASES"
    while :; do
      wait=$(seconds_until_next_run)
      log "next run in ${wait}s"
      sleep "$wait"
      run_backup
    done
    ;;
  *)
    echo "usage: backup.sh [now]" >&2
    exit 2
    ;;
esac
