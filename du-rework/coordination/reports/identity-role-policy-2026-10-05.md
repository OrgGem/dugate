# Identity local-user role policy — 2026-10-05

## Finding and current call path

`services/orchestrator/src/modules/auth/admin-local/repository.ts` contained the local-user insert in `createAdmin()`, with SQL literal role `'admin'`. A repository-wide call-site search found only `services/orchestrator/src/migrations-local-users-cli.ts` calling that method (`create-admin`); there is no registered HTTP identity route in this checkout. The CLI path remains the bootstrap-only administrator creator.

## Change

Added `createUser()` to the local-user repository. It accepts the requested role from the request flow and receives caller role separately in a server-authenticated creation context, so request JSON cannot supply it by forwarding the request object. Both are validated before any database/audit side effect; upward assignments fail with `ROLE_ESCALATION_DENIED`, roles outside `ADMIN | USER | VIEWER` fail with `INVALID_ROLE`, and an invalid server caller role fails with `INVALID_CALLER_ROLE`.

The assignment order is `ADMIN > USER > VIEWER`, so an ADMIN can create any allowed role, a USER can create USER or VIEWER, and a VIEWER can create only VIEWER. Storage uses the existing auth roles: `ADMIN → admin`, `USER → operator`, and `VIEWER → viewer`. The role is bound as an SQL parameter. The bootstrap CLI continues to use `createAdmin()`; request handlers must use `createUser()` and derive `callerRole` only from server auth state. No UI or route-registration files were changed.

## Verification

Environment: offline fake `Db` test; no PostgreSQL, Redis, Vault, S3, or provider connection. No commit was created.

| Command | Result |
|---|---|
| `pnpm --filter @du/orchestrator exec jest --runInBand tests/admin-local-user-role-policy.test.ts` | PASS on initial and post-signature-change runs, each 1 suite / 5 tests, exit 0 |
| `pnpm --filter @du/orchestrator typecheck` | PASS, exit 0 |
| `pnpm --filter @du/orchestrator exec jest --runInBand tests/admin-local-user-repository.test.ts` | 7 passed / 3 failed, exit 1; see note below |
| `git diff --check -- services/orchestrator/src/modules/auth/admin-local/repository.ts` | PASS; Git printed its existing LF→CRLF working-copy warning |

The existing repository suite failures are its audit parameter-position expectations at lines 179, 240, and 273. The shared worktree already contains an unowned diff in `services/orchestrator/src/modules/audit/audit.ts` that adds nullable `actor_issuer`, `actor_sub`, and `actor_role` parameters, shifting the old assertion positions; neither that source nor the existing test was changed for this task. The new role-policy suite independently proves ADMIN success, USER/VIEWER escalation denial before DB/audit calls, invalid-role rejection before side effects, and USER-to-operator mapping.

## Handoff boundary

The HTTP identity route is absent, so this task does not prove a browser request is wired to the new method. Route work must pass the trusted, server-resolved caller role into `createUser()` and map `AdminLocalUserRolePolicyError.code` to the response; it must not accept `callerRole` from request JSON. Route registration remains a separate task as directed.
