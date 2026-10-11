# Dispatch Spec: MDB-POLICY-05 — Context Provider Guard Alignment & Unified Test Suite

- Date: 2026-10-10
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Qwen-B (`term_bd1937f8-0134-4d02-b511-353625e8a3ae`)
- Repo scope: `du-rework` (khong dung legacy root lam pham vi sua, khong dung live DB/Redis/S3)
- Canonical plan: `du-rework/coordination/PLAN-OPEN-2026-10-09.md` §9.2 / §9.3 (hang 5) + `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` §4.5, §7
- Status: DISPATCHED
- Lease:
  - `orchestrator/services/orchestrator/tests/mdb-policy-01-connector.test.cjs` (cap nhat assertion fail-closed con lai)
  - `orchestrator/services/orchestrator/tests/mdb-policy-02-profiles.test.cjs` (cap nhat assertion fail-closed con lai)
  - `orchestrator/services/orchestrator/tests/mdb-policy-03-workflow-schema.test.cjs` (cap nhat assertion fail-closed con lai)
  - `orchestrator/services/orchestrator/tests/mdb-01-composition-provider.test.ts` (cap nhat contract prepareConnector tra skipped thay vi ném loi)
  - `du-rework/coordination/reports/receipt-mdb-policy-05-alignment-2026-10-10.md` (receipt)

---

## 1. Boi Canh va Nhiem Vu

Cả 4 domain policy đã được hiện thực và kiểm chứng độc lập [PASS]:
1. `prepareConnector` (MDB-POLICY-01)
2. `resolveProfileName`, `normalizeConnectionsOverride` (MDB-POLICY-02)
3. `prepareWorkflowSchema` (MDB-POLICY-03)
4. `readFileCacheBytes`, `artifactTokenFor`, `artifactPurposeFor` (MDB-POLICY-04)

Hệ quả là:
- Duy nhất callback thứ 8 `prepareAdminLocalUser` là còn fail-closed với `PASSWORD_RESET_REQUIRED`.
- Bốn test suite cũ (`mdb-policy-01`, `mdb-policy-02`, `mdb-policy-03` và `mdb-01-composition-provider`) đang chứa assertion cũ kỳ vọng các callback đã land là fail-closed với `CONTEXT_POLICY_REQUIRED`.
- Điều này tạo ra guard staleness tự nhiên qua từng lượt.

## 2. Cong Viec Can Lam Cho Qwen-B

1. Cập nhật các test suite cũ trong lease:
   - `mdb-01-composition-provider.test.ts:39-42`: Cập nhật kỳ vọng `prepareConnector({}, {})` resolve với object `{ skipped: true, ... }` thay vì rejects `CONTEXT_POLICY_REQUIRED`.
   - `mdb-policy-01-connector.test.cjs`: Cập nhật guard "callbacks còn lại fail-closed" để chỉ kiểm tra `prepareAdminLocalUser` ném `PASSWORD_RESET_REQUIRED`.
   - `mdb-policy-02-profiles.test.cjs`: Tương tự, cập nhật guard callbacks còn lại.
   - `mdb-policy-03-workflow-schema.test.cjs`: Tương tự, cập nhật guard callbacks còn lại.
2. Chạy toàn bộ 5 test suites:
   - `node --test tests/mdb-policy-01-connector.test.cjs` -> 20/20 PASS
   - `node --test tests/mdb-policy-02-profiles.test.cjs` -> 19/19 PASS
   - `node --test tests/mdb-policy-03-workflow-schema.test.cjs` -> 17/17 PASS
   - `node --test tests/mdb-policy-04-filecache.test.cjs` -> 16/16 PASS
   - `npx jest --runInBand --runTestsByPath tests/mdb-01-composition-provider.test.ts` -> 2/2 PASS
   - `tsc --noEmit -p tsconfig.json` -> PASS (exit 0)
3. Nộp receipt tại `du-rework/coordination/reports/receipt-mdb-policy-05-alignment-2026-10-10.md`.

## 3. Rang Buoc
- KHONG git add, commit, push.
- KHONG sua `scripts/ldba-context-provider.cjs` hay logic san pham.
- KHONG dung ky tu nhay kep trong prompt hoac khi gui lenh qua orca.
