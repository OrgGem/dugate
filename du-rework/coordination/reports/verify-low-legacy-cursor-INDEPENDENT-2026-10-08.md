# VERIFY INDEPENDENT — WFA §8 LOW: legacy page-token cursor unscoped — 2026-10-08

- **Verifier**: oc_3 (independent lane; original receipt read for comparison
  only, every claim re-run/re-checked on disk).
- **Mode**: READ-ONLY — no source/test edits, no commit/add/push, no gate tick,
  no `docs/21-openapi.json` edit, offline only (no live PG/Redis, no DB window).
- **Original receipt**: `coordination/reports/fix-section8-low-legacy-cursor-2026-10-08.md`.
- **Repo state at verification**: HEAD `72e225ae5465e5a648c34bf31fbabbd182763233`
  (advanced by other lanes since the fix receipt), working tree dirty (multiple
  lanes).
- **`src/modules/runtime/runtime.ts` SHA-256**:
  `900E2AD60214DA8582B86A41ABB027145E5D512DAC76B4F4FA3515090DB8A6A3`
  (mtime `2026-10-08T09:54:26`).

## Commands (cwd = `orchestrator/services/orchestrator` unless noted) — literal

| # | Command | Exit | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts` | **0** | `Test Suites: 1 passed, 1 total` / **`Tests: 48 passed, 48 total`** |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/enc-meta-sentinel-runtime-refs.test.ts` | **0** | `Test Suites: 1 passed, 1 total` / **`Tests: 10 passed, 10 total`** |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | output = **0 bytes** |
| 4 | `git diff --stat` (repo root `D:\Git\dugate`) | 0 | 13 files dirty (list below) |
| 5 | extra: `…jest… tests/fix-section8-legacy-cursor-offline.test.ts` | **0** | `Test Suites: 1 passed` / `Tests: 8 passed, 8 total` |

Raw logs: `coordination/reports/raw/verify-low-legacy-cursor/` (`cmd1-rv01.log`,
`cmd2-enc-meta.log`, `cmd3-tsc.log` 0 bytes, `cmd4-diffstat.log`,
`cmd5-fix-lane-test.log`).

## (a) Test failures — NONE, and the two packet expectations differ from reality

**No failing test was found in any command.** Two packet/“known-state” contrasts,
reported exactly:

1. **rv01 is GREEN now (48/48, exit 0), not red.** The packet (and the fix
   receipt's snapshot: `1 failed, 47 passed`) expected the test double's pinned
   old subquery to fail. The double has since been **updated by its owner**:
   `tests/rv01-loopback-http-offline.test.ts` is `M` (mtime `10:08:08`, after
   `runtime.ts` 09:54:26) and its diff makes the double scope-aware —
   the boundary regex now accepts `(?: and tenant_id = $N)?` /
   `(?: and (pipeline_json->0->>'workflow' is null or api_key_id = $N))?`,
   resolves the anchor only if it matches the tenant and api-key fence, and
   returns an **empty page when the anchor is not visible** (NULL semantics,
   commented as such). This is a faithful double update, not an assertion
   loosening (see (c)).
2. **enc-meta is GREEN now (10/10, exit 0).** It was red earlier today in my
   MED-1 sweep (`HttpError: operation not found` at `runtime.ts:1462`). Its test
   double has since been updated (`M`, 30 lines): it now models the current
   product column list (`endpoint_slug`) and the `tasks JOIN operations …
   FOR UPDATE OF t` read, with explicit comments “No sentinel/assertion
   changed”. Not related to the LOW cursor fix; reported as observed.

## (b) Product diff scope — CORRECT, confined to the cursor scope

`git diff --stat` dirty list (13 files, multiple lanes): the LOW fix's product
changes are exactly the two files below; the other entries belong to other
lanes (e.g. `log-metadata.ts` / `migrations.ts` = my own earlier fix lanes,
docs/tasks/other tests = other lanes).

1. **`src/modules/runtime/runtime.ts`** — single hunk `@@ -1843,9 +1843,14 @@`
   in `listOperations`, adding `AND tenant_id=$1` to the cursor subquery plus an
   explanatory comment. Placeholder order unchanged (`$1` tenant, `$2` cursor,
   `$3` limit). Literal:
   ```diff
   -         ${cursor ? 'AND created_at < (SELECT created_at FROM operations WHERE id=$2)' : ''}
   +         ${cursor ? 'AND created_at < (SELECT created_at FROM operations WHERE id=$2 AND tenant_id=$1)' : ''}
   ```
   No other hunk in the file — matches the fix receipt's claim (`:1845-1852`).
2. **`src/compat/legacy-host-adapter.ts`** — hunks `@@ -404,10 +404,17 @@` and
   `@@ -419,10 +426,16 @@` in `listLegacyOperations`: `tenantScope` and
   `apiKeyFence` are named once and reused by the outer WHERE **and** the
   page-token subquery; the subquery becomes
   `… WHERE id = $N AND ${tenantScope} AND ${apiKeyFence}`. `deleted_at IS NULL`
   is deliberately kept out of the scope (visibility ≠ authorization, per the
   receipt's rationale). Placeholder order unchanged (`$2` = LIMIT, token
   appended at `params.length`, filters from `$4`). Matches the receipt §3.1.
3. **`tests/fix-section8-legacy-cursor-offline.test.ts`** (new, `??`) — the fix
   lane's own test; runs **8/8 green** (command 5).

No other product file carries a cursor-scope change; the LOW fix does not touch
anything beyond the two helpers.

## (c) Assertion loosening — none found

- **By the fix lane**: product-only edits (two helpers) + a new test file. No
  existing test/assertion was modified by the fix itself.
- **rv01 (owner update)**: the diff replaces the old pinned regex with a
  scope-aware one **and adds enforcement** (api-key fence filtering, tenant
  match on the anchor, empty page on invisible anchor). Assertions in the suite
  are unchanged; the double is now stricter, not looser.
- **enc-meta (owner update)**: the diff (30 lines, reviewed in full) only models
  current product reads; comments state no sentinel/assertion changed.
- No test was skipped, deleted, or weakened anywhere in the reviewed diffs.

## (d) Verdict

**LOW fix ĐẠT (PASS) theo evidence của tôi.** The scope predicate is mirrored
into both page-token/cursor subqueries exactly as the finding requires, with
placeholder order preserved and fail-closed NULL semantics; typecheck is clean
(exit 0, 0 bytes); all three relevant suites are green (rv01 48/48 — after its
owner's faithful double update, enc-meta 10/10, fix test 8/8); no assertion was
loosened.

**Limitations (honest):** offline only (no live PG/Redis, no DB window claimed);
I did not re-run the full offline suite nor the receipt's 16-suite related set;
the rv01/enc-meta greens are attributable to their own owners' double updates
(verified as faithful), not to this fix.

## Raw inventory

`coordination/reports/raw/verify-low-legacy-cursor/`: `cmd1-rv01.log` (1032 B),
`cmd2-enc-meta.log` (3760 B), `cmd3-tsc.log` (0 B), `cmd4-diffstat.log`
(1784 B), `cmd5-fix-lane-test.log` (1044 B).

No commit / no add / no push / no gate tick; `docs/21-openapi.json` untouched;
this receipt is the only file this lane created.
