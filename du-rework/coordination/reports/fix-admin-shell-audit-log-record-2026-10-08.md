# FIX — admin shell security audit event dropped by log metadata allowlist — 2026-10-08

**Status: COMPLETE (src fix + full offline proof). One deliverable item — the
default admin-shell rerun — remains RED in-lane for a build-artifact reason
explained below; it goes green the moment the package is rebuilt.**

- **Worker**: oc_3 (OpenCode)
- **Mode**: fix lane, offline only — NO commit, NO git add, NO push, NO branch
  change, NO gate tick, NO `docs/21-openapi.json` hand-edit, no live DB, no
  `DU_LIVE_INFRA` suites.
- **Lease**: only `packages/observability/src/log-metadata.ts` was modified in
  the repo (+ this receipt and raw logs under `coordination/reports/`).

## The RED reproduced first (fail-first)

cwd = `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts
```

- **Exit code: 1**
- Literal: `Test Suites: 1 failed, 1 total` / **`Tests: 1 failed, 50 passed, 51 total`**
- Failure at `tests/admin-shell-session-lifecycle.test.ts:821`:
  `expect(record.event).toEqual({kind, reason, method, pathname})` →
  **`Received: undefined`** — exactly the defect.
- Raw: `raw/fix-admin-shell-audit-log-record/red-1-admin-shell.log`

## Chosen design (and why the alternatives were rejected)

**Chosen: a scoped event projection (a refined Option B / Option C).** A
dedicated `EVENT_FIELDS` set — exactly the security-audit taxonomy's scalar
fields `kind, reason, method, pathname, action` (the same set pinned by
`admin-shell-session-lifecycle.test.ts:783`) — projects the object under the
`event` key one level deep, with the same charset/number rules as every
identifier. Everything else is dropped.

- **Option A rejected**: "project through the SAME allowlist recursively" would
  require adding `pathname` to the **global `IDENTIFIERS`** set (so the
  recursive projection keeps it), which expands what can survive at the TOP
  level of every sink — a broader posture change than the defect needs. A
  literal recursion would also admit `message`/`error`/`timestamp`/`FLAGS`
  handling under `event`, i.e. more surface than the audit taxonomy.
- **Option B (add the child keys to the global allowlist) rejected**: adding
  `pathname` (and nothing else is missing) to `IDENTIFIERS` again widens the
  top-level surface for all callers; the event taxonomy deserves its own,
  tighter scope.
- **Chosen C keeps the blast radius minimal**: `IDENTIFIERS` is byte-identical;
  only the `event` branch changes; a scalar `event` (string/number) still falls
  through to the existing identifier rule, so no existing behavior regresses.
- Nested objects/arrays under `event` are dropped (no recursion); unknown child
  keys are dropped; non-scalar values are dropped; the final `redact()` pass is
  unchanged.

## The change (file:line)

`packages/observability/src/log-metadata.ts`:

| Line | Change |
|---|---|
| `:16-17` | extracted `IDENTIFIER_VALUE` regex (same literal previously inline in the identifier branch) — reused, no behavior change |
| `:19-25` | `EVENT_FIELDS = {kind, reason, method, pathname, action}` |
| `:27-36` | `eventLogRecord()` — one-level scalar projection, unknown/nested/array dropped |
| `:51-56` | new `event` branch in `metadataLogRecord` (object values only; scalar `event` falls through) |
| `:57-60` | identifier branch now uses `IDENTIFIER_VALUE` (same regex as before) |

SHA-256 of `log-metadata.ts`:
- **BEFORE**: `F4AA191D3549006499003B1BC70602C6E77FC911BFAFBEDA1B9C0CEE288E4AAF`
- **AFTER**:  `D89A43B3154537AC5D8B49E97CF21BA59F590C19F891011E40ECDDBB159998E4`

## Commands / exit codes / literal results

| # | Command (cwd) | Exit | Literal |
|---|---|---|---|
| RED | `…jest… tests/admin-shell-session-lifecycle.test.ts` (services/orchestrator) | **1** | `Tests: 1 failed, 50 passed, 51 total` |
| privacy baseline | `…jest… tests/payload-privacy.test.ts` (**packages/observability** — the prescribed path `packages/observability/tests/...` does **not** resolve from services/orchestrator; there is no `packages/` dir there) | **0** | `Test Suites: 1 passed` / `Tests: 8 passed, 8 total` |
| privacy after fix | same as baseline | **0** | `Test Suites: 1 passed` / `Tests: 8 passed, 8 total` |
| full observability package | `…jest… --config jest.config.cjs` (packages/observability) | **0** | `Test Suites: 3 passed, 3 total` / `Tests: 44 passed, 44 total` |
| service typecheck | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (services/orchestrator) | **0** | 0-byte log |
| default admin-shell rerun (after src fix) | RED command again | **1** | `Tests: 1 failed, 50 passed, 51 total` — **still red, see residual 1** |
| temp-build mapped admin-shell rerun | `…jest… --config <TEMP>\jest.obs-temp-mapped.config.cjs tests/admin-shell-session-lifecycle.test.ts` | **0** | `Test Suites: 1 passed` / **`Tests: 51 passed, 51 total`** |

