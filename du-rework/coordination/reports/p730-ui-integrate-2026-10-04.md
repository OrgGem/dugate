# P730-UI-INTEGRATE (phase 1) — receipt (mount CurlImportPreview vào ConnectorsScreen)

> **RESUME POINT (qwen_5, 2026-10-04 20:1x)** — packet `P730-UI-INTEGRATE-P1` from run `run_069ecd6957cd`
> (task `task_009c9082b8a8`, ctx `ctx_27b4ef76404e`), spec
> `coordination/dispatch-specs/2026-10-04-1935-P730-UI-INTEGRATE-P1.md`. Status: **implemented,
> offline-verified; save/test/activate deliberately NOT implemented (GAP §4)**. UI_APPROVED NOT ticked.
> Nothing committed, nothing pushed. Q1/Q2/Q3 of the P730 receipt stay open for the Reviewer (§5).
> Depends on P730-CURL-IMPORT (receipt `p730-curl-import-2026-10-04.md`), which stays valid.

---

## 1. Lease — what changed

| File | Change | Size after |
|---|---|---|
| `connectors-screen.tsx` | MODIFIED — Import cURL button + Modal + accepted-draft card | 299 lines (was 198) |
| `state.ts` | MODIFIED — added `ConnectorImportDraft` + `draftFromCurlImport` | 63 lines (was 45) |
| `curl-import.ts` | `buildSummary` → exported `summarizeCurlImport` (rename only) | 594 lines |
| `curl-import-preview.tsx` | export `CurlImportSummaryView`; `h1`→`h2` (one h1 per page) | 240 lines |
| `tests/browser/admin-web/p730-curl-import.spec.ts` | header rewrite + 3 mount tests (14–16); 16 tests total | 283 lines |
| this receipt | NEW | — |

Touched nothing outside the lease: router, shared primitives, styles, contracts, lockfile, package.json
— all untouched. No dependency added. Edits were targeted (no whole-file rewrites of lane-shared files);
pre-edit read confirmed no other lane had written these files since the P730 cycle (mtimes still 12:37/12:28 PM).

---

## 2. What was built (accept-only flow, zero network)

```
Connectors header → [Import cURL] (Button, opens Modal)
  Modal → <CurlImportPreview onApply={draft -> setImportDraft(draftFromCurlImport(draft)); close} applyLabel="Accept draft">
    paste → parser → redacted preview (unchanged from P730)
    Accept draft → draft lives ONLY in screen state (in-memory, editable name field)
      → ImportedDraftCard re-renders via summarizeCurlImport (secret stays masked after accept)
      → [Save connection] [Test connection] rendered DISABLED with reason; [Discard] drops the draft
```

- `onApply` semantics kept: accept copies the draft into state, nothing else. No autosave, no fetch,
  no storage write anywhere in the flow (checked against source text, §3 check 14).
- The draft model extends `CurlImportDraft` (spread-copy + editable `name`), so every render path —
  pre- and post-accept — goes through the same `summarizeCurlImport` redaction rules.
- Reuse over duplication: the accepted card renders headers/fields/notes through the existing
  `CurlImportSummaryView` rather than a second copy of the table.

---

## 3. Evidence (literal Exit Codes)

### 3.1 `pnpm --filter @du/admin-web typecheck` — 3 consecutive runs
```
> tsc --noEmit -p tsconfig.json
Exit Code: 0   (run 1)
Exit Code: 0   (run 2)
Exit Code: 0   (run 3)
```

### 3.2 `pnpm --filter @du/admin-web build` — 3 consecutive runs
```
✓ 2664 modules transformed.
dist/assets/index-HHyOtXdi.css   40.81 kB │ gzip:   8.08 kB
dist/assets/index-DgK0tmyo.js   459.55 kB │ gzip: 144.59 kB
Exit Code: 0   (run 1: built in 9.38s)
Exit Code: 0   (run 2: built in 9.21s)
Exit Code: 0   (run 3: built in 9.82s)
```
**This build DOES exercise the slice now:** module count moved 2662 → 2664 and the JS bundle
444.44 kB → 459.55 kB — the two leaves are reachable from the app entry through ConnectorsScreen.
(Contrast P730 §5.2, where the build proved nothing because the leaves were unmounted.)

### 3.3 Offline behaviour checker — 5 checks ×3 runs (node, after tsc)
```
PASS core parse still green
PASS 15 accepted draft stays masked through summarize
PASS 14 screen mount is accept-only
PASS 16 screen leaf free of eval/shell
PASS limits untouched
SUMMARY failures=0   Exit Code: 0   (runs 1, 2, 3)
```
Check 15 proves the post-accept path: `draftFromCurlImport(parse(draft))` → `summarizeCurlImport`
JSON contains `****0055` and contains neither bearer nor form secret, while the in-memory draft
keeps `auth.secretValue` for the future save wire.

