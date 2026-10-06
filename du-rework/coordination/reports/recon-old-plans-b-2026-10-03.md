# RECON-B — old plans (2026-09-24 / 2026-09-27) vs current evidence

- **Date:** 2026-10-03. **Mode:** READ-ONLY reconciliation. **No test was run. No file was modified except this receipt.** No gate ticked, no commit, no message to `nocobase-10`.
- Scope: `tasks/FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` (6 rows), `tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md` (3 rows), `tasks/REVIEW-FIXES-2026-09-24.md` (2 rows).

## 0. A finding that applies to all 11 rows: the plans' own `file:line` anchors are STALE

`tasks/REVIEW-FIXES-2026-09-24.md` R24-01 cites `server.ts:696` for the tenant-scoped long-poll reader. **`server.ts` is now 4415 lines** and line 696 holds the MM-05 queue-integrity health cache — nothing to do with a reader. Anyone re-verifying that row by line number would conclude the fix is missing when it is present.

**I re-anchored every citation below against the current tree.** The verdicts are about the *behaviour*, not about whether the old line number still points at it.

## 1. `REVIEW-FIXES-2026-09-24.md` (2 rows)

### R24-01 — tenant-scoped reader throughout long-poll

**Verdict: `done` for the source claim; `open` for the DB-backed gate.**

| | |
|---|---|
| Plan's status | "SOURCE FIXED, offline verified; DB-backed gate pending" |
| Verified now | `services/orchestrator/src/server.ts:1932-1933` — `waitForTerminal((id) => ctx.runtime.getTenantOperation(id, apiKey.tenantId), …)`, and `services/orchestrator/src/modules/runtime/runtime.ts:1336-1337` — `getTenantOperation(operationId, tenantId)` → `SELECT * FROM operations WHERE id=$1 AND tenant_id=$2` |
| Stale anchor | plan's `server.ts:696` / `runtime.ts:884`; current `server.ts:696` is the MM-05 queue-integrity cache |
| Still open | the exact-build **DB-backed** regression receipt (foreign active/terminal id → prompt 404 without polling; authorised poll completes). I ran no DB, so I cannot confirm this leg |
| Do NOT re-dispatch | the source fix. The plan says so and the source agrees |

### R24-02 — blob rewrite / base64 fallback removed from the P5 multi-service test

**Verdict: source claim corroborated; closure `open` pending a current-build suite run.**

| | |
|---|---|
| Verified now | `services/orchestrator/tests/blob-wire-binary.test.ts` exists; its header states the wire is *"never base64-encoded, never JSON.stringified (the old fault returned `bytes.toString('base64')` through the common JSON responder …)"*, and `:143` is a test *"wire body is raw, not quoted base64: first byte is payload, not a quote"* |
| Also verified | that suite is registered as **Live** in `tests/isolation/concurrent-runner.ps1:253` |
| Stale anchor | the plan's *"test lines 649–659"* — I did not locate that anchor in the current tree and am **not** claiming it still holds |
| Still open | *"Full current-build suite exit 0 and native parsing/checkpoint replay without blob rewriting"*. I ran nothing, so this is unverified. P5-10 stays partial |

## 2. `ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md` (3 rows)

All three are `[~]` and each carries an inline receipt that names its own remaining blocker. **All three are `open`**, and in every case the blocker is external to any read-only check.

### INGEST-WIRE-01 — real image/file bytes over an authorized artifact reference

- **Verdict: `open` (substantially implemented, explicitly held).**
- **Verified now:** `hasBuffer` has **0 matches** in `businesses/document-core/src` — the plan's receipt claims "removed `hasBuffer` entirely from the executing call sites", and that is true of the current source.
- **Held by the row itself:** connector-side fixture (Δ48) and the live multi-container test with a scanned file and handwriting (Δ49). Both are live-window evidence; neither can be produced read-only.
- **Not claimed:** I did not verify the receipt's counts (5 targeted suites 88/88, FULL document-core 45 suites/537). Those are the receipt's numbers, not re-measured ones.

### RESULT-WIRE-01 — freeze the public result/download contract

- **Verdict: `open` (contract + docs landed, sign-off held).**
- **Verified now:** `docs/06-result-envelope.md` exists (6316 bytes), matching the Qwen-Docs receipt `D-DOCS-06-RESULT`.
- **Held by the row itself:** "Giữ `[~]` chờ Claude Code APPROVED". An external approval is not a fact I can establish.
- **Not claimed:** the contract schemas and the 19-suite/427-test count were not re-verified; I did not open `packages/contracts` for this row.

### ARCH-DOC-01 — sync architecture docs to current source

- **Verdict: `open` (artifacts exist, sign-off held).**
- **Verified now:** `docs/02-architecture.md` (15 739 bytes) and `docs/09-system-architecture.md` (10 324 bytes) both exist.
- **Held by the row itself:** "Giữ `[~]` chờ Claude Code review sign-off", plus the plan's own ordering rule — it follows the wire decision and the source/receipts, so it must not be closed on doc existence alone.
- **Not claimed:** I did **not** verify the content sync itself (the four topics, the target/current/verified table, the 49/49 assertions, link-check ×3). File existence is the weakest form of evidence and I am labelling it as such.

## 3. `FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md` — 6 parent rows

