# SPEC — VFY-REG offline wave: document-core + Worker SDK suites

## Mục tiêu

Mở wave VFY-REG (`tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md`, row
`VFY-REG [ ]`): chạy full suites `businesses/document-core` và
`packages/worker-sdk` trên build hiện tại, báo cáo trung thực exit/counts,
liệt kê red tests mà KHÔNG sửa chúng.

## Được phép

- Chạy `npx jest --runInBand` + `npx tsc --noEmit -p tsconfig.json` (và
  `tsconfig.test.json` nếu có) trong `businesses/document-core` và
  `packages/worker-sdk`.
- Nếu suite đụng DB/Redis: dùng namespace cô lập per-lane (DB/schema riêng +
  Redis prefix/DB riêng + S3 prefix riêng, theo DEV TEST ISOLATION) thay vì
  bỏ qua; không chạm shared/dev chung.

## Cấm

- KHÔNG sửa source hay test của lane khác để test pass (test đỏ không được
  sửa bằng cách bỏ production signal).
- KHÔNG tick `VFY-REG [ ]`. KHÔNG commit thay đổi lane khác.
- Không nhắn `nocobase-10`. Không đọc giá trị secret.

## Acceptance

Receipt → `coordination/reports/tester-vfy-reg-offline-2026-10-02.md`:

1. Raw output tóm tắt: từng package — suites passed/failed/total,
   tests passed/failed/skipped, exit code, build digest ngắn.
2. Danh sách red tests (file:line + lỗi ngắn) — phân loại pre-existing
   (baseline đã biết: bullmq-smoke, all-variants-e2e, corpus-regression,
   manifest.test.ts sau P9-01) vs mới.
3. Verdict: wave offline PASS/FAIL + điều kiện còn thiếu cho live VFY-REG
   (CLAIM/RELEASE DB window, build digest) — liệt kê, không tự mở.
