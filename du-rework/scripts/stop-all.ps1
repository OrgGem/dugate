# ==============================================================================
# stop-all.ps1 — Safely stop all running DUGate local development services
# ==============================================================================

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\stop-all.cjs"
