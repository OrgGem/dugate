# Independent Verification Receipt — WT-02, WT-04, WT-03, WT-05, WT-08, WT-09 (du-rework)

- **Date:** 2026-10-07
- **Verifier:** DeepSeek (dsh) — independent tester/verifier role (per `coordination/COORDINATOR-CONTRACT.md`: DeepSeek may be worker/verifier with disjoint scope, never a second dispatcher)
- **Repo scope:** `du-rework` ONLY (legacy root untouched)
- **Mode:** Independent re-execution of the test suites; no worker receipt reused as evidence
- **Code freeze:** NO commit, NO push, NO stage performed. This report file is the only write.

## Environment

| Item | Value |
|---|---|
| OS / Shell | Windows / PowerShell (pwsh) |
| Node | v22.23.3 |
| Python | system `python` (tools/openapi/validate_openapi.py) |
| Git HEAD | `4308cc5` (branch `codex/fix-workflow-builder`) |
| Working tree at start | dirty, 298 entries (58 modified, 240 untracked) — pre-existing shared state |
| Working tree delta by this run | +1 file: this report only |

## Test runs — command / cwd / exit code / verdict

### 1. WT-02 + WT-04 — Read DTO & Portal invalid clear

- **cwd:** `du-rework/services/orchestrator`
- **command:** `node node_modules/jest/bin/jest.js --runInBand tests/tapi01-closure-offline.test.ts tests/wt04-profile-invalid-callback-read.test.ts`
- **exit code:** `0`
- **result:** Test Suites: **2 passed, 2 total** · Tests: **16 passed, 16 total**, 0 failed, 0 skipped

### 2. WT-03 — Write boundary & Retry carry-forward

- **cwd:** `du-rework/services/orchestrator`
- **command:** `node node_modules/jest/bin/jest.js --runInBand tests/cb02b-profile-publish-callback.test.ts tests/cb02c-retry-callback-pin.test.ts tests/cb02-admission-writer.test.ts`
- **exit code:** `0`
- **result:** Test Suites: **3 passed, 3 total** · Tests: **18 passed, 18 total**, 0 failed, 0 skipped

### 3. WT-05 / WT-08 / WT-09 — dynamic migrations

- **cwd:** `du-rework/services/orchestrator`
- **command:** `node node_modules/jest/bin/jest.js --runInBand tests/migration-verify-trap-fix.test.ts tests/migration-0032-rollback.test.ts`
- **exit code:** `0`
- **result:** Test Suites: **2 passed, 2 total** · Tests: **14 passed, 14 total**, 0 failed, 0 skipped

### 4. WT-05 / WT-08 / WT-09 — OpenAPI validator

- **cwd:** `du-rework`
- **command:** `python tools/openapi/validate_openapi.py`
- **exit code:** `0`
- **result:**
  - `paths=58 x-absent=9`
  - `SC-CB-CANONICAL-SCHEMAS-VALIDATED count=37 refs=resolved operationIds=unique`
  - 23 × `PASS <SchemaName>` (SubmissionSchema … EncryptionPersistence included)
  - terminator `OPENAPI-EXAMPLES-VALIDATED`
  - no FAIL line emitted

### 5. Contracts suite

- **cwd:** `du-rework/packages/contracts`
- **command:** `node node_modules/jest/bin/jest.js --runInBand --silent`
- **exit code:** `0`
- **result:** Test Suites: **30 passed, 30 total** · Tests: **568 passed, 568 total**, 0 failed, 0 skipped

## Totals (this receipt)

| Metric | Count |
|---|---|
| Jest suites run | 37 (2 + 3 + 2 + 30) |
| Jest tests passed | **616** (16 + 18 + 14 + 568) |
| Jest tests failed | **0** |
| Jest tests skipped | **0** |
| Non-Jest validators run | 1 (openapi validator) — PASS |
| Non-zero exit codes | **0** |

## Integrity assertions

1. **Independence:** All commands were executed by the verifier in this session against the current tree at HEAD `4308cc5`; results were not copied from codex_arch/qwen_2 receipts. Owner smoke ≠ this receipt; this is the independent `VFY` step.
2. **Functional verdict, not just exit code:** Per contract ("exit 0 can mean a harness completed while requests failed"), each run's summary was inspected: failed = 0, skipped = 0 in every suite; the OpenAPI validator's explicit `PASS` lines and terminator `OPENAPI-EXAMPLES-VALIDATED` were read, with no `FAIL` output.
3. **No scope violation:** Commands ran only under `du-rework/` (`services/orchestrator`, `packages/contracts`, repo root). Legacy root was not executed or modified.
4. **No code mutation:** The verifier wrote no product code, tests, migrations, configs, manifests or lockfiles. Only `coordination/reports/vfy-wt02-wt09-independent-check-2026-10-07.md` was created.
5. **Code freeze respected:** No `git add`, `git commit`, `git push`, `git stash`, `git reset` was executed. The 298 pre-existing dirty entries are preserved untouched for their owners.
6. **Environment note (cosmetic):** PowerShell printed `NativeCommandError` wrappers because jest writes its progress to stderr; the captured summaries and `EXITCODE=0` confirm all runs succeeded. `GIT_CONFIG_*` env vars in the shell were malformed (`COUNT=2` with missing `KEY_0/KEY_1`); git was read with `GIT_CONFIG_COUNT=0` override for status inspection only — read-only, no config file changed.

## Status & limits

- **State for WT-02, WT-03, WT-04, WT-05, WT-08, WT-09:** `VERIFIED` (independent offline unit/contract + validator suites PASS on current code).
- **Not claimed:** `ACCEPTED` — requires the standing reviewer verdict (Claude Code `APPROVED` / required UI gates) per `du-rework/AGENTS.md`; this receipt does not substitute it.
- **Not covered:** live DB/Redis/browser/deployment gates were not part of this dispatch; skipped tests = 0 within the suites run, but absence of a suite is not evidence for it.
