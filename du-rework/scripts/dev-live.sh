#!/usr/bin/env bash
# dev-live.sh — Start DUGate Rework with Live Infrastructure (.env.live)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/dev.cjs" --env-file=.env.live "$@"
