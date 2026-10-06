# A12-AUTH-GATE-RUNBOOK - receipt (two-gate rule, A12 auth gate, A8 integrity clause)

> **RESUME POINT (qwen_5, 2026-10-05)** - task A12-AUTH-GATE-RUNBOOK (task_ddae3a53e7cb),
> dispatch ctx_73275dde04e8. Status: **runbook updated.** DOC-ONLY: no source edit, the counter was
> **not run**, no commit, nothing ticked.

---

## 1. What was written into `live-window-runbook-803-2026-10-05.md`

File grew 188 -> 290 lines. Appends used byte-append (`type tmp >> file`) because it is a shared lane
file; the A10 edits were targeted.

| Section | Line | What |
|---|---|---|
| A8 (NEW) | 117 | **GATE INTEGRITY CLAUSE** - shape-pass is not protection; a sealed-but-broken row is data loss for processing; never present the shape counter GATE PASSES as flip evidence; if the auth gate cannot run the outcome is NOT PASSED / NOT VERIFIED |
| A10 (UPDATED) | 138 | three edits, below |
| A12 (NEW) | 225 | **AUTH GATE** - the five sub-sections below |

### A10 edits

1. **A10.1 - the two-gate rule added at the top.** The flip needs `actionable = 0` (shape) AND
   `auth_failed_total = 0` (auth), **both zero at the same time**, **both exhaustive**, not samples. A run
   reporting only the shape gate has not earned the flip.
2. **A10.1 outbox bullet refreshed.** `outbox.payload` is now *classified* with the same shape predicate
   (BACKFILL-COUNTER-FIXES-807), carrying the explicit caveat that the predicate is a **shape test, not a
   decryption** - a broken AAD/tag envelope still counts as sealed, so "sealed" means *looks* sealed, not
   *opens*. Still reported separately, still outside the gate.
3. **A10.5 read-only bullet corrected - my own earlier text was stale.** A10 originally said read-only was
   "a claim, not a configuration" and cited `transaction_read_only = off`. That was true when written and
   is **no longer true**: 807 replaced the no-op `default_transaction_read_only` with
   `SET LOCAL transaction_read_only = on`, the run reads the setting back, and `CREATE TABLE` inside that
   transaction now fails with "cannot execute CREATE TABLE in a read-only transaction". The bullet now
   records the enforcement and its load-bearing proof.

### A12 contents

- **A12.1** - run the shape census FIRST; it is the *input* to the auth gate, not a substitute. Only
  shape-pass rows enter the auth gate.
- **A12.2** - for every shape-pass row call `readStored` with **`allowPlaintext = false`**, using the
  **production key provider** and the **exact (tenant, slot, refId) of that row**; **counts only**, never
  a value, envelope, ref or plaintext.
- **A12.3** - sealed-but-broken rows are **error rows that block the flip**; **each row is a veto**;
  per-row process: record slot + error code, investigate, backfill again, **recount**. No hand-editing.
- **A12.4** - the four remaining conditions, and **A12.5** - decision rights: coordinator proposes the
  technical GO, **the USER decides the final GO for the A2 flip**; a user window approval does not convert
  an unresolved HIGH into acceptance.
- **A12.6** - what stands from REVIEW-803 and what A11 voided: see the honest limit in section 3.

---

## 2. A trap I hit and how I caught it

After appending A12, `read_file` reported the runbook as **195 lines with no A12 heading**. That is
wrong: `node` reading the same file reports **290 lines** with A8 at 117, A10 at 138 and A12 at 225, all
present and in order.

**`read_file` silently truncated.** Had I trusted it I would have re-appended A12 and duplicated the
section. The count and the heading list in this receipt come from the node measurement, not from the
tool that lied.

---

## 3. Honest limits

1. **A12.6 could not be written as asked.** The packet asked me to state which parts of REVIEW-803 still
   stand and which A11 voided. **Neither receipt exists in this tree** - globbed for `*review-803*`,
   `*a11*` and `*REVIEW-80*` under `coordination/`, zero matches. Rather than reconstruct the mapping from
   memory, A12.6 says it is not verifiable here, quotes the one supersession note the runbook itself
   carries (section 4: the offline SDK R4 parser and admin projection findings have later fix receipts and
   should not be listed as still open), and directs the reader to cite the mapping from those receipts.
2. **A12.4 is derived, not authoritative.** The four conditions are grounded in this runbook with their
   own line references, and A12.4 says explicitly that if the coordinator holds an authoritative list of
   four elsewhere, that list governs.
3. **Nothing in A8/A12 was executed.** No census, no auth gate, no DB, no key provider. The sections
   describe a procedure for the window, not a result.

---

## 4. Ledger

- A12-AUTH-GATE-RUNBOOK - Muc 1 - runbook 188 -> 290 lines: added A8 gate-integrity clause and A12 auth
  gate (shape census first, per-row readStored with allowPlaintext=false on the production key with exact
  tenant/slot/refId, counts only, one veto per broken row, four remaining conditions, coordinator proposes
  / USER decides); updated A10.1 with the two-gate rule and the 807 outbox shape-only caveat, and corrected
  A10.5 read-only from "claim" to "enforced with proof". Counter NOT run. No source edit, no commit, no
  tick. Limits: REVIEW-803/A11 mapping unverifiable in-tree; A12.4 derived from this runbook.
