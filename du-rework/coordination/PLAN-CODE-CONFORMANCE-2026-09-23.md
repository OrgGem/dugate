# Full-flow plan/code conformance review — 2026-09-23

> **User direction: record only (2026-09-23).** Mismatches and proposed closure criteria are review notes only. Do not implement fixes, dispatch agents, or change the active execution plan based on this review without a subsequent user instruction. Suggested priorities/lanes below are proposals, not assignments. Existing independently authorized work may continue.

Snapshot: 12:04 +07; concurrent implementation continues. **NOT FULLY CONFORMANT / NOT RELEASE READY.** This reviews the complete flow and acceptance boundaries, not a certification of every line or a full deployed E2E run. No shared DB/Redis runs, worker interruption, or product-source changes were made.

Canonical baseline: docs 01–15, phase tasks P0–P9, accepted ADRs and current source. Earlier [code findings](CODE-REVIEW-2026-09-23.md) remain a separate backlog; this report adds plan mismatches rather than duplicating them. Follow-up acceptance is recorded in [MM fix tasks](../tasks/PLAN-MISMATCH-FIXES-2026-09-23.md). Running ownership remains with the current coordinator; held SDK lane stays held.

## Phase assessment

| Phase | What exists | Remaining acceptance mismatch |
|---|---|---|
| P0 | Scope, corpus, new corpus regression consumer, capacity assumptions | Measured workload targets/benchmarks still open; assumptions are not measurements |
| P1 | Contracts, OpenAPI inventory, isolation helpers | MM-11 contract parity; MM-13 default isolation adoption |
| P2 | Durable submission/runtime, outbox, profiles, artifact storage, Admin API | MM-02..05; prior idempotency, fencing, artifact and webhook findings |
| P3 | Ledger, Redis quota, adapters, grants, usage | MM-01, MM-06..08 prevent accepting production integration/convergence |
| P4 | Worker SDK and document kit | Default Connector auth and async integration incomplete; prior CR-07/08 remain separate |
| P5 | Six document actions and corpus tests | Public document ingress/result path and authenticated production wiring unproved |
| P6 | View models plus rendered authenticated Admin shell | Rendered profile editing/publishing acceptance remains open (MM-10) |
| P7 | Real registry/API/profile pinning slices | P7-03/04/07 completion exceeds actual immutable deployment/ACL/UI evidence (MM-09/10) |
| P8 | Useful recovery/convergence/security test slices; runbook drafts | P8-02/03 full acceptance not established (MM-05..10); packaging gap MM-12; benchmarks/release gates remain open |
| P9 | Future business backlog | Intentionally outside initial release; not a defect |

## Findings

### MM-01 — High: default worker cannot authenticate to production Connector

Plan: docs 08/09, P3/P4/P5 authenticated end-to-end invocation. `packages/worker-sdk/src/connector-invoker.ts` sends content-type but no service identity. `worker.ts` constructs that default invoker; document-core's main/config do not wire a service identity into it. Connector `src/entrypoint.ts` installs `HmacServiceIdentityVerifier`; `src/http/server.ts` requires that identity. A signed invocation grant is a different credential.

**Reproduced:** default SDK invoker against a real loopback Connector HTTP server with its production identity verifier returns 401, before service runtime is reached. The SDK labels this INVALID_INPUT. The document-core integration composition without the verifier does not cover this boundary. Supply production service authentication and exercise the shipped composition, including negative identities.

### MM-02 — High: public document upload → execution → result retrieval is incomplete

Plan: docs 06 public artifacts, document facade, discoverable business/schema and result delivery; P2/P5. `docs/21-openapi.json` explicitly inventories absent public routes. `services/orchestrator/src/server.ts` exposes runtime artifact routes but not the complete API-key-only upload/download flow. `submission.ts` includes top-level artifacts/output in hashing but persists only `submission.input` into execution inputs (lines 164/180). Document-core normalizes `input.artifactIds`, leaving the advertised top-level artifact roles/output preferences disconnected.

The result route returns `{ resultRef }` inside data and an empty artifact list; clients lack the planned public reference retrieval path. Large results may legitimately use references, but those references must be retrievable. Complete the public transport and normalization boundary; retain CR-12/13 for artifact ownership/integrity and binary wire defects.

### MM-03 — High: profiles do not implement planned version selection, locks and resolved configuration

Plan: docs 06/11 profile selects version; defaults → profile → allowed caller overrides, immutable resolved execution snapshot. `submission.ts` resolves the active business version before `resolveBinding(...version...)` (line 81). A key bound to v1 can stop working after global activation of v2 instead of continuing on its profile-selected version.

