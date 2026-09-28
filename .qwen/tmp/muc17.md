
---

## 17 — CYCLE 17: ENC-META-01 (control-plane metadata crypto — task_9997ff605662, ctx_3bee5d801816)

#### Scope as dispatched
- Owner: Qwen-Platform (Antigravity dispatch ctx_3bee5d801816).
- Allowed write: `src/modules/runtime/**`, `tests/runtime-encryption-metadata.test.ts`,
  `packages/contracts/src/encryption.ts`. NOT written: packages/contracts (no change
  needed — see Δ40), no other service, no migration, no commit/push, no live window.

#### Inventory — which control-plane columns carry tenant data
| slot | written at | read at |
|---|---|---|
| operations.input_ref | (submit, out of this packet) | runtime.ts:1554 buildClaimResult |
| tasks.payload_ref | :802 child insert, :840 parent continuation, :1087 resume input, :1467 join merge | :1569 buildClaimResult |
| human_waits.response_ref | :1060 resumeOperation | (admin resume read, out of scope) |
| step_checkpoints.output_ref | :450 saveStep | :1525 buildClaimResult |
- Idempotency read (not a slot, but must open before hashing): :731 spawnChildren
  existing-children replay. See the bug I introduced and fixed below.

#### Change
- NEW `src/modules/runtime/metadata-crypto.ts` (324 lines, sha aa200211). One
  authenticated envelope per control-plane value: AES-256-GCM over canonical JSON,
  a FRESH DEK per value wrapped through the ENC-02 Vault Transit provider, and an
  AAD that binds (tenantId, slot, refId).
- `runtime.ts`: optional 3rd param `metadataCrypto` on `createRuntimeService`
  (signature stays 1-arg compatible — 20+ existing callers untouched, proven by the
  regression run below), 2 helpers, 9 call sites, and 3 SELECTs that had to project
  `o.tenant_id` (spawnChildren, saveStep, reconcileParentJoin) because the AAD needs
  it and the original projection did not carry it.
- NEW `tests/runtime-encryption-metadata.test.ts` (278 lines, 23 tests, sha 29d3c225).

#### The two semantic breaks I had to fix in my own patch
Both were silent-wrong, not compile-error; both would have shipped as a green suite:
1. `spawnChildren` idempotency hashed the stored `payload_ref`. Once the column is
   sealed that compares a CIPHERTEXT hash to a PLAINTEXT digest, so every legitimate
   retry would have 409 INPUT_HASH_MISMATCH. Fixed by opening the stored value first
   (:731). Pinned by a test that asserts hashing the raw column does NOT match.
2. `buildClaimResult` passed `checkpointRefs[].outputRef` straight through. The
   contract declares a string, and a sealed value is an object — the claim snapshot
   would have failed its own schema. Fixed by opening per checkpoint under
   (tenant, slot, taskId:stepKey) (:1525).

#### Verify (offline, literal exit codes)
- `pnpm --filter @du/orchestrator exec tsc --noEmit` — Exit Code: 0 (log empty),
  re-run after every hunk; 2 intermediate failures fixed (ActiveLeaseRow.tenant_id,
  then the `string | undefined` AAD arg).
- New suite x3 consecutive: Tests: 23 passed, 23 total — Exit Code: 0, 0, 0.
- Regression, 4 existing runtime suites (mm10 claim-cancel, br08 cancel-resume,
  br12 isolation, mm05 queue-integrity): Tests: 44 passed, 44 total — Exit Code: 0.
  This is the evidence that the optional param really is backward compatible.
- M1 mutation (kill the AAD binding, replace deriveAad input with a constant):
  4 failed / 19 passed — exactly the 4 binding negatives (cross-tenant, cross-slot,
  cross-row, readStored-on-sealed) went red and nothing else did. Restored
  byte-identical: sha aa200211, 12142 bytes, MUTATION_LEFT=false, 23/23 green again.
