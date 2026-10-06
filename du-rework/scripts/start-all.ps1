$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\dev.cjs" @args
exit $LASTEXITCODE