`modules/profiles/profiles.ts` stores bindings and connector revisions, not the full planned defaults/locks/prompts/limits semantics. `modules/runtime/runtime.ts:1006` returns `schemaDigest: 'sha256:slice'`, empty prompt revisions and unresolved input. Existing revision-pinning tests prove connector binding immutability, not this broader profile contract. Add version-selection and forbidden-override tests before declaring the profile gate complete.

### MM-04 — High: public WAITING_INPUT cannot supply the planned resume metadata

Plan: docs 06 exposes waitId, inputSchema/uiSchema and expiry; resume requires waitId and expectedStateVersion. Runtime `getOperation` reads operations without joining the current wait; `modules/operations/facade.ts` omits wait metadata. There is no corresponding public wait lookup. Tests that read the wait from internal runtime/DB bypass the client boundary.

**Reproduced:** `toOperationView` drops supplied wait metadata. Also, `runtime.ts:181` progress reporting checks fencing but does not persist progress; list handling in `server.ts:645` always returns `nextCursor: null`. Implement public wait/progress/pagination semantics, including state filtering and stable cursor ordering, and test using only public credentials.

### MM-05 — High: reconciliation cannot reconstruct lost READY jobs

Plan: docs 04/12, P2-09 and P8-02 require PostgreSQL-authoritative recovery after Redis loss. `modules/queue/dispatcher.ts` dispatches only outbox rows with `dispatched_at IS NULL`. After successful dispatch, loss of a job before claim leaves the task READY with no lease. `runtime.ts:757` sweeps expired RUNNING leases, so this task is outside both recovery paths.

Production timers in `server.ts` schedule lease/webhook sweeps and dispatch; deadline sweeping is exposed through an explicit Admin route rather than a periodic scheduler. Worker heartbeat at line 510 returns a constant HEALTHY/capacity response rather than durable worker health/identity tracking. Add READY reconciliation, scheduled deadline/wait expiry and meaningful health tracking. A lease-expiry recovery test alone cannot close this gate.

### MM-06 — High: PENDING provider invocations have no completion path in the implemented flow

Plan: docs 08, P3-05/P4-07/P8-03 async provider polling converges without duplicate inference. `services/connector/src/invoke.ts:52` returns the stored PENDING timestamp even after it has passed. `services.ts` GET reads the ledger; no provider polling scheduler/adapter path was found. Document-core's worker maps non-SUCCEEDED connector responses to ERROR rather than integrating the SDK polling helper.

**Reproduced at the adapter seam:** replay with PENDING and an elapsed poll timestamp returns pending without transport activity. Complete poll/result reconciliation and document-core integration. CR-07's SDK attempt-budget fix alone cannot make a provider invocation complete.

### MM-07 — High: replay of IN_FLIGHT/CANCELLED falls through to a new provider call

Plan: docs 08, CON-01/03, P8-03 require deduplication and cancellation convergence. `invoke.ts:42–59` special-cases SUCCEEDED/UNKNOWN/PENDING but not IN_FLIGHT/CANCELLED; both proceed to quota acquisition and transport.

**Reproduced with real invokeAdapter and scripted ledger/quota/provider:** each replay invokes transport once. This establishes dispatch behavior, not a measured PostgreSQL race or successful durable completion. In production it becomes reachable when quota is available (for example after a quota lease expires while the original request is still running, or after cancellation releases capacity). Explicit replay-state handling/ownership must prevent redispatch and reject cancelled invocation reuse.

### MM-08 — High: quota scope and timeout do not enforce the planned provider account budget

Plan: docs 08 global account/model quota, reservations and deadlines. `services.ts:79` keys quota by connector ID + revision + tenant, allowing the same provider account to acquire independent capacity across tenants/revisions. `invoke.ts:69` defaults the lease to 30 seconds without renewal, while provider timeout can exceed that. Line 80 starts the full configured timeout rather than bounding it by remaining invocation deadline.

Redis acquisition is atomic for its key; that does not establish the required account-wide limit. Define the shared account/model identity, enforce rate/token reservations, maintain capacity for the actual call lifetime and cap timeout by remaining deadline. Test multiple tenants/revisions sharing one account.

### MM-09 — High: declared digest/ACL descriptors are being counted as deployment proof

Plan: P7-03/P7-07 immutable platform digests and provisioned worker identity/ACL. `businesses/example-review/src/registry-tool.ts` returns fixed digest strings and a provisionWorkerIdentity descriptor with booleans/default credentials. The live registry suite checks these values and useful HTTP authorization boundaries, but does not provision or inspect a Redis queue ACL or measure built/running image digests before/after extension registration.

All five declared digest strings have valid 64-character lengths; this review does not claim malformed digests. Compose network isolation provides useful separation, but a common Redis URL without per-worker queue ACL does not prove queue isolation. Keep live registration PASS; reopen the deployment/ACL portion until actual credentials, denied other-business queue access and immutable running-image evidence exist.

