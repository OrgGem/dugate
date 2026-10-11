# VERIFY-A (independent) — GROUP A: hermetic NODE_ENV pin — 2026-10-09

- Verifier: Agent A — OpenCode (`oc_4`). **Read-only**: no source/test/config edits, no commit/add/push, no gate tick, no `docs/21-openapi.json` edit, no `.env.live` read, offline (no PostgreSQL/Redis started, no DB window claimed). Scope: `du-rework` only.
- Tree: HEAD `72e225a`, working tree dirty.
- Runtime (recorded before running): **`node -v` = `v22.16.0`** (`where node` → `C:\nvm4w\nodejs\node.exe`).
- CWD for all commands: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.
- Each command ran in its own process; `REAL_EXIT` captured immediately after (no pipe through `tail`). Ambient shell `NODE_ENV` was empty before LỆNH 2; for LỆNH 1 the child was launched with ambient `NODE_ENV=production`.

## Command matrix (literal)

| # | Command | REAL_EXIT | Literal `Test Suites:` / `Tests:` |
|---|---|---:|---|
| 1 | `NODE_ENV=production node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-audit-mount.test.ts tests/admin-audit-query.test.ts tests/admin-error-boundary-offline.test.ts tests/v1-boot-typed-denial.test.ts` | **0** | `Test Suites: 4 passed, 4 total` · `Tests: 84 passed, 84 total` |
| 2 | same 4 suites with `NODE_ENV` unset (ambient empty) | **0** | `Test Suites: 4 passed, 4 total` · `Tests: 84 passed, 84 total` |
| 3 | `node -e "require('child_process').execSync('node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/v1-boot-typed-denial.test.ts', {env: {...process.env, NODE_ENV: 'production', DU_TEST_PROBE: '1'}, stdio: 'inherit'})"` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 10 passed, 10 total` |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts tests/rv01-loopback-http-offline.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · `Tests: 99 passed, 99 total` |
| 5 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | no output (clean) |
| 6 | config inspection (read-only; copies saved to raw) | n/a | see “Wiring proof” below |

## Wiring proof — `setupFiles` is loaded and pins `NODE_ENV` before the framework

1. **Base config points at the setup file** — `jest.config.cjs:10`:
   ```js
   setupFiles: ['<rootDir>/tests/setup-node-env.cjs'],
   ```
   (comment `:7-9`: “GROUP A: pin NODE_ENV=test … jest.unit.config.cjs spreads this config, so it inherits setupFiles without its own edit.”)
2. **The unit config inherits it** — `jest.unit.config.cjs:5` `const base = require('./jest.config.cjs');` and `:27` `...base` → `setupFiles` is inherited; the only override is `testPathIgnorePatterns: liveSuites`.
3. **The setup file pins before the framework** — `tests/setup-node-env.cjs:13-21`:
   ```js
   // Runs via setupFiles: before the test framework and before any test module
   // loads, so every module built in these tests sees 'test'. …
   process.env.NODE_ENV = 'test';
   delete process.env.DU_ENVIRONMENT;
   delete process.env.APP_ENV;
   ```
4. **Direct effect probe (read-only `require`, ambient values hostile on purpose)** — REAL_EXIT=0:
   ```
   node -e "process.env.NODE_ENV='production'; process.env.DU_ENVIRONMENT='prod'; process.env.APP_ENV='prod'; require('./tests/setup-node-env.cjs'); console.log(JSON.stringify({NODE_ENV: process.env.NODE_ENV, DU_ENVIRONMENT: process.env.DU_ENVIRONMENT ?? null, APP_ENV: process.env.APP_ENV ?? null}))"
   → {"NODE_ENV":"test","DU_ENVIRONMENT":null,"APP_ENV":null}
   ```
5. **Behavioral proof that this is the cure for the 34 red tests**: the 4 suites (84 tests total, containing the previously-red 34) run **green under ambient `NODE_ENV=production`** (LỆNH 1), where — per the setup file’s own comment — production-only guards would otherwise fire (`src/main.ts:135`, `auth-dispatch.ts:120-130`, logger `environment:"prod"` stamp). The suite that intentionally needs production behaviour still passes (LỆNH 3: `v1-boot-typed-denial` 10/10 with explicit overrides, `tests/v1-boot-typed-denial.test.ts:268`).

## Literal outputs (verbatim)

### LỆNH 1 — 4 suites under ambient `NODE_ENV=production` — REAL_EXIT=0

```
Test Suites: 4 passed, 4 total
Tests:       84 passed, 84 total
Snapshots:   0 total
Time:        ...
Ran all test suites matching tests/admin-audit-mount.test.ts|tests/admin-audit-query.test.ts|tests/admin-error-boundary-offline.test.ts|tests/v1-boot-typed-denial.test.ts.
```

### LỆNH 2 — 4 suites, `NODE_ENV` unset — REAL_EXIT=0

```
Test Suites: 4 passed, 4 total
Tests:       84 passed, 84 total
Ran all test suites matching tests/admin-audit-mount.test.ts|tests/admin-audit-query.test.ts|tests/admin-error-boundary-offline.test.ts|tests/v1-boot-typed-denial.test.ts.
```

### LỆNH 3 — probe run (`NODE_ENV=production`, `DU_TEST_PROBE=1`) — REAL_EXIT=0

```
Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
Ran all test suites matching tests/v1-boot-typed-denial.test.ts.
```

### LỆNH 4 — regression — REAL_EXIT=0

```
Test Suites: 2 passed, 2 total
Tests:       99 passed, 99 total
Ran all test suites matching tests/admin-shell-session-lifecycle.test.ts|tests/rv01-loopback-http-offline.test.ts.
```

### LỆNH 5 — backend typecheck — REAL_EXIT=0

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
REAL_EXIT=0
(no output)
```

