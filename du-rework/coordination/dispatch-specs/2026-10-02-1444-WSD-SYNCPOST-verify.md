# WSD-SYNCPOST-VERIFY — xác minh fix "giữ mã lỗi connector trên sync POST" (READ-ONLY)

## Bối cảnh

Spec gốc: `dispatch-specs/2026-10-02-1402-wsd-syncpost-code.md`. Lane qwen_2 **crash** (`Fatal: uncaught exception` / `write EAGAIN`)
sau khi code xong; phần việc **đã nằm trong commit `b088eec`**:
`packages/worker-sdk/src/connector-invoker.ts` (+67), `tests/connector-sync-post-code.test.ts` (+172),
`tests/connector-invoker.test.ts` (±10), `src/index.ts` (+2) — cùng `bounded-fanout*` (CONV-06).
**Receipt chưa có** → cần xác minh độc lập và viết receipt.

## Mục tiêu

1. Đọc diff của `b088eec` cho `packages/worker-sdk`; xác nhận đúng 3 hành vi theo spec:
   (a) 400/`PROVIDER_REQUEST_REJECTED` **giữ nguyên code** thay vì flatten thành `PROVIDER_UNAVAILABLE`;
   (b) 502/`PROVIDER_UNAVAILABLE` giữ code; (c) nhánh cũ 401/403/409 không đổi; và **retry semantics không đổi** (`worker.ts` dùng `=== 503`).
2. Chạy full `pnpm --filter @du/worker-sdk test` + `tsc --noEmit` — ghi literal; đối chiếu mốc `669/669` (VFY-REG 14:30) và `650/650` (trước WSD).
3. Chạy riêng `connector-sync-post-code.test.ts` + `connector-invoker.test.ts` — ghi literal.
4. Nêu rõ điểm KHÔNG chứng minh được (nếu có); không overclaim.

## Ranh giới

- READ-ONLY; không sửa file; không tick gate; không commit; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/tester-wsd-syncpost-verify-2026-10-02.md`.
