# DU Rework architecture hardening plan

Date: 2026-10-13. Status: implementation, independent scoped review, offline verification, ordered build, and isolated startup checks complete. Earlier checkpoints below are historical, not the current acceptance status. See reports/architecture-hardening-validation-2026-10-13.md for evidence and limits.
Workflow: Codex primary owns planning and synthesis; Luna/max workers implement scoped tasks; independent Sol/high review. Historical coordination dispatch gates do not apply.

## Requirements retained

- Workers remain independent projects. Source-vendored SDK and skill-guided direct protocol implementations are both supported.
- Preserve intentionally shared business authentication keys, immutable business/version manifests, operation snapshots, and Connector revision pins.
- Profiles select registered, enabled businesses and their endpoints. Document Core exposes its endpoint catalog; workflow businesses retain their workflow contracts.
- Simplify Connector creation while keeping provider credentials and revision selection correct.
- Make queue admission, concurrency, retry, cleanup, and operation/worker visibility reliable.

## Added requirement: one active version and graceful task drain

For each business, at most one version is active. An enabled business needs one eligible active version to accept new work; an unconfigured, disabled, or explicitly deactivated business may have none and must reject new admission.

Multiple workers of the same active version may accept tasks, within their capacity. Registering a worker or another version does not automatically activate it. Activation is a business-level routing decision, not a worker-instance status.

Switching A/v1 to A/v2 stops all NEW v1 task claims. Tasks already claimed by v1 workers with valid leases continue to completion under their original pins. A worker with no remaining tasks stays registered and idle; it can resume if its version is reactivated. Activation alone does not kill the process or cancel a running task.

### Current source evidence

| Area | Existing behavior | Required change |
| --- | --- | --- |
| `orchestrator/services/orchestrator/migrations/0006_active_version.sql` | Partial unique index on business ID where `is_active=true` enforces at most one active version. | Retain the constraint; do not introduce a second competing active pointer. |
| `orchestrator/services/orchestrator/src/modules/registry/registry.ts`, `activateVersion` | Transaction locks version rows, clears previous active flag, activates an enabled target. Explicit deactivation can leave no active version. | Serialize cutover with admission/claim, add stale-change protection and transition audit. |
| `orchestrator/services/orchestrator/src/modules/operations/submission.ts`, `resolveEnabledVersion` | New submission resolves active version, but resolution and subsequent admission need a shared transaction boundary with activation. | Revalidate version/generation before durable admission; never silently repin an already validated request. |
| `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts`, task claim | Worker/task version and manifest pins are checked; logical business enabled is checked. The current active-version flag is not a new-claim condition. | Authoritative transactional gate for every new lease, including retry and expired-lease reclaim. |
| `orchestrator/services/orchestrator/src/modules/queue/dispatcher.ts` | Outbox routes by pinned version; business enabled is checked. | Stop publishing inactive-version work; handle already published deliveries safely. |
| `orchestrator/services/orchestrator/src/modules/runtime/worker-instances.ts` and worker runtime clients | Heartbeat conveys control state, not a distinct version admission decision. | Expose version eligibility independently from permission to continue an existing task. |

These are source findings, not verification of the currently running deployment.

### Implementation design

