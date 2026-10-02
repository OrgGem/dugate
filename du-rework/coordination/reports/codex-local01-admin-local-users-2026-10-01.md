# LOCAL-01 — Admin local-user primitives

## Implemented

- Added `services/orchestrator/migrations/0023_admin_local_users.sql`. It creates the tenant-bound `admin_local_users` table with generated immutable UUID, normalized username uniqueness within tenant, self-describing password hash, role text, enabled/locked flags, timestamps, and a positive version counter. Migration number `0023` follows the existing `0022_budget_reservations.sql`.
- Added `src/modules/auth/admin-local/password.ts`: password creation uses Node scrypt with `N=32768`, `r=8`, `p=1`, a random 16-byte salt, a 32-byte output, and a 64 MiB memory ceiling. The stored encoding records the algorithm and parameters (`scrypt$32768$8$1$...`). There is no password verification or comparison API; that remains with LOCAL-02.
- Added `src/modules/auth/admin-local/repository.ts` and `index.ts`. Repository entry points reject missing or malformed tenant IDs before database access; reads and status changes bind both `tenant_id` and user `id`. SQL projections omit `password_hash`. Create and status mutations write `admin_audit_events` through the same transaction; a failed audit insert rolls back user creation.
- Added `src/migrations-local-users-cli.ts`. `create-admin` takes tenant ID and username as arguments and reads the password from piped stdin, never from argv. It emits no identity details, uses one generic failure message, and does not print the hash or password.
- Added only two new test files: `tests/admin-local-user-repository.test.ts` and `tests/admin-local-users-migration.test.ts`.

No boot wiring, UI, `server.ts`, `main.ts`, existing auth module, package, task document, or gate file was changed. No gate was ticked.

## Verification

Repository unit tests and the live migration smoke passed:

```text
PASS tests/admin-local-user-repository.test.ts
PASS tests/admin-local-users-migration.test.ts

Test Suites: 2 passed, 2 total
Tests:       7 passed, 7 total
Snapshots:   0 total
```

The migration smoke connected to the test database, created a randomly named private schema, applied migration 0023 twice, checked the table and tenant/username unique constraint, accepted the expected encoded hash shape, rejected a plaintext-shaped value, then dropped only that private schema.

The latest required typecheck did **not** pass:

```text
npx tsc --noEmit -p services/orchestrator/tsconfig.json
ExitCode 1
services/orchestrator/src/modules/auth/local-primitives/authenticate.ts(91,34): error TS18047: 'record' is possibly 'null'.
services/orchestrator/src/modules/auth/local-primitives/authenticate.ts(112,12): error TS18047: 'record' is possibly 'null'.
services/orchestrator/src/modules/auth/local-primitives/authenticate.ts(113,13): error TS18047: 'record' is possibly 'null'.
services/orchestrator/src/modules/auth/local-primitives/authenticate.ts(114,17): error TS18047: 'record' is possibly 'null'.
```

Those errors are in `src/modules/auth/local-primitives/authenticate.ts`, which is outside this packet's exclusive lease and was not edited here. An earlier typecheck during this work exited 0; the final rerun above is the current workspace result. The LOCAL-01 source additions compiled on that earlier run, but the acceptance typecheck is currently blocked by the listed file.

## OPEN QUESTIONS for LOCAL-00 / follow-on auth work

- What explicit auth-mode policy and defaults will be adopted, and how will `ADMIN_TOKEN` remain a separate machine credential? This implementation adds no mode parsing or token behavior.
- What role taxonomy and role-to-action/tenant authorization matrix will be approved? The bootstrap command creates only the requested `admin` role; the schema leaves role values unconstrained and this module defines no role matrix.
- Does the security policy approve the selected scrypt parameters, or require a different approved password-hashing implementation? scrypt is the current primitive because it is available in Node without adding a package; changing that policy is not inferred here.
- What username character/normalization rules, minimum password policy, lockout/reset behavior, and audit actor source should apply? Current primitives use NFC + lowercase + trim with a bounded ASCII username, accept non-empty passwords up to 1024 UTF-8 bytes, and require the caller to supply the audit actor.
- Which session invalidation and user-state transition rules should disable/lock operations enforce? This packet does not mint, verify, revoke, or wire sessions.

