# BFF-WIRING-DESIGN-808 — upstream handler design (2026-10-05)

**Task:** BFF-WIRING-RECEIPT-808 (`task_b43d193d3a70`) · **Owner:** dsh_2 (`term_bac0ad06`)
**Mode:** DOC-ONLY. No source modified, no commit, no push, no tick.
**Supersedes:** nothing on disk — BFF-WIRING-DESIGN had been given but produced **no receipt file**. This is that receipt, written from scratch.

> **Contract prompt slots:** already fixed by **FIX-PROMPT-SLOTS-811**. Not re-litigated here. `apps/admin-web/src/features/settings/catalog.ts` (file-type slots) and the settings contract are now aligned; this document treats that as settled.

## 0. TL;DR for the coordinator

Two BFF routes I registered under lease A7 are **live code calling upstream paths that do not exist**. Everything else in the admin BFF is wired. The work splits into **three packets**: one small read-only packet (identity — mostly substrate already exists), one medium read-only packet (settings — needs a new store + migration), and one **user-gated** packet (settings *writer* — cannot be built until a deployment adapter exists). Detail and ordering in §5–§6.

---

## 1. Upstream inventory — what the BFF calls vs what exists

The BFF relays to `runtime.jsonBaseUrl`. Every call site, verified by grep:

| # | BFF call site | Upstream path | Handler exists? |
|---|---|---|---|
| 1 | `bff/settings.ts:138` | `GET /api/v1/admin/settings` | ❌ **MISSING** |
| 2 | `bff/identity.ts:115` | `GET /api/v1/admin/identity` | ❌ **MISSING** |
| 3 | `bff/identity.ts:118` / `:183` | `GET`/`POST /api/v1/admin/identity/users` | ❌ **MISSING** |
| 4 | `bff/identity.ts:117` / `:223` | `GET`/`PUT /api/v1/admin/identity/users/:id` | ❌ **MISSING** |
| 5 | `bff/security.ts:92` | `/api/v1/admin/crypto-config` | ✅ `http/routes/admin.ts:675` |
| 6 | `bff/handle.ts:285` | `GET /api/v1/admin/audit` | ✅ `admin.ts:766` |
| 7 | `bff/handle.ts:344` | `GET /api/v1/admin/api-keys[/:id]` | ✅ `admin.ts:605` |
| 8 | `bff/handle.ts:395` | `GET /api/v1/admin/connectors/:id/revisions/:rev` | ✅ `admin.ts:551` |
| 9 | `bff/handle.ts:442` | `GET /api/v1/admin/connectors[+/capabilities]` | ✅ `admin.ts:543`, `:532` |
| 10 | `bff/handle.ts:516`, `bff/profiles.ts:229` | `POST /api/v1/admin/actions` | ✅ `admin.ts:324` |
| 11 | `bff/profiles.ts:109` | `GET /api/v1/admin/profiles/...` | ✅ (profile GETs) |
| 12 | `bff/operations.ts:153/165/188/198/209/217` | `/api/v1/operations`, `/usage`, `/admin/businesses…` | ✅ |

**Four missing handlers, all from my lease A7 packet.** Proof of absence (not assumption — a grep for `admin/(settings|identity)` across `services/orchestrator/src` returns **zero** matches):

```
services/orchestrator/src/http/routes/admin.ts:317  POST /api/v1/admin/actions   (ADM-BASE-02)
services/orchestrator/src/http/routes/admin.ts:529  GET  .../connectors/capabilities
services/orchestrator/src/http/routes/admin.ts:543  GET  .../connectors
services/orchestrator/src/http/routes/admin.ts:551  GET  .../connectors/:id/revisions/:rev
services/orchestrator/src/http/routes/admin.ts:605  GET  .../api-keys[/:keyId]
services/orchestrator/src/http/routes/admin.ts:660  GET/POST .../crypto-config
services/orchestrator/src/http/routes/admin.ts:756  GET  .../audit
```

