# CONV-08 — Chia `admin-shell-render.test.ts` theo pane

Nguồn: `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` mục `CONV-08` — đọc kỹ.

**File lease:** `services/orchestrator/tests/admin-shell-render.test.ts` (2.815 dòng) → các file mới `tests/admin-{shell,business,profile,connector,api-key,operation,overview}-render.test.ts` + helper fixture trong `tests/helpers/`. **Read-only renderers**; không sửa file khác.

## Việc

1. Chuyển các nested `describe` P6-01..07 vào file pane tương ứng; **chỉ trích fixture builder dùng chung thật** (không biến snapshot thành helper tự assert).
2. Giữ nguyên tại từng pane: escaping/role/unauthorized/fetch-failure assertions.
3. Mỗi file chạy **độc lập**, không phụ thuộc thứ tự Jest.

## Acceptance (theo plan)

- Không file nào >2.000 dòng; **số case và assertion chủ đạo trước/sau không giảm** (ghi số literal trước/sau trong receipt).
- Focused renderer suites + `tsc --noEmit` orchestrator (nếu package test config cần); literal command/cwd/exit.

## Ranh giới

- Không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/qwen-conv08-render-split-2026-10-02.md`.
