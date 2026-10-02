# FENCE-RED re-verify (READ-ONLY) — sau khi CONV-12 hạ tầng tsc đã sạch

## Bối cảnh

Lần verify trước (`tester-admin-fence-red-verify-2026-10-02.md`) kết luận **(c) không xác định offline** vì:
cached run trả 200 envelope lệch return-path hiện tại; **uncached run bị chặn trước execution bởi TS diagnostics của CONV-12** (nay CONV-12 đã xong,
`qwen-conv12-shell-router-split-2026-10-02.md` — shell-router.ts 447 + 5 module mới). Đây là lần chạy lại để chốt phân loại.

## Mục tiêu

1. Chạy lại `pnpm --filter @du/orchestrator test -- tests/admin-operations-sql.test.ts` (cached) + lần thứ hai với `npx jest --no-cache --runInBand --runTestsByPath tests/admin-operations-sql.test.ts`
   từ `du-rework/services/orchestrator` — ghi literal cả hai.
2. Xác định run sạch giờ chạy được đến execution chưa; nếu test vẫn đỏ, xác định vì sao 200 (envelope nào, có khớp return-path hiện tại không).
3. **Phân loại chốt (a)/(b)/(c)** với bằng chứng file:line; nếu cần populated cross-tenant fixture để phân biệt, dùng **probe tạm ngoài repo** (temp copy như các verify trước) — KHÔNG sửa file repo.
4. Nêu rõ nếu 200 anomaly trước đây là artifact cache (jest cache của file cũ) hay có thật trên source hiện tại.

## Ranh giới

- READ-ONLY; không sửa source/test/fixture trong repo; không tick gate; không commit; không infra live; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/tester-fence-red-reverify-2026-10-02.md`.
