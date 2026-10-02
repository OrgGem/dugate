# PAR00-MAP — evidence map: PAR-00 journeys / mismatches ↔ existing receipts (READ-ONLY)

**TaskRef:** task_706677ac9372
**Spec:** `du-rework/coordination/dispatch-specs/2026-10-02-0245-PAR00-evidence-map.md`
**Status:** aggregation only. **No classification is signed here** — `required / post-cutover / retire` remains Product's decision. No source was re-verified (receipts + `tasks/` only, per spec §Cấm), no code written, no gate ticked, no commit, no message to `nocobase-10`. The only file written is this receipt.
**Not touched:** `tasks/*.md`, `AGENTS.md`, execution overlay, lockfile, `services/orchestrator/src/server.ts`, `packages/contracts/src`.

## Sources read (evidence base)

| Receipt | Date | What it contributes here |
|---|---|---|
| `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` | 2026-10-01 | the baseline: J01..J06 proposal, `PAR00-M01..M05`, dependency register (read in full) |
| `reports/qwen-admin.md` §66 | 2026-10-01 | admin-operator journey classification (the PAR-00 survey companion) |
| `reports/codex-j01-j03-auth-apikey-characterization.md` | 2026-10-01 | J01/J02/J03 source characterization incl. what actually authorizes a request |
| `reports/codex-local01-admin-local-users-2026-10-01.md`, `codex-local02-auth-primitives-2026-10-01.md`, `codex-local-auth-cutover-characterization-2026-10-01.md` | 2026-10-01 | LOCAL-00..06 state feeding M05 / J01 |
| `reports/codex-functest-b-orchestrator-offline-2026-10-02.md` | 2026-10-02 | the only receipt with **executed** per-suite literals: 104 suites, 102 green, 2 red, 31 skipped-live |
| `reports/codex-comp01-slice-a…f-*-2026-10-02.md` (A route matrix, B profile/connector matrix, C output-action map, D lifecycle/pagination, E webhook divergence, F legacy encryption touchpoints) | 2026-10-02 | legacy-side characterization + rework counterpart deltas |
| `reports/codex-legacy-opsadmin-settings-journeys-2026-10-01.md` | 2026-10-01 | legacy ops/settings/analytics journeys (dashboard time-series) |
| `reports/qwen-admin.md` §65 (ORCH-PAR-01 api-key mutation) | 2026-10-01 | the one rework-side **production-code** cycle for J02 |
| `tasks/API-COMPAT-DUGATE-2026-09-28.md:64,73,84-89` | — | gate-dispatch: `READY-MODULE` vs `BLOCKED-COMP-00` |

## 1. `PAR00-M01..M05` × new evidence / remaining gap

### M01 — Admin issue/revoke key mutation

| | |
|---|---|
| **Survey said** | rework had GET only; `dispatcher.ts:95-114` had no create/revoke; form `POST /admin/api-keys/new` had no handler |
| **New evidence** | `qwen-admin.md` §65: `src/modules/admin-actions/dispatcher.ts` **+143 lines, 0 deleted**, two admin-only actions — `apikey.issue` (INSERT; raw passes only through injected `deps.hashApiKey`, only the digest reaches the column, raw returned exactly once in the 201 copy-once body) and `apikey.revoke` (`UPDATE … SET status='REVOKED' WHERE id=$1 AND status='ACTIVE'`, so revocation is effective because that column is the one auth filters on). Both go through `executeIdempotent` + `auditedMutation`, **no new dependency**, `server.ts` untouched. New suite `tests/admin-api-keys.test.ts` (29 tests, baseline 0), reported 29/29 ×3 + `tsc` exit 0 + regression `admin-action-dispatcher.test.ts` 55/55. |
| **Independently re-run** | FUNCTEST-B ran it: `admin-api-keys.test.ts` **29/0/0 exit 0** and `admin-action-dispatcher.test.ts` **55/0/0 exit 0** — two suites from a receipt that did not write them. |
| **Delta vs legacy (decision, not a defect claim)** | `codex-j01-j03` §J02: legacy POST **generates** the raw server-side (`dg_` + 256-bit random) and returns it once; the rework `apikey.issue` **accepts a caller-supplied raw key** and hashes it. Both receipts agree on this point, so it is a **parity delta to sign**, not a receipt conflict. |
| **Still missing** | (a) no `apikey.rotate` / `apikey.activate` action; (b) Admin **HTML** create/revoke forms still have no mutation handler, and the renderer comment claiming a `POST /api/v1/admin/api-keys` route is stale (that route is GET-only) — `codex-j01-j03` §J02; (c) no HTTP/browser create→DB/hash/audit→revoke→401 evidence: `admin-keyset-explain.test.ts` and `admin-mutation-atomicity.test.ts` are both **SKIPPED-live** in FUNCTEST-B; (d) URL/DTO for an Admin API/BFF still unfrozen (PAR-01). |