### 3.4 SSR render — real `ConnectorsScreen` markup (react-dom/server, vite ssr bundle) ×3 runs
```
SCREEN_H1=true                        DRAFT_CARD_ABSENT_BEFORE_ACCEPT=true
IMPORT_BUTTON=true                    SAVE_DISABLED=true
PARSE_OK=true                         SCREEN_SECRET=false
CARD_SECRET_LEAK=false                CARD_FINGERPRINT=true
CARD_METHOD=true                      CARD_FORM_FIELD=true
Exit Code: 0   (runs 1, 2, 3)
```
The whole screen renders; the Import button is present; the draft card is absent before accept;
no secret appears in screen markup; the post-accept summary view leaks nothing.

Both harness flavours (checker + SSR bundle) ran in a throwaway `.p730-check/`, deleted after;
`if exist` confirms `TEMP_REMOVED`. This time the mount made SSR rendering of the real screen
possible — a first for this feature.

### 3.5 Playwright spec — authored (16 tests), executed: **SKIP — GAP**

Re-probed 2026-10-04 for this packet: `@playwright/test => UNRESOLVED`, `playwright => UNRESOLVED`
from the du-rework root; no runner binary. Tests 14–16 are static mount guards (imports,
accept-only wiring, disabled save/test, no eval/shell/storage in the screen) plus the runtime
redraw check (15). The interactive browser flow (open modal → paste → preview → Accept → card)
is **not** driven in a real page — that needs the coordinator runner plus the harness env vars.
SKIP is not PASS. The SSR render in §3.4 is the closest substitute, and it is labelled as such.

---

## 4. GAP — save / test / activate NOT implemented (by packet order)

- No connector save/test/activate wire exists on this deployment (PAR-03/14; the P730 baseline
  showed even revision reads 404 without `connectorBaseUrls`). Per spec: **no mock-save**, no faked
  success. The draft card states this in its own copy: `in-memory: requires backend`.
- Save/Test buttons are rendered **disabled with a title reason** (same honest pattern as the
  existing Test credential / Rotate secret buttons on this screen).
- Handoff for whoever wires the backend: `ConnectorImportDraft` (state.ts) is the payload shape;
  `summarizeCurlImport(draft)` is the only safe projection for any UI of that save flow.

---

## 5. Q1 / Q2 / Q3 — status: OPEN, untouched (reviewer Antigravity evaluating in parallel)

- Q1 (fail-closed Δ1–Δ13 vs legacy leniency): no parser behaviour changed this phase.
  `summarizeCurlImport` is a rename + export; the redaction rules are byte-equivalent.
- Q2 (masking heuristic): heuristic untouched.
- Q3 (onApply scope): kept accept-only exactly as the packet ordered; the prop signature is
  unchanged, so whatever the Reviewer decides about Q3 does not fork here.

---

## 6. Δ-DEVIATION

1. **Δ14 — `summarizeCurlImport` exported from the parser leaf** (was internal `buildSummary`).
   Reason: the post-accept card must rebuild the redacted summary from a mutated draft; duplicating
   the masking rules in the screen would fork the security logic. Behaviour unchanged.
2. **Δ15 — the preview renders `h2`, not `h1`.** The component now lives inside a dialog on a page
   that has its own `h1` (Connectors). Heading-level fix only.
3. **Δ16 — `CurlImportSummaryView` became an export** of the preview leaf so the screen can reuse it
   instead of copying the table markup. Visual output identical.
4. **Δ17 — `ConnectorImportDraft extends CurlImportDraft`** (spread + `name`) rather than a flattened
   copy. Reason: a flattened copy would need its own summarizer; this keeps one redaction path.
5. The Import cURL button sits in the header row of the Connectors screen (the packet allowed
   "entry point hợp lý"); the legacy dialog had no fixed slot. Trivially relocatable.

---

## 7. Ledger

- P730-UI-INTEGRATE-P1 — Mục 1 — mounted accept-only flow (Modal + in-memory draft + disabled
  save/test), 3 mount tests added; offline-verified honestly: typecheck 3× Exit Code: 0,
  build 3× Exit Code: 0 (2664 modules / 40.81 kB css / 459.55 kB js — bundle now includes the
  leaves), node checker 3× failures=0, SSR render 3× clean; Playwright runner still UNRESOLVED
  → SKIP/GAP; save/test/activate GAP with disabled buttons, zero mock; Q1–Q3 kept open;
  Δ14–Δ17 flagged.
