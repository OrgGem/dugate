# FIX MED-1 — migration ledger validates DB objects (fail closed) — 2026-10-08

**Status: COMPLETE.** Implementation lane for MED-1 (WFA section 8 security
review).

- **Worker**: oc_3 (OpenCode)
- **Mode**: fix lane — NO commit, NO git add, NO push, NO VERIFIED/ACCEPTED
  tick, no WFA plan edit, no `docs/21-openapi.json` edit, **no live DB / no DB
  window claimed**.
- **Lease honored**: only `src/db/migrations.ts` (modified) + new test file
  `tests/med1-migration-ledger-object-drift.test.ts` (created).
  `src/app/bootstrap/create-app.ts` was **not needed and is unchanged** (the
  throw propagates through the existing boot `try/catch`, create-app.ts:305-309).

## Finding (verbatim from `wfa-section8-security-review-2026-10-08.md`)

> MED - migration ledger doesn't validate DB objects: src/db/migrations.ts:111-129,139-215;
> src/app/bootstrap/create-app.ts:271-280;
> migrations/0037_legacy_workflow_schema_catalog.sql:4-20. migrate() skips
> already-recorded sequences; 0037 uses CREATE TABLE/INDEX IF NOT EXISTS. If an
> object is dropped while its ledger row remains, autoMigrate skips it and
> verifyMigrations still passes -> boots against an incomplete schema instead of
> failing closed. Fresh isolated provisioning passed; no object-drift test found.

**MỤC TÍCH**: object (table/index) dropped while its ledger row remains →
`migrate()` must FAIL CLOSED (throw) instead of skipping.

## Decision + rationale

1. **Fix lands in `migrate()`** — the MỤC TÍCH target and the `autoMigrate`
   boot path. Before skipping recorded sequences, `migrate()` now parses each
   recorded file's declared tables/indexes and probes the catalog; any missing
   object aborts the run **before** any pending migration is applied.
2. **`verifyMigrations` intentionally unchanged.** (a) MỤC TÍCH names
   `migrate()`; (b) `tests/migration-0032-rollback.test.ts:143-158` explicitly
   pins verify's files-vs-ledger semantics ("verify never inspects the real
   columns") and that file is outside my lease; (c) the verify fakes in
   `migration-verify-trap-fix.test.ts` / `migrations-ledger-guard.test.ts`
   throw on any unknown SQL, so a new probe there would break pinned tests I
   must not edit. **Residual (stated honestly):** a verify-only boot
   (`autoMigrate=false`) still cannot see a dropped object; the production
   order `npm run migrate` (now fail-closed) → `npm start` catches the drift
   at migrate time. Whether verify should gain the probe is a follow-up
   decision for the owner.
3. **Object coverage**: `CREATE [UNIQUE] [TABLE|INDEX] [CONCURRENTLY]
   [IF NOT EXISTS] <name>` per statement line; `--` comments stripped (0019
   carries commented-out DDL). Column-level drift is deliberately out of
   scope (see 0032 pin above).
4. **Probe**: one read-only query per declared object —
   `information_schema.tables` (tables) OR `pg_indexes` (indexes), scoped to
   `current_schema()`; runs on `db.query` (no transaction, no writes).
5. **Failure message** names every drifted file + missing object(s) and gives
   the repair hint (`DELETE FROM schema_migrations WHERE sequence IN (…)`).

## Changes (file:line)

| Location | Change |
|---|---|
| `src/db/migrations.ts:112-124` | `declaredSchemaObjects()` — table/index extractor |
| `src/db/migrations.ts:127-138` | `schemaObjectExists()` — read-only catalog probe |
| `src/db/migrations.ts:141-166` | `recordedMigrationsMissingObjects()` — drift scan |
| `src/db/migrations.ts:186-206` | `migrate()` — drift check + fail-closed throw, before the pending loop |

`src/db/migrations.ts` SHA256: `D618ADABC3FB66BF14473C9F9C6D2A871CBD185D1A2CDC33F7ADAB2C1BDFF0F6`

## Test (new file)

`tests/med1-migration-ledger-object-drift.test.ts` SHA256:
`151B2D10244F65A5DF512205E321A2D60E553A74D237E63099AFA2E20B18B755`

Offline (scripted `Db`: ledger + present-object catalog; no PostgreSQL). The
object extractor in the test is **local/independent** of the implementation.

