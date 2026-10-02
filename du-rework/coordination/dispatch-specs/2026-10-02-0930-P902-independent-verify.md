# SPEC — P9-02 independent verification (Tester packet)

## Mục tiêu

Verify độc lập receipt P9-02 (`qwen-p9-02-lc-checker-2026-10-02.md`, gồm §10
amendment): chạy lại suites `businesses/lc-checker` offline, kiểm chứng các
claim (identity guard trên raw record, terminal SUCCEEDED/FAILED only,
mount chưa done, 104/118 tests exit 0).

## Được phép

- Đọc `businesses/lc-checker/**` + receipt P9-02 (read-only với source).
- Chạy test offline trong scope lane: `npx jest` trong `businesses/lc-checker`,
  `npx tsc --noEmit` nếu cần. Không dùng shared DB/Redis/S3; nếu test đụng
  infra thì ghi NOT-RUN + lý do thay vì bỏ qua im lặng.

## Cấm

- KHÔNG sửa source của lane khác; test đỏ thì báo nguyên văn, KHÔNG sửa
  production signal để test pass.
- KHÔNG tick P9-02 `[ ]` (chỉ reviewer + product tick sau khi VERIFIED).
- KHÔNG commit thay đổi lane khác. Không nhắn `nocobase-10`.

## Acceptance

Receipt → `coordination/reports/tester-p9-02-verify-2026-10-02.md`:

1. Lệnh chạy + exit code + counts (suites/tests/passed/failed) nguyên văn.
2. Đối chiếu từng claim P9-02 (§5 defects A+B, §7 F1–F7, §9 escalate, §10
   ruling): CONFIRMED / REFUTED / UNCONFIRMED kèm evidence.
3. Verdict cuối: VERIFIED=Yes hoặc No + blocker cụ thể nếu No.
