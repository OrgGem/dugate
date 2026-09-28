$orca = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$out = & $orca terminal read --terminal term_f190d102-3a5a-4827-a1bf-ea62dcbc720b --screen --json | ConvertFrom-Json
$out.result.terminal.tail | ForEach-Object { Write-Host $_ }
