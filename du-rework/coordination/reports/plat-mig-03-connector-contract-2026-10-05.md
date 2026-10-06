# PLAT-MIG-03: Connector root-path and management contract

Date: 2026-10-05. Task reference: `task_9ee833042ba7`. Owner: Codex Arch, direct user-owned execution. `dispatch-show` returned no active Dispatch, so no lifecycle ID or worker_done is fabricated. Status: IMPLEMENTED with owner verification; independent VFY/Claude acceptance pending.

## Outcome and actual wire

PM-M04 corrected in docs/08-connector-api.md: Connector base is its service origin, without /internal/v1. Invocation client and Orchestrator management proxy already use root paths. No production route, client implementation, external wire or legacy precedence was changed.

| Surface | Actual source | Auth and behavior |
|---|---|---|
| Root path routing | services/connector/src/http/server.ts:128-138 | url.pathname used directly; no /management or /internal/v1 aliases |
| GET /capabilities | server.ts:163 | connector:invoke, adapter catalog; manage-only token gets 403 |
| GET/POST /connectors and revision lifecycle | server.ts:164-298 | connector:manage; current and explicit revision reads, pending/bootstrap/CAS activate/retire |
| POST /invocations | server.ts:312-321 | connector:invoke and grant in body; completed200/pending202 |
| GET /invocations/{id}, POST cancel | server.ts:299-310,322-333 | connector:invoke plus x-invocation-grant passed to runtime |
| Credential rotate, disable, provider test | server.ts:335-351 | connector:manage; provider test differs from readiness |
| GET /health/live, /health/ready | server.ts:158-162 | internal health without identity, no provider dispatch |
| Management proxy | services/orchestrator/src/modules/connectors/connector-management-store.ts:122-200 | uses /connectors root routes |
| Invocation transport | packages/connector-client/src/transport.ts:177-196 | uses /invocations root routes |
| Platform admin capabilities | services/orchestrator/src/http/routes/admin.ts:532-542 | composition booleans management/credentialWorkflow/test, distinct from adapter catalog |

The task packet's `/management/connectors` and `/management/capabilities` are NOT current endpoints. No aliases were added. `GET /connectors/{id}` was also advertised incorrectly in docs08; use `/connectors/{id}/revisions/current` or an explicit revision. These unsupported paths are tested over real HTTP and return404 with a valid identity carrying both scopes.

Real service identity uses Authorization: Bearer HS256 JWT, not a literal identity header. Existing identity.ts:5 verifier validates signature and integer exp; :43 guard validates audience connector, subject and required scope. Production entrypoint.ts:18 injects the verifier. Missing/wrong-signature/expired identity returns401 GRANT_INVALID; wrong audience/scope returns403 BINDING_DENIED. Corrected the old docs taxonomy accordingly. Orchestrator per-request signing/refresh remains the separate identity implementation lane; this packet documents its approved claims and does not claim its production boot is complete.

## Leases and generator fix

Original user lease: docs08, generated docs21 and contract tests. Coordinator granted `lease_extension_plat_mig_03` for Connector generator block/validation and `lease_extension_plat_mig_03_admin` for four existing Connector-related Platform entries. No services source, contracts, lockfile, Compose, migrations or MIG00 documentation edited.

Generator previously lacked four paths already present in the working-tree JSON: /api/v1/admin/actions, /api/v1/admin/connectors, /api/v1/admin/connectors/capabilities and /api/v1/admin/connectors/{id}/revisions/{rev}. First attempted regeneration stopped before writing via the new pre-write no-drop guard. It was not forced through. These four entries are now reconstructed from the admin router, not copied from old JSON. Action docs reflect header idempotency, 405 on non-POST and404 on unknown action. Capabilities remain booleans. Revision fallback is documented as disabled, not a live capability.

Connector block adds six revision lifecycle paths, exact success statuses,401/403 distinction, operation-level internal Connector origin, required JWT scope extension and source citations. HTTP Bearer OpenAPI security remains `Svc: []`; claim scopes are described with x-required-service-scope, not falsely modeled as OAuth scopes. Get/cancel document the separate invocation-grant header. Source presence/scope selector assertions guard generation.

Full regeneration: 54 paths, 14 schemas, dropped-paths0. Existing operations query6/sort6/usage query13 and delivery-schema guards pass. Two consecutive runs produced identical output SHA-256. docs21 was written only by the generator. This verifies the affected contract; unrelated legacy generator descriptions are not a complete API coverage audit.

