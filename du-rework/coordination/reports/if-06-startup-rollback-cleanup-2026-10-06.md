# IF-06-STARTUP-ROLLBACK-CLEANUP — receipt (qwen_1, 2026-10-06)

Fix for the two startup-rollback defects in
coordination/reports/verify-pm-m02-ingress-2026-10-06.md.
Lease: create-app.ts + directly affected tests. No commit, no tick, no Compose.

## Defects as reported

1. Internal listener bind failure left the PUBLIC socket open
   (publicListening=true, internalListening=false).
2. Admin shell remount failure left BOTH sockets open
   (publicListening=true, internalListening=true).

Both trace to one shape: listen() bound public, then internal, then remounted
the shell, with no rollback if any step threw.

## The fix (src/app/bootstrap/create-app.ts, listen())

Both binds plus the shell remount are now inside one try/catch. The catch:

  for (const candidate of [server, internalServer]) {
    candidate.closeAllConnections();
    if (candidate.listening) await new Promise((r) => candidate.close(() => r()));
  }
  await adminShell.handle.close().catch(() => undefined);
  throw startupError;

- The listening guard makes the never-listened and partially-listened cases
  correct: the listener that never bound is skipped, the one that did is closed.
- closeAllConnections() first, so a held-open keep-alive socket cannot stall the
  rollback (the same trick close() already uses).
- The ORIGINAL error is rethrown, never a cleanup error.
- The shell handle is closed too, so a failed remount leaves no half-mounted shell.

Expected state after either failure: publicListening=false, internalListening=false.

## Verification — what actually ran

| check | result |
|---|---|
| npx tsc --noEmit -p tsconfig.json | no output, exit 0 |
| tests/pm-m02-ingress-fence.test.ts | PASS |
| tests/p745-connector-boot-composition.test.ts | PASS |
| tests/crx02-rfx05res-s3-read-guard.test.ts | PASS |
| tests/webhook-error-boundaries.boundary.test.ts | PASS |
| combined | 4 passed, 1 skipped, exit 0; 45 passed, 14 skipped |

## tests/pm-m02-ingress-verification.test.ts — 8/8 NOT run, honestly

The suite is hard-gated by its own harness, line 37:

  const ENABLE_PM_M02 = process.env.DU_PM_M02_INGRESS_VERIFY === "1";
  if (ENABLE_PM_M02 && !LIVE_INFRA) throw ... requires DU_LIVE_INFRA=1 as well
  const RUN_LIVE = LIVE_INFRA && ENABLE_PM_M02;

With neither variable set the run reports: Test Suites: 1 skipped, 0 of 1;
Tests: 8 skipped, 8 total — SKIPPED, not passed.

Command to turn this fix into 8/8 evidence, inside an approved live window
(PG + Redis):

  set DU_LIVE_INFRA=1 && set DU_PM_M02_INGRESS_VERIFY=1
  npx jest tests/pm-m02-ingress-verification.test.ts

I did NOT open that window here (live DB/Redis is not authorized by this
packet) and I did not run the harness with mocks to manufacture an 8/8.

## What remains open

The runtime rollback contract (false/false after a failed bind or remount) is
type-checked and code-reviewed but NOT runtime-proven until that live suite runs.
Offline proof would need the live harness or an in-process double-bind test.

No commit, no tick, no Compose edit.
