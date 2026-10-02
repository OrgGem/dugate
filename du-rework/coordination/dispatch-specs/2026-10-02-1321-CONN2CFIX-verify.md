# CONN-2CFIX independent verify (READ-ONLY)

## Bối cảnh

Fix receipt `du-rework/coordination/reports/qwen-conn2cfix-retryable-2026-10-02.md` (A-1 regression + A-2 partial self-correction).
Cần verify độc lập trước khi coi connector taxonomy ổn định.

## Mục tiêu

1. **Chạy suites** (literal): `services/connector` (gồm suite mới `provider-rejection-diagnostics` + `p8-03` sửa) và `packages/connector-client`;
   `tsc --noEmit` hai package. Ghi counts + exit codes.
2. **Cross-check claims (không tin receipt):**
   - (a) envelope non-2xx giờ mang `retryable` (+ `retryAfterMs` khi có) — đọc `services/connector/src/http/server.ts:76-88` bản hiện tại;
   - (b) client ưu tiên wire `error.retryable`, fallback theo `code` đã parse: xác nhận `502 + PROVIDER_REQUEST_REJECTED → false`,
     `502 + PROVIDER_UNAVAILABLE → true`, `429 → true` (đọc code + probe in-memory nếu cần);
   - (c) `services/connector/src/services.ts` **không còn diff** (`git diff` empty dù `git status` có thể còn ' M') — xác nhận bằng `git diff`;
   - (d) thuần additive: consumer cũ không đọc field mới không đổi hành vi (lập luận + bằng chứng).
3. Nếu claim không tái hiện → nói thẳng, không diễn giải thay.

## Ranh giới

- READ-ONLY; không sửa file; không tick gate; không commit; không chạy infra live; không nhắm `nocobase-10`.
- Receipt: `du-rework/coordination/reports/tester-conn2cfix-verify-2026-10-02.md`.
