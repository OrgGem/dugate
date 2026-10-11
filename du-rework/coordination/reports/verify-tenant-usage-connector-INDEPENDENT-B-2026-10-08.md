# VERIFY (agent B) — tenant roster + usage + connector focused battery — 2026-10-08

- **Verifier**: oc_3 (independent agent B).
- **Mode**: READ-ONLY — no source/test/config edits, no commit/add/push, no gate
  ticks, no `docs/21-openapi.json` hand-edit, `.env.live` never read.
  **Offline only** — no PostgreSQL/Redis, no DB window claimed. `du-rework` only.
- **Runtime**: `node -v` → **`v22.16.0`** (node on PATH).
- **cwd for every command**: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.
- Every command ran in its own process; `REAL_EXIT` was captured immediately
  after it (no pipe that could swallow the exit code). Full outputs kept outside
  the repo at `%TEMP%\verify-tuc\`.

## Command table (command × exit × literal)

| # | Command | REAL_EXIT | Literal |
|---|---|---:|---|
| 0 | `node -v` | 0 | `v22.16.0` |
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts tests/f5-bff-tenant-cursor-offline.test.ts tests/f6-api-key-tenant-select-offline.test.ts tests/f2-overview-tenant-select-offline.test.ts tests/f4-component-tenant-select.test.ts` | **0** | `Test Suites: 6 passed, 6 total` / `Tests: 36 passed, 36 total` |
| 2 | `node tests/tenant-select-offline.cjs` | **0** | `PASS: real TenantSelect element tree — 8 scenarios (…cycle/multi-page)` — all 8 `ok` |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/usage-drilldown.test.ts tests/usage-aggregation.test.ts tests/usage-contracts-integration-offline.test.ts` | **0** | `Test Suites: 3 passed, 3 total` / `Tests: 31 passed, 31 total` |
| 4 | `node tests/usage-screen-offline.cjs` | **0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |
| 5 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-connector-render.test.ts tests/admin-connector-view-model.test.ts tests/bff-connectors-actions.test.ts tests/p745-connector-actions.test.ts tests/p745-connector-boot-composition.test.ts tests/p745-connector-management-proxy.test.ts` | **0** | `Test Suites: 6 passed, 6 total` / `Tests: 148 passed, 148 total` |

Totals: **15 jest suites executed, all passed; 215 jest tests, all passed; 2
`.cjs` harnesses, both exit 0.**

## RED suites

**KHÔNG có — none.** Every command above exited 0; no failing test, so no error
block to quote.

## SKIPPED

**None appeared in the executed commands** — the three jest summaries report
`passed / total` with no `skipped` entries, and both harnesses run to completion.

Live-gated suites were **deliberately not run**, per the packet: `usage-summary.test.ts`
and `f3-tenants-route-live.test.ts` (the latter reports `Test Suites: 1 skipped`
when invoked offline; it is excluded from this battery and **skipped ≠ passed**).
No DB window was claimed or used.

## Conclusion (honest)

**PASS on the verified scope.** All 15 focused suites across the three change
areas (tenant roster cursor/BFF/select, usage 422/summary/drilldown, connector
knownIds render/view-model/BFF/p745) passed with exit 0 on Node `v22.16.0`,
offline; both element-tree harnesses (tenant select, usage screen) exit 0 with
their explicit `PASS` lines. No reds, no hidden skips inside the executed set,
nothing was edited to make anything green.

## Constraints confirmation

No source/test/config edits; no commit, no `git add`, no push; no gate ticks; no
`docs/21-openapi.json` edits; `.env.live` never read or printed; offline only.
The only file this lane creates in the repo is this receipt.
