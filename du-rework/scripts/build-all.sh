#!/usr/bin/env bash
# ==============================================================================
# build-all.sh — Topological Dependency-Ordered Build Script for du-rework
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node "$SCRIPT_DIR/build-all.cjs"