### LỆNH 6 — config contents (read-only; copies in raw)

- `jest.config.cjs` — 15 lines; `setupFiles: ['<rootDir>/tests/setup-node-env.cjs']` at `:10`; comment at `:7-9` states the unit config inherits it via spread.
- `tests/setup-node-env.cjs` — 21 lines; pins `process.env.NODE_ENV = 'test'` at `:17`, deletes `DU_ENVIRONMENT`/`APP_ENV` at `:20-21`; header documents the 34-test breakage and that it runs before the framework.
- `jest.unit.config.cjs` — 29 lines; `...base` at `:27`; live-suite ignore list at `:8-24` includes `'migrations\\.test\\.ts$'`.

## RED suites

**KHÔNG có.** All six runnable steps exited 0; no `FAIL`, no `✕`, no failing assertion. Case-insensitive scan of all raw files for `skipped|todo|FAIL |✕` → **0 hits**. Nothing was fixed, skipped or reclassified to make anything green.

## SKIPPED

- **None in the executed set** — every jest summary is `N passed, N total` with no `skipped` count.
- `tests/migrations.test.ts` is live-gated (excluded by `jest.unit.config.cjs` `testPathIgnorePatterns`) and was **not run and not counted as passed** (it was not in this task’s command list either).
- No live suite was run; no PostgreSQL/Redis started; no DB window claimed.

## Conclusion (honest)

The GROUP A fix is verified on the current disk: `setupFiles` → `tests/setup-node-env.cjs` is wired through the base config and inherited by `jest.unit.config.cjs` (`...base`), it pins `NODE_ENV=test` (and neutralizes `DU_ENVIRONMENT`/`APP_ENV`) before the test framework, and the 4 previously-broken offline suites are green **even under ambient `NODE_ENV=production`** (84/84). No regression observed in the two checked offline suites (99/99) and the backend typecheck is clean. This is offline jest/tsc evidence only — no live/browser verification; no gate (`VERIFIED`/`ACCEPTED`) ticked. No commit, no push.

## Raw evidence

`du-rework/coordination/reports/raw/verify-group-a-2026-10-09/A/` (files created by this verification):
- `01-red-baseline-prod-env.txt` (exit 0)
- `02-default-env.txt` (exit 0)
- `03-probe.txt` (exit 0)
- `04-regression.txt` (exit 0)
- `05-tsc.txt` (exit 0, no output)
- `06-setup-probe.txt` (exit 0)
- `07-jest.config.cjs.txt`, `08-setup-node-env.cjs.txt`, `09-jest.unit.config.cjs.txt` (read-only copies)

Note: the same directory also contains pre-existing `cmd1..cmd5*.log` artifacts from another session (not created by me). They are **not** used as evidence in this receipt and are not credited to this verification.
