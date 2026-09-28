# W39-CX Codex Lane Report â€” P0-01 then P0-03

Lane: Codex (fifth lane, term_95378d30-e4fc-40f1-bc0c-e6256a71be91). DB: NO DB USED (offline docs lane; never held the shared window, no DB/Redis touched).
Scope: own only du-rework/businesses/document-core/docs/traceability-matrix.md, authorization/actor corrections in du-rework/docs/01-product-scope.md, du-rework/tasks/P0-business-specs.md, and this report. No source/test edits, no commit/push.

## Files changed

- du-rework/coordination/reports/codex.md (NEW, this file)
- du-rework/businesses/document-core/docs/traceability-matrix.md (stale markers corrected, evidence re-pointed; PENDING this turn)
- du-rework/docs/01-product-scope.md (actor/authorization corrections only; PENDING this turn)
- du-rework/tasks/P0-business-specs.md (P0-01 row left unchecked with gaps; PENDING this turn)

## Commands run (rg verification, W38-CX + W39-CX)

- rg -n "BR-0[1-9]|BR-1[012]" du-rework/businesses/document-core/docs/traceability-matrix.md
- rg -n "du-business-document-core|du:business:document-core" du-rework/businesses/document-core/tests du-rework/businesses/document-core/src du-rework/packages/contracts/src
- rg -n "queue|businessId|version" du-rework/businesses/document-core/src/manifest/document-core.manifest.ts
- rg -n "businesses/:id/versions|/enable" du-rework/services/orchestrator/src --glob "*.ts"
- rg -n "pendingHash" du-rework --glob "*.ts"
- rg -n "ADMIN_TOKEN|RUNTIME_TOKEN" du-rework/services/orchestrator/src du-rework/services/connector/src du-rework/packages/worker-sdk/src
- rg -n -i "admin.*token|runtime.*token|api.?key|bearer|authorization|fail.closed|fail.open|dev.*fallback" du-rework/services/orchestrator/src/server.ts
- rg -n "describe(|(it|test)(" du-rework/businesses/document-core/tests/cross-service-boundary.test.ts du-rework/businesses/document-core/tests/bullmq-smoke.test.ts du-rework/businesses/document-core/tests/checkpoint.test.ts du-rework/businesses/document-core/tests/checkpoint-replay.test.ts du-rework/businesses/document-core/tests/cancellation-fencing.test.ts du-rework/businesses/document-core/tests/package-boundary.test.ts
- rg -n "rejects blind retry|INVOCATION_UNKNOWN" du-rework/businesses/document-core/src/worker.ts du-rework/businesses/document-core/tests/provider-backed-variant.test.ts
- rg -n "describe(|(it|test)(" du-rework/businesses/document-core/tests/provider-backed-variant.test.ts
- rg -n "describe(|(it|test)(" du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts
- rg -n "R08-01" du-rework/services/orchestrator/src/server.ts du-rework/services/orchestrator/tests du-rework/docs/15-decisions.md
- rg -n "test(|it(" du-rework/services/orchestrator/tests/runtime.test.ts
- rg -n "artifacts|invocation-grants|grant" du-rework/services/orchestrator/src/server.ts
- rg -n "enable|api/v1/admin/businesses|scoped API key|api.*key" du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts
- rg -n "/children|/wait|/resume|/continuation" du-rework/services/orchestrator/src/server.ts
- rg -n "describe(|(it|test)(" du-rework/businesses/example-review/tests/example-review-continuation.integration.test.ts
- rg -n -i "quota" du-rework/services/connector/src du-rework/services/orchestrator/src du-rework/businesses/document-core/src
- rg -n "202|Accepted|accept" du-rework/services/orchestrator/src/server.ts
- rg -n "TTL|ttl" du-rework/businesses/document-core/docs/traceability-matrix.md
- Focused tests: cd du-rework/businesses/document-core; npx jest tests/manifest.test.ts tests/traceability.test.ts --runInBand => 2 suites PASS, 12 tests PASS.

## BR-01..BR-12 evidence (one row each; literal test names confirmed by rg)

