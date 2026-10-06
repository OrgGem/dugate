# RECON-F — ADMIN-OPS-UX + ADMIN-LOCAL-AUTH + P7 vs current evidence

- **Date:** 2026-10-03. **Mode:** READ-ONLY reconciliation. **No test was run. Nothing was modified except this receipt.** No gate ticked, no commit, no message to `nocobase-10`.
- Scope: `tasks/ADMIN-OPS-UX-2026-09-24.md` (8 rows), `tasks/ADMIN-LOCAL-AUTH-2026-09-30.md` (7 rows), `tasks/P7-extension-proof.md` (3 rows = the three `[~]` rows P7-03/04/07; the four `[x]` rows are P7-01/02/05/06).
- Method: every claim re-derived from the working tree. The task register was used only to cross-check.

## 0. Two findings that matter more than any single row

**(a) LOCAL-01 and LOCAL-02 markers are STALE.** The packet warned local-auth has code + migration 0023 + tests in the tree. Confirmed, and the rows are still `[ ]`:

- `services/orchestrator/migrations/0023_admin_local_users.sql` exists. (The migrations directory is `services/orchestrator/migrations/`, **not** `src/db/migrations/` — a first grep for `0023` under `src/db` finds nothing and would have produced a false "not done" verdict.)
- `services/orchestrator/src/modules/auth/admin-local/` and `.../local-primitives/` both exist.
- `services/orchestrator/src/migrations-local-users-cli.ts` exists (the first-admin CLI the row asks for).

A lane reading the plan would re-dispatch work that has landed. This is the same failure class as RECON-B's stale `file:line`: **the plan is not the truth; the tree is.**

**(b) LOCAL-03 is genuinely NOT done, and it is blocked on a decision, not on effort.** `DU_ADMIN_AUTH_MODE` has **0 matches** in `services/orchestrator/src/main.ts` — no parse, no mode switch, no local-only mount. The row's dependency is `LOCAL-00`, which is an explicit **decision packet** ("ký mode env … ADR và threat model; đây là quyết định, chưa phải code") and carries **no owner and no deadline in the row**. So the LOCAL chain is not blocked on capacity; it is blocked on a signature. Dispatching LOCAL-03 now would mean guessing the security contract.

## 1. `ADMIN-OPS-UX-2026-09-24.md` (8 rows)

Markers as they stand in the file: `ADM-UX-00 [ ]`, `ADM-UX-01..06 [~]`, `ADM-UX-07 [ ]`.

**All eight are `open`.** These are Admin-UI acceptance rows whose remaining conditions are browser journeys and live data — none producible by a read-only pass, and the file's own receipts say so in as many words ("Giữ `[~]` chờ browser C1-C5 và live data verification tại ADM-UX-07"; "Giữ `[~]` chờ live PG migration và query plan verification").

What I did verify is that the offline artefacts each row cites actually exist, so the `[~]` markers are not hiding missing code:

| Row | Marker | Artefact verified present | Verdict |
|---|---|---|---|
| ADM-UX-00 | `[ ]` | n/a — the row's deliverable is literally "P6 hiện có" | `open` (foundation, no independent acceptance of its own) |
| ADM-UX-01 | `[~]` | row is the nav/role/data-display base for 02–06 | `open` |
| ADM-UX-02 | `[~]` | section data/renderers present in `app/admin/` | `open` |
| ADM-UX-03 | `[~]` | `services/orchestrator/tests/admin-operations-sort-wiring.test.ts` | `open` — held on browser C1-C5 + live data |
| ADM-UX-04 | `[~]` | `services/orchestrator/tests/admin-overview-triage.test.ts` | `open` — held on an aggregate connector-health live endpoint + browser E2E |
| ADM-UX-05 | `[~]` | `services/orchestrator/tests/admin-operation-cockpit.test.ts` | `open` |
| ADM-UX-06 | `[~]` | copy-once lifecycle lives in the api-key renderer | `open` |
| ADM-UX-07 | `[ ]` | the row that OWNS browser C1-C5 and the security end-to-end | `open` — this is the row that unblocks 03/04 |

**Highest-leverage fact here:** ADM-UX-07 is the shared blocker. Six `[~]` rows are waiting on the acceptance row that has no evidence yet. A browser run closes more of this plan than any further offline UI work.

## 2. `ADMIN-LOCAL-AUTH-2026-09-30.md` (7 rows)

