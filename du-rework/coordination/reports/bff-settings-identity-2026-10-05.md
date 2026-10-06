# BFF-SETTINGS-IDENTITY — receipt (2026-10-05)

**Packet:** BFF-SETTINGS-IDENTITY (`task_6fa1b100409c`, dispatch `ctx_59500915e0fd`), lease **A7**
**Owner:** dsh_2 (`term_bac0ad06`)
**Precondition:** CFGADM-DOCS-CSRF-FIX receipt written first (`coordination/reports/cfgadm-docs-csrf-fix-2026-10-05.md`). ✅
**Mode:** OFFLINE — no DB / Redis / S3, no commit, no push, no tick.

This packet also **resolves the blocker** recorded in `settings-wire-base-2026-10-05.md` §3: the orchestrator BFF + contracts surfaces were outside the lease at that time. Lease A7 grants exactly those files.

## 1. Write-set (lease A7, nothing outside it)

| File | Change |
|---|---|
| `packages/contracts/src/settings.ts` | **NEW** — settings read DTO + disabled-writer contract |
| `packages/contracts/src/identity.ts` | **NEW** — identity DTOs, CAS-guarded |
| `packages/contracts/src/index.ts` | **MODIFIED** — added `export * from './settings'` + `'./identity'` |
| `services/orchestrator/src/app/admin/bff/settings.ts` | **NEW** — `GET`/`POST /admin/api/settings` |
| `services/orchestrator/src/app/admin/bff/identity.ts` | **NEW** — `GET`/`POST`/`PATCH /admin/api/identity` |
| `services/orchestrator/src/app/admin/bff/handle.ts` | **MODIFIED** — route registration at the assigned seam (~`:147-160` region) + header comment |
| `services/orchestrator/tests/bff-settings-identity.test.ts` | **NEW** — 24 offline tests |
| `coordination/reports/bff-settings-identity-2026-10-05.md` | **NEW** — this receipt |

