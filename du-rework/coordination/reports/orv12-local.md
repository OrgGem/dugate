# ORV12-LOCAL owner handoff

2026-10-11, `/root/api_compat`; shared uncommitted workspace. Owner smoke only. `/root/internal_ops` owns the bootstrap factory/hook in create-app.ts; DATA owns the credential reader; UI owner adds logout CSRF to the React shell. Independent VFY/reviewer acceptance remains separate.

## Behavior and producer/consumer contract

- Main explicitly enables local credentials with `DU_ADMIN_AUTH_MODE=local`. Default token mode and existing OIDC flow remain. Enabling local with an OIDC flow fails boot rather than creating an IdP bypass. Imported account presence never auto-enables local mode.
- Username/password uses `authenticateLocalPassword` and `createAdminLocalCredentialReader`; enabled/unlocked/reset-complete predicates remain authoritative. An exact verifier recheck and user-version snapshot closes reset/login races. The opaque session reader rechecks enabled/locked/reset-required/version/role/tenant against DB on every request, including sessions used on another instance. No browser role or tenant can influence identity.
- Shared Redis holds opaque sessions, hashed-SID version metadata, per-normalized-user login failures/lockouts and bounded global login admission. Existing session store TTL/idle policy is reused. Global admission200/minute, per-user20/minute, lock after5 failures for15minutes; generic401 avoids disclosing existence or lockout. Invalid usernames use the bounded generic bucket and dummy verifier.
- Login has a signed, expiring HttpOnly/SameSiteStrict double-submit nonce; invalid proof gives403 before password processing. Existing TLS/Secure-cookie policy remains enforced. Redirect stays under `/admin`. Successful login rotates opaque identity, clears legacy cookie; local logout checks session CSRF and destroys the shared session. Static token fallback remains, and explicitly clears a stale opaque cookie after successful authentication.
- New redacted security events: auth.login_succeeded/auth.logout; failed credentials, rejected CSRF and revoked-session gates retain fixed reasons. Passwords, bearer values, CSRF/nonces and session IDs never enter audit events.
- No human platform bearer is required for local login. Bootstrap generates a process-only internal API credential when absent, before config consumers capture it. BFF operator calls use a TENANT credential, never the platform fallback. `du-local-tenant-v1.<lowercaseUUID>.<64hexMAC>` is HMAC-SHA256 over `du-local-tenant-v1\0<tenantUUID>` with the shared service key. RBAC accepts it only in explicit local mode, checks strict framing/MAC length in constant time, and returns only tenant_operator. Credentials are minted only for a server-resolved session principal. Legacy static tenant credentials keep priority.
- Cross-replica service verification uses `DU_ADMIN_LOCAL_SERVICE_SECRET`, falling back to the shared `ADMIN_SHELL_COOKIE_SECRET`, requiring at least32UTF8bytes. It does not depend on process-random admin credentials or mutable token registration. All API replicas must enable local mode and share this service key; sessions additionally require the same Redis namespace/database and user DB. Browser cookie signing also needs shared cookie secret.
- HTTP shell response writers now emit multiple Set-Cookie fields rather than one comma-concatenated field; this is necessary for clearing stale identity cookies while minting another. Splitting recognizes cookie assignments and preserves Expires-date commas.

## Deployment requirements

Set `DU_ADMIN_AUTH_MODE=local`, `REDIS_URL`, `ADMIN_SHELL_COOKIE_SECRET` and optionally `DU_ADMIN_LOCAL_SERVICE_SECRET`. Local boot requires shared Redis and a stable strong service key. Production must prove HTTPS under existing cookie policy (`DU_ADMIN_COOKIE_SECURE=enforce`, trusted proxy settings where applicable); no insecure fallback was added. Existing imported identities requiring reset remain disabled until authorized activation/password reset completes. Reuse existing session TTL and revocation policy.

## Owner checks

Cwd `/workspace/dugate/du-rework/orchestrator`; Node24.21.0/pnpm10.18.3 under `/workspace/scratch/orv11-toolchain`; owner live Redis `redis://127.0.0.1:56398` with random `orv12-owner:<UUID>:` namespace. Override with `ORV12_REDIS_URL` for another isolated Redis.

- `pnpm --filter @du/orchestrator typecheck`: exit0, [raw](raw/orv12-local/typecheck.log).
- `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv12-local-tenant-credential.test.ts tests/orv12-local-login.test.ts tests/admin-shell-auth.test.ts tests/admin-shell-router.test.ts tests/admin-shell-session-lifecycle.test.ts tests/admin-shell-oidc-flow-integration.test.ts tests/p730-profile-snapshot.test.ts`:129 passed,0 failed,0 skipped, exit0, [raw](raw/orv12-local/focused.log).
- New4 local tests use actual HTTP shell, scrypt and shared Redis with a DB double: loginCSRF, valid/invalid credentials, opaque session, version revocation across instances, disabled/locked/reset-needed refusal, logoutCSRF/revocation, shared lockout, token fallback cookie clearing, version-key token hashing and redacted audits. New2 service-credential tests use distinct process admin credentials/shared service key, tenant tamper/wrongmode/wrongkey denial and old static compatibility.
- Initial new cookie-clear check failed against comma-joined HTTP headers; transport fixed, assertion unchanged, [red retained](raw/orv12-local/set-cookie-initial-red.log).
- p730 fixture now supplies a legitimate unlimited spending key row for the ORV12 spend query; original profile assertions remain. It is included here as the late spend consumer regression.

Actual migrated PostgreSQL identity activation→HTTP login→BFF own-tenant operations, foreign denial and cross-app credential routing are VFY's independently assigned evidence. Owner checks above do not replace them. UI browser review is also separate.
