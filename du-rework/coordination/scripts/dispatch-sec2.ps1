$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET W-ADMBASE03-ERR-1] Qwen-SEC (Security & Error Boundary).
Doc du-rework/AGENTS.md va tasks/SEC-OIDC-VAULT-2026-09-24.md (ADM-BASE-03).
Nhiem vu: Chuan hoa error boundary va sentinel leakage defense cho Orchestrator Admin Shell / HTTP:
1. File can sua:
   services/orchestrator/src/app/admin/shell-server.ts (hoac middleware xu ly loi ProblemDetails cua Orchestrator).
2. Yeu cau:
   - Khong bao gio dua raw err.message, stack trace, upstream Vault/IdP token vao HTTP response detail hoac unmasked log.
   - Dung ProblemDetails voi safe error code, generic safe message, va correlationId.
3. Kiem thu:
   - Them/chay unit test offline (vd trong tests/admin-error-boundary-offline.test.ts hoac tuong duong): inject sentinel token/secret 'SENTINEL-SECRET-9999' vao exception, assert response body, HTML, va logs co ZERO matches.
   - tsc --noEmit exit 0.
   - Jest targeted test suite pass x3 lien tiep exit 0.
4. STRICT: Offline only. Khong dung vao DB window, khong commit/push.
5. Ghi receipt va ledger vao du-rework/coordination/reports/qwen-sec.md.
"@

& $orcaCli terminal send --terminal term_3c201a29-7279-49c4-8dda-89bb6c18f48a --text $prompt --enter --json
Write-Host "Dispatched to Qwen-SEC."
