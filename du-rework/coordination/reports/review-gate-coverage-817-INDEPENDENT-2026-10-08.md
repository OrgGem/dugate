# REVIEW INDEPENDENT — GATE-COVERAGE-817 (metadata auth counter) — 2026-10-08

- **Reviewer**: oc_3 (independent review leg; original receipt read for
  comparison only).
- **Mode**: READ-ONLY — no source/test/config edits, no commit/add/push, no
  gate tick, no `docs/21-openapi.json` hand-edit, `.env.live` never read.
  **Offline** — no PostgreSQL/Redis, no DB window claimed. `du-rework` only.
- **Original receipt**: `coordination/reports/gate-coverage-817-2026-10-05.md`.
- **Artifacts**: `src/modules/encryption/metadata-auth-counter.ts`,
  `tests/gate-authenticate-808.test.ts`, `tests/gate-authenticate-808-pg16.test.ts`.

## Commands (literal + exit; cwd `orchestrator/services/orchestrator`)

| # | Command | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `pnpm exec jest --runInBand tests/gate-authenticate-808.test.ts` (the offline file only) | **0** | `Test Suites: 1 passed, 1 total` / `Tests: 8 passed, 8 total` |
| 2 | extra (offline): `pnpm exec jest --runInBand tests/bypass-fix-810.test.ts` | **0** | `Test Suites: 1 passed, 1 total` / `Tests: 13 passed, 13 total` |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | no output (0 bytes) |
| — | `tests/gate-authenticate-808-pg16.test.ts` | **NOT RUN** | live-gated on `GATE_AUTH_PG_URL` (`:22-23`); running it would need a DB — explicitly out of scope for this offline review |

Note on #2: the 817 receipt ran this suite with a temporary ts-jest config
(diagnostics disabled). Today it passes with the **default** config, consistent
with #3 (typecheck clean).

## 1. Fail-closed behaviour of the counter (file:line)

`countUnsealedWithAuth` (`metadata-auth-counter.ts`):

| Condition | Where | Result |
|---|---|---|
| census **missing** (`expectedTenantIds === undefined`) | `:342-344` | reason “not supplied from an independent…census” → `coverage.complete=false` → **FAIL** (`:388`) |
| census **empty** `[]` | `:345-347` | reason “vacuous coverage cannot pass” → **FAIL** |
| census duplicates | `:348-350` | reason → **FAIL** |
| census contains empty/non-string ID | `:351-353` | reason → **FAIL** |
| a census tenant invisible in ALL slots | `:357-359` | `missingTenantIds` + RLS/policy reason → **FAIL** |
| tenant outside the census visible | `:360-362` | `unexpectedTenantIds` reason → **FAIL** |
| row with no usable tenant id | `:245-252`, `:363-365` | `unattributedRows` reason → **FAIL** |
| fewer than 8 slots fully scanned | `:354-356` | reason → **FAIL** |
| trimmed/extra/duplicate spec list | `assertFullCoverage` `:58-75` | **throws** before any query |
| **no crypto seam** | `:261-265` | every non-null value = `plaintext` → `blockers` > 0 → **FAIL** |
| shape-passing but unreadable envelope | `:285-306`, `:320-321` | `sealedBrokenAuth/Context/Other` all counted in `blockers` → **FAIL** |
| gate predicate | `:388` | `PASS` only when `blockers===0 && coverage.complete` |

**Slot query errors propagate**: `await options.db.query(slotSql(spec))` at
`:236` is **not** wrapped in try/catch — a throwing slot query aborts
`countUnsealedWithAuth` with the error (no result object, no PASS). This matches
the receipt’s “fail-closed” claim. **Honest gap:** neither offline suite drives
a throwing slot query (all fakes return rows), so this property is
code-inspection-verified, not test-pinned.

## 2. `runtime.ts(478,38)` TS2554 — pre-existing or recent?

- **Not reproducible today**: command #3 exits **0 with 0 bytes** of
  diagnostics; there is no TS2554 anywhere in the current tree.
