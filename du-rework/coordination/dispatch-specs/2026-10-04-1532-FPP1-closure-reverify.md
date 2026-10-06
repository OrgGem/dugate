# Dispatch spec — F-PP1 closure re-verify (2026-10-04 15:32 +07)

## Mục tiêu

Re-verify ngắn, READ-ONLY, đóng finding **F-PP1** (`profile-phase1-verify-2026-10-04.md` §3) sau khi owner (Claude) đã sửa 3 điểm.

## Việc cần làm

1. **Lớp contract**: `profile-policy.ts` — `PROFILE_JOB_PRIORITY_WEIGHTS` phải là `{ LOW: 20, MEDIUM: 10, HIGH: 1 }`; comment phải nói rõ BullMQ lower-first + parity `lib/pipelines/submit.ts:26-32`.
2. **Test**: `packages/contracts/tests/profile-policy.test.ts` — pin giá trị mới + (nếu có) case parity với hằng `LEGACY_BULLMQ`; chạy lại suite (ghi literal count mới — có thể ≠27 nếu thêm case; xác nhận exit 0).
3. **OpenAPI**: `docs/21-openapi.json` — description priority đã đúng chiều (LOW 20 / MEDIUM 10 / HIGH 1 + cite legacy); JSON parse + `$ref` 0 unresolved (đếm lại schemas/paths/x-absent).
4. **Không còn nguồn đảo chiều**: grep `PROFILE_JOB_PRIORITY_WEIGHTS` và chuỗi `20/10/1`/`1/10/20` trong `packages/contracts/**`, `docs/21-openapi.json`, `services/orchestrator/src/**` — xác nhận chỉ còn bảng đúng; nêu nếu có consumer đầu tiên xuất hiện.
5. `tsc` contracts.

## Verdict

- `VERIFIED` (đóng F-PP1) hoặc `CHANGES_REQUIRED` + `file:line`.

## Deliverable

- Receipt: `coordination/reports/fpp1-closure-verify-2026-10-04.md`.

## Lane

- **cc_2** — `term_5f7e42da-6790-4449-8539-746626c5d078`. Dispatch 2026-10-04 15:32.