- BR-01 Six actions, one business: du-rework/businesses/document-core/tests/manifest.test.ts :: "manifest declares all 6 actions" + "recipe registry contains exactly 28 unique variants". Also tests/traceability.test.ts :: "contains exactly 28 unique documented variants spanning DOC-01 through DOC-06". Also tests/all-variants-e2e.test.ts :: "Deterministic 28-Variant Full-Business Local E2E Matrix (WORKLOAD-REBALANCE-04, P5-06)" / parametrized "${entry.brdCaseId} (${entry.action}/${entry.variant}): executes E2E and validates output artifact". Owner Business (document-core). UC-02, UC-03.
- BR-02 Plugin via registration: du-rework/businesses/example-review/tests/manifest.test.ts :: "validates the manifest and derives the expected BullMQ queue" (expects du-business-example-review-1.0.0). Also du-rework/businesses/document-core/tests/cross-service-boundary.test.ts :: "confirms documentCoreManifest registers queue compatible with multi-container deployment". Live enable proven in du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts :: "Cross-Service Process E2E (Orchestrator + Connector + Document-Core Worker)" via PUT /api/v1/admin/businesses/:id/versions/:version/enable (server.ts line ~621, test line ~424). UC-02, UC-05.
- BR-03 Profile-driven routing: du-rework/businesses/document-core/tests/profile-binding-fixture.test.ts :: "derives declared reasoning slot for extract, analyze, transform, generate, compare" + "binds all six actions with manifest-accurate slots and chains profileId". Also du-rework/services/orchestrator/tests/runtime.test.ts :: "W13-C/PRF-01: profile-mode key submitting an unauthorized action gets 403 and nothing is enqueued" + "W13-C: pinned operations grant the pinned connector, and claims carry the pin". GAP SUB-SCOPE: no dedicated test name found proving client prompt-override rejection (rg "prompt.*override" empty outside a results.ts type field); prompt precedence claim in compatibility-matrix rests on provider-backed-variant facade test, not a negative override test. UC-02, UC-03.
- BR-04 Async operations/polling: du-rework/businesses/document-core/tests/bullmq-smoke.test.ts :: "proves queue consumption, claim, step execution, completion and drain against Redis 6380". Also du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts :: "submits extract/invoice through live Orchestrator, processes via real Connector pipeline and mock provider, asserts ledger, outbox, usage, artifact, and step checkpoints". 202 fast-submit in server.ts (~line 490). UC-03, UC-04.
- BR-05 Artifact lifecycle: du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts :: same main E2E test above (upload grant, blob, access grant paths exercised). Grant expiry exists (artifacts.ts GRANT_TTL_MS 15 min). EVIDENCE MISSING for: S3/blob TTL cleanup sweep and tenant disk quotas â€” no test name found (rg ttl/sweep/quota in orchestrator artifacts module returns only grant expiry; zip-extractor test covers zip parsing, not lifecycle). UC-03, UC-05. PARTIAL.
- BR-06 Checkpoints/replay: du-rework/businesses/document-core/tests/checkpoint.test.ts :: "RUN-04: preserves full step output >500 characters intact without truncation" + "RUN-04: resumes completed step without re-executing callback on duplicate delivery". Also tests/checkpoint-replay.test.ts :: "P5-04: executeWithCheckpoint restores complete output without re-executing callback on replay" + "P5-04: Multi-step pipeline replay avoids repeating provider calls for completed steps". UC-04, UC-08.
- BR-07 Workflow ownership (fan-out/HITL): du-rework/businesses/example-review/tests/child-review.test.ts + approval-wait.test.ts (business baseline, mock-level). Live continuation now exists: du-rework/services/orchestrator/tests/runtime.test.ts :: "W13-C/children: spawn to WAITING_CHILDREN to GET children to join completes exactly once" + "W13-C/wait+resume: wait opens WAITING_INPUT; resume validates, CAS-guards, and re-queues". Routes confirmed: POST /api/runtime/v1/tasks/:id/children, GET children, POST wait-input, POST /api/v1/operations/:id/resume. Stale W09-C2-pending marker must be corrected to W13-C-delivered. UC-05, UC-06.
- BR-08 Cancel/resume race control: du-rework/businesses/document-core/tests/cancellation-fencing.test.ts :: "action 2 (extract) does not invoke connector or write artifacts when lease is lost" + "StepCheckpointManager.assertActive throws LeaseLostError when signal aborted due to lease loss" + "in-flight abort mid-execution prevents final artifact write and terminal success report". Also orchestrator runtime.test.ts W27-C cancel/resume race tests. UC-06, UC-08.
- BR-09 Connector gateway/quotas: du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts :: main E2E (real Connector, ledger, quota, outbox). Also du-rework/services/connector/tests/reliability-security.test.ts :: "HTTP maps quota and provider failures to stable statuses". Hash parity landed: du-rework/packages/contracts/tests/invocation-hash.test.ts :: "is stable for identical wire fields" + "carries the sha256: prefix"; du-rework/services/connector/tests/canonical-hash-parity.test.ts :: "connector digest equals the contracts digest for the same wire fields". Stale pendingHashes-shim marker must be corrected (W11-C1 canonical hash landed). UC-01, UC-04.
- BR-10 Dynamic admin config: du-rework/businesses/document-core/tests/manifest.test.ts :: "validates documentCoreManifest strictly against @du/contracts v1 validator". Also du-rework/businesses/example-review/tests/manifest.test.ts :: "declares review action with strict 1..10 artifact input schema and output schema". Admin enable path covered by multi-container enable test above. UC-01, UC-02.
- BR-11 Traceability: du-rework/businesses/document-core/tests/traceability.test.ts :: "every variant maps to a declared action in documentCoreManifest" + "every variant maps to an exact registered recipe in RecipeRegistry". End-to-end correlation in multi-container main E2E test (ledger, outbox, usage, artifact, checkpoints asserted in one flow). UC-03, UC-08.
- BR-12 Isolation: du-rework/businesses/document-core/tests/package-boundary.test.ts :: "contains zero source imports of internal services or unapproved packages in src/" + "declares only approved shared public packages in dependencies". Cross-tenant/auth fencing in du-rework/services/orchestrator/tests/runtime.test.ts :: "R08-01: unknown and revoked API keys are denied fail-closed" + "R08-01: admin and runtime credentials cannot substitute for each other" + "cross-tenant cancel to 404 (no information leakage)". Stale fail-open marker must be corrected (R08-01 fail-closed landed). UC-02, UC-05.

