# VERIFY-OC (independent) — RV01 cursor fence + MED1 migration ledger — 2026-10-09

- Verifier: OpenCode (`oc_4`). **Read-only**: no source/test/config edits, no commit/add/push, no gate tick, no `docs/21-openapi.json` edit, no `.env.live` read, offline (no PostgreSQL/Redis started, no DB window claimed). Scope: `du-rework` only.
- Tree: HEAD `72e225a`, working tree dirty.
- Runtime (recorded before running): **`node -v` = `v22.16.0`** (`where node` → `C:\nvm4w\nodejs\node.exe`).
- CWD for all commands: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.
- Each command ran in its own process; `REAL_EXIT` captured immediately after (no pipe through `tail`).

## Command matrix (literal)

| # | Command | REAL_EXIT | Literal `Test Suites:` / `Tests:` |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 48 passed, 48 total` |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts tests/med1-verify-migrations-object-drift.test.ts` | **0** | `Test Suites: 2 passed, 2 total` · `Tests: 13 passed, 13 total` |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/migrations.test.ts tests/migrations-ledger-guard.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 17 passed, 17 total` — **only `migrations-ledger-guard.test.ts` executed**; `migrations.test.ts` is live-excluded (see SKIPPED) |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/bypass-fix-810.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 13 passed, 13 total` |
| 5 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/gate-authenticate-808.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 8 passed, 8 total` (offline file only; no pg16 live run) |
| 6 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | no output (clean) |

Total executed: **6 jest suites / 99 tests passed** + clean backend typecheck. Every `REAL_EXIT=0`.

## Literal outputs (verbatim)

### LỆNH 1 — RV01 cursor fence — REAL_EXIT=0

```
Test Suites: 1 passed, 1 total
Tests:       48 passed, 48 total
Snapshots:   0 total
Time:        5.554 s
Ran all test suites matching tests/rv01-loopback-http-offline.test.ts.
```

### LỆNH 2 — MED1 object drift — REAL_EXIT=0

```
Test Suites: 2 passed, 2 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        2.898 s
Ran all test suites matching tests/med1-migration-ledger-object-drift.test.ts|tests/med1-verify-migrations-object-drift.test.ts.
```

### LỆNH 3 — migrations + ledger guard — REAL_EXIT=0

```
Test Suites: 1 passed, 1 total
Tests:       17 passed, 17 total
Snapshots:   0 total
Time:        1.341 s
Ran all test suites matching tests/migrations.test.ts|tests/migrations-ledger-guard.test.ts.
```

Which file actually ran (diagnostic, no test executed):

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/jest/bin/jest.js --config jest.unit.config.cjs --listTests tests/migrations.test.ts tests/migrations-ledger-guard.test.ts
REAL_EXIT=0
D:\Git\dugate\du-rework\orchestrator\services\orchestrator\tests\migrations-ledger-guard.test.ts
```

⇒ `migrations.test.ts` is excluded by `jest.unit.config.cjs` (`'migrations\\.test\\.ts$'` in the live-suite ignore list); the 17 passing tests are `migrations-ledger-guard.test.ts`.

### LỆNH 4 — bypass-fix-810 — REAL_EXIT=0

```
Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        1.089 s
Ran all test suites matching tests/bypass-fix-810.test.ts.
```

### LỆNH 5 — gate-authenticate-808 — REAL_EXIT=0

```
Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
Snapshots:   0 total
Time:        0.856 s
Ran all test suites matching tests/gate-authenticate-808.test.ts.
```

### LỆNH 6 — backend typecheck — REAL_EXIT=0

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
REAL_EXIT=0
(no output)
```

## RED suites

**KHÔNG có.** No `FAIL`, no `✕`, no failing assertion in any of the six runs. Case-insensitive scan of all raw logs for `skipped|todo|FAIL |✕` → **0 hits in every file**. Nothing was fixed, skipped or reclassified to make anything green.

## SKIPPED

- **`tests/migrations.test.ts` — LIVE-GATED / excluded, NOT executed and NOT counted as passed.** It is listed in `jest.unit.config.cjs`'s live-suite ignore list; the `--listTests` diagnostic above proves only `migrations-ledger-guard.test.ts` would run. Skipped ≠ passed.
- **No live suite was run.** `gate-authenticate-808.test.ts` executed the offline file only (8/8); no pg16 live path was exercised and no DB window is claimed.
- No other skip in the executed set (all summaries are `N passed, N total` with no `skipped` count).

## Conclusion (honest)

Both changes verify green on the current disk, offline: the RV01 cursor-fence suite passes 48/48, the two MED1 object-drift suites pass 13/13, the migrations ledger guard passes 17/17, bypass-fix-810 passes 13/13, gate-authenticate-808 passes 8/8 (offline file only), and the backend typecheck is clean. One requested file (`migrations.test.ts`) is live-gated and was **not** executed — it remains unverified here by design. This is offline jest/tsc evidence only; no live/browser verification, no DB window; no gate (`VERIFIED`/`ACCEPTED`) was ticked. No commit, no push.

## Raw evidence

`du-rework/coordination/reports/raw/verify-rv01-med1-2026-10-09/`:
- `01-rv01.txt` (exit 0)
- `02-med1.txt` (exit 0)
- `03-migrations.txt` (exit 0) + `03b-listtests.txt` (exit 0)
- `04-bypass-810.txt` (exit 0)
- `05-gate-808.txt` (exit 0)
- `06-tsc.txt` (exit 0, no output)
