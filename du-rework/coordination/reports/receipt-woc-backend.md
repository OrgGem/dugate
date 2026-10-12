# WOC backend implementation receipt

Date: 2026-10-12 (Asia/Bangkok)

Status: backend WOC source is implemented and its focused offline verification is green. This is an implementation receipt, not independent acceptance. WOC-02/03/04/07/09/10 remain subject to read-only review and the live verification gates in the canonical plan.

## Delivered behavior

- WOC-00/07 contract source in `orchestrator/packages/contracts/src/errors.ts`, `runtime.ts`, and `public-api.ts` defines the runtime refusal codes and a shared claim disposition matrix. Only `NOT_FOUND`, `TASK_TERMINAL`, `TASK_WAITING`, and `TASK_LEASE_ACTIVE` are ACK-safe. `BUSINESS_DISABLED`, readiness/admission, worker registration, version/manifest mismatch, lease-held, temporary-unavailable, and shutdown outcomes defer; unrecognized and legacy `STATE_CONFLICT` outcomes remain fail-closed/deferred. `WorkerHeartbeat.manifestDigest` is optional on wire v1. When present, it must match the server-registered digest; legacy absence uses the immutable server-side version digest. `backupEffectFence` is additive/optional; missing state remains UNKNOWN and is never defaulted OPEN or silently acknowledged.
- WOC-02 in `runtime/runtime.ts` clears lease owner and expiry and advances fencing on yield; durable replay returns the prior yield result without restoring old write authority. Resume/join makes the parent claimable immediately and retains one continuation intent.
- WOC-03 in `runtime/runtime.ts` and `queue/dispatcher.ts` uses bounded transport retries/backoff with jitter before business claim, and recovery examines actual BullMQ state for both dispatch and continuation. Replacement outbox delivery uses a database CAS/generation identity for stable-job collisions; recovery does not delete active work or redeliver RUNNING/terminal tasks. Retry/recovery does not consume business attempts.
- WOC-04 binds claim to the pinned task version, immutable server-registered manifest digest, and registered worker instance version before lease acquisition. A supplied heartbeat digest is persisted only after registry match; absent v1 heartbeat digest remains compatible through the registered server digest. Incompatible replicas defer without consuming the task or incrementing business attempts.
- WOC-09 adds `PUT /api/runtime/v1/businesses/:businessId/versions/:version`. It validates URL/body identity, accepts the existing platform runtime credential or existing uniquely resolved scoped worker-business credential, and transactionally performs digest-checked idempotent registration plus an unowned catalog root. Replaying the same digest is safe; a different digest for the same version conflicts. No tenant ownership or credential is inferred from registration input. Heartbeat remains separate and per instance.
- WOC-10 adds migration `0066_business_enable_worker_intake.sql`, a platform-admin business enabled-state CAS (`PUT /api/v1/admin/businesses/:businessId/enabled`, `{enabled, expectedLifecycleRevision}`), and its CSRF/tenant-fenced BFF endpoint `/admin/api/businesses/:businessId/enabled`. Existing catalog roots are enabled for compatibility; roots absent for already registered versions are backfilled with `ON CONFLICT DO NOTHING`, preserving existing ownership/lifecycle rows. Newly registered roots default disabled. Submission, durable dispatch selection, and claim all gate on the persisted business state; existing leases drain, and disabled backlog remains pending/recoverable. Dispatcher eligibility filters disabled business intents before the bounded batch limit so they cannot starve enabled work.
- Worker inventory reports `acceptedTaskCount` and `acceptedTaskCountSince` as a business-instance-lifetime count/epoch, separate from current active leases and capacity. The counter increments once within the successful fenced claim transaction, not for duplicate/deferred delivery. Business list/detail DTOs include `enabled` and `lifecycleRevision` for CAS clients.

No worker identity/auth helper, key validation/configuration, credential provisioning, Vault policy, checkpoint key, or grant key format was changed. Replicas sharing one token mapping for the same business remain supported. Existing duplicate-token rejection across different business mappings or reserved platform credentials remains unchanged; no live deployment config was inspected to establish whether that conditional branch is in use.

## Changed paths in this work scope

Contracts: `orchestrator/packages/contracts/src/errors.ts`, `src/runtime.ts`, `src/public-api.ts`.

Migration and backend: `orchestrator/services/orchestrator/migrations/0066_business_enable_worker_intake.sql`; `src/http/routes/runtime.ts`; `src/http/routes/admin.ts`; `src/app/admin/bff/operations.ts`; `src/modules/admin-read/business-list.ts`; `src/modules/admin-read/tenant-business-catalog.ts`; `src/modules/admin-read/worker-instances.ts`; `src/modules/operations/submission.ts`; `src/modules/queue/dispatcher.ts`; `src/modules/registry/registry.ts`; `src/modules/runtime/runtime.ts`; `src/modules/runtime/worker-instances.ts`.

