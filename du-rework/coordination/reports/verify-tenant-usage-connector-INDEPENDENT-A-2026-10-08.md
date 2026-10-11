# VERIFY-A (independent) — tenant roster / usage / connector focused sets — 2026-10-08

- Verifier: Agent A — OpenCode (`oc_4`). **Read-only**: no source/test/config edits, no commit/add/push, no gate tick, no `docs/21-openapi.json` edit, no `.env.live` read, offline (no PostgreSQL/Redis started, no DB window claimed). Scope: `du-rework` only.
- Tree: HEAD `72e225a`, working tree dirty (portal wave lanes).
- Runtime (recorded before running): **`node -v` = `v22.16.0`** (`where node` → `C:\nvm4w\nodejs\node.exe`).
- CWD for every command: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.
- All results below were produced by me on the current disk; no receipt was trusted. Each command ran in its own process and `REAL_EXIT` was captured immediately after it (no pipe through `tail`).

## Command matrix (literal)

| # | Group | Command | REAL_EXIT | Literal `Test Suites:` / `Tests:` (or harness PASS) |
|---|---|---|---:|---|
| 1 | G1 jest | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts tests/f5-bff-tenant-cursor-offline.test.ts tests/f6-api-key-tenant-select-offline.test.ts tests/f2-overview-tenant-select-offline.test.ts tests/f4-component-tenant-select.test.ts` | **0** | `Test Suites: 6 passed, 6 total` · `Tests: 36 passed, 36 total` |
| 2 | G1 cjs | `node tests/tenant-select-offline.cjs` | **0** | `PASS: real TenantSelect element tree - 8 scenarios (names-not-ids, state suffix, unknown value, loading/failed/empty/cycle/multi-page)` |
| 3 | G2 jest | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/usage-drilldown.test.ts tests/usage-aggregation.test.ts tests/usage-contracts-integration-offline.test.ts` | **0** | `Test Suites: 3 passed, 3 total` · `Tests: 31 passed, 31 total` |
| 4 | G2 cjs | `node tests/usage-screen-offline.cjs` | **0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |
| 5 | G3 jest | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-connector-render.test.ts tests/admin-connector-view-model.test.ts tests/bff-connectors-actions.test.ts tests/p745-connector-actions.test.ts tests/p745-connector-boot-composition.test.ts tests/p745-connector-management-proxy.test.ts` | **0** | `Test Suites: 6 passed, 6 total` · `Tests: 148 passed, 148 total` |

Total executed: **15 suites / 215 jest tests passed** + **2 .cjs harnesses passed**. Every `REAL_EXIT=0`.

## Literal outputs (verbatim)

### CMD1 — GRUP 1 jest — REAL_EXIT=0

```
Test Suites: 6 passed, 6 total
Tests:       36 passed, 36 total
Snapshots:   0 total
Time:        4.344 s
Ran all test suites matching tests/tenant-list-cursor-codec-offline.test.ts|tests/tenant-list-bff-offline.test.ts|tests/f5-bff-tenant-cursor-offline.test.ts|tests/f6-api-key-tenant-select-offline.test.ts|tests/f2-overview-tenant-select-offline.test.ts|tests/f4-component-tenant-select.test.ts.
```

### CMD2 — GRUP 1 `tenant-select-offline.cjs` — REAL_EXIT=0

```
  ok  a: option labels are tenant names and no raw id reaches any text node
  ok  b: a non-ACTIVE tenant is labelled with its state
  ok  c: a value outside the roster selects nothing and never fires onValueChange
  ok  d1: loading state before the roster resolves
  ok  d2: failed state clears the roster and raises an alert
  ok  d3: empty roster is its own state, not an error
  ok  d4: a repeating cursor is treated as a failed read, not an endless loop
  ok  d5: a multi-page roster is concatenated and stays name-labelled
PASS: real TenantSelect element tree - 8 scenarios (names-not-ids, state suffix, unknown value, loading/failed/empty/cycle/multi-page)
```

### CMD3 — GRUP 2 jest — REAL_EXIT=0

```
Test Suites: 3 passed, 3 total
Tests:       31 passed, 31 total
Snapshots:   0 total
Time:        3.437 s
Ran all test suites matching tests/usage-drilldown.test.ts|tests/usage-aggregation.test.ts|tests/usage-contracts-integration-offline.test.ts.
```

### CMD4 — GRUP 2 `usage-screen-offline.cjs` — REAL_EXIT=0

```
PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock
```

### CMD5 — GRUP 3 jest — REAL_EXIT=0

```
Test Suites: 6 passed, 6 total
Tests:       148 passed, 148 total
Snapshots:   0 total
Time:        3.252 s, estimated 4 s
Ran all test suites matching tests/admin-connector-render.test.ts|tests/admin-connector-view-model.test.ts|tests/bff-connectors-actions.test.ts|tests/p745-connector-actions.test.ts|tests/p745-connector-boot-composition.test.ts|tests/p745-connector-management-proxy.test.ts.
```

## RED suites

**KHÔNG có.** No `FAIL`, no `✕`, no failing assertion in any of the five runs. A case-insensitive scan of all raw logs for `skipped|todo|FAIL |✕` returned **0 hits** in every file. Nothing was fixed, skipped or reclassified to make anything green.

## SKIPPED

- **None in the executed set.** No run printed a `skipped` count (all summaries are `N passed, N total`).
- `tests/usage-summary.test.ts` and `tests/f3-tenants-route-live.test.ts` are **LIVE-GATED** and were **not run** (they are not in the instructed command list; no live suite was run). Per the instruction, they are not counted as passed; if run in a DB window, any skipped case must be reported as skipped, not pass.
- Benign environment note (not a skip/failure): the G1 raw log contains two `[admin-shell] admin web mount enabled but bundle is missing` warn lines emitted by the test environment; they do not affect any assertion.

## Conclusion (honest)

All three focused change areas verified by this pass are green **on the current disk, offline**: tenant roster/cursor + UI select (6 jest suites + element-tree harness), usage 422/summary/drilldown (3 jest suites + usage-screen harness), connector knownIds/picker (6 jest suites). `REAL_EXIT=0` for all five commands; no red, no skip in the executed set. This is offline jest + element-tree evidence only — no live/browser verification, no DB window, no gate tick (`VERIFIED`/`ACCEPTED` remains the coordinator/user decision). No commit, no push.

## Raw evidence

`du-rework/coordination/reports/raw/verify-tenant-usage-connector-2026-10-08/`:
- `g1-jest.txt` (CMD1, exit 0)
- `g1-tenant-select-cjs.txt` (CMD2, exit 0)
- `g2-jest.txt` (CMD3, exit 0)
- `g2-usage-screen-cjs.txt` (CMD4, exit 0)
- `g3-jest.txt` (CMD5, exit 0)