The only `settings` hit in the whole `src` tree is a **comment** at `admin.ts:673` ("injected workflow … both routes fail closed"). There is no settings handler and no settings store.

---

## 2. Per-handler gap analysis — what each one needs

### 2.1 `GET /api/v1/admin/identity` + `/identity/users` + `/identity/users/:id`

**Good news: the substrate already exists. This is mostly a route.**

| Need | Status | Evidence |
|---|---|---|
| **Table** | ✅ EXISTS | `migrations/0023_admin_local_users.sql:4-20` — `admin_local_users` with `tenant_id`, `username_normalized`, `password_hash` (scrypt, CHECK-constrained), `role`, `is_enabled`, `is_locked`, `version` |
| **Tenant scoping** | ✅ EXISTS | every repo method takes `requireTenantId(input.tenantId)` and filters `WHERE tenant_id = $n` (`repository.ts:291-304`) |
| **Role enum** | ✅ EXISTS | `repository.ts:45` role-policy error type; `IDENTITY_ROLE_VALUES` in the contract |
| **Audit** | ✅ EXISTS | `repository.ts:308-317` already records `admin_local_user.status` inside the same tx via `audit.record(..., client)` |
| **Repository** | ✅ EXISTS | `modules/auth/admin-local/repository.ts` — `createUser` (`:209`), `createAdmin` (`:246`), `findById` (`:278`), `setStatus` (`:290`), `disableAdmin` (`:322`), `rotateCredentials` (`:351`) |
| **Password hashing** | ✅ EXISTS | `modules/auth/local-primitives/password.ts` — scrypt encoder matching the 0023 CHECK |
| **Read path (list users)** | ❌ **MISSING** | no `listByTenant` in the repository — only `findById` and the credential reader |
| **CAS on version** | ⚠️ **BROKEN — see 2.2** | |

### 2.2 ⚠️ HIGH — `expectedVersion` CAS is **not implemented** in the repository

This is the single most important finding in this document.

The BFF `PATCH` handler **requires** `expectedVersion` and relays a `409 IDENTITY_VERSION_CONFLICT` on mismatch (`bff/identity.ts`, contract `UpdateIdentityUserParamsSchema` requires the field). But the repository's `setStatus` does this (`repository.ts:298-305`):

```ts
const result = await client.query<AdminLocalUserRow>(
  `UPDATE admin_local_users
   SET is_enabled = $1, is_locked = $2, updated_at = now(), version = version + 1
   WHERE tenant_id = $3 AND id = $4
   RETURNING ${SAFE_COLUMNS}`,
  [input.enabled, input.locked, tenantId, userId]
);
```

It **increments `version` but never compares it to a caller-supplied expectation.** There is no `AND version = $expected` in the `WHERE` clause and no `rowCount === 0 → 409` branch. Same pattern in `disableAdmin` (`:322-330`) and the password paths (`:181`, `:300`, `:329`).

**Consequence:** two admins editing the same user concurrently both succeed — last writer wins. The optimistic-concurrency guarantee the BFF contract advertises **does not exist server-side**. The BFF would forward `expectedVersion`, the platform would ignore it, and the caller would receive a `200` for a write that silently clobbered a concurrent change. This is a lost-update bug, not a cosmetic gap.

**Fix:** add `AND version = $expectedVersion` to each `UPDATE` and return `null`/`0 rows` → `409`. `rowCount === 0` is already the natural signal (the repo returns `null` on no row, `:306-307`).

**This must be fixed before the identity route is wired to `setStatus`.** A BFF that advertises CAS in its contract while the upstream ignores `expectedVersion` is worse than one that does not advertise it — the frontend will rely on it.

### 2.3 `GET /api/v1/admin/settings`

Substrate inventory:

