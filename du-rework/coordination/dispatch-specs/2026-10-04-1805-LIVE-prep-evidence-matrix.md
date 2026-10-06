# Dispatch spec — LIVE-prep: ma trận evidence live PLAN04-03 (§4) — chuẩn bị OFFLINE — 2026-10-04 18:05 +07

- **Owner:** codex_tester_live — `term_3adb7228-0087-45c5-8a18-77a4150a5043`
- **Run:** `run_069ecd6957cd` (command-code coordinator `term_58db0267`)
- **Mục tiêu:** chuyển bảng evidence §4 của `tasks/PLAN-COMPLETION-2026-10-04.md` (G-SEC/LIV-05, G-ENC/LIV-06, G-ADMIN-OPS/LIV-08..10, G-DATA) thành **kế hoạch test live thực thi được + fixtures/harness chuẩn bị trước (offline)**. **KHÔNG chạy live** — window do user/coordinator mở riêng.

## Việc cần làm

1. Với từng dòng evidence trong 4 bảng §4: test ID, mục tiêu verify, tiền điều kiện infra (Postgres/Redis/MinIO/Vault), bước thực thi, assertion, dữ liệu cần (sentinel/tamper/rotation/wrong-role), đường receipt, "hold không được bỏ qua".
2. Viết fixtures/script/harness ở khu vực test riêng của bạn — đề xuất vị trí (ví dụ `tests/integration/**`), **không chạm file source / suite đang được lane khác lease**; liệt kê rủi ro đụng độ nếu có (đặc biệt `tests/vault-live.test.ts`, `tests/integration/live-pipeline-e2e.integration.test.ts`, `tests/e2e/**`).
3. Đối chiếu với hạ tầng live đã ghi trong plan LIV (`tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md`) + report `liv03..liv11` (2026-10-04) để tránh làm lại; ghi rõ phần nào dùng lại được.
4. Nêu rõ **danh sách câu hỏi cần user/coordinator chốt** trước khi chạy live (window, scope, tenant, dữ liệu).

## Deliverable

- Receipt: `coordination/reports/live-test-prep-2026-10-04.md` + fixtures/script (nếu viết) + checklist điều kiện mở window.

## Constraints

- **OFFLINE ONLY** — được phép compile/chạy unit của script mình viết, nhưng không kết nối Postgres/Redis/MinIO/Vault.
- Không commit/push/reset; ghi rõ mọi thứ chưa thể kiểm chứng offline.
