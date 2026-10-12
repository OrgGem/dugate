# ORV13 — Admin UI review and completion

User authorized review and implementation of missing Admin UI features on 2026-10-11. Repo scope: du-rework, preserve legacy public contracts and all existing uncommitted work. Canonical requirements: tasks/ADMIN-SYSTEM-OPERATIONS-SUPERSET-2026-10-05.md and tasks/ORCHESTRATOR-COMPATIBILITY-REVIEW-2026-10-11.md. No deployment, production data mutation, commit or push.

Implementation/test workers use gpt-6-luna, max, fork none. Independent review inherits the user-facing parent model. Root writes coordination metadata only. Historical ORV12 agents completed; no live writer is reused under the wrong model. Scheduler UNVERIFIED; no timer created.

## Packets and acceptance

| Packet | Acceptance | Owner / exclusive write lease | State |
|---|---|---|---|
| UI13-REVIEW | Source/spec gap inventory with concrete journeys; final exact-build browser/source review, separate backend/UI verdicts | orv13_ui_review; coordination/reports/orv13-ui-review.md and raw/orv13-review/ only | FINAL SCOPED APPROVED/UI_APPROVED; BROADER CANONICAL SCOPE OPEN |
| UI13-JOURNEYS | Safe operation/HITL/callback/workflow interaction: no stale operation/tenant data or duplicate actions, actionable load/error/conflict/empty states, accessible confirmation, validated forms and links | orv13_journeys; features/operations/, features/workflows/ only plus uniquely named owner tests/receipt | IMPLEMENTED — OWNER SOURCE FROZEN |
| UI13-COCKPIT | Operator navigation and truthful service/worker/queue/incident visibility using actual scoped projections; freshness, pause/refresh, drilldowns and responsive keyboard access | orv13_cockpit; overview/system-operations/routes/router/shell/shared UI/styles, excluding global tenant selector | IMPLEMENTED — OWNER SOURCE FROZEN |
| UI13-BACKEND | Only reviewed missing scoped DTO/projection/BFF needed by UI; bounded queries, tenant/RBAC/CSRF and sanitized errors; no invented infrastructure adapter | orv13_backend; BFF/usage/frontend API/tenant context/selector; additive internal-usage route and server import/dispatch only | IMPLEMENTED — OWNER SOURCE FROZEN |
| UI13-USAGE | Typed summary, truthful measured/estimated/unpriced costs, bounded actual-event ledger/export and operation links; no cross-query response contamination | orv13_usage; features/usage/ only | IMPLEMENTED — OWNER SOURCE FROZEN |
| UI13-SETTINGS | Complete core endpoint selector, native revision workflow and effective connector/prompt targeting, role/scope/conflict/draft safety and mobile/keyboard | orv13_settings; features/settings/ only + unique owner tests/receipt | IMPLEMENTED — OWNER SOURCE FROZEN |
| UI13-COMPOSE-BACKEND | Approved host catalog/preview/durable jobs/runner auth and PG0048, atomic audit/idempotency/CAS/UNKNOWN target fence | orv13_backend; compose contracts/service/internal route/migration plus exact config/bootstrap/BFF/client hooks | IMPLEMENTED — OWNER SOURCE FROZEN |
| UI13-COMPOSE-HOST | Trusted fixed manifest, genuine sanitized Docker observations, bounded fixed argv, host journal/start ACK/no blind replay/reconciliation | orv13_usage; compose manifest/host-executor/runner/CLI only + unique owner tests/receipt | IMPLEMENTED; INDEPENDENT HOST/ACTION SLICE VERIFIED + SCOPED APPROVED |
| UI13-COMPOSE-UI | Actual catalog/desired-observed/jobs; preview/confirm allowed release/restart with role/CSRF/CAS and truthful unavailable/UNKNOWN state | orv13_cockpit; system-operations features/route and exact shell/router integration only | IMPLEMENTED — OWNER SOURCE FROZEN |
| VFY-UI13 | Independently test changed backend and real-browser operator journeys, tenant/error/stale/mobile/keyboard cases on final exact served bundle; screenshots and source hashes | orv13_verification; uniquely prefixed verifier test/harness/raw/receipt only | VERIFIED14/14 + ROSTER1 FOCUSED; TESTED SCOPE ACCEPTED |
| VFY-UI13-COMPOSE | Independently verify real PG/API durable jobs and genuine disposable host inventory/apply/restart/approved rollback, UNKNOWN/replay/env guards and actual mounted Compose UI | orv13_compose_verification; tests/workflow-api/orv13-vfy-compose-* and reports/raw/orv13-vfy-compose/** + receipt only; consumes shared builds | VERIFIED2/2 + MOBILE1 FOCUSED; TESTED SCOPE ACCEPTED |

No broad AOPS parent acceptance inferred from a delivered subset. Missing infrastructure/provider/customer dependencies must remain explicit, with implementable capability vs deployment proof distinguished.

## Dispatch proof

- UI13-REVIEW runtime spawn accepted `/root/orv13_ui_review`; concise fork-none review packet, no model override (inherits parent). Real runtime roster was read before dispatch.
- UI13-JOURNEYS actual spawn `/root/orv13_journeys`: gpt-6-luna/max/fork-none, exclusive operations/workflows features + unique owner tests/receipt. Callback fresh-state confirmation, scope fences, URL state and existing DELETE client integration; workflow role gates/catalog fencing. No shared-client writes.
- UI13-COCKPIT actual spawn `/root/orv13_cockpit`: gpt-6-luna/max/fork-none, overview + new system-operations feature/route + router/shell/shared UI/styles. Excludes global-tenant-selector.tsx. Correct unknown/stale/partial sample/cost semantics, meaningful actual service/worker/queue/triage reads, responsive/keyboard.
- UI13-USAGE actual spawn `/root/orv13_usage`: gpt-6-luna/max/fork-none, usage features only + unique owner tests/receipt. Scope/query race fixes, typed cost breakdown and bounded ledger/export from actual DTO; no fabricated budget editor.
- UI13-BACKEND actual spawn `/root/orv13_backend`: gpt-6-luna/max/fork-none, BFF + shell-router route declaration if needed + usage module + frontend lib/api + lib/tenant-context.tsx + exact global-tenant-selector.tsx. Existing bounded usage event read, typed DELETE client, complete paginated tenant/error states. No legacy public changes.
- VFY-UI13 actual spawn `/root/orv13_verification`: gpt-6-luna/max/fork-none, new uniquely prefixed verifier tests/harness/raw/receipt only. Separate real HTTP/backend and browser tests on final served build. Must wait owner freeze before final frontend build; no product edits.
- UI13-SETTINGS actual spawn `/root/orv13_settings`: gpt-6-luna/max/fork-none; settings features only, no backend/client/shared UI ownership. Completes operator UX supported by actual immutable native revision adapter, preserves backend scope restrictions.

## Initial independent findings and assigned fixes

- Shell stale health can remain healthy; overview missing reads show zero/degraded/DB error rather than unknown. COCKPIT fixes state semantics.
- Usage and workflow/overview reads are not fenced across tenant/window changes. USAGE/JOURNEYS/COCKPIT own their scopes.
- Callback initial failure remains loading and failed refresh leaves stale rows actionable. JOURNEYS fixes fresh-state gating.
- Usage raw JSON lacks operational ledger/table, despite existing service event primitive. BACKEND exposes scoped DTO, USAGE supplies UI.
- Overview chart uses latest100 sampled rows but suggests complete history, mouse-only interactions; mobile duplicate nav does not wrap. COCKPIT fixes truthful labels/access.
- Soft delete exists internally/BFF but no client/UI; workflow mutation controls show to viewers; selected operation/filter state does not survive browser history. BACKEND/JOURNEYS own wiring.
- Tenant roster first100 and no error state; BACKEND owns cursor/error/selection semantics.
- Deployment/maintenance/full incident lifecycle and global deployment settings lack runtime adapters; no fabricated enabled actions/telemetry or broad AOPS acceptance. Further implementable gaps will be reviewed before closing this user task.

## Architecture decisions and dependencies

- Reviewer approved BASIC_ADMIN_USAGE_V1 additive admin event projection from actual persisted simple UsageEvent rows, separately from the strict rich public COST exporter. Existing rich exporter rejects current simple events; it cannot be the sole operator ledger. Backend owns bounded tenant-fenced projection, internal route/BFF/client; missing event provenance remains null, operation attribution is labeled. Public rich exporter unchanged.
- Additional backend route wiring lease must be exact and additive, confirmed with root before editing shared bootstrap/router. Request query defaults receivedAt to align with summary; cursors bind query identity.
- User answered Docker Compose on host. Proposal [UI13-COMPOSE](ORV13-COMPOSE-ADAPTER-PROPOSAL-2026-10-11.md) is architecture input for a follow-up actual host adapter, not a fake completed UI. No host environment mutation or preexisting stack rollout authorized/executed by this development task.

## Coordination checkpoint — 17:02 UTC

Six Luna executors are active in real runtime, independent reviewer initial audit completed with ten findings and basic-ledger architecture decision. New source is visibly progressing (overview/settings/workflow/basic usage module/new internal usage route). No stalled-worker inference or duplicate dispatch; no final build slot granted while shared source is changing. Tester prepared scenarios only. Current implementation/verification/acceptance = in progress / pending / open. Scheduler remains UNVERIFIED, no timer created.

## Compose dispatch and first-slice handoff

Independent architecture [APPROVED for implementation](reports/raw/orv13-review/compose-architecture.md), not live acceptance. Root delivered actual followup tasks to existing matching Luna workers `/root/orv13_backend`, `/root/orv13_usage`, `/root/orv13_cockpit` with exclusive disjoint paths and shared contracts frozen first. Root is not implementation owner. Settings/journeys remain on their original lanes. Tester prepares final API/browser plus isolated Compose fixture; final build not yet granted.

First-slice owner evidence: cockpit5 focused smoke, usage6 focused tests, backend5 focused tests + orchestrator typecheck. These are owner checks, not independent acceptance. Shared frontend typecheck has red/transient co-owner errors (operations/system-operations/settings depending snapshot); final freeze/build must resolve them. Tenant-context intermediate syntax error was corrected by backend; do not erase the old red logs. First-slice source-frozen receipts are `orv13-cockpit.md`, `orv13-usage.md`, `orv13-backend.md`. No skipped/red check counted as pass.

## Evidence

Initial ORV12 source manifest: 213 files matched before this wave (prior status turn). New source/build evidence required after changes. This ledger is not proof of implementation or acceptance.

## Coordination checkpoint — 17:34 UTC

Runtime roster: backend, cockpit, usage/host, independent verification and independent reviewer are running; journeys completed. Settings source-frozen receipt is present. Existing owners retain their disjoint leases. No final build/execution slot granted while Compose source is changing. Managed environment observations are current, connected/running with unrestricted enforced network and no configured credentials. Scheduler UNVERIFIED; no timer created.

| Delivered slice | Owner implementation evidence | Independent verification | Acceptance |
|---|---|---|---|
| Operations/callback/workflow journeys | [receipt](reports/orv13-journeys.md): frontend typecheck, owner + ORV12 helper tests12/12, AWEB17 tests6/6 | Pending actual API/browser scenarios | Open |
| Native settings editor | [receipt](reports/orv13-settings.md): owner5/5, frontend typecheck, scoped diff check | Pending actual API/browser conflict/role/tenant cases | Open |
| Basic usage, tenant selector, cockpit | First-slice receipts above; old transient red logs retained | Pending final build | Open |
| Compose durable API/host/UI | Actively implementing reviewer fixes | Tester harness preparing only | Open |

Review follow-up fixes are dispatched through actual messages to current owners, not new overlapping writers:

- UI13-COMPOSE-BACKEND: fix nullable-row locking, same-body submit and completion replay, pre-spawn failure transition, five-minute execution lease, replica observations, pinned-image readiness, and exact reconciliation request/ACK replay. Approved narrow runner-only `GET /runner/jobs/:jobId`, host-scoped expiration sweep/current state version, for recovery of reports rejected after lease expiry. No browser proxy/public route.
- UI13-COMPOSE-HOST: genuine image inspection, aligned token contract, process/journal quiescence proof, unique full-project image-vector release inference, pending-report preservation and explicit UNKNOWN reconciliation with replay after lost ACK. Immutable manifest policy remains intact; isolated root-owned test fixture may be created with a disposable helper, never by changing repository/preexisting stack ownership.
- UI13-COMPOSE-UI: unconditional session bootstrap, scoped health reads, global expiry event/recovery and inert draft-preserving UI. Backend shared-client lease additionally covers confirmed401 latch across instances; session/CSRF401 aborts subsequent mutation, explicit successful session recovery clears latch.
- Narrow `upstream.ts` actor-proof extension: only validated session cookie/CSRF are forwarded; API independently validates cookie with bearer removed, fails closed on invalid/expired proof and records trusted subject/issuer. No browser-provided identity header/body. Reviewer checks actual session-store/secret wiring before approval.

Docker Compose is the user-confirmed target. Actual disposable-host and exact-served-bundle verification remain required. Complete17global settings editing, rich COST provenance/budget configuration, durable incident lifecycle, destructive cleanup/database rollback, two-replica rollout/zero downtime and customer cutover are not inferred from this adapter or the UI projections.

## Product source freeze and independent execution slot

All product owners explicitly declared source freeze through actual runtime messages. Host and UI receipts are [host](reports/orv13-compose-host.md) and [UI](reports/orv13-compose-ui.md); backend receipt/hashes are being written after its freeze declaration. Host10 focused tests + orchestrator typecheck; UI11 focused + AWEB17 regressions6 + frontend typecheck; backend route4 + shared-client lifecycle test, both typechecks and additive OpenAPI generation/validation passed. These remain owner evidence only. Runbook-only correction of the illustrative rollback source list does not unfreeze product source.

Root delivered FINAL EXECUTION SLOT to `/root/orv13_verification`: exclusive orchestrator/admin-web build/dist, real isolated API/BFF/Chromium cases, and a new disposable Compose host fixture. Root-owned fixture subtree can be provisioned with an isolated disposable helper preserving ownership via `docker cp -a`; existing repository/host ownership and stacks must not be changed. Only verifier-owned project/helper resources may be cleaned up. Cloud Docker instructions, source/bundle provenance, earlier red logs, explicit pass/fail/skip and no command-repeat recovery evidence are required. Root runs no builds/tests/host mutations. All source leases remain frozen unless a concrete independent failure is handed back to the exact owner.

Current state: delivered implementation / independent verification RUNNING / acceptance OPEN. Reviewer completed source-audit turn and will be reopened on the same agent for final frozen-source/served-bundle/host evidence.

## Independent verification first intake — corrections open

Supported Node24.21/pnpm10.18 builds of contracts/orchestrator/admin-web passed; tester recorded served `index-Db7WOGsG.js` provenance (full SHA in final receipt). No product drift during build. Earlier UUID fixture setup failure and subsequent selector/listener/asset-serialization harness errors are retained separately; they do not establish product failure or functional pass.

Actual independent product findings handed back through a real followup turn to `/root/orv13_backend`, narrow original usage/BFF lease only:

- Malformed/overlength persisted usage attribution/date can make BASIC page return502 instead of200 plus `skippedInvalidEvents`. Final projection must safeParse and skip diagnostically.
- BASIC limit1 page2 repeats its first row. Exact PostgreSQL microsecond timestamp must survive cursor encoding/SQL bind; JS Date ISO millisecond truncation is unsafe for this keyset.
- Invalid raw event IDs at a page boundary must not generate unusable cursors. Root approved BASIC-only opaque cursor with exact `received_at` plus fixed SHA256(event_id) SQL tie key for all scanned rows, matching predicate/order and preserving scope/query binding. No public rich exporter contract/order changes. Actual PG malformed-boundary and microsecond pagination cases required.

Settings role gate, internal terminal-delete/CSRF conditions and shared401 transport latch have actual independent passing checks. Populated callback retry reached actual receiver/DB DELIVERED but its whole browser case remains pending after artifact serialization error. Usage tenant-B browser outcome remains unresolved and must be traced after the API fix. No partial run count or owner smoke is promoted to acceptance; final independent receipt and named exact-build review still required.

Scoped BASIC correction refrozen17:59, owner7 focused/typecheck pass; owner's local5433 live-PG attempt is unavailable, not a pass. Tester-owned actual isolated PG artifact `reports/raw/orv13-vfy/admin-ui/usage-microsecond-pagination.json` now records an invalid boundary skipped once, exact six-fraction timestamp preserved, two subsequent valid rows once each and page exhaustion; whole-suite outcome remains pending.

Root read-only host security follow-up opened a narrow actual runtime followup for `/root/orv13_usage`, retaining its existing host paths: set fixed clean Compose environment to disable implicit unpinned `.env` reads while retaining explicit pinned `--env-file`; reject invalid Compose project names at manifest validation. No browser/backend DTO changes. Owner focused checks/refreeze and tester genuine Compose sentinel proof required. Source/build provenance must include this correction; existing frontend bundle need not be rebuilt when frontend source is unchanged.

## Independent verification split and hardening handoff — 18:13 UTC

Actual runtime spawn accepted `/root/orv13_compose_verification` (gpt-6-luna/max/fork-none), packet **VFY-UI13-COMPOSE**. Main verifier explicitly released the planned Compose fixture before dispatch; no overlapping writer. Exclusive test lease: `tests/workflow-api/orv13-vfy-compose-host.test.ts`, uniquely named `orv13-vfy-compose-*` helpers, `reports/raw/orv13-vfy-compose/**`, `coordination/reports/orv13-compose-verification.md`. No product/docs/package/build/dist writes. Independent Compose tester owns real PG/API, genuine disposable Docker Compose/runner and mounted Compose UI proof, including role/CSRF/CAS/idempotency/UNKNOWN recovery and implicit `.env` sentinel vs explicit pinned env-file.

`/root/orv13_verification` remains sole shared build/dist owner and owns the other mounted Admin journeys. It rebuilt the frozen host CLI after the narrow hardening: `dist/compose-operations-runner-cli.js` SHA256 `87603259d0687f77c8a5388350f62aa1e2d4554c6a9cd306c1103d335ecdbfd6`, mtime18:12:48Z. Compose tester consumes this artifact without rebuilding; exact source/bundle/CLI provenance belongs in both final receipts.

Disposable root-trusted fixture setup is authorized only within a newly created isolated subtree/project/helper prefixed `orv13-compose-vfy-*`. If client-side `docker cp -a` cannot preserve uid0, a disposable root helper may bind only the new fixture parent and create/chown only NEW child fixtures (root0755/0644); journal is separate service-user0700/0600. Verify bind visibility with a harmless new marker/lstat. Never change repository/preexisting path ownership or other stacks, never weaken manifest trust checks; clean only own resources. No customer host deployment or production data mutation.

Independent main intake: BASIC API/actual-PG corrected cases now3/3 pass, including malformed-event skip and microsecond keyset exhaustion. Actual mounted browser auth lifecycle now1/1 pass: real BFF401, protected shell inert/no further reads, retained draft, same-scope verify recovery and changed-scope SESSION_CHANGED lock. Mobile viewport checks320/390/768 pass. Full receipts and final named independent exact-build review remain pending; no broad acceptance inferred.

## Final source-review follow-up — Compose job-history precision

Named independent reviewer reported MEDIUM: descending Compose history keyset converts PostgreSQL `created_at` to JS Date/millisecond ISO, so jobs within the same millisecond can be permanently skipped. Root delivered actual `followup_task` to matching Luna owner `/root/orv13_backend`, narrow original `compose-operations/service.ts` + unique owner tests/receipt/raw lease. Exact SQL six-fraction cursor time and precision-preserving decode/predicate required; no public API contract change. Compose verifier receives genuine PG limit1/microsecond/exhaustion case; main verifier remains sole affected orchestrator rebuild owner after refreeze. Existing frontend bundle remains valid when frontend source is unchanged. Finding remains OPEN until fixed/refrozen and independently verified/reviewed.

## Exact-screenshot review follow-up — readable mobile operation actions

Reviewer found residual IR13-10 MEDIUM in actual `callback-delivered-mobile-320.png`: result download link squeezed to a one-character vertical column despite no horizontal overflow. Root delivered actual narrow followup to original Luna `/root/orv13_journeys`, operations-screen.tsx action layout only + unique owner test/receipt/raw. Readable wrap/shrink/min-width at320/390 required, preserving behavior. Main verifier sole frontend build slot after owner refreeze; updated populated download/callback screenshots and final served bundle digest required. Compose verifier consumes the final shared bundle for its own UI proof. Other frozen source remains untouched; previous viewport scrollWidth checks do not close this finding.

Independent additional intake: actual cockpit tenant projections/permissions/stale-last-good browser case1/1 and Operations browser history/terminal DELETE+audit case1/1 pass. Real BFF baseline distinguished from injected503 presentation check. Remaining main Usage/Settings/callback focused final reruns and Workflow viewer/CAS case pending.

## Both final source corrections refrozen; shared artifacts updated

Backend exact Compose history time correction: owner5/5/typecheck/scoped diff pass, source `a4a514fed90d0366ad5129d48992cc634368d113a4a08972ecfe4692a94ac01b`; main independent tester rebuilt orchestrator (exit0), service JS `b4e663cab4a313eda53056e240c018ca7542641af00b7a2e04bf26f7fa988841`. CLI entry hash remains `87603259d0687f77c8a5388350f62aa1e2d4554c6a9cd306c1103d335ecdbfd6`; entry alone does not identify all imported service changes. Compose tester receives both hashes for actual-PG history proof.

Mobile operation action correction: owner5/5/frontend typecheck, original journeys receipt/refrozen source `0720c59fb00283cb8066d3b0941495fe9a5d17eb7964411d51b107f11751b5eb`. Main sole-owner frontend rebuild passed tsc/Vite. Final JS `index-BO7-bJEd.js` SHA256 `8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a`; HTML `c8deadba1b4b81476d7e295053ca4c300a31196fc99fa638418b14587a1d9184`, CSS `index-B-iqGBQY.css` `25ea028bbccf360d53be25daa6a8fc471e85fcda123620d9d9437ada77339d4f`. Both verifiers receive final artifacts; populated mobile readability/affected browser cases and reviewer verdict still pending. Previous bundle evidence retained as historical scoped proof, not final affected-control approval.

## Genuine host first probe — claim500 correction open

Independent Compose tester confirmed root-owned/helper bind-visible fixture paths and actual Engine28.4.0/Compose2.40.3 behavior: implicit `.env` sentinel ignored with fixed guard, explicit pinned env-file respected. First CLI transport failure `runner_api_network` was independently classified as a tester harness defect: synchronous child spawn blocked the same-process HTTP listener. Harness changed to async spawn; old red retained.

After that correction, genuine built CLI posts runner snapshot200 then claim500 even with no queued jobs. Root read-only source identified unqualified `JOB_COLUMNS` in `compose_jobs j JOIN compose_target_state t`, which shares host_id/project_id/target_revision and can raise PG ambiguous-column error. Actual narrow followup delivered `/root/orv13_backend`, original service.ts/test/receipt lease only; qualify joined job columns and inspect other new Compose joins. Independent tester confirms actual PG code and reruns empty-claim/claim-race/full host chain after refreeze; main sole orchestrator rebuild owner. This remains an OPEN product candidate until exact PG evidence/refreeze/independent green, not a declared host capability pass.

Main Usage mounted tenant-B200/empty was traced to a separate harness fixture: freshly inserted received_at lies after explicitly exclusive default To minute boundary. Only verifier-owned received_at rows are shifted into the applied window; exact request bounds/row clocks recorded and earlier red retained. No product default changed solely to satisfy the test.

Actual PG evidence now CONFIRMED: `42702`, safe message `column reference "host_id" is ambiguous`; actual CLI snapshot200→claim500 in `reports/raw/orv13-vfy-compose-host/initial-runner-result.json`. Exact backend owner received this evidence and is qualifying claim projection. Root explicitly extends Compose verifier's exclusive raw lease to `reports/raw/orv13-vfy-compose-host/**` in addition to original `reports/raw/orv13-vfy-compose/**`; no overlapping writer, existing raw proof retained without relocation.

## Claim SQL correction refrozen and rebuilt

Owner explicitly refroze `JOB_COLUMNS_J` qualification, six focused owner checks/typecheck pass, all other new Compose joins checked. Latest service TS SHA256 `05875a12856dadbc4a3d1f86787727a8544f9c8cb87f21e618a90fec63afb9df`. Main independent build owner rebuilt orchestrator with Node24.21 (tsc exit0); current service JS `197d6bdd3bb32ba869165d0a5d66e98f8b3673f87575c073807e05b22e53f7f7`, CLI entry remains `87603259d0687f77c8a5388350f62aa1e2d4554c6a9cd306c1103d335ecdbfd6`. Actual delivery to Compose tester confirmed, prior service hashes retained as earlier checkpoints. Genuine no-job claim/apply/restart/rollback and protocol/UI outcomes still pending; owner pass is not independent verification. Final frontend unchanged.

## Genuine preview502 receiver correction opened

Actual isolated BFF preview calls returned502, recorded in `reports/raw/orv13-vfy-compose-host/preview-probe-failure.json` and `unknown-preview-probe-failure.json`. Root read-only source found `getProjectRow` extracts `executor.query` then invokes it without its receiver; real PG PoolClient needs `this` even though a closure-based Db wrapper/mock can conceal the failure. Actual narrow followup delivered original backend owner service.ts/test/receipt lease to retain receiver and inspect other new-module extracted PG methods. Tester captures safe underlying cause and independently reruns genuine preview→submit→claim/start/complete; source remains reopened until freeze. Main retains sole orchestrator build ownership. No client/UI contract changes inferred; preceding green source/build checkpoints preserved.

## Main independent receipt delivered; preview receiver refrozen

[Main VFY-UI13 receipt](reports/orv13-verification.md) delivered: actual final-bundle full run14/14,0 failed,0 skipped (5 API/PG,8 mounted UI,1 Node transport), raw `reports/raw/orv13-vfy/admin-ui/admin-ui-final-bundle-full-rerun.log`. Chromium200 JavaScript body, authenticated direct fetch and disk final asset all match `index-BO7-bJEd.js` SHA8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a. Earlier unauthenticated fetch hashed login redirect body; classified harness measurement, not loaded JS. Callback real dispatcher/HTTP receiver, Usage held actual response and sourceclock fixture correction, workflow/settings CAS, auth recovery, tenant/role and mobile-readable controls are separately evidenced. Main scope VERIFIED; final review/Compose acceptance pending.

Owner preview receiver correction refrozen18:37: sole extracted query is now bound; receiver-sensitive preview plus combined owner suites7/7/typecheck/scoped diff pass, updated backend receipt preserves prior actual502. Main rebuild dispatched through actual runtime message; imported service hash must be updated after this final correction before host/protocol verification. Frontend unchanged.

## Genuine apply reaches host; populated inventory parser follow-up opened

Preview receiver underlying cause confirmed by tester as TypeError from detached real PoolClient.query; direct internal500 maps to BFF502. Corrected backend source/current build pair delivered: TS `6956072ce71e732eb4f9823242cd0914017e4127de483d61df8defba6ad6b55d`, service JS `ae86f2cb4183b6d6dff0ced9fedab6639d11cb11cd68821dcff76bc9d5043932`; CLI entry unchanged. Genuine UI preview/confirm→runner claim/start→Docker apply now executes, produces4 running pinned-image replicas, then durably records UNKNOWN/EXECUTION_UNCERTAIN with INVENTORY_UNAVAILABLE. Sanitized actual chain proof at `reports/raw/orv13-vfy-compose-host/compose-apply-a-lost-ack-diagnostic.json`, includes intentionally dropped completion ACK. Running containers/exit0 do not establish job success or replay correctness.

Root delivered actual narrow host followup `/root/orv13_usage`, original host-executor.ts + own tests/receipt/raw lease only. Source candidate: `.trim()` before split of inspect output drops the final empty Health field's trailing tab; tester also checks actual fixed-format tab bytes. Preserve strict selected-field parsing/bounds and empty health NONE, no broad fallback/secret inspect. Tester-owned existing UNKNOWN fixture stays fenced, no blind action retry; genuine post-fix inventory/reconciliation/report-only replay or fresh isolated chain required. Main is sole shared rebuild owner and must include imported host-executor hash. Frontend/main14/14 remain verified; overall acceptance open.

Evidence note: original failing callback320 PNG was overwritten during final capture and no backup exists. Final corrected screenshots are valid; historical reviewer finding/pre-fix source/bundle/raw logs remain, but do not claim the old image itself is retained. Main receipt now states this limitation and explicit CWD/teardown semantics.

Actual selected Docker probe confirms the primary populated-inventory failure: fixed template `{{if .State.Health}}` raises missing-key error for containers without a Health map (Engine28.4.0/Compose2.40.3), before parser processing. Exact selected safe probe/actual0x09 separators and four running states are retained in `compose-apply-a-lost-ack-diagnostic.json` (`exactContainerInspectProbe`, `selectedContainerInspectProbe`). Host owner explicitly authorized within same exact lease to use safe missing-map access, report NONE when no healthcheck, and preserve empty last-field parsing if applicable. Do not manufacture health or downgrade all read failures to NONE. Actual tester proof/root-to-owner runtime delivery confirmed.

## Additional independent finding IDs for final review

| Finding | Evidence and disposition | Required remaining evidence |
|---|---|---|
| IR13-11 | Compose history microsecond precision; reviewer source finding, corrected/refrozen exact SQL clock | Genuine PG limit1 same-millisecond paging/exhaustion in Compose receipt |
| IR13-12 | Actual runner claim500/PG42702 from unqualified joined job columns; fixed/refrozen | Full real claim/start/protocol receipt; first post-fix chain already reaches start/complete |
| IR13-13 | Actual preview502/internal500 TypeError from detached PoolClient.query; bound receiver/refrozen/rebuilt | Final real preview/submit/protocol receipt; first post-fix UI preview/confirmation already reaches Docker |
| IR13-14 | Actual populated inventory fails missing Health map; safe candidate additionally proves trailing empty health field lost by global trim | Narrow host fix/refreeze/build + genuine populated inventory, apply/restart/rollback, no-health NONE and UNKNOWN/report/reconcile proof |

Previous IR13-10 mobile action remainder corrected on final bundle and independent14/14; named reviewer final visual verdict pending. IDs describe real scope only, not new umbrella gates.

## Main scoped independent review delivered; roster proof added

Named independent reviewer delivered **APPROVED main API safety slice + UI_APPROVED main tested journeys**, exact final `index-BO7-bJEd.js` digest above. Source/assertions/API/PG/callback/auth/CAS evidence and eight final screenshots inspected; IR13-10 mobile header remainder closed. [Review report](reports/orv13-ui-review.md) explicitly keeps Compose controls/host, full AOPS/global17/richbudgets/incidents/HA/customer cutover and broader axe/fullkeyboard/fullHITL unverified scope open. Main tested14-case slice ACCEPTED only within this scoped verdict; no parent gate tick.

Root sent an actual narrow extension to original independent `/root/orv13_verification`: one test-only real PG/BFF mounted >100-tenant roster case (IR13-09), persisted tenant beyond page1, cursor requests/stable selected scope and retryable truthful load error. Original exclusive verifier test/raw/receipt lease, no product/build changes, no broad rerun. This closes a concrete current pagination evidence gap rather than expanding unrelated suites; incremental outcome/reviewer assessment pending.

## Populated inventory correction refrozen and rebuilt

Host owner12/12/typecheck/scoped diff pass, safe optional Health map lookup and final-empty-field preservation refrozen. Main sole build owner tsc exit0 with Node24.21, exact current source/imported artifacts:

- host-executor.ts `e086ff4213652ba349105a1d633ad1eda9315940b4af7acc41cb064bee10af52`, host-executor.js `fa06b4d9a3d8c26a047aad552920a6663dcd1962be8ae262d15884e36bba8670`.
- service.ts `6956072ce71e732eb4f9823242cd0914017e4127de483d61df8defba6ad6b55d`, service.js `ae86f2cb4183b6d6dff0ced9fedab6639d11cb11cd68821dcff76bc9d5043932`.
- CLI entry `87603259d0687f77c8a5388350f62aa1e2d4554c6a9cd306c1103d335ecdbfd6`; final frontend unchanged.

Actual delivery to Compose tester confirmed, fresh isolated fixture rerun pending. Previous UNKNOWN job never blindly re-executed; tester uses new per-run own project and cleans only own resources. Final real host/protocol/browser receipt and incremental reviewer verdict required.

## Independent final-chain progress and supplemental roster evidence

Main supplemental IR13-09 case delivered: one new unique focused pass (14 other cases explicitly filtered/skipped) on unchanged final bundle, real127-tenant BFF pages100+27, persisted selection at index126, change away/back and actual Usage tenant fence. Injected503 presentation is separately labeled; retry/pagination/Usage are actual BFF/PG. [Main receipt](reports/orv13-verification.md) now links exact raw/screenshots/test SHA `96d67b5815d4673db7325b06efb7cc1e380ec04995532c8a2c6e1171e5930250`. This does not mean a new15/15 full-suite run; reviewer incremental assessment pending.

Composer verifier checkpoint: actual UI-confirmed apply succeeds with4 replicas and no-health NONE; exact completion ACK loss retry200 has one ACTION_OUTCOME/COMPLETE_ACK, altered report409. Actual restart, releaseB and approved rollback reached passing assertions; full scenario still pending its tail. Audit-trigger rollback harness originally expected500 but BFF correctly sanitized it to502; tester adjusts only expectation, preserves red, asserts unchanged job count. Final partial apply/history,320/390 Compose screenshots, complete receipt/own cleanup and named reviewer verdict pending. No further product-source reopen from this harness mapping mismatch.

## Final Compose raw run delivered; incremental review running

Independent actual Compose final raw `reports/raw/orv13-vfy-compose-host/jest-final-run.log` records two scenarios passed, zero failed/skipped. Nested named subcases prove real Apply A, restart, release B, approved rollback A, missing-image PARTIAL with pull disabled, audit-insert failure transaction rollback (BFF502/UPSTREAM_ERROR) and retry, plus five actual PG six-fraction history rows returned once with limit1. UNKNOWN expiration/reconciliation remains a controlled fixture clock/protocol case, not an actual runner-crash claim. Actual mounted Admin Apply A and final320/390 preview/result images are available. Final verifier receipt/provenance/cleanup are still pending; raw green alone is not acceptance.

Root delivered actual final-review followup to the same named independent reviewer, retaining its read-only product/test lease and review report/raw write lease. Review covers the supplemental127-tenant roster, frozen IR13-11..14 source corrections and actual Compose host/API/UI evidence on unchanged final JS. Main scoped verdict remains recorded. Final Compose and supplemental acceptance await the incremental reviewer; no parent/release gate changes.

## Final incremental mobile evidence gap

Named reviewer confirmed the127-tenant roster supports scoped IR13-09 closure and IR13-11..14 source fixes match current frozen hashes. Compose320/390 screenshots showed readable modal headers but did not show Confirm/per-service results below the scroll fold; existing harness checked x bounds without viewport y visibility. This is an evidence gap, not a new product defect. Actual runtime message sent to original independent Compose tester under the existing test/raw/receipt lease: scroll actual modal, capture visible Confirm/outcomes at320/390 with y bounds within850, and rerun only the affected first scenario. Preserve previous full2/2; report added focused pass/deselection separately. No product source/build reopens, no duplicate tester or unrelated reruns. Final Compose verdict still pending.

## Final modal follow-up verified and visually reviewed

Independent `jest-focused-mobile-run.log` records the affected first Compose scenario1 passed/1 deliberately filtered skip, zero failed, on unchanged frozen artifacts. Prior full2/2 remains separate, not added again. New `compose-preview-confirm-mobile-{320,390}.png` and `compose-result-outcomes-mobile-{320,390}.png` are visually reviewed: Confirm/Cancel and both service outcomes are legible in the modal viewport, with x/y bounds within850 asserted and actual Confirm activation at320. Reviewer reports the narrow mobile evidence gap resolved; no new source defect. Final bounded verifier receipt/provenance and positive own-resource cleanup proof are pending before final Compose verdict.

## Final handoff — independent verification and scoped acceptance

Final owner source remains frozen. Independent [main receipt](reports/orv13-verification.md)14/14, zero failed/skipped, plus supplemental roster1 pass/14 filtered; independent [Compose receipt](reports/orv13-compose-verification.md)2/2, zero failed/skipped, plus focused mobile1 pass/1 filtered. All final commands exit0; repeated runs are not added to counts. Final [reviewer](reports/orv13-ui-review.md) APPROVED main safety and allowlisted Compose API/host protocol; UI_APPROVED exercised main and320/390 Compose preview/confirmation/result on index-BO7-bJEd.js, SHA2568e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a. IR13-09 pagination/retry, IR13-10 tested mobile controls and IR13-11..14 actual history/claim/preview/inventory failures closed in the tested scope. This supersedes earlier pending statements only for this delivered slice.

| Delivered scope | Code | Independent verification | Independent acceptance |
|---|---|---|---|
| Tenant/window/session fences, roster, typed usage, native scoped Settings, Operations/callback and Workflow revisions, truthful cockpit | Implemented/refrozen | Main14 and roster1 on final bundle | APPROVED/UI_APPROVED tested journeys; broader permutations remain open |
| Allowlisted Compose catalog/preview/durable jobs/host runner/apply/restart/approved rollback/replay/reconcile | Implemented/refrozen | Real Docker/PG/API full2 and focused mobile follow-up | APPROVED/UI_APPROVED exercised protocol and320/390 controls |
| Full17 global settings, rich COST/budgets, incident lifecycle, queue/data maintenance, XML conversion, HA/customer cutover | Canonical backlog, not implied delivered | Not closed by these receipts | OPEN; acceptance and next work in canonical plan §6 |

Actual host uses synthetic sleep-only containers. UNKNOWN expiry is controlled DB-clock injection, not actual process crash. Compose disk hashes cross-reference the main actual Chromium200 loaded-body equality; final current imported module hashes are recorded, not just CLI entry. Positive exact-project Docker/network/fixture-dir cleanup is proven; schema drop is afterAll attempt, not a positive catalog-absence query. Original red logs preserved; old failing operation320 image was overwritten without backup and is not claimed retained. [Host runbook](../docs/41-compose-operations-host-runbook.md) records immutable manifest installation/configuration/limits and manual reconciliation. No deployment/data cutover/commit/push or broad historical parent gate changes. Root writes plan metadata only. Scheduler UNVERIFIED; no timer created.
