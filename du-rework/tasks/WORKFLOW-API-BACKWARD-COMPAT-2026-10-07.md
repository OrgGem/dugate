# Workflow API backward compatibility — implementation execution plan

Status: ACTIVE; parent acceptance OPEN. Owner/integrator: Codex. User explicitly authorizes Codex to spawn `gpt-6-luna` with reasoning `max` and implement this plan now. This packet grants dispatch for these scoped subagents; it does not replace the existing coordinator for unrelated tasks. Scope: du-rework only; legacy root read-only. No commit/push without a new instruction for these changes.

## 1. Outcome and scope lock

Implement **only** the missing legacy Workflow API vertical slice:

- `POST /api/v1/docs/workflows` with legacy multipart `process`, file inputs and process-specific variables.
- `POST /api/v1/docs/workflows/schema` with legacy multipart `schemaSlug`, JSON `input`, optional files.
- Carry execution through actual admission, artifacts, pinned configuration, operation/outbox/queue, worker handler, persisted result and existing operation polling/resume/cancel surfaces.

Clients must not switch to `/businesses/...` to obtain compatibility. Business actions may be an internal execution detail. Neither removal of the 503 stub alone nor a handler/manifest declaration closes this task. Schema execution must support legacy schemas rather than mapping selected slugs to unrelated fixed actions.

Non-goals: redesign Portal/Workflow Builder; arbitrary new public APIs; broad unrelated security/test fixes; repository migration; production cutover; paid provider calls; modification/import of legacy production source, DB or environment. Schema catalog storage/loading and a controlled provisioning mechanism are in scope only as prerequisites for executing existing `schemaSlug` requests; GUI authoring is not.

## 2. Authorities and known gaps

Read old `app/api/v1/docs/workflows/{route.ts,schema/route.ts}`, `lib/endpoints/registry.ts`, `lib/pipelines/workflow-engine.ts`, `lib/pipelines/workflows/*`, `lib/workflow-builder/{types,loader,interpreter,binding,real-exec,run-schema}.ts`, operation routes and envelope formatter. Use source behavior as evidence, not filenames or outdated documentation.

Actual legacy named processes: `disbursement`, `lc-checker`, `doc-compare` (`workflow-engine.ts:421`). Existing rework `simple-extraction/multi-step-analysis/transform-compare` mapping is not parity and cannot be substituted.

Current mount recognizes both paths but unconditionally returns 503 before submission (`orchestrator/services/orchestrator/src/compat/legacy-http-mount.ts:404`). Existing business handlers are useful foundations, not proof of old form/result parity. Existing docs saying no route are imprecise; final docs must describe executable behavior or explicit remaining gaps.

## 3. Contract baseline to freeze before integration

WFA-01 owner produces a field/status matrix with old/new file:line and named fixtures. Cover method, multipart aliases/multiple files, trimmed selectors, process variables/defaults, schema loader, optional file behavior, JSON object validation, errors, output formats, progress, async headers, polling/result, HITL/resume/cancel and profile prompt/connector pins.

Successful initial submit preserves `202`, `Operation-Location: /api/v1/operations/{id}`, `name: operations/{id}`, `done: false`, workflow/schema-specific `metadata` fields from old route. IDs and timestamps are normalized only for comparison; do not silently alter other fields. Old workflow route source ignores `Idempotency-Key` and `?sync`: each accepted request creates a fresh operation and returns 202. Reuse submission transactions/outbox safety but do not introduce canonical public replay or synchronous semantics for these endpoints.

Security exceptions: require authenticated active public API key and tenant/profile/action authorization. Never reproduce fallback to oldest ADMIN API key or allow body `apiKeyId` to select another principal. If supplied, body key must be validated as the authenticated caller's key or rejected; exact safe behavior must be captured in matrix and tests. This intentional exception is not full insecure wire equivalence. No arbitrary code execution, insecure archive extraction, plaintext secret projection, unapproved SSRF/callback destinations, unbounded DAG/files/fanout or DB reads that bypass tenant fences. Keep real-data encryption policy intact.

## 4. Task/lease ledger

