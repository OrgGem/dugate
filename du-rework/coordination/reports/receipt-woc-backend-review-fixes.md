# WOC backend core review repair receipt

Date: 2026-10-12

This receipt records the backend repair work performed by `/root/woc_backend` under the assigned core-source lease. The changes listed below are this worker's implementation edits, not inherited baseline behavior; no other writer edited the runtime, queue dispatcher, or worker-instance core files during this lease. No SDK, profile/UI, auth helper/config, deployment, migration, or shared-admin files were edited for this repair.

## Changes

- Queue-integrity recovery now creates each replacement outbox intent with `payload.deliveryId` rewritten from the new durable `delivery_id`. The dispatcher also always overwrites BullMQ job data's `deliveryId` from the selected outbox row, so the job ID, message envelope, and later claim use one authoritative delivery identity.
- The claim UPDATE has a claim-generation supersession fence: under the task-row lock, the incoming delivery must be the newest durable `task.dispatch` or `task.continuation` for that task. A late original delivery after recovery returns `TASK_NOT_READY` without consuming an attempt; a current replacement/continuation can claim. The task-row lock and recovery's locked CAS serialize the race: a claim that wins first moves the task to `RUNNING`, which recovery rechecks; recovery that wins first inserts the newer intent, which fences the old claim.
- Same-owner lost-ACK replay remains available only for the exact original `delivery_id`, a live lease, fresh worker registration, and matching pinned business version and immutable manifest digest. A different/replacement delivery while that lease remains live gets `TASK_LEASE_ACTIVE`, not the old snapshot. An exact-ID replay after the worker instance upgrades to another version gets `WORKER_VERSION_MISMATCH`.
- Explicit heartbeat manifest-digest validation still rejects missing registration and digest mismatch. Its read of immutable `business_versions` no longer takes a row lock before the later worker-instance lock, removing the version-to-worker edge of the registration/heartbeat/claim lock cycle. The business enabled gate and its `FOR SHARE` recheck remain unchanged.
- Recovery and claim tests cover both `task.dispatch` and a valid current `task.continuation`; newest-intent selection remains ordered by delivery timestamp, creation timestamp, and row ID.

## Validation

All commands ran from `D:\Git\dugate\du-rework\orchestrator\services\orchestrator` unless noted.

| Command | Result |
| --- | --- |
| `pnpm exec jest tests/or10-03-runtime-lease-replay.test.ts tests/mm05-queue-integrity-sweep.test.ts tests/mm05-queue-integrity-offline.functional.test.ts tests/woc-backend-business-lifecycle.test.ts tests/aweb11c-worker-instances.test.ts --runInBand` | 5 suites passed, 48 tests passed, 0 snapshots |
| `pnpm run typecheck` | Passed (`tsc --noEmit -p tsconfig.json`) |
| `pnpm run build` | Passed (`tsc -p tsconfig.json`) |
| `git diff --check -- <seven scoped source/test paths>` (from `D:\Git\dugate\du-rework`) | Passed; no whitespace errors |

Raw output is in `coordination/reports/raw/woc-backend-review-fixes-jest-2026-10-12.txt`, `...-typecheck-2026-10-12.txt`, and `...-build-2026-10-12.txt`. One initial Jest attempt used a raw-log path relative to the service directory that did not exist; that invocation is not counted. The focused suite was rerun with the corrected `../../../coordination/reports/raw` target and produced the passing result above.

## Remaining verification

The offline tests prove the claim predicates and recovery payload construction, not PostgreSQL's concurrent row-lock behavior. No live database was used. Independent verification still needs a real PostgreSQL barrier test for (1) the original-claim/recovery-CAS race and (2) root→version registration, explicit-digest heartbeat, and worker→root claim lock ordering. No release, image, deployment, or runtime behavior is claimed from these source/test results.

## Changed source/test paths and SHA-256

| Path | SHA-256 |
| --- | --- |
| `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts` | `3D333B43259BEF7E830D6D1F03D1C7336898FC5E462DD15F9928EE9C1EED3507` |
| `orchestrator/services/orchestrator/src/modules/queue/dispatcher.ts` | `091830A2DA70BB86F21700228402D2B03ABDADBBE6A68C786F9B3904ED0B8F23` |
| `orchestrator/services/orchestrator/src/modules/runtime/worker-instances.ts` | `9B1A76090B692CAD371C50EC7084F47BC0AC259DC4AA14F67B51A2E1BA177BDB` |
| `orchestrator/services/orchestrator/tests/or10-03-runtime-lease-replay.test.ts` | `2080259A30E0D2D510C71FBB0FFD89603BB508F2D1F24CAC36B0464B73ACFB86` |
| `orchestrator/services/orchestrator/tests/mm05-queue-integrity-sweep.test.ts` | `1A05816F1A022C9113FC1056BC7C5A57F93B32F0B45AD8EBA7AA1FF2EEF6EDD5` |
| `orchestrator/services/orchestrator/tests/mm05-queue-integrity-offline.functional.test.ts` | `D8C4D4BE17CBB11CBC64D093D3205DCA1E0350CA51FFE77D5CD6256C90BD1FA3` |
| `orchestrator/services/orchestrator/tests/woc-backend-business-lifecycle.test.ts` | `18CCBE131C1655BA81B457B74C6781ACCFE9AB23F41BD6624FF26A549C3B5F86` |
