# ==============================================================================
# dev.ps1 — Unified Local Dev Runner (All services in one terminal)
# ==============================================================================

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\dev.cjs" $args
