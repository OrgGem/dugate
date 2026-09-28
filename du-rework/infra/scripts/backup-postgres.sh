#!/usr/bin/env bash
set -Eeuo pipefail

: "${PGSERVICE:?Set PGSERVICE to one named connection in a protected libpq service file}"
: "${PGSERVICEFILE:?Set PGSERVICEFILE to the protected libpq service file}"
: "${BACKUP_DIR:?Set BACKUP_DIR to an approved encrypted backup mount}"

for command_name in pg_dump pg_restore sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    exit 127
  }
done

umask 077
export PGSERVICEFILE
mkdir -p -- "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="${BACKUP_NAME:-postgres}"
if [[ ! "$name" =~ ^[A-Za-z0-9_-]{1,48}$ ]]; then
  printf 'BACKUP_NAME may contain only letters, digits, underscore, and hyphen.\n' >&2
  exit 2
fi
base="$name-$stamp"
backup_file="$BACKUP_DIR/$base.dump"
checksum_file="$backup_file.sha256"

if [[ -e "$backup_file" || -e "$checksum_file" ]]; then
  printf 'Refusing to overwrite an existing backup: %s\n' "$backup_file" >&2
  exit 1
fi

temporary_file="$(mktemp "$BACKUP_DIR/.$base.XXXXXX")"
temporary_checksum="$temporary_file.sha256"
cleanup() {
  rm -f -- "$temporary_file" "$temporary_checksum"
}
trap cleanup EXIT

pg_dump \
  --dbname="service=$PGSERVICE" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$temporary_file"

pg_restore --list "$temporary_file" >/dev/null
sha256sum "$temporary_file" | cut -d ' ' -f 1 > "$temporary_checksum"
mv -- "$temporary_file" "$backup_file"
mv -- "$temporary_checksum" "$checksum_file"
trap - EXIT

printf 'Backup written: %s\nSHA-256: %s\n' \
  "$backup_file" "$(<"$checksum_file")"
