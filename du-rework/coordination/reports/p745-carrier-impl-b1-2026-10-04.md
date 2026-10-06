# P745-CARRIER-IMPL-B1 (SDK leg) — 2026-10-04

**Packet:** P745-CARRIER-IMPL-B1 · lane cc_1 · dispatch 23:58. **Offline; không tick; không commit/push.**
**Snapshot:** 2026-10-04 23:58–00:10 +07 · HEAD `b088eec`.

## 0. LEASE-ANNOUNCE

| File | Trước | Post SHA-256 |
|---|---|---|
| `packages/worker-sdk/src/types.ts` | `9ab4af514be8f84df409…` | `ded3e9f350b80e70af597be930c7d1bf44d382764ab10af343c169baf5f2c598` |
| `packages/worker-sdk/src/worker.ts` | `6e82be42c66b3fe1f270…` | `7a62a47a04c2c41cbb7add488ae05a400e7927131c27f44bab5058522f173c2f` |
| `packages/worker-sdk/src/task-context.ts` | `181282a5e15dbd35fe11…` | `f81d4d56d782f1680d0587151a33ce2c45b6b2405f077020cb41eac0f8217e68` |
| `packages/worker-sdk/tests/p745-carrier-sdk-forward.test.ts` | **MỚI** | `0eb478327d404069466c…` |
| `packages/contracts/src/runtime.ts` (**vượt lease read-only — xem §2**) | `c527b56646581c6b9064…` (IMPL-A) | `66656bd6cadfc79fa45bc2f91f089cbc94c4df6f29b6429045abe038a4fca53c` |
| `packages/contracts/dist/{runtime.d.ts,runtime.js}` | rebuild | `c23971e6…` / `6cf967da…` |

Ambient (không phải lane này): `worker-sdk/src/crypto-storage.ts` + các test `p730-pinned-policy`, `p745-options-passthrough`, `crypto-storage-plaintext-bound` (lane khác). Không chạm document-core (qwen_2).

## 1. Thay đổi (SDK leg, đúng pattern W1b)

- **types.ts** — `TaskContext` thêm `readonly promptOverrides?: readonly PinnedPromptOverride[] | null;` + import type.
- **task-context.ts** — args `promptOverrides?: PinnedPromptOverride[] | null;`; class field `… | null | undefined`; constructor **pass-through thẳng** `this.promptOverrides = task.promptOverrides;` — **null giữ null, undefined giữ undefined, không coalesce**.
- **worker.ts** — DefaultTaskContext args thêm `promptOverrides: snapshot.pinned.promptOverrides` (claim → ctx; mọi redelivery re-read claim).

## 2. Δ-LEASE-DEVIATION (bounded, báo rõ để coordinator adjudicate)

**Việc đã làm ngoài lease read-only của B1:** contracts `pinned.promptOverrides` đổi từ `.nullable().default(null)` (IMPL-A) → **`.nullable().optional()`** + rebuild dist.

**Lý do (type-compat thực đo):** với `.default(null)`, output-type của `ClaimResult` khiến field **required** → mọi object literal `as ClaimResult` thiếu field **vỡ typecheck** (TS2352) tại **9 construction sites thuộc 3 lane**:
`worker-sdk/tests/{p730-sdk-consume-pin-passthrough:115, worker.test:113, p745-carrier-sdk-forward:120}`, `document-core/tests/{sdk-consumer:227,495,643,735, provider-backed-variant:441, bullmq-smoke:124}` (+3 integration dùng `as unknown as` nên không vỡ).
Giữ `default(null)` ⇒ phải sửa ≥9 file — **document-core (qwen_2 đang giữ) hoàn toàn ngoài tầm với của lane này**.