| Need | Status | Evidence |
|---|---|---|
| **Settings table** | ❌ **MISSING** | grep across all 32 migrations for `ai_provider|prompt_default|s3_|cache_ttl|retention|settings` → **zero** matches |
| **AppSetting store** | ❌ **MISSING** | the legacy `lib/settings.ts` AppSetting model does **not exist** in du-rework (it lives in the root Next.js app, out of tree) |
| **AI provider/model config** | ⚠️ boot-env only | no DB row; connector config is process config |
| **Prompt defaults** | ⚠️ **nearest thing exists, wrong shape** | `migrations/0026_profile_policy.sql:121-139` `connector_prompt_overrides` — keyed `(connection_id, api_key_id, endpoint_slug, step_id)`, i.e. **per-API-key override**, not a **tenant-wide default** |
| **S3/artifact storage config** | ⚠️ boot-env only | `artifacts.ts:81-97` — `storageBackend` comes from `options.storageBackend ?? (options.storageFacade ? 's3' : 'postgres')`, resolved at process start |
| **Cache/retention** | ❌ MISSING | no table; `0022_budget_reservations` is unrelated |
| **Precedent to copy** | ✅ **strong** | `app/admin/crypto-config-store.ts:24-47` — tenant-scoped `SELECT` + idempotent `UPSERT … WHERE (old tuple) IS DISTINCT FROM (new tuple) RETURNING`. This is *exactly* the shape a settings store should take. |

**Key design judgement — do not reuse `connector_prompt_overrides` for prompt defaults.** Its grain is `(connection, api_key, endpoint, step)` — a *client-specific override*. The settings contract's `promptDefaults` is a **tenant-wide default** that an override then layers on top. Conflating them would (a) put tenant defaults behind an `api_key_id NOT NULL` FK, making them un-settable without a key, and (b) make a settings read return every key's override. **New table, tenant-scoped, no api_key dimension.** 0030/0031 (`prompt_revisions_pin`, `prompt_overrides_ref`) are *operation-level pins* — also not a defaults store.

---

## 3. The two user-gated parts

### 3.1 Settings **writer** — gated on a deployment adapter

`POST/PUT /admin/api/settings` is already **fail-closed by design**: `bff/settings.ts` refuses with `503 SETTINGS_WRITER_DISABLED` **before any upstream call** (asserted in my tests, `expect(stub.requests).toHaveLength(0)`).

The blocker is real and unchanged: **there is no deployment adapter.** `artifacts.ts:81-97` reads `storageBackend` from process options at boot; `connectorBaseUrls` is process config (`0026_profile_policy.sql:115-116`: *"the platform only holds `connectorBaseUrls` config"*). There is nothing to write a changed setting **to** — no table, no adapter, no config-reload channel.

**This cannot be built honestly by anyone right now.** It needs a coordinator decision on where runtime settings live:
- (a) a settings table the process reads at boot (restart to apply), or
- (b) a live-reload adapter.

I am **not** proposing one — inventing that is exactly the "no invented storage" rule I followed in A7. Until it's decided, the honest state stays `writerEnabled: false`.

### 3.2 S3 **secret storage** — gated on a secret manager

`SettingsStorageSchema.secretPresent` is a presence bit. To compute it honestly you must know *whether* a credential is configured **without reading it into the process**. Two options, both needing a decision:

- Vault KV v2 metadata (`readVersions` — the interface **already exists**: `workflow.ts:44`, impl `vault-kv2-writer.ts:156-168`) — check `current_version > 0` without unwrapping. **This is the better fit and mostly exists.**
- Boot-env presence check (`Boolean(process.env.X)`) — honest but only tells you about env, not about a rotated Vault value.

The KV v2 path is genuinely close: the writer, the CAS, the error taxonomy, and the policy checks are all in `modules/connector-credentials/`. Reusing it is a wiring job, not new crypto.

---

## 4. Minimal implement-ready packets

Ordered; each is independently shippable. Files listed are **proposed** — the coordinator assigns leases.

