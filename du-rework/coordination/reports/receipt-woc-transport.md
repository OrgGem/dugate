# WOC-05 RuntimeClient transport receipt

**Result:** Implemented and locally verified. Independent verification and live Runtime API E2E remain open.

**Run context:** 2026-10-12 15:00 Asia/Bangkok; `D:\Git\dugate\du-rework\orchestrator\packages\worker-sdk`; branch `codex/fix-workflow-builder`, baseline `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`; Node `v24.21.0`; pnpm `10.18.3`.

## Changes

- The request deadline now covers fetch, response-body reading, JSON parsing, and schema parsing. A deadline race bounds bodies that never settle even when the injected fetch/body implementation ignores abort. The internal timeout and caller abort listener are cleaned up after settlement; caller abort reasons are retained as error causes.
- HTTP status is handled before error-body parsing. Malformed or unreadable 401/403/409/410/429 responses retain their status; write 5xx responses become ambiguous without parsing HTML. Success-body read, JSON, or schema failures become `AmbiguousReportError` for writes that require reconciliation. Explicit replay-safe calls retain typed `TEMPORARY_UNAVAILABLE` errors and any known HTTP status.
- `RuntimeError.isRetryable` exposes retryability for transport/body failures even when a malformed success response carried HTTP 200. No credentials are included in generated error messages.
- Added focused tests for slow and hanging bodies, late rejection after timeout, body-read failure after simulated server commit, malformed JSON and schema-invalid ACKs, HTML 502, denial statuses, replay-safe claim ACK failure, GET status handling, and caller abort cleanup.

## Verification

All commands ran from `D:\Git\dugate\du-rework\orchestrator\packages\worker-sdk` with normal Jest/ts-jest diagnostics enabled.

- `pnpm test -- --runTestsByPath tests/woc-runtime-client.test.ts` — **PASS**, 1 suite, 14 tests passed, 0 failed.
- `pnpm lint` — **PASS**, `tsc --noEmit -p tsconfig.json`.

An earlier concurrent typecheck run failed at the SDK owner's `src/worker.ts:705:54` with TS2722. That edit was fixed by its owner; the subsequent package lint passed. Both logs are retained so the transient failure is visible.

Raw logs:

- `du-rework/coordination/reports/raw/woc-transport-jest-2026-10-12.txt`
- `du-rework/coordination/reports/raw/woc-transport-typecheck-after-sdkfix-2026-10-12.txt` — passing run
- `du-rework/coordination/reports/raw/woc-transport-typecheck-2026-10-12.txt` — transient TS2722 failure before the SDK owner's fix

No package build, deployment, or live Runtime API E2E was run. These results verify the source and focused package checks only; they do not establish deployed behavior. No contracts, shared auth keys, checkpoint keys, or grant keys were changed.
