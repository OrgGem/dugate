$orca = "C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
$term = "term_f190d102-3a5a-4827-a1bf-ea62dcbc720b"

$prompt = @"
[PACKET W-VAULT-POL-TEST-1 — Vault machine policy and account isolation offline tests]

OBJECTIVE: Run existing Vault-related offline test suites in du-rework to verify policy enforcement and account isolation logic.

STEPS:
1. Search for existing test files related to Vault in du-rework: services/orchestrator/tests/vault*, services/connector/tests/vault*, packages/*/tests/vault*, and any file matching vault in test directories
2. Also search for test files related to account isolation and credential: *account-isolation*, *credential*, *machine-policy*
3. List all found test files
4. Run each found test suite OFFLINE (no DU_LIVE_INFRA, no Vault server needed): pnpm --filter <package> test -- <test-file>, Cwd: du-rework
5. Record results per suite: command, exit code, tests pass/fail/skip

If NO Vault-related tests exist yet: Report that clearly with the file search commands you ran. List what contracts/schemas exist in packages/contracts/src/ related to Vault (VaultKv2Ref, etc.). Suggest what test coverage is needed for VAULT-01..06.

CONSTRAINTS: Do NOT open a DB/Redis/Vault window. Do NOT modify source code. OFFLINE mode only. Write receipt to du-rework/coordination/reports/codex-security.md (append or create).
"@

& $orca terminal send --terminal $term --text $prompt --enter
