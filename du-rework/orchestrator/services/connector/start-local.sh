#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${1:-.env.orchestrator.local}"
if [[ "$ENV_FILE" != /* ]]; then ENV_FILE="$WORKSPACE_ROOT/$ENV_FILE"; fi
if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Local env file not found: %s\nCreate it with node scripts/init-orchestrator-local.cjs --output=.env.orchestrator.local.\n' "$ENV_FILE" >&2
  exit 1
fi

export CONNECTOR_PORT="${CONNECTOR_PORT:-8080}"
export CONNECTOR_URL="${CONNECTOR_URL:-http://127.0.0.1:${CONNECTOR_PORT}}"
cd "$WORKSPACE_ROOT"
exec node scripts/dev.cjs "--env-file=$ENV_FILE" --services=connector --workers=none --skip-build --skip-migrate