1. **Atomic cutover.** Use a shared business-scoped transaction lock and a documented consistent lock order for activation, deactivation, new operation admission, dispatcher decisions, and new task claims. Retain the database uniqueness constraint. Add an activation revision and compare-and-set to reject stale concurrent admin changes. Activation checks target eligibility and shows readiness/profile compatibility before switching. Do not hold a database transaction open across Redis/network calls.
2. **Authoritative claim gate.** Under that lock, a new claim requires business enabled, target version enabled and active, matching immutable worker/task version and digest, fresh worker registration, allowed control state, free capacity, and available attempt budget. The transaction commit defines cutover order: a claim committed before activation is drainable; one after activation cannot acquire an old-version lease. Cached heartbeat state and Redis routing cannot override this gate.
3. **Idempotent active-task continuation.** Replaying an existing valid claim must not consume another attempt or be treated as a new admission. Existing valid leases retain heartbeat, progress, checkpoint, artifact, Connector grant/invocation, completion and failure reporting permissions. Normal cancellation, deadlines, lease expiry, security revocation, and fencing still apply. Version change must not trigger a generic execution fence that aborts those tasks.
4. **Worker admission feedback.** Return active version, activation revision, admission eligibility, and a reason such as `VERSION_NOT_ACTIVE` (proposed contract field/code). Pause local consumption without waiting for active handlers to terminate. Prevent late heartbeat responses from restoring an older admission state. Existing Runtime claim validation remains authoritative during propagation delay or with a self-implemented worker.
5. **Pending work and retries.** Keep not-yet-claimed old-version work durably parked with an explicit reason and counts. This includes READY/QUEUED work, due retries, expired-lease recovery, and child/join tasks requiring a new claim. Do not change its business version, manifest, profile, or Connector pins. Do not increment attempts for an admission refusal or hot-loop retries. Make transport acknowledgement/defer behavior recoverable from PostgreSQL; lost Redis deliveries must not lose parked work. Reactivation resumes eligible work; cancellation/resubmission is an explicit action, not automatic migration. Deadlines and terminal cleanup still run while parked.
6. **Workflow boundary.** Drain guarantees apply to already claimed tasks, not an entire operation that needs additional child/join/retry claims. An in-flight operation may therefore remain waiting after its current tasks finish. Show this consequence before immediate cutover. If whole-operation completion is needed, support a separate pre-drain rollout: stop new operation submissions, keep v1 active for its remaining claims, then switch once the defined drain criteria are met. Do not let both versions claim concurrently as an implicit exception.
7. **Profile/endpoint behavior.** New requests use only the active version's endpoint contract. Validate that the selected profile bindings, action schemas, and Connector revisions support the target version before activation/admission. Reject incompatible bindings with actionable errors rather than silently rewriting existing snapshots. Existing tasks continue using their original configuration.
8. **Observable state.** Show one active badge per business, version admission status, old-version draining tasks, parked backlog, and activation revision/time/actor. Keep worker liveness distinct from eligibility: ONLINE does not imply permission to claim. Display worker capacity, running lease count, task/operation ownership, attempt budget, lease expiry, and the reason a worker or task cannot proceed. Derive drain completion from valid durable leases, not heartbeat counters alone.

### Acceptance scenarios

- v1 has two workers, v2 has one: only workers of the selected active version acquire new tasks.
- Two simultaneous activations preserve the unique active target and reject stale revisions; unrelated businesses remain independent.
- Race activation against submission, dispatcher publication, first claim, retry claim, and expired-lease reclaim. A delayed Redis publication or stale heartbeat cannot allow a post-cutover v1 claim.
- A v1 task claimed before cutover can heartbeat, invoke Connector, checkpoint and complete after cutover; a lost claim response can replay its still-valid lease without a second attempt.
- A worker with one running task and queued jobs finishes only its running task, then stays idle. Admission denial neither consumes attempts nor causes busy delivery loops.
- Retry/child/join work from v1 stays pinned and parked after cutover; deadlines, explicit cancellation, reactivation and recovery from Redis loss remain deterministic.
- v1 -> v2 -> v1 with delayed heartbeat responses does not resume the wrong consumers or revive stale leases.
- UI shows active, draining and parked counts consistently; profile incompatibility is reported before or at admission without silent migration.
- Run the same protocol conformance cases against the SDK worker and an independent implementation. Add real PostgreSQL/Redis race tests with fake Connector/provider responses; no real AI calls are required.

## Integrated delivery order