**Explicitly NOT touched** (per the packet's "hold outside" list): `runtime.ts`, `http/routes/runtime.ts`, `metadata-crypto.ts`, migration `0032`. Also untouched: `apps/admin-web/router.tsx` and `lib/api/**` — the packet holds those until the backend route exists *and* is ACKed. The BFF routes now exist but are **not yet ACKed**, so the admin-web side stays untouched in this packet (see §7).

`packages/contracts/dist/` was rebuilt (`npm run build`) because the orchestrator consumes the **built** `dist/index.d.ts`, not source — verified: without the rebuild, tsc reports `has no exported member` for every new symbol.

## 2. Part A — settings

### 2.1 Read DTO — only real value fields

`packages/contracts/src/settings.ts`, per the packet's field list:

| Packet requirement | Contract shape | Secret? |
|---|---|---|
| AI provider/model/base URL | `SettingsAiDefaultsSchema { provider, model, baseUrl }` | no — a URL/identifier is not a credential |
| 5 prompt-default slots | `SettingsPromptDefaultsSchema { extract, analyze, transform, generate, compare }` | no |
| S3 endpoint/bucket/region/TTL | `SettingsStorageSchema { backend, endpoint, bucket, region, ttlSeconds }` | no |
| **S3 secret** | **`storage.secretPresent: boolean`** | **presence bit only — the value has no field anywhere** |
| cache/retention | `SettingsCacheRetentionSchema { dedupEnabled, retentionDays, cleanupIntervalSeconds }` | no |

The 5 slots are an explicit `as const` tuple (`SETTINGS_PROMPT_SLOTS`), so adding a sixth is a deliberate contract change. `ingest` is deliberately absent — it interpolates no prompt; I documented that rather than inventing a 6th empty slot.

`SettingsCapabilitiesSchema { readerEnabled, writerEnabled }` is the machine-readable capability the UI gates on.

### 2.2 `GET /admin/api/settings`

Follows `bff/security.ts` exactly: session first (401) → unscoped principal (403) → `authorizeAuditTenantRead` tenant fence → `credentialFor` → upstream.

Tenant comes from the **session**; an operator is pinned to its own credential and a foreign `?tenantId=` is refused with the upstream untouched (asserted in tests).

### 2.3 ⚠ Design decision worth your attention: the read is NARROWED, not relayed raw

The packet said "relay verbatim". My first implementation did exactly that — **and the test caught a real secret leak.** The upstream stub deliberately returned `storage.secretValue` and `relayUpstream` passed it straight through to the browser.

Verbatim relay is only safe if you trust the upstream never sends a secret. That is exactly the assumption the repo's own redaction doctrine forbids. So the read now parses through `SettingsReadSchema` and republishes the narrowed result:

- an unmodelled field (including a `secretValue`) is **dropped**, not relayed;
- a body that does not match the DTO at all → `502 UPSTREAM_ERROR`, never a half-trusted echo;
- 5xx still collapses to `502 UPSTREAM_ERROR` via the existing `relayUpstream` → `upstreamProblem` path.

"Verbatim" is honoured in the sense that matters: the platform's own view is republished unchanged. It is *not* honoured as "pass bytes through unexamined". Recorded here because it is a deliberate deviation from the packet's literal wording, made for a security reason.

This also forced a contract change: the READ schemas are now **non-strict** (Zod's default strips unknown keys). With `.strict()`, one stray key rejected the whole body and turned a benign extra field into a 502 — noisier and strictly worse for availability. The WRITE schema stays `.strict()`, because an unrecognised field in caller input is a client bug we must not drop silently.

### 2.4 Writer — disabled/fail-closed, no invented storage

`POST`/`PUT /admin/api/settings` runs the fence **in this order**:

1. CSRF **before** role — a cross-site caller learns nothing about the role policy;
2. role + platform principal → `403 ADMIN_CREDENTIAL_REQUIRED`;
3. then the capability gate → **`503 SETTINGS_WRITER_DISABLED`** with the reason `"no deployment adapter exists in this build, so settings cannot be changed from the Admin UI"`.

Critically, the refusal happens **before any upstream call** — asserted by `expect(stub.requests).toHaveLength(0)`. There is no store to write to, so not attempting the write is the only honest behaviour.

### 2.5 GAP recorded, not resolved

> **GAP — no deployment adapter exists in this tree.** Every settings field is boot-time config with no Admin mutation path (the ACUI-M06 `connectorBaseUrls` shape). The read is honest and live; **no writer can be honest** until an adapter exists. Left as a visible GAP per the packet — not resolved here.

## 3. Part B — identity

`packages/contracts/src/identity.ts` mirrors the already-`UI_APPROVED` `identity-api.ts` shapes, so the browser adapter and the BFF speak one contract rather than two that drift.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/admin/api/identity` | snapshot: users + capabilities + auth mode |
| GET | `/admin/api/identity/users` | user list |
| POST | `/admin/api/identity/users` | create; validates username/password/role against the closed enum |
| GET | `/admin/api/identity/users/:id` | one user |
| PATCH | `/admin/api/identity/users/:id` | role/enabled, **CAS-guarded** |

**CAS**: `expectedVersion` is **required**. Omitting it is a `422 INVALID_SCHEMA`, never a blind write. A stale version is the platform's call — the route forwards it and relays the `409 IDENTITY_VERSION_CONFLICT` honestly rather than re-implementing the comparison.

**Tenant is not a caller field.** No schema accepts a `tenantId` from the client; the BFF derives it from the resolved session. A `tenantId` in a body is simply not forwarded (the body is rebuilt field-by-field, not passed through).

**No credential ever rides.** No password hash / API key / session token field exists on any identity schema. The create password is forwarded **once** to the platform and never returned; `IdentityUserSchema` is `.strict()` so an upstream field we did not model is rejected rather than republished.

**Role policy not invented.** The requested role is validated against the closed enum and forwarded; the platform decides (IDENTITY-ROLE-POLICY is another lane's packet). No hardcoded self-admin escalation.

**Audit**: the contract declares `IdentityMutationResponseSchema { user, audit: { action, recordedAt } }` so a caller sees what was recorded without a second round trip. The platform is responsible for emitting it.

## 4. Verification

| Command | cwd | Result |
|---|---|---|
| `npm run build` | `packages/contracts` | **exit 0** |
| `npx tsc --noEmit -p tsconfig.json` | `services/orchestrator` | **exit 0, no output** |
| `npx jest --runInBand tests/bff-settings-identity.test.ts` ×3 | `services/orchestrator` | **24 passed / 24 total** each run |

Focused run ×3 literals: `RUN1: 24 passed`, `RUN2: 24 passed`, `RUN3: 24 passed`. No flakes.

### Coverage against the packet's five required test areas

| Required | Tests |
|---|---|
| DTO validation | 6 tests — real view accepted; malformed backend/ttl rejected; unmodelled field stripped; missing slot rejected; writer shape; identity snapshot accepted / credential-bearing user rejected |
| **secret never leaks** | 3 tests — injected `secretValue` dropped from the wire; 5xx body not echoed; non-DTO upstream → 502 not an echo |
| cap gate 401/403 | 4 tests — settings + identity anonymous→401 and unscoped viewer→403, **upstream untouched**; foreign-tenant→403; wrong method→405 |
| **disabled writer** | 3 tests — no-CSRF→403; operator→403 ADMIN_CREDENTIAL_REQUIRED; admin+CSRF→503 SETTINGS_WRITER_DISABLED **with zero upstream calls** |
| CAS 409 | 2 tests — missing `expectedVersion`→422 with no upstream call; valid version forwarded; stale version relays 409 |

Plus 2 unit tests on `matchIdentityRoute` proving dot-segments/embedded-slashes/over-long ids never shift the request onto a different route.

### Two failures found and fixed in-turn (not hidden)

1. **HIGH — real secret leak in my own first implementation.** "Relay verbatim" passed an upstream-injected `storage.secretValue` straight to the browser. Caught by the test that deliberately injects it. Fixed by narrowing through the strict-shaped DTO (§2.3). This is the reason that test exists.
2. **Test artifact, not a defect** — an HTTP test for a `..` user id returned 200. The WHATWG `URL` parser normalizes dot segments in `pathname` before a request is sent, so that branch was unreachable over HTTP. Replaced with an over-long-segment HTTP test plus direct unit tests on the matcher, which is where the fence actually lives.

## 5. Offline confirmation

No database, Redis, S3 or Vault is used. The upstream is an in-process `node:http` stub on loopback; the BFF boots a real `createAdminShellServer`. Ports are derived from `process.pid` to avoid colliding with concurrent lanes.

## 6. Security posture summary

| Property | Status |
|---|---|
| Secret values on the settings wire | **impossible** — no schema field can hold one; unknown keys stripped |
| Secret values on the identity wire | **impossible** — no credential field exists on any schema |
| Tenant widening via client input | **impossible** — session-derived; client `tenantId` never forwarded |
| CSRF before role on every write | ✅ both routes |
| Blind write without CAS | **impossible** — `expectedVersion` required, 422 otherwise |
| Invented storage | **none** — writer refuses before any upstream call |

## 7. What is left / honest gaps

- **Upstream platform routes do not exist yet.** These BFF routes call `/api/v1/admin/settings` and `/api/v1/admin/identity[...];` the corresponding handlers in `http/routes/admin.ts` are **not** on disk (verified: the only `settings` hit there is a comment at `:673`). The BFF is honest — a missing upstream yields a relayed `404`/`502` — but these routes are **not end-to-end functional** until the platform handlers land. That is a follow-up packet, not a defect here.
- **admin-web untouched, by design.** The packet holds `router.tsx` / `lib/api/**` until the backend route exists *and* is ACKed. The routes now exist but are not ACKed, so I did not wire the UI. This is the honest sequencing, not an omission.
- **identity-api.ts vs the new contract** — the browser adapter declares its own local types. They were written to match, but the UI does not yet import `@du/contracts`. Consolidating them is the natural follow-up when the UI lease opens.
- **Review request**: the §2.3 narrowing deviation is a security-motivated departure from the packet's literal "relay verbatim" wording. Flagging it explicitly rather than burying it.

## 8. Commands + file digests

| Command | cwd | Result |
|---|---|---|
| `npm run build` | `packages/contracts` | exit 0 |
| `npx tsc --noEmit -p tsconfig.json` | `services/orchestrator` | exit 0, no output |
| `npx jest --runInBand tests/bff-settings-identity.test.ts` ×3 | `services/orchestrator` | 24/24 each run |

No commit, no push, no task tick.

### File digests (SHA-256, first 16)

```
b8d9fa915a149353  packages/contracts/src/settings.ts
7794f3bef1f5e168  packages/contracts/src/identity.ts
72bbfd01f33f43b2  services/orchestrator/src/app/admin/bff/settings.ts
038234bf4025dff2  services/orchestrator/src/app/admin/bff/identity.ts
07199a0b41d1aa70  services/orchestrator/src/app/admin/bff/handle.ts
9c43fe3675b98e2c  services/orchestrator/tests/bff-settings-identity.test.ts
```