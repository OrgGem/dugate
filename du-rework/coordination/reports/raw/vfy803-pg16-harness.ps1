$ErrorActionPreference = 'Continue'

$containerName = 'du-vfy803-pg16'
$ownerTask = 'task_a02a97db2a6e'
$rawDir = (Resolve-Path 'coordination/reports/raw').Path
$port = 55483
$password = [Guid]::NewGuid().ToString('N')
$dbUrl = "postgresql://vfy803:$password@127.0.0.1:$port/vfy803"
$startedContainer = $false
$summary = [System.Collections.Generic.List[string]]::new()

function Save-Step([string]$Name, [string]$Command, [object[]]$Output, [int]$ExitCode) {
  $lines = @("COMMAND: $Command", "LITERAL_EXIT_CODE: $ExitCode", '') + @($Output | ForEach-Object { [string]$_ })
  $lines | Set-Content -LiteralPath (Join-Path $rawDir $Name) -Encoding utf8
}

function Invoke-Verify([string]$Name, [string]$ExpectedPattern, [int]$ExpectedExit, [switch]$Direct) {
  if ($Direct) {
    $probe = @'
const { createDb } = require('./dist/db/db');
const { verifyMigrations } = require('./dist/db/migrations');
(async () => {
  const db = createDb(process.env.DATABASE_URL);
  try {
    await verifyMigrations(db);
    console.log('VERIFY_RESULT=PASS');
  } catch (error) {
    console.log('VERIFY_ERROR_NAME=' + String(error && error.name));
    console.log('VERIFY_ERROR_MESSAGE=' + String(error && error.message));
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
'@
    $output = & node -e $probe 2>&1
    $command = 'node -e direct createDb + verifyMigrations probe (DATABASE_URL points only at this task-owned PostgreSQL 16 container)'
  } else {
    $output = & node dist/migrate-cli.js verify 2>&1
    $command = 'node dist/migrate-cli.js verify (DATABASE_URL points only at this task-owned PostgreSQL 16 container)'
  }
  $code = $LASTEXITCODE
  Save-Step $Name $command $output $code
  $text = @($output | ForEach-Object { [string]$_ }) -join "`n"
  if ($code -ne $ExpectedExit -or ($ExpectedPattern -and $text -notmatch $ExpectedPattern)) {
    throw "verify scenario $Name failed expectation: exit=$code, pattern=$ExpectedPattern"
  }
  $summary.Add("$Name`: EXIT=$code; expected pattern matched")
  Write-Output "VERIFY=$Name EXIT=$code EXPECTED=PASS"
  $output | Select-String 'schema verification passed|ledger is not readable|no migration file on disk|missing migrations|migration command failed' | ForEach-Object { Write-Output $_.Line }
}

try {
  $existing = & docker ps -a --filter "name=^/$containerName$" --format '{{.Names}}' 2>&1
  if ($LASTEXITCODE -ne 0) { throw "docker ps failed: $existing" }
  if ($existing) { throw "refusing existing container name $containerName" }
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "refusing to use occupied TCP port $port"
  }

  $dockerOutput = & docker run --detach --name $containerName --label "com.dugate.vfy803=$ownerTask" --publish "127.0.0.1:${port}:5432" --env POSTGRES_USER=vfy803 --env "POSTGRES_PASSWORD=$password" --env POSTGRES_DB=vfy803 --tmpfs /var/lib/postgresql/data:rw,size=1g postgres:16 2>&1
  $dockerCode = $LASTEXITCODE
  Save-Step 'vfy803-pg16-start.txt' 'docker run postgres:16, unique container, loopback-only port, tmpfs data, random throwaway password' $dockerOutput $dockerCode
  if ($dockerCode -ne 0) { throw "docker run failed: $dockerOutput" }
  $startedContainer = $true
  $summary.Add('container: new postgres:16 with tmpfs, task ownership label, loopback-only port')

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    & docker exec $containerName pg_isready -U vfy803 -d vfy803 *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'PostgreSQL 16 did not become ready within 30 seconds' }

  $env:DATABASE_URL = $dbUrl
  $migrateOutput = & pnpm --filter @du/orchestrator migrate 2>&1
  $migrateCode = $LASTEXITCODE
  Save-Step 'vfy803-pg16-migrate-fresh.txt' 'pnpm --filter @du/orchestrator migrate (DATABASE_URL points only at task-owned disposable PG16)' $migrateOutput $migrateCode
  if ($migrateCode -ne 0) { throw "fresh PostgreSQL migration failed with exit $migrateCode" }
  $summary.Add("fresh migrate: EXIT=$migrateCode")
  Write-Output "MIGRATE_FRESH EXIT=$migrateCode"
  $migrateOutput | Select-String 'migrations applied|migration verification passed|error|Error' | ForEach-Object { Write-Output $_.Line }

  Push-Location 'services/orchestrator'
  try {
    $versionOutput = & docker exec $containerName psql -X -v ON_ERROR_STOP=1 -U vfy803 -d vfy803 -Atc "SELECT current_setting('server_version_num'), count(*) FROM schema_migrations" 2>&1
    $versionCode = $LASTEXITCODE
    Save-Step 'vfy803-pg16-version-and-ledger-count.txt' 'docker exec psql: SELECT server_version_num and schema_migrations count only' $versionOutput $versionCode
    if ($versionCode -ne 0 -or (($versionOutput -join '') -notmatch '^16\d+\|\d+$')) { throw "unexpected PG version/count result: $versionOutput" }
    $summary.Add("postgres: server_version_num=$($versionOutput -join ''); fresh ledger count observed")
    Write-Output "PG16_VERSION_AND_COUNT=$($versionOutput -join '')"

    Invoke-Verify 'vfy803-pg16-verify-good.txt' 'schema verification passed' 0

    $sql = "ALTER TABLE schema_migrations RENAME TO schema_migrations_rows; CREATE SEQUENCE vfy803_gate_sequence START WITH 1; CREATE VIEW schema_migrations AS SELECT sequence, filename, applied_at FROM schema_migrations_rows WHERE (SELECT nextval('vfy803_gate_sequence')) % 2 = 1;"
    $viewOutput = & docker exec $containerName psql -X -v ON_ERROR_STOP=1 -U vfy803 -d vfy803 -c $sql 2>&1
    $viewCode = $LASTEXITCODE
    Save-Step 'vfy803-pg16-install-adversarial-view.txt' 'docker exec psql: install task-local alternating read view over migration ledger rows' $viewOutput $viewCode
    if ($viewCode -ne 0) { throw "could not install mismatch fixture: $viewOutput" }
    Invoke-Verify 'vfy803-pg16-verify-count-mismatch.txt' 'ledger is not readable as recorded' 1 -Direct

    $restore = & docker exec $containerName psql -X -v ON_ERROR_STOP=1 -U vfy803 -d vfy803 -c 'DROP VIEW schema_migrations; ALTER TABLE schema_migrations_rows RENAME TO schema_migrations; DROP SEQUENCE vfy803_gate_sequence;' 2>&1
    $restoreCode = $LASTEXITCODE
    Save-Step 'vfy803-pg16-restore-table.txt' 'docker exec psql: restore the original migration table from task-local view fixture' $restore $restoreCode
    if ($restoreCode -ne 0) { throw "could not restore task-local migration table: $restore" }

    $orphan = & docker exec $containerName psql -X -v ON_ERROR_STOP=1 -U vfy803 -d vfy803 -c "INSERT INTO schema_migrations (sequence, filename) VALUES (9999, '9999_ghost.sql')" 2>&1
    $orphanCode = $LASTEXITCODE
    Save-Step 'vfy803-pg16-insert-orphan-fixture.txt' 'docker exec psql: insert one synthetic orphan ledger row into throwaway DB' $orphan $orphanCode
    if ($orphanCode -ne 0) { throw "could not install orphan fixture: $orphan" }
    Invoke-Verify 'vfy803-pg16-verify-orphan.txt' 'no migration file on disk' 1 -Direct
    & docker exec $containerName psql -X -v ON_ERROR_STOP=1 -U vfy803 -d vfy803 -c 'DELETE FROM schema_migrations WHERE sequence = 9999' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'could not remove synthetic orphan fixture' }

    $empty = & docker exec $containerName psql -X -v ON_ERROR_STOP=1 -U vfy803 -d vfy803 -c 'TRUNCATE TABLE schema_migrations' 2>&1
    $emptyCode = $LASTEXITCODE
    Save-Step 'vfy803-pg16-empty-ledger-fixture.txt' 'docker exec psql: empty only the task-owned throwaway migration ledger' $empty $emptyCode
    if ($emptyCode -ne 0) { throw "could not install empty-ledger fixture: $empty" }
    Invoke-Verify 'vfy803-pg16-verify-empty-ledger.txt' 'missing migrations' 1 -Direct
  } finally {
    Pop-Location
  }
  $summary.Add('verified good, count/select mismatch, orphan and empty ledger outcomes on real PG16')
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  if ($startedContainer) {
    $labelJson = & docker inspect --format '{{json .Config.Labels}}' $containerName 2>$null
    $inspectCode = $LASTEXITCODE
    $label = $null
    if ($inspectCode -eq 0) {
      $labelObject = ($labelJson -join '') | ConvertFrom-Json
      $label = $labelObject.PSObject.Properties['com.dugate.vfy803'].Value
    }
    if ($inspectCode -eq 0 -and $label -eq $ownerTask) {
      $removeOutput = & docker rm --force $containerName 2>&1
      $removeCode = $LASTEXITCODE
      Save-Step 'vfy803-pg16-cleanup.txt' 'docker rm --force task-owned du-vfy803-pg16 only' $removeOutput $removeCode
      if ($removeCode -ne 0) { throw "task-owned PG16 cleanup failed: $removeOutput" }
      $summary.Add('cleanup: task-owned container removed; tmpfs contents discarded')
    } else {
      throw "cleanup ownership label did not match; container left untouched ($containerName)"
    }
  }
}

$summary | Set-Content -LiteralPath (Join-Path $rawDir 'vfy803-pg16-summary.txt') -Encoding utf8
Write-Output 'PG16_HARNESS_RESULT=PASS'
$summary | ForEach-Object { Write-Output $_ }