### M02 — Profile policy persisted + enforced

| | |
|---|---|
| **Survey said** | `server.ts:2466-2505` returns manifest / `revision:0` / `currentValues:{}`; `profiles.ts` pins Connector revisions only; legacy has lock/prompt/priority |
| **New evidence** | weak and **view-model level only**: `admin-profile-view-model.test.ts` **79/0/0 exit 0** (FUNCTEST-B). No suite was added for persisted policy revision, publish/diff, or admission enforcement. |
| **Still missing** | the whole M02 acceptance set: persisted policy revision + read/diff/publish, shared admission enforcement, "locked override denied per golden", no-write-on-deny, pinned-old-revision. `PAR-02` + `COMP-01/02` golden parameter inventory still owns it; the M-02 test matrix in the survey has **no executing suite today**. |

### M03 — Admin sees real revision; provider config/test usable after boot

| | |
|---|---|
| **Survey said** | `server.ts:2512-2555` builds a masked/disabled placeholder; credential route 503s unless injected; `main.ts:105-129` passes no workflow/base URLs |
| **New evidence** | connector + credential + crypto-config surfaces have offline suites: `connector-revision-http-offline.functional.test.ts` **8/0/0**, `connector-credentials-offline.functional.test.ts` **19/0/0**, `admin-connector-view-model.test.ts` **91/0/0**, `admin-config-cockpit.test.ts` **8/0/0**, `vault-transit-provider.test.ts` **9/0/0**, `admin-crypto-config.test.ts` **83/0/0**, `admin-crypto-config-oidc.test.ts` **6/0/0** (all exit 0, FUNCTEST-B). |
| **Still missing** | the survey's decisive claim — that a **production composition injects** `credentialWorkflow` / `connectorBaseUrls` — is still unproven, because the two suites that would show it are **SKIPPED-live**: `admin-crypto-config-wiring.test.ts` and `admin-crypto-config-shell.test.ts`. Slice F independently confirms legacy crypto is a single env-derived key with **no rotation surface** (`codex-comp01-slice-f…:§2-§4`), and the live encryption suite `rv0104-live-encryption.test.ts` is **SKIPPED-live**. Offline doubles are not deployment proof. |

### M04 — Versioned schema catalog for `schemaSlug`

| | |
|---|---|
| **Survey said** | no Admin schema catalog route/table in Orchestrator; legacy `app/api/internal/workflow-schemas/route.ts` exists |
| **New evidence** | **none on the rework side.** FUNCTEST-B ran **no** schema/workflow suite (a grep of its table for `schema|workflow|analytics|billing` returns zero suite rows). Legacy side is only characterized: Slice A §3 records the legacy schema route shape, Slice C notes **no `schemaSlug` action or dynamic schema-workflow recipe** in the inspected rework manifest/recipe catalog, Slice E maps the separate workflow-builder `callback` path and the `wb_schema:<slug>` AppSetting row. |
| **Still missing** | import → validate → publish → resolve, XXE/DTD + graph-invalid negatives, rollback, and the public `schemaSlug` mapping (COMP-09). This is the **least-evidenced** of the five mismatches: today it has characterization only, no executing suite on either side. |

### M05 — Admin local-only boot/login

