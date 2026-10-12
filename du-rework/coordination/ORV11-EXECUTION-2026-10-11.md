# ORV11 execution ledger — 2026-10-11

Canonical plan: [ORCHESTRATOR-COMPATIBILITY-REVIEW-2026-10-11](../tasks/ORCHESTRATOR-COMPATIBILITY-REVIEW-2026-10-11.md).
Repo scope: `du-rework/` only; legacy root read-only reference. Base HEAD `7e36a1e`.
User authorized implementation and tests; operations management moves internal, public result-by-ID preserved. Public result-by-ID includes retained legacy download; canonical result is internal. No production DB/cutover authorization inferred without a concrete tested target.

## Runtime and ownership

Coordinator for this user-assigned session: `/root` (Codex). Historical Claude/Orca roster is not this runtime. Initial collaboration roster contains only root; no other live writer observed. No scheduler created; historical scheduler state UNVERIFIED. Four pre-existing CRLF report diffs remain outside leases.

| Packet | Owner slot | Exclusive write lease | Acceptance / affected flow | Status |
|---|---|---|---|---|
| ORV11-API | `api_compat` | `services/orchestrator/src/compat/**`, `src/modules/operations/submission.ts`, `src/modules/profiles/{profiles,policy}.ts`, `src/modules/webhooks/**`, `packages/contracts/src/hashing.ts`; business document-core source/tests as needed; named API-focused tests; `reports/orv11-api.md` | Legacy request→profile→artifacts→task→worker→result; 31 variants, sync/replay, result/callback/discovery, key ownership | ACCEPTED scoped compatibility implementation; external integration gates remain |
| ORV11-OPS | `internal_ops` | `services/orchestrator/src/http/routes/public.ts`, new internal-operations module/route, `src/http/ingress*.ts`, `src/http/route-context.ts`, `src/server.ts`, `src/app/bootstrap/create-app.ts`, `src/modules/operations/{facade,retry}.ts`, `src/app/admin/**` except local-auth paths allocated migration; operation route tests; `reports/orv11-ops.md` | Public result-by-ID; admin-authenticated internal management; no public key management access; BFF paths integrate with UI owner | ACCEPTED for scoped code/PG/HTTP flows; live S3 gate separate |
| ORV11-DATA | `migration` | `services/orchestrator/scripts/ldba-*.cjs`, `src/modules/identity/**`, `src/modules/auth/admin-local/**`, new migration SQL >=0044 (coordinate numbers before write), named ldba/identity tests; `reports/orv11-data.md` | Legacy DB snapshot→mapped rows/blob links/profile memberships→read/replay/auth; timezone proof, safe import, dry-run and reconciliation | ACCEPTED safe importer mechanisms; customer cutover HOLD |
| ORV11-UI | `admin_ui` | `apps/admin-web/**`, `services/orchestrator/src/modules/admin-actions/**`, `src/http/routes/admin.ts`, new `src/modules/settings/**`, new workflow-test service module, scoped new migration after number reservation, UI/admin tests; `reports/orv11-ui.md` | Settings effective read/write where supported; real workflow.test; operations internal API client, HITL journey, accurate capability/health | ACCEPTED delivered journeys (UI_APPROVED); broader P06/P07 remains |
| VFY-ORV11-ENV | `verification` | Dependency installation/build outputs and isolated scratch infrastructure; `reports/orv11-verification.md`, `reports/raw/orv11/**`; independent tests under distinct `orv11-vfy-*` names | Supported runtime/toolchain; independently run affected tests, HTTP integration, DB rehearsal and browser where available; no product-source writes | COMPLETED: final44 + workflow15; receipts below |

All source leases are relative to `du-rework/orchestrator/` unless named businesses. Shared changes outside lease require coordinator reassignment first. Root owns plan, traceability/docs and coordination metadata. No commit/push. Each worker runs owner smoke and writes receipt (command/cwd/runtime/pass/fail/skip/exit/raw path); independent verification follows source handoff. Existing relevant docs are read-only to workers, propose deltas for root.

## Contract decisions

- Public: six document submit APIs, named/schema workflow submits, operations result-by-ID, other existing non-operation public APIs. Operations list and mutations become internal admin/session-authenticated surface.
- Proposed internal canonical prefix: `/api/internal/operations`; existing Admin BFF stays `/admin/api/*` and uses this backend. Admin bearer on old public management paths does not make those routes public-compatible; retire old routes after client/BFF update.
- Legacy request/result field names and existing operation IDs preserved. Security improvements do not authorize body-supplied identity or cross-key access.
- One-time migration, no continuous dual-write/CDC platform. Prefer stable snapshot and drain/controlled HITL ownership; keep production writes blocked absent verified source evidence.
- SQL sequence: DATA0044; OPS0045 after UI released its reservation; additional sequence allocation must be coordinated.

