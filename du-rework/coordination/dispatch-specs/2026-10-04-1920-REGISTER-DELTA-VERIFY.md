# Dispatch spec — REGISTER-DELTA-VERIFY (cc_2, read-only) — 2026-10-04 19:20 +07

- **Owner:** cc_2 — `term_ee7e9f33-e20d-483d-8423-830f2924d90c`
- **Run:** `run_069ecd6957cd` · Nguồn: findings **N1–N4** trong `cfgadm-lpg-register-delta-2026-10-04.md` của bạn + `plan-merge-fix-2026-10-04.md` (codex_arch vừa land).

## Việc cần làm (READ-ONLY)

1. Re-anchor inventory register-delta sau merge-fix (limitations §1 của bạn yêu cầu): spot-check các kết luận còn đúng không (row/definition/citation/dedupe).
2. Với **N1–N4**: đối chiếu cây hiện tại — cái nào merge-fix đã chạm/không chạm; verdict FIXED / STILL / NOT-IN-SCOPE.
3. Nếu merge-fix chưa cover N1/N4 (không nằm trong 10 mục M/L): ghi rõ đề xuất cho lần plan-touch kế tiếp (không tự sửa).
4. Ghi receipt **MỚI**: `coordination/reports/register-delta-verify-2026-10-04.md`.

## Constraints

- READ-ONLY; không sửa plan/docs; không tick; không commit/push.
