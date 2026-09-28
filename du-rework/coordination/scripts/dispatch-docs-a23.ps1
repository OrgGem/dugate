$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = @"
[PACKET D-EVID-A23] Qwen-Docs (Dong bo Generator tools/openapi/gen_openapi.py & contracts-v1.md giai quyet T140-D1).
Doc du-rework/AGENTS.md, coordination/reports/review.md (Turn 150 finding T140-D1), va tools/openapi/gen_openapi.py:
Boi canh finding T140-D1 tu Reviewer Turn 150:
Reviewer danh gia: "T140-D1 is partly corrected, with a reproducibility gap. D-EVID-A22's manually updated docs/21-openapi.json advertises all six operations parameters; the generator still advertises two. A fresh generation can erase the documented contract. The contracts/OpenAPI owner must align tools/openapi/gen_openapi.py, regenerate and compare the artifact, update coordination/gates/contracts-v1.md, and revise docs/06/20 once T140-A1's final wire policy is verified."

Nhiem vu:
1. Cap nhat tools/openapi/gen_openapi.py:
   - Tai dong 36 (route /api/v1/operations):
     Bo sung day du ca 6 query parameters: limit, cursor, state, tenant, id, sort.
     Param `sort` can ghi ro description/schema: 6 gia tri allowlist (created_at:asc, created_at:desc, updated_at:asc, updated_at:desc, deadline_at:asc, deadline_at:desc).
   - Chay generator: `python tools/openapi/gen_openapi.py` (hoac chay tu root repo / du-rework) de tai sinh `docs/21-openapi.json` hop le, khong bi de mat contract.
2. Cap nhat coordination/gates/contracts-v1.md (dong 43 va cac vi tri lien quan):
   - Bo sung symbol `sort` va allowlist vao bang hop dong.
3. Kiem thu:
   - python tools/openapi/gen_openapi.py exit 0.
   - So sanh diff docs/21-openapi.json dam bao 6 params van day du va khong bi mat route.
   - Chay link check S0 va S1 dam bao BROKEN=0.
4. STRICT: Chi sua tai lieu va generator script, khong sua code san pham server.ts, khong dung DB window, khong commit/push.
5. Ghi receipt Muc 16 vao coordination/reports/qwen-docs.md.
"@

& $orcaCli terminal send --terminal term_8ba9a7d5-e5b4-437e-b613-e9281007ad6e --text $prompt --enter --json
Write-Host "Dispatched D-EVID-A23 to Qwen-Docs."
