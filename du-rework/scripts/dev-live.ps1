# ==============================================================================
# dev-live.ps1 — Start DUGate Rework with Live Infrastructure (.env.live)
# ==============================================================================

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\dev.cjs" --env-file=.env.live $args

exit $LASTEXITCODE