1. **Version admission and queue correctness:** the cutover design above, atomic worker capacity and attempt limits, recovery of RETRY_PENDING deliveries, fair queue-integrity scans, and retry priority preservation. Establish the protocol before propagating changes into independently vendored SDK copies and skill/sample instructions.
2. **Profile and Connector call path:** prevent revoked profile-key membership falling back to legacy authorization; unify typed Connector catalog/revision validation; separate forbidden static headers from supported credential injection; provide validated provider presets and a simple Name / Provider / URL / Model / Credential -> Test -> Activate flow. Preserve advanced configuration.
3. **Lifecycle and cleanup:** avoid retention candidate starvation; define terminal operation/task/checkpoint/artifact retention, parked-work deadline handling, and safe worker-instance retirement without deleting live leases or referenced data.
4. **Read models and UI:** expose actual operation progress, task ownership and parallel workflow structure, worker handlers versus durable leases, queue and cleanup backlog, and version transition state. Correct soft-delete filtering and disclose truncated fleet counts.
5. **Validation and rollout:** targeted regression tests for the reviewed defects plus the acceptance matrix above; independent read-only review. Report source, tests, built artifacts and running E2E separately. No Docker build or deployment is implied by this planning update.

The SDK separation and shared business auth keys are deliberate architecture decisions, not issues to remove during these workstreams.

## Retry rules to preserve and expose

- A business attempt is consumed only when a new durable lease is acquired. Valid claim replay and admission refusal do not consume another attempt.
- A lease-bound failure report schedules business retry only when `retryable=true` and the current attempt is below `max_attempts`. The delay is `retryAfterMs` when supplied, otherwise 5 seconds; the operation deadline still limits execution. Non-retryable errors or exhausted budgets terminate through the Runtime state machine.
- SDK error classification is explicit: ordinary unclassified handler errors are non-retryable; handlers may declare a retryable business error; supported Connector/Runtime transient errors follow their existing classifier. An uncertain external outcome must reconcile its invocation identity rather than create an untracked duplicate effect.
- Redis delivery retry and outbox publication retry are transport mechanisms, not extra business-attempt budgets. Stable delivery IDs and lease fencing remain authoritative. Dispatcher publication uses bounded exponential backoff with jitter (up to 300 seconds); queued delivery transport has its separate retry policy.
- Inactive-version work is parked with its original immutable pins. Reactivation may resume it within its deadline/budget. A fresh operation retry is new admission and must respect pre-drain and active-version checks; replay of an already-created retry remains idempotent.

## Codex task groups and verification sequence

User instruction: implement all groups concurrently where file ownership permits; use unit tests during group development, then one integrated test/build/run pass and fix discovered issues. This supersedes the earlier planning-only scope and the proposed immediate database race-test stage. Docker image builds are not part of this pass.

| Group | Scope | Initial owner | Dependency / verification |
| --- | --- | --- | --- |
| A | Active-version cutover, admission, capacity, retries, queue recovery and heartbeat protocol | `runtime_hardening` (Luna/max) | Focused offline unit tests; publish contract fields early |
| B | Profile key authorization, typed Connector catalog/bindings, credential injection and simple provider setup | `profile_connector_hardening` (Luna/max) | Focused offline unit tests; independent of A |
| C/D | Cleanup, retention safety, operation/worker read models and UI visibility | `cleanup_visibility_hardening` (Luna/max) | Focused offline unit tests; consume A's admission contract |
| E | SDK admission versus execution gates, vendored source copies, independent sample, skill and protocol documentation | `sdk_protocol_hardening` (Luna/max) | Contract published; implementation in progress; preserve standalone package boundaries |
| R | Independent read-only review of combined implementation | `hardening_review` (Sol/high) | Reviewing stable B/C/D first, then A/E; separate from implementation owners; findings returned for fixes |
| V | Integrated offline tests, package builds/typechecks and service startup smoke checks | Primary coordinates Luna/max execution | Starts once focused checks pass; use fake providers, record actual runtime scope, avoid replacing user processes |

Only three worker slots are available concurrently, so E/R/V start as slots free up. Ownership is disjoint within each wave. Existing uncommitted changes are preserved. No commit/push is implied by this implementation request.

