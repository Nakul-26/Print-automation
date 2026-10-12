#!/bin/bash
# Usage: backup.sh run     keep running: one backup a day at BACKUP_AT (and one at start-up if the
#                          last good one is older than a day)
#        backup.sh once    take one backup now and exit (non-zero if it failed)
#
# Each cycle: dump -> restore the dump into a scratch database and check it -> encrypt with the
# PUBLIC age key (the server cannot decrypt its own backups) -> upload -> delete old remote copies.
set -Eeuo pipefail

: "${AGE_RECIPIENT:?set AGE_RECIPIENT to the age public key (age1...)}"
: "${BACKUP_REMOTE:?set BACKUP_REMOTE, e.g. r2:print-backups/prod}"
: "${APP_DB_PASSWORD:?}" "${POSTGRES_PASSWORD:?}"

export PGHOST="${PGHOST:-postgres}" PGDATABASE="${PGDATABASE:-print}"
BACKUP_AT="${BACKUP_AT:-02:30}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-3}"
PING="${BACKUP_PING_URL:-}"
SCRATCH_DB="print_backup_verify"

log() { echo "$(date -u +%FT%TZ) backup: $*"; }
ping_monitor() { [ -n "$PING" ] && curl -fsS -m 15 --retry 2 -o /dev/null "$PING$1" || true; }
as_app() { PGUSER=print_app PGPASSWORD="$APP_DB_PASSWORD" "$@"; }
as_admin() { PGUSER=postgres PGPASSWORD="$POSTGRES_PASSWORD" "$@"; }

cycle() {
  local stamp file out
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="/work/print-$stamp.dump"
  out="/backups/print-$stamp.dump.age"
  # A brand-new, empty database (e.g. right after rebuilding the server) must never become the
  # "latest" backup that hides the real ones. Restore first, then backups resume by themselves.
  if [ "$(as_app psql -Atc 'SELECT count(*) FROM users' 2>/dev/null || echo 0)" = "0" ]; then
    log "the database has no users yet: skipping this backup (restore a backup first if this is a rebuilt server)"
    date -u +%FT%TZ >/backups/last-skip
    return 0
  fi
  ping_monitor /start
  trap 'rm -f /work/print-*.dump' RETURN

  log "dumping $PGDATABASE"
  as_app pg_dump --format=custom --no-owner --no-privileges --file="$file"

  log "checking the dump by restoring it into a scratch database"
  as_admin dropdb --if-exists "$SCRATCH_DB"
  as_admin createdb --owner=print_app "$SCRATCH_DB"
  as_admin pg_restore --exit-on-error --no-owner --dbname="$SCRATCH_DB" "$file"
  local want got want_t got_t
  want="$(as_app psql -Atc 'SELECT count(*) FROM _prisma_migrations' -d "$PGDATABASE")"
  got="$(as_admin psql -Atc 'SELECT count(*) FROM _prisma_migrations' -d "$SCRATCH_DB")"
  want_t="$(as_app psql -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" -d "$PGDATABASE")"
  got_t="$(as_admin psql -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" -d "$SCRATCH_DB")"
  as_admin dropdb "$SCRATCH_DB"
  if [ "$want" != "$got" ] || [ "$want_t" != "$got_t" ] || [ "$got" -lt 1 ]; then
    log "restore check FAILED (migrations $got/$want, tables $got_t/$want_t)"
    return 1
  fi

  log "encrypting and uploading"
  age --recipient "$AGE_RECIPIENT" --output "$out" "$file"
  rclone copyto "$out" "$BACKUP_REMOTE/$(basename "$out")" --checksum --retries 5
  # Re-read what is in the bucket: the size must match what we sent.
  [ "$(rclone size --json "$BACKUP_REMOTE/$(basename "$out")" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')" = "$(stat -c %s "$out")" ]

  log "removing copies older than $KEEP_DAYS days"
  rclone delete "$BACKUP_REMOTE" --min-age "${KEEP_DAYS}d" --include 'print-*.dump.age' || log "prune failed (ignored)"
  # shellcheck disable=SC2012
  ls -1t /backups/print-*.dump.age 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f

  date -u +%FT%TZ >/backups/last-success
  log "done: $(basename "$out") ($(stat -c %s "$out") bytes, $got migrations, $got_t tables verified)"
  ping_monitor ""
}

run_cycle() {
  if cycle; then return 0; fi
  log "FAILED"
  date -u +%FT%TZ >/backups/last-failure
  ping_monitor /fail
  return 1
}

seconds_until() { # next HH:MM in the container's timezone
  local now target
  now="$(date +%s)"
  target="$(date -d "$(date +%F) $1" +%s)"
  [ "$target" -le "$now" ] && target=$((target + 86400))
  echo $((target - now))
}

case "${1:-run}" in
once) run_cycle ;;
run)
  until as_app pg_isready -q; do sleep 3; done
  if [ -z "$(find /backups/last-success -mmin -1440 2>/dev/null)" ]; then
    sleep 60 # let the API apply its migrations on a first deploy
    run_cycle || true
  fi
  while true; do
    wait_s="$(seconds_until "$BACKUP_AT")"
    log "next backup in ${wait_s}s (at $BACKUP_AT)"
    sleep "$wait_s"
    run_cycle || { log "retrying in 1 hour"; sleep 3600; run_cycle || true; }
  done
  ;;
*) echo "usage: backup.sh run|once" >&2; exit 2 ;;
esac
