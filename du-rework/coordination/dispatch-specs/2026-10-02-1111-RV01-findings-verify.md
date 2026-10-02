# RV01 findings — independent verify (READ-ONLY)

## Bối cảnh

`coordination/reports/qwen-rv01-loopback-http-2026-10-02.md` (cập nhật 11:02) — suite 45 pass + **6 `it.failing` tripwire**
= 39 green / 6 red finding (F1–F6). Trước khi user quyết fix wave, cần xác minh độc lập các claim.

## Mục tiêu

1. **Chạy suite gốc:** `cd du-rework/services/orchestrator` → `npx jest --runInBand --testPathPatterns "rv01-loopback"`
   → xác nhận literal 45/45. Chạy lại lần 2 để loại flake (ghi cả hai lần).
2. **Xác nhận 6 red đỏ thật** khi behavior không còn khớp legacy: cách chấp nhận — copy file test ra thư mục tạm NGOÀI repo
   (scratch), flip 6 `it.failing(` → `it(`, chạy bằng `npx jest --runTestsByPath <path-copy>` nếu chạy được;
   nếu không chạy được từ temp thì chứng minh từng red bằng probe độc lập + ghi rõ cách làm. Kết quả kỳ vọng: 6 failed / 39 passed.
3. **Cross-check từng finding F1–F6** với code hiện tại (file:line trong receipt): F1 (`legacy-http-mount.ts:597-606` +
   `server.ts:814-821`), F2/F3 (`legacyError()` shape/slug), F4 (`safePrincipal` 500 vs 401), F5 (`parseLegacyDocsPath` namespace),
   F6 (JSON-body guard 400 vs 415). VERIFIED Yes/No từng cái + bằng chứng mới (probe/đọc code).
4. **Kiểm tra nhẹ §7 regression claim** (không cần full lần nữa nếu tốn): ít nhất xác nhận không `legacy-*` suite nào đỏ
   (chạy lọc `--testPathPatterns "legacy"` nếu rẻ); nếu bỏ qua phần nào → nêu giới hạn.

## Ranh giới

- READ-ONLY: **không sửa file gốc nào** (kể cả test); bản copy temp phải ngoài repo và xoá sau.
- Không fix gì; không tick gate; không commit; không chạy infra live; không nhắm `nocobase-10`.
- Nếu finding không tái hiện → nói thẳng, không diễn giải thay.

## Acceptance

- Receipt `coordination/reports/tester-rv01-verify-2026-10-02.md`: bảng 6 finding → VERIFIED Yes/No + bằng chứng; 2 lần chạy suite;
  ghi rõ phần nào không làm được và vì sao.
