$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\dev.cjs" --services=connector --workers=none @args
exit $LASTEXITCODE
