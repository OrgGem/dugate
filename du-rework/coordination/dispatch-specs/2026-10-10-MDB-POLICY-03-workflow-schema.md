# Dispatch Spec: MDB-POLICY-03 — Workflow Schema Policy Implementation

- Date: 2026-10-10
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Qwen-A (`term_25de3310-c775-4703-86f1-5462afee63df`)
- Repo scope: `du-rework` (khong dung legacy root lam pham vi sua, khong dung live DB/Redis/S3)
- Canonical plan: `du-rework/coordination/PLAN-OPEN-2026-10-09.md` §9.2 / §9.3 (hang 5) + `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7
- Status: DISPATCHED
- Lease:
  - `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (phần `prepareWorkflowSchema`)
  - `orchestrator/services/orchestrator/tests/mdb-policy-03-workflow-schema.test.cjs` (test offline moi)
  - `du-rework/coordination/reports/receipt-mdb-policy-03-workflow-schema-2026-10-10.md` (receipt)

---

## 1. Boi Canh va Hop Dong Backfill

Trong `scripts/ldba-03-backfill.cjs:658-687` (`mapWorkflowSetting`), callback `prepareWorkflowSchema` duoc goi voi chu ky:
```javascript
const prepared = await context.prepareWorkflowSchema(parsed, {
  slug,
  tenantId,
  revision: 1,
});
```

Ràng buộc nghiêm ngặt từ backfill runner (`:669-676`):
1. `prepared` phai la plain object (`isPlainObject(prepared)`).
2. `prepared.digest` phai la chuoi hop le theo regex `/^sha256:[0-9a-f]{64}$/`.
3. `prepared.schemaRef` phai la plain object.
4. Neu tra ve `{ skipped: true, reason: '<non-empty string>' }`, backfill runner se ghi nhan bo qua mot cach an toan.

Tham chieu nghiep vu LDBA-06 da co san trong codebase:
- `orchestrator/services/orchestrator/src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter.ts`
- Cung cap cac tieu chuan ve SHA256 digest va canonical JSON representation.

Bảo toàn tính toàn vẹn:
- Giu nguyen `prepareConnector` (da xong o MDB-POLICY-01).
- Giu nguyen `resolveProfileName` va `normalizeConnectionsOverride` (da xong o MDB-POLICY-02).
- 4 callback con lai (`readFileCacheBytes`, `artifactTokenFor`, `artifactPurposeFor`, `prepareAdminLocalUser`) phai duy tri fail-closed.
- Khong them bat ky external dependency nao vao file `.cjs`.

## 2. Cong Viec Can Lam Cho Qwen-A

1. Cap nhat `scripts/ldba-context-provider.cjs`:
   - Thay the stub `requireApprovedPolicy('prepareWorkflowSchema')` bang implement policy that.
   - Thuc hien validate parsed schema, sinh sha256 digest on dinh (`sha256:...`), tra ve envelope `{ digest, schemaRef }`.
   - Neu schema bi loi hoac khong the parse, tra ve `{ skipped: true, reason: '...' }` an toan.
2. Viet test offline day du tai `tests/mdb-policy-03-workflow-schema.test.cjs`:
   - Happy path: schema hop le tra ve digest dung format `sha256:[0-9a-f]{64}` va `schemaRef` hop le.
   - Negative controls: schema malformed hoac null/non-object tra ve skipped hoac xu ly an toan.
   - Regression guards: `prepareConnector`, `resolveProfileName`, `normalizeConnectionsOverride` van hoat dong; 4 callback con lai van fail-closed.
3. Chay test offline pass va typecheck pass.
4. Nop receipt tai `du-rework/coordination/reports/receipt-mdb-policy-03-workflow-schema-2026-10-10.md`.

## 3. Rang Buoc
- KHONG git add, commit, push.
- KHONG dung ky tu nhay kep trong prompt hoac khi gui lenh qua orca.
- KHONG mo cua so live DB/Redis.