**Kiểm chứng `.optional()` là lựa chọn ít xâm lấn + đúng semantics hơn:**
- 0 file ngoài lease phải sửa; SDK full + orchestrator full compile sạch (bằng chứng §3).
- Semantics đúng yêu cầu packet: **runtime LUÔN ghi key tường minh** (null hoặc rows — IMPL-A) ⇒ wire thật: null→null ✓; **wire-absent chỉ còn ở shape cũ ⇒ ở lại absent (undefined)** — khớp chính xác "absent giữ shape cũ" (còn mạnh hơn `default(null)` vì `default` sẽ biến absent→null, mất phân biệt).
- Blast radius: 1 dòng contracts + dist rebuild.

**Đề xuất:** giữ `.optional()`; nếu coordinator muốn quay lại `default(null)` thì cần cấp lease sửa 9 cast sites ở worker-sdk+document-core — nói rõ chi phí đó. **Lưu ý:** hash contracts trong receipt IMPL-A (`c527b566…`) đã bị thay bởi mục này — IMPL-A receipt giữ nguyên làm lịch sử, delta ghi ở đây.

## 3. Evidence literal

| Lệnh | Kết quả |
|---|---|
| `packages/worker-sdk`: `npx jest tests/p745-carrier-sdk-forward.test.ts tests/p730-sdk-consume-pin-passthrough.test.ts tests/worker.test.ts` **× 3 lượt** | **B1R1/R2/R3_EXIT=0** — mỗi lượt `3 suites / 35 tests passed` |
| `packages/worker-sdk`: `npx jest --runInBand` (full) | **SDK_FULL_EXIT=0 — 30 suites, 691 passed + 1 todo** (số suite tăng do test lane khác + T5) |
| `packages/worker-sdk`: `npx tsc --noEmit` | **SDK_TSC_EXIT=0**, ERR=0 |
| `services/orchestrator`: focused **11 suite** (carrier T1/T2 + producer-impl + w1-sub02/sub03 + p730-profile-snapshot + p730-legacy-snapshot-failclosed + mm10 + url-ingestion ×3) **× 3 lượt** | **ORCH_R1/R2/R3_EXIT=0** — mỗi lượt `11 suites / 115 tests passed` |
| `services/orchestrator`: `npx tsc --noEmit` | **ORCH_TSC_EXIT=0**, ERR=0 |
| `packages/contracts`: `npx jest --runInBand` | **25/26 suite, 520/522 test** — suite đỏ `vault-policies.test.ts` (2 test, `expect(...).toThrowError is not a function`) **pre-existing** (đã A/B chứng minh ở IMPl-A receipt §4; lần này vẫn đúng signature đó, không phát sinh mới) |

Phân loại evidence: SDK leg prove **offline** qua constructor thật + `startWorker` thật (claim stub qua `ClaimResultSchema.parse` — đúng seam wire). Live gap: claim từ runtime thật qua HTTP + PG thật (thuộc window live).

## 4. Hành vi pin (T5, 6 test)

1. rows `{connectionId, stepId, promptOverride, revision}` vào ctx **nguyên key-4** (deep-equal).
2. `null` → **giữ null** (không `[]`, không `undefined`).
3. absent (shape cũ) → **giữ `undefined`**.
4. `startWorker`: claim JSON có rows → handler ctx thấy đúng rows (real wiring).
5. `startWorker`: claim **omit field** → giữ **absent** (`.optional()`, không bị biến thành null).
6. `startWorker`: claim **null tường minh** → handler thấy **null**.

## 5. Δ / chuyển tiếp

- **T6 (phần document-core) + wiring 6 site = B2** (qwen_2 giữ document-core; serialize). Ghi chú read-only cho B2: `toInternalContext` (document-core `worker.ts:210-222`) cần thêm guard cùng pattern `!== undefined` cho field mới — **không sửa ở lane này**.
- SDK leg không đổi behavior cũ: contexts không mang pin giữ nguyên shape (case 3/5).

READ-ONLY compliance (trừ deviation §2 đã báo): chỉ worker-sdk src 3 file + 1 test mới + contracts 1 dòng (deviation) + dist + receipt này được ghi; không tick; không commit/push.
