$ErrorActionPreference = "Continue"
chcp 65001 | Out-Null
$msgs = Get-Content -Raw -Encoding UTF8 "D:\Git\dugate\.qwen\tmp\dispatch-02.json" | ConvertFrom-Json
$retries = Get-Content -Raw -Encoding UTF8 "D:\Git\dugate\.qwen\tmp\retry-02.json" | ConvertFrom-Json
foreach ($r in $retries) {
  $m = $msgs | Where-Object { $_.h -eq $r.h }
  Write-Output ("===== " + $r.h.Substring(0,14))
  $out = & orca terminal send --terminal $r.h --text $m.t --enter --retry-request $r.r --wait-submit 25 --json 2>&1 | Out-String
  Write-Output ($out.Substring(0, [Math]::Min(700, $out.Length)))
}