| ID | Scope and outputs | Owner lease | State | Dependency |
| --- | --- | --- | --- | --- |
| WFA-01 | Old-source inventory, parity matrix, fixture requirements and interface handoff | API subagent; report `coordination/reports/wfa-api-contract-2026-10-07.md` | RUNNING | None |
| WFA-02 | Both legacy HTTP paths, decoders, named-process adapter, real submission/artifact/profile wiring and legacy response | API subagent: `orchestrator/services/orchestrator/src/compat/`, `src/http/routes/public.ts`, `src/http/route-context.ts`, `src/app/bootstrap/`, `src/modules/operations/` only as required; own tests `tests/wfa-api-*.test.ts` | RUNNING | WFA-01; WFA-03 interface |
| WFA-03 | Versioned tenant-scoped schema read/provision/pin contract; legacy schema validation/bindings; durable worker execution of node primitives and HITL | Runtime subagent: new contracts `orchestrator/packages/contracts/src/legacy-workflow*.ts`, exports in `src/index.ts`; new `services/orchestrator/src/modules/workflow-schemas/`, dedicated migration if required; `businesses/document-core/src/pipelines/workflows/schema/`, necessary worker/manifest wiring; named workflow adapters in document-core/lc-checker; own `wfa-runtime-*` tests | RUNNING | Read old behavior; handoff to WFA-02 |
| WFA-04 | Independent parity tests through HTTP and real new service composition; isolated PG/Redis + worker execution with local mock providers | Verification subagent: `tests/workflow-api/` only plus report `coordination/reports/wfa-verification-2026-10-07.md`; product source read-only | RUNNING | Fixtures can start now; executable tests after WFA-02/03 |
| WFA-05 | Integrate seams, reject fake success, run build/contracts/offline and isolated end-to-end; fix returned owner findings | Codex integration; no overlapping source edit while lease active | RUNNING | WFA-02/03; interim receipt exists, runtime gates OPEN |
| WFA-06 | Update workflow API spec, parity matrix, generated OpenAPI and user-facing setup examples | Codex: relevant sections of `docs/06-public-api.md`, `docs/39-legacy-parity-contract.md`; generator `tools/openapi/*` and generated `docs/21-openapi.json` only after implementation; new receipt | RUNNING | Facade docs/generated OpenAPI validated; executor/setup evidence pending |

Shared exports/modules above have one named owner. API agent does not edit schema modules/contracts/worker wiring. Runtime agent does not edit HTTP/bootstrap/submission files. If an extra shared file is necessary, send a handoff request before writing; integrator assigns it. Tests import real production modules; mocks replace external transports/providers, not the behavior under test.

Lease extension granted to `/root/workflow_api`: `orchestrator/services/orchestrator/tests/legacy-http-mount.test.ts` and `tests/rv01-loopback-http-offline.test.ts` to replace obsolete unconditional-503 assertions. Do not delete/skip assertions merely to obtain green; exercise configured behavior and appropriate unconfigured failures.

Lease extension granted to `/root/workflow_runtime`: minimal additive catalog slot in `orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto.ts` and `orchestrator/packages/contracts/src/encryption-persistence.ts`; preserve allowlist equality, old slot semantics and tenant/ref AAD validation. Bootstrap injection remains API-owner lease. Catalog full schema is secret-bearing metadata and must not introduce unprotected persistence or downgrade fallbacks.

Lease extension granted to `/root/workflow_api`: `orchestrator/services/orchestrator/src/modules/artifacts/artifacts.ts`, narrowly for compensation of newly uploaded, tenant-owned, unlinked workflow inputs when admission fails. Enforce atomic reference/ownership checks, complete storage cleanup or durable cleanup retry; never delete pre-existing/client artifacts or storage-less DB-only compensation.

Runtime test lease confirmed: `orchestrator/services/orchestrator/tests/persistence-encryption-freeze.test.ts` plus owned `wfa-runtime-schema-catalog.test.ts` and `businesses/document-core/tests/wfa-runtime-schema-executor.test.ts`. New schema-catalog purpose must be accepted consistently by type/runtime/contract validators and covered by encryption/AAD tamper tests; old slots/AAD semantics remain unchanged. Independent tests use injected synthetic key provider, never plaintext catalog fallback.

