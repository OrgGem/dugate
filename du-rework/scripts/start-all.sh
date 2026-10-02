#!/usr/bin/env bash
# ==============================================================================
# start-all.sh — Local Dev Launcher for Linux / macOS / WSL
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$WORKSPACE_ROOT"

ENV_FILE=".env.local"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f ".env" ]; then
    ENV_FILE=".env"
  else
    echo "Creating .env.local from .env.local.sample..."
    cp .env.local.sample .env.local
  fi
fi

# 1. Build if dists missing
if [ ! -f "services/orchestrator/dist/main.js" ] || [ ! -f "services/connector/dist/entrypoint.js" ]; then
  echo "Building all services..."
  node "$SCRIPT_DIR/build-all.cjs"
fi

# 2. Migrate
echo "Running migrations..."
node "$SCRIPT_DIR/migrate-local.cjs"

# 3. Trap SIGINT/SIGTERM to terminate background processes
cleanup() {
  echo "Stopping services..."
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

echo "Starting Orchestrator on :3000..."
node --env-file="$ENV_FILE" services/orchestrator/dist/main.js &

sleep 2
echo "Starting Connector on :8080..."
node --env-file="$ENV_FILE" services/connector/dist/entrypoint.js &

sleep 1
echo "Starting Document-Core Worker..."
node --env-file="$ENV_FILE" businesses/document-core/dist/main.js &

echo ""
echo "=========================================================="
echo " All services running! Press Ctrl+C to stop all."
echo " Admin UI: http://localhost:3000/admin"
echo " Health:   http://localhost:3000/health"
echo "=========================================================="

wait
