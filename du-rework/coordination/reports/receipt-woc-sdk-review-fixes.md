# WOC SDK same-instance single-flight repair receipt

Date: 2026-10-12 16:20 ICT  
Owner: `/root/woc_sdk`  
Workspace: `D:\Git\dugate\du-rework`  
Command cwd: `D:\Git\dugate\du-rework\orchestrator`

## Delivered

- Added a per-worker task reservation keyed by `taskId`, acquired synchronously before the first claim and held through user-handler settlement and report handling.
- A concurrent duplicate task delivery is moved to bounded, jittered delayed recovery through the delivery hook. If an injected consumer has no delay hook, the delivery rejects as recoverable rather than resolving successfully.
- The reservation remains held after context abort, shutdown, or lease expiry while an uncooperative user handler promise is still pending. It is released only when the full delivery processing promise settles. Different task IDs continue to progress concurrently.
- Lost claim ACK handling still releases a deferred delivery for retry; the regression confirms the retry can claim and run once. Shutdown coverage now also verifies that a duplicate remains deferred while the original handler is still unsettled.

## Files changed

- `packages/worker-sdk/src/worker.ts`
- `packages/worker-sdk/tests/woc-sdk-worker.test.ts`

The focused tests cover concurrent duplicate deliveries with a blocked handler, simultaneous progress for another task, a lost claim ACK followed by a single successful retry, duplicate deferral after lease expiry while an uncooperative handler remains pending, reservation release after settlement, and duplicate deferral during shutdown. No contract, backend, auth/configuration, or transport edits were made.

## Verification

- `pnpm --filter @du/worker-sdk lint` — PASS, `tsc --noEmit -p tsconfig.json`, exit 0. Raw log: `du-rework/coordination/reports/raw/woc-sdk-review-fixes-typecheck-2026-10-12.txt`.
- `pnpm exec jest --runInBand --runTestsByPath tests/woc-sdk-worker.test.ts` from `orchestrator/packages/worker-sdk` — PASS, 1 suite / 16 tests, 0 failed. Raw log: `du-rework/coordination/reports/raw/woc-sdk-review-fixes-focused-jest-2026-10-12.txt`.

No full package test, production build, Redis/PostgreSQL E2E, deployment, commit, or push was performed for this packet.

## SHA-256

```text
C32C2C0D2B98D6C38D8059034BE1DD85C68B45FF137EA18F6CE136A060DFE2D8  packages/worker-sdk/src/worker.ts
2BBEF91470EA5CE982AF4CF247A44ACA29A7268F30FDD2B23F99CF76997DEA0C  packages/worker-sdk/tests/woc-sdk-worker.test.ts
```
