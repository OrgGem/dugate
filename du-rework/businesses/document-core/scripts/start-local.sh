#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${DU_ENV_FILE:-}}"
ARGS=()

if [[ -n "$ENV_FILE" ]]; then
  if command -v cygpath >/dev/null 2>&1 && [[ "$ENV_FILE" == /* ]]; then
    ENV_FILE="$(cygpath -w "$ENV_FILE")"
  fi
  ARGS+=("--env-file=$ENV_FILE")
fi
if [[ "${DU_SKIP_BUILD:-0}" == 1 ]]; then ARGS+=(--skip-build); fi

cd "$PROJECT_DIR"
exec node scripts/dev.cjs "${ARGS[@]}"
