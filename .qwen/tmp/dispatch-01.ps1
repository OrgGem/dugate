$ErrorActionPreference = "Continue"
chcp 65001 | Out-Null
$msgs = Get-Content -Raw -Encoding UTF8 "D:\Git\dugate\.qwen\tmp\dispatch-01.json" | ConvertFrom-Json
foreach ($m in $msgs) {
  Write-Output ("===== " + $m.h.Substring(0,14))
  $out = & orca terminal send --terminal $m.h --text $m.t --enter --wait-submit 20 --json 2>&1 | Out-String
  try { $j = $out | ConvertFrom-Json; $r = $j.result; Write-Output ("stage=" + $r.stage + " req=" + $r.requestId + " id=" + $j.id + " seq=" + $r.baselineWorkingSequence) } catch { Write-Output ($out.Substring(0, [Math]::Min(400, $out.Length))) }
}