### Packet A — `IDENTITY-UPSTREAM-READ` (read-only, no migration)
**Size: small.** The table, tenant scoping, role enum, audit and password hashing all exist.
- Add `listByTenant(tenantId)` to `modules/auth/admin-local/repository.ts` (mirror `findById` at `:278`).
- Add 3 routes in `http/routes/admin.ts` (after the crypto-config block at `:660`, same `assertAdminAuth` + `isAdminAuthed` shape).
- **Lease:** `services/orchestrator/src/modules/auth/admin-local/repository.ts` + `services/orchestrator/src/http/routes/admin.ts`.
- **Tests:** real PG, tenant A cannot list tenant B; anonymous → 401; password hash never in a response body.

### Packet B — `IDENTITY-CAS-FIX` (do **A and B together**, or B before A)
**Size: small, but HIGH severity.** Fix §2.2.
- Add `AND version = $expected` to `setStatus` (`:298-305`), `disableAdmin` (`:322-330`), and the two password paths (`:181`, `:329`).
- `rowCount === 0` → `409 IDENTITY_VERSION_CONFLICT`.
- **Lease:** same repository file.
- **Tests:** two concurrent writers, same `expectedVersion` → exactly one 200, one 409. Wrong `expectedVersion` → 409 and **no** row change.

> B touches the same file as A. Run them **in one packet** or sequence strictly — parallel lanes on `repository.ts` will conflict.

### Packet C — `IDENTITY-MUTATIONS` (create + status + audit)
- `POST /identity/users` → `createUser` (`:209`).
- `PATCH /identity/users/:id` → `setStatus` (`:290`) **once B has landed** — do not wire PATCH to a non-CAS `setStatus`.
- Audit is already inside both (`repository.ts:308-317`); confirm the audit action names reach the admin audit read (`admin.ts:766`).
- **Lease:** `http/routes/admin.ts` + the repository.
- **Tests:** create with a weak password rejected; duplicate username in one tenant → 409; the created password never echoed; audit row present after mutation.

### Packet D — `SETTINGS-READ` (needs a migration)
**Size: medium.** Needs a new tenant-scoped store.
- **New migration** `0033_admin_settings.sql` — `admin_settings(tenant_id PK, ai_*, prompt_defaults jsonb, storage_*, cache_retention jsonb, updated_at)`, additive + idempotent per the runner's contract.
- **New store** `app/admin/settings-store.ts` modelled on `crypto-config-store.ts:24-47` (same tenant-scoped SELECT + `IS DISTINCT FROM` UPSERT).
- Add `GET /api/v1/admin/settings` in `admin.ts`.
- `secretPresent` comes from §3.2 — **if that decision is not made, ship `false` and say so**, never guess. (This is the honest fallback: "no credential configured" is a true statement about an empty deployment.)
- **Lease:** `migrations/0033_*`, `app/admin/settings-store.ts`, `http/routes/admin.ts`.
- **Tests:** tenant isolation; unknown keys stripped; **no secret value in any response**; `writerEnabled: false` when no adapter.
- ⚠️ `http/routes/admin.ts` is contended across A/C/D — sequence A→C→D or split that file's lease.

### Packet E — `SETTINGS-WRITER` — ⛔ **USER-GATED, do not dispatch**
Blocked on §3.1. No ticket until the adapter decision exists.

### Ordering
```
B (CAS) ─┬─► C (mutations) ─► A (read)        [identity; B must precede C]
         └─► D (settings read)                [independent of identity]
E (writer)                                    [user-gated]
```
A and C both touch `admin.ts`; **A and C can be one packet.** B must precede C.

---

## 5. Frontend `lib/api/**` + `router.tsx` — parallel or after ACK?

**Answer: strictly AFTER a written backend ACK. Not parallel.**

Reasoning:

1. **The adapter contract is already written and provably stable.** `apps/admin-web/src/features/identity/identity-api.ts:58` calls `/admin/api/identity`, `:71` `POST …/users`, `:83` `PATCH …/users/:id` — **exactly** the four paths in §1 rows 2–4. The BFF routes exist (`handle.ts` registration, lease A7). **The URL surface will not move.** The risk of writing the UI now is therefore near zero *for identity*.