## Actor and authorization matrix (fail-closed expectations)

- Tenant caller (API client, X-API-Key): may submit/poll/fetch-result/cancel only within its tenant/profile/operation. Fail-closed: missing/unknown/revoked key => 401 UNAUTHENTICATED; cross-tenant access => 404 (no leakage); unauthorized action for profile-mode key => 403 and nothing enqueued (W13-C/PRF-01). Evidence: runtime.test.ts R08-01 unknown/revoked denial, PRF-01 403, cross-tenant cancel/resume 404. Forbidden: admin endpoints, task claim/progress, direct connector invocation.
- Admin / operator: admin bearer token (ADMIN_TOKEN) for registry/connector/profile/enable/sweep; operator role is a UI/nav scope (admin view-models: operator sees businesses/operations/profiles/connectors) not a separate service credential. Fail-closed: no admin token => 401 on every admin request; runtime token never substitutes (401); enable/profile-bindings reject missing admin auth; unsafe equal admin/runtime tokens refuse boot. Evidence: server.ts requireAdmin/requireRuntime + boot guard; runtime.test.ts "enable rejects missing admin auth", "enable rejects runtime token (401) â€” role substitution denied", "profile-bindings rejects missing admin auth", "R08-01/W11-C1: unsafe credential configuration is rejected". Operator-only runtime endpoints are PLANNED (no service route); do not claim them. Forbidden: bypass audit, expose raw connector secrets, inject unvalidated worker code.
- Runtime worker (RUNTIME_TOKEN, business-scoped): may claim assigned-queue tasks, heartbeat/renew lease, request artifact upload/access grants, request invocation grants, report checkpoints/terminal status. Fail-closed: missing/invalid runtime token => 401; stale/expired lease => 409 LEASE_LOST; undeclared slot => 409 BINDING_DENIED; differing inputHash for same (task, step, slot) => 409 INPUT_HASH_MISMATCH (never a new provider call); terminal-task ops => 409/410. Evidence: grants.ts issue() fencing; runtime.test.ts R08-02 stable-identity/conflict, W12-C expired-lease/stale-lease denials, W13-C BINDING_DENIED. Forbidden: admin APIs, other-business queues, direct DB, direct blob write without grant.
- Connector boundary: verifies HS256 signed invocation grants (canonical hash W11-C1), dedupes by (task, step, slot) identity via ledger, enforces quota (RedisQuotaStore, QUOTA_EXHAUSTED), standardizes error codes, never receives raw credentials via proxy test path. Fail-closed: unsigned/expired/mismatched grant => deny; quota exhausted => stable 429 path; UNKNOWN provider outcome => INVOCATION_UNKNOWN non-retryable (no blind retry). Evidence: invocation-hash + canonical-hash-parity tests; provider-backed-variant "rejects with non-retryable INVOCATION_UNKNOWN..." (4 tests); reliability-security "HTTP maps quota and provider failures to stable statuses". Forbidden: direct worker DB access, unsigned invocation, credential forwarding.

## Stale claims corrected (traceability-matrix.md)

- Queue name: "du:business:document-core:1.0.0" (colon form) does not exist; canonical form per packages/contracts queue.test.ts + manifest.test.ts is "du-business-document-core-1.0.0" (businessQueueName). Correct BR-04, UC-07 rows.
- Registration route: "PUT /api/runtime/v1/businesses/:id/versions/:version" does not exist; real route is "PUT /api/v1/admin/businesses/:id/versions/:version/enable" (server.ts ~621, multi-container test ~424). Correct BR-02 row.
- W10-C1 fail-open auth marker: STALE. R08-01 fail-closed landed â€” server.ts requireAdmin/requireRuntime + boot refusal on equal tokens; runtime.test.ts R08-01 trio + enable-rejects-runtime-token. Correct BR-12 row, API Client row, Administrator row, and section-3 IMPORTANT box.
- W09-C2 typed continuation marker: STALE as "pending". Live child/wait/continuation contract landed as W13-C â€” POST/GET children, POST wait-input, POST operations resume; runtime.test.ts W13-C children/wait/resume suites + example-review-continuation P7-T3..T9 + version-coexistence P7-06. Correct BR-07 row and UC-06 row (PARTIAL only for zero-downtime v1/v2 drain breadth, not for continuation itself).
- pendingHashes shim marker (BR-09): STALE. Canonical hash landed (W11-C1): hashInvocationInput + canonical-hash-parity + R08-02 stable identity. Correct BR-09 row.
- UC-08 test citation: matrix text "rejects blind retry on INVOCATION_UNKNOWN" does not match any literal test name; real names are "rejects with non-retryable INVOCATION_UNKNOWN when connector state is UNKNOWN" (and 3 siblings) in provider-backed-variant.test.ts. Correct UC-08 row.
- Package names: "@du/example-review" and "@du/document-kit" (not "example-review" bare / "connector SDK" vague); BusinessManifestSchema from @du/contracts. Correct overview + BR-02/BR-05/BR-10 rows.

