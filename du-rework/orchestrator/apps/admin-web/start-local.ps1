[CmdletBinding()]
param(
  [string]$BindHost = '127.0.0.1',
  [ValidateRange(1, 65535)]
  [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'
$ExitCode = 1
Push-Location $PSScriptRoot
try {
  Get-Command pnpm -ErrorAction Stop | Out-Null
  & pnpm exec vite --host $BindHost --port $Port
  $ExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $ExitCode
