# CYCLE REPORT — 2026-10-08 (coordinator, 30-min cycle, second pass)

Mode: READ-ONLY synthesis + dispatch. No commit, no push, no git add, no gate tick, no plan/task edit, no `docs/21-openapi.json` hand-edit. du-rework only.

---

## (a) Plan state — WFA acceptance matrix (SPECIFIED / IMPLEMENTED / independently VERIFIED / OPEN)

Source: `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` §6 (WFA-T01..T38) + receipts. **No row is ticked ACCEPTED by me.**

| Acceptance group | Rows | State | Evidence / note |
|---|---|---|---|
| Multipart named submissions | T01–T03 | IMPLEMENTED + VERIFIED | Covered by the 15/15 green full-suite runs (see (b)); no separate receipt per row. |
| Error contract | T04–T08 | IMPLEMENTED + VERIFIED | Same 15/15 runs. |
| Schema route | T09–T13 | IMPLEMENTED + VERIFIED | Same 15/15 runs. |
| Revision pinning | T14 | IMPLEMENTED + VERIFIED | Same 15/15 runs. |
| Ten legacy node types | T15–T24 | IMPLEMENTED + VERIFIED | Same 15/15 runs. |
| HITL / cancel | T25–T28 | **T26/T27 attribution RESOLVED; 2-agent verify 1 of 2 legs done** | T26 fix (worker-sdk `task-context.ts:352` + `connector-invoker.ts:153`, dist rebuilt) and T27 fix (`runtime.ts` `hasCancelSignal`, SHA `c735d18e…c86`) are **both necessary and orthogonal** — A/B by qwen_2 (`wfa-t27-attribution-2026-10-08.md`): revert only the T27 hunk → T27 red at `:1245`; restore byte-for-byte → green. This refutes the T26 lane's §6 "side-effect" hypothesis. |
| Authz | T29–T32 | IMPLEMENTED + VERIFIED | 15/15 runs. |
| SSRF / bounds / redaction | T33–T36 | IMPLEMENTED + VERIFIED | 15/15 runs. |
| Schema provision on fresh DB | T37 | **OPEN — under review** | §8 independent review re-dispatched (see below). |
| Generated OpenAPI | T38 | **OPEN** | `docs/21-openapi.json` is generated; never hand-edited. Regeneration via `tools/openapi/gen_openapi.py` only. |
| **WFA §8 independent review (release gate)** | — | **OPEN — re-dispatched** | First reviewer (`term_cefb27a0`) died on provider quota **after** collecting evidence (full suite 15/15 green, T26 5.9s / T27 1.2s) but **before writing any receipt** → its findings are unrecorded and cannot be credited. Re-dispatched to `term_f1c5a1d1` with an incremental-receipt instruction. |

**Other open items (not WFA):**
- Red-suite triage: #1 (`list-query.ts` 58-test cluster) **fixed** by lane receipt `triage1-list-query-2026-10-08.md` (4 test files, 0 product; 58 red → 0; product SQL pinned by 2 green suites). Still open: #2 `admin-shell-session-lifecycle:821` (product/security bug, needs a 2-sided lease decision), #4 gateway, #5 `enc-meta-sentinel-runtime-refs` (possible regression), ambient-env group, 1 assertion drift.
- REVIEW-815 residuals: RLS silent-PASS gate redesign (B2b manifest), window-switch implementation, backfill real-DB, `docs/04-data-state.md:93`+`:100` still unguarded/wrong (7 vs 8 slots), race atomic revocation, signed identity partial, SHIPPING-DU-REWORK-887.

---

## (b) 2-agent independent test — WFA-T26 / WFA-T27

**Leg #1 — Codex (`term_ca784044`) — DONE, receipt `verify-t26-t27-independent-codex-2026-10-08.md` (08:53).**
- T26 focused E2E: exit **0**, `Tests: 14 skipped, 1 passed, 15 total`.
- T27 focused E2E: exit **0**, `Tests: 14 skipped, 1 passed, 15 total`.
- Read the attribution receipt; did not perform any mutation itself.

**Leg #2 — dsh-TUI (`term_8bfe6adc`) — DIED on provider quota (`429 GoUsageLimitError`).**
- Only `VERIFY1_EXIT=0` (T26 focused) was captured before the cut. T27 focused and the two unit suites never ran. **Not credited.**

**Leg #2 replacement — OC (`term_169a5da5`) — DISPATCHED this cycle.**
- Same two focused E2E + one full suite + the two unit suites the dsh leg never reached (`worker-sdk/tests/wfa-t26-lease-loss-abort.test.ts` 7/7, `services/orchestrator/tests/wfa-t27-cancel-ack.test.ts` 3/3).
- Confounder control: `runtime.ts` must stay at SHA `c735d18e…c86` before/after every run; `dist/connector-invoker.js` must contain `if (signal?.reason === 'cancel')`; `dist/task-context.js` must contain `abort(reason)`. If the hash differs → STOP and report as BLOCKER.
- Receipt path: `verify-t26-t27-independent-oc2-2026-10-08.md`.

