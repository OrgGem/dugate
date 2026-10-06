# ADJUDICATION-893 — independent Codex review

Date: 2026-10-05  
Scope: adjudicate the five unresolved questions in `rpk-inventory-freeze-889`. I read the 1,019-row freeze TSV, its receipt, the Orchestrator topology decision, the Worker pilot receipt, the PLAT-MIG-02 race rerun, the legacy root auth path, and the metadata-window/backfill evidence. The 76 unresolved paths were rehashed relative to the freeze source root `du-rework/`: **76/76 match the frozen hashes**. This is a reviewer decision record only: no source/test change, task tick, commit or push.

## Decisions at a glance

| Question | Adjudication |
|---|---|
| Q1 — 76 unclassified paths | Admin Portal belongs to Orchestrator. Classify 62 Portal runtime/source files as `ORCHESTRATOR_PORTAL_UI`; split the remaining 10 Portal docs/demo/build files into their own non-runtime classes and the four Jest configs as shared test-runner configuration. |
| Q2 — Worker dependencies | Materialize only the worker's used source plus full transitive source closure, not all three packages wholesale. Keep `@du/contracts` canonical in Orchestrator and materialize a pinned local contract subset in each Worker; no Worker dependency/re-export from the Orchestrator package and no separately built SDK. |
| Q3 — readiness revocation race | Choose bounded admission semantics (A): a probe authorized before revocation may finish once; an authorization begun after the revoke commits must deny. Do not claim atomic revocation. |
| Q4 — legacy root API key | Static source evidence shows a missing/invalid-key request can reach nullable operation creation and queue submission when the rest of the request is valid. It is a separate HIGH security issue; block cutover if this legacy route remains reachable, until it is fixed or disabled and that boundary is verified. No route-level no-key runtime test was found. |
| Q5 — evidence and acceptance | Inventory/hash plus one isolated build verifies only those bounded facts, not RPK migration or acceptance. No RPK item or implementation is ACCEPTED. A2 plaintext-read flip remains NO-GO pending exhaustive shape+auth gates, backfill/backup evidence, policy-path proof and the user's separate final authorization. |

## Q1 — classification of all 76 UNCLASSIFIED rows

**Decision: yes.** Admin Portal UI is part of the Orchestrator repo. `docs/40-du-platform-architecture.md:7,15-20,51-58` places the Portal with Orchestrator and says its bundle is built into the Orchestrator image; it also explicitly rejects a mandatory third repo. `apps/admin-web/vite.config.ts:7-10` says it is served by the Orchestrator admin shell. The frozen target is therefore not changed: no separate Portal repo and no separate API/Runtime service.

The TSV's 72 `apps/admin-web/**` rows break down as follows. These classes resolve all 72 paths without treating repository/build metadata as product source:

### `ORCHESTRATOR_PORTAL_UI` — 62 product UI/runtime source paths

```text
apps/admin-web/src/app-shell/app-shell.tsx
apps/admin-web/src/components/ui/{app-shell-primitives.tsx,badge.tsx,button.tsx,card.tsx,dialog.tsx,field.tsx,index.ts,input.tsx,select.tsx,state-panel.tsx,table.tsx,tabs.tsx}
apps/admin-web/src/features/api-keys/{api-keys-screen.tsx,state.ts}
apps/admin-web/src/features/businesses/{business-inputs.tsx,businesses-screen.tsx,state.ts}
apps/admin-web/src/features/connectors/{connectors-screen.tsx,curl-import-preview.tsx,curl-import.ts,state.ts}
apps/admin-web/src/features/docs/docs-screen.tsx
apps/admin-web/src/features/identity/{identity-api.ts,identity-screen.tsx}
apps/admin-web/src/features/index.ts
apps/admin-web/src/features/operations/{operations-screen.tsx,state.ts}
apps/admin-web/src/features/overview/{overview-screen.tsx,state.ts}
apps/admin-web/src/features/profiles/{command-bodies.ts,profiles-screen.tsx,request-redaction-editor.tsx,state.ts}
apps/admin-web/src/features/security/security-screen.tsx
apps/admin-web/src/features/settings/{catalog.ts,settings-screen.tsx,state.ts}
apps/admin-web/src/features/usage/usage-screen.tsx
apps/admin-web/src/features/workflows/workflows-screen.tsx
apps/admin-web/src/lib/api/{client.ts,index.ts,types.ts}
apps/admin-web/src/lib/utils.ts
apps/admin-web/src/main.tsx
apps/admin-web/src/router.tsx
apps/admin-web/src/routes/{api-keys.tsx,bootstrap-home.tsx,businesses.tsx,connectors.tsx,docs.tsx,identity.tsx,not-found.tsx,operations.tsx,overview.tsx,profiles.tsx,security.tsx,settings.tsx,usage.tsx,workflows.tsx}
apps/admin-web/src/styles/{app.css,tokens.css}
```