## LOCAL-01 CLI and migration rollback follow-up (2026-10-01)

### Admin-user CLI commands

`src/migrations-local-users-cli.ts` now supports these commands; none accepts password material in argv:

| Command | Inputs and repository action | Output |
|---|---|---|
| `create-admin --tenant-id <uuid> --username <name>` | Reads the new password from piped stdin, hashes it, then calls `createAdmin`. | `admin local user command succeeded` on success; otherwise the generic failure below. |
| `disable-admin --tenant-id <uuid> --user-id <uuid>` | Calls tenant-fenced `disableAdmin`; no password is read. | Same generic success/failure output. |
| `reset-password --tenant-id <uuid> --user-id <uuid>` | Reads a replacement password from piped stdin, hashes it, then calls `resetPassword`. The repository replaces the verifier and increments `version`. | Same generic success/failure output. |
| `rotate-credentials --tenant-id <uuid> --user-id <uuid>` | Reads replacement password material from piped stdin, hashes it, then calls `rotateCredentials`. The prior verifier is replaced and `version` increments. | Same generic success/failure output. |

All successes print exactly `admin local user command succeeded`; all failures print exactly `admin local user command failed` to stderr and exit non-zero. Tenant/user misses, duplicate creation, invalid input, and password-processing errors share that failure response. No command echoes a username, user ID, password, hash, or underlying error. Disable sets `is_enabled=false`; a login verifier must honor that state when LOCAL-02 wires authentication. Password comparison, session invalidation, and credential verification are not implemented here.

The repository status/credential mutations and their `admin_audit_events` entries remain in one transaction. Reset and rotation return only the safe user projection and do not return the verifier.

### Rollback path and private-schema proof

No migration-specific rollback command or down migration exists in v1: `src/db/migrations.ts:13-15` documents that down-migrations are not implemented, and `services/orchestrator/package.json` exposes only `migrate`, `migrate:status`, and `migrate:verify`. The focused live migration test therefore applies 0023 twice in its own randomly named schema, inserts an encoded verifier and rejects a plaintext-shaped value, then drops only that schema with `DROP SCHEMA ... CASCADE` and asserts `to_regclass('<private-schema>.admin_local_users')` returns null. It does not alter the public schema or another lane's objects.

### Follow-up verification

Command run from `services/orchestrator`:

```text
$env:DU_LOCAL01_LIVE_MIGRATION='1'; npx jest --runInBand tests/admin-local-user-repository.test.ts tests/admin-local-users-cli.test.ts tests/admin-local-users-migration.test.ts
PASS tests/admin-local-user-repository.test.ts
PASS tests/admin-local-users-cli.test.ts
PASS tests/admin-local-users-migration.test.ts
Test Suites: 3 passed, 3 total
Tests:       21 passed, 21 total
ExitCode: 0
```

Typecheck rerun after the concurrent LOCAL-02 edit settled:

```text
npx tsc --noEmit -p services/orchestrator/tsconfig.json
ExitCode: 0
```

The earlier typecheck failure recorded above was in the other lane's `auth/local-primitives/authenticate.ts`; it is now clean and remains unmodified by this packet. Actual CLI subprocess invocations against a deployment database were not run; command routing and generic result behavior are covered through the exported command dispatcher with repository fakes, while the schema and repository mutations are exercised by unit/private-schema tests.

### LOCAL-00 questions still open

- Auth-mode policy/defaults and the separation/production policy for `ADMIN_TOKEN` remain undecided; no mode or token behavior was added.
- Role taxonomy and the role/action/tenant authorization matrix remain undecided; bootstrap assigns only the requested `admin` label.
- Security approval of scrypt `N=32768, r=8, p=1` versus another approved password-hashing implementation remains open; no verifier/constant-time comparison was added.
- Username normalization/character policy, minimum password requirements, lockout/reset policy, and trusted audit-actor source remain open.
- How the future login lookup obtains an unambiguous tenant for usernames unique only within each tenant remains open; no tenant-less lookup or caller-selected tenant behavior was added here.
- LOCAL-02 must define how disabled/locked state, version changes, and credential rotation invalidate or reject sessions. This packet only writes the state/version and replacement verifier.
