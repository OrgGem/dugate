$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET D-EVID-A21] Qwen-Docs (Evidence & Matrix Synchronization).
Doc du-rework/AGENTS.md, coordination/reports/review.md (Turn 130 audit L809), va cac receipt Turn 130-133:
- coordination/reports/qwen-vault.md Muc 3 (W-VAULT-CONNECTOR-ISOLATION-1, 45 tests) & Muc 4 (W-VAULT-POLICY-HCL-IDENTITY-1, 350 tests, delta 5/6)
- coordination/reports/qwen-platform.md Muc 3 (W-PLAT-CLAIM-CANCEL-FLAG-1, 86 tests)
- coordination/reports/qwen-cost.md Muc 3 (W-COST03-RECONCILIATION-1, 333 tests, BigInt micro-USD)
- coordination/reports/qwen-admin.md Muc 13 (W-ADMUX03-TOOLBAR-CHIPS-1)

Nhiem vu:
1. Cap nhat docs/19-traceability-audit-matrix.md, docs/28-test-inventory.md, docs/35-acceptance-baseline.md:
   - Ghi nhan ket qua Reviewer Turn 130: T130-A1 audit test mismatch, delta 36 va delta 23 tiep tuc CLOSED, 4 release gates (G-ADMIN-OPS, G-SEC, G-DATA, G6) giu NO-GO.
   - Bo sung cac receipt Turn 130-133 vao bang evidence append-only (docs/28 Section 8.18, docs/35 Section 12.21).
   - Bump Document Version 1.28.0 -> 1.29.0 tren ca docs/28 va docs/35.
2. Link check offline: Dam bao tat ca markdown link / line anchor hop le (BROKEN=0).
3. STRICT: Docs-only, khong sua code san pham, khong sua tests, khong chay tests, khong dung DB/Redis window, khong commit/push.
4. Ghi bao cao va ledger Muc 14 vao coordination/reports/qwen-docs.md. Sau khi xong hay chay /compress.
"@

& $orcaCli terminal send --terminal term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e --text $prompt --enter --json
Write-Host "Dispatched D-EVID-A21 to Qwen-Docs."
