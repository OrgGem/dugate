[CmdletBinding()]
param(
  [string]$EnvFile,
  [switch]$SkipBuild,
  [switch]$Check,
  [switch]$NoWatch
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path $PSScriptRoot).Path
$Arguments = @()
if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
  $ResolvedEnvFile = if ([IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $ProjectDir $EnvFile }
  if (-not (Test-Path -LiteralPath $ResolvedEnvFile -PathType Leaf)) { throw "Environment file not found: $ResolvedEnvFile" }
  $Arguments += "--env-file=$((Resolve-Path -LiteralPath $ResolvedEnvFile).Path)"
}
if ($SkipBuild) { $Arguments += '--skip-build' }
if ($Check) { $Arguments += '--check' }
if ($NoWatch) { $Arguments += '--no-watch' }
Push-Location $ProjectDir
try {
  & node 'scripts/dev.cjs' @Arguments
  $ExitCode = $LASTEXITCODE
} finally { Pop-Location }
exit $ExitCode
