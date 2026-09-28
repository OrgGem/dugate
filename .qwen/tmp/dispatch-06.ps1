$ErrorActionPreference = "Continue"
chcp 65001 | Out-Null
$msgs = Get-Content -Raw -Encoding UTF8 "D:\Git\dugate\.qwen\tmp\dispatch-06.json" | ConvertFrom-Json
foreach ($m in $msgs) {
  $out = & orca terminal send --terminal $m.h --text $m.t --enter --wait-submit 40 --json 2>&1 | Out-String
  Write-Output ($out.Substring(0, [Math]::Min(420, $out.Length)))
}
