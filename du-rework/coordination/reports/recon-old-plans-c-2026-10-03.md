# RECON-C — parity plans (2026-10-01) vs current evidence

**Task:** RECON-C · **Date:** 2026-10-03 · **Status:** read-only reconciliation. No test run, no source change, no gate ticked, no commit.

Scope: `tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md` (ORCH-PAR-00..10, 11 rows) and `tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md` (6 rows + 5 MISMATCH rows).

## 0. Method — same limits as RECON-A, plus one that matters here

`plan-open-task-register-2026-10-03.md` is a transcription only (RECON-A established that), so it was used solely to cross-check stated status. Every verdict below was re-derived from the working tree at HEAD `b088eec`.

**No tests were run** (dispatch constraint). For these two plans that bites harder than in RECON-A: almost every acceptance criterion is written as a *journey* (`create -> submit -> revoke -> 401`, `publish -> submit -> poll`), and a journey cannot be discharged by reading a route. So `done` below means *the named mechanism and its focused test exist*, never *the journey is verified*. Where even that is not determinable I say `uncertain` and name the gap.

**Line numbers in both plans have drifted.** The plans cite `server.ts:2466-2505` for the profile projection; that code now sits at `:2600-2601`. Any future dispatch quoting these plans by line number will apply to the wrong place — the same failure mode already recorded for the CONV plan (frozen at `adec19e`) and RFX (`f2be0de`).

## 1. ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01 — 11 rows