| | |
|---|---|
| **Survey said** | `main.ts:95-128` is OIDC + static token only; shell-server mount requires cookie secret + adminToken |
| **New evidence** | LOCAL-01 landed real primitives: migration `0023_admin_local_users.sql` (tenant-bound table, self-describing password hash, role, enabled/locked, version counter), `src/modules/auth/admin-local/password.ts` (**scrypt N=32768, r=8, p=1**, 16-byte salt, encoding records params), `repository.ts` (tenant-fenced reads/mutations, SQL projections omit `password_hash`, audit written in the same transaction with rollback on audit failure), and `migrations-local-users-cli.ts` (password from **piped stdin only**, never argv; generic success/failure; never prints hash or password). FUNCTEST-B re-ran `admin-local-user-repository.test.ts` **10/0/0** and `admin-local-users-cli.test.ts` **10/0/0**. |
| **Caveat that must not be lost** | the LOCAL-01 receipt records its final acceptance typecheck **failing**: `npx tsc --noEmit -p services/orchestrator/tsconfig.json` → **ExitCode 1**, 4 × TS18047 in `src/modules/auth/local-primitives/authenticate.ts:91,112,113,114` — a file outside that packet's lease. FUNCTEST-B ran **no typecheck**, so the current state is **unverified**; re-run before relying on it. |
| **Still missing** | a local login/session actually mounted and reachable; `DU_ADMIN_AUTH_MODE` parsing (LOCAL-01 states it adds none); role taxonomy + role→action/tenant matrix (LOCAL-01 open question); 2-replica session/revocation evidence — `oidc-boot.test.ts`, `redis-session-repository.test.ts`, `oidc02-multi-replica-offline.test.ts`, `oidc02-process-replicas-offline.test.ts`, `admin-local-users-migration.test.ts` are all **SKIPPED-live**; and per `codex-j01-j03`, `ADMIN_TOKEN` at `POST /admin/login` still mints an `admin`-role cookie, so the M05 fixture "ADMIN_TOKEN does not become local identity" is **not satisfied**. |

## 2. `J01..J06` × supporting evidence / missing fixtures

`consumerId` / `fixtureId` status is identical on every row: **none exist yet**. The survey names `COMP-00/01` as sole owners ("chưa có consumer IDs", dependency register), slice F invented none (it was scoped to legacy crypto), and no receipt listed above emits an ID. Nothing in this map assigns one.

