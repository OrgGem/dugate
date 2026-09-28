$orca = "C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
$term = "term_f31e5ec1-55f1-4483-b1eb-f1a6208bd7f5"

$prompt = @"
[PACKET T-CODEX-TEST-24 — Admin audit/API-keys/business list contract verification]

OBJECTIVE: Verify the current implementations of Admin list endpoints for audit, API keys and businesses — confirm pagination (cursor+limit), tenant scoping and envelope format.

SCOPE: Run existing test suites that cover Admin list functionality beyond Operations (which is already ACCEPTED). Focus on:
1. Audit events: GET /api/v1/admin/audit — verify tenant-scoped reader, limit enforcement, response envelope
2. API keys: GET /api/v1/admin/api-keys — verify tenant-scoped listing, any limit/cursor behavior
3. Businesses: GET /api/v1/admin/businesses — verify listing behavior

STEPS:
1. Identify existing test files covering audit, API key, and business Admin GET endpoints. Search in: du-rework/services/orchestrator/tests/ (look for admin-audit*, admin-api-key*, admin-business* test files) and du-rework/tests/ root level
2. Run the relevant test suites OFFLINE first (no DU_LIVE_INFRA): Command pattern: pnpm --filter @du/orchestrator test -- <test-file-glob>, Cwd: du-rework
3. Record results: exit code, suites/tests pass/fail/skip counts.
4. If audit/API-keys/business list tests DO NOT EXIST yet, report that clearly — the Coordinator will assign implementation to Qwen-Admin before testing.

CONSTRAINTS: Do NOT modify source code or test files. Do NOT open a DB/Redis window (offline mode only for this packet). Record command, cwd, HEAD commit, exit code, pass/fail/skip in receipt format. Write receipt to: du-rework/coordination/reports/tester.md (append)
"@

& $orca terminal send --terminal $term --text $prompt --enter
