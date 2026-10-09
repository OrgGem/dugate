#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$PROJECT_DIR"
while [[ ! -f "$WORKSPACE_ROOT/pnpm-workspace.yaml" ]]; do
  PARENT="$(dirname "$WORKSPACE_ROOT")"
  [[ "$PARENT" != "$WORKSPACE_ROOT" ]] || { echo 'Could not find the du-rework workspace root.' >&2; exit 1; }
  WORKSPACE_ROOT="$PARENT"
done

ENV_FILE="${DU_ENV_FILE:-$WORKSPACE_ROOT/.env.local}"
if [[ "$ENV_FILE" != /* ]]; then ENV_FILE="$WORKSPACE_ROOT/$ENV_FILE"; fi
[[ -f "$ENV_FILE" ]] || { echo "Environment file not found: $ENV_FILE. Copy .env.local.sample to .env.local and configure it." >&2; exit 1; }
NODE_ENV_FILE="$ENV_FILE"
if command -v cygpath >/dev/null 2>&1; then NODE_ENV_FILE="$(cygpath -w "$ENV_FILE")"; fi

export PORT=3000
export ORCHESTRATOR_PORT=3000
export ORCHESTRATOR_HOST=127.0.0.1
export ORCHESTRATOR_INTERNAL_PORT=3002
export ORCHESTRATOR_INTERNAL_HOST=127.0.0.1
export ORCHESTRATOR_INTERNAL_BASE_URL=http://127.0.0.1:3002
export ADMIN_SHELL_PORT=3001
export ADMIN_SHELL_HOST=127.0.0.1
export CONNECTOR_PORT=8080
export CONNECTOR_URL=http://127.0.0.1:8080
export RUNTIME_URL=http://127.0.0.1:3002/api/runtime/v1
export REDIS_URL=redis://127.0.0.1:6379
export DU_ADMIN_WEB=1
export DU_ADMIN_WEB_DIST=../../apps/admin-web/dist
export AUTO_MIGRATE=false

if [[ "${DU_SKIP_BUILD:-0}" != 1 ]]; then
  (cd "$WORKSPACE_ROOT" && pnpm --filter '@du/orchestrator...' run build)
  (cd "$WORKSPACE_ROOT" && pnpm --filter '@du/admin-web...' run build)
fi

if [[ "${DU_SKIP_MIGRATE:-0}" != 1 ]]; then
  (cd "$PROJECT_DIR" && node --env-file="$NODE_ENV_FILE" dist/migrate-cli.js migrate)
fi

echo 'Orchestrator Public:   http://127.0.0.1:3000'
echo 'Orchestrator Admin:    http://127.0.0.1:3001/admin/'
echo 'Orchestrator Internal: http://127.0.0.1:3002'
echo 'Connector:             http://127.0.0.1:8080'
echo 'Redis:                 redis://127.0.0.1:6379'
cd "$PROJECT_DIR"
exec node --env-file="$NODE_ENV_FILE" dist/main.js
