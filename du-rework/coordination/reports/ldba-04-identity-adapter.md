# LDBA-04 identity adapter receipt

Task: LDBA-04-2026-10-09
Date: 2026-10-09
Spec: coordination/dispatch-specs/2026-10-09-LDBA-04-identity-adapter.md
Canonical plan: coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md

## Decision and schema evidence

Read the legacy User mapping at lib/db/schema.ts:175-184 and the legacy UserProfileAssignment declaration at lib/db/schema.ts:190-195. Read migrations 0023, 0024 lines 24-30, and 0026 lines 161-180.

The no-backfill statements read:

> Deliberately NOT backfilled
>
> There is no legacy data to import: the legacy database is a separate deployment and docs/14-reference-compatibility.md states the rework is a fresh project with no data/credential migration. Backfilling 0 would make billing report zero spend for every pre-existing operation, which is a lie a client cannot distinguish from a real measurement.

> Deliberately NOT backfilled
>
> docs/14-reference-compatibility.md states the rework is a fresh project with no data/credential migration from the legacy deployment, so there are no legacy ProfileEndpoint / ExternalApiOverride / UserProfileAssignment rows to import. The DEFAULTs above make every existing profile_bindings row read as a fully-enabled, no-policy, MEDIUM-priority revision — which is exactly the behavior those rows had before this migration, so resolution is unchanged.

This packet deliberately reverses the deployment-level no-data/no-credential-migration assumption for legacy local identities. Any admin_local_users row inserted through this adapter is migrated data, not new user data. This receipt is evidence for the coordinator to update the plan; no migration or plan file was changed.

Migration 0023 lines 1-23 contains the admin_local_users schema, scrypt CHECK, and index only. It contains no backfill policy. The scrypt CHECK remains unchanged, and no bcrypt column was added.

## Implementation

- src/modules/identity/legacy-user-adapter.ts:8-53 defines the legacy and target shapes plus an injected bcrypt verifier and atomic insert port.
- src/modules/identity/legacy-user-adapter.ts:76-120 maps only ADMIN to admin, USER to operator, and VIEWER to viewer; unknown roles fail. It validates legacy user and resolved tenant UUIDs and normalizes usernames with the existing local identity rule.
- src/modules/identity/legacy-user-adapter.ts:122-171 verifies a supported bcrypt verifier at login, hashes the presented password with the existing scrypt primitive, checks the exact local scrypt format, then asks the port to insert the target row. A wrong password writes nothing. An absent or malformed verifier requires password reset. A concurrent or prior target row returns write conflict so the caller can restart through the normal scrypt login path.
- The adapter requires the resolved UUID for the seeded legacy-default tenant; it never casts the text label to UUID. The target identity carries that tenant UUID, retains the validated legacy user UUID, and uses the existing target enabled and unlocked defaults.
- migrations/0023_admin_local_users.sql:4-23 has no provider, providerSub, email, or displayName columns. The adapter does not add columns or project these fields. External provider identities are classified as unsupported-provider and are not inserted. OIDC identity continuity remains open for a separate decision.
- migrations/0026_profile_policy.sql:161-165 defines user_profile_assignments with only user_id, api_key_id, and granted_at, and a composite primary key. src/modules/identity/legacy-user-adapter.ts:174-194 returns only the UUID-validated user/key pair and rejects different resolved tenant UUIDs. The source assignment id is not copied and no target tenant column is invented.
- tests/legacy-identity-adapter.test.ts:42-91 exercises the synthetic credential cohort, scrypt CHECK format, and no-write behavior. Lines 94-166 cover external-provider exclusion, the role map, UUID validation, and same-tenant assignment mapping.

Password reset is the selected disposition for an identity with no usable legacy local verifier. The adapter does not create a locked row with an unknown password.

## Offline test and typecheck

Working directory for each command: D:/Git/dugate/du-rework/orchestrator/services/orchestrator

| Run | Command | Exit | Literal result |
|---|---|---:|---|
| RED before module existed | node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-identity-adapter.test.ts | 1 | FAIL tests/legacy-identity-adapter.test.ts; TS2307 Cannot find module ../src/modules/identity/legacy-user-adapter; Tests: 0 total |
| GREEN focused suite | node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-identity-adapter.test.ts | 0 | Test Suites: 1 passed, 1 total; Tests: 5 passed, 5 total; Snapshots: 0 total |
| Typecheck | node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json | 0 | No diagnostics |

The test uses a synthetic cohort of exactly 3 users: 1 correct bcrypt login migrated, 1 incorrect password rejected, and 1 missing verifier requiring reset. At the end, 2 of 3 have not completed migration; exactly 1 requires reset in this fixture. The real bcrypt verifier is checked with bcryptjs; the generated target password hash passes isLocalPasswordHash, which matches the 0023 CHECK format. No database fixtures or real DB were used.

The module, test, and receipt contain no double-quote character or trailing whitespace.

## Open items for coordinator

- The module is not wired into the existing auth/login path. The current credential reader reads only admin_local_users and does not resolve legacy User.password. The dispatch lease forbids editing existing auth source, so login integration needs a separate lease and must arrange a trusted legacy verifier source, bcrypt implementation, transaction-backed insert, and normal scrypt lookup after migration.
- The orchestrator package does not declare bcryptjs. The adapter takes verification as an injected port; its future production caller must provide the approved bcrypt verifier without creating an undeclared runtime dependency.
- The test count is synthetic evidence only. The exact deployment count of identities requiring password reset, plus normalized username collision counts, belongs in the authorized backfill report. No production or legacy database was queried.
- provider and providerSub are missing from the target local-user shape, so external identity continuity is unresolved. No target columns were added.

No migration was run, no real database was used, no gate was ticked, and no commit, staging, or push was performed.