- Full offline unit suite: Test Suites: 1 failed, 1 skipped, 80 passed, 81 of 82
  total; Tests: 1 failed, 28 skipped, 1877 passed, 1906 total — Exit Code: 1.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ36 — PACKET CLAIM BÁC BỎ bằng lệnh thật, lặp lại sau W-ENC-01-SCHEMA:
  `task_9997ff605662` yêu cầu "submit lưu encrypted ref/ciphertext TRƯỚC
  transaction". Không làm được trong write scope: `operations.input_ref` được ghi
  ở `src/modules/operations/submission.ts`, ngoài `src/modules/runtime/**`. Đây là
  điểm đầu tiên của danh sách packet nói "no plaintext trong input_ref" — gap thật.
  Cần packet riêng (hoặc mở rộng scope) cho submission.ts. Gateway upload (ENC-05)
  là packet khác, không gộp.
- Δ37 — `metadataCrypto` là tham số OPTIONAL nên production wiring nằm ngoài scope
  này: chưa có chỗ nào trong repo gọi `createRuntimeService(db, queue, crypto)`.
  Tới khi wiring được, cột control-plane VẪN plaintext trong mọi deployment. Đây là
  khoảng trống thật, không phải chi tiết hình thức — ENC-META-01 chưa đóng.
- Δ38 — chưa đổi `packages/contracts/src/encryption.ts` (nằm trong write scope nhưng
  không cần): envelope control-plane đã có shape riêng, version riêng, và mang
  `WrappedDek` của ENC-02. Thêm nó vào contracts bây giờ sẽ đóng băng một shape mà
  ADR-18 vẫn chưa freeze (open item 2: AAD + manifest + test vector) — hoàn toàn
  trái lý do ENC-01 được phép chạy trước. Đề xuất: đợi ENC-00 sign-off rồi mới
  đưa sang contracts trong một packet riêng.
- Δ39 — COLUMN DUY NHẤT ngoài packet: `outbox.payload`. Task dispatch/continuation
  hiện mang taskId/operationId/businessId/correlationId/kind (định danh kiểm soát,
  không phải nội dung tenant). Packet yêu cầu "outbox/queue không plaintext", tôi
  KHÔNG seal vì (a) dispatcher/SDK đọc trực tiếp, seal sẽ phá wire, (b) không có
  nội dung nhạy cảm để lo. Nếu coordinator muốn seal outbox thì cần một packet
  riêng có dispatcher trong scope.

#### Collateral đỏ KHÔNG thuộc cycle này (không sửa, đúng quy tắc lane)
- `tests/admin-operations-list-pagination.test.ts:406` "list table is wrapped by the
  shell reflow scroller" — đỏ ở cô lập (1 failed / 88 passed), xác định bằng mtime:
  điểm đỏ nằm ở `src/app/admin/shell-render.ts:509` (mtime 14:43Z) và
  `shell-router.ts` (16:00Z), tức Admin lane đang sửa admin shell SONG SONG; file
  của cycle này là `runtime/*` (17:06Z, 17:21Z). Không chạm file lane khác.

#### Tự phân loại 4 tầng
- SPECIFIED: inventory + 4 slot + semantics-preservation rõ ràng; yêu cầu "submit
  lưu ciphertext" vượt write scope (Δ36).
- IMPLEMENTED: 1 module mới + 9 call site + 3 projection + 23 test.
- VERIFIED (offline): tsc 0; 23/23 x3 Exit 0; collateral 44/44 Exit 0; M1 đỏ đúng
  4 binding test rồi restore byte-exact; full 1877/1906 với 1 đỏ ngoại lai.
- ACCEPTED: không thuộc quyền lane. ENC-META-01 [~] — chưa đóng vì Δ36 (submit-side
  input_ref) và Δ37 (production wiring) còn mở. ENC-INT-01 vẫn cần byte scan thật
  trên S3/PG/Redis/log; test offline chỉ chứng minh shape + binding.
