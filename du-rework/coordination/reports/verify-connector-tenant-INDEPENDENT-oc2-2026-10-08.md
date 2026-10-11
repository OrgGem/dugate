# VERIFY — connector knownIds + tenant roster (leg B, independent) — 2026-10-08

- **Lane**: oc2 (per dispatch filename) — independent verification.
- **Scope**: connector `knownConnectorIds` suites + `tenant-list` suites ONLY
  (not MED-1).
- **Mode**: READ-ONLY — no source/test edits, no commit/add/push, no gate
  ticks, no `docs/21-openapi.json` hand-edit, `.env.live` never read.
  Offline only — no PostgreSQL, no Redis, no DB window claimed.
- **cwd for every command**: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.

## Discovery (exact commands)

| Command | Exit | Result |
|---|---:|---|
| `rg -l knownConnectorIds tests/` | 0 | 4 files (below) |
| `rg -l tenant-list tests/` | 0 | 6 files (below) |

## Connector suites — command, exit, literal lines

Command per file (one at a time, no retry):
`node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs <file>`

| File | Exit | Test Suites (literal) | Tests (literal) |
|---|---:|---|---|
| `tests/admin-config-cockpit.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 8 passed, 8 total` |
| `tests/admin-connector-render.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 16 passed, 16 total` |
| `tests/bff-connectors-actions.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 17 passed, 17 total` |
| `tests/p745-connector-management-proxy.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 12 passed, 12 total` |

## Tenant suites — command, exit, literal lines

Command per file (one at a time, no retry):
`node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs <file>`

| File | Exit | Test Suites (literal) | Tests (literal) |
|---|---:|---|---|
| `tests/admin-operations-sort-http-offline.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 32 passed, 32 total` |
| `tests/f3-tenant-list-live-db.test.ts` | 0 | `Test Suites: 1 skipped, 0 of 1 total` | `Tests: 2 skipped, 2 total` |
| `tests/f3-tenants-route-live.test.ts` | 0 | `Test Suites: 1 skipped, 0 of 1 total` | `Tests: 11 skipped, 11 total` |
| `tests/f5-bff-tenant-cursor-offline.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 2 passed, 2 total` |
| `tests/tenant-list-cursor-codec-offline.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 6 passed, 6 total` |
| `tests/tenant-list-bff-offline.test.ts` | 0 | `Test Suites: 1 passed, 1 total` | `Tests: 3 passed, 3 total` |

**Skipped, not run (offline rule honored):** `f3-tenant-list-live-db` (2 tests)
and `f3-tenants-route-live` (11 tests) are live-gated and reported **skipped**
by jest. They were **not** executed against any database; no DB window is
claimed. Not reds — genuinely not run offline.

## Typecheck

| Command | Exit | Output |
|---|---:|---|
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | 0 bytes |

## Red results

**None.** All 8 executed suites passed (96 tests: 8+16+17+12+32+2+6+3), exit 0
each; 2 live suites skipped offline as above. No test name/expected/received to
report because nothing failed.

Factual note (no interpretation): `tests/admin-operations-sort-http-offline.test.ts`
— listed among pre-existing reds in an earlier full offline run — is **green now**
(`32 passed, 32 total`) in this run.

## Constraints

No source edits; no commit, no `git add`, no push; no gate ticks; no
`docs/21-openapi.json` edits; `.env.live` never read or printed; offline only.

## Outputs

Full console captures were kept outside the repo at
`%TEMP%\verify-connector-tenant\` (one log per suite + `tsc.log`). The only file
this lane creates in the repo is this receipt.