### Other Portal entries — 10, retained only as the appropriate support/input class

| Class | Count | Exact paths | Treatment |
|---|---:|---|---|
| `ORCHESTRATOR_PORTAL_UI_DEMO_SUPPORT` | 2 | `apps/admin-web/src/components/ui/demo.tsx`; `apps/admin-web/src/components/ui/fixtures.ts` | Demo/fixture source, not production UI source. `src/components/ui/README.md:105-109` says the production barrel excludes them. Keep only if the demo surface is retained; do not count them as production route/UI logic. |
| `ORCHESTRATOR_PORTAL_DOCUMENTATION` | 2 | `apps/admin-web/README.md`; `apps/admin-web/src/components/ui/README.md` | Documentation, not product source. Retain as repo docs if useful. |
| `ORCHESTRATOR_PORTAL_BUILD_METADATA` | 5 | `apps/admin-web/.gitignore`; `apps/admin-web/components.json`; `apps/admin-web/postcss.config.mjs`; `apps/admin-web/tsconfig.json`; `apps/admin-web/vite.config.ts` | Repository/dev/build configuration, not product runtime source. `tsconfig`, Vite and PostCSS are required build inputs if this Portal build is carried forward; `.gitignore` and `components.json` are repo/developer support. |
| `ORCHESTRATOR_PORTAL_BUILD_ENTRY` | 1 | `apps/admin-web/index.html` | Vite HTML build entry, not runtime TypeScript/UI logic; retain as a build input. |

### Shared test configuration — 4

Classify these as `SHARED_TEST_RUNNER_CONFIG`, outside Portal product source:

- `tests/integration/jest.config.cjs`
- `tests/isolation/jest.config.cjs`
- `tests/login/jest.config.cjs`
- `tests/unit/jest.config.cjs`

**Total check:** 62 Portal UI source + 10 Portal support/docs/build entries + 4 shared test-runner configs = **76**. The PLAT-MIG-00 freeze TSV is not edited by this adjudication; its `UNCLASSIFIED` label remains as frozen evidence. Apply this mapping as an adjudication overlay or regenerate a classified manifest from the same 76/76 hash-verified paths before using the classification as an extraction allowlist.

## Q2 — Worker dependency strategy

`businesses/document-core/package.json:18-22` declares `@du/contracts`, `@du/document-kit` and `@du/worker-sdk` as `workspace:*`; `src/worker.ts:18-22` directly imports contracts and document-kit, with additional SDK imports elsewhere. The pilot receipt §1 measured 20 import sites/18 symbols and found `tsconfig.json` and `tsconfig.test.json` paths to sibling Orchestrator/Connector `dist/*.d.ts`. It explicitly says **no template was materialized and no isolated build was run**. The freeze also records a `packages/contracts -> packages/worker-sdk -> packages/contracts` source cycle (freeze receipt §4). These are real blockers to a hermetic Worker build; an isolated build has not passed.

### Adjudication

1. **Vendor the required closure, not each whole package by default.** Start from the Worker's actual production/test imports and vendor only the required symbols/files plus every transitive source/schema/constants dependency needed to compile and behave correctly. If closure measurement shows an entire file or package is required, include it with evidence. This avoids importing unused server code while preventing incomplete partial copies (the pilot notes the `PinnedProfilePolicy` schema-alias closure as one trap). Runtime helpers, connector client logic and document parsing remain executable TypeScript/source in the Worker; do not replace them with prose or a separately built SDK.
2. **Use file-level reproducible provenance.** `package + version + commit + file hash` is a good minimum but not sufficient while the source tree is dirty/uncommitted (the freeze includes 243 untracked product files). Record: source repo and frozen inventory/tree digest; package name/version and source commit if one exists; each upstream path and SHA-256; exported symbol(s), consuming Worker paths and transitive closure; Worker destination path and resulting SHA-256; any local patch/diff hash; license; contract bundle digest; and conformance test IDs/results. If there is no source commit, bind provenance to the frozen source/tree digest plus per-file hashes, not just HEAD.
3. **Keep contract authority unique but materialize a local derived subset.** `@du/contracts` remains the canonical schema/type/semantic authority in Orchestrator. A Worker that must build with sibling source absent cannot directly re-export/import `@du/contracts` as a package. Generate or vendor the actually used contract subset into Worker-local versioned source, then re-export only from that local Worker entry point if desired. Mark it as derived/pinned (not a second authority), and require bundle-digest/schema/vector conformance tests against canonical Orchestrator contracts. Resolve the contracts/worker-sdk cycle before RPK-03/RPK-05; do not carry the cycle into the Worker copy.

## Q3 — public Connector readiness revocation race

