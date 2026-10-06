# Dispatch spec — verify Phase 1 Profiles (T-DB/T-PROF/T-DOC) (2026-10-04 15:12 +07)

## Mục tiêu

READ-ONLY verify `reports/profile-parity-phase1-2026-10-04.md` (lane Claude) — không sửa source/test/plan; chỉ receipt + script tạm (xoá sau). Migrations 0026/0027 **đã verify riêng** (`migrations-0026-0027-verify-2026-10-04.md`) — packet này tập trung **contracts + openapi + receipt conformance**.

## Việc cần làm

1. **Re-derive**: `cd packages/contracts && npx jest --runInBand tests/profile-policy.test.ts` (kỳ vọng 27); `tsc` contracts + orchestrator; openapi parse + `$ref` (kỳ vọng 0 unresolved, 26 schemas, 45 paths, 10 `x-absent`); nhắc lại context: `vault-policies.test.ts` 2 fail **pre-existing** (không tính lane).
2. **Adversarial ≥6 (script/test tạm tự viết, không copy)**:
   - cipher regex: uppercase hex → reject; sai độ dài IV(24)/tag(32); ciphertext rỗng; đúng → accept;
   - **`PROFILE_JOB_PRIORITY_WEIGHTS` + mapping queue vs legacy thật** — đối chiếu nguồn legacy (`lib/**` chỗ `20/10/1`) và nêu kết luận (khớp/lệch) — đây là điểm dễ sai chiều;
   - params: `profile.publish` thiếu `expectedRevision` → fail; `rollback` thiếu `targetRevision` → fail; `upsert` với `policy = {}` → pass; `policy` unknown key → fail (strict);
   - key-4: `stepId` default `'_default'` trong schema khớp DB (0026);
   - `parseAllowedFileExtensions`: giữ thứ tự/case/trùng, bỏ rỗng;
   - strictness: read schema vs write schema (`fileUrlAuthConfigured` vs `fileUrlAuthConfig`).
3. **Lease check**: `git status` — thay đổi của lane chỉ gồm 5 file receipt §1 (+ migrations đã biết; `0025` không phải của lane, `src/**` không bị chạm).
4. **Receipt conformance**: spot-check `file:line` các claim chính (§5.2 exports, §7 wire items, §8 openapi).

## Verdict

- `VERIFIED` / `CHANGES_REQUIRED` + finding `file:line`; nêu rõ phần không đo được.

## Deliverable

- Receipt: `coordination/reports/profile-phase1-verify-2026-10-04.md`.

## Lane

- **cc_2** — `term_5f7e42da-6790-4449-8539-746626c5d078`. Dispatch 2026-10-04 15:12.
