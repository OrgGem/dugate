#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKUP_FILE:?Set BACKUP_FILE to a PostgreSQL custom-format dump}"
: "${RESTORE_PGSERVICE:?Set RESTORE_PGSERVICE to a named isolated restore connection}"
: "${PGSERVICEFILE:?Set PGSERVICEFILE to the protected libpq service file}"
: "${RESTORE_EXPECTED_DATABASE:?Set RESTORE_EXPECTED_DATABASE to the expected database name}"
: "${CONFIRM_RESTORE_DATABASE:?Type the expected restore database name to confirm}"

for command_name in psql pg_restore sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 127
  }
done

if [[ ! "$RESTORE_EXPECTED_DATABASE" =~ ^du_restore_[A-Za-z0-9_]{1,48}$ ]]; then
  printf 'Restore target must use the isolated du_restore_ prefix.\n' >&2
  exit 2
fi

if [[ "$CONFIRM_RESTORE_DATABASE" != "$RESTORE_EXPECTED_DATABASE" ]]; then
  printf 'Confirmation does not match the expected restore database.\n' >&2
  exit 2
fi

if [[ ! -f "$BACKUP_FILE" || ! -f "$BACKUP_FILE.sha256" ]]; then
  printf 'Backup dump or SHA-256 sidecar is missing.\n' >&2
  exit 2
fi
export PGSERVICEFILE

expected_checksum="$(<"$BACKUP_FILE.sha256")"
if [[ ! "$expected_checksum" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  printf 'SHA-256 sidecar must contain exactly one 64-character digest.\n' >&2
  exit 2
fi

actual_checksum="$(sha256sum "$BACKUP_FILE" | cut -d ' ' -f 1)"
if [[ "${actual_checksum,,}" != "${expected_checksum,,}" ]]; then
  printf 'Backup checksum verification failed.\n' >&2
  exit 2
fi

actual_database="$(psql --no-psqlrc --quiet --tuples-only --no-align \
  --dbname="service=$RESTORE_PGSERVICE" \
  --command='SELECT current_database()')"
if [[ "$actual_database" != "$RESTORE_EXPECTED_DATABASE" ]]; then
  printf 'Connected database does not match the explicitly confirmed restore target.\n' >&2
  exit 2
fi

pg_restore --list "$BACKUP_FILE" >/dev/null
printf 'Restoring into isolated target database: %s\n' "$actual_database"
pg_restore \
  --dbname="service=$RESTORE_PGSERVICE" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  "$BACKUP_FILE"

printf 'Restore completed. Keep dispatch and external provider calls disabled until recovery checks pass.\n'