`services/orchestrator/src/http/routes/public.ts:208-214` awaits `authorizeConnectorProbe` and immediately calls `testConnector`; there is no transaction or second binding read spanning that boundary. The PLAT-MIG-02 harness observed one probe and HTTP 200 when revocation happened at the call boundary. That is a bounded time-of-check/use race, not atomic revocation.

**Choose option A with a precise contract.** Authorization uses the current database state at the authorization query. A request admitted before a revoke commits may finish its single already-authorized read-only readiness probe (bounded by the existing outbound timeout); a later authorization query after commit must deny. Call this “one in-flight admitted probe may complete,” not “instant/atomic revocation” or an unbounded eventual-consistency window. This matches [codex-arch-unblock-migration §A](codex-arch-unblock-migration-2026-10-05.md) and the rerun receipt.

Option B's second query narrows but does not eliminate the check/use race. Holding a row lock/transaction across outbound I/O would block revocation behind network work and adds undesirable lock duration; do not do that for this bounded public-readiness probe. Option C—cancelling already admitted work—needs a separate admission/cancellation protocol and is not justified for this endpoint. Keep the negative cases at zero outbound calls, test revocation before authorization (deny) and after admission (at most one probe), then prove a subsequent request denies. Do not generalize this exception to management mutations, billing or worker invocation grants.

## Q4 — legacy root `/api/v1/docs/*` missing-key path

This is code under the **outer legacy app**, not `du-rework/`; it is not the new Orchestrator route implementation. Static source tracing confirms the risk:

- `middleware.ts:32-52` passes through every `/api/v1/*` request and returns without requiring either a NextAuth token or an API key. It strips spoofed internal identity headers, but a missing token/key still reaches the route.
- `app/api/v1/docs/ingest/route.ts:5-6` calls `runEndpoint`. In `lib/endpoints/runner.ts:84-110`, no raw key leaves `apiKeyId` undefined; a supplied but nonmatching key only logs a warning (`:103-108`) and does not return an authorization error. `loadProfileEndpoint` deliberately returns `null` for an absent key (`lib/endpoints/profile-resolver.ts:20-30`).
- `submitPipelineJob` accepts optional `apiKeyId` (`lib/pipelines/submit.ts:47`); it writes `apiKeyId || null` into the nullable Operation column (`:300-315`; schema `lib/db/schema.ts:10-16`), then enqueues the job (`:335-390`). There is no API-key-required check in this path. Therefore a syntactically/semantically valid request with required input and functioning storage/queue can create an unowned job without a key. This is a static control-flow conclusion, not a runtime observation.
- The current test search found no route-level/runtime case for absent or invalid key through this handler. Existing `tests/pipelines/external-api.test.ts` tests an API helper; checked end-to-end helpers send a valid `x-api-key`. No runtime test was run for this adjudication.

**Recommendation: treat it as a separate HIGH security issue, not a cheap refactor inside the Orchestrator migration. But do not wave it through as “legacy.”** Before any cutover that leaves this endpoint reachable, either implement fail-closed auth and tests or disable/remove this legacy ingress and prove it is unreachable at the deployment boundary. If the old service is retired before cutover, document and independently verify that route is not reachable; then its dormant source can be handled as a separate legacy cleanup. Required tests for a fix/disable proof: no key and invalid key return denial with zero Operation inserts, queue adds or outbound work; valid API key and the explicitly allowed browser-session path preserve their intended behavior.

## Q5 — IMPLEMENTED / VERIFIED / ACCEPTED and the A2 flip

### Evidence boundary

Use the statuses per artifact/scope, not as synonyms:

| Status | Meaning |
|---|---|
| **IMPLEMENTED** | The exact source/config/report artifact exists. This alone says nothing about independent correctness or release permission. |
| **VERIFIED** | An independent review binds evidence to exact hashes and checks the named acceptance conditions: required tests/builds/censuses, including failures/skips and scope limits. It is only VERIFIED for that stated slice. |
| **ACCEPTED** | The named decision authority explicitly accepts the outcome/architecture/release boundary. Verification does not confer this status. |

A current-worktree freeze with an allowlist/hash and a successful isolated Worker build can establish **VERIFIED inventory integrity and that one build was hermetic**, if the exact input and output digests are captured and the run has no unexplained skips/drift. It is **not enough to mark the Worker migration, RPK-00, all implementations, or rollout VERIFIED/ACCEPTED**: it does not alone prove every package consumer was found, the contract/API behavior is conformant, other Worker variants build, all required test suites pass, the legacy auth path is contained, or rollback/production gates pass. Here specifically, pilot 890 reports dependency mapping only—no template, no vendored source and no isolated build—so there is no Worker isolated-build proof to accept yet.

