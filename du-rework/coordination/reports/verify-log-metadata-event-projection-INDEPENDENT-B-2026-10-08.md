# Independent verification — log-metadata event projection (emission B)

Date: 2026-10-08
Scope: `du-rework` only. Read-only verification; offline. No PostgreSQL/Redis started and no DB window claimed.

NOTE: this receipt was originally written by the Codex verifier (term_ca784044) to the `-A-` filename, then overwritten by the OC verifier (term_f1c5a1d1). The coordinator preserved the Codex content verbatim under the `-B-` filename so both independent receipts remain on disk. Content below is the literal file the Codex verifier wrote (read by the coordinator before the overwrite).

Runtime was checked before running the test commands:

| cwd | Command | Exit code | Literal output |
|---|---|---:|---|
| `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node -v` | 0 | `v22.16.0` |

## Required commands

| # | cwd | Exact command | Exit code | Literal test/compiler result |
|---:|---|---|---:|---|
| 1 | `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts` | 0 | `Test Suites: 1 passed, 1 total`<br>`Tests: 51 passed, 51 total` |
| 2 | `D:/Git/dugate/du-rework/orchestrator/packages/observability` | `node node_modules/jest/bin/jest.js --runInBand tests/payload-privacy.test.ts` | 0 | `Test Suites: 1 passed, 1 total`<br>`Tests: 8 passed, 8 total` |
| 3 | `D:/Git/dugate/du-rework/orchestrator/packages/observability` | `node node_modules/jest/bin/jest.js --runInBand tests/observability.test.ts` | 0 | `Test Suites: 1 passed, 1 total`<br>`Tests: 23 passed, 23 total` |
| 4 | `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | Empty output; typecheck completed without diagnostics. |
| 5 | `D:/Git/dugate/du-rework/orchestrator/packages/observability` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | Empty output; typecheck completed without diagnostics. |

Command 2 ran from the observability package directory and used its package-default Jest configuration (`jest.config.cjs`); no alternate config was needed. The package directory was the working directory again for command 3.

## RED and skipped tests

- RED: none. The three requested Jest suites all exited `0`.
- Skipped: none reported. The requested Jest summaries show 51/51, 8/8, and 23/23 tests passed (82 total); no live suite was run.

One backend typecheck result-capture wrapper raised `ReferenceError: TextEncoder is not defined` after `exec_command` had returned, so that attempt did not surface its exit code in the transcript. The exact backend `tsc` command was run once more without the wrapper; its recorded exit was `0` with empty output, as listed in row 4. This was a result-reporting issue, not a compiler diagnostic or test failure.

## Conclusion

All requested offline suites and both typechecks passed in the captured runs. No source, test, or config file was modified. No `.env.live` file was read. No commit, staging, push, or gate change was performed.
