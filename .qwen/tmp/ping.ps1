$ErrorActionPreference = "Continue"
chcp 65001 | Out-Null
$probe = "Coordinato check kenh: KHONG lam gi ca. Ghi chu: neu ban thay dong nay thi tra loi 'ok' roi dung." + [char]10
foreach ($h in @("term_95aad78d","term_f6e13d60")) {
  $t = (Get-Content -Raw "D:\Git\dugate\.qwen\tmp\handles.txt" -ErrorAction SilentlyContinue)
  $out = & orca terminal send --terminal $h --text $probe --enter --wait-submit 15 --json 2>&1 | Out-String
  Write-Output ("===== " + $h)
  Write-Output ($out.Substring(0, [Math]::Min(300, $out.Length)))
}
