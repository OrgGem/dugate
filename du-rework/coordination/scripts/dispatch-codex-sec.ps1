$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-VAULT-POL-TEST-1] Codex-Security (Vault Machine Policy & Account Isolation Verification).
CWD: D:\Git\dugate\du-rework.
Nhiem vu:
1. Chay va kiem tra cac suite policy va isolation cua Vault (VAULT-02 / VAULT-05 offline boundary):
   pnpm --filter @du/contracts test -- tests/vault-policies.test.ts tests/vault-ref.test.ts
   pnpm --filter @du/connector test -- tests/vault-machine-policies-offline.test.ts tests/vault-account-isolation.test.ts
   pnpm --filter @du/connector typecheck
2. Kiem tra tinh nhat quan cua writer (write-only) va reader (read-only) tren prefix tenant/account theo SEC-04/05.
3. STRICT: Khong sua source code, khong dung DB live window luc nay, khong commit/push git.
4. Ghi receipt vao coordination/reports/codex6-vault.md hoac tester/security log tuong ung.
"@

& $orcaCli terminal send --terminal term_f190d102-3a5a-4827-a1bf-ea62dcbc720b --text $prompt --enter --retry-request 640db215-5d31-44c3-ab28-883df3a361cf --wait-submit 10 --json
Write-Host "Dispatched W-VAULT-POL-TEST-1 to Codex-Security."