Runtime lease extension: `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts` and owned `wfa-runtime-progress*.test.ts` for workflow progress projection. Fence lease, ownership, root-vs-child attribution and terminal state. Progress must not mutate execution finish timestamps. Persisted stage messages are bounded/non-secret; any content-bearing step results require encryption and authorized read projection, never plaintext preview storage.

Progress lease subsequently transferred to parent after runtime owner confirmed no pending edits. Parent additionally owns the narrow progress branch in `src/http/routes/runtime.ts` to pass authenticated worker business identity. Implemented live lease/business/root/terminal/cancel fences and fixed non-secret labels; new progress plus existing cancel-heartbeat tests pass 22/22 on Node 24.21.0, backend typecheck exit 0. Independent live projection evidence remains required.

Real encrypted HITL replay exposed SDK/server double sealing. Parent owns narrow `orchestrator/packages/contracts/src/runtime.ts` upload-grant extension, `packages/worker-sdk/src/task-context.ts` single-PUT negotiation and `tests/wfa-server-sealing.test.ts`; API owner owns matching grant minting in artifacts.ts. Optional authenticated runtime `storageEncryption:'server'` is emitted only with configured server encryption and server-mediated upload. SDK then sends internal plaintext for server encryption at rest (explicitly allowed by the user); absent mode retains existing worker sealing/refusal behavior. Never infer trusted mode from URL or accept it as caller policy. Independent ciphertext/sidecar readback and HITL/parallel replay are required.

Named LC implementation decision: keep `lc-checker/lc-checker` mapping with an explicit validated legacy input discriminant/adapter where safe. Existing rule-checker semantics remain intact for canonical inputs; legacy adapter preserves OCR → original-document hybrid verification → report semantics. Do not manufacture empty reference data to satisfy a stricter rule-engine schema. Document business manifest/version/profile-slot provisioning changes instead of silently changing a published registration.

## 5. Producer/consumer interface

Additional leases granted during implementation: API owner may narrowly edit `orchestrator/services/orchestrator/src/compat/legacy-public-artifact.ts` for partial-upload compensation before an artifact ID exists, with durable cleanup and ownership fences. Runtime owner may add the existing `@du/egress` workspace dependency in `businesses/document-core/package.json` for socket-pinned authenticated URL download/callback handling. Workspace lockfile integration remains the parent integrator's lease. No raw fetch fallback or broad package upgrades are authorized.

LC adapter lease transferred from runtime owner to `/root/workflow_api` after API implementation handoff: necessary `businesses/lc-checker/src/` worker/manifest/types, new legacy provider-chain adapter, and owned `wfa-lc-*` tests. Runtime owner confirmed no LC edits before transfer. Canonical rule-checker inputs must retain existing semantics; the explicit legacy discriminant selects the old document-layout, hybrid verification and content-generation chain. Document-core schema/named adapters remain runtime-owner lease.

Connector name-to-profile-slot mapping must be explicit and immutable with the admitted schema/profile pin. Sorting arbitrary connector names into numbered slots without a persisted mapping is insufficient: adding a name must not silently change which configured provider an existing name selects.

API owner and runtime owner agree typed schema lookup result containing authenticated tenant, slug, immutable revision/digest and validated schema. Admission must persist that pin/snapshot and normalized artifact refs into the operation/task input. Worker uses the admitted snapshot, not a mutable latest schema lookup mid-run. API owner owns insertion into existing submission lifecycle; runtime owner owns schemas, validator, executor and dedicated catalog module.

User follow-up confirms the architectural question about legacy workflow parameters mapping to business routes. Decision: preserve legacy public routes/parameters/envelopes and map internally to business/action through the shared admission/submission service. Never redirect clients or make loopback HTTP requests to `/businesses/...`. The schema route maps to a generic schema executor with an admitted immutable pin, not a list of fixed slug aliases.

Named process adapter preserves old request variables and files, translating to existing workflow handlers without silently dropping fields or changing business semantics. Record any irreducible semantic difference as a finding, not a fake mapping. Reuse durable steps, child tasks, artifacts and checkpoint APIs to avoid holding a parent queue slot while waiting on children.

