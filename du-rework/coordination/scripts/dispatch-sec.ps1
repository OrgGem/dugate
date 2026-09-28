$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$secPacket = @"
[PACKET W-VAULT01-ORCH-BIND-1 @ 00:58] Codex-Security (Vault & Connector).
Doc du-rework/AGENTS.md, tasks/SEC-OIDC-VAULT-2026-09-24.md, va coordination/reports/W-VAULT01-BIND-1-receipt.md.
Nhiem vu: Tiep tuc dong gate integration cua VAULT-01 trong Orchestrator:
1. File can sua:
   services/orchestrator/src/modules/connector-credentials/connector-http-store.ts
   (hoac workflow lien quan trong connector-credentials)
2. Noi dung:
   Truyen cac truong binding doc lap (tenantId va accountId) khi Orchestrator tao/yeu cau Connector revision, dam bao khong chi gui moi credentialSource ma phai gui ca tenant/account doc lap theo Migration 008 va contract matchesVaultAccountPath.
3. Kiem thu offline:
   - pnpm --filter @du/contracts build
   - pnpm --filter @du/connector typecheck
   - pnpm --filter @du/orchestrator lint
   - pnpm --filter @du/orchestrator test -- tests/connector-credentials-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/connector-revision-http-offline.functional.test.ts
4. STRICT: Offline only. Khong dung vao DB window, khong goi PostgreSQL :5433, Redis :6380 hay Vault that.
5. Ghi raw logs va cap nhat receipt vao du-rework/coordination/reports/codex6.md. Khong commit, khong push.
"@

& $orcaCli terminal send --terminal term_f190d102-3a5a-4827-a1bf-ea62dcbc720b --text $secPacket --enter --retry-request 94c82e48-d69c-4862-8a75-46e5070c383e --wait-submit 10 --json
