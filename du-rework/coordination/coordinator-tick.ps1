$ErrorActionPreference = 'Stop'

$workspacePath = 'D:\Git\dugate'
$coordinationPath = Join-Path $workspacePath 'du-rework\coordination'
$coordinatorPath = Join-Path $coordinationPath 'coordinator-state.json'
$statePath = Join-Path $coordinationPath 'coordinator-schedule-state.json'
$promptPath = Join-Path $coordinationPath 'coordinator-cycle-prompt.md'
$errorPath = Join-Path $coordinationPath 'coordinator-schedule-error.log'
$orcaCommand = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$mutex = [System.Threading.Mutex]::new($false, 'Local\du-rework-coordinator-tick')

if (-not $mutex.WaitOne(0)) {
  exit 0
}

try {
  Set-Location -LiteralPath $workspacePath
  $terminalList = & $orcaCommand terminal list --worktree active --json | ConvertFrom-Json
  if (-not $terminalList.ok) { throw 'Orca terminal inventory failed.' }

  $coordinator = Get-Content -LiteralPath $coordinatorPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $coordinators = @($terminalList.result.terminals | Where-Object {
    $_.handle -eq $coordinator.coordinator_handle -and $_.agentIdentity -eq 'antigravity' -and $_.connected
  })
  if ($coordinators.Count -ne 1) { throw "Expected one primary coordinator terminal; found $($coordinators.Count)." }

  $terminalHandle = $coordinators[0].handle
  $transcript = & $orcaCommand terminal read --terminal $terminalHandle --limit 500 --json | ConvertFrom-Json
  if (-not $transcript.ok) { throw 'Orca coordinator transcript read failed.' }

  $state = if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    [pscustomobject]@{ cycleId = $null; startedAt = $null; completedAt = $null; incompleteChecks = 0; lastNudgeAt = $null; terminalHandle = $terminalHandle }
  }

  $now = (Get-Date).ToUniversalTime().ToString('o')
  if ($state.cycleId) {
    $completionMarker = "CYCLE_COMPLETE:$($state.cycleId)"
    $finished = @($transcript.result.terminal.tail | Where-Object { $_.Trim() -eq $completionMarker }).Count -gt 0
    if (-not $finished) {
      $state.incompleteChecks = [int]$state.incompleteChecks + 1
      if ($state.incompleteChecks -ge 3 -and -not $state.lastNudgeAt) {
        $nudge = "Continue the current coordination cycle. Finish or report the blocker. End your response with the exact line $completionMarker"
        $receipt = & $orcaCommand terminal send --terminal $terminalHandle --text $nudge --enter --json | ConvertFrom-Json
        if ($receipt.ok -and $receipt.result.send.accepted) { $state.lastNudgeAt = $now }
      }
      [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 8), $utf8)
      exit 0
    }
    $state.completedAt = $now
  }

  $cycleId = [guid]::NewGuid().ToString('N')
  $prompt = (Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8) + "`nEnd your response with exactly one line: CYCLE_COMPLETE:$cycleId"
  $send = & $orcaCommand terminal send --terminal $terminalHandle --text $prompt --enter --json | ConvertFrom-Json
  if (-not $send.ok -or -not $send.result.send.accepted) { throw 'Orca did not accept the coordinator prompt.' }

  $state.cycleId = $cycleId
  $state.startedAt = $now
  $state.incompleteChecks = 0
  $state.lastNudgeAt = $null
  $state.terminalHandle = $terminalHandle
  [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 8), $utf8)
} catch {
  $message = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $_.Exception.Message
  Add-Content -LiteralPath $errorPath -Value $message -Encoding UTF8
  exit 1
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