## P0-01 decision

P0-01 stays [ ] (unchecked). Reason: BR-05 artifact TTL cleanup sweep + tenant disk quotas have no executable test (EVIDENCE MISSING); UC-07 zero-downtime v1/v2 drain has no dedicated drain test (version pinning proven, drain deferred); Operator service endpoints are view-model-only with no runtime route/test. All other BRs have at least one rg-confirmed test path + literal test name above. Do not tick P0-01 until those three gaps get tests or the acceptance is narrowed in writing.

## P0-03 start (characterization/compatibility from legacy public handlers)

Legacy handlers confirmed present: app/api/v1/docs/{ingest,extract,analyze,transform,generate,compare}/route.ts, lib/endpoints/registry.ts, lib/endpoints/runner.ts, lib/pipelines/engine.ts. Normalizer + characterization tests confirmed: du-rework/businesses/document-core/src/validation/input-normalizer.ts, tests/bounded-input.test.ts (incl. "Compare Input Normalization & source_file / target_file Aliases (P0-03)" block with CONFLICTING_COMPARISON_PARAMETERS / AMBIGUOUS_COMPARISON_SIDE / INVALID_COMPARISON_SIDE cases), tests/all-variants-e2e.test.ts, tests/output-validation.test.ts. Next: verify each row of businesses/document-core/docs/compatibility-matrix.md against those sources with rg, then decide P0-03 honestly. NO DB USED.

W39-CX part 1 (report + P0-01 audit) recorded; part 2 (P0-03 matrix + doc corrections) in progress. Idle after corrections land, no commit/push.

## P0-03 verdict

P0-03 stays [ ] (unchecked). Alias rows proven (normalizer + bounded-input compare block + transform legacy alias + 28-variant E2E). Error-table rows for PROVIDER_TIMEOUT/RATE_LIMITED/ARTIFACT_NOT_FOUND/UNSUPPORTED_FORMAT/VALIDATION_ERROR lack literal document-core test names; narrow the table or add tests. Same _prompt negative-test gap as BR-03. NO DB USED.

## P0-03 evidence detail (legacy vs document-core, rg-verified)

Legacy base: app/api/v1/docs/{ingest,extract,analyze,transform,generate,compare}/route.ts are thin runEndpoint pass-throughs (compare/transform heads read). lib/endpoints/registry.ts PARAMS has output_format/reference_data/target_language/redact_patterns/max_words; discriminators mode/type/task/action/mode; subcases id-card/receipt/fact-check. lib/endpoints/runner.ts reads form fields source_file/target_file/file/file_urls/output_format/webhook_url, headers x-api-key/x-correlation-id/idempotency-key, sync flag, apiError envelope. lib/pipelines/engine.ts imports db directly and truncates content_preview to 500 chars (line 370). lib/pipelines/workflows prompts use _prompt bypass (workflows README + prompt files).

New base: input-normalizer.ts maps outputFormat/output_format, referenceData/reference_data, targetLanguage/target_language, redactPatterns/redact_patterns, maxWords/max_words, artifactIds/artifact_ids/file_ids, action-to-variant (lines 160-168), parseComparisonSide with CONFLICTING/AMBIGUOUS/INVALID/MISSING codes; emits MISSING_DISCRIMINATOR/INVALID_DISCRIMINATOR/TOO_MANY_ARTIFACTS. Tests: bounded-input Compare Input Normalization block (9 literal tests incl. maps legacy source_file and target_file string aliases to artifactId objects; rejects conflicting canonical parameter and legacy file alias with CONFLICTING_COMPARISON_PARAMETERS; rejects ambiguous comparison side with both artifactId and text with AMBIGUOUS_COMPARISON_SIDE); transform.test.ts DOC-04-v1..v5 plus rejects translate without targetLanguage; all-variants-e2e literal VARIANT_TRACEABILITY_MATRIX contains exactly 28 variants; output-validation literal rejects null and undefined provider data with EMPTY_PROVIDER_OUTPUT (+MALFORMED/SCHEMA variants); checkpoint RUN-04 full-output tests; package-boundary zero-service-import tests.

