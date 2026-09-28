$orca = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$terms = @(
  @{ Name = 'Reviewer'; Id = 'term_95461591-ce36-4932-bfbb-3a7ba5605da0' },
  @{ Name = 'Tester'; Id = 'term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5' },
  @{ Name = 'Codex-Security'; Id = 'term_f190d102-3a5a-4827-a1bf-ea62dcbc720b' },
  @{ Name = 'Qwen-DATA'; Id = 'term_6df22fa3-e399-4e31-9400-364917d9bdc8' },
  @{ Name = 'Qwen-SEC'; Id = 'term_3c201a29-7279-49c4-8dda-89bb6c18f48a' },
  @{ Name = 'Qwen-Admin'; Id = 'term_bf93d438-9974-4c4e-88a8-90e6ea80d37c' },
  @{ Name = 'Qwen-Docs'; Id = 'term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e' }
)

foreach ($t in $terms) {
  Write-Host "================== $($t.Name) ($($t.Id)) =================="
  $raw = & $orca terminal read --terminal $t.Id --screen --json 2>$null
  if ($raw) {
    $res = $raw | ConvertFrom-Json
    $tail = $res.result.terminal.tail
    ($tail | Select-Object -Last 12) -join "`n"
  } else {
    Write-Host "Failed to read terminal"
  }
}
