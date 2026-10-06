# FENCE-ALIGN-VERIFY — xác nhận suite admin-operations-sql xanh sau FENCE-TEST-ALIGN (READ-ONLY)

## Bối cảnh

`qwen-fence-test-align-2026-10-02.md` vừa sửa assertion stale (case A viết lại mạnh hơn + case B mới) trong
`services/orchestrator/tests/admin-operations-sql.test.ts` — file này từng có **1 red retained** (baseline cũ). Cần xác nhận độc lập suite giờ xanh và hai case mới đúng ngữ nghĩa.

## Mục tiêu

1. Chạy `npx jest --runInBand --runTestsByPath tests/admin-operations-sql.test.ts` (từ `du-rework/services/orchestrator`) — kỳ vọng **0 failed**; ghi literal.
2. Chạy lại cụm focused liên quan admin-operations (query/view/sql/sort) — ghi literal; xác nhận không có red mới.
3. Đọc 2 case mới (A: compat behavior — `tenant` bị bỏ qua + scoped theo key; B: canonical-bearer 403) — xác nhận assertion đúng với hành vi hiện tại và **không weaken** (so với ý nghĩa cũ).
4. Nếu còn red → nói thẳng; không sửa.

## Ranh giới

- READ-ONLY; không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/tester-fence-align-verify-2026-10-02.md`.