**Clean wrapper rerun — OC (`term_8a432ae3`) — DONE, receipt `wfa-muc5-wrapper-rerun-clean-2026-10-08.md` (08:51).**
- 3/3 consecutive full-suite runs through `run-jest.cjs`: exit **0**, `Tests: 15 passed, 15 total` each (17.329s / 16.211s / 16.536s).
- `runtime.ts` SHA verified `C735D18E…B3C86` at pre-run, post-run 1, post-run 2, post-run 3 — **no A/B revert window inside this rerun**.
- WFA-T26 green 6095/5909/5897 ms; WFA-T27 green 1317/1210/1234 ms. No `spawnError:`.
- **This resolves the earlier confound:** the 08:34–08:36 rerun (1 green / 2 red on T27) ran inside qwen_2's A/B revert/restore window on `runtime.ts`. The clean rerun proves the suite is stable on the restored tree. The earlier "T27 is flaky" verdict is **withdrawn as confounded**, not as a real flake.

**My own verification this cycle:** `services/orchestrator` `tsc --noEmit` → **exit 0**; T26 fix present at `dist/connector-invoker.js:153` and `src/task-context.ts:352`; `runtime.ts` SHA `c735d18e…c86` with `hasCancelSignal` intact.

**Coordinator tick for T26/T27: still outstanding** — attribution resolved, 1 of 2 independent legs done, clean 3/3 stability run in hand. No self-tick.

---

## (c) Admin-portal feature suggestions — FOR COORDINATOR APPROVAL (not added to plan)

Surveyed `orchestrator/apps/admin-web/src/features/*`, `router.tsx`, `app-shell/app-shell.tsx`, `features/businesses/business-inputs.tsx`. Each suggestion below is validated against current code.

| # | Feature | Problem solved | File:line | Complexity | Risk |
|---|---|---|---|---|---|
| 1 | **Tenant/business scoping in Profiles & Businesses** | Profiles takes `businessId` as free text (`BusinessInputs`); a typo silently targets the wrong business or 404s. `TenantSelect` is used in 6 screens (api-keys, connectors, operations, secrets, security, usage) but **absent from profiles and businesses**. | `features/profiles/profiles-screen.tsx:88,429`; `features/businesses/business-inputs.tsx:66,73` | S–M | Low |
| 2 | **Connector ID free-text → real `<select>`** | Connector ID is a free-text `<Input>` + `datalist`; the known-ids fix landed but the field still accepts arbitrary strings. | `features/connectors/connectors-screen.tsx:482-494`; data `features/connectors/state.ts:159-165` | S | Low |
| 3 | **OpenAPI staleness indicator** | `api-docs` ships the bundled `docs/21-openapi.json` (`?raw` import) with **no build date / staleness signal**; the spec can silently lag the deployed API. | `features/api-docs/api-docs-screen.tsx:2,131-145` | S | Low |
| 4 | **Workflows-disabled unblock guidance** | The `workflows` route is registered but fail-closed (Δ-DEV-03 banner); the operator is told it is disabled but not **what** unblocks it or who owns the decision. | `features/workflows/workflows-screen.tsx:8-32` | S | None (display only) |
| 5 | **Legacy-shell link labeling** | A bare `<a href="/admin">Legacy shell</a>` is easy to miss and unclear about which app it opens. | `app-shell/app-shell.tsx:72` | S | Low |
| 6 | **NEW — Structured usage summary + error detail** | The usage screen renders the whole summary as a raw JSON `<pre>` dump and the error pane shows only `problem.title` + `problem.code` (no `detail`), so a 422/403 is undiagnosable in the UI. Same raw-dump pattern exists in docs/profiles/security/operations. | `features/usage/usage-screen.tsx:123-140` (error pane + JSON dump) | S–M | Low |

**None of these has been written into the plan or task list.**

---

## UPDATE (same cycle, post-dispatch) — provider quota truncation

- OC leg-2 (`term_169a5da5`) and OC §8 review (`term_f1c5a1d1`) **both died** on the same `429 GoUsageLimitError` (DeepSeek V4.1 Flash OpenCode Go). No receipt was written for either — NOT credited.
- Replacement dispatch #1: leg-2 independent verify → **Qwen `term_16fef1c3`** (confirmed landed; confounder-control hashes printed, `dist/connector-invoker.js:153` and `dist/task-context.js` contain the T26 fix, `runtime.ts` check pending).
- Replacement dispatch #2: WFA §8 security review → **GPT-6-Luna `term_43f85ccc`** (input_accepted; Enter possibly swallowed — delivery confirmation via `--retry-request b27649fb... --wait-submit`).
- The Claude Code session `term_19edcad8` refused input (busy "Crafting…" 23m) — its §8 pickup is unconfirmed, so it is NOT relied upon.
- This is the 2nd systemic provider-quota truncation wave: 4 lanes affected total (`term_8bfe6adc`, `term_cefb27a0`, `term_169a5da5`, `term_f1c5a1d1`). Process rule stands: receipts written EARLY/incrementally.

## Standing constraints honored

No commit, no push, no git add. du-rework only. `docs/21-openapi.json` never hand-edited. No gate self-ticked. No red test hidden or loosened. No lease overlap.