These are **not implementation tasks**. The table is headed *"Parent rows cần tái nghiệm thu"* — rows placed under an acceptance **HOLD** — and the last column is the *condition to release the hold*. So the only honest verdict axis is: *does the evidence needed to release the hold exist?*

**All six are `open`.** Not one has a release condition satisfied by anything readable from the tree, and the packet forbids running the tests that would produce it. Per-row, with the exact missing evidence:

| # | Parent rows | Un-hold condition (from the plan) | Verdict | What is missing |
|---|---|---|---|---|
| 1 | P2-03/05/06/07, P4-05/08 | Producer/consumer/public artifact scopes; active-lease checks; atomic finalization/publication; **actual SDK wire**; bounded body tests | `open` | real-PostgreSQL two-client evidence for finalize/cancel/lease/lost-response replay; current-build SDK wire run. The file's own later tables still list `artifacts-fencing-pg.test.ts` as *written but never run* |
| 2 | P2-04/08/09 | Concurrent idempotency/TTL; pinned profile; public result policy; safe webhook; Redis-before-claim recovery; default drain/deadline/cancel | `open` | live two-replica PG/Redis. The plan's own follow-up table records the webhook claim release as **still lacking an owner fence**, and the Admin idempotency marker as still global |
| 3 | P3-03/05/06/07/08, P4-07 | Durable replay never redispatches cancelled/in-flight work; UNKNOWN preserved; async poll/deadline/shared quota/usage progress; egress/body limits | `open` | the POLLING migration has no live-apply receipt; multi-replica durable proof outstanding |
| 4 | P4-06, P5-05..10, P7-05 | Office artifact flows; decompression limits; unreadable source/child result cannot become approved; current-image business E2E | `open` | artifact-metadata contract with R1-A; real Office bytes from upload→six actions; a recorded compile failure in the post-Layer-6 document-core regression is still described as unresolved in the plan's last table |
| 5 | P6-02..07, P7-04 | Live pane data; actual authorized mutation; copy-once lifecycle; full agreed a11y rules; isolated current-run browser evidence | `open` | a **browser** run. No read-only check can substitute — the plan explicitly forbids renderer-only or stub-transport closure |
| 6 | P1-05, P8-01/04/06/08 | Discovered test inventory; clean image boot; exact security negative cases; independent regression fixtures; all release gates | `open` | `G6` needs G-SEC + G-DATA + G-ADMIN-OPS + G-ENC together, plus S3 and Elasticsearch, which per the environment have no infrastructure here |

**Rows 2, 5 and 6 additionally carry blockers the plan itself re-states in its own later follow-up tables**, so they are not merely un-run — they are known-open. Row 1's `artifacts-fencing-pg.test.ts` is the sharpest: the plan says the file exists and was never executed.

## 4. Summary

| Row | Verdict |
|---|---|
| R24-01 | `done` (source, re-anchored) + `open` (DB-backed gate) |
| R24-02 | source corroborated + `open` (current-build suite) |
| INGEST-WIRE-01 | `open` (held on live/connector fixture) |
| RESULT-WIRE-01 | `open` (held on external sign-off) |
| ARCH-DOC-01 | `open` (held on external sign-off) |
| FULL-REWORK rows 1–6 | all `open` |

**Rows that could be ticked on current evidence: none.** I am not proposing any tick. Every one of the eleven is either explicitly held by its own row, or needs live/DB/browser evidence that a read-only pass cannot manufacture.

**What I recommend dispatching next, in dependency order** (proposals only — I changed nothing):
1. **Re-anchor the stale `file:line` in the two plan files.** This is the cheapest real win: as written, `REVIEW-FIXES-2026-09-24.md` will mislead the next verifier into re-dispatching a fix that already landed. That is a documentation edit to a plan file, not a tick.
2. **Run `artifacts-fencing-pg.test.ts` against a real PostgreSQL** — it is written, never executed, and it is the named un-hold condition for FULL-REWORK row 1 and for R1-A/ART-02.
3. **One browser run for P6-02..07 / P7-04.** This is the only row that nothing else unblocks, and every other candidate for it is blocked on infrastructure we do not have.
4. **Resolve the webhook claim-release owner fence** (FULL-REWORK row 2). The plan names the defect and still has it open; it is a source fix plus one real-PG A-stall→B-reclaim test.

## 5. Method and its limits

- I read the three plan files, then **re-derived every checkable claim from the current source** rather than trusting the plan's own status column or its line numbers.
- I ran **no test, no DB, no browser** — the packet forbids it. Every green in this receipt is either "the artefact exists at this path" or "the source says this", never "the suite passed". Where a receipt cites a count, I say explicitly that the count is **theirs, not re-measured**.
- I did not open `packages/contracts` for RESULT-WIRE-01, and I did not attempt to close any row whose un-hold condition needs live evidence.
- **The weakest evidence class used here is file existence**, used only for the three documentation artefacts. It is labelled as such.

## RESUME POINT

- RECON-B closed 2026-10-03, read-only. **11 rows, 0 tickable, 11 open.**
- **Highest-value follow-up is not a code fix:** the stale `file:line` anchors in `REVIEW-FIXES-2026-09-24.md` will cause a future lane to re-dispatch R24-01's already-landed fix.
- **Reproduce:** every citation in §1–§2 is a `file:line` you can open. Re-verify against the tree, not against this receipt.