| Journey | Evidence supporting it today (all exit 0 unless marked) | Missing fixtures / blockers | `consumerId` / `fixtureId` |
|---|---|---|---|
| **J01** Admin login/session | `admin-oidc-flow.test.ts` 7/0/0 · `admin-shell-oidc-flow-integration.test.ts` 7/0/0 · `admin-shell-oidc-mount.test.ts` 6/0/0 · `admin-oidc04-claims-tenant-offline.test.ts` 11/0/0 · `admin-shell-auth.test.ts` 29/0/0 · `session-store.test.ts` 17/0/0 · `admin-local-user-repository.test.ts` 10/0/0 · `admin-local-users-cli.test.ts` 10/0/0 | **RED**: `admin-shell-session-lifecycle.test.ts` 50/1/**0 exit 1** (literal `Expected length: 1`, `Received length: 0`, at `:790`). **SKIPPED-live**: `admin-base-routes`, `admin-shell-live-pane`, `oidc-boot`, `redis-session-repository`, `oidc02-*`, `admin-local-users-migration`. Fixture "ADMIN_TOKEN ≠ local identity" unmet. | pending `COMP-00/01` |
| **J02** API key provisioning/revocation | `admin-api-keys.test.ts` **29/0/0** · `admin-api-key-view-model.test.ts` 84/0/0 · `admin-action-dispatcher.test.ts` 55/0/0 · `admin-idempotency.test.ts` 45/0/0 | **SKIPPED-live**: `admin-keyset-explain`, `admin-mutation-atomicity`, `admin-action-rbac-live`. No rotate/activate action; generation-model delta (§M01); Admin HTML handler + DTO unfrozen. | pending `COMP-00/01`; public `x-api-key` wire is `COMP-08`, not PAR |
| **J03** Profile policy | `admin-profile-view-model.test.ts` 79/0/0 (display layer only) | no persisted-policy / admission-enforcement / locked-field fixture at all; golden parameter inventory is `COMP-01/02`. | pending `COMP-01/02` golden |
| **J04** Connector config/credential | `connector-revision-http-offline.functional.test.ts` 8/0/0 · `connector-credentials-offline.functional.test.ts` 19/0/0 · `admin-connector-view-model.test.ts` 91/0/0 · `admin-config-cockpit.test.ts` 8/0/0 · `vault-transit-provider.test.ts` 9/0/0 | **SKIPPED-live**: `admin-crypto-config-wiring`, `admin-crypto-config-shell`. No Admin→Orchestrator→Connector path against a real composition; no `connectorId/revision` public fixture (`COMP-10`). | pending `COMP-10` for fixture refs |
| **J05** Schema catalog | **none** — no executing suite on either side (§M04) | entire fixture class: import→publish→submit→result/HITL, XXE/DTD + graph-invalid negatives, rollback. | pending `COMP-09` |
| **J06** Operator observability | `admin-operations-list-pagination.test.ts` 103/0/0 · `operations-list-contract-conformance.test.ts` 19/0/0 · `operations-list-cursor-sort-binding.test.ts` 54/0/0 · `admin-operations-sort-http-offline.functional.test.ts` 32/0/0 · `admin-operations-sort-wiring.test.ts` 47/0/0 · `admin-operation-view-model.test.ts` 277/0/0 · `admin-overview-triage.test.ts` 158/0/0 · `admin-overview-view-model.test.ts` 193/0/0 · `admin-audit-*` (30/26/30/21/67/0/0) · `admin-operation-cockpit.test.ts` 4/0/0 · `admin-p6-01-shell-fixtures.test.ts` 38/0/0 · `usage-drilldown.test.ts` 10/0/0 · `usage-aggregation.test.ts` 2/0/0 | **RED**: `adm-base-03-safe-error-offline.functional.test.ts` 18/1/**0 exit 1** (literal `Expected substring: "deferred section render error"`, `Received string: ""`, at `:210`). **SKIPPED-live**: `admin-audit`, `operation-tenant-fence`, `runtime`, `admin-shell-live-pane`. Slice D adds two **undecided COMP-00 items** that block J06 parity sign-off: the `next_page_token` dialect (op-id vs 4-slot cursor — "two dialects already exist") and set-vs-exact filter semantics. Dashboard time-series (PAR-07) has legacy characterization only (`codex-legacy-opsadmin-settings…:§4`), no rework analytics route found by the survey. | pending `COMP-00` (cursor/filter decision) |

## 3. Cross-cutting blockers visible in the evidence

1. **Two red suites, both offline-runnable and both left recorded, not fixed** — `admin-shell-session-lifecycle.test.ts` (J01) and
   `adm-base-03-safe-error-offline.functional.test.ts` (J06). FUNCTEST-B explicitly recorded them rather than editing.
   Neither is a live-only failure, so neither can be attributed to missing infra.
2. **31 suites SKIPPED-live**, including every suite that would prove a production composition or a real
   Postgres/Redis/S3/Vault path: `admin-crypto-config-wiring`, `admin-crypto-config-shell`, `admin-mutation-atomicity`,
   `admin-local-users-migration`, `runtime`, `operation-tenant-fence`, `admin-audit`, `artifact*-pg`, `migrations`,
   `data-02-04-live-s3`, `encryption-boot-options`, `rv0104-live-encryption`, `webhook-reclaim-fence`.
   ⇒ **The offline green set proves logic, not deployment.** Any PAR-00 line that says "works" needs one live run.
3. **Slice D's two COMP-00 decisions are on the J06 critical path** and are not PAR-00's to make.
4. **Legacy crypto has no rotation surface at all** (Slice F §4) — relevant to M03/G-ENC and to any cutover that
   assumes a key can be changed safely.
5. **Gate dispatch is unchanged and still splits the two kinds of work** (`tasks/API-COMPAT-DUGATE-2026-09-28.md:64,73`) —
   `COMP-02..09` stay `BLOCKED-COMP-00` for public wire mount, contract freeze and acceptance; module work marked
   `IMPLEMENTED` separately without ticking the parent. `READY-MODULE` rows (`:87-89`) remain the only rows that
   may proceed now, and none of them is a PAR-00 journey.

## 4. Questions for Product to sign, line by line (this map does not answer them)

Each line is a decision request. The right-hand column shows what evidence exists to inform it — it is **not** a
recommendation and no classification is implied.

| # | Question for Product | Evidence available to decide it |
|---|---|---|
| Q-M01a | Does `apikey.issue` keep the **caller-supplied raw key** shape, or must it **generate** like legacy POST (`dg_` + random, returned once)? | §M01: rework = caller-supplied + injected hasher (Mục 65); legacy = server-generated (codex-j01-j03) |
| Q-M01b | Is an Admin **HTML/BFF** mutation handler in cutover scope, or is API/CLI operation acceptable? | §M01(b): forms still have no handler; renderer comment stale |
| Q-M01c | Is `apikey.rotate` / `apikey.activate` required at cutover, or does legacy PUT-rotate/DELETE need no rework equivalent? | §M01(a) gap list |
| Q-M02 | Is persisted profile policy (lock/prompt/priority/endpoint) required at cutover, and if so does it gate on the `COMP-01/02` golden parameter inventory? | §M02: view-model only today |
| Q-M03 | Does J04 require proof that a **real composition** injects the credential workflow, or is an offline suite + one live run enough? | §M03: both wiring suites are SKIPPED-live |
| Q-M04 | Is schema catalog (`schemaSlug`) cutover-required given it has **no executing evidence on either side**? | §M04: zero suites |
| Q-M05a | Which auth mode becomes the cutover default, and is `ADMIN_TOKEN` retained as a separate machine credential only? | LOCAL-01 open questions (mode policy, `ADMIN_TOKEN` separation) |
| Q-M05b | Which role taxonomy and role→action×tenant matrix is approved? | LOCAL-01: schema leaves role unconstrained, module defines no matrix |
| Q-M05c | Are the LOCAL-01 scrypt parameters (N=32768, r=8, p=1) approved, or must a different primitive be used? | LOCAL-01 open question |
| Q-J01 | Can J01 be signed with one red session-lifecycle suite outstanding, or is that suite a precondition? | §3.1 (red, literal at `:790`) |
| Q-J02/J03/J04/J06 | Which fixture IDs from `COMP-00/01` attach to each journey row, and who issues them? | §2: all rows currently `pending COMP-00/01` |
| Q-J06a | Which `next_page_token` dialect wins — op-id or 4-slot cursor? | Slice D §6: "two dialects already exist" |
| Q-J06b | May COMP-06 **set** filter semantics replace legacy **exact** semantics on the legacy path? | Slice D §6 open item 2 |
| Q-J06c | Is dashboard time-series (PAR-07) post-cutover, or does an operator SLA make it required with a fixture? | legacy characterization only (`codex-legacy-opsadmin-settings…:§4`) |
| Q-cross | Are the 31 SKIPPED-live suites acceptable as "logic proven, deployment unproven", or does any gate require a live run before sign-off? | §3.2 |

**Not asked here, deliberately:** no new Admin URL/DTO is proposed (PAR-01..09 contract freeze not opened), and no
HPKE/DEK/AAD decision is touched (ADR-18 remains the user-blocker it is).

## 5. Acceptance mapping + commands

| Required | Where |
|---|---|
| 1. `PAR00-M01..M05` × new evidence / remaining gap | §1 (five subsections, each with survey baseline, new evidence, independent re-run, remaining gap) |
| 2. `J01..J06` × supporting evidence / missing fixtures, with `consumerId`/`fixtureId` still pending `COMP-00/01` | §2 |
| 3. Questions for Product per line, unanswered | §4 (15 questions) |
| No file edited outside this receipt | verified by `git status` — this slice wrote **only** this file (`?? coordination/reports/qwen-par00-evidence-map-2026-10-02.md`). Note the shared tree already carries other lanes' edits to `tasks/*.md` and `du-rework/AGENTS.md`; those are **not** mine and were not touched here. |

Read-only commands used (no test, build, lint or infra command was run): `read_file` on the survey and 10 receipts;
`glob` on `coordination/reports/**`; `grep_search` on `API-COMPAT-DUGATE-2026-09-28.md` (READY-MODULE / BLOCKED /
gate-dispatch) and on receipt headings. No source file was opened, so **no claim above is a fresh verification of
code** — every statement is attributed to the receipt it came from, with that receipt's own date.

**Two staleness flags for whoever acts on this:** (a) the LOCAL-01 typecheck failure is recorded as of 2026-10-01 and
was not re-run here; (b) M05/M03 depend on files that other lanes are actively editing (the working tree already
carries untracked `src/modules/auth/admin-local/`, `local-primitives/`, `migrations/0023_admin_local_users.sql`,
`boot-options.ts`), so "what exists" may already have moved since these receipts were written.
