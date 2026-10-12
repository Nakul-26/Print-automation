#!/bin/bash
# Usage: restore.sh <backup-file-name|latest> <target-database> [--replace]
#
# Downloads an encrypted backup, decrypts it with the PRIVATE age key (mount it read-only at
# /run/age.key), and restores it into <target-database> (created if missing).
# Restoring over the live "print" database needs --replace, and the api and worker must be stopped.
set -Eeuo pipefail

: "${BACKUP_REMOTE:?}" "${POSTGRES_PASSWORD:?}"
export PGHOST="${PGHOST:-postgres}" PGUSER=postgres PGPASSWORD="$POSTGRES_PASSWORD"
KEY="${AGE_IDENTITY_FILE:-/run/age.key}"
want="${1:?backup file name or 'latest'}"
target="${2:?target database name}"
replace="${3:-}"

[ -r "$KEY" ] || { echo "Private key not found at $KEY (mount it with -v /path/to/age.key:/run/age.key:ro)" >&2; exit 1; }
if [ "$target" = "print" ] && [ "$replace" != "--replace" ]; then
  echo "Refusing to touch the live database 'print' without --replace." >&2; exit 1
fi

if [ "$want" = "latest" ]; then
  want="$(rclone lsf "$BACKUP_REMOTE" --include 'print-*.dump.age' | sort | tail -n 1)"
fi
[ -n "$want" ] || { echo "No backups found in $BACKUP_REMOTE" >&2; exit 1; }
echo "Restoring $want into $target"

trap 'rm -f /work/restore.*' EXIT
rclone copyto "$BACKUP_REMOTE/$want" /work/restore.age
age --decrypt --identity "$KEY" --output /work/restore.dump /work/restore.age

if [ "$replace" = "--replace" ]; then dropdb --if-exists --force "$target"; fi
createdb --owner=print_app "$target"
pg_restore --exit-on-error --no-owner --role=print_app --dbname="$target" /work/restore.dump
echo "Restored. Tables: $(psql -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" -d "$target"), migrations: $(psql -Atc 'SELECT count(*) FROM _prisma_migrations' -d "$target")"