Focused tests: `tests/aweb06-bff-operations.test.ts`, `tests/aweb11c-worker-instances.test.ts`, `tests/br12-isolation-offline.test.ts`, `tests/business-catalog-contract-conformance.test.ts`, `tests/mm05-queue-integrity-offline.functional.test.ts`, `tests/mm05-queue-integrity-sweep.test.ts`, `tests/or10-03-runtime-lease-replay.test.ts`, `tests/runtime-lease-fencing-offline.test.ts`, `tests/woc-backend-business-lifecycle.test.ts`, `tests/woc-backend-contracts.test.ts`, `tests/woc-backend-resume-join.test.ts`, and `tests/woc-backend-yield.test.ts`.

`src/http/routes/admin.ts` is co-located with the profile-groups backend worker's subsequently integrated routes. Its recorded hash is the final shared-tree file snapshot, not a claim that the file contains only this worker's changes. The profile-group modules, migration 0067, admin profile-groups BFF module, profile UI, and SDK source are sibling-owned and are not included as this worker's changes.

## Verification

Repository baseline: `D:\Git\dugate\du-rework`, branch `codex/fix-workflow-builder`, HEAD at task start `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`.

From `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`:

```text
pnpm typecheck
exit 0
raw: coordination/reports/raw/woc-backend-typecheck-2026-10-12.txt

pnpm exec jest --runInBand --config jest.unit.config.cjs tests/aweb06-bff-operations.test.ts tests/aweb11c-worker-instances.test.ts tests/br12-isolation-offline.test.ts tests/business-catalog-contract-conformance.test.ts tests/mm05-queue-integrity-offline.functional.test.ts tests/mm05-queue-integrity-sweep.test.ts tests/or10-03-runtime-lease-replay.test.ts tests/runtime-lease-fencing-offline.test.ts tests/woc-backend-business-lifecycle.test.ts tests/woc-backend-contracts.test.ts tests/woc-backend-resume-join.test.ts tests/woc-backend-yield.test.ts
exit 0
Test Suites: 12 passed, 12 total
Tests: 129 passed, 129 total
Snapshots: 0 total
raw: coordination/reports/raw/woc-backend-focused-2026-10-12.txt

pnpm build
exit 0
raw: coordination/reports/raw/woc-backend-build-2026-10-12.txt
```

From `D:\Git\dugate\du-rework`, `pnpm --filter @du/contracts build` completed with exit 0 after the contracts/profile-groups source handoff; its terminal output was not retained as a raw file. `git diff --check` completed with exit 0; raw output is `coordination/reports/raw/woc-backend-diffcheck-2026-10-12.txt`. Git emitted line-ending warnings for in-progress shared files, with no whitespace errors.

An earlier broad contracts test run had 30/32 suites pass and 573/578 tests pass; the two failing suites had existing `usage-reconciliation` expectation drift and `profile-policy` fixtures missing `connectorBindings`. The broad orchestrator unit run was interrupted after unrelated failures/timeouts and did not yield a reliable full-suite verdict. Neither broad run is counted as focused WOC verification. A final full-suite rerun was not started because the scoped focused suite, typecheck, and build passed and no new failure justified broadening verification.

## Snapshot SHA-256

Hashes below identify the current shared working-tree snapshot after the comment-alignment fix; they do not imply commit or release provenance.