## Dispatch and evidence

Agent IDs, acceptance messages, change handoffs and independent verdicts are appended below after actual runtime delivery. A row alone is not dispatch proof. Parent acceptance remains open until required evidence is received.

### Dispatch cycle 1

Actual collaboration spawn deliveries: `/root/api_compat`, `/root/internal_ops`, `/root/migration`, `/root/admin_ui`, `/root/verification`, `/root/independent_review`. All six returned explicit acceptance messages in this session. This is the current live roster, not a historical terminal alias.

- API: producer/consumer fixes and result projection underway; coordinating `endpoint_slug` profile resolution with DATA.
- OPS: internal management and BFF route composition underway; coordinating client contracts with UI.
- DATA: SQL0044 reserved for `profile_bindings.endpoint_slug` and membership/import compatibility; exact endpoint then generic fallback contract being coordinated with API.
- UI: workflow test + settings consumer inventory underway. New convenience settings alone do not close legacy Settings parity; existing AI/prompt/storage/retention consumers must be mapped explicitly.
- VFY: runtime/dependency setup underway; existing Node/pnpm versions mismatch repo requirements, supported versions being resolved without changing engine policy.
- REVIEW: independent read-only boundary review accepted; final verdict waits for source handoff and receipts.

Independent reviewer owns only `reports/orv11-independent-review.md`. No product leases added. All packets IMPLEMENTATION/VERIFICATION IN PROGRESS, none ACCEPTED.

### Coordination cycle 2

- VFY installed SHA256-verified Node 24.21.0, pnpm 10.18.3; frozen parent dependency install and six shared-package builds passed. Dedicated PG16/Redis7 test instances provisioned. HTTP admission baseline 5/5 passed; this is scoped baseline evidence, not closure of new APIs.
- Internal OPS owner identified an early pnpm11 invocation generated four workspace YAML placeholder lines. VFY received and performed narrow cleanup lease for just that generated block; manifests/lockfiles otherwise retained.
- OPS lease expanded to OpenAPI generator/validation and generated `docs/21-openapi.json`, `orchestrator/docs/21-openapi.json`; obsolete routes must be intentionally retired in generator rather than handpatched artifacts.
- UI released SQL0045 reservation; settings writes will reuse real connector prompt overrides instead of introducing unused global defaults. DATA owns0044; additional SQL needs explicit allocation.
- Independent early review found multipart hash filename/MIME/order coverage, preservation of endpoint_slug through new profile revisions, and legacy HITL state spelling require attention; owners notified. No final verdict yet.
- Download optional clarification has no answer after reasonable time: implementation proceeds with stated default public GET by ID + download; management and canonical `/result` internal.

### Coordination cycle 3

Live roster: six worker/reviewer agents still running in the same collaboration session. No duplicate writer or new scheduler; historical scheduler remains UNVERIFIED.

- OPS lease additionally includes `src/modules/operations/mappers.ts` for internal detail human waits and state version. Owner reports internal route smoke 21/21, generator succeeds with explicit obsolete-path retirement.
- Independent verifier: real HTTP/PostgreSQL operations matrix 5/5 PASS. Covers retired public controls/list/result, own-key legacy output bytes, same/cross tenant/key denial, admin/internal ingress, viewer denial, cookie CSRF, terminal soft delete and transactional audit. Raw: `../reports/raw/orv11/operations-http.log`. This scoped result is VERIFIED, not umbrella acceptance.
- UI owner build/typecheck and focused smoke 7/7 PASS. Independent Chromium screen test 1/1 PASS on bundle `Cf1Ga0b5`, covering six route/viewport checks with no API/JS errors and no measured overflow. Interactive settings/workflow/HITL journeys remain in progress.
- Independent reviewer raised aggregate URL budget, same-name multipart order/hash identity, large historical download regression, and direct artifact route key/deleted-operation fence. Owners are addressing these; earlier receipt does not close newly identified gaps.
- DATA requires explicit reviewed connector-slot mapping when it cannot be inferred, and drains nonterminal/HITL jobs before cutover. Real source evidence/configuration remain unavailable; synthetic rehearsal does not authorize a production cutover.
- Canonical final receipts: `coordination/reports/orv11-{api,ops,data,ui,verification}.md`; active verifier raw output may remain under `du-rework/reports/raw/orv11/` and must be linked accurately.

### Coordination cycle 4 — handoff and operator upload gap

