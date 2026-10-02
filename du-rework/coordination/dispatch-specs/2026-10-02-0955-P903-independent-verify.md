# SPEC — P9-03 independent verification (Tester packet)

## Mục tiêu

Verify độc lập receipt P9-03
(`codex-p9-03-doc-compare-2026-10-01.md`): module doc-compare bounded multi-step,
offline-verified, NOT mounted/NOT registered — kiểm chứng các claim.

## Được phép

- Đọc `businesses/document-core/src/pipelines/workflows/doc-compare/**` +
  receipt P9-03 (read-only với source).
- Chạy offline trong `businesses/document-core`:
  `npx jest --runInBand --runTestsByPath tests/p9-03-doc-compare.test.ts`
  (33 tests theo receipt) + `npx tsc --noEmit -p tsconfig.json`
  (và `tsconfig.test.json` nếu có). Không dùng shared DB/Redis/S3; đụng infra
  thì ghi NOT-RUN + lý do.

## Cấm

- KHÔNG sửa source/test của lane khác; test đỏ báo nguyên văn, KHÔNG sửa
  production signal để test pass.
- KHÔNG tick P9-03. KHÔNG commit thay đổi lane khác. Không nhắn `nocobase-10`.

## Acceptance

Receipt → `coordination/reports/tester-p9-03-verify-2026-10-02.md`:

1. Lệnh chạy + exit code + counts nguyên văn.
2. Đối chiếu claim: bounded chunks (không gửi whole document), 4 stages +
   typed state, evidence `evidenceChunkIds`, exactly-two-sides (từ chối file
   thứ 3 — deliberate divergence), không field `confidence`, NOT mounted /
   NOT registered (0 wiring trong server.ts/registry).
3. Verdict: VERIFIED=Yes/No + blocker cụ thể nếu No.
