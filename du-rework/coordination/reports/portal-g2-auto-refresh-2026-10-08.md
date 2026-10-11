# OPU-G2 — auto refresh + data age labels (Overview & Usage) — 2026-10-08

- Lane/worker: OpenCode (`oc_4`). Scope: `du-rework` only. Offline only — no PostgreSQL/Redis started, no DB window claimed.
- Lease used (exactly): `apps/admin-web/src/features/overview/overview-screen.tsx`, `apps/admin-web/src/features/usage/usage-screen.tsx`, new `services/orchestrator/tests/portal-auto-refresh-offline.cjs`. No other file was edited; `usage-screen-offline.cjs`, `f7-overview-usage-tile-offline.cjs`, `docs/21-openapi.json` untouched (mtimes unchanged). No commit, no `git add`, no push; no `.env.live` read; no gate ticked.

## What was built

- **Both screens**: an explicit `Auto refresh: On/Off` toggle (`aria-pressed`, `data-portal-auto-refresh-toggle`), **off by default**; one `setInterval` created only after opt-in (`AUTO_REFRESH_MS = 10_000`), cleared by the effect cleanup on toggle-off and unmount.
- **Data age label** (`data-portal-data-age`, state `data-data-age-state`): derived from the timestamp of the last **successful** load completion; never loaded → literal `Unavailable (no successful load yet)` — never a zero or fake age.
- **Failed refresh**: the last good data stays on screen and the label switches to `stale` (with the last-success age); a first-load failure keeps the existing fail-closed panes. No blanking, no zero substitution.
- **Usage screen**: changing tenant resets provenance to `Unavailable` for the new scope.
- **New harness** `portal-auto-refresh-offline.cjs`: follows the `f7`/`tenant-select-offline` convention (real TSX transpiled with `typescript`, executed in a `vm` with a React hook shim), plus fake `setInterval`/`clearInterval`, a fake clock, and effect-cleanup tracking. 9 scenarios.

## RED literal (before implementing; harness `portal-auto-refresh-offline.cjs`, cwd `services/orchestrator`)

Command: `node tests/portal-auto-refresh-offline.cjs`

```
  FAIL usage-1: a failed first load shows Unavailable, never a zero age, and never polls
       an auto refresh toggle is rendered
  FAIL usage-2: a successful load shows an age derived from when it completed
       a data age label is rendered
  FAIL usage-3: polling starts only after the operator opts in, on the declared cadence
       clickable node expected
  FAIL usage-4: a failed refresh keeps the last good data and marks it stale
       clickable node expected
  FAIL usage-5: turning the toggle off and unmounting both clear the interval
       clickable node expected
  FAIL overview-1: a failed first load shows Unavailable and never polls
       an auto refresh toggle is rendered
  FAIL overview-2: a successful load is fresh; opt-in registers one interval that polls
       Cannot read properties of undefined (reading 'props')
  FAIL overview-3: a failed refresh keeps the last good rollup and marks it stale
       clickable node expected
  FAIL overview-4: unmount clears the interval (no leak)
       clickable node expected
FAILED 9/9: ...
exit=1
```

(Full literal preserved in this section; the run output above is verbatim.)

## PASS literal (final code)

### New harness — `node tests/portal-auto-refresh-offline.cjs` → exit 0

```
  ok  usage-1: a failed first load shows Unavailable, never a zero age, and never polls
  ok  usage-2: a successful load shows an age derived from when it completed
  ok  usage-3: polling starts only after the operator opts in, on the declared cadence
  ok  usage-4: a failed refresh keeps the last good data and marks it stale
  ok  usage-5: turning the toggle off and unmounting both clear the interval
  ok  overview-1: a failed first load shows Unavailable and never polls
  ok  overview-2: a successful load is fresh; opt-in registers one interval that polls
  ok  overview-3: a failed refresh keeps the last good rollup and marks it stale
  ok  overview-4: unmount clears the interval (no leak)
PASS: OPU-G2 auto refresh + data age — 9 scenarios (opt-in only, age from last success, stale-on-failure retention, cleanup on toggle-off/unmount)
exit=0
```