- OPS owner handed off implemented internal operations/BFF/OpenAPI and own checks (receipt `reports/orv11-ops.md`); independent acceptance still pending latest artifact regression.
- API owner reports real ingest/compare host-to-worker smoke and 31-variant corpus passing; independent HTTP ingest→worker→legacy download/replay now passes. Sync fixture initially sent JSON to multipart-only legacy mount and is being corrected by tester; retained failed raw is not a product pass.
- DATA owner reports 53 CJS tests passing after authenticated connector/schema ciphertext replay fixes. Actual PostgreSQL rehearsal remains assigned to independent VFY.
- UI owner now validates prompt target against active selected tenant/key/endpoint profile connector pins. This closes the silent-unused-setting risk identified by reviewer. All-key cursor loading added; final build pending.
- P06 operator journey still lacked file upload; manual artifact JSON was insufficient. Actual follow-up dispatch delivered to `/root/internal_ops` as **ORV11-OPS-UPLOAD**, existing internal routes/BFF lease plus named owner tests/report. Implement bounded admin/session/tenant/key-scoped encrypted upload with viewer/CSRF denial; coordinate wire with UI. No new SQL reserved yet; owner must request before writing. `/root/admin_ui` owns file-picker consumer. `/root/verification` owns independent browser upload→workflow test; reviewer reviews auth and ownership. This is continuation of existing authorized P06, not a separate production action.
- All other owners continue their disjoint work; no additional agents or schedulers spawned.

OPS-UPLOAD ownership follow-up: SQL0045 reserved to OPS for nullable `artifacts.upload_api_key_id`; lease expanded to `src/modules/artifacts/artifacts.ts` and `src/compat/legacy-public-artifact.ts`. API retains host caller and submission ownership checks. Public existing upload initialization must record trusted key; imported historical artifacts remain accessible only through owned operations/references. UI receives no raw API key. This schema work closes the previously explicit orphan-artifact ownership gap and requires final independent regression.

### Coordination cycle 5 — actual backend findings

- DATA handoff received: [owner receipt/runbook](reports/orv11-data.md), 54 CJS + 25 Jest owner checks and typecheck pass. No production input supplied. Snapshot is bounded in-memory materialization, not streaming/chunked import; production sizing remains a gate.
- Independent current integration: migration PostgreSQL import + fresh adapter replay pass, two imported profile memberships, old-key historical read + exact 9 MiB download hash, disabled exact endpoint403. This fixture does not yet cover all source entities, encrypted replay or reset login; no full migration acceptance inferred.
- Independent core HTTP→worker tests 2/2 pass: real multipart artifact/result/download, replay without added blobs, sync waits to terminal. Additional ownership checks cover successful own-key input download, foreign-key and deleted-owner denial. Intermediate artifacts intentionally remain inaccessible.
- Browser exposed a production integration defect: `settings.prompt-update` failed existing dotted-action grammar. UI renamed action to `settings.prompt.update`, preserving validation rather than weakening it. Final browser rerun pending.
- Browser/named workflow403 exposed real `createRevision` omission of `profile_api_keys`; API owner adding membership transactionally without reactivating revoked memberships. Not treated as a test-fixture-only fix.
- UI owner handoff includes file picker and all-key paging; final bundle depends on OPS upload/schema0045 completion and latest review fixes. All acceptance statuses remain open until final independent receipts.

### Coordination cycle 6 — full core HTTP matrix

- Independent VFY completed all **31 document variants** through real HTTP/admission/PG outbox/Redis worker/Connector loopback provider and legacy polling. Together with exact ingest bytes/download/replay and sync terminal: **33/33 PASS**, `../reports/raw/orv11/core31-worker.log`. Deterministic synthetic provider responses verify transport and contract, not external AI/provider quality.
- UI final owner bundle `index-BRKI860K.js`, SHA256 `a4199de4df65f4f560f0d9f329f56405f5d2fe435327c62264c60f67088feacf`; build/backend typecheck and73 owner tests pass. Independent interactive browser and UI verdict still pending this exact build.
- API narrow test lease extended to `du-rework/tests/workflow-api/http-worker.integration.test.ts` solely to migrate retired public lifecycle requests to authenticated internal paths; VFY runs full named/schema/restart/cancel/HITL matrix afterward. Existing business outcome assertions must be retained.

User clarification received during final verification: **“Giữ GET theo ID và download public”**. Public download default is now explicitly confirmed; no pending contract question remains. Existing implementation matches this answer.

### Coordination cycle 7 — stronger assertions keep acceptance open

