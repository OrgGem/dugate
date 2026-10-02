# CONV-00 — Baseline + guard script cho file lớn (từ plan `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md`)

## Bối cảnh

Plan CONV (SPECIFIED, chưa dispatch) yêu cầu một guard deterministic trước khi tách file. Nguồn đầy đủ:
`du-rework/tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` §CONV-00. Đây là packet tooling, **read-only mọi production source/test**.

## Mục tiêu

1. Script deterministic (Node, `.mjs`/`.cjs`, chạy cross-platform) trong **`du-rework/tools/`** (thư mục mới):
   đếm **tracked hand-authored code** (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.sql/.ps1/.sh`…), bỏ `node_modules/dist/build/coverage/.cache/__pycache__`;
   bỏ generated/history theo allowlist có giải thích (lock, `docs/21-openapi.json`, reports, state JSON).
2. Báo cáo: file `> 2.000` (FAIL-exit) và cảnh báo `>= 1.500` (WARN); baseline hiện tại phải khớp **5 file**
   (server.ts 4.299; runtime.test.ts 3.869; admin-shell-render.test.ts 2.815; multi-container-e2e 2.261; admin-operations-list-pagination.test.ts 2.031).
3. Exit code: nonzero **chỉ khi** có file mới vượt 2.000 hoặc file đã refactor tăng lại qua ngưỡng; không chặn toàn repo vì nợ cũ khi chưa tách.
4. Chứng minh: Windows/Linux line endings không đổi kết quả (test bằng file có CRLF vs LF).

## Ranh giới

- Chỉ ghi trong `du-rework/tools/` + receipt. **KHÔNG** sửa production source/test; **KHÔNG** sửa `package.json`/CI trong pass này
  (wiring CI để coordinator/integration owner quyết sau — ghi đề xuất 1 dòng trong receipt).
- Không tick gate; không commit; không nhắm `nocobase-10`; không sửa `tasks/*.md`, `AGENTS.md`, tasks/README.

## Acceptance

- Chạy script trên cùng tree → output khớp bảng baseline 5 file; ghi lệnh + exit code literal.
- Ghi rõ cách allowlist hoạt động (không silent-skip sai).
- Receipt: `coordination/reports/codex-conv00-file-size-guard-2026-10-02.md`.
