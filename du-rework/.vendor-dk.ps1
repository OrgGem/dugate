$ErrorActionPreference = 'Stop'
$NL = [string][char]10
$repo = 'D:/Git/dugate/du-rework'
$dst  = Join-Path $repo 'businesses/document-core/template/vendor/document-kit/src'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
$oplistPath = 'C:/Users/Gem/AppData/Local/Temp/vendor-oplist-dk.json'
if (-not (Test-Path $oplistPath)) { Write-Output 'NO_OPLIST'; exit 2 }
$ops = Get-Content $oplistPath -Raw | ConvertFrom-Json
$report = @()
foreach ($op in $ops) {
  $src = Join-Path $repo $op.from
  if (-not (Test-Path $src)) { Write-Output ('MISSING ' + $op.from); exit 3 }
  $body = [System.IO.File]::ReadAllBytes($src)
  $nlines = ([System.IO.File]::ReadAllLines($src)).Count
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash
  $h1 = '// VENDORED from ' + $op.pkg + ' @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)'
  $h2 = '// source: ' + $op.from + ' (lines=' + $nlines + ') sha256=' + $sha
  $h3 = '// why: ' + $op.why
  $hdr = $h1 + $NL + $h2 + $NL + $h3 + $NL + $NL
  $hb = [System.Text.Encoding]::UTF8.GetBytes($hdr)
  $dir = Split-Path -Parent $op.to
  if ($dir) { New-Item -ItemType Directory -Force -Path (Join-Path $dst $dir) | Out-Null }
  $out = Join-Path $dst ($op.to -replace '/[\\]', [char]92)
  $fs = [System.IO.File]::Create($out)
  $fs.Write($hb, 0, $hb.Length)
  $fs.Write($body, 0, $body.Length)
  $fs.Close()
  $dsha = (Get-FileHash -Algorithm SHA256 -LiteralPath $out).Hash
  $report += ($op.to + ' | srcLines=' + $nlines + ' | src16=' + $sha.Substring(0,16) + ' | vend16=' + $dsha.Substring(0,16))
}
$report | ForEach-Object { Write-Output $_ }
Write-Output ('VENDORED=' + $report.Count)