- User explicitly confirmed public ID + download, recorded above.
- Independent reviewer boundary checks: API158/158, document variant corpus32/32 (explicit versioned envelope assertion), upload13/13 PASS. Initial corpus red preserved and final correction reviewed; no aggregate double-counting.
- Strengthened HTTP31 now compares output data as well as terminal status. New run has three output mismatches requiring fixture-vs-product diagnosis; earlier33PASS proved execution/polling, not full golden parity. `core31-browser-current2.log` is newer RED and blocks API umbrella acceptance until resolved.
- Full existing workflow runtime matrix initial12PASS/3FAIL: two retired-public resume expectations are being updated to authorized internal requests plus explicit public404. Provider-inflight cancellation is a real semantic regression: internal path must propagate cancellation to running worker/provider. OPS reactivated through actual followup dispatch; coordinate lifecycle/dispatcher leases before edits.
- Browser upload succeeded but workflow.test worker rejected input (`LEGACY_WORKFLOW_INPUT_INVALID`). UI reactivated through actual followup for worker task contract and template readiness copy. Final UI build/hash must be recaptured; prior build screenshots cannot accept the new code.
- No new agents/schedulers; current owners retained and reviewer/tester remain independent.

Cycle7 follow-up: OPS lease expanded to `src/modules/lifecycle/lifecycle.ts` and named cancellation tests for active-worker cancellation propagation. UI retains workflow-test input fix. Verifier diagnosed three HTTP golden mismatches as fixture wire encoding (legacy CSV redaction patterns, string comparison sides, standard FormData CRLF); fixes preserve response capture and only normalize line endings for corpus comparison. DATA independent negatives now exercise missing UTC proof with zero writes and mismatched observation using native PostgreSQL timestamp columns. Final reruns pending.

Cycle7 resolutions received: strengthened core31 corpus comparison **31/31 PASS** (`../reports/raw/orv11/core31-corpus.log`, three other cases deselected, not passes). Each variant checks legacy name/state/done and expected extracted data; only known nondeterministic IDs/time and multipart newline normalization apply. UI worker-input bug fixed by server-side owned artifact metadata lookup, ordered filenames and worker DTO validation before submit. Owner75 tests/build/typecheck PASS; latest bundle `index-BEftFSiZ.js`, SHA256 `2d2850ef963ca0b06cee14a97e660487d9f0a3b1fb5d4d607727fac6dc675984` supersedes BRKI860K. Browser final rerun remains pending.

### Coordination cycle 8 — residual compatibility and cancellation recovery

- OPS cancellation source now includes bounded reconciliation on the **existing** lease recovery timer, preceding generic expired-lease recovery. Active worker keeps lease and observes cancellation; paused/expired/contended jobs are later terminalized. Owner19 focused cases/typecheck pass; independent DB/worker confirmation pending.
- API receipt received but exposed an avoidable backward-compatibility difference (10 input files for several actions vs legacy20 URLs). API owner reactivated under existing lease to align non-compare admission and verify 11–20-file cases, preserving aggregate transfer bounds. Also checking legacy HTTP source URL support against pinned egress policy; credential origin protections remain required. This known difference cannot be hidden under a broad API parity approval.
- Final independent runs will be serialized or verify distinct Redis DBs; fixture randomDB allocation alone is insufficient isolation evidence for simultaneous runs. No production infrastructure touched.

Cycle8 runtime lease: OPS additionally owns only `src/modules/runtime/runtime.ts` expired-lease cancellation exclusion and locked state recheck, preventing generic recovery from requeueing/failing a cancellation that committed after the candidate read. Owner20 tests/typecheck pass; independent verification pending.

### Coordination cycle 9 — workflow runtime verified

Live roster: API implementer, independent reviewer and verifier active; UI, DATA and OPS owners handed off/completed and retain only defect-response leases. No extra scheduler.

- Full named/schema workflow runtime suite **15/15 PASS**, serialized alone on PostgreSQL/Redis with latest cancellation/recovery source. Covers disbursement, lc-checker, doc-compare, schema pins, real provider abort on cancellation, lease recovery without repeated stage, sequential/parallel HITL, paused cancellation and auth/encryption negatives. Raw `../reports/raw/orv11/workflow15-serialized.log`; process exited0 naturally after a delayed-open-handle warning (no forceExit/kill).
- Browser upload→workflow.test→worker success and human approval→worker success executed; final screenshot locator corrected to actual detail navigation. Final consolidated44-case independent suite pending API transport count freeze.
- Independent focused cancellation recovery8/8 PASS; real PostgreSQL contention/expired-lease finalizer cases added to independent operations suite, pending consolidated run.

