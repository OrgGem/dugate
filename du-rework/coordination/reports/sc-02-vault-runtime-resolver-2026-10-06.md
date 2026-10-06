# SC-02 — Vault KV2 link & runtime secret resolver — 2026-10-06

- Task: `SC-02` (`tasks/SECRET-CATALOG-2026-10-06.md`); closes/reconciles `CR06-02`
- Owner: OpenCode (oc_2); role: Vault & Crypto Integrator
- Status: **IMPLEMENTED + offline-verified; live Vault chain (VFY-SC-01) and the one-line production composition wiring (integrator) remain OPEN. No acceptance claim.**
- Constraints honored: no commit, no push; strict write lease — new `services/orchestrator/src/modules/secrets/vault-resolver.ts`, `services/connector/src/vault/{reader,approle,runtime}.ts` (new files inside the leased `vault/**`), plus one new test file per service. Existing shared files untouched.

## 1. Requirement → implementation map

| Spec requirement (SC-02 row / Runtime resolution, CR06-02) | Implementation |
|---|---|
| Runtime resolver supports `managed_value` (AES-GCM at rest) | `createRuntimeSecretResolver` delegates to an injected `ManagedValueDecryptor`; the orchestrator test drives a REAL AES-256-GCM envelope roundtrip. The resolver never holds key material. |
| Runtime resolver supports `vault_reference` (safe KV v2 lookup) | `VaultReferenceReader` port; the connector side implements it with `createVaultKv2HttpReader` (KV v2 `GET /v1/{mount}/data/{path}?version=N`, namespace header, token header, no redirects, bounded response, typed failures). |
| Strict tenant/path isolation (never another tenant's mount/path or namespace) | Connection: runtime still checks the trusted revision binding (`matchesVaultRevisionBinding`) BEFORE the resolver; the new reader adds mount/path-prefix scope enforcement with traversal-proof ref validation, and fails closed with no request on deny. Platform: the resolver requires `ref.tenantId === context.tenantId`, the vault path must equal `<root>/tenants/<tenantId>/...`, the mount must be allowlisted, and the namespace must be in the allowlist when configured — all BEFORE any reader call. |
| Close the Vault KV2 chain / CR06-02: resolver + `createTokenRenewalDaemon` not dead code | New `createConnectorVaultRuntime` / `connectorVaultRuntimeFromEnv` production factory: AppRole login/renew (`createAppRoleTokenClient`) → `createTokenRenewalDaemon` (dynamic leases, fail-closed UNAUTHENTICATED) → daemon-backed reader → `SecretResolver`. An end-to-end offline test drives `DurableConnectorRuntime` with this resolver and asserts the pinned Vault value reaches the provider request; a second test runs the renewal tick across the safety margin. |
| Short in-memory cache, invalidated on rotation/revocation | Connector reader is lease-gated (no cached plaintext; every resolve re-reads Vault). Platform resolver caches by `tenant:secretId:revision` with a bounded TTL; a revision bump is a new key and `invalidate(secretId)` / `invalidateAll()` drop cached generations (rotation/revoke stops future resolves). |
| Fail closed on Vault outage / missing secret; never plaintext fallback | AppRole login rejection → non-retryable; renew-self 4xx → re-login rotation; transport/5xx → bounded daemon retries then `UNAUTHENTICATED` (reader then refuses before HTTP). Reader maps 400/403/404 to non-retryable typed errors, 429/5xx to retryable; `SecretResolver` converts these to `CREDENTIAL_INVALID` / retryable `PROVIDER_UNAVAILABLE` — never the legacy DB secret. Platform resolver maps any store/reader failure to `RESOLVE_FAILED` with a fixed, value-free message. |
| Unit tests with mock Vault; cross-tenant denied; invalid path denied; renewal cycle | `tests/sc-02-vault-runtime.test.ts` (17 tests) + `tests/sc-02-runtime-secret-resolver.test.ts` (17 tests), both offline. |

## 2. Changed paths (write lease respected)

| File | SHA-256 | Notes |
|---|---|---|
| `services/connector/src/vault/reader.ts` (new) | `3DA643779A011D437D51D4AF8A1457D438F9ADA953A218EC9617476E8E59F406` | Scoped, version-pinned KV v2 HTTP reader + daemon-backed wrapper |
| `services/connector/src/vault/approle.ts` (new) | `5AADE812CE573D029412FEFC5244300E241C5343CD4947697583B5D2AB8A7503` | AppRole `VaultTokenClient` (login + renew-self) |
| `services/connector/src/vault/runtime.ts` (new) | `5BFD1DC3B52889693F6C3BA5033ABB9ADA83ADD0CA9A00EFA53925F54534AFF8` | Production factory (options + env) closing the chain |
| `services/connector/tests/sc-02-vault-runtime.test.ts` (new) | `65C160FC0198EC2718801C82823F45DC31E9129153580824D76D7A7D30F8D991` | 17 tests (AppRole, daemon cycle, reader, runtime end-to-end, env) |
| `services/orchestrator/src/modules/secrets/vault-resolver.ts` (new) | `2383329F5CC5349070BE83AB8D95DAA3B04ACBECA52470DC2CC26039069CA395` | Platform runtime resolver (managed_value + vault_reference, isolation, cache) |
| `services/orchestrator/tests/sc-02-runtime-secret-resolver.test.ts` (new) | `90E90F6473B3B2BE4F926A3A8CBE75B5BD873998A0091D8424671C8CD3FA8C36` | 17 tests (AES-GCM managed leg, vault isolation negatives, cache/invalidate, probe) |

No file outside the lease was edited (`composition.ts`, `entrypoint.ts`, `resolver.ts`, `token-renewal.ts` untouched).

## 3. Composition handoff (integrator-owned, NOT edited)

Connector (one place, boot):
1. `const vault = connectorVaultRuntimeFromEnv(process.env)` — `undefined` keeps today's behavior; a HALF-set surface throws at boot (`VAULT_ADDR` + `VAULT_APPROLE_ROLE_ID` + `VAULT_APPROLE_SECRET_ID`; optional `VAULT_NAMESPACE`, `VAULT_APPROLE_MOUNT`, `VAULT_KV_MOUNT`, `VAULT_KV_ALLOWED_PREFIX`).
2. `await vault?.start()` before serving; `vault?.stop()` in shutdown.
3. Pass `vault?.secretResolver` to `new DurableConnectorRuntime(...)` (8th arg) and `new DurableConnectorManagement(...)` (4th arg) in `composition.ts` — those constructor seams already exist and now receive a real resolver instead of `undefined`.

Orchestrator (SC-04 consumers + SC-01 catalog):
4. `createRuntimeSecretResolver({ decryptManagedValue, readVaultReference, allowedMounts, allowedPathRoots, allowedNamespaces, allowLatestVersion, cacheTtlMs })`; inject the catalog store's decryptor and a Vault reader, and call `resolve(ref, {tenantId, purpose})` only inside authenticated request paths. Index/listing APIs must never return the value; `probe` is the safe availability check.

## 4. Verification (offline; literal exits)

| Command (cwd) | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` (`services/connector`) | exit **0** |
| `npx jest tests/sc-02-vault-runtime.test.ts tests/secret-resolver.test.ts tests/token-renewal.test.ts tests/vault-machine-policies-offline.test.ts tests/vault-bootstrap-offline.test.ts tests/vault-account-isolation.test.ts --silent` (`services/connector`) | **6 suites / 84 tests passed**, exit **0** |
| `npx jest tests/sc-02-vault-runtime.test.ts --silent` | 1 suite / **17 tests passed**, exit **0** |
| `npx tsc --noEmit -p tsconfig.json` (`services/orchestrator`) | exit **0** |
| `npx jest tests/sc-02-runtime-secret-resolver.test.ts --silent` (`services/orchestrator`) | 1 suite / **17 tests passed**, exit **0** |

Highlights: version-pinned read with namespace; cross-tenant grant denied before Vault read AND before provider dispatch; out-of-scope/traversal refs rejected with zero HTTP; 404/403 non-retryable vs 429/5xx retryable; no-live-lease refuses with zero requests; renewal tick renews at the margin, keeps a valid token through a renew outage, re-logins when the lease is lost; rotated secret version reaches the provider on the next revision pin; Vault outage yields retryable `PROVIDER_UNAVAILABLE` with zero provider calls; platform managed_value uses real AES-GCM and tamper/empty values fail closed; probe never returns values.

## 5. Limitations / open items

- **No live Vault/PG run** in this packet: mock HTTPS Vault only. The real KV v2 chain (AppRole auth mount, namespace, policies, rotation/revocation, restart) is VFY-SC-01's live-window scope; G-SEC stays NO-GO until then.
- **Production composition wiring is integrator-owned**: until `composition.ts`/`entrypoint.ts` pass the factory result, the resolver chain exists but is not boot-wired. The runtime end-to-end test constructs the same object graph in-process to prove the seam (not dead code), not production boot.
- **SC-01 format freeze**: platform reference fields (`purposes`, `revision`, envelope shape) are the SC-02 working contract; SC-01 may rename/narrow them and add the catalog store/RBAC.
- Legacy `legacy-db` connector credentials keep the historical repository/cipher path in `services.ts` (unchanged); the new resolver covers `vault-kv2` (and the platform's `managed_value`).
- No root token / arbitrary user path access is introduced; the deployment owns AppRole + policy scopes.
- No commit/push/cutover; no task/gate tick.
