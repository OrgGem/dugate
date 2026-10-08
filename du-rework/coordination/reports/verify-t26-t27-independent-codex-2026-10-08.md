# Independent verification — WFA-T26 / WFA-T27 — 2026-10-08

Scope: `du-rework`. Node `v24.21.0`, executable `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`. No source/test/product edits, reverts, commits, pushes, gate ticks, or edits to `docs/21-openapi.json` were made. Each focused E2E command was run once; no retry-to-green.

## Focused independent runs

| Check | CWD | Command | Start UTC | Exit / observed result |
|---|---|---|---|---|
| T26 | `D:\Git\dugate\du-rework` | `& "C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe" tests/workflow-api/run-jest.cjs verify-t26-independent-codex-node24-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts -t "recovers an expired lease without repeating the completed provider stage"` | `2026-10-08T01:52:55.4157771+00:00` | **0** — `Test Suites: 1 passed, 1 total`; `Tests: 14 skipped, 1 passed, 15 total`. |
| T27 | `D:\Git\dugate\du-rework` | `& "C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe" tests/workflow-api/run-jest.cjs verify-t27-independent-codex-node24-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts -t WFA-T27` | `2026-10-08T01:53:11.3097369+00:00` | **0** — `Test Suites: 1 passed, 1 total`; `Tests: 14 skipped, 1 passed, 15 total`. |

Both independent results were green and match the requested exit-0 expectation. Runner logs were written to `tests/workflow-api/logs/verify-t26-independent-codex-node24-2026-10-08.log` and `tests/workflow-api/logs/verify-t27-independent-codex-node24-2026-10-08.log`.

## Attribution A — receipt only

Read `coordination/reports/wfa-t27-attribution-2026-10-08.md` §2. Its A/B receipt reports:

- A (T26 fix remains in worker SDK dist; T27 `failTask` change reverted for that controlled run): exit **1**, expected `CANCELLED` but received `FAILED` at `http-worker.integration.test.ts:1245`; provider-abort assertion at `:1243` passed.
- B (T27 change restored byte-for-byte): exit **0**, WFA-T27 passed.

This verification did not perform either attribution mutation or reversion; A is recorded from the existing receipt only.

## Receipts read

- `coordination/reports/wfa-t26-lease-recovery-2026-10-08.md`
- `coordination/reports/wfa-t27-cancel-state-2026-10-08.md`
- `coordination/reports/wfa-t27-attribution-2026-10-08.md`
