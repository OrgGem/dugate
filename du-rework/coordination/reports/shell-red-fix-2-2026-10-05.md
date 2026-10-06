# SHELL-RED-FIX-2 — session lifecycle test repair (2026-10-05)

**Disposition: PASS.** Offline-only; no commit/stage/push. HEAD remains b088eececcb5f3df0b4edbe073a29401dafda624.

## Root causes and Δ

The §5 findings in shell-red-fix-2026-10-05.md are reproduced and resolved with a test-only change in services/orchestrator/tests/admin-shell-session-lifecycle.test.ts:

1. The unset-knobs case read ambient NODE_ENV. Its describe-level beforeEach now pins NODE_ENV=test while clearing the two DU_ADMIN cookie knobs; existing afterAll restores the saved environment. The same two-case control that previously failed under inherited production now passes with NODE_ENV=production.
2. The default sink case spied on console.warn, but the implementation is shell-server.ts calling logger.warn; @du/observability's default consoleSink.write emits a JSON record through process.stdout.write. The test now captures stdout, selects the structured security-event record, parses and checks the exact event, and checks the captured line for the sentinel. This retains the real listener/default sink path and changes no runtime default or source code. No additional seam was needed.

Before the edit, the two-case selection under NODE_ENV=test reproduced the default-sink failure (1 passed, 1 failed, 49 skipped; exit 1). After the edit, the selected pair passed both under NODE_ENV=test and under NODE_ENV=production (2 passed each; exit 0).

## Required regression runs

Cwd: services/orchestrator. Each run set NODE_ENV=test and executed:

    node node_modules/jest/bin/jest.js --config jest.unit.config.cjs --runInBand tests/admin-shell-session-lifecycle.test.ts tests/admin-shell-render.test.ts tests/admin-shell-auth.test.ts

| Round | Result | Exit | Raw log SHA-256 |
|---|---|---:|---|
| 1 | 3 suites / 103 passed | 0 | raw/verify-shell-red-fix-2-round1.txt — e70273d46c8e719f541ff0d4b5169e78d0b49677b324f2ee845f8feaa917f89b |
| 2 | 3 suites / 103 passed | 0 | raw/verify-shell-red-fix-2-round2.txt — c54b333b2aa329080d472e345408bcab946151058a3d9a997475df8b74057807 |
| 3 | 3 suites / 103 passed | 0 | raw/verify-shell-red-fix-2-round3.txt — 4a8747146d5b089f63524d3ba7362dd9684f0f111864c211fff4b746118e80d2 |

Baseline reproduction log: raw/shell-red-fix-2-baseline.txt, SHA-256 4d7fbd89eaa4b4c2ffa08fd4cd1248ee8dc75083a3ed9c97cc99a41fae811ed9.

## Scope

Only the session-lifecycle test was edited for this packet; no application source was changed. Test file SHA-256 after the edit: 13e2a19db36aa932d17cf59b41d6c843b69c9967c6d24b66d9b1197044067720. The default logger source inspected was packages/observability/src/logger.ts (SHA-256 eb8c98f8cbf6565329927a891496edd69962245fdb1d364ffa1a1d388b35cf89); shell-server.ts remains outside this packet's write set.

git diff --check found no whitespace errors; Git emitted a working-copy LF→CRLF warning for the dirty session-lifecycle test file. No line-ending normalization was applied.