Independent reviewer issued **OPS scoped APPROVED** after source review +8 focused cancellation cases +7 real PostgreSQL operations/cancellation cases +15 runtime workflow cases. Acceptance covers public ID/download, internal tenant/session/CSRF management, artifact ownership, bounded encrypted upload and provider/orphan cancellation. Live S3 integration remains unverified and is not claimed by this scoped approval.

Reviewer issued **DATA scoped APPROVED** for safe one-time importer mechanisms after independent54/54 CJS plus actual PG proof/replay/history evidence. Does not accept full customer migration: all source entities, encrypted replay on live target, imported identity login, settings/connector mapping, retry-window reconciliation and sizing remain gates. Verifier receipt drafted at [orv11-verification](reports/orv11-verification.md), final44 pending last API/UI freeze.

### Coordination cycle 10 — final freeze

- API final compatibility count fix reviewed independently:43 API tests +79 document bounded/corpus tests PASS. Legacy20URLs plus multipart retained; server-only count context cannot be forged by public input/profile fields. HTTP(S) uses pinned egress; credential-bearing HTTP/downgrade refused, cross-origin credentials stripped. Reviewer issued **API scoped APPROVED**; DNS/S3/external callback/provider and full production limits remain separate integration gates.
- UI preserves operation detail after successful HITL resume (refresh list first, then reopen captured operation with stale-scope guard). Final owner bundle `index-D6Ow5y8y.js`, SHA256 `720734c2f44234474d0cef5fbcfcf94c6677ee3fa80aea1bd6700f3a134492dd`. Independent44-case final run now starts on this build; earlier UI hashes historical.
- No product edits planned after this freeze unless independent verification finds a defect. API, OPS and DATA scoped reviewer approvals received; UI final verdict remains pending final browser evidence.

### Final independent execution receipt

`reports/raw/orv11/independent-final44.log` (relative to du-rework): **4 suites,44 passed,0 failed,0 skipped,exit0**, serialized solo on frozen source and `index-D6Ow5y8y.js`. Includes31 core variant corpus assertions, sync/replay/download, actual browser upload/workflow/HITL retained-detail, effective prompt carrier, PostgreSQL snapshot proof/import/replay/history, operations auth and cancellation contention/recovery. Separate runtime suite **15/15 PASS,exit0**. Do not add repeated owner/reviewer runs as distinct test cases. Formal [verification receipt](reports/orv11-verification.md) records runtime/commands, raw files and scope limits. UI final independent review verdict pending evidence intake; no production cutover inferred.

## Remaining plan gates (not silently marked complete)

| Gate / next work | Owner/input required | Acceptance before cutover |
|---|---|---|
| Full customer source rehearsal | Data/operator with sanitized representative clone, blobs and independent timezone observations | Every populated entity/count/hash/usage/profile/user reconciled; actual connector/schema encrypted replay and imported identity login verified; duration/RAM/locks measured |
| Effective legacy configuration | Operator + business/profile owners with current legacy settings/connector inventory | Archive mapped to effective model/connector/prompt/storage/retention settings; disabled/default/locked policies tested; global settings diff/test/apply/rollback remains broader P06 work, not claimed by bounded prompt editor |
| Pending work and old retries | Operator/client owners | Drain running/HITL jobs; reconcile historical callbacks and old idempotency retry window; no double execution at cutover |
| Deployment-specific integration | Deployment/verification on actual S3/key provider/SSO/connectors | S3 encryption/readback, authenticated remote URLs, external callback receiver, login and measured usage/cost reconciliation; register correct immutable manifest/version pins |
| Final switch and rollback | Operator using DATA runbook after clone acceptance | Backup/restore rehearsal, frozen final source, verified mapping, ingress smoke and explicit handling of post-cutover writes for rollback |

Current implementation/verification does not declare the whole original plan100% or authorize production cutover. No commits/push or production data changes were made. Four pre-existing report-only CRLF diffs preserved; incidental installer manifest changes removed narrowly. Exact final source/test/bundle hashes: `../reports/raw/orv11/final-source-hashes.json`.

## Final scoped acceptance — 2026-10-11

Independent reviewer confirmed **API APPROVED, OPS APPROVED, DATA APPROVED (mechanisms only), UI_APPROVED (delivered journeys)** on frozen sources and final bundleD6Ow5y8y (SHA above). Fresh final workflow/HITL screenshots, exact loaded build,44-case receipt, scoped independent focused tests and source were inspected. No unresolved blocker in the delivered slice. See [review verdict](reports/orv11-independent-review.md) and [verification](reports/orv11-verification.md).

All current execution packets handed off; no background coding task or additional scheduler remains. Original plan's broader configuration/UX and production migration gates in the table above remain OPEN. This is scoped implementation acceptance, not whole-system release/cutover approval.