| row | verdict | current evidence |
|---|---|---|
| **ORCH-PAR-00** Product+architect sign-off on the journey inventory | **open** | The survey deliverable exists and is substantial (this plan's sibling file), and `coordination/reviews/2026-10-02-0155-coordinator.md:9-10,25` records the ORCH-PAR-00 receipt as **SETTLED**. But settling a receipt is not Product sign-off: the survey itself states it is "chưa phải PAR-00 Product sign-off" and that unsigned rows stay `BLOCKED`. No sign-off record found. |
| **ORCH-PAR-01** key issue/rotate/disable/revoke + profile grants | **open — plan's own MISMATCH is now stale** | **Backend landed.** `dispatcher.ts:105-106` registers `apikey.issue` / `apikey.revoke` with `bearerRoles: ['platform'], cookieRoles: ['admin']`, implemented at `:540` and `:619` with tenant fences (`:556`, `:640`) and audit (`apikey.create` `:584`, `apikey.revoke` `:664`). Focused tests exist: `tests/admin-api-keys.test.ts`, `admin-api-key-render.test.ts`, `admin-api-key-view-model.test.ts`. **The plan asserts at `PAR-M01` that `dispatcher.ts:95-114` has no create/revoke — that is no longer true.** What remains open is the **UI half**: the Admin form still POSTs to `/admin/api-keys/new`, and `ADMIN-CONTROL-PLANE-UI-2026-10-02.md` ACUI-M01 records that path as having no POST handler. Also `apikey.rotate` is absent (only issue/revoke). |
| **ORCH-PAR-02** revisioned profile policy enforced at publish **and** submit | **open, confirmed** | `server.ts:2600-2601` still returns `revision: 0` and `currentValues: {}` for the profile editor projection — verbatim what the plan's `PAR-M02` and `PAR00-M02` describe. `profile_bindings` is revision-keyed at the storage layer (`migrations/0004_profile_bindings.sql:14-27`) but carries `connectorBindings` only, not the legacy parameter/lock/prompt/priority policy. |
| **ORCH-PAR-03** Connector lifecycle via Orchestrator Admin proxy | **open, confirmed** | `main.ts` still passes **neither** `connectorBaseUrls` nor `credentialWorkflow` — a grep of the whole file for those two names returns only `adminShellCookieSecret` at `:144`. This is the same absence recorded independently in my ACUI-00 catalog (`qwen-acui-00-config-catalog-2026-10-02.md` §2.1, 15 ServerConfig fields unreachable from the packaged entrypoint). `PAR00-M03` stands. |
| **ORCH-PAR-04** workflow schema catalog/import/publish | **open (control plane), with runtime progress** | No `workflow-schemas` route in `server.ts` — the catalog/import/publish surface the row requires is absent. **However the execution side HAS moved:** `document-core.manifest.ts:109-110,334-345,431-451` registers `disbursement` and `doc-compare` as real handlers with input/result versions, and my own RV01 facade answers the workflow routes with an explicit 503 rather than 404. So the P9-04 runtime dependency is partly satisfied; the Admin control plane and COMP-09 public mapping are not. |
| **ORCH-PAR-05** local user <-> API-key assignment | **open / conditional** | The plan itself classifies this CONDITIONAL pending Product. `migrations/0023_admin_local_users.sql` gives the local-user store, but no user<->key assignment route exists in `server.ts`. Consistent with the plan's conditional classification; the decision is still unmade. |
| **ORCH-PAR-06** settings replacement (provider/S3/cache) | **open** | ACUI-00 (2026-10-02) catalogued the whole surface one day after this plan: **75 env keys, 14 secret-ref, 0 managed**, plus `admin_crypto_config` as the only store with a real Admin write path. That is a current, cited answer to "what replaces the old settings" and it confirms the row is open. `admin_crypto_config` also lacks a revision column, which PAR-06's acceptance (desired/applied state) requires. |
| **ORCH-PAR-07** dashboard time-series / usage drilldown | **uncertain** | `overview-section-data.ts` and `overview-section-renderer.ts` exist and are recent (both ` M` in the working tree). Whether they provide the 24h/7d/30d time-series, late-event/dedup and cross-check-vs-source acceptance the row specifies is not determinable without reading their tests. **Missing: the analytics acceptance evidence.** |
| **ORCH-PAR-08** safe operations console | **open** | Runtime reconciliation/health/drain exist (`server.ts` lease sweep, `dispatcher` deadline actions). The row is explicitly conditional on a gap test; no gap-test receipt found. Note the plan's warning still applies — `matchShellRoute` sends section POSTs to `handleSectionGet`, which I re-confirmed in CONV-12 (`shell-router.ts` section branch returns 405 for POST). |
| **ORCH-PAR-09** served versioned API reference | **open** | `docs/21-openapi.json` exists, but grep of `server.ts` for `openapi` / `21-openapi` returns **zero** matches — the spec is not served by any route. Exactly what the plan says is missing. |
| **ORCH-PAR-10** end-to-end parity verdict | **open** | Requires Claude Code `APPROVED` plus a live-journey receipt with PG/Redis/S3/Vault/Connector. No such receipt found; `G-COMP`, `G-ADMIN-OPS`, `G-LOCAL-ADMIN`, `G-SEC`, `G-DATA`, `G-ENC`, `G6` are all recorded NO-GO in the survey's own gate line. |

### MISMATCH rows in the same plan

| ID | verdict | note |
|---|---|---|
| `PAR-M01` | **stale** | Claims `dispatcher.ts:95` has no create/revoke. Superseded — see ORCH-PAR-01. |
| `PAR-M02` | **open, re-confirmed** | `server.ts:2600-2601` still `revision: 0`. |
| `PAR-M03` | **open** | `docs/01-product-scope.md:68` still needs the workflow-release scope decision; no evidence it was updated. |

## 2. ORCH-PAR-00-INVENTORY-SURVEY — 6 journey rows + 5 MISMATCH rows

| row | verdict | current evidence |
|---|---|---|
| `PAR00-J01` local auth mode `local\|oidc\|both` | **open** | `main.ts` still wires only `adminShellCookieSecret` (`:144`) plus optional OIDC from `oidc-boot.ts`; there is no `DU_ADMIN_AUTH_MODE` env and no local-user login route. `admin_local_users` exists as storage only. Matches `PAR00-M05`. |
| `PAR00-J02` key provisioning/revocation capability | **partly done, open as a journey** | Backend is real (see ORCH-PAR-01). The journey — copy-once raw key, revoke effective on new requests across replicas — is not evidenced. |
| `PAR00-J03` persisted profile policy revision | **open** | Same evidence as ORCH-PAR-02 / `PAR00-M02`. |
| `PAR00-J04` provider routing/credential capability | **open** | Same evidence as ORCH-PAR-03 / `PAR00-M03`: `connectorBaseUrls` and `credentialWorkflow` unwired in `main.ts`. |
| `PAR00-J05` versioned workflow schema catalog | **open** | No schema catalog route. Execution partially landed (see ORCH-PAR-04). |
| `PAR00-J06` operator observability | **uncertain** | The routes exist (operation list/detail, audit, health, cancel/resume, deadline actions), which the row itself records. What is missing is the browser/RBAC/receipt evidence it asks for. Cannot be settled without running the Admin journey. |

| MISMATCH | verdict | note |
|---|---|---|
| `PAR00-M01` | **stale (backend)** / **open (UI)** | identical to `PAR-M01`; see ORCH-PAR-01. |
| `PAR00-M02` | **open, re-confirmed** | `server.ts:2600-2601`. |
| `PAR00-M03` | **open, re-confirmed** | `main.ts` unwired. |
| `PAR00-M04` | **open** | no schema catalog. |
| `PAR00-M05` | **open** | no local auth mode. |

## 3. Summary A — tick proposals (I do not tick)

**No row qualifies for a tick.** Not one of the 17 rows has both a mechanism and a verified journey, and the two plans' own rule is that a row may not reach `[x]` without independent test evidence and an approval. I would rather return an empty tick list than manufacture one.

The closest to a proposal, and it is **not** a tick recommendation:

- **PAR-01 backend half.** `dispatcher.ts:105-106,540,619` plus `tests/admin-api-keys.test.ts` is a coherent, cited change made after this plan was written. It deserves a receipt-based status update (open -> backend implemented, UI open), not a tick, because the row's own acceptance ends "UI form phải gọi handler thật" and that is still false.

## 4. Summary B — dispatch next, by shared lease

| group | rows | work | lease |
|---|---|---|---|
| profile policy | PAR-02, PAR00-J03, PAR-M02, PAR00-M02 | Persist parameter/lock/prompt/priority policy as a versioned revision; enforce at publish **and** submit; make the editor read the real revision. | `modules/profiles/`, `server.ts` profile routes, a migration |
| connector proxy | PAR-03, PAR00-J04, PAR00-M03 | Wire `connectorBaseUrls` + `credentialWorkflow` at composition; build the Admin create/activate/retire proxy over the real Connector management API. | `main.ts`, `server.ts`, connector credential module |
| API-key UI | PAR-01 UI half, PAR-M01, PAR00-M01 | Point the shell form at `POST /api/v1/admin/actions` (`apikey.issue`/`revoke`) instead of a POST path with no handler; add `apikey.rotate`. | `src/app/admin/` — **overlaps ACUI/P6 writers** |
| workflow schema | PAR-04, PAR00-J05, PAR00-M04 | Admin schema catalog/import/validate/publish + COMP-09 `schemaSlug` mapping. Runtime side partly landed. | `server.ts`, contracts, migrations — serialize |
| local auth | PAR-05, PAR00-J01, PAR00-M05 | `DU_ADMIN_AUTH_MODE` + local-user login/reset/disable; the decision on user<->key assignment. | `oidc-boot.ts`, `main.ts`, `shell-server.ts` |
| docs | PAR-09 | Serve a versioned reference from the frozen OpenAPI. | docs + one route |
| final verdict | PAR-10 | Journey run + Claude `APPROVED`. | none — depends on all above |

**Serialisation warning, and it is concrete:** PAR-01-UI, PAR-02, PAR-03, PAR-04, PAR-05 and PAR-09 all touch `server.ts`, `src/app/admin/` or `main.ts`. The RFX lease table already assigns `server.ts` to RFX-10/11/12 and `main.ts` boot wiring to a boot owner, and the Admin shell is under active ACUI/P6 writers. **Dispatching more than one of these concurrently would collide.**

## 5. Summary C — decisions needed (no more digging will settle these)

1. **Is PAR-01 stale-and-partially-landed, or should the MISMATCH rows be rewritten?** Three separate plan rows assert a dispatcher state that is now false. Someone with plan ownership should correct them, otherwise the next dispatcher reads `dispatcher.ts:95` as authoritative and re-dispatches finished work — the exact CONV-08 failure mode.
2. **`apikey.rotate` — in or out?** The dispatcher has issue and revoke but no rotate, while the row's title names rotate. Product decision, not engineering.
3. **PAR-00 sign-off is still BLOCKED.** The survey is settled as a receipt; nobody has signed the dependency register. Everything in group B waits on it, so it is the cheapest unblock available.
4. **Is the ORCH-PAR-04 visual builder actually required?** The survey grades it CONDITIONAL on the real operator journey, while the backlog row lists "schema catalog/builder/import/publish" flatly. Those two readings differ by a large amount of work.
5. **Do live-gated skips count?** Several relevant suites (`admin-shell-*`, `webhook-reclaim-fence.live`) skip without `DU_LIVE_INFRA`. Under a strict reading, PAR-07/PAR-08 and PAR-10 cannot even be assessed without a window.

## 6. Caution

Both plans are dated **2026-10-01** and their line pointers have already drifted (profile projection `:2466` -> `:2600`). More importantly, **PAR-01 is a live example of a plan being overtaken by delivery**: the MISMATCH it records was fixed after the plan was written. Where a plan and the tree disagree, this receipt follows the tree.

**No gate is ticked by this receipt.**