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
    node /app/dist/migrate-cli.js verify
    exec node /app/dist/main.js "$@"
    ;;
  *)
    printf '%s\n' 'Supported commands: server, migrate, status, verify, baseline-reviewed' >&2
    exit 64
    ;;
esac
