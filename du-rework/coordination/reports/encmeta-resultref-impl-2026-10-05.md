# ENCMETA-RESULTREF-IMPL — seal `tasks.result_ref` + `operations.result_ref` (Option A) — 2026-10-05

**Packet:** ENCMETA-RESULTREF-IMPL (prep `encmeta-resultref-prep` + adjudication A+C) · lane cc_1 · dispatch 01:23. **Offline; không tick; không commit/push.**
**Snapshot:** 2026-10-05 01:23–02:0x +07 · HEAD `b088eec`.

## 0. Write set + pin (post)

| File | Trạng thái | SHA-256 |
|---|---|---|
| `src/modules/runtime/metadata-crypto.ts` | +2 slots + `readStoredText` | `3e6ee2a76c8d682e40f…` |
| `src/modules/runtime/runtime.ts` | writer seal ×2 + R2/R3 open | `01ffff43cfd528e029c5…` |
| `src/http/route-context.ts` | +`metadataCrypto?` (seam cho route) | `ee3997d4d339d2b3261e…` |
| `src/http/routes/public.ts` | R1 open (giữ verbatim shape) | `5a6f9972c8299ebc655a…` |
| `src/app/bootstrap/create-app.ts` | pass `metadataCrypto` vào route ctx | `ae7e29ce64ed558c022b…` |
| `tests/enc-meta-sentinel-runtime-refs.test.ts` | **FLIP pin** + mock tenant_id | `bcc081a2e4ba9d7c7dd3…` |
| `tests/encmeta-resultref-offline.functional.test.ts` | **MỚI** (nhóm 2–7) | `c516d4da620f19a209da…` |

**Không cần migration** (cột `result_ref text` đã tồn tại — 0001:48/85). Contracts/submission read-only, không chạm.

**Δ-LEASE (báo rõ):** scope item 2 yêu cầu "OPEN tại read R1" — nhưng lease liệt kê chỉ `modules/runtime + metadata-crypto + migration + tests`. R1 nằm ở `http/routes/public.ts`, và route cần seam ⇒ phải sửa thêm **3 file ngoài danh sách** (`public.ts`, `route-context.ts`, `create-app.ts`). Đã làm **tối thiểu** (1 hunk mỗi file + 1 field); nếu coordinator muốn giữ nguyên lease wording ⇒ đây là Δ cần ratify, code hoàn nguyên được trong 3 hunk.

## 1. Thi hành theo scope

1. **Slots:** `METADATA_SLOTS` + `'tasks.result_ref'`, `'operations.result_ref'` (`metadata-crypto.ts:54-60`); union inline của `sealMetadata`/`openMetadata` trong runtime mở rộng tương ứng.
2. **Writer:** đúng **1 writer** `completeTask` — SELECT thêm `o.tenant_id`; seal **2 lần** cùng giá trị dưới 2 binding khác nhau (refId: taskId vs operationId) **trước cả 2 UPDATE**; cột TEXT ⇒ envelope bind dạng **JSON text** (convention `input_ref`); no-seam → verbatim (window).
3. **Readers:** R2 `getChildren` (+`c.tenant_id`) mở từng ref; **R3 `reconcileParentJoin` mở TẤT CẢ child refs TRƯỚC khi merge** vào parent payload (hazard nesting — comment chặn tại chỗ); R1 `/result` mở rồi chiếu **cùng chuỗi opaque** (shape public không đổi); R4 (SDK fan-out) tiêu thụ chính wire của R2 — server-side mở là đủ, SDK **không đụng** (ngoài lease).
4. **Window policy:** mirror quy ước 5 slot còn lại — `allowPlaintext=true` tại route/readers (ENC-09 backfill window), seam giữ khả năng fail-closed khi `false`. Riêng **text column**: thêm `readStoredText(crypto, value, ctx, allowPlaintext)` — envelope-looking JSON text mở **fail-closed** (`readStored(..., false)`), plaintext (kể cả JSON hợp lệ nhưng không phải envelope) trả verbatim trong window; không seam → verbatim.
5. **FLIP FINDING pin có ý thức:** test 1 của detector đổi từ "verbatim + leak=true" → "SEALED envelope ×2 + leak=false + open round-trip đúng slot"; test RED detector giữ nguyên assertion (nay XANH); mock thêm `tenant_id` (hệ quả của SELECT mới).

