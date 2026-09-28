# Concurrent & Unified Test Batch Runner (MM-13 / W42-A6 / P1-05)
# Unified execution interface for all du-rework test suites:
# 1. Batch mode (-Mode Batch): Runs suites classified as Offline, Live, or All
#    with dynamic MM-13 per-run isolation sandboxes for Live suites.
# 2. Concurrent mode (-Mode Concurrent): Overlapping two-process isolation proof.

param(
    [ValidateSet("Concurrent", "Batch")]
    [string]$Mode = "Concurrent",

    # Batch parameters
    [ValidateSet("Offline", "Live", "All")]
    [string]$Category = "Offline",
    [string]$Filter = "",
    [switch]$StopOnFirstFailure = $false,

    # Concurrent parameters
    [string]$TargetSuite = "tests/runtime.test.ts",
    [int]$OffsetSeconds = 5,
    [string]$WorkingDir = "D:\Git\dugate\du-rework\services\orchestrator",
    [switch]$PlainRun = $false
)

$ErrorActionPreference = "Continue"

$repoRoot = "D:\Git\dugate\du-rework"
$logDir = "$repoRoot\tests\isolation\logs"
if (!(Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Write-Telemetry($msg) {
    $timeStr = Get-Date -Format "HH:mm:ss.fff"
    $line = "[$timeStr] $msg"
    Write-Host $line
}

# ==============================================================================
# MODE 1: CONCURRENT ISOLATION PROOF RUNNER
# ==============================================================================
if ($Mode -eq "Concurrent") {
    $mainLog = "$logDir\concurrent-$timestamp.log"
    $logA = "$logDir\run-A-$timestamp.log"
    $logB = "$logDir\run-B-$timestamp.log"

    Write-Telemetry "=========================================================="
    Write-Telemetry "STARTING CONCURRENT ISOLATION PROOF RUN: $TargetSuite"
    Write-Telemetry "Plain Run (zero custom env vars): $PlainRun"
    Write-Telemetry "Offset: ${OffsetSeconds}s | WorkingDir: $WorkingDir"
    Write-Telemetry "Zero Cross-Run Cleanup: True (strictly isolated per-run sandboxes)"
    Write-Telemetry "=========================================================="

    $cleanTimestamp = $timestamp -replace '[^a-zA-Z0-9]', ''
    $runIdA = "iso_a_$cleanTimestamp"
    $runIdB = "iso_b_$cleanTimestamp"
    $baseDbUrl = "postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test"

    if ($PlainRun) {
        Write-Telemetry "Launching Run A (Plain Run: automatic per-run isolation)..."
        $procA = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c npx jest $TargetSuite --runInBand --forceExit > `"$logA`" 2>&1" `
            -WorkingDirectory $WorkingDir `
            -PassThru

        Write-Telemetry "Run A started with PID: $($procA.Id). Sleeping $OffsetSeconds seconds before starting Run B..."
        Start-Sleep -Seconds $OffsetSeconds

        Write-Telemetry "Launching Run B (Plain Run: automatic per-run isolation)..."
        $procB = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c npx jest $TargetSuite --runInBand --forceExit > `"$logB`" 2>&1" `
            -WorkingDirectory $WorkingDir `
            -PassThru
    } else {
        Write-Telemetry "Launching Run A (RunId: $runIdA, Redis DB: 1)..."
        $procA = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c set TEST_RUN_ID=$runIdA&& set DATABASE_URL=$baseDbUrl&& set REDIS_DB_INDEX=1&& npx jest $TargetSuite --runInBand --forceExit > `"$logA`" 2>&1" `
            -WorkingDirectory $WorkingDir `
            -PassThru

        Write-Telemetry "Run A started with PID: $($procA.Id). Sleeping $OffsetSeconds seconds before starting Run B..."
        Start-Sleep -Seconds $OffsetSeconds

        Write-Telemetry "Launching Run B (RunId: $runIdB, Redis DB: 2)..."
        $procB = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c set TEST_RUN_ID=$runIdB&& set DATABASE_URL=$baseDbUrl&& set REDIS_DB_INDEX=2&& npx jest $TargetSuite --runInBand --forceExit > `"$logB`" 2>&1" `
            -WorkingDirectory $WorkingDir `
            -PassThru
    }

    Write-Telemetry "Run B started with PID: $($procB.Id). Both runs are now executing concurrently."

    $sample = 0
    $maxSamples = 120 # 4 minutes timeout guard

    while (!$procA.HasExited -or !$procB.HasExited) {
        Start-Sleep -Seconds 2
        $sample++

        $activeSessions = docker exec du-rework-postgres psql -U du -d du_orchestrator_test -t -A -c "SELECT count(*) FROM pg_stat_activity WHERE datname='du_orchestrator_test' AND state='active' AND query NOT LIKE '%pg_stat_activity%';" 2>$null
        $ungrantedLocks = docker exec du-rework-postgres psql -U du -d du_orchestrator_test -t -A -c "SELECT count(*) FROM pg_locks WHERE NOT granted;" 2>$null
        $redisClients = docker exec du-rework-redis redis-cli info clients 2>$null | Select-String "connected_clients:"

        $statusA = if ($procA.HasExited) { "EXITED($($procA.ExitCode))" } else { "RUNNING" }
        $statusB = if ($procB.HasExited) { "EXITED($($procB.ExitCode))" } else { "RUNNING" }

        Write-Telemetry "SAMPLE #$sample | Run A: $statusA | Run B: $statusB | PG Active: $activeSessions | Ungranted Locks: $ungrantedLocks | $redisClients"

        if ($sample -ge $maxSamples) {
            Write-Telemetry "ERROR: Timeout reached ($($maxSamples * 2)s). Terminating hanging processes."
            if (!$procA.HasExited) { Stop-Process -Id $procA.Id -Force }
            if (!$procB.HasExited) { Stop-Process -Id $procB.Id -Force }
            break
        }
    }

    Write-Telemetry "=========================================================="
    Write-Telemetry "CONCURRENT EXECUTION COMPLETED"
    Write-Telemetry "Run A ExitCode: $($procA.ExitCode)"
    Write-Telemetry "Run B ExitCode: $($procB.ExitCode)"

    $resultA = if (Test-Path $logA) { Get-Content $logA | Select-String "Tests:" } else { "Log not found" }
    $resultB = if (Test-Path $logB) { Get-Content $logB | Select-String "Tests:" } else { "Log not found" }
    Write-Telemetry "Run A Jest Summary: $resultA"
    Write-Telemetry "Run B Jest Summary: $resultB"
    Write-Telemetry "=========================================================="

    if ($procA.ExitCode -ne 0 -or $procB.ExitCode -ne 0) {
        exit 1
    } else {
        exit 0
    }
}

# ==============================================================================
# MODE 2: UNIFIED TEST BATCH RUNNER WITH MM-13 ISOLATION
# ==============================================================================
Write-Telemetry "=========================================================="
Write-Telemetry "STARTING UNIFIED TEST BATCH RUNNER"
Write-Telemetry "Mode: Batch | Category: $Category | Filter: '$Filter'"
Write-Telemetry "=========================================================="

# Define the complete suite inventory
$testSuites = @(
    # Document Core (31)
    @{ Path="businesses/document-core/tests/all-variants-e2e.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/all-variants-e2e.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/analyze.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/analyze.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/barrier-cleanup-lifecycle.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/barrier-cleanup-lifecycle.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/bounded-input.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/bounded-input.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/build-dependency-order.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/build-dependency-order.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/bullmq-smoke.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/bullmq-smoke.test.ts"; Category="Live" },
    @{ Path="businesses/document-core/tests/cancellation-fencing.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/cancellation-fencing.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/checkpoint-replay.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/checkpoint-replay.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/checkpoint.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/checkpoint.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/child-lifecycle.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/child-lifecycle.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/compare.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/compare.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/config.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/config.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/corpus-regression.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/corpus-regression.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/cross-service-boundary.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/cross-service-boundary.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/extract.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/extract.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/generate.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/generate.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/helpers/synthetic-fixtures.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/helpers/synthetic-fixtures.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/ingest.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/ingest.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/manifest.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/manifest.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/multi-container-e2e.integration.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/multi-container-e2e.integration.test.ts"; Category="Live" },
    @{ Path="businesses/document-core/tests/output-validation.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/output-validation.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/p8-03-provider-convergence.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/p8-03-provider-convergence.test.ts"; Category="Live" },
    @{ Path="businesses/document-core/tests/package-boundary.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/package-boundary.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/parser-budgets.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/parser-budgets.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/profile-binding-fixture.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/profile-binding-fixture.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/provider-backed-variant.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/provider-backed-variant.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/sdk-consumer.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/sdk-consumer.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/test-target-guard.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/test-target-guard.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/traceability.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/traceability.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/transform.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/transform.test.ts"; Category="Offline" },
    @{ Path="businesses/document-core/tests/worker.test.ts"; WorkDir="$repoRoot\businesses\document-core"; Cmd="npx jest tests/worker.test.ts"; Category="Offline" },

    # Example Review (14)
    @{ Path="businesses/example-review/tests/approval-wait.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/approval-wait.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/child-review.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/child-review.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/example-review-continuation.integration.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/example-review-continuation.integration.test.ts"; Category="Live" },
    @{ Path="businesses/example-review/tests/example-review.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/example-review.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/fanout-and-join.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/fanout-and-join.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/fencing.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/fencing.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/input-validation.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/input-validation.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/manifest.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/manifest.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/p7-03-registry-live.integration.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/p7-03-registry-live.integration.test.ts"; Category="Live" },
    @{ Path="businesses/example-review/tests/p7-04-profile-assignment.integration.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/p7-04-profile-assignment.integration.test.ts"; Category="Live" },
    @{ Path="businesses/example-review/tests/package-boundary.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/package-boundary.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/registry-tool.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/registry-tool.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/task-context-consumer.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/task-context-consumer.test.ts"; Category="Offline" },
    @{ Path="businesses/example-review/tests/version-coexistence.test.ts"; WorkDir="$repoRoot\businesses\example-review"; Cmd="npx jest tests/version-coexistence.test.ts"; Category="Offline" },

    # Connector Client (3)
    @{ Path="packages/connector-client/tests/client.test.ts"; WorkDir="$repoRoot\packages\connector-client"; Cmd="npx jest tests/client.test.ts"; Category="Offline" },
    @{ Path="packages/connector-client/tests/real-service.test.ts"; WorkDir="$repoRoot\packages\connector-client"; Cmd="npx jest tests/real-service.test.ts"; Category="Live" },
    @{ Path="packages/connector-client/tests/transport.test.ts"; WorkDir="$repoRoot\packages\connector-client"; Cmd="npx jest tests/transport.test.ts"; Category="Offline" },

    # Contracts (6)
    @{ Path="packages/contracts/tests/dto.test.ts"; WorkDir="$repoRoot\packages\contracts"; Cmd="npx jest tests/dto.test.ts"; Category="Offline" },
    @{ Path="packages/contracts/tests/hashing-errors.test.ts"; WorkDir="$repoRoot\packages\contracts"; Cmd="npx jest tests/hashing-errors.test.ts"; Category="Offline" },
    @{ Path="packages/contracts/tests/invocation-hash.test.ts"; WorkDir="$repoRoot\packages\contracts"; Cmd="npx jest tests/invocation-hash.test.ts"; Category="Offline" },
    @{ Path="packages/contracts/tests/manifest.test.ts"; WorkDir="$repoRoot\packages\contracts"; Cmd="npx jest tests/manifest.test.ts"; Category="Offline" },
    @{ Path="packages/contracts/tests/queue.test.ts"; WorkDir="$repoRoot\packages\contracts"; Cmd="npx jest tests/queue.test.ts"; Category="Offline" },
    @{ Path="packages/contracts/tests/state-machine.test.ts"; WorkDir="$repoRoot\packages\contracts"; Cmd="npx jest tests/state-machine.test.ts"; Category="Offline" },

    # Document Kit (6)
    @{ Path="packages/document-kit/tests/converters.test.ts"; WorkDir="$repoRoot\packages\document-kit"; Cmd="npx jest tests/converters.test.ts"; Category="Offline" },
    @{ Path="packages/document-kit/tests/detector.test.ts"; WorkDir="$repoRoot\packages\document-kit"; Cmd="npx jest tests/detector.test.ts"; Category="Offline" },
    @{ Path="packages/document-kit/tests/limits-boundary.test.ts"; WorkDir="$repoRoot\packages\document-kit"; Cmd="npx jest tests/limits-boundary.test.ts"; Category="Offline" },
    @{ Path="packages/document-kit/tests/parsers.test.ts"; WorkDir="$repoRoot\packages\document-kit"; Cmd="npx jest tests/parsers.test.ts"; Category="Offline" },
    @{ Path="packages/document-kit/tests/pdf-splitter.test.ts"; WorkDir="$repoRoot\packages\document-kit"; Cmd="npx jest tests/pdf-splitter.test.ts"; Category="Offline" },
    @{ Path="packages/document-kit/tests/zip-extractor.test.ts"; WorkDir="$repoRoot\packages\document-kit"; Cmd="npx jest tests/zip-extractor.test.ts"; Category="Offline" },

    # Observability (1)
    @{ Path="packages/observability/tests/observability.test.ts"; WorkDir="$repoRoot\packages\observability"; Cmd="npx jest tests/observability.test.ts"; Category="Offline" },

    # Worker SDK (5)
    @{ Path="packages/worker-sdk/tests/artifact-streams.test.ts"; WorkDir="$repoRoot\packages\worker-sdk"; Cmd="npx jest tests/artifact-streams.test.ts"; Category="Offline" },
    @{ Path="packages/worker-sdk/tests/connector-session.test.ts"; WorkDir="$repoRoot\packages\worker-sdk"; Cmd="npx jest tests/connector-session.test.ts"; Category="Offline" },
    @{ Path="packages/worker-sdk/tests/fan-out.test.ts"; WorkDir="$repoRoot\packages\worker-sdk"; Cmd="npx jest tests/fan-out.test.ts"; Category="Offline" },
    @{ Path="packages/worker-sdk/tests/temp-sweep.test.ts"; WorkDir="$repoRoot\packages\worker-sdk"; Cmd="npx jest tests/temp-sweep.test.ts"; Category="Offline" },
    @{ Path="packages/worker-sdk/tests/worker.test.ts"; WorkDir="$repoRoot\packages\worker-sdk"; Cmd="npx jest tests/worker.test.ts"; Category="Offline" },

    # Services Connector (11)
    @{ Path="services/connector/tests/black-box-durable.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/black-box-durable.test.ts"; Category="Live" },
    @{ Path="services/connector/tests/canonical-hash-parity.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/canonical-hash-parity.test.ts"; Category="Offline" },
    @{ Path="services/connector/tests/composition.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/composition.test.ts"; Category="Offline" },
    @{ Path="services/connector/tests/connector.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/connector.test.ts"; Category="Offline" },
    @{ Path="services/connector/tests/durable-integration.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/durable-integration.test.ts"; Category="Live" },
    @{ Path="services/connector/tests/mock-provider/provider.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/mock-provider/provider.test.ts"; Category="Offline" },
    @{ Path="services/connector/tests/p8-03-convergence.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/p8-03-convergence.test.ts"; Category="Live" },
    @{ Path="services/connector/tests/reliability-security.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/reliability-security.test.ts"; Category="Offline" },
    @{ Path="services/connector/tests/runtime-foundations.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/runtime-foundations.test.ts"; Category="Offline" },
    @{ Path="services/connector/tests/security-lifecycle.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/security-lifecycle.test.ts"; Category="Offline" },
    @{ Path="services/connector/tests/webhook.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest tests/webhook.test.ts"; Category="Offline" },

    # Services Orchestrator (18)
    @{ Path="services/orchestrator/tests/admin-api-key-view-model.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-api-key-view-model.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-business-view-model.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-business-view-model.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-connector-view-model.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-connector-view-model.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-operation-view-model.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-operation-view-model.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-overview-view-model.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-overview-view-model.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-p6-01-shell-fixtures.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-p6-01-shell-fixtures.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-profile-view-model.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-profile-view-model.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-shell-auth.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-shell-auth.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-shell-platform-mount.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-shell-platform-mount.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-shell-render.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-shell-render.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-shell-router.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-shell-router.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-shell-server.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-shell-server.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/admin-view-model.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/admin-view-model.test.ts"; Category="Offline" },
    @{ Path="services/orchestrator/tests/blob-wire-binary.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/blob-wire-binary.test.ts"; Category="Live" },
    @{ Path="services/orchestrator/tests/ingress-bounded.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/ingress-bounded.test.ts"; Category="Live" },
    @{ Path="services/orchestrator/tests/migrations.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/migrations.test.ts"; Category="Live" },
    @{ Path="services/orchestrator/tests/runtime.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/runtime.test.ts"; Category="Live" },
    @{ Path="services/orchestrator/tests/usage-summary.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest tests/usage-summary.test.ts"; Category="Live" },

    # Top-Level Integration & Isolation (9)
    @{ Path="tests/integration/artifacts-grants.integration.test.ts"; WorkDir="$repoRoot\tests\integration"; Cmd="npx jest artifacts-grants.integration.test.ts"; Category="Live" },
    @{ Path="tests/integration/connector-usage.integration.test.ts"; WorkDir="$repoRoot\tests\integration"; Cmd="npx jest connector-usage.integration.test.ts"; Category="Live" },
    @{ Path="tests/integration/p4-05-artifact-streams.integration.test.ts"; WorkDir="$repoRoot\tests\integration"; Cmd="npx jest p4-05-artifact-streams.integration.test.ts"; Category="Live" },
    @{ Path="tests/integration/p4-08-sdk-consumer.integration.test.ts"; WorkDir="$repoRoot\tests\integration"; Cmd="npx jest p4-08-sdk-consumer.integration.test.ts"; Category="Live" },
    @{ Path="tests/integration/p8-02-fault-recovery.integration.test.ts"; WorkDir="$repoRoot\tests\integration"; Cmd="npx jest p8-02-fault-recovery.integration.test.ts"; Category="Live" },
    @{ Path="tests/integration/p8-04-security-isolation.integration.test.ts"; WorkDir="$repoRoot\tests\integration"; Cmd="npx jest p8-04-security-isolation.integration.test.ts"; Category="Live" },
    @{ Path="tests/integration/usage-projection.integration.test.ts"; WorkDir="$repoRoot\tests\integration"; Cmd="npx jest usage-projection.integration.test.ts"; Category="Live" },
    @{ Path="tests/isolation/concurrent-interference.test.ts"; WorkDir="$repoRoot\services\orchestrator"; Cmd="npx jest --roots D:\Git\dugate\du-rework\tests\isolation"; Category="Offline" },
    @{ Path="tests/stubs/provider/mock-provider.test.ts"; WorkDir="$repoRoot\services\connector"; Cmd="npx jest --roots D:\Git\dugate\du-rework\tests\stubs\provider"; Category="Offline" }
)

# Filter suites based on Category and optional Filter string
$suitesToRun = $testSuites | Where-Object {
    ($Category -eq "All" -or $_.Category -eq $Category) -and
    ($Filter -eq "" -or $_.Path -like "*$Filter*")
}

Write-Telemetry "Filtered suites count: $($suitesToRun.Count) of $($testSuites.Count)"

$passedSuites = 0
$failedSuites = 0
$results = @()

$batchIndex = 0
foreach ($suite in $suitesToRun) {
    $batchIndex++
    $suiteName = $suite.Path
    $suiteCategory = $suite.Category
    $suiteWorkDir = $suite.WorkDir
    $baseCmd = $suite.Cmd

    $suiteLog = "$logDir\batch-$timestamp-$batchIndex.log"
    $cleanTimestamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") -replace '[^a-zA-Z0-9]', ''
    $runId = "iso_batch_${cleanTimestamp}_$batchIndex"
    $redisDb = 1 + ($batchIndex % 14)

    Write-Telemetry "----------------------------------------------------------"
    Write-Telemetry "[$batchIndex/$($suitesToRun.Count)] RUNNING: $suiteName ($suiteCategory)"

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    if ($suiteCategory -eq "Live") {
        $envPrefix = "set TEST_RUN_ID=$runId&& set DATABASE_URL=postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test&& set REDIS_DB_INDEX=$redisDb&& set REDIS_URL=redis://127.0.0.1:6380/$redisDb&& set CONNECTOR_INTEGRATION=1&& set CONNECTOR_DATABASE_URL=postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test&& set CONNECTOR_REDIS_URL=redis://127.0.0.1:6380/$redisDb&& "
        $fullCmd = "/c $envPrefix $baseCmd --runInBand --forceExit > `"$suiteLog`" 2>&1"
    } else {
        $fullCmd = "/c $baseCmd --runInBand --forceExit > `"$suiteLog`" 2>&1"
    }

    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList $fullCmd `
        -WorkingDirectory $suiteWorkDir `
        -PassThru `
        -Wait

    $sw.Stop()
    $durationMs = $sw.ElapsedMilliseconds
    $durationStr = "{0:N2}s" -f ($durationMs / 1000)

    $jestSummary = "No Jest summary found"
    if (Test-Path $suiteLog) {
        $lines = Get-Content $suiteLog
        $summaryLine = $lines | Select-String "Tests:\s+" | Select-Object -Last 1
        if ($summaryLine) {
            $jestSummary = $summaryLine.ToString().Trim()
        } elseif ($lines | Select-String "PASS ") {
            $jestSummary = "PASS (output truncated)"
        } elseif ($lines | Select-String "FAIL ") {
            $jestSummary = "FAIL (output truncated)"
        }
    }

    if ($proc.ExitCode -eq 0) {
        $passedSuites++
        Write-Telemetry "RESULT: PASS | ExitCode: 0 | $jestSummary | Duration: $durationStr"
        $results += [PSCustomObject]@{
            Index = $batchIndex
            Suite = $suiteName
            Category = $suiteCategory
            Status = "PASS"
            JestSummary = $jestSummary
            Duration = $durationStr
            Log = $suiteLog
            ExitCode = $proc.ExitCode
        }
    } else {
        $failedSuites++
        Write-Telemetry "RESULT: FAIL | ExitCode: $($proc.ExitCode) | $jestSummary | Duration: $durationStr"
        $results += [PSCustomObject]@{
            Index = $batchIndex
            Suite = $suiteName
            Category = $suiteCategory
            Status = "FAIL"
            JestSummary = $jestSummary
            Duration = $durationStr
            Log = $suiteLog
            ExitCode = $proc.ExitCode
        }
        if ($StopOnFirstFailure) {
            Write-Telemetry "StopOnFirstFailure specified. Aborting batch execution."
            break
        }
    }
}

$sumPassed = 0
$sumTotal = 0
foreach ($r in $results) {
    if ($r.JestSummary -match 'Tests:\s+(\d+)\s+passed') {
        $sumPassed += [int]$matches[1]
    }
    if ($r.JestSummary -match '(\d+)\s+total') {
        $sumTotal += [int]$matches[1]
    }
}

Write-Telemetry "=========================================================="
Write-Telemetry "BATCH EXECUTION SUMMARY"
Write-Telemetry "Category: $Category | Suites Total: $($suitesToRun.Count) | Suites Passed: $passedSuites | Suites Failed: $failedSuites"
Write-Telemetry "Tests Passed Sum: $sumPassed | Tests Total Sum: $sumTotal"
Write-Telemetry "=========================================================="

foreach ($r in $results) {
    $marker = if ($r.Status -eq "PASS") { "[PASS]" } else { "[FAIL]" }
    Write-Telemetry "$marker $($r.Suite) - $($r.JestSummary) - ExitCode: $($r.ExitCode) ($($r.Duration))"
}

Write-Telemetry "=========================================================="
if ($failedSuites -gt 0) {
    exit 1
} else {
    exit 0
}