2. **But the failure mode is bad, not merely cosmetic.** With no upstream handler, the BFF relays the platform's `404`, which `upstreamProblem` turns into a `502`. So the identity screen would load and then show a hard error against a backend that a test suite says is "wired". A UI that is provably correct but visibly broken in a demo is worse for the `UI_APPROVED` review than a UI that does not exist yet.

3. **Settings is different and should wait longer.** `identity-api.ts` exists; there is **no settings adapter at all** (grep for `admin/api/settings` in `apps/admin-web/src` → only `routes/settings.tsx:1`, which renders a static catalog with zero `fetch`). So settings UI is new work *and* depends on D landing.

4. **`router.tsx` has no new route to add anyway** — `/settings` (`routes/settings.tsx`) and `/identity` already exist. The wiring is to existing routes.

**The ACK condition I'll implement against — all four:**
1. Upstream handler exists on disk at the exact path (`admin.ts` registers it), **and**
2. an orchestrator integration test proves a 200 with the DTO shape for a **real** tenant, **and**
3. §2.2 CAS is fixed (for identity only), **and**
4. the coordinator has written `ACK` on the backend route by name + path.

I will **not** start UI wiring on "the code looks done". Condition 2 is the one that distinguishes wired from assumed.

---

## 6. Implement-ready checklist

**Identity**
- [ ] `listByTenant(tenantId)` exists and filters `WHERE tenant_id = $1`
- [ ] `AND version = $expectedVersion` on **every** `admin_local_users` UPDATE (4 sites: `:181`, `:301`, `:329`, and the create-adjacent path)
- [ ] `rowCount === 0` → `409 IDENTITY_VERSION_CONFLICT` (not `404` — the row exists, the version moved)
- [ ] `GET /api/v1/admin/identity` returns `{users, capabilities, auth}` per the contract
- [ ] Tenant A cannot read/write tenant B (real PG test, not a stub)
- [ ] `password_hash` in **zero** response bodies
- [ ] Mutation emits an audit row (`admin_local_user.*`) visible via `GET /admin/audit`

**Settings**
- [ ] Migration `0033` is additive + idempotent, matches the runner's contract
- [ ] Store is tenant-scoped and modelled on `crypto-config-store.ts`
- [ ] Prompt defaults are a **tenant-wide** table, **not** `connector_prompt_overrides`
- [ ] `secretPresent` is derived from a real source, or shipped `false` with that stated
- [ ] `GET /api/v1/admin/settings` matches the (811-fixed) contract exactly
- [ ] `writerEnabled: false` until an adapter exists; `POST/PUT` still 503 with zero upstream calls
- [ ] No secret value in any response, at any depth

**Both**
- [ ] `npx tsc --noEmit` clean in `services/orchestrator`
- [ ] `packages/contracts` rebuilt (`npm run build`) after any contract touch, or the orchestrator fails `TS2305`
- [ ] Focused test ×3 for stability
- [ ] `orca orchestration check` clean before `worker_done`

**Gate:** none of this is `VERIFIED` until a Codex test packet runs the suites over real PG/Redis. My receipt is `IMPLEMENTED`-adjacent design evidence only — no code changed here.

---

## 7. Open decisions for the coordinator

1. **Settings runtime source** (§3.1) — table + restart, or live-reload adapter? Blocks Packet E entirely.
2. **`secretPresent` source** (§3.2) — Vault KV v2 metadata (`readVersions`, already implemented) vs boot-env presence? Blocks the honest answer in D.
3. **Lease contention on `http/routes/admin.ts`** — A, C and D all touch it. Either one combined platform packet, or strictly sequential leases.
4. **Confirm B before C** — I will not wire PATCH to a non-CAS `setStatus`.

**No source files were modified in this task.** DOC-ONLY as instructed.