Provisional heartbeat admission contract: `activeVersion: string | null`, `activationRevision: number`, `admissionEligible: boolean`, and `admissionReason: ELIGIBLE | BUSINESS_DISABLED | NO_ACTIVE_VERSION | VERSION_NOT_ACTIVE | VERSION_NOT_ENABLED`. These fields govern new consumption, independently of the existing execution control/fencing contract. Activation changes use `expectedActivationRevision` for stale-write protection.

### Completion receipts

- A: implementation delivered; focused batch reported 12 passing suites / 203 tests (4 suites / 37 tests skipped), continuation/queue batch 4 suites / 67 tests, and admin-action dispatcher 61 tests after audit wiring. Temporary source-contract mapping was used. No live database race test or broad build was run. Independent review in progress. Activation preflight checks target enablement and optional pre-drain completion; immutable profile/Connector compatibility is checked at submission, followed by locked version/revision/digest/action validation, not by a cross-tenant mutable-profile scan.
- B: implementation delivered. Focused Orchestrator checks: 5 suites / 61 tests passed; Admin Web: 8 tests passed; Connector provider presets: 3 tests passed; typed-chain route regression passed in isolation. Jest checks used transpilation with diagnostics disabled while shared contracts were changing; this is not a typecheck/build result. The typed-retirement mock-query failures were repaired; the complete retirement suite now passes 6 tests. Canonical profile-binding validation repair passed 5 Orchestrator suites / 58 tests, and provider presets passed 3 tests. These overlapping batches are not additive totals.
- C/D: implementation delivered. Focused backend: 7 suites / 63 tests passed using source contracts mapping and disabled ts-jest diagnostics; Admin Web: 39 tests passed. Typecheck/build remain pending. Retention policy is conservative: configured windows bound eligibility for unreferenced terminal artifacts, while referenced results and operation/task/checkpoint lineage remain retained indefinitely. Soft-delete is not a destructive purge. The UI/read models expose retention blockers; this work does not claim bounded storage for retained lineage.
- E: SDK focused suite passed 22 tests; independent worker sample compiled and passed 12 offline tests, including version drain and stale acknowledgement handling. Vendor source/provenance and protocol documentation synchronization are in progress. Independent review pending.
- Independent B/C/D review: four P2 findings returned for fixes: reversed parent/join dependency display; retention policy/cutoff not fenced inside expiry preparation; activation dialog silently substituting a newer revision; direct profile-binding creation bypassing Connector pin validation. C/D repaired the first three and passed 3 backend suites / 9 tests plus 40 Admin Web tests. Canonical profile-binding repair is complete and source-reviewed. A/E and repair re-review are in progress. Group completion is provisional until these repairs and integrated checks pass.
- Integrated tests/build/startup checks: pending.

### Independent review repair round

The reviewer verified the four B/C/D repairs on current source. A/E review returned three additional P2 gaps for repair before integration: newly queued old-version work created after cutover needs durable parked reasons/counts; a lost claim response needs bounded exact-claim reconciliation even after new admission closes; and fresh operation retries must enter the same root-locked/pre-drain admission path while preserving idempotent replay. These remain open until focused regression tests and re-review complete.

### Repair unit gates and integrated handoff

- A follow-up: 6 suites / 26 tests passed for root-locked fresh retry admission, idempotent replay during pre-drain, late pending-work parking, and per-version counts.
- C follow-up: task parking mapper 2 tests and Admin Web 43 tests passed. Missing legacy fields remain unknown; counts reflect tasks rather than outbox rows.
- E final: SDK 24 tests, independently compiled sample 13 tests, and provisioning CAS 2 tests passed. Three business vendors and template match 48 contract and 16 SDK source files; template lock verification covers 92 files. No vendor package dependency boundaries changed.
- Independent repair re-review and integrated ordered build/offline-test/startup pass have started. These counts overlap earlier receipts and must not be added into a single total.

