# Dispatch Spec: MDB-POLICY-02 — Profile Policy Implementation

- Date: 2026-10-10
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Qwen-C (`term_c89675a0-351a-47cc-8c4d-21fb29d5d41a`)
- Repo scope: `du-rework` (khong dung legacy root, khong dung live DB/Redis/S3)
- Canonical plan: `du-rework/coordination/PLAN-OPEN-2026-10-09.md` §9.2 / §9.3 (hang 5) + `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7
- Status: DISPATCHED
- Lease:
  - `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (phần `resolveProfileName` va `normalizeConnectionsOverride`)
  - `orchestrator/services/orchestrator/tests/mdb-policy-02-profiles.test.cjs` (test offline moi)
  - `du-rework/coordination/reports/receipt-mdb-policy-02-profiles-2026-10-10.md` (receipt)

---

## 1. Boi Canh va Hop Dong

Trong `ldba-03-backfill.cjs:580-649` (`mapProfile`), qua trinh di tru profile can 2 callback tu context provider:
1. `resolveProfileName(row)`:
   - Input: row `ProfileEndpoint` tu legacy DB (`endpointSlug`, `businessId`, `apiKeyId`, etc.).
   - Output: chuoi string non-empty bieu thi ten profile trong rework catalog (`profile_names.profile_name`).
   - Contract tu backfill (`:584-593`): Neu khong tra ve chuoi hop le, backfill nem fail `INVALID_PROFILE_NAME`.
   - Logic chuan: neu co mapping tu business/action hoac format slug sach se `Imported <action>` hoac format slug on dinh tu `endpointSlug`.
2. `normalizeConnectionsOverride(overrideRaw)`:
   - Input: JSON parsed tu cột `connectionsOverride` (co the la null, object, hoac array cac buoc noi ket noi).
   - Output: mang Array chua danh sach connection steps (`Array.isArray(connectionsOverride)` phai tra true theo `:596-599`).
   - Contract: Neu `overrideRaw` la null/empty thi tra ve mang rong `[]`. Neu la array thi validate/normalize cac step. Neu la object legacy wrapper thi extract array steps hop le.

Ràng buộc bảo mật va tinh toàn vẹn:
- Khong lam hong ham `prepareConnector` da hoan thanh boi MDB-POLICY-01.
- 5 callback con lai (`prepareWorkflowSchema`, `readFileCacheBytes`, `artifactTokenFor`, `artifactPurposeFor`, `prepareAdminLocalUser`) phai giu nguyen fail-closed.
- Export Object.freeze day du ca 8 callback.

## 2. Cong Viec Can Lam Cho Qwen-C

1. Cap nhat `scripts/ldba-context-provider.cjs`:
   - Thay the stub `requireApprovedPolicy('resolveProfileName')` bang implement policy that.
   - Thay the stub `requireApprovedPolicy('normalizeConnectionsOverride')` bang implement normalizer that (luon tra array, an toan voi null/undefined/malformed input).
2. Viet test offline day du tai `tests/mdb-policy-02-profiles.test.cjs`:
   - Happy path cho `resolveProfileName` voi cac dong legacy hop le.
   - Negative controls cho `resolveProfileName` (row rong, slug null, etc.).
   - Happy path cho `normalizeConnectionsOverride` voi null, `[]`, valid steps array.
   - Negative controls/fallback cho malformed override JSON.
   - Regression guards: `prepareConnector` van hoat dong, 5 callback con lai van fail-closed.
3. Chay test offline pass va typecheck pass.
4. Nop receipt tai `du-rework/coordination/reports/receipt-mdb-policy-02-profiles-2026-10-10.md`.

## 3. Rang Buoc
- KHONG git add, commit, push.
- KHONG dung ky tu nhay kep trong prompt hoac khi gui lenh qua orca.
- KHONG mo cua so live DB/Redis.
