#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
exec pnpm exec vite --host "${VITE_HOST:-127.0.0.1}" --port "${VITE_PORT:-5173}"
