# Receipt SEC-OR-20261011-04

## Implementation

- `packages/egress/src/pinned-fetch.ts` now returns a `Response` with a null body for status 204, 205, 304, and every HEAD request.
- Bodyless incoming responses are drained with `resume()` and have a stream error handler. Response conversion and redirect adjudication failures destroy the incoming response and client request, then reject the returned Promise.
- The `ClientRequest` response callback is guarded by try/catch. The asynchronous redirect adjudication path also has a rejection handler, preventing callback failures from escaping as process-level exceptions.
- Added an offline loopback regression covering 204, 205, 304, and HEAD response bodies.

## Verification

- Command: `pnpm --dir orchestrator/packages/egress test`
- Result: PASS, 3 suites, 35 tests, 0 snapshots.

## Scope

- Task files: `orchestrator/packages/egress/src/pinned-fetch.ts` and `orchestrator/packages/egress/tests/egress-boundaries.boundary.test.ts`.
- No files were staged, committed, pushed, or used to update a gate.
