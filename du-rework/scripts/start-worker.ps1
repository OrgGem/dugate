$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\dev.cjs" --services=workers --workers=document-core @args
exit $LASTEXITCODE
