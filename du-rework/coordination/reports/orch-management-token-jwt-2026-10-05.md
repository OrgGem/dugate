# ORCH-MANAGEMENT-TOKEN-JWT receipt — 2026-10-05

## Result

Implemented signed Orchestrator-to-Connector management identity using Connector's existing `HmacServiceIdentityVerifier` and `requireServiceIdentity`; no second verifier was added and no Connector source was changed. Each outbound management request now asks an issuer for a new HS256 bearer token with `sub=orchestrator-management`, `aud=connector`, `scopes=[connector:manage]`, current epoch-second `iat`, and `exp=iat+60`. The issuer adds a unique `jti` and does not cache bearer tokens.

## Wiring and fail-closed behavior

- `services/orchestrator/src/modules/connectors/management-service-identity.ts` issues tokens on demand. Its environment adapter reads the base64 `SERVICE_IDENTITY_SECRET` in the same 32-byte format used by Connector's `requiredSecret`; the lower-level issuer rejects keys shorter than 32 bytes.
- Both Connector management HTTP adapters call the provider while constructing each request's `Authorization` header: `modules/connectors/connector-management-store.ts` and `modules/connector-credentials/connector-http-store.ts`.
- `main.ts` refuses configured Connector URLs without a valid shared key and rejects the obsolete static-header and standalone-expiry settings. `createApp` receives the issuer as a server-only option; credential-workflow composition also refuses to start without it.
- Compose passes the shared key to Orchestrator and Connector. Deployment environment documentation describes the key as server-side configuration; no key or bearer token is exposed to the browser.

## Focused coverage

`services/orchestrator/tests/orch-management-token-jwt.test.ts` uses the built Connector verifier. It proves a valid token passes, the claims match the required values, each request receives a distinct token even within the same second, and a later request gets a fresh 60-second window. Wrong-key and expired tokens are rejected as `GRANT_INVALID`; wrong audience and missing `connector:manage` scope are rejected as `BINDING_DENIED`. The Connector revision HTTP offline integration also exercises signed requests against the real Connector HTTP server/verifier.

## Verification

Working directory: `D:\Git\dugate\du-rework`. Verification was offline; no external services or live deployment were used.

| Command | Result |
|---|---|
| `pnpm --filter @du/connector run build` | exit 0; built Connector verifier used by Orchestrator tests |
| `pnpm --filter @du/orchestrator run test --runTestsByPath tests/orch-management-token-jwt.test.ts tests/plat-mig-01-boot.test.ts tests/p745-connector-management-proxy.test.ts tests/connector-revision-http-offline.functional.test.ts tests/credential-legacy-transition-offline.test.ts tests/credworkflow-e2e-offline.functional.test.ts tests/admin-actions-vault04-offline.functional.test.ts tests/business-contract-fix-820.test.ts --forceExit` | exit 0; 8 suites passed, 79 tests passed |
| `pnpm --filter @du/orchestrator run typecheck` | exit 0 |

Jest printed its open-handle notice after the passing run, so `--forceExit` was used. No commit or migration tick was made.
