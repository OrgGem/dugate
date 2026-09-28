# Antigravity Coordinator Tick script
$ErrorActionPreference = 'Stop'
$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$stateFile = 'D:\Git\dugate\du-rework\coordination\coordinator-state.json'
$reportFile = 'D:\Git\dugate\du-rework\coordination\reports\coordinator-antigravity.md'

if (-not (Test-Path $stateFile)) {
  Write-Error "State file not found at $stateFile"
  exit 1
}

$state = Get-Content $stateFile -Raw | ConvertFrom-Json
$state.turn++
$state.last_tick = (Get-Date).ToString("o")

Write-Host "========================================="
Write-Host "=== ANTIGRAVITY COORDINATOR TICK: Turn $($state.turn) ==="
Write-Host "=== Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Write-Host "========================================="

$terminals = @()
foreach ($prop in $state.roster.PSObject.Properties) {
  if ($prop.Name -ne "coordinator" -and $prop.Value.handle) {
    $terminals += @{
      Name = $prop.Name
      Handle = $prop.Value.handle
      Identity = if ($prop.Value.identity) { $prop.Value.identity } else { "agent" }
      Role = $prop.Value.role
    }
  }
}

$results = @()

foreach ($t in $terminals) {
  try {
    $resText = & $orcaCli terminal read --terminal $t.Handle --screen --json 2>$null
    if ($LASTEXITCODE -eq 0 -and $resText) {
      $res = $resText | ConvertFrom-Json
      $tail = $res.result.terminal.tail
      $tailText = ($tail | Select-Object -Last 5) -join " "
      
      $isIdle = $false
      $isStuck = $false
      $statusDesc = "Running"

      if ($tailText -match "Waiting for user confirmation|Y/N|\[y/N\]|Approaching rate limits|Press enter to confirm") {
        $isStuck = $true
        $statusDesc = "STUCK (Waiting user confirmation)"
      } elseif ($tailText -match "Working\s*\(|Enter to steer|Running command") {
        $statusDesc = "WORKING (In progress)"
      } elseif ($tailText -match "Type your message or @path/to/file|Ask Codex to do anything|YOLO mode \(tab to cycle\)") {
        $isIdle = $true
        $statusDesc = "IDLE (Ready for prompt)"
      } elseif ($res.result.terminal.status -ne "running") {
        $statusDesc = "UNAVAILABLE (" + $res.result.terminal.status + ")"
      } else {
        $statusDesc = "WORKING"
      }

      $results += [PSCustomObject]@{
        Role = $t.Name
        Handle = $t.Handle
        Status = $statusDesc
        IsIdle = $isIdle
        IsStuck = $isStuck
        TailPreview = ($tail | Select-Object -Last 2) -join " | "
      }
    } else {
      $results += [PSCustomObject]@{
        Role = $t.Name
        Handle = $t.Handle
        Status = "OFFLINE_OR_UNREADABLE"
        IsIdle = $false
        IsStuck = $false
        TailPreview = "N/A"
      }
    }
  } catch {
    $results += [PSCustomObject]@{
      Role = $t.Name
      Handle = $t.Handle
      Status = "ERROR: " + $_.Exception.Message
      IsIdle = $false
      IsStuck = $false
      TailPreview = "N/A"
    }
  }
}

$results | Format-Table -AutoSize -Property Role, Status, TailPreview

# Save state
$state | ConvertTo-Json -Depth 5 | Set-Content $stateFile -Encoding UTF8

# Reviewer periodic review trigger (every 10 turns or demand-driven)
$reviewerInterval = if ($state.reviewer_interval_turns) { [int]$state.reviewer_interval_turns } else { 10 }
if ($reviewerInterval -gt 0 -and ($state.turn % $reviewerInterval -eq 0)) {
  Write-Host ">>> Turn $($state.turn) reaches review cycle! Triggering Reviewer Codex..."
  $reviewerPrompt = @"
DUGate Periodic Review Checkpoint: Turn $($state.turn) Independent Audit.
Please read du-rework/AGENTS.md, tasks/README.md, coordination/reports/review.md (Turn 80 audit), and recent reports:
- coordination/reports/coordinator-antigravity.md
- coordination/reports/qwen-admin.md (Section 11)

Key Audit Focus for Turn $($state.turn):
1. Review and adjudicate finding Δ36 closure: Qwen-Docs completed D-EVID-A15 (docs/19, 20, 22 synchronized, v1.24.0, link check BROKEN=0).
2. Review and adjudicate finding Δ23 closure: Tester Codex completed T-CODEX-TEST-23 on live PG :5433 / Redis :6380 (6/6 pass, Index Scan confirmed, zero Seq Scan).
3. Review status of T-CODEX-TEST-22 (Admin browser harness 82/82 pass, C0-C3 synthetic verified) and confirm requirements for C4/C5 live gate.
4. Confirm release gate status: G-ADMIN-OPS, G-SEC, G-DATA, G6 strictly NO-GO.
5. Provide Turn 110 Independent Audit in coordination/reports/review.md with resized roadmap for Turn 110-120.
"@
  & $orcaCli terminal send --terminal $state.roster.reviewer.handle --text $reviewerPrompt --enter --json | Out-Null
  Write-Host ">>> Reviewer Codex notified."
}
