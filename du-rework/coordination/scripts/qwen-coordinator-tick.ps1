# Sends one coordination tick to the existing Qwen session. Never starts an agent.
$ErrorActionPreference = 'Stop'
$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$coordinatorHandle = 'term_5a11bb91-9cae-4588-a46c-0718b48bb39b'
$logDir = Join-Path $env:LOCALAPPDATA 'DUGate'
$logFile = Join-Path $logDir 'qwen-coordinator-tick.log'

function Write-TickLog([string]$message) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Add-Content -LiteralPath $logFile -Value ('{0:o} {1}' -f (Get-Date), $message)
}

try {
  $stateText = & $orcaCli terminal read --terminal $coordinatorHandle --limit 16 --json
  if ($LASTEXITCODE -ne 0) { throw 'Orca could not read the coordinator terminal.' }
  $state = $stateText | ConvertFrom-Json
  if (-not $state.ok -or $state.result.terminal.status -ne 'running') {
    throw 'Coordinator terminal is unavailable.'
  }

  $footer = @($state.result.terminal.tail | Select-Object -Last 8)
  $emptyPrompt = @($footer | Where-Object { $_ -match '^\*\s+Type your message or @path/to/file' }).Count -gt 0
  $compressDraft = @($footer | Where-Object { $_ -match '^\*\s*/compress\s*$' }).Count -gt 0
  $busy = @($footer | Where-Object { $_ -match 'Enter to steer|esc to cancel|Waiting for user confirmation' }).Count -gt 0
  if (-not ($emptyPrompt -or $compressDraft) -or $busy) {
    Write-TickLog 'SKIP busy or draft prompt; no second coordinator started.'
    exit 0
  }

  $prompt = 'DUGate 10-minute coordination tick. Read du-rework/AGENTS.md and the top of coordination/reports/coordinator-qwen.md. Check new receipts and roster, dispatch packets to the correct owners, and record a short coordination delta. Antigravity term_fdc51e22 is a Tester only; live tests share the exclusive CLAIM/RELEASE DB window with Tester-1. Do not code, test, review, commit, or push. Call Reviewer only for a specific independent decision. Avoid duplicate packets.'
  $receiptText = & $orcaCli terminal send --terminal $coordinatorHandle --text $prompt --enter --json
  $sendExit = $LASTEXITCODE
  $receipt = $receiptText | ConvertFrom-Json
  if ($sendExit -ne 0 -or -not $receipt.ok) {
    if ($receipt.error.code -in @('terminal_not_writable', 'agent_prompt_blocked')) {
      Write-TickLog ('SKIP terminal busy ({0}).' -f $receipt.error.code)
      exit 0
    }
    throw ('Orca could not send the coordination tick: {0}' -f $receipt.error.code)
  }
  if (-not $receipt.ok -or -not $receipt.result.send.accepted) {
    Write-TickLog 'SKIP prompt not accepted; no duplicate send.'
    exit 0
  }
  Write-TickLog ('SENT request={0}' -f $receipt.result.send.prompt.requestId)
} catch {
  Write-TickLog ('ERROR {0}' -f $_.Exception.Message)
  exit 1
}
