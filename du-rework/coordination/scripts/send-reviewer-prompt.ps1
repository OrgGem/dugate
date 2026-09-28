$orcaCli = 'C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe'
$prompt = "Thuc hien kiem toan doc lap dinh ky Turn 20: Doc du-rework/AGENTS.md, tasks/README.md, va cac bao cao gan nhat trong coordination/reports/ (qwen-data.md, qwen-docs.md, tester.md, codex6.md, W-VAULT01-BIND-1-receipt.md). Kiem tra conformance spec-code-receipt tren cac lane DATA, SEC, Admin, va Vault. Danh gia phat hien moi, resize va re-evaluate tasks va plan, cap nhat vao coordination/reports/review.md. Khong commit push."

& $orcaCli terminal send --terminal term_95461591-ce36-4932-bfbb-3a7ba5605da0 --text $prompt --enter --json
