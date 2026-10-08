$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\dev.cjs" --services=orchestrator --workers=none @args
exit $LASTEXITCODE