10 tests: (1) healthy fully-migrated schema resolves, applies nothing;
(2) dropped TABLE `legacy_workflow_schemas` (0037) throws instead of skipping;
(3) dropped INDEX `legacy_workflow_schemas_one_active` detected and named;
(4) drift in two migrations (0001 + 0037) reported together; (5) fail-closed
BEFORE pending application — no ledger write, no DDL; (6) a pending migration
is not falsely flagged; (7) exhaustive — dropping ANY declared object of ANY
shipped migration is detected; (8) extractor pin 0037 = table + 2 indexes;
(9) extractor pin 0001 core tables; (10) commented-out DDL in 0019 not a
declaration.

Honest note: after the first green attempt, **two harness bugs in my own test
fake** were corrected — (a) object materialisation parsed normalised SQL
(newlines collapsed), (b) an over-strict precondition on ALTER-only migrations
that declare no table/index. Neither touched the core RED assertions (the RED
failures below are unaffected).

## Commands / exit codes / literal results (cwd `orchestrator/services/orchestrator`)

| # | Command | Exit | Literal |
|---|---|---|---|
| RED | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts` | **1** | `Test Suites: 1 failed, 1 total` / `Tests: 5 failed, 5 passed, 10 total` |
| GREEN | same command | **0** | `Test Suites: 1 passed, 1 total` / `Tests: 10 passed, 10 total` |
| tsc | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | 0-byte log (no diagnostics) |
| collateral | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/migration-0032-rollback.test.ts tests/migrations-ledger-guard.test.ts tests/migration-verify-trap-fix.test.ts tests/rfx10-seed-gate.test.ts tests/webhook-error-boundaries.boundary.test.ts` | **0** | `Test Suites: 5 passed, 5 total` / `Tests: 69 passed, 69 total` |
| importer sweep | same runner, `--runTestsByPath` over the 11 remaining offline `db/migrations` importers (credworkflow, crx01 ×2, crx02, encmeta-resultref, enc-meta-sentinel-outbox, enc-meta-sentinel-runtime-refs, p730, p745, rcr-http, sec-enc-05) | **1** | `Test Suites: 1 failed, 10 passed, 11 total` / `Tests: 1 failed, 53 passed, 54 total` — the single failure is **pre-existing, not MED-1** (below) |

Raw logs (`coordination/reports/raw/fix-section8-med1/`): `red-1-before-fix.log`,
`green-1-after-fix.log`, `green-2-after-fix.log`, `tsc-after.log`,
`collateral-suites.log`, `importers-offline-sweep.log`,
`enc-meta-sentinel-isolated.log` (all `*.log`, gitignored).

**Sweep failure classification (honest record):**
`tests/enc-meta-sentinel-runtime-refs.test.ts` fails with `HttpError: operation
not found` at `runtime.ts:1462` — identically **in isolation** (`1 failed, 9
passed`, exit 1). It is not on this change's path: it boots with
`autoMigrate:false` (verify path, untouched), imports only `loadMigrationFiles`
(line 38) and never calls `migrate()`; its scripted ledger is built from the
files (line 253). The same suite was already recorded failing in the earlier
VERIFY-2 full offline run (`verify2-f1-oc-2026-10-08.md`).

## RED evidence (fail-first, before the fix)

`red-1-before-fix.log` — **5 failed / 5 passed, exit 1**, failures are the bug:

- dropped TABLE: `Received promise resolved instead of rejected` →
  `Resolved to value: {"applied": []}` (silent skip).
- dropped INDEX: same shape.
- drift in two migrations: `migrate() resolved against a drifted schema`.
- fail-closed BEFORE pending: `Resolved to value: {"applied":
  ["0037_legacy_workflow_schema_catalog.sql"]}` — it even applied the pending
  migration over the drift.
- exhaustive: first dropped object not detected → resolved.

## Residuals / notes

- `verifyMigrations` unchanged (reasons above); verify-only boots remain blind
  to object drift until the owner decides to revisit the 0032 pin.
- Pre-existing red `enc-meta-sentinel-runtime-refs.test.ts` (see sweep
  classification above) remains open and untouched.
- No live DB was run and no DB window is claimed; the probe uses standard
  catalog views (`information_schema.tables`, `pg_indexes`) and will be
  exercised by the live-gated suites (`tests/migrations.test.ts` etc.) in a
  future DB window.
- Cost: ~1 catalog probe per declared object of recorded migrations per
  `migrate()` call (~60 probes on the full 37-file set) — boot-time only.

## Gate confirmation

No commit / no git add / no push / no VERIFIED or ACCEPTED tick / no WFA plan
file edit / no live DB claim. `docs/21-openapi.json` untouched. Only the two
lease files above were written in the repo (plus this receipt and the raw logs).
