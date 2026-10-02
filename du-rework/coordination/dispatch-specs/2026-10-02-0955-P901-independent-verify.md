# SPEC — P9-01 independent verification (Tester packet)

## Mục tiêu

Verify độc lập receipt P9-01 (`codex-p9-01-disbursement-2026-10-01.md` + follow-up
08:43): business logic green offline + registration test, PARTIAL trung thực
(2 failures mới trong `manifest.test.ts` hiện hữu, NOT wired to platform).

## Được phép

- Đọc `businesses/document-core/src/pipelines/workflows/disbursement/**` +
  receipt P9-01 (read-only với source).
- Chạy offline trong `businesses/document-core`:
  `npx jest --runInBand --runTestsByPath tests/p9-01-disbursement.test.ts tests/p9-01-disbursement-registration.test.ts`
  (45 + 4 tests theo receipt) + `npx tsc --noEmit -p tsconfig.json`
  (và `tsconfig.test.json` nếu có). Không dùng shared DB/Redis/S3.

## Cấm

- KHÔNG sửa source/test của lane khác; test đỏ báo nguyên văn.
- KHÔNG tick P9-01. KHÔNG commit thay đổi lane khác. Không nhắn `nocobase-10`.

## Acceptance

Receipt → `coordination/reports/tester-p9-01-verify-2026-10-02.md`:

1. Lệnh chạy + exit code + counts nguyên văn (kỳ vọng 49 pass nếu đúng receipt).
2. Đối chiếu claim: continuation set (spawn-children/wait-for-input/terminate),
   bounded fan-out, approval gate, NOT wired (0 dispatch trong worker.ts/main.ts/
   server.ts), PARTIAL item 3 (manifest.test.ts hiện hữu — pass/fail thế nào
   trên build hiện tại).
3. Verdict: VERIFIED=Yes/No + blocker cụ thể nếu No.
