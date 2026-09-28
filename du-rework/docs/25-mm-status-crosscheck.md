# MM status crosscheck (W40-CX6, coordination input, no implementation)

One row per MM id. States: satisfied (slice) / partial / needs-code. Lanes:
platform, sdk, admin-ui, docs, test-infra. No row ticked here.

| MM | State | Literal evidence (path:line or test name) | Remains | Lane |
|---|---|---|---|---|
| MM-01 | needs-code | worker-sdk/src/connector-invoker.ts:50 sends content-type only, no identity; connector entrypoint.ts:16 installs HmacServiceIdentityVerifier + http/server.ts:66 requires identity | ship production service auth in default invoker; deny missing/wrong identity (SDK subtask BLOCKED) | sdk + platform |
| MM-02 | needs-code | orchestrator server.ts:559 submit persists submission.input (submission.ts:164/180); result route returns resultRef + empty artifacts (server.ts:670); docs/21 x-absent lists missing public artifact routes | API-key-only upload/download flow; top-level artifact roles/output normalization; retrievable refs | platform |
| MM-03 | needs-code | submission.ts:81 resolves active version before binding; profiles.ts stores bindings not full defaults/locks/prompts; runtime.ts:1006 schemaDigest slice + :1014 empty promptRevisions | profile version selection, locks, resolved snapshot digest, override-denial tests | platform |
| MM-04 | needs-code | facade.ts:32 toOperationView drops wait metadata; facade progress not persisted (runtime.ts:181); server.ts:645 nextCursor null | public wait lookup, durable progress, state filter, stable pagination via public creds | platform |
| MM-05 | needs-code | dispatcher.ts:32 only undispatched rows; runtime.ts:757 sweeps RUNNING only; server.ts:510 constant HEALTHY | READY reconciliation after Redis loss, scheduled deadline/wait expiry, durable worker health | platform |
| MM-06 | needs-code (slice: SDK budget only) | connector invoke.ts:52 returns stored PENDING without transport; no poll scheduler found | provider poll/result convergence across restart; pending must not burn budget | platform + sdk |
| MM-07 | needs-code | invoke.ts:42-59 handles SUCCEEDED/UNKNOWN/PENDING only; IN_FLIGHT/CANCELLED fall to transport | replay-state ownership; no redispatch; reject cancelled reuse; ledger quota-expiry test | platform |
| MM-08 | needs-code | services.ts:79 quota key connector:revision:tenant; invoke.ts:69 lease 30s default, :80 full timeout | shared account/model identity, reservations, lease renewal, deadline-bounded timeout | platform |
| MM-09 | partial (slice: live registration PASS) | registry-tool.ts digests + provisionWorkerIdentity descriptor; live suite checks values not running images/ACLs | real image digests before/after, provisioned identities, denied cross-queue access | platform |
| MM-10 | partial (slice: API pinning PASS) | p7-04 test file NOT FOUND in repo (review claim unanchored); p8-02 integration file exists du-rework/tests/integration/p8-02-fault-recovery.integration.test.ts | rendered editor edit/validate/publish; same-epoch cancel; Redis/storage recovery | admin-ui + platform |
| MM-11 | partial (slice: docs+validator PASS) | tools/openapi/validate_openapi.py exit 0, 23/23 PASS; docs/23 tenant decision; probe now repo-relative (probe_cases.js:1) | spec-extracted examples + real HTTP response validation from fresh checkout | docs |
| MM-12 | needs-code | orchestrator package.json start node dist/server.js; src/server.ts exports createApp, listen only at :275 | production entrypoint/container wiring, health/shutdown/migration/restore | platform |
| MM-13 | satisfied | tests/isolation/namespace.ts:24 (redisDbIndex + assertSafeIsolationConfig); concurrent-runner.ps1 -PlainRun (52/52 & 40/40 PASS); runtime/p8-02/p8-04 wired | full two-run plain isolation, loud rejection of un-namespaced public/DB 0, artifact cleanup proven | test-infra |

Validator (fresh-checkout form, zero DB): `python
du-rework/tools/openapi/validate_openapi.py` exit 0, paths=41 x-absent=7,
23/23 PASS (submit, poll page, submit-ack, operation view/detail, result
envelope, artifact upload/finalize/access, grant/request/response, usage
event/batch, claim/heartbeat/step/children/wait/complete/fail). Portability
fix this packet: probe require is now repo-relative (was absolute
D:/Git path). Slices vs parents stated per row; no row ticked. NO DB USED.
