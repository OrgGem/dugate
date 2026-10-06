# VERIFY-BACKFILL-WINDOW-878 — independent receipt

Date: 2026-10-05  
Task: `task_f0a755e0039b` / dispatch `ctx_c1a15ea5de13`  
Scope: read-only verification of BACKFILL-CLI-825 and WINDOW-METRICS-825. Source and test files were not left modified; no commit or plan tick was made.

## Environment and database isolation

- Started a new `postgres:16-alpine` container, `vfy-bw878-20261005` (container ID prefix `ef9d9ab57d3c`), with a fresh in-memory `/var/lib/postgresql/data` tmpfs and a host binding only on `127.0.0.1:56060`.
- Direct connection returned `PostgreSQL 16.11 ... 64-bit`, database `bw878`. The database had `public_tables=0` at cleanup; the container was stopped and auto-removed. No project or shared PostgreSQL container was used.
- Ran the two focused Jest suites with `DATABASE_URL` targeting this disposable database. Inspection of the suites shows they do not issue PostgreSQL queries: the migration store test uses `fakeDb`, and the window suite mocks `legacy-payload-migration`. Thus PostgreSQL isolation was exercised and verified, but live SQL behavior of these two features is not proven by those suite cases.

## BACKFILL-CLI-825

Source: `services/orchestrator/src/modules/encryption/backfill-metadata-cli.ts`.

- Lines 24–28 define success exit `0` and refusal exit `2`. Lines 109–112 refuse unless `DU_ENCRYPTION_METADATA_ENABLED === 'true'`, before database initialization; the actual `main()` process probe with the variable absent wrote `refusing to run: DU_ENCRYPTION_METADATA_ENABLED is not true; nothing can be sealed without the metadata seam` to stderr and exited `2`.
- Lines 48–64 require `gate === 'PASS'` and full slot coverage. Lines 136–160 apply this gate before a backfill can be reported as successful. Lines 178–198 re-run the authenticated counter after the backfill and return refusal exit `2` if unresolved values or incomplete coverage remain. The decision helper tests exercise blockers and partial coverage.
- Mutation probe: temporarily replaced the environment guard condition with `if (false)`. `tests/backfill-cli-825.test.ts` stayed green: **1 suite passed, 16/16 tests passed, exit 0**. This focused suite does not protect the CLI entry-point environment guard or its process exit behavior; the separate direct process probe above verifies the current guard, but a regression test gap remains.

## WINDOW-METRICS-825 and retirement gate

Source: `services/orchestrator/src/modules/encryption/metadata-window-control.ts`.

- Lines 87–94 require an active `window` mode and resolve auth server-side. Lines 96–101 require a cookie admin with CSRF success plus nonempty principal ID and issuer (`isStablePlatformOperator`). Lines 103–116 require recorded complete progress, zero unresolved references, zero blockers, and `canRetireLegacyPayloads(..., confirmation.backupSignedOff)` before authorization is returned.
- Lines 122–138 write the audit event and fail with `AUDIT_REQUIRED` if persistence fails. Lines 141–145 return `nextMode: 'forbid'`, `restartRequired: true`, `auditEventId`, and `authorizedBy` from the verified session. The function does not mutate the immutable active policy; the test at lines 234–280 verifies an authorized request leaves `policy.mode === 'window'` and plaintext reads allowed. Closing the active window still requires the documented environment change and restart.
- The actual helper in `legacy-payload-migration.ts:501–506` returns true only when `backupSignedOff === true`, unresolved references are a safe integer, and the count is zero. The control suite mocks that helper (test lines 1–11), but its backup-false case turns red when that call is bypassed. The real helper cases at `legacy-payload-migration.test.ts:161–163` also assert unsigned backup → false, unresolved references → false, and signed backup with zero references → true.
- Mutation probe: changing `isStablePlatformOperator` to always return true made the focused control suite fail **1 test, 8 passed, exit 1** (`OPERATOR_AUTH_REQUIRED` was expected but `WINDOW_NOT_READY` was received). A raw removal of the `if` narrowing failed TypeScript compilation before Jest; the predicate mutation preserved the type guard and tested runtime behavior.
- Mutation probe: bypassing the `canRetireLegacyPayloads` condition made the signed-backup case fail **1 test, 8 passed, exit 1** because the request resolved instead of rejecting when `backupSignedOff` was false.

## Test and typecheck results

Final verification after restoring source bytes:

```text
Focused Jest: backfill-cli-825.test.ts + metadata-window-control.test.ts
Test Suites: 2 passed, 2 total
Tests:       25 passed, 25 total
Exit:        0

pnpm exec tsc --noEmit -p tsconfig.json
Exit: 0 (no diagnostics)
```

The real helper’s broader suite was also run:

```text
tests/legacy-payload-migration.test.ts
Test Suites: 1 failed, 1 total
Tests:       1 failed, 8 passed, 9 total
Exit:        1
Failure: expected unresolvedReferences=4, received 10 (assertion at line 148).
```

The same mismatch is documented in the BACKFILL-CLI-825 owner receipt: the inventory now counts six additional `ENC09_PAYLOAD_KINDS`. No test was edited or suppressed during this verification.

## Restoration and proof limits

- `backfill-metadata-cli.ts` SHA-256 before mutations and after restoration: `F84386B3C5FEA459C0AA569304B500157F987E69E425EAAF2158BD5CC84ECC33`.
- `metadata-window-control.ts` SHA-256 before mutations and after restoration: `0652538CD23533CDFFB11A751EF280593316217F887345FF3C43929E1B1C7D30`.
- Test files were not mutated. Their final hashes are `DB8582EB7D0D470F75999327443580DD2EA7AC68033D22ED542CB82FBDE3B407` (`backfill-cli-825.test.ts`) and `0FBE9EC750A3DA3D67C68B3C8D29B77F192185C3515AF4C5B6C76FDAF53209C1` (`metadata-window-control.test.ts`).
- Offline evidence covers code guards, the actual missing-seam CLI refusal, unit behavior, audit authorization decisions, helper semantics, and successful typecheck. It does not establish that the production Vault key provider is reachable or correctly authorized, nor does it prove real-schema row locking/backfill, durable audit storage, or a live deployment’s environment/restart workflow. Deterministic/fake providers and mocked sinks are not production Vault evidence.
- Scoped `git status` showed these four source/test files already untracked before this work and still untracked afterward. The only artifact created by this verification is this receipt.
