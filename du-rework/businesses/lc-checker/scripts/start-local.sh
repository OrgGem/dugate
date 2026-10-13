#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ARGS=()
if [[ -n "${1:-}" ]]; then ARGS+=("--env-file=$1"); fi
if [[ "${DU_SKIP_BUILD:-0}" == 1 ]]; then ARGS+=(--skip-build); fi
if [[ "${DU_DEV_CHECK:-0}" == 1 ]]; then ARGS+=(--check); fi
if [[ "${DU_DEV_NO_WATCH:-0}" == 1 ]]; then ARGS+=(--no-watch); fi
cd "$PROJECT_DIR"
exec node scripts/dev.cjs "${ARGS[@]}"
