# FU-ENCMETA-ADMIN (qwen_2) — admin operation-detail result projection — 2026-10-05

**Nguon:** finding trong `coordination/reports/tester.md` §VFY-ENCMETA-801 (turn 801).
**Lease:** `services/orchestrator/src/modules/operations/mappers.ts` + test moi. **KHONG sua `runtime.ts`.** Offline. Khong commit/push/tick.

## 1. Defect (owner finding, da dung)

Admin-bearer `GET /api/v1/operations/:id` -> `buildAdminOperationDetail` (`http/routes/public.ts:455`) copy thang `op.result_ref` vao `result.data.resultRef` (`mappers.ts:88`) ma **khong goi `readStoredText`**. `getOperation` la `SELECT *` (`runtime.ts:1656-1659`) nen gia tri toi la **envelope da seal** khi metadata seam bat — response tra envelope thay vi opaque pointer, lech voi R1 `/result` (`public.ts:531-546`) da dung.

## 2. Fix (chi 1 file, trong lease)

`services/orchestrator/src/modules/operations/mappers.ts`:
- them `import { readStoredText }` + `type { MetadataCrypto }` tu `../runtime/metadata-crypto`.
- them `metadataCrypto?: MetadataCrypto | null` vao `AdminOperationDetailContext` (optional -> additive).
- projection gio mo envelope voi **dung slot/tenant/id triple cua R1**: `readStoredText(ctx.metadataCrypto ?? undefined, String(op.result_ref), { tenantId: String(op.tenant_id), slot: 'operations.result_ref', refId: String(op.id) }, true)`.
- **Route KHONG doi**: `public.ts:455` da truyen ctx day du (co san `metadataCrypto`, dung o `:539`) nen context moi structural-compat. Da kiem bang tsc.

## 3. Test (moi, offline)

`services/orchestrator/tests/fu-encmeta-admin-projection.test.ts` — 5 test:
1. seam ON + sealed envelope -> tra **opaque pointer da mo**, va response **khong chua** `__sealed`.
2. seam OFF -> gia tri plaintext cu **nguyen ven** (backfill-window convention).
3. seam ON + legacy plaintext row -> van nguyen ven (allowPlaintext window).
4. non-terminal -> `result` = null.
5. `result_ref` null -> `data` = `{}`.

**Seam la fake trung thuc** tren dung 2 thanh vien ma `readStoredText` goi (`isSealed` roi `readStored`) — assertion kiem duoc **duong code cua mapper** (slot/tenant/refId/projection), khong kiem lai crypto (da duoc suite RESULTREF chung minh).

## 4. Bang chung (literal Exit Codes)

- Focused x3 (`fu-encmeta-admin-projection` + `encmeta-resultref-offline` + `enc-meta-sentinel-runtime-refs`): `Test Suites: 3 passed` / `Tests: 21 passed` — **Exit Code: 0** ca 3 lan.
- `tsc --noEmit -p tsconfig.json` — **Exit Code: 0**.
- **MUTATION PROBE (load-bearing):** tam thoi tra lai ban copy-thang cu -> test **FAIL dung 1 case**, `Expected: "opaque-result-ref-abc123"` / `Received: "{\"__sealed\":1,\"__plaintext\":\"opaque-result-ref-abc123\"}"` — chinh la envelope lo ra. Re-apply fix -> 5/5 xanh. Test khong pass vi ly do sai.

## 5. Δ / gioi han

- **Khong co Δ lease**: route khong can doi; `runtime.ts` khong bi cham.
- **A3 window-switch van mo** (khong thuoc slice nay): `readStoredText(..., true)` giu nguyen backfill-window convention; viec dong so phai doi `runtime.ts` (lease A2 cua Luna).
- Fake seam chi bao dam duong projection; envelope that + key provider that van thuoc leg live/crypto.

## 6. File da ghi

`services/orchestrator/src/modules/operations/mappers.ts`, `services/orchestrator/tests/fu-encmeta-admin-projection.test.ts`, receipt nay.