RPK-00 remains **not ACCEPTED**. The freeze receipt's still-open gates include a reproducible committed baseline (243 product files in that frozen input are untracked), the contracts/worker-sdk cycle, named serial owners for shared files, exact baseline image/config/migration revisions and rollback artifact, and independent P8-08/G6 recheck. This receipt resolves the 76-path classification decision, but does not reissue the TSV or close those other gates. User authorization for the libraries migration is not an acceptance of RPK-00 or any implementation; no task status is changed here.

### A2 allowPlaintext flip: NO-GO on current evidence

The actual mode is `DU_METADATA_PLAINTEXT_READ_MODE` with exactly `window | forbid` (`metadata-read-policy.ts:25-28`; boot parser `boot-options.ts:270-308`). `forbid` fails plaintext reads; a bounded window also fails closed after expiry. The policy/metrics/control code is implemented, but operational evidence is incomplete:

1. **Complete and authenticate all encrypted slots exhaustively.** Run the shape census first, then the A12 authenticated census over every shape-pass value, for every tenant/slot/refId with the production key provider and `allowPlaintext=false`. The exact eight slots are listed in `metadata-auth-counter.ts:81-90` (3 TEXT and 5 JSONB). Supply independently complete `expectedTenantIds`; no RLS-hidden/missing tenant, slot query failure, unattributed row, plaintext, auth/tag failure, context mismatch or other blocker can be counted as zero. A8 requires `actionable = 0` and A12 requires `auth_failed_total = 0` from exhaustive compatible snapshots; the outbox payload/source-URL shape census is separate and is not proof of decryption. The A12 runbook explicitly records these censuses were **not executed** (`a12-auth-gate-runbook-808`, §3).
2. **Backfill and verify all eight slots, then recount.** `backfill-metadata-cli.ts` and `backfill:metadata` now exist and require metadata encryption enabled, explicit production authorization, full slot coverage and a post-run gate (`backfill-cli-825` receipt). Its tests exercise a fake DB; its disposable-PG16 end-to-end success run was not done, and no production DB/key-provider census was run. `verify-backfill-window-878` records 25/25 focused tests and tsc exit 0 in its snapshot, but also records a failing `legacy-payload-migration.test.ts` assertion (expected unresolved 4, got 10) after six payload kinds were added. Resolve or explicitly adjudicate that regression before claiming full verification.
3. **Require signed backup and no unresolved/blocker counts.** The live `canRetireLegacyPayloads` gate requires `backupSignedOff === true` and a safe-integer `unresolvedReferences === 0` (`legacy-payload-migration.ts:501-506`). `metadata-window-control.ts:102-116` additionally requires a complete progress snapshot and zero blockers. The control module requires a server-resolved CSRF-verified platform admin with nonempty issuer/subject and fails closed if its audit write fails (`:94-145`).
4. **Finish the operational wiring and observe the same policy in every reader.** `metadata-window-metrics.ts` instruments reads, but `WINDOW-METRICS-825` says there is no route/deployment integration and no backfill progress producer connected; unresolved metrics are consequently unreported and close authorization unavailable. The policy is immutable per boot; closure returns a next-boot authorization and requires an explicit env change/restart. `create-app.ts:359-405` injects one reader, but its absent-mode in-process fallback is a bounded compatibility window (`:365-378`), and `route-context.ts:91` plus public/mappers compatibility fallbacks remain optional. A production acceptance must prove every live path gets the same explicit `forbid` reader and cannot enter the compatibility fallback. Confirm metadata encryption/key provider is enabled and valid; sealed rows cannot be served by a no-seam build.
5. **User final authorization is still required.** A12 states coordinator may recommend technical GO, but the USER decides final GO for A2 (`a12-auth-gate-runbook-808`, lines 38-47). The user authorized libraries migration only. This task supplies no A2 approval and performs no flip.

Accordingly: collect the exhaustive A8/A12 and backfill evidence; resolve known suite/typecheck/snapshot gaps; record backup sign-off and operational restart/rollback plan; have the coordinator present a technical GO; then obtain the user's separate A2 decision. Until then, keep the currently approved mode/window unchanged. Never infer a close from zero-looking in-memory metrics, and do not mark any implementation ACCEPTED.

## Sources checked

- `coordination/reports/raw/rpk-inventory-freeze-889-2026-10-05.tsv` and `rpk-inventory-freeze-889-2026-10-05.md`
- `docs/40-du-platform-architecture.md`
- `coordination/reports/codex-arch-unblock-migration-2026-10-05.md` §A
- `coordination/reports/worker-template-pilot-890-2026-10-05.md`
- `coordination/reports/rerun-plat-mig-02-888-2026-10-05.md`
- `coordination/reports/encmeta-window-design-808-2026-10-05.md`, `a12-auth-gate-runbook-808-2026-10-05.md`, `backfill-cli-825-2026-10-05.md`, `window-metrics-825-2026-10-05.md`, `verify-backfill-window-878-2026-10-05.md`, and `control-plane-verify-checklist-819-2026-10-05.md`