## 2. Evidence literal (cwd `services/orchestrator`)

| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit` sau code edits | **ER_TSC1=0**; sau vòng sửa string-text **ER_TSC2=0** (cuối) |
| 2 suite tâm điểm (`encmeta-resultref-offline.functional` 6 + `enc-meta-sentinel-runtime-refs` 4) — lần đầu | 6 failed — **lỗi thật của tôi**: `sealMetadata` trả OBJECT, cột `result_ref` là **text** ⇒ `JSON.parse("[object Object]")` + reader nhận string-envelope như plaintext. Fix: writer stringify khi có seam + `readStoredText` + R1 dùng nó |
| … chốt **× 3 lượt** | **R1/R2/R3=0 — mỗi lượt `2 suites / 10 tests passed`** |
| Regression 6 suite: `runtime-lease-fencing-offline` + `crx01` + `crx02` + `enc-meta-sentinel-outbox-source-url` + `p730-profile-snapshot` + `p730-legacy-snapshot-failclosed` | **REG=0 — 6 suites / 61 tests passed** |
| Runtime split set (`runtime-admin-auth/facade/health/hitl/recovery/version-lifecycle/webhook`) | **RT=0 — 7 suites / 57 tests ALL SKIPPED** (window-gated `DU_LIVE_INFRA`, đúng guard của chúng — không phải fail) |
| `packages/worker-sdk`: full jest | **SDK=0 — 30 suites / 691 passed + 1 todo** (fan-out path không regression) |

## 3. Hành vi được pin (10 test / 2 suite)

- **G1 (detector, flipped):** 2 UPDATE đều là envelope `{version:1, algorithm:'aes-256-gcm'}`; sentinel **không tồn tại** trong cả 2 param; **positive control** mở lại đúng chuỗi gốc dưới đúng slot/refId từng row; RED detector cũ giữ nguyên assertion (nay green); 2 test còn lại (waitInput pin, resume green) **không đổi**.
- **G2 round-trip qua writer thật** (completeTask) cho cả 2 slot; **G3** cross-slot (`tasks↔operations`), cross-tenant, và payload_ref-envelope-as-result_ref ⇒ `CONTEXT_MISMATCH`; **G4** `NOT_SEALED` khi `allowPlaintext:false` + window `true` trả plaintext; **G5 join-summary**: outer payload là envelope, mở ra `joinSummary = {a:'ref-a', b:'ref-b'}` **plaintext**, không chuỗi nào chứa `aes-256-gcm` (nesting regression chặn); **G6/R2** sealed→mở, legacy plaintext→verbatim, null→null; **G6/R1** route `/result`: row sealed → **cùng chuỗi opaque** trên wire; null → `data:{}`; no-seam + plaintext cũ → verbatim (shape public không đổi).

## 4. Δ / chuyển tiếp

- **Δ-LEASE §0** (3 file ngoài danh sách — cần ratify hoặc hoàn nguyên 3 hunk).
- **D5-style note:** R4 (SDK fan-out) không sửa — nó đọc cùng wire đã mở ở R2; parser camel/snake của SDK là pre-existing, không thuộc packet này (không re-verify hành vi parse đó ở đây).
- **Live còn thiếu:** PG thật (row sealed thật + backfill window thật), vault thật, runtime split suites window-gated; không claim live.
- Cập nhật docs/ENC-09 window khi bắt đầu backfill thật = việc của window đó (ngoài scope).