| Row | Marker in file | Verdict | Evidence / what is missing |
|---|---|---|---|
| **LOCAL-00** | `[ ]` | `open` — **by design** | It is a decision packet: mode env, token-login default/migration, machine-bearer policy, role×action×tenant, bootstrap/reset/lockout, session invalidation, ADR + threat model. No code can close it. The row names **no owner and no deadline** — that, not implementation capacity, is why LOCAL-03 cannot start |
| **LOCAL-01** | `[ ]` | **`uncertain` — marker is stale** | Implementation is present: `services/orchestrator/migrations/0023_admin_local_users.sql`, `src/modules/auth/admin-local/`, `src/migrations-local-users-cli.ts`. The row's own acceptance (focused smoke, migration rollback, `VFY-LOCAL` business matrix) is **not** evidenced by me. Recommend the coordinator re-check the row before dispatching |
| **LOCAL-02** | `[ ]` | **`uncertain` — marker is stale** | `src/modules/auth/local-primitives/` exists. Same caveat: I did not run the auth/security smoke the row requires before `IMPLEMENTED`, and no `VFY-LOCAL` receipt was checked |
| **LOCAL-03** | `[ ]` | `open` — **verified gap, not stale** | `DU_ADMIN_AUTH_MODE` = **0 matches** in `services/orchestrator/src/main.ts`. No mode parse, no local-only mount, no login UI switch. Genuinely not started |
| **LOCAL-04** | `[ ]` | `open` | Unified trusted principal across Admin read/mutation, browser never receives a static bearer, audit actor = user id/issuer. Nothing in the tree demonstrates this; it depends on LOCAL-02/03 |
| **LOCAL-05** | `[ ]` | `open` | The `local`/`oidc`/`both`/invalid matrix over boot, login, lockout, CSRF, stale cookie, two replicas. Tester work, `VFY-LOCAL` |
| **LOCAL-06** | `[ ]` | `open` | `.env.example`, Docker/K8s env mapping, bootstrap/reset runbook, no-secret logs, reviewer `APPROVED`. Gate for `G-LOCAL-ADMIN` |

## 3. `P7-extension-proof.md` (3 rows)

**All three `open`.** Each artefact exists; each is held on a named follow-up the file itself records.

| Row | Verdict | Evidence | What is missing |
|---|---|---|---|
| **P7-03** | `open` | `businesses/example-review/src/registry-tool.ts` and `businesses/example-review/tests/p7-03-registry-live.integration.test.ts` both exist | MM-09: running-image digest check before/after extension registration on a real container runtime, and multi-replica worker queue isolation. The row is live-DB evidence I did not run |
| **P7-04** | `open` | `businesses/example-review/tests/p7-04-profile-assignment.integration.test.ts` exists | MM-10: the rendered profile edit/publish user journey and production fault injection. The offline pin does not cover the rendered path |
| **P7-07** | `open` | `docs/16-extension-developer-guide.md` exists | MM-09: independent container packaging proof + immutable-digest evidence. A written guide is not digest evidence |

## 4. Summary

| Row | Verdict |
|---|---|
| ADM-UX-00 | `open` |
| ADM-UX-01 | `open` |
| ADM-UX-02 | `open` |
| ADM-UX-03 | `open` |
| ADM-UX-04 | `open` |
| ADM-UX-05 | `open` |
| ADM-UX-06 | `open` |
| ADM-UX-07 | `open` |
| LOCAL-00 | `open` (decision) |
| LOCAL-01 | `uncertain` — marker stale, implementation present |
| LOCAL-02 | `uncertain` — marker stale, implementation present |
| LOCAL-03 | `open` — verified not started |
| LOCAL-04 | `open` |
| LOCAL-05 | `open` |
| LOCAL-06 | `open` |
| P7-03 | `open` |
| P7-04 | `open` |
| P7-07 | `open` |

**18 rows: 16 `open`, 2 `uncertain`, 0 tickable.**

**I am not proposing any tick.** Not one row's release condition is satisfiable from something readable in the tree.

## 5. Recommendations (proposals only — I changed nothing)

1. **Re-check the LOCAL-01/02 markers before dispatching them.** This is the cheapest real win in the set: two rows look untouched but have an implementation and a migration. Same trap as the stale `file:line` in RECON-B — the plan is not the truth, the tree is.
2. **Give `LOCAL-00` an owner and a deadline.** It is the single blocker for the whole LOCAL chain (03 → 04 → 05 → 06). It is a signature, not an implementation, and it currently has neither owner nor date. Everything downstream idles behind it.
3. **Run one browser pass for ADM-UX-07.** It is the shared unblock for six `[~]` rows and needs no new code. Nothing else in this plan moves that many rows per unit of work.
4. **Note the migrations-path trap for the next recon.** `0023_admin_local_users.sql` is under `services/orchestrator/migrations/`. Searching `src/db/migrations/` returns nothing and produces a false "not implemented" verdict on LOCAL-01.

## 6. Method and limits

- No test, DB, or browser was run — the packet forbids it. **Every green here is "the artefact exists at this path" or "the source says this", never "the suite passed".** Where a row's own receipt cites counts, I did not re-measure them and do not repeat them as my evidence.
- I did not open `businesses/example-review/` beyond confirming the three named files, and did not attempt to close any row whose condition needs live evidence.
- The weakest evidence class used is file existence; it is labelled as such in every row.

## RESUME POINT

- RECON-F closed 2026-10-03, read-only. **18 rows: 0 tickable.**
- Two actions are documentation/coordination, not code: refresh the LOCAL-01/02 markers, and put an owner and a date on `LOCAL-00`.
- One action unblocks the most: a browser run for ADM-UX-07.
- **Reproduce:** each §1–§3 table names a path you can open. Re-verify against the tree, not against this receipt.
