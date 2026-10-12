# Independent core source review

Reviewer: `/root/requirements_alignment`, gpt-6.1-sol high, read-only. Baseline `b276ede4`, working source hashes matched backend/SDK/transport receipts. Verdict: **CHANGES NEEDED**. No tests/build/services executed by reviewer. Unfinished profile/UI excluded.

## Findings

1. **P1 recovered delivery has old wire identity.** Runtime recovery (`modules/runtime/runtime.ts:180-186`) inserts replacement delivery_id but copies payload, dispatcher (`modules/queue/dispatcher.ts:135-145`) uses new BullMQ jobId but old payload.deliveryId. If recovery CAS commits before delayed original claim and original then starts, replacement may replay same owner lease and start another handler. Rewrite envelope from durable row authority; test row/BullMQ/payload/claim ID agreement and delayed-original-claim race. Do not change logical invocation/checkpoint IDs.
2. **P1 same-instance redelivery lacks SDK single-flight.** SDK worker (`packages/worker-sdk/src/worker.ts:376-378,788,891-894`) tracks promises/contexts but each callback may independently claim and invoke handler. Server (`modules/runtime/runtime.ts:687-694`) intentionally replays same worker/delivery lease. Concurrency > 1 plus Redis job lock loss while Runtime heartbeat stays healthy permits two handlers sharing one lease epoch. Hold a local keyed execution guard through handler settlement, preserve lost-ACK replay, test simultaneous identical deliveries with blocked first handler and one accepted-counter increment.
3. **P2 PostgreSQL lock cycle.** Registry (`modules/registry/registry.ts:76-78`) catalog→version, explicit-digest heartbeat (`modules/runtime/worker-instances.ts:49-51,82`) version→worker, claim (`modules/runtime/runtime.ts:738,765`) worker→catalog. Concurrent barriers form root→version→worker→root; DB wrapper rolls back/rethrows with no transaction retry. Establish consistent order or remove unnecessary immutable-version locks, then barrier-controlled real PostgreSQL regression with registration replay/heartbeat/fresh claim.

## Reviewed source observations

Scoped registration uses existing credentials/helpers. New business defaults disabled; existing roots backfill enabled. Disabled businesses are filtered before dispatcher LIMIT and blocked at fresh claim; existing leases drain. Accepted counters update atomically with fresh fenced claims. Explicit digest must match; absent legacy digest uses server registration. Submission replay precedes new admission. Worker identity helper has no diff.

Owner logs: backend 12 suites/129 tests; SDK registration 7 suites/140 tests; transport 1 suite/14 tests pass. These are owner checks, not independently rerun tests.

## Open verification

True PostgreSQL migration/concurrent registration/lock tests, Redis/BullMQ fault/duplicate tests, multi-replica recovery, compatibility matrix and live provider counts remain unproven. Full SDK has failures/incomplete latest run; WOC-00 baseline reconciliation and WOC-08 template parity remain open. No deployed image or E2E readiness verdict.

## Repair ownership

Backend P1/P2 assigned to `/root/woc_backend` after review handoff. SDK P1 queued for `/root/woc_sdk` with separate source lease; source must be re-reviewed after fixes. Profile/UI review starts only after their own handoff.
