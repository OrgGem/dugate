#!/bin/sh
set -eu

mode="${1:-server}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  migrate|status|verify|baseline-reviewed)
    exec node /app/dist/migrate-cli.js "$mode" "$@"
    ;;
  server)
    export DU_MIGRATION_ENABLED="${DU_MIGRATION_ENABLED:-true}"
    case "$DU_MIGRATION_ENABLED" in
      true)
        node /usr/local/bin/du-wait-for-db.cjs
        node /app/dist/migrate-cli.js migrate
        ;;
      false) ;;
      *) printf '%s\n' 'DU_MIGRATION_ENABLED must be true or false' >&2; exit 64 ;;
    esac
    exec node /app/dist/entrypoint.js "$@"
    ;;
  *)
    printf '%s\n' 'Supported commands: server, migrate, status, verify, baseline-reviewed' >&2
    exit 64
    ;;
esac
