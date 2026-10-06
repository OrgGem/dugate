# LIVE-GATES runner (Claude review §10.7-5 / §11.4-5).
# Runs steps 1->2->3 against the tagged candidate and aggregates exit codes.
# Exit: 0 all PASS, 1 any FAIL, 2 any CONFIG/PREREQ.
[CmdletBinding()]
param(
  [string]$ImageTag = 'candidate-portal-swagger-20261006-r4.1',
  [string]$EnvFile = '',
  [string]$PgUrl = '',
  [string]$Project = 'du-live-gates',
  [int]$IdpPort = 8443,
  [int]$ReceiverPort = 9443,
  [string]$OperationId = '',
  [string]$Sentinels = '',
  [string]$ReportDir = '',
  [switch]$First401,
  [switch]$SkipMigrations,
  [switch]$SkipWebhook,
  [switch]$SkipScan,
  [switch]$ForceCerts,
  [string]$ExtraComposeFiles = ''
)

$ErrorActionPreference = 'Stop'
$HarnessDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $HarnessDir '..\..')).Path
if ([string]::IsNullOrWhiteSpace($EnvFile)) { $EnvFile = Join-Path $RepoRoot '.env.docker' }
if ([string]::IsNullOrWhiteSpace($ReportDir)) {
  $ReportDir = Join-Path $RepoRoot ("coordination\reports\raw\live-gates-" + (Get-Date -Format 'yyyy-MM-dd'))
}
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$CertsDir = Join-Path $HarnessDir '.certs'

# Compose wiring for the harness override (candidate gets extra_hosts + CA trust).
$extraList = @()
if ($ExtraComposeFiles) {
  $extraList = $ExtraComposeFiles.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}
$composeFiles = @(
  (Join-Path $RepoRoot 'docker-compose.yml'),
  (Join-Path $HarnessDir 'compose\live-gates.override.yml')
) + $extraList
$env:DU_LIVE_IMAGE_TAG = $ImageTag
$env:DU_LIVE_ENV_FILE = $EnvFile
$env:DU_LIVE_PROJECT = $Project
$env:DU_LIVE_COMPOSE_FILES = ($composeFiles -join ',')
$env:LIVE_GATES_HOST_DIR = $HarnessDir
$env:LIVE_CERTS_HOST_DIR = $CertsDir

$results = [ordered]@{}
function Invoke-Step {
  param([string]$Name, [string[]]$StepArgs, [string]$LogName)
  Write-Host ("[live-gates] running " + $Name)
  $log = Join-Path $ReportDir $LogName
  # Windows PowerShell 5.1: a native command writing to stderr becomes a
  # terminating error under ErrorActionPreference=Stop. Keep diagnostics in the
  # step log instead of aborting the suite on a progress/warning line.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & node @StepArgs 2>&1 | Tee-Object -FilePath $log -Append
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $results[$Name] = $code
  Write-Host ("[live-gates] " + $Name + " exit=" + $code)
  return $code
}

$sentinelsFile = Join-Path $ReportDir 'sentinels.json'

if (-not $SkipMigrations) {
  $args = @((Join-Path $HarnessDir 'check-migrations.cjs'), '--report-dir', $ReportDir, '--via-container')
  if ($PgUrl) { $args += @('--pg-url', $PgUrl) }
  Invoke-Step -Name 'check-migrations' -StepArgs $args -LogName 'runner-check-migrations.log' | Out-Null
}

if (-not $SkipWebhook) {
  $args = @(
    (Join-Path $HarnessDir 'webhook-live-idp.cjs'), '--mode', 'live', '--run-live',
    '--report-dir', $ReportDir,
    '--cert-dir', $CertsDir,
    '--idp-port', "$IdpPort",
    '--receiver-port', "$ReceiverPort",
    '--compose-service', 'orchestrator'
  )
  if ($OperationId) { $args += @('--operation-id', $OperationId) }
  if ($First401) { $args += '--expect-first-401' }
  if ($ForceCerts) { $args += '--force-certs' }
  Invoke-Step -Name 'webhook-live-idp' -StepArgs $args -LogName 'runner-webhook-live.log' | Out-Null
}

if (-not $SkipScan) {
  $args = @((Join-Path $HarnessDir 'scan-plaintext-sentinels.cjs'), '--report-dir', $ReportDir)
  if (Test-Path $sentinelsFile) {
    $args += @('--sentinels-file', $sentinelsFile)
  } elseif ($Sentinels) {
    $args += @('--sentinels', $Sentinels)
  } else {
    Write-Warning 'No sentinels available (webhook step skipped and -Sentinels empty); scan will refuse to run.'
  }
  Invoke-Step -Name 'scan-plaintext-sentinels' -StepArgs $args -LogName 'runner-scan.log' | Out-Null
}

$summary = [pscustomobject]@{
  harness = 'live-gates'
  candidate = $ImageTag
  envFile = $EnvFile
  reportedAt = (Get-Date).ToUniversalTime().ToString('o')
  steps = $results
  reportDir = $ReportDir
}
$summary | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $ReportDir 'run-summary.json') -Encoding UTF8
Write-Host ("[live-gates] summary: " + (($results.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value }) -join ' '))

if ($results.Values -contains 2) { exit 2 }
if ($results.Values -contains 1) { exit 1 }
exit 0
