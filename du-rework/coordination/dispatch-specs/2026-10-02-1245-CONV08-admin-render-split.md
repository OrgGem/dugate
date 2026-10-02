# CONV-08 — Chia `admin-shell-render.test.ts` theo pane (từ plan CONVENTION)

## Bối cảnh

Plan `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` §CONV-08: file test 2.815 dòng, một `describe` chứa shell + P6-02..07 renderer/fetcher.
Test-only refactor — read-only renderers.

## Mục tiêu

1. Chuyển nested `describe` P6-01..07 vào các file tương ứng (theo tên gợi ý trong plan §CONV-08), helper fixture (nếu trích) đặt trong `tests/helpers/` **file mới riêng của task này**.
2. **Chỉ** trích fixture builders thực sự dùng chung; giữ nguyên escaping/role/unauthorized/fetch-failure assertions ở từng pane; không biến snapshot thành helper tự-assert.
3. Giữ skip-guard/đếm case: không giảm số case/assertion chủ đạo; mỗi file chạy độc lập (không phụ thuộc thứ tự Jest).

## Ranh giới

- Allowed: file test hiện tại + các file test mới tách từ nó + helper mới **riêng của task** trong `tests/helpers/`.
  **KHÔNG chạm** file của CONV-10 (admin-operations-list-pagination) hoặc helper của họ.
- Không sửa production/renderers; không tick gate; không commit; không nhắm `nocobase-10`.

## Acceptance

- Mỗi file hand-authored **< 2.000 dòng**; focused renderer suites + `tsc --noEmit` → exit 0 (ghi literal counts trước/sau).
- Receipt: `coordination/reports/tester-conv08-admin-render-split-2026-10-02.md`.