Gaps blocking P0-03 [x]: (1) compatibility-matrix section 5 error rows VALIDATION_ERROR/UNSUPPORTED_FORMAT/PROVIDER_INVALID_RESPONSE/PROVIDER_TIMEOUT/RATE_LIMITED/ARTIFACT_NOT_FOUND have no literal document-core test hits (rg UNSUPPORTED_FORMAT and ARTIFACT_NOT_FOUND empty in tests; VALIDATION_ERROR only as SCHEMA_VALIDATION_ERROR; PROVIDER_INVALID_RESPONSE zero; PROVIDER_TIMEOUT/RATE_LIMITED live in connector tests only). Fix: narrow table to evidenced codes or cite connector/orchestrator suites. (2) _prompt negative test missing (same as BR-03 gap). (3) file_urls discontinued-by-absence (rg file_urls empty in new src) has no explicit rejection test. P0-03 stays [ ]. NO DB USED.

## P1-03 start (OpenAPI docs survey, documentation only)

Acceptance: validator checks request/response examples, pagination/status/auth. Survey: docs 06-public-api.md (base /api/v1, x-api-key, catalog submit/poll/artifacts/operations, Idempotency-Key scope, problem+json) vs server.ts routes (POST /api/v1/businesses/:id/actions/:action, /api/v1/operations*, /api/v1/usage/summary, /api/v1/connectors/:id/test, PUT /api/v1/admin/.../enable|activate|deactivate, POST /api/v1/admin/profile-bindings, runtime /api/runtime/v1/*, GET /health + /api/v1/health). Mismatches: docs 07-internal-api.md says base /api/internal/v1 with POST enable/drain/retire, but server implements /api/v1/admin/* with PUT enable/activate/deactivate; docs 08-connector-api.md says base /internal/v1, but connector http/server.ts implements /invocations*, /connectors/:id/test, /health/live|ready. No OpenAPI yaml/json artifact exists under du-rework (only infra/docker compose yamls). P1-03 stays [ ]; next is authoring versioned OpenAPI descriptions + examples under du-rework docs with route reconciliation. NO DB USED.

## P1-03 doc (W39-CX3, code-derived OpenAPI prose)

New file: du-rework/docs/20-openapi-descriptions.md (human-readable tables for public/admin/runtime/connector, every row cites server.ts or connector http/server.ts line + contracts schema). P1-03 stays [ ]; no openapi.yaml/json under du-rework and no example validator, so acceptance unmet. ABSENT lists mark documented-but-unimplemented routes as absent, not aspirational. Did not touch tasks/P0-business-specs.md (concurrent-lane rule) or tasks/P1-foundation-contracts.md (dirty from another lane, sequencing left to orchestrator). NO DB USED.

## W40-CX (P1-03 machine-readable + P0-01/03/06 limits + compat fixes)

Parent tasks: P1-03 (validator checks examples/pagination/status/auth); P0-01 (each BR owner+scenario+test); P0-03 (aliases/status kept-fixed-deferred); P0-06 (benchmarks as assumptions, no prod SLA). Sources: server.ts route table (health 315, submit 559, ops 591-663, connectors test 378, runtime 348-555, admin 666-736), connector http/server.ts (80-156, errmap 216-240), facade.ts MAX_WAIT_SECONDS=30 (lines 16,66-71), contracts zod schemas. Commands: python gen_openapi.py (exit 0, 41 paths) + python validate_openapi.py (exit 0, 5/5 PASS: SubmissionSchema, OperationViewSchema, ResultEnvelopeSchema, InvocationRequestSchema incl. grant field, SaveStepRequestSchema) on Node v22 + Windows host; no DB used. New: du-rework/docs/21-openapi.json (openapi 3.0.3, x-absent list) + prose docs/20-openapi-descriptions.md (credited inventory). P1-03 decision: tick ONLY if validator + machine-readable doc are accepted as meeting acceptance; file is new and unreviewed, recommend reviewer confirms before ticking. P0-01 stays [ ] (BR-05 TTL/quotas, UC-07 drain, operator routes lack tests). P0-03 stays [ ] (error-table codes + _prompt/file_urls gaps). P0-06 stays [ ] (workload-assumptions.md is explicit TARGET/UNENFORCED mix with no prod SLA; P8-05 depends on it). Compat fixes applied in owned compatibility-matrix.md only: generic-submission router + wait-30 corrections; release report (unowned, other lane) NOT edited. Historical suite/test totals from the review (P8-01/07/08 PARTIAL) NOT reused as fresh evidence. NO DB USED. Task-row edits: single-line comments only on P0-03/P0-06/P1-03 rows after reread; P0-05 untouched (Agent-6).

## W40-CX2 (RV-03 audit rebuild, canonical BR-01..12)

Parent: P8-01 (PARTIAL, RV-03). Scope: rebuilt docs/19 section 2 against docs/01-product-scope.md BR-01..12 only; prior BR-13..30 labels voided to NEEDS-ID/SCOPE-DECISION (2.2); ten review-listed paths verified Test-Path False and recorded ABSENT (2.1) with actual locations; every row carries actual source path + actual test path + literal test name + class (unit/integration(DB)/integration(live)) + unresolved subrequirement. Mermaid BR-01..30 relabeled canonical BR-01..12. Compat corrections (generic submission server.ts:559, wait cap facade.ts MAX_WAIT_SECONDS=30) recorded in 2.3 + compatibility-matrix.md. Sections 3-5 retained as explicitly-labeled history, not fresh evidence; no 80/644 totals reused. Gaps restated: BR-03 prompt-override negative, BR-05 TTL/quotas, P0-06 assumptions, operator routes. Document only, no source/test edits. NO DB USED.

## Status check (RV-03 finished? P1-03 next?)

1) RV-03 rebuild is FINISHED as a document edit, not as acceptance: section 2 has 26 rows BR-01..BR-12, each with verified source path + test path + literal test name + class; old BR-13..BR-30 rows are GONE (only mentioned as voided labels in 2.2 + header note); the ten invalid paths appear ONLY in the ABSENT list (lines 68, 103-106), never as cited evidence. I am agentgw-gpt-5.6-terra, provided by agentgw.cloud. 2) P1-03 next: docs/21-openapi.json re-read now (openapi=3.0.3, paths=41, x-absent=7); example validation re-run now against @du/contracts dist: PASS SubmissionSchema; PASS OperationViewSchema; PASS ResultEnvelopeSchema; PASS InvocationRequestSchema; PASS SaveStepRequestSchema exit=0. What passed: 5/5 schema examples incl. grant field; what remains: reviewer acceptance to tick the row + a committed in-repo validator (my scripts were scratch, deleted) + example coverage beyond 5 schemas. Row stays [ ]. NO DB USED.

## W40-CX3 P1-03 in-tree validator (RV-07 standard)

New files (docs/tools only, no source/test edits): du-rework/tools/openapi/gen_openapi.py, du-rework/tools/openapi/validate_openapi.py, du-rework/tools/openapi/probe_cases.js; regenerated du-rework/docs/21-openapi.json (openapi 3.0.3, 41 paths, x-absent 7). Commands + exit codes: `python du-rework/tools/openapi/gen_openapi.py` exit 0 (OPENAPI-JSON path-count=41); `python du-rework/tools/openapi/validate_openapi.py` exit 0 (paths=41 x-absent=7, 21/21 PASS incl. submit, ops poll page, submit-ack, result envelope, artifact upload/finalize/access, invocation grant+request+response, usage event+batch, claim/heartbeat/step/children/wait/complete/fail). Validator caught and fixed 5 real example bugs (usage invocationId/measurement shape, children/continuationRef, inputSchema, response state enum). Implemented-vs-absent kept in 21-openapi.json x-absent + docs/20 prose. Rows P1-03/P0-01/P0-03/P0-06 all stay [ ] pending reviewer acceptance. P0-06 untouched for capacity (P8-05 dependency noted). NO DB USED.

## W40-CX4 P0-06 capacity targets (for P8-05)

New: du-rework/docs/22-p0-06-capacity-targets.md alongside workload-assumptions.md; cross-linked from audit matrix BR-04/BR-05 rows and P8-05 row. Every value labeled IMPLEMENTED (with file+constant) or TARGET/UNENFORCED or NO TARGET STATED; no invented numbers. Closability: P0-01 stays [ ] (BR-05 TTL/quotas, UC-07 drain, operator routes); P0-03 stays [ ] (error-table codes, prompt/file_urls gaps); P0-06 stays [ ] pending reviewer acceptance of the two-doc assumption set. All rows unticked. NO DB USED.

## W40-CX5 MM-11 (tenantId decision + portable validator)

Extended in-tree tools (no scratch): probe 21->23 cases (+OperationDetail, +HumanWait). Commands: `python du-rework/tools/openapi/gen_openapi.py` exit 0 (41 paths); `python du-rework/tools/openapi/validate_openapi.py` exit 0 (23/23 PASS covering poll page, submit-ack, result envelope, artifact upload/finalize/access, grant+request+response, usage event+batch, claim/heartbeat/step/children/wait/complete/fail). Responses checked: SubmitAck/OperationView/ResultEnvelope/UsageSummary shapes + all route examples above. Decision doc du-rework/docs/23-mm-11-tenant-decision.md: schema tenant wins (usage.ts:134 JOIN scope; UsageEvent has no tenantId; resolveApiKey + 404 fencing). MM-13 gap doc du-rework/docs/24-mm-13-gap.md (harness exists, owner out, needs wiring+proof+owner). MM-11/P0 rows stay [ ] pending reviewer. NO DB USED.

## W40-CX6 MM crosscheck (coordination input)

Wrote du-rework/docs/25-mm-status-crosscheck.md: 13 rows MM-01..13 with state/evidence/remains/lane; slices marked as slices (MM-06 SDK-only, MM-09 registration-only, MM-10 API-pinning-only, MM-11 docs+validator-only, MM-13 configured-run-only). Validator run fresh-checkout form: `python du-rework/tools/openapi/validate_openapi.py` exit 0, 23/23 PASS; fixed absolute-path require to repo-relative. p7-04 test file cited by review NOT FOUND on disk (flagged in row). No rows ticked. Tools/openapi + docs only. NO DB USED.

## W40-CX7 missing-evidence assignments

Wrote du-rework/docs/26-cx7-missing-evidence.md: orphan P4-05/P4-08 integration files named unclaimed with sdk+platform run-and-record fix; MM-10 p7-04 file confirmed absent with admin-ui+platform correct-or-commit fix; MM-11/MM-13 docs-closeable assertions specified; MM-01..09/12 marked code-only. Nothing ticked. Docs only. NO DB USED.

## W40-CX8 handoff + P1-03 decision request + P0-03 error evidence

Wrote du-rework/docs/27-orphan-test-handoff.md (sdk+platform: what each orphan file asserts, needs live PG/Redis, passes-today UNKNOWN under zero-DB rule, exact citability bar). Narrowed compatibility-matrix error table to literal document-core codes (MISSING/INVALID_DISCRIMINATOR, SCHEMA/EMPTY/MALFORMED, TOO_MANY bounds, comparison codes, INVOCATION_UNKNOWN) with file+test hits. DECISION REQUEST: please accept P1-03 on the in-tree validator (gen+validate exit 0, 23/23 PASS, portable) or state what further proof is required. All rows stay [ ]. NO DB USED.

## W41-CX (P0-03 narrowed + P0-01/P0-06 residuals)

Narrowed compatibility-matrix section 5 to evidenced codes; UNVERIFIED 5.1 verdicts: VALIDATION_ERROR + UNSUPPORTED_FORMAT are documentation errors (fixed); PROVIDER_INVALID_RESPONSE + ARTIFACT_NOT_FOUND + _prompt + file_urls are real product gaps needing new tests (business/platform lanes), named not ticked. P0-01 still blocked: BR-05 TTL sweep/quotas untested; UC-07 v1/v2 drain untested; operator service routes absent. P0-06 still blocked: two-doc assumption set complete but needs reviewer acceptance; P8-05 depends on it. All rows stay [ ]. Docs only. NO DB USED.

# W41-CC (thuc hien boi Codex lane term_95378d30, tai phep cua orchestrator)
# Doan nay tung nam o coordination/reports/command-code.md tu dong '# W41-CC' den het file; da cut theo lenh khac phuc W42-CX9.

# W41-CC (P4-08 orphan audit + P4-05 ART-01/02 evidence, zero DB/Redis)

## Orphan suite audit (read-only; NOT executed, zero DB/Redis per packet)

- `du-rework/tests/integration/p4-05-artifact-streams.integration.test.ts`: 7 tests (uploadArtifact staged grant->PUT->finalize READY; downloadArtifactById read grant; withDownloadedArtifact lifetime; maxBytes oversized no-file; stale leaseEpoch fenced; hash corruption caught; artifact resultRef + dispose). Requires live PG :5433 + Redis :6380. Verdict today: NOT adopted as evidence (no live run under zero-DB rule). To adopt: owning lane runs it live, records command + exit code + result here.
- `du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts`: 1 test (submit->dispatch->SDK worker->pending yield->retry->stable invocation->SUCCEEDED vs real P2+P3, mock provider only, worker-has-no-DB-credential). Same verdict and adoption bar.
- Neither file is deleted: both are the exact suites P4-05/P4-08 acceptance needs; deletion would destroy the adoption path. They stay unclaimed, not cited.

## P4-05 SDK side (offline proof, this turn)

- `pnpm --filter @du/worker-sdk exec tsc --noEmit`: exit 0.
- `npx jest --runInBand` in packages/worker-sdk: 5 suites / 119 tests PASS (artifact-streams, connector-session, fan-out, temp-sweep 6/6, worker), exit 0. No DB/Redis touched.
- ART-01 real grant flow + ART-02 staging semantics remain platform-owned (services/orchestrator/src/modules/artifacts/artifacts.ts has NO orphan sweep; SDK sweep touches only du-worker-* temp dirs, never step_checkpoints rows - rg for checkpoint refs in artifact-streams.ts is empty). REQUEST to platform lane: add a staging-orphan sweeper guarded by active-checkpoint protection, or document it as deferred; SDK will not edit services/orchestrator per boundary.

## Ticks

- P4-08 stays [ ] (no live cross-service run under zero-DB rule).
- P4-05 stays [ ] (ART-01/02 real-grant + sweeper-vs-checkpoint clauses open; platform request above).
- Zero DB/Redis activity. No commit/push/reset. No edits outside packages/worker-sdk + packages/connector-client + own tests + this report.

## W42-CX9 rectification + run-request queue

Rectification: moved my W41-CC section out of reports/command-code.md (lines 2208-end, 20 lines) into reports/codex.md under my own header; command-code.md now 2206 lines with zero W41-CC matches (rg exit 1); no stray helper scripts remain (only _fix_types.py predates me). New: du-rework/docs/29-run-request-queue.md from docs/28 inventory: one line per open P-row with exact command + cwd + literal expected line + DB/offline + author lane + runner antigravity. Nothing executed, nothing ticked, docs/19 untouched, P4-05/P4-08 adoption left to owner. Report written pre-compact. NO DB USED.

## W42-CX10 MM refresh

Wrote du-rework/docs/31-mm-status-refresh.md superseding docs/25 by pointer: 13 rows with plan-vs-disk, holder, file+line evidence, missing, and toi-KHONG-kiem-chung-duoc; wave 41/42 changes marked (MM-13 wired, FIX-CR-11 done, FIX-CR-13 open, P8-04[x], orphans to Codex-2, P9 parked). Validator rerun: exit 0, 23/23 PASS. Boundaries kept (no docs/19/28/30, services, tests). Nothing ticked. NO DB USED.

## W42-CX11 acceptance spec + user note

Wrote du-rework/docs/32-p0-01-acceptance-spec.md (4 tests A-D with file+assertion+infra+RUN REQUEST to testing lane term_47a1d44b; no tests written, no source touched) and du-rework/docs/33-user-acceptance-note.md (P1-03 command/exit/PASS + 3 non-proofs; P0-06 IMPLEMENTED vs TARGET split; no plan conflict found). Nothing ticked. Docs only. NO DB USED.

## W42-CX12 type-drift spec + MM refresh delta

Wrote du-rework/docs/34-p4-08-type-drift-spec.md (exact signatures types.ts:242/248 + worker.ts:115 + sdk-invoker.ts:60; test:334:44 wants queue+invoker worker; option A fix-test preferred, option B fix-signature heavier; USER routes). Updated docs/31 with live-batch delta + GREEN-BUT-EXIT-1 rule (exit code is verdict). Nothing ticked. Docs only. NO DB USED.
## W42-CX13 run-queue true status plus P0-01 requests plus MM refresh (docs only, NO DB USED, zero tests run)
- docs/29: per-row ledger ANSWERED vs OPEN quoting testing lane antigravity-6.md batch 19:19-19:24 DB RELEASED 19:24 totals 22 suites 15 PASS plus 3 GREEN-EXIT1 plus 4 FAIL 270/5/275; P4-05 ANSWERED-FAIL :280 base64, P4-08 ANSWERED-BLOCKED TS2345 :334:44, GREEN-EXIT1 blob-wire 5/5 ingress 8/8 usage-summary 9/9 exit 1; new RUN REQUESTs P0-01-A/B/C/D from docs/32 author platform priority order; P0-01 stays [ ].
- docs/31 W42-CX13 delta: P1-03 plus P0-06 [x] per USER via orchestrator with validator exit 0 23/23 plus 3 non-proofs; P4-08 owner Codex-2 per USER 19:45; GREEN-BUT-EXIT1 class with W42-A65 drain root cause plus usage-summary mislabel conflict quoted not edited.
- Offline validator rerun: python du-rework/tools/openapi/validate_openapi.py exit 0 23/23 OPENAPI-EXAMPLES-VALIDATED. No source or test edits, no DB, nothing ticked by this lane.
## W42-CX14 evidence reconciliation (docs only, NO DB USED, zero tests, nothing ticked)
- Wrote docs/36-evidence-table-reconciliation.md with 8 conflicts each carrying file plus line on every table: C1 offline 81 vs 82 via concurrent-interference class docs/28 L221 vs docs/35 L124; C2 live PASS roster is a different run than 19:19 batch, docs/30 section 3 repeats it; C3 bullmq file-name mismatch; C4 p4-08 stale 1-total row vs current 0-total TS2345; C5 P6-03 36 vs 23; C6 P7 filename mismatch, 7/7 prose not citable; C7 real-service 19 vs 1; C8 docs/30 citation gap plus MIXED GREEN-EXIT1 support.
- docs/35 L34 sum 1664+6=1670 recorded as unverifiable by my parsing; REQUEST to testing lane term_47a1d44b to paste aggregation command plus exit code. GREEN-EXIT1 rule restated: blob-wire 5/5 ingress 8/8 usage-summary 9/9 unusable until exit 0, so P2-03 has no live evidence. Authority map: 28 list, 29 queue, 30 row map, 35 totals, 36 conflict log. Test-Path docs/36 = True, 27 lines.
