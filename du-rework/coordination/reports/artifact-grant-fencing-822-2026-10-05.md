# ARTIFACT-GRANT-FENCING-822 - receipt (VERIFY first, no code change)

> RESUME POINT (qwen_5, 2026-10-05) - task ARTIFACT-GRANT-FENCING-822 (task_3faa2db4685a),
> dispatch ctx_1660d200199a. DOC-ONLY + PROPOSAL. No code edited, no commit, no tick.
>
> Bottom line: the backlog item states no specific requirement, so nothing was changed.

---

## 1. Grant and fence code, with file:line

| What | Where |
|---|---|
| GRANT_TTL_MS = 2 * 60 * 1000 | artifacts.ts:43 |
| requestUpload(taskId, leaseEpoch, body) | artifacts.ts:147 |
| assertLease(taskId, leaseEpoch) - the fence | artifacts.ts:123-138 |
| fence throws LEASE_LOST when stored lease_epoch differs | artifacts.ts:137-138 |
| grant is method-scoped with a stored expiry | artifacts.ts:160-163 |
| access path also fence-checked | artifacts.ts:271, 354, 395 |
| multipart read-only producer fence | multipart-service.ts:358 |

Path prefix: services/orchestrator/src/modules/artifacts/. Contracts import at artifacts.ts:4-18
(ArtifactAccessGrantSchema, ArtifactUploadGrantRequestSchema, ArtifactUploadGrantSchema,
ArtifactStorageUploadGrant).

The fence is a LEASE fence: assertLease reads the task row and refuses a stale leaseEpoch.

## 2. Seed and whether it satisfies the fence

File: services/orchestrator/tests/artifact-grant-fencing.test.ts

| What | Where |
|---|---|
| seedOperation(tenantId) | :79 |
| seedTask(operationId, epoch = 1) inserts lease_epoch | :88-91 |
| happy path calls with leaseEpoch 1 | :180, :212, :243, :278, :328, :358, :378, :401, :411, :421, :431, :437 |
| mismatch case: UPDATE tasks SET lease_epoch=2 then call with 1 | :407 |
| cancelled-task case | :417 |
| foreign-tenant task seeded | :387 |
| whole file live-gated | :124 (liveDescribe = LIVE ? describe : describe.skip) |

The seed satisfies the fence by construction (writes lease_epoch 1, callers pass 1), and the mismatch
case is registered explicitly at :407. The constraint the fence enforces IS exercised.

## 3. MISMATCH report (file:line, expected, actual)

| # | file:line | Expected per backlog | Actual (verified) |
|---|---|---|---|
| M1 | artifact-grant-fencing.test.ts:124 | a seed fix is needed | seed already satisfies the fence; mismatch registered at :407 |
| M2 | artifacts.ts:123-138 | fence could be defeated by the seed | assertLease compares against stored lease_epoch; a wrong epoch is caught, not bypassed |
| M3 | artifact-grant-fencing.test.ts | runs in offline regression | liveDescribe skips the file unless DU_LIVE_INFRA |

No ART-03 or P8-04 receipt exists in this tree (globbed coordination/**/*ART-03*, *P8-04*, *P8* -
zero matches). Item (4) therefore cannot be cross-checked here; the historical acceptance hold is
NOT verifiable from this checkout and must be cited from those receipts directly.

## 4. Why nothing was changed

Three candidate readings, none actionable as written:

1. The seed writes a task that bypasses the fence - not reproducible (epoch 1 written, 1 passed).
2. The seed does not register the constraint - not reproducible (:407 sets epoch 2, expects LEASE_LOST).
3. The seed is missing a row the fence needs - cannot tell which row; guessing would be inventing work.

Per the packet, an ambiguous requirement gets questions, not a change.

## 5. Questions needing USER or Claude

1. Which seed statement is wrong? Quote the INSERT/UPDATE line or the failing case.
2. Which fence constraint must the seed satisfy: lease_epoch equality, lease_active, state not
   CANCELLED, tenant scoping, or the stored expires_at?
3. What is expected after the fix - the seed starts FAILING the fence (proving the fence works) or
   starts PASSING it (proving the seed is valid)?
4. Is the target offline or live? The file is live-gated; offline coverage would be a different change.
5. What do ART-03 and P8-04 actually say? Neither receipt is in this tree.

## 6. Safest option

Do not change the seed. The current seed is self-consistent with the fence and the mismatch case is
already registered. If the real intent is broader coverage (foreign tenant, cancelled task), that is
an ADDITION - :387 and :417 already exist - not a fix.

## 7. Ledger

- ARTIFACT-FENCING-822 - Muc 1 - verified grant/fence code (artifacts.ts:43,123-138,147-163,271,354,395;
  multipart-service.ts:358) and the test seed (artifact-grant-fencing.test.ts:79,88-91,124,180,387,407,417);
  the seed satisfies the fence by construction and the mismatch case is registered, so the reported seed
  fix is NOT reproducible; no ART-03/P8-04 receipt in tree so the historical hold is unverifiable here;
  5 concrete questions listed; safest option = do not change the seed. No code edit, no commit, no tick.