- **The old site no longer carries code**: current `runtime.ts:478-483` is the
  `WRAPPER-FIX-812 (A15)` comment; the call below it is
  `compatibilityMetadataReader(seam)` (`:484`). The pre-restructure path
  `du-rework/services/orchestrator/…/runtime.ts` **does not exist** any more
  (restructure `df3f955`, 2026-10-07); `git log --follow` shows the file’s
  history as `72e225a` → `df3f955` → `4308cc5` → `5349c89` → `7811298`.
- **Attribution**: the 817 receipt itself logged it as “unrelated out-of-lease
  error” in a different file than the counter; the counter’s own scoped
  typecheck was exit 0. The error belonged to an intermediate wrapper state
  that the A15 wrapper work (`WRAPPER-FIX-812`) subsequently rewrote. It is
  **not caused by the 817 counter change** and is **no longer present** at the
  current revision. (Working-tree diff of runtime.ts today is only the WFA §8
  LOW cursor-scope hunk, 6+/1- — unrelated to TS2554.)

## 3. Bypass / spoofing assessment

- **Spec trimming bypass — closed**: exact 8-slot set enforced (`:58-75`);
  pinned by `bypass-fix-810.test.ts` BA-05 (trimmed and empty lists both
  rejected — it calls both). ✅ test-verified.
- **Shape-only false-pass — closed**: every shape-passing row is authenticated
  through the real reader (`:285-306`); the 808 suite shows
  `shapeSealed=4` vs `authSealed=1` with `gate=FAIL`. ✅ test-verified.
- **No-seam pass — closed**: no seam ⇒ all non-null plaintext ⇒ FAIL
  (`:261-265`); pinned by 808 (“no seam => … never a pass”). ✅ test-verified.
- **Census spoofing — RESIDUAL (procedural trust boundary)**: the expected
  census is **caller-supplied**. The counter checks presence/emptiness/
  duplicates/format and set-equality against observed tenants, but it **cannot
  verify that the census really is independent or full-visibility**. A caller
  that passes a census equal to the RLS-filtered observed set would satisfy
  every coverage check (given clean auth counts) and get `PASS`. The API
  documents the requirement (`:219-224`, `:29-35`) and the live PG16 test
  demonstrates the intended caller behaviour (census from an unrestricted
  connection, `gate-authenticate-808-pg16.test.ts:154-157`) — but enforcement
  is operational, not technical. **Not verified live in this review.**
- **Crypto seam trust — RESIDUAL**: the reader seam is injected; a fake
  always-succeeding seam would classify broken envelopes as `sealedValid`. The
  production caller must pass the real reader (as the suites do). Procedural.
- **Empty-slot semantics — acceptable**: empty slots are reported
  (`:331-340`) but are not blockers by themselves; vacuous configurations are
  still caught by the census rules and the 8/8-scan check (an all-empty DB hits
  missing-tenant or empty-census FAIL). ✅ reasoned from `:342-366`.

## 4. Comparison with the original receipt

| 817 receipt claim | Independent review |
|---|---|
| PG16 RLS repro PASS (2 suites/10 tests) | **not re-run** (live-gated; offline rule) — claim neither confirmed nor refuted here |
| bypass-fix-810 PASS (13 tests) | **confirmed**: exit 0, 13/13 with the default config |
| counter scoped tsc exit 0 | consistent with current service tsc exit 0 (0 bytes) |
| `tsc -p tsconfig.json` exit 1 at `runtime.ts(478,38)` TS2554, out-of-lease | **no longer present** (tsc exit 0); old path gone after restructure; the region was rewritten by later wrapper work; not attributable to the counter change |

## Verdict

**Counter logic (offline scope): PASS.** Fail-closed on missing/empty/deduped/
invalid census, missing/unexpected/unattributed tenants, unscanned slots,
no-seam, and broken envelopes; slot-query errors propagate instead of being
swallowed. Offline suite 8/8 and BA-05 13/13 green; typecheck clean.

**Two residuals stand, honestly:** (1) the census is trusted as caller-supplied
— a non-independent census is a bypass path that only process discipline
guards; (2) no test pins the slot-query-throw propagation. Nothing was edited
to make anything green.

## Constraints

No source/test/config edits; no commit, no `git add`, no push; no gate tick; no
`docs/21-openapi.json` edit; `.env.live` never read; offline only. The only file
this lane creates in the repo is this receipt.
