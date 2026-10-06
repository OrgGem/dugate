param(
  [ValidateSet('document-core', 'lc-checker', 'example-review')]
  [string]$Worker = 'document-core',
  [string]$EnvFile = '.env.docker',
  [string]$Project = 'du-benchmark',
  [string]$Overlay = ''
)
node "$PSScriptRoot/benchmark.cjs" start $Worker $EnvFile $Project $Overlay
exit $LASTEXITCODE
