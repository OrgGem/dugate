$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-OIDC04-SESSION-FLOW] Qwen-SEC (OIDC-04 Browser Session Lifecycle & CSRF Guard).
Doc du-rework/AGENTS.md va tasks/SEC-OIDC-VAULT-2026-09-24.md (OIDC-04 & B0-B5 scenario).
Nhiem vu:
1. Pham vi sua: services/orchestrator/src/app/admin/shell-router.ts hoac auth/session handlers tuong ung.
2. Yeu cau:
   - Kiem tra va dam bao luong callback Authorization Code + PKCE cua fake IdP / OIDC.
   - Dam bao cookie session co Secure flag (khi tren HTTPS), HttpOnly, SameSite=Lax.
   - CSRF guard tren tat ca cac action mutation (POST /api/v1/admin/actions).
   - Test cac negative cases: expired session, missing CSRF token, forged identity header -> fail closed (401/403).
3. Kiem thu:
   - Chay unit/integration tests offline:
     pnpm --filter @du/orchestrator test -- tests/admin-shell-session-lifecycle.test.ts tests/admin-oidc04-claims-tenant-offline.test.ts tests/admin-oidc-flow.test.ts
   - npx tsc --noEmit
4. Quy tac: Offline unit only. Khong mo DB window, khong commit/push git.
5. Ghi receipt vao coordination/reports/qwen-sec.md.
"@

& $orcaCli terminal send --terminal term_3c201a29-7279-49c4-8dda-89bb6c18f48a --text $prompt --enter --json
Write-Host "Dispatched W-OIDC04-SESSION-FLOW to Qwen-SEC."
