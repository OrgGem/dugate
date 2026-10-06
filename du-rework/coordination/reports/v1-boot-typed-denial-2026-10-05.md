# V1 boot warning and typed cipher denial — 2026-10-05

**Dispatch:** `task_0d4dd38898e6` / `ctx_fed17b86169b` · **Verified:** 2026-10-05 04:55 ICT · **cwd:** `D:\Git\dugate\du-rework` · **commit:** none.

## Decision applied

Applied option (b) from `v1-boot-denial-decision-2026-10-05.md`: the process remains bootable without the profile cipher key, configured-cipher consumption fails closed with a typed permanent denial, and `main.ts` emits one warning for that boot when both `ENCRYPTION_KEY` and `NEXTAUTH_SECRET` are absent.

The decision record explicitly keeps `file-url-auth.ts`'s shared helper contract unchanged and places the exception conversion at the resolver boundary. In `acquisition-ref-resolver.ts`, a throw from `decryptFileUrlAuthConfig()` now becomes `SourceAuthDeniedError(500, 'AUTH_DECRYPT_FAILED', 'stored auth cipher could not be decrypted with this deployment key')`; the existing `null` denial path keeps the same code and message. `AUTH_DECRYPT_FAILED` was already in `SourceAuthDenialCode` and `PERMANENT_CODES`; both lists and their mapping were left unchanged. The boot warning names configured-cipher acquisition as the affected consumer and directs operators to either supported key.

## Verification

Tests are offline: resolver/consumer use scripted DB adapters, and the boot test mocks `createApp`, OIDC, Vault boot options, and shutdown. The boot case observes `createApp()` and `listen()` completing and exactly one warning; no PostgreSQL, Redis, Vault, or external provider was used.

| Command | Result |
|---|---|
| `pnpm --filter @du/orchestrator exec jest --runInBand tests/v1-boot-typed-denial.test.ts tests/p730-acquire-ref-resolver.test.ts tests/p730-acquire-consumer-auth.test.ts tests/aweb02b-tenant-token-env.test.ts` | PASS ×3, 4 suites / 40 tests per run (120 total test executions), exit 0 each run |
| `pnpm --filter @du/orchestrator typecheck` | PASS, exit 0 |

Raw command output: `coordination/reports/raw/v1-boot-typed-denial-2026-10-05.txt`.

The new suite asserts: missing key plus an actual cipher shape yields `SourceAuthDeniedError`, `typedSourceAuthDenial === true`, code/status and the existing secret-free message; this error travels through the consumer and produces `AUTH_DECRYPT_FAILED` terminal failure with zero retries and no fetch; a supported key decrypts normally; tampered ciphertext with a valid key remains denied; and boot proceeds with one warning only when both keys are absent.

## Scope and handoff

Changed for this task: `services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts`, `services/orchestrator/src/main.ts`, and the new `services/orchestrator/tests/v1-boot-typed-denial.test.ts`. `main.ts` already had unrelated local edits at task start; this change only exports `main()` for the mocked boot test and adds the warning block. `file-url-auth.ts` was deliberately not changed per the decision record; `runtime.ts`, `metadata-crypto.ts`, and migration `0032` were present as pre-existing dirty paths at task start and were not touched. No commit or coordinator tick was made.

The offline boot proof uses a mocked app/listener, so a real database/Redis startup remains a separate environment-level check; this dispatch did not run a live boot.