### Why the default rerun is still red (and why that is NOT a logic failure)

- The service resolves `@du/observability` to the package's **`dist`**:
  `require.resolve('@du/observability')` from the service →
  `orchestrator/packages/observability/dist/index.js`; there is no
  `moduleNameMapper` in `jest.config.cjs` / `jest.unit.config.cjs` and no
  tsconfig `paths`. `dist/` is **gitignored** (`du-rework/.gitignore:2 dist/`)
  and has 0 tracked files — a derived build artifact, built 2026-10-07
  19:15:50 from the pre-fix source.
- Rebuilding `dist` is **outside this lane's lease** ("may NOT edit any other
  file"), so the default E2E cannot see the fix until a rebuild happens.
- Proof that the fix is complete once compiled: the package was built to
  `%TEMP%` with its own tsc (`--outDir <TEMP>\obs-build`, exit 0) and the
  admin-shell suite was run with `@du/observability` mapped to that build →
  **51/51 green, exit 0** — the same output a `dist` rebuild produces. The
  sentinel assertion (`not.toContain('SENTINEL-SOCKET-LEAK-6666')`) passed in
  that run as part of the suite.

### Behavioral probe of the compiled fix (temp build)

```
audit-event (the RED case) -> {"message":"[admin-shell] security event","event":{"kind":"auth.login_failed","reason":"invalid_token","method":"POST","pathname":"/admin/login"}}
hostile event children (unknown key, nested object, array, secret key, bad charset) -> {"event":{"kind":"auth.login_failed"}}
scalar event (unchanged identifier path) -> {"event":"auth.login_failed"}
non-scalar taxonomy field (kind as object) -> {"event":{}}
array event (dropped as before) -> {}
```

Exactly the four expected keys for the audit event; everything unknown, nested,
array-valued, secret-named or bad-charset is dropped.

## Residuals (honest list)

1. **`packages/observability/dist` is stale (gitignored artifact) → the DEFAULT
   admin-shell command stays red until the package is rebuilt.** Rebuild command
   (outside this lane's lease, for the coordinator/build lane), from
   `orchestrator/packages/observability`:
   `node node_modules/typescript/bin/tsc -p tsconfig.json`
   (or `pnpm --filter @du/observability build`). Then re-run the default RED
   command; expected `51 passed, 51 total`. **This was not verified in-lane**
   (the temp-build run is the closest evidence).
   *Rebuild safety (checked):* every other `src/*.ts` file predates the current
   dist build (newest non-edited file `redaction.ts` 2026-10-07 04:30:17 vs
   dist 2026-10-07 19:15:50), so a rebuild incorporates **only this fix**.
2. Top-level scalar `pathname` remains dropped by design — it is only allowed
   inside the `event` object. If the owner wants top-level `pathname`, that is a
   separate redaction-posture decision, not part of this defect.
3. Only `kind, reason, method, pathname, action` survive under `event`; any
   future audit field must be added to `EVENT_FIELDS` deliberately (that is the
   point of the allowlist).
4. No live DB / live suites were run (offline only, per the task). Nothing
   here claims the blocker is closed end-to-end until residual 1 is done.

## Gate confirmation

No commit / no git add / no push / no branch change / no VERIFIED or ACCEPTED
tick / no WFA plan edit. `docs/21-openapi.json` untouched. Only
`packages/observability/src/log-metadata.ts` was modified in the repo (plus this
receipt and the raw logs).

## Raw logs (`coordination/reports/raw/fix-admin-shell-audit-log-record/`)

| File | Content |
|---|---|
| `red-1-admin-shell.log` | RED — 1 failed / 50 passed, exit 1 |
| `baseline-payload-privacy.log` | privacy guard baseline — 8/8, exit 0 |
| `payload-privacy-after.log` | privacy guard after fix — 8/8, exit 0 |
| `observability-package-full.log` | full package — 3 suites / 44 tests, exit 0 |
| `service-tsc.log` | typecheck — 0 bytes, exit 0 |
| `green-attempt-default-resolution.log` | default rerun — still 1 failed (stale dist) |
| `green-with-temp-build.log` | temp-build mapped rerun — 51/51, exit 0 |
| `probe-metadata-record.log` | compiled-fix behavioral probe |

Temp artifacts (outside repo): `%TEMP%\opencode\fix-admin-shell-audit\{obs-build\,
jest.obs-temp-mapped.config.cjs, probe.cjs}`.
