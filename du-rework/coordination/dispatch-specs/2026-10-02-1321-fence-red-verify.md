# Admin operations-list fence baseline red — verify & classify (READ-ONLY)

## Bối cảnh

CONV-10 receipt ghi **1 red retained** (có trước cả split): test `the x-api-key path is fenced by the key, not by the tenant param`
— kỳ vọng **403**, nhận **200** `{ next_page_token: null, operations: [] }` (nay ở `tests/admin-operations-sql.test.ts:483`).
Cần xác định: **test stale** hay **fence gap thật** (security-adjacent) — trước khi có ai sửa gì.

## Mục tiêu

1. Chạy lại suite `admin-operations-sql` → xác nhận red + literal output.
2. Trace read-only: test kỳ vọng gì (đọc test + fixture), code path admin operations list trong `server.ts` (READ-ONLY) —
   vì sao hiện trả 200; so sánh với fence của PUBLIC operations list; hành vi cross-tenant qua `x-api-key` (tenant A đọc tenant B?).
3. **Phân loại** (bắt buộc chọn 1 + dẫn chứng file:line):
   (a) test expectation stale — code đúng theo thiết kế hiện hành;
   (b) **fence gap thật** — mô tả chính xác ai đọc được gì, mức độ;
   (c) không xác định được offline — nêu phần thiếu.
4. Đề xuất hướng (sửa code / sửa test / escalate — không tự quyết, không fix).

## Ranh giới

- READ-ONLY; không sửa source/test; không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/tester-admin-fence-red-verify-2026-10-02.md`.
