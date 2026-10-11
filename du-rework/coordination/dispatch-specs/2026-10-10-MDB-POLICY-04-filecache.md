# Dispatch Spec: MDB-POLICY-04 — FileCache & Artifact Policy Implementation

- Date: 2026-10-10
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Qwen-C (`term_c89675a0-351a-47cc-8c4d-21fb29d5d41a`)
- Repo scope: `du-rework` (khong dung legacy root lam pham vi sua, khong dung live DB/Redis/S3)
- Canonical plan: `du-rework/coordination/PLAN-OPEN-2026-10-09.md` §9.2 / §9.3 (hang 5) + `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7
- Status: DISPATCHED
- Lease:
  - `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` (phần `readFileCacheBytes`, `artifactTokenFor`, `artifactPurposeFor`)
  - `orchestrator/services/orchestrator/tests/mdb-policy-04-filecache.test.cjs` (test offline moi)
  - `du-rework/coordination/reports/receipt-mdb-policy-04-filecache-2026-10-10.md` (receipt)

---

## 1. Boi Canh va Hop Dong Backfill

Trong `scripts/ldba-03-backfill.cjs:690-730` (`mapFileCache`), backfill runner can 3 callback tu context provider:
1. `readFileCacheBytes(s3Key)`:
   - Input: `s3Key` string tu dong `FileCache`.
   - Output: `Buffer` hoac `Uint8Array` chua bytes cua artifact.
   - Contract (`:705-707`): Phai tra ve Buffer hoac Uint8Array; neu khong co bytes (vi du offline test stub/mock storage reader), tra ve bytes hoac throw loi hop le co ma `ARTIFACT_READER_REQUIRED`/`INVALID_ARTIFACT_BYTES`. Trong moi truong co cau hinh storage reader/mock directory, doc tu mock store hoac return dummy bytes duoc tinh toan deterministic theo MD5.
2. `artifactTokenFor(row, id)`:
   - Input: row `FileCache`, `id` UUID.
   - Output: chuoi token `string` voi `token.length >= 32` (`:718-720`).
   - Tinh toan deterministic: SHA256 hex digest tu `row.s3Key + ':' + id`.
3. `artifactPurposeFor(row)`:
   - Input: row `FileCache`.
   - Output: mot trong 4 gia tri hop le: `'input' | 'output' | 'intermediate' | 'session'` (`:721-723`).
   - Quy tac suy dien: dua vao loai file hoac metadata (mac dinh `'output'` hoac `'input'` theo format s3Key, vi du chua 'upload' -> 'input', con lai -> 'output').

Bảo toàn tính toàn vẹn:
- Giu nguyen `prepareConnector` (MDB-POLICY-01), `resolveProfileName` + `normalizeConnectionsOverride` (MDB-POLICY-02), `prepareWorkflowSchema` (MDB-POLICY-03).
- Chi duy nhat `prepareAdminLocalUser` con lai duy tri fail-closed voi `PASSWORD_RESET_REQUIRED`.
- Khong them bat ky external dependency nao vao file `.cjs`.

## 2. Cong Viec Can Lam Cho Qwen-C

1. Cap nhat `scripts/ldba-context-provider.cjs`:
   - Thay the stub `requireApprovedPolicy('readFileCacheBytes')`, `requireApprovedPolicy('artifactTokenFor')`, `requireApprovedPolicy('artifactPurposeFor')` bang policy that.
2. Viet test offline day du tai `tests/mdb-policy-04-filecache.test.cjs`:
   - Happy path: `artifactTokenFor` tra ve string >= 32 ky tu, deterministic.
   - Happy path: `artifactPurposeFor` tra ve dung tap hop `['input', 'output', 'intermediate', 'session']`.
   - Happy path: `readFileCacheBytes` tra ve Buffer / Uint8Array.
   - Regression guards: 4 policy da land giu nguyen hoat dong; `prepareAdminLocalUser` van ném `PASSWORD_RESET_REQUIRED`.
3. Chay test offline pass va typecheck pass.
4. Nop receipt tai `du-rework/coordination/reports/receipt-mdb-policy-04-filecache-2026-10-10.md`.

## 3. Rang Buoc
- KHONG git add, commit, push.
- KHONG dung ky tu nhay kep trong prompt hoac khi gui lenh qua orca.
- KHONG mo cua so live DB/Redis.