### Existing harness — `node tests/f7-overview-usage-tile-offline.cjs` → exit 0 (must stay green; not edited)

```
  ok  1: tenant session renders real usage totals and drops the stale copy
  ... (8/8)
PASS: real OverviewScreen usage tile — 8 scenarios (real totals, tenant from session, platform/unscoped/failed fail-closed, unreadable payload, empty window, Operations tile intact)
exit=0
```

### Existing harness — `node tests/usage-screen-offline.cjs` → exit 0 (extra regression check; not edited)

```
PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock
exit=0
```

### Typecheck — cwd `apps/admin-web`, `pnpm --filter @du/admin-web typecheck` → exit 0

```
> @du/admin-web@0.0.0 typecheck D:\Git\dugate\du-rework\orchestrator\apps\admin-web
> tsc --noEmit -p tsconfig.json

typecheck exit=0
```

## Every command + exit code (in order)

| # | cwd | Command | Exit | Result |
|---|---|---|---:|---|
| 1 | `services/orchestrator` | `node tests/portal-auto-refresh-offline.cjs` | **1** | RED 9/9 fail (screens had no toggle/age/timers) |
| 2 | `services/orchestrator` | `node tests/portal-auto-refresh-offline.cjs` (after implementation) | **1** | 7/9 — 2 refresh scenarios failed on a harness timing bug (assertions unchanged) |
| 3 | `services/orchestrator` | `node tests/portal-auto-refresh-offline.cjs` (after harness settle fix) | **0** | PASS 9/9 |
| 4 | `services/orchestrator` | `node tests/f7-overview-usage-tile-offline.cjs` | **0** | PASS 8/8 |
| 5 | `services/orchestrator` | `node tests/usage-screen-offline.cjs` | **1** | regression: first-`Button` heuristic picked the new header toggle |
| 6 | `services/orchestrator` | `node tests/usage-screen-offline.cjs` (after moving the toggle below the Window card) | **0** | PASS |
| 7 | `apps/admin-web` | `pnpm --filter @du/admin-web typecheck` | **0** | clean |
| 8 | `services/orchestrator` | `node tests/portal-auto-refresh-offline.cjs` (final) | **0** | PASS 9/9 |
| 9 | `services/orchestrator` | `node tests/f7-overview-usage-tile-offline.cjs` (final) | **0** | PASS 8/8 |

## Honest FAIL section

1. **Harness timing bug (mine, fixed).** The first post-implementation run (row 2) failed `usage-4` and `overview-3` with `'fresh' !== 'stale'`: my `settle()` did not flush microtasks before asserting, so the failed refresh's `setStale(true)` had not landed. I fixed the harness `settle()` (leading flush) — **no assertion was changed, deleted or weakened**; the RED run (row 1) was captured against the unmodified screens with the same assertions, so fail-first holds across the revision (the 2 scenarios fail structurally on unmodified screens because there is no toggle to click).
2. **Regression in an existing harness (fixed without touching it).** `usage-screen-offline.cjs:72,78` finds the *first* `Button` node and asserts `disabled` — my header toggle sat before `Load usage`, so it failed (row 5). Since that file is outside my lease, I did **not** edit it or its assertions; instead I moved the Usage toggle + age label to their own control row **below the Window card** (before the data pane), which keeps `Load usage` as the first Button and is also better UX (freshness control next to the data). Re-run green (row 6).
3. **Element-tree, not DOM.** Both harnesses assert on the returned React element tree with a stubbed API client; no browser/DOM render and no BFF/HTTP round trip was exercised. This is the same limitation the F-7 harness documents.
4. **Age semantics.** The age is computed at render time from `Date.now() - lastSuccessAt`; it refreshes on every render (poll ticks, manual loads, any state change) and the label also carries the explicit `stale` marker. When auto-refresh is off, the age does not tick per second — it updates on the next render. No fake per-second timer was added (that would be an interval outside the opt-in contract).
5. **Not covered:** live/browser verification, real polling against the BFF, production build, and any DB window. No gate (`VERIFIED`/`ACCEPTED`) was ticked.