## Owner verification and raw evidence

Windows, Node22/pnpm, loopback HTTP; no live provider, shared DB/Redis/Vault or production calls. Cwd is D:/Git/dugate/du-rework for pnpm; D:/Git/dugate for Python.

| Command | Result | Raw receipt |
|---|---|---|
| python du-rework/tools/openapi/gen_openapi.py, two consecutive runs + SHA comparison | exit0, deterministic output,54 paths,0 dropped | plat-mig-03-generation-2026-10-05.log; SHA below |
| python du-rework/tools/openapi/validate_openapi.py | exit0,23 contract example checks PASS | plat-mig-03-openapi-validation-2026-10-05.log |
| pnpm --filter @du/connector test -- --runTestsByPath tests/plat-mig-03-root-contract.test.ts tests/service-auth.test.ts tests/runtime-foundations.test.ts tests/invocation-access.test.ts | exit0,4 suites,40 passed,0 failed,0 skipped | plat-mig-03-connector-tests-complete-2026-10-05.log |
| pnpm --filter @du/connector-client test -- --runTestsByPath tests/transport.test.ts tests/client.test.ts | exit0,2 suites,22 passed,0 failed,0 skipped | plat-mig-03-client-tests-2026-10-05.log |
| pnpm --filter @du/orchestrator test -- --runTestsByPath tests/p745-connector-management-proxy.test.ts tests/connector-revision-http-offline.functional.test.ts | exit0,2 suites,19 passed,0 failed,0 skipped | plat-mig-03-management-tests-2026-10-05.log |
| pnpm --filter @du/connector typecheck | exit0 | plat-mig-03-typecheck-2026-10-05.log |
| git diff --check for four changed files | exit0 | command output in owner session |

New root-contract suite has26 tests, real createConnectorServer listener with HmacServiceIdentityVerifier. It proves root management/statuses/redaction, signature/expiry/audience/scope denial before store access, capabilities split, unsupported aliases, health, invocation/get/cancel grant forwarding and generated scope/origin contract. Management store and runtime are typed in-memory test doubles: this is real router/auth HTTP proof, NOT durable PostgreSQL/Vault lifecycle or verification of signed runtime grant semantics by the stub. Existing invocation-access suite separately checks runtime grant access. Server is closed and connections cleaned in afterAll.

Initial test run was RED: new tests assumed403 for invalid identity and the stale JSON lacked scope annotations. Corrected tests to actual401/403 wire; fixed generator under granted extensions. Final40/40 supersedes that run. Initial/final logs retained. PowerShell stderr formatting labels NativeCommandError for Jest output; the documented pnpm exit codes above are0 for final runs.

## Candidate and input SHA-256

| File | SHA-256 |
|---|---|
| docs/08-connector-api.md | 47616fcfcc11552f337a9cfa1d790a8995a782b7841ff2addb3f87ff6c1583fd |
| docs/21-openapi.json | 346a30fa7f7a502127ad36bda2d350a440ba3edd42a481f142fcd70a8f3d3268 |
| tools/openapi/gen_openapi.py | 13bccb0638e0f3894859569ad3c17282b7eae00672ba4ad1d91054cdecbbe0cb |
| services/connector/tests/plat-mig-03-root-contract.test.ts | 64b73a4054cf71c3fd14eeafd530246396bd6a466aa6a5418284e4cda023cf5c |
| services/connector/src/http/server.ts (read-only input) | 5695e3928f6816196b2e035ce45926eaa4ec3ee0ea9b154796358cb68a317425 |
| services/connector/src/identity.ts (read-only input) | 7a24dee99a225eb34b9f66cb72e8f30982abcfa2a8a683ce3e96073e17d74a01 |
| services/orchestrator/src/http/routes/admin.ts (read-only input) | bf77179f29cb35925e4ec263ea503605a132a25c73ceda66b88ab0e5617783ac |

## Handoff

Existing coordinator should release the MIG03 user-owned lease, bind independent VFY and Claude review on the exact artifact/source hashes, and update traceability/test inventory/acceptance docs under their owners. No acceptance checkbox tick, remote/push/cutover or production-source edit performed. Identity issuer/refresh and ingress remain separate open tasks. MIG03 work is complete within this packet, pending independent review rather than declared ACCEPTED.