### MM-10 — High: full acceptance is inferred from narrower UI and recovery tests

P7-04's `p7-04-profile-assignment.integration.test.ts` tests view-model generation, authenticated shell navigation, then direct Admin API binding and public submission. It does not drive a rendered profile editor through edit/validate/publish. This cannot yet close UI-01, although API pinning is valuable evidence.

P8-02's `tests/integration/p8-02-fault-recovery.integration.test.ts` includes manually constructed transaction rollback rather than fault injection into every production submission/spawn/finalize path. Its stale-heartbeat cancellation case changes epoch by +99; it does not test cancellation with the same current epoch (CR-06). Actual Redis job loss and storage recovery are not established by those slice results. P8-03 PASS likewise does not cover MM-06..08. Record these as slice passes and require missing production-boundary tests before closing the full parent tasks.

### MM-11 — Medium: OpenAPI validation does not establish producer/contract/example parity

Plan: P1 contracts and generated/validated public examples. `tools/openapi/validate_openapi.py` inventories paths and runs `probe_cases.js`; that probe validates independent hardcoded fixtures, not examples extracted from the actual spec. It also requires `D:/Git/dugate/du-rework/packages/contracts/dist/index.js`, making it nonportable.

**Reproduced:** real `toOperationView` output fails exported `OperationViewSchema` because tenantId is missing. Decide whether the public schema or producer should expose that field, then align them deliberately. Validate actual OpenAPI examples and real HTTP response shapes from a fresh checkout, using repository-relative resolution.

### MM-12 — High: advertised orchestrator start command does not bootstrap the service

Plan: P8-06 clean deployment. Orchestrator `package.json` starts `node dist/server.js`, while source `src/server.ts` exports the app factory without a top-level environment/config bootstrap, listen call or process lifecycle entrypoint. Compiling that module does not turn it into a server process. The infrastructure compose file is a test dependency setup, not evidence of the full packaged deployment.

P8-06 is correctly still open: this is an implementation gap, not a false completion claim. Add a production entrypoint/container wiring, startup health checks and clean shutdown/migration/restore evidence before accepting immutable deployment claims upstream.

### MM-13 — Medium: isolation descriptors are not universally consumed by default test runs

Plan: P1-05 isolated concurrent tests. `tests/isolation/namespace.ts` defines DB schema, Redis/queue prefixes and artifact directory. Runtime tests wire the DB schema, but Redis selection still depends on externally supplied REDIS_URL/REDIS_DB_INDEX; generated queue/Redis prefixes are not universally passed into consumers. Fixed business queue names can therefore still share Redis under default commands.

Preserve the recorded controlled concurrent test success; it proves that configured run, not universal default isolation. Wire namespacing end-to-end or fail fast when a suite lacks isolated resources; verify two default invocations including cleanup cannot affect each other. Do not revive the earlier retracted global-TRUNCATE causal diagnosis.

## Accepted deviations and progress

- ADR-13 accepts pnpm; ADR-14 records the bounded raw HTTP/raw PostgreSQL, role bearer and PostgreSQL artifact-storage slice. Framework choices are not findings. These ADRs do not establish full profile, deployment or ACL acceptance.
- Admin now has a rendered authenticated shell; the previous view-model-only description is stale. Full editor interactions remain separate.
- A document corpus regression consumer now exists. OpenAPI inventory and example fixture checks now exist. These are improvements over earlier snapshots.
- Bounded ingress handling for CR-11 has landed in source. That should be tracked as source-fixed/pending dedicated verification rather than repeated as unchanged. Other earlier CR findings need their own closure evidence.
- Capacity assumptions honestly distinguish targets from measured performance; P9 is explicitly deferred.

## Validation and limitations

- Document-core: manifest, traceability, package-boundary and corpus-regression suites: **4 suites / 44 tests PASS**.
- Admin: shell auth/router/render suites: **3 suites / 89 tests PASS**.
- `python du-rework/tools/openapi/validate_openapi.py`: exit 0, 41 paths, 7 absent-route entries, 21 fixture checks. Limitations are MM-11.
- [Offline/loopback probe](review-evidence/plan-conformance-2026-09-23.cjs), [captured JSON](review-evidence/plan-conformance-2026-09-23.json): exit 0; defect-characterization assertions succeed. This is evidence of the findings, **not** a passing fix regression suite. Loaded source SHA-256 values are checked for changes during that probe.
- No full production deployment, external providers, live shared DB, Redis fault drill or browser editor acceptance was run by this review. Source-only findings must be closed with the prescribed boundary tests. Concurrent changes after this snapshot require revalidation, not historical evidence deletion.
