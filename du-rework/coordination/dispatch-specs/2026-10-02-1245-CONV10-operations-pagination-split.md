# CONV-10 — Chia `admin-operations-list-pagination.test.ts` (từ plan CONVENTION)

## Bối cảnh

Plan `CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md` §CONV-10: file test 2.031 dòng — parser, catalog/toolbar, SQL/keyset, sort, negative bounds cùng file.
Test-only refactor — read-only production.

## Mục tiêu

1. Tách theo top-level `describe` thành các file gợi ý trong plan: `tests/admin-operations-{query,view,sql,sort}.test.ts` + `tests/helpers/operations-page-fixture.ts` (file mới riêng của task này).
2. Helper fake DB/fetch phải giữ **query/params observable** — không thay SQL assertions bằng mock output.
3. Coverage không giảm: full/partial page, prev/next, NULL deadline, tie-break, injection/foreign tenant, bad cursor — đối chiếu count trước/sau.
4. Mỗi file chạy độc lập; không phụ thuộc thứ tự Jest.

## Ranh giới

- Allowed: file test hiện tại + các file mới tách + helper mới **riêng của task** trong `tests/helpers/`.
  **KHÔNG chạm** file/helper của CONV-08.
- Không sửa production; không tick gate; không commit; không nhắm `nocobase-10`.

## Acceptance

- Mỗi file **< 2.000 dòng**; focused suites (pagination/sort/keyset) + `tsc --noEmit` → exit 0; ghi literal counts trước/sau.
- Receipt: `coordination/reports/tester-conv10-operations-pagination-split-2026-10-02.md`.
