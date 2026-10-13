[CmdletBinding()]
param(
  [string]$EnvFile = $env:DU_ENV_FILE,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Arguments = @()

if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
  $ResolvedEnvFile = if ([IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $ProjectDir $EnvFile }
  if (-not (Test-Path -LiteralPath $ResolvedEnvFile -PathType Leaf)) {
    throw "Environment file not found: $ResolvedEnvFile"
  }
  $Arguments += "--env-file=$((Resolve-Path -LiteralPath $ResolvedEnvFile).Path)"
}
if ($SkipBuild -or $env:DU_SKIP_BUILD -eq '1') { $Arguments += '--skip-build' }

Push-Location $ProjectDir
try {
  & node 'scripts/dev.cjs' @Arguments
  $ExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $ExitCode
