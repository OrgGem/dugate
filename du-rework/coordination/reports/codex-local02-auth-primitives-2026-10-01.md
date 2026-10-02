# LOCAL-02 local auth primitives

**Status:** isolated primitives implemented and focused offline checks passed. This does not wire local login into boot, routes, UI, `server.ts`, or `main.ts`. Interfaces are defined in this lane and import no LOCAL-01 repository code.

## Implemented seams

| Primitive | Implementation and current behavior | Plug-in seam |
|---|---|---|
| Password verifier | [password.ts](../../services/orchestrator/src/modules/auth/local-primitives/password.ts#L1) uses a fresh 16-byte salt, Node `scrypt` with fixed `N=16384, r=8, p=1`, and a 32-byte derived key. Verification derives the same fixed-size key and compares it with `timingSafeEqual`; malformed stored verifiers take a dummy derivation and fail closed. Password input is used transiently and is neither returned nor logged/stored by these primitives. | LOCAL-01 stores the encoded verifier returned by `hashLocalPassword`; `verifyLocalPassword` accepts only the presented password and that verifier. The verifier format does not accept caller-selected KDF parameters. |
| Login authentication | [authenticate.ts](../../services/orchestrator/src/modules/auth/local-primitives/authenticate.ts#L4) defines `LocalCredentialReader.findByLogin(login)`, whose result contains the server-resolved subject, verifier, role, and tenant. Unknown logins use the injected dummy verifier. Wrong-password and unknown-user failures return the same frozen `{ authenticated: false, status: 401, body: { error: 'Invalid credentials' } }` value. Successful claims come only from the resolved record. | LOCAL-01 implements the reader and must return `null` for unknown, disabled, or otherwise ineligible accounts. Its login normalization must match `subjectKeyForLogin`; callers must not supply a subject ID, role, or tenant claim. LOCAL-03 can pass this result to the session mint seam. |
| Attempt limit and lockout | [login-guard.ts](../../services/orchestrator/src/modules/auth/local-primitives/login-guard.ts#L3) provides `beginAttempt`, `recordFailure`, and `recordSuccess`. Defaults are 20 attempts per 60-second window, lockout after 5 failed checks for 15 minutes, and at most 10,000 retained subjects. Subject keys are HMACed with an instance-only random key; capacity exhaustion denies new subjects. Invalid configuration, invalid subjects, and invalid clocks fail closed. | `LocalLoginGuard` is asynchronous so LOCAL-01/03 can substitute an atomic shared-store adapter. The included implementation is process-local memory only; it is a primitive/test adapter and does not coordinate replicas or survive restart. |
| Opaque session | [session.ts](../../services/orchestrator/src/modules/auth/local-primitives/session.ts#L3) mints 32 random bytes encoded as base64url. Claims are stored server-side with `issuer: 'du-local'`; the repository key is SHA-256 of the token, never the raw token. `readLocalSession` returns no principal when lookup fails, issuer/record validation fails, or `expiresAt <= now`. | LOCAL-03 supplies a `LocalSessionRepository` implementation with `insert(digest, record)` and `findByTokenDigest(digest)`. `LocalSessionClaims` must be built from trusted server-side identity data. |

The authentication helper reserves a rate attempt before account lookup, verifies a dummy hash for unknown accounts, and records failed checks through the guard ([authenticate.ts](../../services/orchestrator/src/modules/auth/local-primitives/authenticate.ts#L58)). The generic response is identical by value and object identity in the unknown-user and wrong-password unit case. This normalizes the response contract; it does not claim identical end-to-end latency for different repository lookups.

## LOCAL-00 open questions

- Sign off or change the provisional login defaults: 20 attempts per minute, lockout at 5 failures, 15-minute lockout, and 10,000 in-memory subject entries. Capacity exhaustion currently returns the same generic 401 at the authentication seam.
- Sign off the provisional session TTL: 8 hours by default, with a 24-hour maximum. Idle expiry, rotation, logout/revocation, and CSRF are outside this primitives packet.
- Select and wire a shared atomic attempt/session backend before multi-replica production use. The included attempt guard is process-local and resets on restart; it is not cross-replica enforcement.
- Review the fixed Node `scrypt` choice and parameters for deployment resource budgets and LOCAL-00 password-hashing policy. No new crypto dependency was introduced.

## Verification receipt

Both checks were offline; no database, Redis, or S3 was used.

- CWD: `D:\Git\dugate\du-rework\services\orchestrator`
- Command: `pnpm exec jest --runInBand --config jest.unit.config.cjs tests/local-primitives.test.ts`
- Result: **Tests: 6 passed, 6 total**; exit code 0.
- CWD: `D:\Git\dugate\du-rework`
- Command: `npx tsc --noEmit -p services/orchestrator/tsconfig.json`
- Result: exit code 0, no diagnostics.

No gate or task row was changed.