Legacy node inventory: connector, parallel, join, file_parse, file_url_download, callback, archive_compress, archive_extract, human, input. Enumerate nested nodes, binding expressions, output selection, connector/profile overrides, input defaults, error/abort behavior and old sequential-flow semantics. Every supported old node gets an executable test. Unsupported-node rejection alone does not close schema parity.

## 6. Acceptance matrix

| Test IDs | Acceptance |
| --- | --- |
| WFA-T01..03 | Multipart named submissions for all three real processes return old 202/header/envelope and enqueue the correct real workflow; no silent alias to six document actions. |
| WFA-T04..08 | Missing process, unknown process, missing required files, invalid multipart/limits, invalid process variable match approved error contract and produce no orphan operation/queue/artifact publication. |
| WFA-T09..13 | Schema missing slug, unknown slug, invalid schema, invalid JSON/nonobject input, fileless valid input-only schema; successful response matches old schema envelope. |
| WFA-T14 | Schema revision pinned at admission; concurrent update does not change admitted job or resumed execution. |
| WFA-T15..24 | Each of ten legacy node types executes with real runtime adapters and safe bounded behavior; parallel/join nested dependencies and bindings/output selection covered. |
| WFA-T25..28 | Human pause/resume retains prior node results, restart/retry avoids completed side effects, cancellation aborts children/provider work, terminal output visible via old polling/result/download contracts. |
| WFA-T29..32 | No/malformed/inactive key rejected; tenant/profile/action authorization; mismatched body apiKeyId denied; no ADMIN-key fallback. |
| WFA-T33..36 | SSRF/egress and callback policy, unsafe archive/path/prototype bindings, file/DAG/fanout size bounds, secret/payload log redaction fail closed. |
| WFA-T37 | Schema provision/load path documented and exercised on fresh isolated DB, including missing/retired revisions and tenant isolation. |
| WFA-T38 | OpenAPI generated from implementation includes both workflow request/response/error contracts; docs distinguish verified parity from approved exceptions. |

Exact cases may expand after source inventory. Case IDs cannot disappear merely because they are difficult. No bulk skipped suite counts as PASS. A pure builder test or mocked host response does not prove write/queue/worker integration.

## 7. Validation and evidence

Node >=24.21.0 <25, pnpm 10.18.3; commands run from canonical promoted paths. Use fresh isolated DB/schema, Redis prefix/namespace, synthetic documents and loopback mock providers; no production or legacy DB. Preserve concurrency/resource claims for any shared resource. Each receipt records command/cwd/Node, pass/fail/skip/exit, test IDs and raw logs; no secrets.

Run contracts, focused source tests, Portal/backend/worker typechecks and production build. Independent verifier must drive both legacy HTTP entrypoints to worker completion and old polling, plus at least one schema HITL resume/restart case. Failure receipts remain OPEN. Do not report all-platform acceptance from this API-only plan.

## 8. Completion gate

Distinguish SPECIFIED, IMPLEMENTED, independently VERIFIED and ACCEPTED. Parent stays OPEN until all acceptance rows have real evidence or an explicitly documented approved security exception. No hidden mapping subset, unconditional 503, queue-only success, worker-only implementation or docs-only endpoint declaration can close it. Independent review of schema execution/security is required before release; no cutover in this task.

## 9. Dispatch evidence

Actual subagents created through collaboration.spawn_agent (not a paper dispatch), all `gpt-6-luna`, reasoning `max`:

| Agent ID | Task | Active lease |
| --- | --- | --- |
| `/root/workflow_api` | WFA-01/02 | API contract report, compat/public/bootstrap/operation integration and `wfa-api-*` tests |
| `/root/workflow_runtime` | WFA-03 | Schema contracts/catalog/migration, worker/manifest/named adapters and `wfa-runtime-*` tests |
| `/root/workflow_verify` | WFA-04 | `tests/workflow-api/` and independent verification report; product source read-only |

WFA-01/02/03/04 are dispatched and awaiting owner checkpoints; creation is dispatch proof, not completion proof. This plan is supervised by Codex under the explicit user request. No automatic scheduler created and no unrelated fleet lease reassigned.