### Integrated verification checkpoint

- Full Contracts, Connector, SDK, Admin Web, three standalone business workers, and independent sample suites are green; exact independent counts and commands are recorded in reports/architecture-hardening-validation-2026-10-13.md.
- All nine Orchestrator build stages and three own-project worker builds passed. A later isolated-restore helper source repair requires a final backend rebuild.
- Isolated startup passed health, migrations, and registration/admission for all three workers; no task/provider call was made. Owned temporary services and containers were cleaned up.
- Full Orchestrator unit gate remains open. Its initial broad run found 87 failing suites; regression repairs are proceeding in disjoint runtime, admin/BFF, and host/package batches. Passing targeted batches do not replace the final full-suite rerun.
- Independent source review closed activation/provisioning, SDK exact-claim recovery, backpressure/AAD, profile pin validation and S3 composition findings. Final restore helper review remains pending.

### Mandatory API compatibility clarification from user

Core and Workflow public APIs must preserve their existing specs and complete old client flows. GET /api/v1/operations/{id} is explicitly mandatory: unchanged authentication, polling/wait behavior, status codes, state/progress, result/error envelope, and download adaptation. Worker/queue/admin refactoring must not require client migration.

Compatibility baseline includes the original app/api/v1 routes and earlier published DU Rework public contracts. Existing source guards returning 404 are not proof that removing a public contract was authorized. Restore supported API-key list, by-id GET/DELETE, cancel, resume, download, and previously published result routes with tenant/key ownership enforced. Keep admin-only surfaces independently authenticated. Audit core sync=true behavior, workflow multipart/schema inputs, profile selection, and output/error serialization. Replace test rewrites that merely accepted unintended removals with regression tests for the preserved client flows.

Final full-suite/build closure is paused pending this compatibility audit and implementation. Prior build/startup evidence remains a snapshot and does not establish old-flow compatibility.

### Additional frontend requirement during final verification

Keep the global tenant selector visible in the left navigation directly below the logo while content or navigation links scroll. Give navigation subitems a clear indentation. Remove redundant copies of the selected-tenant panel/selector from individual pages and tabs while preserving authorization, stale-tenant guards, meaningful per-entity tenancy, and no-tenant/error feedback. C owns this UI scope; A continues resume-CAS runtime verification and B owns public compatibility documentation. Final Admin Web tests/build and complete backend tests must include these final changes.

### Final implementation and review checkpoint

- Desktop sidebar now keeps its logo and global tenant selector outside the independently scrollable navigation links. Nested links have stronger indentation and a visible group rule. Mobile navigation keeps tenant selection available when links are collapsed.
- Removed repeated selected-tenant presentation from individual screens; retained entity ownership, authenticated session scope, tenant-required warnings, and write guards. Admin Web passed 169 tests across 38 suites and its TypeScript/Vite build. No browser visual check was performed.
- Public Core/Workflow and operation routes retain their client contracts. CAS resume additionally checks the stored answer identity before stale-version and terminal-state rejection, so an exact retry remains a replay after operation completion; a different answer/version or a fresh terminal resume remains rejected. Backup gating precedes the operation lock and public access remains tenant/API-key scoped.
- Updated public API documentation and validated all 136 local OpenAPI references without removing existing paths, methods, or schemas.
- Independent read-only review closed the terminal-replay finding and found no remaining actionable P1/P2 in the scoped Runtime/public/UI/docs changes. This is source review, not live compatibility evidence.
- The final ordered nine-stage build passed. The complete Orchestrator offline rerun passed 374 suites / 6,002 tests, with 17 live-gated suites / 147 tests skipped and no failures. Jest required force exit for retained handles; this is recorded separately from test success.
- The final-build isolated startup passed Orchestrator and Connector health, all expected migrations, and registration/admission for Document Core, LC Checker, and Example Review. No jobs were submitted and no provider was called. This verifies startup and registration, not end-to-end client workloads or rendered browser layout. No Docker image was built.