```text
orchestrator/packages/contracts/src/errors.ts 07BFA3BBD7676B5ED36ABA17A596DE4EEDE64E0EA21855B3408FE6BA969D68D8
orchestrator/packages/contracts/src/runtime.ts E28B6D8A9658F44512FE518974C5FBDCF55BA76A6EE88036CEC865886363C91E
orchestrator/packages/contracts/src/public-api.ts 129EF4E66CC93F88AD52E5EDB05F2CDE885B4B5888A392EAA52F6FAB60E2A587
orchestrator/services/orchestrator/migrations/0066_business_enable_worker_intake.sql 11FCDBDC64A1CF5ACE46962892BEE376F9482F13AE7ED435AC1700BB16F921FB
orchestrator/services/orchestrator/src/http/routes/runtime.ts 87E29C70B3142051B000D66AC34BD85EF6FC462F372AD95E561A8EB010D64F54
orchestrator/services/orchestrator/src/http/routes/admin.ts 01913FE6BB96AB652F246C5B0FA9892539C28AC64519F663BC8594C1F44A6953
orchestrator/services/orchestrator/src/app/admin/bff/operations.ts BFC97298B0AAAF118A49C9C2CC843ABC318B28175BC5A9730004C2A8816E3FD5
orchestrator/services/orchestrator/src/modules/admin-read/business-list.ts 50368A1D5B14AF256241AE93F49A1C0055049A9A03FCF044006356D59B431BE5
orchestrator/services/orchestrator/src/modules/admin-read/tenant-business-catalog.ts FC0BB2375EC7265BF368877A8F674BF28A2B5EE0432BD3428BD1BD5B15E89514
orchestrator/services/orchestrator/src/modules/admin-read/worker-instances.ts 5F96DC54619B7AE625D99BC61518638B843EDF8DFAC08F5EAE609D3AEB3D0ECE
orchestrator/services/orchestrator/src/modules/operations/submission.ts 06008EF7714C249F15EEA6A195161087B970DECF4E809503F2EB3724C0A93C07
orchestrator/services/orchestrator/src/modules/queue/dispatcher.ts FD7358F2E0CC4857F7A0DA1A482181DCBFFCBA25DB2819273FB8BB81614B9480
orchestrator/services/orchestrator/src/modules/registry/registry.ts 5A3E5E72D1AA95D9EF6BF8942C9ED8A2E8A2CF0027339FDD79AC716E49CBD989
orchestrator/services/orchestrator/src/modules/runtime/runtime.ts E111A24AA02F67F1B4185C812FEBD141855168F53B925611710B3EAA7C06022C
orchestrator/services/orchestrator/src/modules/runtime/worker-instances.ts E71279C24105CFD334B3878E222F39456934158F6A0989A02CE594D3F8A8D107
orchestrator/services/orchestrator/tests/aweb06-bff-operations.test.ts A95138FA3B7F5752FCECCA6AC21169DDAEE2479F127B516DF364C293962F80F3
orchestrator/services/orchestrator/tests/aweb11c-worker-instances.test.ts F504A66EE9E93ED12927FC82F8991BEBD22F07EFDFC7622B0C756B32209A0ABF
orchestrator/services/orchestrator/tests/br12-isolation-offline.test.ts 73BEE0492BBD192E3DC693D996250648C0215D3292AEE125F69334AE93A4AF1E
orchestrator/services/orchestrator/tests/business-catalog-contract-conformance.test.ts 442434419550D3992D2B9FCF49ADA92D0764C873FC4FF4B96D5D8FED10280C8B
orchestrator/services/orchestrator/tests/mm05-queue-integrity-offline.functional.test.ts A69C9BA3FDA05F1D3EAB405EC5D81654F86423833A1F79E856DE66A3B1C34EB3
orchestrator/services/orchestrator/tests/mm05-queue-integrity-sweep.test.ts EE2D5C3166CD7DD1D28A9CA2536A0DF1731DE0652B12B5453C3CFB3B1CB0D6D6
orchestrator/services/orchestrator/tests/or10-03-runtime-lease-replay.test.ts B8838F5D1709363C00595BB833DA3A01780321EC435AE194C040D6A2477B3ECC
orchestrator/services/orchestrator/tests/runtime-lease-fencing-offline.test.ts B638C052A1FB9B793BF563D002C168B57CE8EBC63981FE3C50DCDA1820034CD4
orchestrator/services/orchestrator/tests/woc-backend-business-lifecycle.test.ts 2BF436DE07A5F332972C6C846B947067A17915AAAAA968C25B0F3B02A3F6597D
orchestrator/services/orchestrator/tests/woc-backend-contracts.test.ts 70C4AF7C56C00B8750AB76A1487BA6709D86C54E73C6C6C2E630BDDD46E02408
orchestrator/services/orchestrator/tests/woc-backend-resume-join.test.ts 331BD0387C6A49A854B847204718B50DF7B9C84F91C72CBF5FC03B5E93103365
orchestrator/services/orchestrator/tests/woc-backend-yield.test.ts 45CEB3155C2C90DA7A8E89E6E7F48F8E2F42034233329497E87E5618E3F377DB
```

## Limits and handoff

No migration was applied to a real PostgreSQL database. Registration concurrency and digest conflict are tested with offline/mock fixtures, not a true concurrent PostgreSQL race. No real Redis/BullMQ namespace, multi-orchestrator/worker replica fault run, provider mock E2E, deployment, container provenance, or production verification was performed. Queue override values and subscriptions have not been verified in a live environment. Existing registered-version routing is version-qualified; the separate unique `business_versions.is_active` pointer remains the default for new submission and does not by itself provide an explicit-version submission API. The backend does not claim simultaneous explicit-version intake absent that API/evidence. The migration and route sources are ready for independent review and VFY-WOC-02/VFY-WOC-03.

Write ownership for `admin.ts` was released to the profile-groups backend worker after enable-route integration; its profile-groups wiring is sibling-owned. Backend source is now frozen for independent read-only review. No commit, push, production mutation, deployment, or release was performed.

