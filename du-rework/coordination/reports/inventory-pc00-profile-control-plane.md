# PC-00 — Inventory and freeze for the Profile Control Plane

**Packet:** PC-00 (Inventory and freeze)
**Master plan:** `du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` (PC-00 row + "Current implementation seams")
**Mode:** read-only source analysis + read-only dry-run against a local database
**Status:** inventory complete, no source code modified
**Date:** 2026-10-21

---

## 0. Receipt summary

| Item | Value |
|---|---|
| Source files modified | **none** (report file only) |
| Source files inspected | 31 files under `services/orchestrator/src`, `app/admin/bff`, `compat/`, `migrations/` (full reads plus targeted section reads) |
| Live route table read | yes — `src/server.ts` + `src/http/routes/*` + `compat/legacy-http-mount.ts` |
| Dry-run executed | yes — read-only SQL against `du_orchestrator_dev` (PostgreSQL 16.11, `127.0.0.1:15433`) |
| Data mutated | **none** (SELECT-only; no DDL, no locks beyond `SHARE`) |
| Migrations applied | none |
| Blocker to PC-01 | none; cohort-level caveats are in §7 (classification) and §8 (findings) |
| Next free migration prefix | **`0070`** — `0069_required_data.sql` exists on disk and is **not** yet applied (see §6.10) |

Harness scripts and raw output used for §6 are kept under `D:/Git/dugate/.tmp-pc00/`
(`inventory.mjs` … `inventory5.mjs`, `inventory-out*.json`).

---

## 1. Scope and method

Per the plan, PC-00 is the **first** package: enumerate every public action/catalog/preflight
path, Connector/provider probe, key issue/rotate/revoke/attach action, profile mutation,
key/grant reader, retry, and operation owner projection; record the **current authority source**
and the **target resolver** per route.

Method:

1. Read `src/server.ts` (dispatch order) and the whole `src/http/routes/` family.
2. Read the shared key resolver (`http/routes/api-key-auth.ts`) and every caller.
3. Trace the profile admission seam (`modules/profiles/profiles.ts` → `selectActiveRow`),
   the group read seam (`modules/profiles/profile-groups.ts` → `resolveCurrentGroupKey`),
   and the legacy facade (`compat/legacy-http-mount.ts` → `compat/legacy-host-adapter.ts`).
4. Enumerate key/profile mutation surfaces (dispatcher, parity, identity service, BFF).
5. Run a read-only dry-run inventory of the actual data (groups, revisions, memberships,
   tombstones, selector overlaps, operation/artifact owners).

**Evidence boundary.** Everything below is *source* + *one local dev database* evidence.
This report does **not** claim anything about a built image, a deployed container, or
production data. Per plan §"Rollout order" item 1, no production data was touched.

---

## 2. Freeze statement

The plan requires contracts and migrations to be frozen until this inventory lands.
This packet therefore declares, for downstream packages (PC-01…PC-09):

* **No source file was edited.** The only file created by PC-00 is this report.
* The current authority behaviour described in §3 and §4 is the **baseline being replaced**;
  it is not to be extended except where a package's lease explicitly says so.
* Anything listed in §7 as a blocker must be resolved by an explicit decision in
  PC-02/PC-03, **not** by widening PC-01 contracts.

---

## 3. Current authority model in code (three seams)

### 3.1 Key authentication — `http/routes/api-key-auth.ts`

```ts
// api-key-auth.ts:10-22
export async function resolveApiKey(ctx) {
  const raw = ctx.headers['x-api-key'];
  if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'missing x-api-key');
  const hash = hashKey(raw);
  const res = await ctx.db.query(
    'SELECT id, tenant_id FROM api_keys WHERE hash=$1 AND status=$2', [hash, 'ACTIVE']);
  ...
}
```

* Only `api_keys.status='ACTIVE'` resolves. Unknown, revoked and cross-tenant keys are 401.
* The resolver returns **`{id, tenantId}` only** — no mode, no authority, no group.
  This is the single seam that must become mode-aware (`GROUP_MANAGED` /
  `LEGACY_STANDALONE` / `UNMANAGED_LEGACY`), and it currently has no join to profiles,
  groups or grants at all.

### 3.2 Profile resolution — `modules/profiles/profiles.ts:414-473` (`selectActiveRow`)

Resolution for `(apiKeyId, businessId, businessVersion, action, endpointSlug)`:

```
profile_active_revisions a
  ⋈ profile_bindings p   ON p.profile_id=a.profile_id AND p.revision=a.revision
  ⋈ profile_api_keys m   ON m.profile_id=p.profile_id AND m.api_key_id=$1
                            AND m.state='ACTIVE' AND m.tenant_id=p.tenant_id
ORDER BY (p.endpoint_slug IS NOT NULL) DESC, a.moved_at DESC, p.profile_id LIMIT 1
```

Refusal taxonomy (all fail closed):

| Result | Trigger | Surfaced as |
|---|---|---|
| row | one ACTIVE membership resolves an active revision | `mode:'pinned'` |
| `'pointer-missing'` | membership + bindings exist, no `profile_active_revisions` row | 404, never `MAX(revision)` fallback |
| `'not-authorized'` | the key has **any** historical `profile_api_keys` row but no ACTIVE match for this selector | 403 |
| `'legacy'` | the key has **no** `profile_api_keys` row at all | `mode:'legacy'` (no-profile path) |

**This is the core "zero active memberships ≠ unmanaged" proof already in code**
(`profiles.ts:464-472`): the `anyRes` probe counts rows regardless of `state`, so a key
with only revoked tombstones can never become `legacy`. The plan's
`LEGACY_STANDALONE` vs `UNMANAGED_LEGACY` distinction formalises exactly this predicate.

### 3.3 Group key resolution — `modules/profiles/profile-groups.ts:321-366` (`resolveCurrentGroupKey`)

The displayed/authoritative group key today is **derived by intersection**, not stored:

* **Empty group** (`profileIds.length === 0`) → falls back to
  `profile_group_revisions.api_key_id` (`profile-groups.ts:328-339`), i.e. the historical
  author reference. A revoked author key therefore makes an empty group's read fail with
  `409 STATE_CONFLICT 'empty profile group API-key reference is missing'`.
* **Non-empty group** → `SELECT k.id … FROM api_keys k WHERE k.tenant_id=$1 AND k.status='ACTIVE'
  AND NOT EXISTS (membership of every current child)`. It demands **exactly one** candidate:

```
0 candidates  → 409 'no single ACTIVE tenant API key is a member of every current profile group child'
>1 candidates → 409 'multiple ACTIVE tenant API keys match …; refusing to choose one'
```

This is precisely the plan's "a revoked key can make group reads fail with 409" seam, and it
proves the today-model has **no root grant table**: the group's authority is an emergent
property of child memberships.

### 3.4 Write-side group coupling

`saveProfileGroupOn` requires a selected key and materialises it into children:

* `profile-groups.ts:673-674` — `loadSelectedKey(input.apiKey.apiKeyId)` must be `ACTIVE`,
  and must be in the group's tenant (403 otherwise). **A group cannot be created or saved
  without an ACTIVE API key.**
* `profile-groups.ts:701` — every child revision is authored with that key:
  `createChildRevision(..., key, ...)` → `profiles.createGroupChildRevision({apiKeyHash: key.hash})`
  → `appendRevision` re-resolves the key by hash (`profiles.ts:727-731`).
* `profile-groups.ts:722-729` — after a save, every **other** ACTIVE membership on the
  group's children is revoked (`profile_api_keys SET state='REVOKED'`). This is a silent
  shared-key destructor and must be inventoried as such (§7 F-03).
* `profile-groups.ts:730-738` — `profile_group_revisions.api_key_id` is written (**NOT NULL**).
* `rollbackProfileGroupOn` (`profile-groups.ts:805-807`) re-derives the key the same way and
  **`addMembership` re-grants it to every target child** (`:843`) — so a config rollback
  currently re-creates child memberships. The plan requires rollback to move only the
  config pointer.

---

## 4. Route inventory

Legend for **Target resolver after cutover**:

| Symbol | Meaning |
|---|---|
| `MODE→` | dispatch on server-side key mode (never on client input) |
| `ROOT_GRANT` | `profile_group_api_keys` ACTIVE grant **+** a unique current active member selector; **no** child-membership fallback |
| `LEGACY_MEMBERSHIP` | today's `profile_api_keys` membership resolver (`selectActiveRow`) |
| `LEGACY_NOPROFILE` | today's `mode:'legacy'` no-profile path |
| `OWNER_KEY` | operation/artifact owner projection (`operations.api_key_id`, `artifacts.upload_api_key_id`); unchanged |
| `NONE` | not key-authenticated (admin bearer/session or worker runtime grant) |

### 4.1 Public action / catalog / preflight (`x-api-key`)

| # | Route | Handler anchor | Current authority source | Target resolver after cutover |
|---|---|---|---|---|
| A1 | `POST /api/v1/docs/{ingest,extract,analyze,transform,generate,compare}` | `compat/legacy-http-mount.ts:271-280, 653-705` → `legacy-host-adapter.ts:115-202` → `submission.preflightLegacyWorkflow` (`submission.ts:595`) | `resolveApiKey` (ACTIVE) → `selectActiveRow` (ACTIVE `profile_api_keys` membership) at `preflightLegacyWorkflow`; re-validated in `submit` at `submission.ts:789-820` via `legacyExpectedProfile` CAS (`PROFILE_CHANGED`) | `MODE→` `ROOT_GRANT` / `LEGACY_MEMBERSHIP` / `LEGACY_NOPROFILE`; `CHILD_PROJECTION` unchanged. Body unchanged; no fingerprint |
| A2 | `POST /api/v1/docs/workflows` | `legacy-http-mount.ts:552-615` → `legacy-host-adapter.ts:205+` | `resolveApiKey` → membership via `preflightLegacyWorkflow` | same as A1 |
| A3 | `POST /api/v1/docs/workflows/schema` | `legacy-http-mount.ts:570-604` (`resolveLegacyWorkflowSchema`) + `submitLegacyWorkflow` | `resolveApiKey` → membership; workflow schema pin is `(tenant, slug)` scoped, **not** profile scoped | same as A1; workflow revision/digest must stay fail-closed |
| A4 | `POST /api/v1/businesses/:businessId/actions/:action` | `http/routes/public.ts:510-544` → `submission.submit` | `resolveApiKey` → `resolveEffectiveProfile` (`profiles.ts:1023`) → membership | `MODE→` as A1. Strict v1 `SubmissionSchema` unchanged |
| A5 | `GET /api/v1/services` (catalog) | `legacy-http-mount.ts:951-967` → `legacy-host-adapter.ts:541-571` | `resolveApiKey`; then **per (action, variant)** `resolveEffectiveProfile(apiKeyId, …)` and silently `continue`s on 403/404 (`legacy-host-adapter.ts:560-563`) | `MODE→`: catalog must resolve through the root grant for `GROUP_MANAGED`. A grant revoke must remove the sub-case. Note the current silent-skip behaviour hides authorization failures |
| A6 | Preflight (public) | **does not exist in v1** | — | v2 only: `POST /api/v2/profile-groups/:groupId/preview` (returns `resolutionFingerprint`) |
| A7 | `GET /api/v1/connectors/:id/test` (Connector probe) | `public.ts:279-288` → `modules/connectors/probe-authorization.ts:11-49` | `resolveApiKey` **+** inline SQL: `profile_active_revisions ⋈ profile_bindings ⋈ profile_api_keys(state='ACTIVE')` **and** `p.enabled=true` **and** `api_keys.status='ACTIVE'`; requires a binding whose `connectorId` matches. Explicit "no legacy fallback to the global deployment registry" (`:48`) | `MODE→` `ROOT_GRANT` for `GROUP_MANAGED`; grant revoke must deny new probes |
| A8 | `GET /api/v1/health`, `/health` | `server.ts:389` | none | `NONE` |

**Finding F-01:** v1 has **no public preflight route**. The plan's phrase
"public action, catalog/preflight" therefore maps to A1–A5 today and becomes real only with
PC-05's v2 preview. PC-05 should not assume a v1 preflight body to extend.

### 4.2 Connector / provider probe and workflow test

| # | Route | Handler anchor | Current authority source | Target resolver |
|---|---|---|---|---|
| B1 | Public Connector probe `GET /api/v1/connectors/:id/test` | see A7 | membership + enabled binding + `connectorId` match | `MODE→` `ROOT_GRANT` |
| B2 | Provider test `POST /api/internal/parity/provider-tests` | `internal-parity.ts:146-154` → `modules/connectors/provider-test.ts` | `requireWrite` (platform only) **then** per-invocation: `api_keys ACTIVE` (`provider-test.ts:187,230`) **+** `admin_local_user_api_key_grants` (`:194,235`) **+** `admin_local_user_profile_grants` (`:198,239`) **+** `profile_bindings ⋈ profile_api_keys(state='ACTIVE')` at the exact `(profileId, revision)` (`:204-209,297-306`) | `MODE→` `ROOT_GRANT`; **also** the locked-model rule at `submission.ts:533-537` must use effective (request-default-resolved) values |
| B3 | Provider-test admission seam | `submission.ts:492-594` (`admitProviderTest`) | `resolveEffectiveProfile` + `profile.profileId === input.profileId` + revision CAS (`PROFILE_CHANGED`) | same as B2 |
| B4 | Workflow test `POST /api/v1/admin/actions {action:'workflow.test'}` | `dispatcher.ts:580-588` → `modules/workflow-test/workflow-test.ts:18-88` | table gate `bearerRoles:['platform','tenant_operator']` / `cookieRoles:['admin','operator']` (`dispatcher.ts:149`); then `api_keys ACTIVE` (`workflow-test.ts:31`); for a **local USER** only, `preflightLegacyWorkflow` must be `pinned` + `assertAdminWorkbenchAdmissionScope` (`:57-82`) | `MODE→`; the local-USER branch becomes a root-grant check for `GROUP_MANAGED` |
| B5 | Admin Workbench test `POST /api/internal/admin-workbench/test-endpoint` | `internal-admin-workbench.ts:21-23` → `modules/admin-workbench/service.ts:162-222` | `resolveAdminActionAuthAsync` + CSRF; `verifyActiveKey` (`:117-119`); `preflightProfile` (`:132-140`); exact profileId match + revision CAS (`:176`); `assertAdminWorkbenchAdmissionScope` (`:67-93`) | `ROOT_GRANT` for explicit `apiKeyId`; **never choose the first key** |
| B6 | Admin Workbench prompt wizard `POST /api/internal/admin-workbench/prompt-wizard` | `internal-admin-workbench.ts:24-26` → `service.ts:224-270` | as B5 with action `generate` (`:248`) | as B5 |

### 4.3 Settings and artifacts

| # | Route | Handler anchor | Current authority source | Target resolver |
|---|---|---|---|---|
| C1 | `GET /api/v1/admin/settings` | `admin.ts:186-192` → `modules/settings/settings.ts:32-95` | admin principal (`resolveAdminPrincipal`) + `authorizeAuditTenantRead`; optional `apiKeyId`+`endpointSlug` then resolves the profile through **membership** (`settings.ts:10-15`, `PROMPT_BINDINGS_QUERY`) | admin unchanged; the key-scoped sub-read becomes `ROOT_GRANT` for `GROUP_MANAGED` |
| C2 | `POST /api/v1/admin/actions {action:'settings.revision.create|validate|apply|rollback'}` | `dispatcher.ts:543-565` → `modules/settings/revisions.ts` (`snapshot` at `:60-75`) | platform-only gate; `api_keys ACTIVE` (`revisions.ts:62-63`) **+** membership (`:64-69`) **+** `activeKeyCount` from membership (`:71`) | `ROOT_GRANT` for the profile map; keep the platform role gate |
| C3 | `POST /api/v1/admin/actions {action:'settings.prompt.update'}` | `dispatcher.ts:566-579` | platform-only gate; `connector_prompt_overrides` keyed by `(tenant, apiKeyId, endpointSlug)`; profile snapshot (§C2) | same as C2 |
| C4 | `GET /api/v1/artifacts/:id/download` | `public.ts:546-636` | `resolveApiKey` + tenant **+** `operations.api_key_id = key.id AND state='SUCCEEDED'` (output) or `submit_artifacts` membership of an owner operation (`:556-577`) | `OWNER_KEY` unchanged — **another key on the same group must not read it** |
| C5 | `POST /api/v1/uploads` | `public.ts:314-345` | `resolveApiKey` + tenant; binds `artifacts.upload_api_key_id` (`:336-340`); replay token namespaced by key (`:332`) | `OWNER_KEY` unchanged |
| C6 | `PUT /api/v1/uploads/:id/content` | `public.ts:294-313` → `requireOwnedUpload` (`:99-105`) | `upload_api_key_id = key.id`, `purpose='input'`, unlinked | `OWNER_KEY` unchanged |
| C7 | `POST /api/v1/uploads/:id/{complete,abort}` | `public.ts:346-372` | same owner fence; `part` → 501 | `OWNER_KEY` unchanged |
| C8 | `POST /api/internal/operations/uploads?tenantId&apiKeyId&fileName` | `internal-operations.ts:38-53` → `admin-operation-upload.ts:37-86` | admin auth + CSRF + `authorizeAuditTenantRead` + **explicit `apiKeyId` must be `ACTIVE` in tenant** (`admin-operation-upload.ts:52-53`); local-USER sessions additionally need `isLocalUserAssignedApiKey` (`internal-operations.ts:40-51`) | admin/owner unchanged; for `GROUP_MANAGED` the explicit key must still hold a current grant **only where the operation is new** — upload binding itself stays owner-keyed |
| C9 | Cross-tenant artifact fence | `artifacts` table owner columns | `upload_api_key_id` only set for `purpose='input'`; `output`/`intermediate` owner is the operation (dry-run §6.8) | unchanged |

### 4.4 Operation reads and owner projection

| # | Route | Handler anchor | Current authority source | Target resolver |
|---|---|---|---|---|
| D1 | `GET /api/v1/operations` (legacy `filter`/`page_size`/`page_token`) | `legacy-http-mount.ts:762-794` → `host.listLegacyOperations` | `resolveApiKey` + `tenant_id` + `api_key_id` fence (`legacy-host-adapter.ts:520-539`) | `OWNER_KEY` unchanged |
| D2 | `GET /api/v1/operations` (canonical keyset query) | `public.ts:385-404` | `resolveApiKey` + tenant + `apiKey.id` passed to `listOperationsPage` | `OWNER_KEY` unchanged |
| D3 | `GET /api/v1/operations/:id` (incl. `?wait=`) | `legacy-http-mount.ts:718-760` | `safePrincipal` + `loadOperation(id, tenantId, apiKeyId)` | `OWNER_KEY` unchanged |
| D4 | `DELETE /api/v1/operations/:id` | `legacy-http-mount.ts:721-731` | owner key + tenant | `OWNER_KEY` unchanged |
| D5 | `GET /api/v1/operations/:id/download` | `legacy-http-mount.ts:844-867` | owner key + tenant | `OWNER_KEY` unchanged |
| D6 | `POST /api/v1/operations/:id/cancel` | `legacy-http-mount.ts:807-816` → `host.cancelLegacy` | owner key + tenant | `OWNER_KEY` unchanged |
| D7 | `POST /api/v1/operations/:id/resume` (legacy body) | `legacy-http-mount.ts:818-842` | owner key + tenant | `OWNER_KEY` unchanged |
| D8 | `POST /api/v1/operations/:id/resume` (CAS body `{waitId,input,expectedStateVersion}`) | `public.ts:154-173, 118-133` | `resolveApiKey` + tenant; `apiKey.id` passed as the owner argument to `runtime.resumeOperation` | `OWNER_KEY` unchanged |
| D9 | `GET /api/v1/operations/:id/result` | `public.ts:482-508` | `resolveApiKey` + `WHERE tenant_id=$2 AND api_key_id=$3` (`:499-505`) | `OWNER_KEY` unchanged |
| D10 | Admin/internals operation reads | `internal-operations.ts:54-119` | admin principal/session + `requireResourceTenant` + local-user operation scope; `retry` additionally `principal.role === 'platform'` (`:77`) | `NONE` for key auth; retry re-authorization is §4.7 |
| D11 | Billing `GET /api/v1/billing/balance`, `/api/v1/billing/usage` | `legacy-http-mount.ts:871-948` | `resolveApiKey` + `principal.apiKeyId` (key identity only, **no profile/group**) | `NONE` (key-scoped, unaffected by cutover) |
| D12 | Usage `GET /api/v1/usage/summary`, `/api/v1/usage/events`, `/api/v1/usage` | `public.ts:176-273` | `api_keys` tenant **or** admin bearer with `authorizeAuditTenantRead`; `apiKeyId` filter is a query parameter, not authority | `NONE` (tenant-scoped) |

**Owner projection rule confirmed:** every D-route fences on the **stored owner key**
(`operations.api_key_id`), never on "same group". This matches the plan's requirement that a
different key on the same group cannot read or upload to the operation.

### 4.5 Key lifecycle mutations

| # | Surface | Handler anchor | Current authority source | Idempotency | Target |
|---|---|---|---|---|---|
| E1 | `POST /api/v1/admin/actions {action:'apikey.issue'}` | `dispatcher.ts:839-931` | table `bearerRoles:['platform']`, `cookieRoles:['admin']` (`:159`); `assertRoleActionTenant(auth,'apikey.issue',tenantId)` (`:866`) | `executeIdempotent` + `admin_idempotency` | add explicit key mode; **cannot attach profiles today** (params are `tenantId`,`apiKey`,optional `name`/`prefix`) — so no child-profile inference is possible here. Raw key returned once (`:926`) |
| E2 | `POST /api/v1/admin/actions {action:'apikey.revoke'}` | `dispatcher.ts:932-990` | table gate (`:160`); `assertRoleActionTenant` on the **stored** tenant (`:953`) | yes | must become **global revoke** = `api_keys.status` + revoke every ACTIVE root grant in one transaction + bump each `access_version` |
| E3 | `POST /api/v1/admin/actions {action:'apikey.attach'}` | `dispatcher.ts:991-1124` | table gate (`:166`); key tenant fence (`:1010`); **explicit group-child guard** `409 STATE_CONFLICT 'profile group children cannot be edited through API-key membership actions'` (`:1034-1036`, re-checked under `FOR UPDATE` at `:1074-1076`); overlap guard (`:1077-1091`) | yes | after cutover: **`409 PROFILE_GROUP_V2_REQUIRED`** for `GROUP_GRANT` groups; child membership must not be re-created |
| E4 | `POST /api/v1/admin/actions {action:'apikey.rotate'}` | `dispatcher.ts:1125-1264` | table gate (`:167`); tenant fence (`:1160`); selector-then-key lock order (`:1180-1181`) | yes | **mint new key ID, copy only the current same-group root grant** (or exact legacy memberships); never add functions/profiles |
| E5 | `POST /api/v1/admin/actions {action:'apikey.bind-profile'}` | `dispatcher.ts:781-838` | table gate (`:154`); tenant fence only for `tenant_operator` (`:788-805`); then `profiles.createRevision({apiKeyHash})` → `appendRevision` group-owner guard (`profiles.ts:767-777`) | yes | must reject grouped child profile IDs (`PROFILE_GROUP_V2_REQUIRED`) |
| E6 | `POST /api/internal/parity/api-keys?tenantId` (**issue**) | `internal-parity.ts:284-297` → `identity/api-keys.ts:179-220` | `requireWrite` (platform, CSRF for cookie) + `scopedTenant` + `actorForKey` → `requireAdmin` (`api-keys.ts:348-351`) | advisory lock + `admin_api_key_mutations` (`:189-193, 211-213`) | **this is the only issue path that accepts `profileIds`** and inserts ACTIVE memberships (`api-keys.ts:208-210`) with only an existence check (`profilesExistForClient`, `:103-109`, **no `group_id` filter**). Plan §6 requires it to reject grouped child profile IDs |
| E7 | `PATCH /api/internal/parity/api-keys/:keyId` (**note**) | `internal-parity.ts:308-311` → `api-keys.ts:222-244` | platform + `IDENTITY_VERSION_CONFLICT` CAS; `protectGlobal` | — | unchanged |
| E8 | `POST /api/internal/parity/api-keys/:keyId/rotate` | `internal-parity.ts:312-315` → `api-keys.ts:246-312` | platform + version CAS; copies `profile_api_keys` ACTIVE rows verbatim (`:274-277`), then revokes old key globally (`:299-302`) and **moves local-user key grants** (`:289-298`) | `admin_api_key_mutations` | same rule as E4. Note this path **copies whatever memberships exist**, including group children, with no group semantics |
| E9 | `POST /api/internal/parity/api-keys/:keyId/revoke` | `internal-parity.ts:316-319` → `api-keys.ts:314-343` | platform + version CAS; revokes ACTIVE memberships (`:326`) and deletes local-user key grants (`:327-330`) | — | must additionally revoke root grants + bump `access_version` |
| E10 | BFF key minting | `app/admin/bff/key-minting.ts:18-31` | server mints `du_<32 random bytes>` for `apikey.issue` / `apikey.rotate` only when absent | — | group-key issue must mint the same way and return `Cache-Control: no-store` |
| E11 | BFF parity proxy | `app/admin/bff/parity.ts:250-262` | session/CSRF + `credentialFor` — `api-key-list|issue|note|rotate|revoke` → the E6–E9 routes | — | unchanged routing; semantics from E6–E9 |
| E12 | BFF identity proxy | `app/admin/bff/identity.ts:158-163, 224-238, 267, 308` | platform-only mutations (`:187-196`), CSRF before role | — | unchanged |

**Naming divergence (finding F-02).** The plan refers to `identity.issue`. **No
`identity.issue` action string exists in source.** Key issuance lives on exactly two paths:
the dispatcher action **`apikey.issue`** (E1) and **`POST /api/internal/parity/api-keys`**
(E6). By contrast `/api/internal/parity/identity/*` manages users and profile/key
*assignments*, not keys. PC-04 should reconcile by mapping the plan term onto E1+E6 and
document the mapping in the acceptance matrix, rather than inventing a new action name.

### 4.6 Profile mutations

| # | Surface | Handler anchor | Current authority source | Target |
|---|---|---|---|---|
| F1 | `POST /api/v1/admin/actions {action:'profile.upsert'}` | `dispatcher.ts:1265-1307` → `modules/admin-actions/profile-actions.ts` → `profiles.createRevision({apiKeyHash})` | platform gate; group-child guard `409 … 'edit it through the profile group'` (`profile-actions.ts:289-295`, `profiles.ts:767-777`) | `409 PROFILE_GROUP_V2_REQUIRED` for `GROUP_GRANT`; new group-owned append path needs **no** key hash |
| F2 | `POST /api/v1/admin/actions {action:'profile.publish'}` | `dispatcher.ts:1308-1345` → `runProfilePublish` | platform gate; same group guard | idem |
| F3 | `POST /api/v1/admin/actions {action:'profile.rollback'}` | `dispatcher.ts:1346-1383` → `runProfileRollback` | platform gate; same group guard | idem |
| F4 | `POST /api/v1/admin/profile-bindings` | `admin.ts:429-501` | admin bearer; `tenant_operator` → 403 (`:444-450`); body carries **raw `apiKey`**, hashed server-side (`:474`) | must reject grouped children; v1 route stays read-only-ish for converted cohorts |
| F5 | `GET /api/v1/admin/profile-groups` / `/:groupId` | `http/routes/admin-profile-groups.ts:98-136` → `getProfileGroup`/`listProfileGroups` → `readGroupOn` → `resolveCurrentGroupKey` | platform or scoped principal (`authorizeAuditTenantRead`) | v1 becomes **read-only compatibility**: project singular `apiKey` only when exactly one ACTIVE grant exists, else `409 PROFILE_GROUP_V2_REQUIRED` |
| F6 | `POST /api/v1/admin/profile-groups`, `PUT …/:groupId` | `admin-profile-groups.ts:109-156` → `saveProfileGroup` | `requirePlatform`; body requires `ProfileGroupSaveSchema.apiKey` | v1 write → `409 PROFILE_GROUP_V2_REQUIRED` after cutover |
| F7 | `POST /api/v1/admin/profile-groups/:groupId/rollback` | `admin-profile-groups.ts:159-179` → `rollbackProfileGroup` | `requirePlatform`; **re-derives key** and re-grants children (`profile-groups.ts:805-807, 843`) | v2 only; must not touch grants/access version |
| F8 | `GET /api/v1/admin/businesses/:id/versions/:version/functions` | `admin-profile-groups.ts:90-96` → `getBusinessFunctionCatalog` | `requirePlatform` | unchanged (catalog is immutable-manifest data); v2 adds its own catalog route |
| F9 | `GET /api/v1/admin/profiles` (list) | `admin.ts:952-1016` | admin principal + tenant scope | reads `profile_api_keys` counts (`admin-read/profile-list.ts:84`) — must keep working with **zero** keys |
| F10 | `GET /api/v1/admin/profiles/:b/:v/:name` (detail) | `admin.ts:1018-1149` | admin principal + scope; returns `apiKeyId` write identity (`:1141`) | must not expose a guessed key for a keyless group child |
| F11 | `GET /api/v1/admin/profiles/:b/:v/:name/api-keys` | `admin.ts:1156-1197` → `admin-read/profile-api-keys.ts:62-70` | admin principal + scope | keep readable with zero rows |
| F12 | `POST /api/v1/admin/profiles/:b/:v/:name/workflows` | `admin.ts:1201-1260` | admin principal; `tenant_operator` → 403 | group functions reject non-null `workflowRevision` today (`profile-groups.ts:233-235`) — PC-03 must resolve workflows via the registry |
| F13 | **Self-service reads** `GET /admin/api/profiles/assigned[/…]` (BFF) | `app/admin/bff/profiles.ts` → `self-service.ts:367-444`, `:446-542` | live local-USER session (`assertCurrentLocalActor`, `self-service.ts:179-188`) + `admin_local_user_profile_grants` + **`profile_api_keys` ACTIVE** + `profile_names.group_id IS NULL` (list, `:459`) | `LEGACY_STANDALONE` only; group children stay out of self-service |
| F14 | **Self-service edit** `PATCH /admin/api/profiles/:b/:v/:name/self-service` | `bff/profiles.ts:211-271` → `self-service.ts:544-665` | CSRF + local actor + assignment + **group guard `409 'this profile is owned by a profile group; edit it through the profile group'`** (`self-service.ts:316`) + revision CAS + idempotency | after cutover, converted children → `409 PROFILE_GROUP_V2_REQUIRED` |
| F15 | Self-service group visibility | `self-service.ts:331-365` (`canReadAssignedProfileGroup`) | intersection of child-profile grants **+** selected key grant **+** ACTIVE membership on **every** child (`:346-364`) + `n.group_id IS NOT NULL` | becomes root-grant based; today it is explicitly "does not create group grants" |
| F16 | BFF attach/rotate | `bff/profiles.ts:386-421` | CSRF/platform + `resolveProfileId` server-side from the URL tuple, then dispatcher `apikey.attach`/`apikey.rotate` | same rule as E3/E4 |
| F17 | BFF profile-groups proxy | `bff/profile-groups.ts:95-291` | session + platform gate + CSRF; local USER **read-only** and filtered by `canReadAssignedProfileGroup` (`:235-264`) | must speak v2; local USER read must not require a key to exist |
| F18 | `POST /admin/api/profiles/test-endpoint` (BFF) | `bff/profiles.ts:370-372` → upstream `/api/v1/admin/profile-test-endpoint` | platform + CSRF | **Finding F-04:** that upstream path does not exist in the orchestrator route table (no match in `admin.ts` or any `http/routes/*`). The real test-endpoint surfaces are `/api/internal/admin-workbench/test-endpoint` and `apikey`-less `provider-tests`. The BFF call currently 404s; out of PC-00 scope to fix, but PC-08 must not build on it |

### 4.7 Retry

| # | Surface | Handler anchor | Current authority source | Target |
|---|---|---|---|---|
| G1 | `POST /api/internal/operations/:id/retry` | `internal-operations.ts:73-86` (`principal.role !== 'platform'` → 403 at `:77`) → `dispatcher.ts:704-742` → `modules/operations/retry.ts:11-177` | platform admin only. Inside `retryOperation`: tenant fence (`:19-20`), terminal-state check (`:21-23`), **coalescing replay before any key check** (`:25-28` and again at `:107-112`), `assertKeySpendAvailable(op.api_key_id)` (`:37`), business admission (`:105-119`), then insert | **must re-authorize before the coalesced replay** and before insert: original key `ACTIVE` + current matching root grant (`GROUP_MANAGED`) + enabled function + current business/version readiness. Today there is **no profile/grant check at all** and no `enabled` endpoint check — only spend + business admission |

**Finding F-05 (high).** `retryOperation` never consults `profile_active_revisions`,
`profile_bindings.enabled`, or the key's status. It only calls `assertKeySpendAvailable` and
`readBusinessAdmission`. A revoked key, a removed grant, or a disabled endpoint can all be
retried today as long as an admin asks. This is exactly the gap PC-07 must close, and the
coalescing path at `:25-28` returns a sibling operation **before** any of those checks.

### 4.8 Route families that are not `x-api-key` (for completeness of the route table)

| Family | Prefix | Auth | Notes |
|---|---|---|---|
| Worker runtime | `/api/runtime/v1/**` | `Authorization: Bearer` worker/platform identity + method-scoped artifact grants (`http/routes/runtime.ts:27-55, 279-330, 379-490`) | not key-auth; unaffected by cutover |
| Internal ops/usage/compose/cost/incidents/maintenance/settings/workflow-import/service-runtime | `/api/internal/**` | admin bearer/session + `ingressAudience === 'internal'` | listed per §4.3–§4.4 where they touch keys |
| Admin | `/api/v1/admin/**` | `resolveAdminPrincipal` bearer or cookie role + CSRF | listed where they touch keys/profiles |
| Legacy facade is mounted **before** the canonical routes inside `handlePublicRoutes` (`public.ts:406-476`), and declines admin-bearer callers (`legacy-http-mount.ts:715`) | — | — | ordering matters if a v2 route is added under `/api/v1/` |

---

## 5. Grant / membership reader fan-out

Every place that reads `profile_api_keys` (the table the root grant ledger will shadow).
This is the complete list produced by a whole-`src` grep; PC-03/PC-04/PC-05 must decide each.

| Reader | Anchor | Used by |
|---|---|---|
| `selectActiveRow` | `profiles.ts:441-472` | A1–A4 admission; the central resolver |
| membership snapshot for mutation locks | `profiles.ts:580` | `profile-actions.ts`, group save |
| `assertSelectorAvailable` | `profiles.ts:664-682` | `apikey.attach`, `apikey.rotate`, group save |
| `listActiveMemberships` | `profiles.ts:1113-1134` | rotation inheritance |
| `revokeMemberships` | `profiles.ts:1126-1134` | rotation, revoke |
| group intersection resolver | `profile-groups.ts:341-355` | F5, F7, §3.3 |
| group ambiguity check | `profile-groups.ts:246-263` | group save/rollback |
| Connector probe | `probe-authorization.ts:26-36` | A7 |
| Provider test (2 sites) | `provider-test.ts:204-209, 297-306` | B2 |
| Key lifecycle (3 sites) | `identity/api-keys.ts:115, 160, 275` | E6, E8 |
| Profile list key count | `admin-read/profile-list.ts:84` | F9 |
| Profile key page | `admin-read/profile-api-keys.ts:62-70` | F11 |
| Self-service (6 sites) | `self-service.ts:302, 356, 402, 422, 461` | F13, F15 |
| Settings effective read | `settings/settings.ts:10-15` | C1 |
| Settings revision snapshot | `settings/revisions.ts:64-71` | C2 |
| Cost alert recipients (3 sites) | `cost-alerts/service.ts:527, 563, 569` | admin alerting; read-only over memberships |
| Profile mutation source check | `profile-actions.ts:102` | F1–F3 |

**Reader behaviour that must be preserved:** every one of these treats a `REVOKED`
membership as absent, and `selectActiveRow` additionally treats *any historical row* as
proof that the key is profile-managed. Adding the root grant must not introduce a reader
that falls back to "no membership ⇒ unmanaged".

---

## 6. Data inventory (dry-run)

### 6.1 Environment

| Item | Value |
|---|---|
| Server | PostgreSQL 16.11 (x86_64-pc-linux-musl) |
| Database | `du_orchestrator_dev` @ `127.0.0.1:15433` (from `du-rework/.env.orchestrator.local`) |
| Access | `pg` 8.23.0 via a read-only Node script; `SELECT` only |
| Scope caution | This is a **local dev** dataset, not production. Results below are evidence that the queries and the classification logic work; they are not a production cohort census |

### 6.2 Topology

```
api_keys                    3   (3 ACTIVE, 0 REVOKED)
profile_api_keys            4   (4 ACTIVE, 0 REVOKED)
profile_groups              1
profile_group_revisions     1
profile_group_members       2
profile_names               3   (2 group children, 1 standalone)
profile_active_revisions    3
operations                  4   (all SUCCEEDED/FAILED, 0 in flight)
artifacts                   6
admin_local_users           0
admin_local_user_api_key_grants 0
connector_prompt_overrides  0
settings_streams            0
```

### 6.3 The one group, and why the intersection resolver still works

| group_id | name | tenant | active_revision | author key (`profile_group_revisions.api_key_id`) | key status |
|---|---|---|---|---|---|
| `5d5dc4ac-2db0-4d5a-950f-008537e51f2d` | `test` | `00000000-…-0001` | 1 | `00000000-…-0099` (prefix `dev-fallback`, name `NULL`) | ACTIVE |

Children (both `document-core@1.1.0`, action `ingest`):

| child profile | endpoint slug | binding rev | active pointer | ACTIVE keys |
|---|---|---|---|---|
| `1193317a-…` | `ingest:parse` | 1 | 1 | 1 |
| `56a3b53c-…` | `ingest:ocr` | 1 | 1 | 1 |

`resolveCurrentGroupKey` intersection probe returns **exactly one** candidate
(`00000000-…-0099`), so the current read path succeeds for this group. Its
`profile_group_revisions.api_key_id` also equals that key, so the empty-group fallback would
agree — but **only by coincidence of this dataset**, not by construction.

### 6.4 Shared keys between groups

| Query | Result |
|---|---|
| keys that author revisions of >1 group | **0** |
| keys whose ACTIVE memberships span >1 `group_id` | **0** |
| keys whose ACTIVE memberships mix standalone + group children | **0** |

**No shared-key-across-groups cohort exists in this dataset.** The conversion gate still
needs the query (§9) because production may differ.

### 6.5 Groups without a key

| Query | Result |
|---|---|
| groups whose ACTIVE revision key is missing or not ACTIVE | **0** |
| groups with 0 members | **0** |
| groups with 0 ACTIVE membership rows on their children | **0** |

The current code **cannot create** the zero-key case: `saveProfileGroupOn` requires
`input.apiKey.apiKeyId` (`profile-groups.ts:673`), and `ProfileGroupSaveSchema` requires a
singular `apiKey` (plan §"Current implementation seams"). The only way to reach "zero keys"
today is to revoke the author key / all memberships *after* the fact, which produces the
409 paths in §3.3. **That is precisely the cohort PC-02/PC-03 must be able to represent and
PC-00 cannot manufacture** — so "zero-key group" is a *schema* gap, not a data cohort gap.

### 6.6 Revoked membership tombstones

| Query | Result |
|---|---|
| keys with only `REVOKED` memberships | **0** |
| keys with no membership at all (never-membered) | **0** |
| keys that authored a group revision but have no membership | **0** |

Consequence for the classification rules (§7): in this dataset **no key qualifies for
`UNMANAGED_LEGACY`** and no key is a tombstone-only `LEGACY_STANDALONE`. Both cohorts need
fixtures before the gate can be exercised.

### 6.7 Selector overlap — and the false-positive trap

| Query | Result |
|---|---|
| same key, same `(business, version, action)`, >1 ACTIVE profile | 1 row — key `…0099`, `document-core@1.1.0`, `ingest`, slugs `[ingest:ocr, ingest:parse]` |
| same, but after including `endpoint_slug` in the key | profiles are distinct **because the slugs differ** |
| generic (`NULL` slug) + specific slug overlap for the same key | **0** |

**Finding F-06 (important for the conversion gate).** A naive detector that groups only by
`(api_key_id, business_id, business_version, action)` reports the group itself as a
"shared/across-profile key". The correct discriminator must include `endpoint_slug`, and
must additionally treat "multiple children of one group" as the expected group shape, not as
sharing. Using the naive query as a cutover gate would block every group in the system.

### 6.8 Operation owner projection

| Query | Result |
|---|---|
| operations | 4 |
| `api_key_id IS NULL` | **0** |
| owner key row missing | **0** |
| owner key not ACTIVE | **0** |
| in-flight (non-terminal, not deleted) | **0** |
| operations linked to a group child profile | **0** |
| artifacts with `purpose='input'` and `upload_api_key_id IS NULL` | **0 / 2** |
| artifacts with `purpose IN ('output','intermediate')` and `upload_api_key_id IS NULL` | **4 / 4** (by design — owned via `operations.api_key_id`) |

Owner-projection conclusion: reads are fenced on the stored owner key (`public.ts:499-505`,
`:556-577`, `legacy-host-adapter.ts:520-539`). The dry-run confirms no operation currently
depends on a group child profile, so **no owner ID needs rewriting** during a conversion —
matching the plan's "Do not rewrite operation/upload owner IDs during group conversion".

### 6.9 Schema state versus PC-02 requirements

Confirmed present (`information_schema`, live):

| Requirement (plan §"Settled data and authorization model") | Current state |
|---|---|
| `profile_groups.auth_mode`, `auth_authority`, `access_version` | **absent** |
| `api_keys.key_mode` (or equivalent) | **absent** |
| `profile_group_api_keys` root-grant ledger | **absent** (`to_regclass(...) = null`) |
| `profile_group_revisions.api_key_id` nullable | **NOT NULL** (`0067_profile_groups.sql:21`) |
| `profile_bindings.api_key_id` nullable | **NOT NULL** |
| `profile_names.api_key_id` nullable | **NOT NULL** |
| `profile_bindings.request_defaults` | **absent** |
| legacy all-row name uniqueness | present as `profile_names_identity UNIQUE (tenant_id, api_key_id, business_id, business_version, action, profile_name)` — note it is **key-scoped**, so the plan's "replace with a legacy partial unique index for standalone names and a group-scoped unique index" changes the uniqueness *semantics*, not just the index |
| tenant-safe composite FKs on grants | n/a (no table yet) |
| `profile_api_keys` shape | `(profile_id, api_key_id, tenant_id, state CHECK IN ('ACTIVE','REVOKED'), created_at, revoked_at)`; **no** unique on `(api_key_id)` across state, so "one key ↔ at most one group" needs new enforcement |

Indexes present that the grant design must coexist with:
`profile_api_keys_key_lookup (api_key_id, state)`,
`profile_api_keys_tenant_profile (tenant_id, profile_id)`,
`profile_group_members_child (profile_id, binding_revision)`,
`profile_bindings_key_action (api_key_id, business_id, business_version, action, revision DESC)`,
`profile_names_group_id (group_id, profile_id) WHERE group_id IS NOT NULL`.

### 6.10 Migration ledger and the next free prefix

| Item | Value |
|---|---|
| `schema_migrations` rows | 65 (all `checksum_provenance = 'reviewed-baseline'`) |
| highest applied | sequence 68 / `0068_version_admission_cutover_20261013.sql` |
| migration files on disk | 66 |
| file present but **not applied** | **`0069_required_data.sql`** (ledger has no `0069%` row) |
| **next free numeric prefix for PC-02** | **`0070`** |

**Finding F-07 (blocking for PC-02 planning).** The PREP-PC-02 lane assumed `0069`. That
prefix is already occupied on disk by `0069_required_data.sql`, which is unapplied. PC-02
must use `0070` (or take a coordinator decision to fold into 0069, which would violate the
"additive new file" rule of the plan). Recorded here so the choice is made once.

---

## 7. Classification rules (binding confirmations for PC-02…PC-04)

### 7.1 No grouping by name or prefix — **confirmed and honoured**

The dry-run deliberately included the tempting shortcuts:

* **Names:** the group's author key is named `NULL` (only `prefix = 'dev-fallback'`). Two
  other keys share `prefix = 'du_H'` but belong to a standalone profile and are *not* group
  members. Matching on `name`/`prefix` would have produced both a false negative (the group
  key has no name) and a false positive (the two `du_H` keys). **No classification in this
  report, and none recommended to PC-02, uses `api_keys.name` or `api_keys.prefix`.**
* **Group child profile names** are machine-generated
  `__du_group_<groupIdHex>_<sha256(identity)[:32]>` (`profile-groups.ts:114-117`). They look
  deterministic and are tempting to parse. **They must not be parsed for authority.** They
  are a uniqueness device, not an ownership record; ownership is `profile_names.group_id`.
* **Key prefix `du_`** is the minting shape for *all* keys (E1/E4/E10,
  `key-minting.ts:21-23`), so it carries no authority signal whatsoever.

### 7.2 `UNMANAGED_LEGACY` is only for deterministic never-member keys

Acceptance criterion (must be implemented as a **negative** proof, not a heuristic):

```
UNMANAGED_LEGACY(k)  ⇒  k has ZERO rows in profile_api_keys (any state)
                    AND k has ZERO rows as profile_group_revisions.api_key_id
                    AND k has ZERO rows as profile_names.api_key_id
                    AND k has ZERO rows as profile_bindings.api_key_id
                    AND k has ZERO rows in profile_group_api_keys (post-PC-02, any state)
                    AND no other association table in the ledger references k
```

The code already contains the crucial half of this proof at `profiles.ts:464-472`
("A key that has ever been attached to a Profile must not become a legacy key when its last
active membership is revoked"), which is why §6.6's "tombstone-only" cohort is
`LEGACY_STANDALONE` and never unmanaged. **PC-02 must not weaken this predicate**, and must
add the four group-side probes above, because today a key could be a group revision author
with no membership row (0 rows in this dataset, but structurally possible).

### 7.3 Ambiguity stays fenced

* A key with any historical membership **stays `LEGACY_STANDALONE`** even with zero ACTIVE
  memberships (rotate must preserve that mode — plan §5).
* A group that fails any unambiguous-conversion proof **stays `CHILD_PROJECTION`** and
  blocks conversion. Do not reclassify to make a migration pass.
* Shared-key cohorts require an explicit replacement key / client migration; they are never
  auto-split. Note `saveProfileGroupOn` already silently revokes "other" child memberships
  (`profile-groups.ts:722-729`) — a shared key that is currently working could be destroyed
  by an unrelated group save. **Finding F-03 (high):** this is an existing data-loss path
  that PC-03 must either remove or gate behind the conversion proof.

---

## 8. Findings register (for downstream packages)

| ID | Severity | Finding | Owner |
|---|---|---|---|
| F-01 | info | v1 has **no public preflight route**; catalog is `GET /api/v1/services` only | PC-05 |
| F-02 | low | Plan's `identity.issue` has no source equivalent; issuance is `apikey.issue` (dispatcher) + `POST /api/internal/parity/api-keys` | PC-04 (map, don't rename) |
| F-03 | **high** | Group save/rollback revokes ACTIVE memberships of "other" keys on children (`profile-groups.ts:722-729`, `:864-870`) and rollback re-grants the derived key (`:843`) — a live shared-key data-loss path and a grant resurrection path | PC-03 |
| F-04 | medium | BFF proxies to `/api/v1/admin/profile-test-endpoint`, which does not exist in the route table (`bff/profiles.ts:371`) | PC-08 |
| F-05 | **high** | `retryOperation` performs **no** profile/grant/key-status/endpoint-enabled check, and the coalesced replay path returns before any authorization (`retry.ts:25-28`) | PC-07 |
| F-06 | **high** | Naive `(key, business, version, action)` sharing detector flags every group; the gate must include `endpoint_slug` + group ownership | PC-02 (gate SQL) |
| F-07 | medium | Next free migration prefix is `0070`, not `0069` (`0069_required_data.sql` exists, unapplied) | PC-02 |
| F-08 | medium | `POST /api/internal/parity/api-keys` accepts `profileIds` and inserts ACTIVE memberships with only an existence check — no `group_id` filter (`api-keys.ts:103-109, 208-210`) | PC-04 |
| F-09 | medium | `identity/api-keys.ts` rotate copies memberships verbatim and has no group-grant semantics (`:274-287`) | PC-04 |
| F-10 | low | Legacy catalog silently drops sub-cases on 403/404 (`legacy-host-adapter.ts:560-563`), so an authorization failure is indistinguishable from "not offered" | PC-05 |
| F-11 | low | `PROFILE_CHANGED` is already used by legacy admission for a drift race (`submission.ts:813-820`); v2 stale-fingerprint 409 must reuse the code without inheriting the legacy message | PC-01/PC-05 |
| F-12 | low | Fast-fail status today is `409 STATE_CONFLICT` for group-child mutation guards; the plan requires `409 PROFILE_GROUP_V2_REQUIRED` after cutover — three distinct sites (`dispatcher.ts:1035`, `profiles.ts:773`, `self-service.ts:316`) plus `profile-actions.ts:294` | PC-03/PC-04 |

---

## 9. Dry-run query pack (hand this to PC-02)

Read-only; each query is safe to run against production. `:g` = the candidate group id.

```sql
-- G1. Full cohort census (run first; drives every gate decision)
SELECT g.group_id, g.tenant_id, g.name, g.active_revision,
       r.api_key_id AS author_key, k.status AS author_key_status, k.name AS author_key_name,
       (SELECT count(*) FROM profile_group_members m
         WHERE m.group_id=g.group_id AND m.group_revision=r.revision) AS members,
       (SELECT count(*) FROM profile_group_members m
          JOIN profile_api_keys pk ON pk.profile_id=m.profile_id AND pk.state='ACTIVE'
         WHERE m.group_id=g.group_id AND m.group_revision=r.revision) AS active_membership_rows
  FROM profile_groups g
  LEFT JOIN profile_group_revisions r ON r.group_id=g.group_id AND r.revision=g.active_revision
  LEFT JOIN api_keys k ON k.id=r.api_key_id
 ORDER BY g.tenant_id, g.name;

-- G2. Groups with 0 children or 0 active memberships (zero-key candidates)
SELECT g.group_id, g.name, r.revision,
       (SELECT count(*) FROM profile_group_members m
         WHERE m.group_id=g.group_id AND m.group_revision=r.revision) AS members,
       (SELECT count(*) FROM profile_group_members m
          JOIN profile_api_keys pk ON pk.profile_id=m.profile_id AND pk.state='ACTIVE'
         WHERE m.group_id=g.group_id AND m.group_revision=r.revision) AS active_rows
  FROM profile_groups g
  LEFT JOIN profile_group_revisions r ON r.group_id=g.group_id AND r.revision=g.active_revision;

-- G3. SHARED KEY ACROSS GROUPS (blocker if non-empty)
SELECT r.api_key_id, count(DISTINCT r.group_id) AS group_count,
       array_agg(DISTINCT r.group_id) AS group_ids
  FROM profile_group_revisions r
 GROUP BY r.api_key_id HAVING count(DISTINCT r.group_id) > 1;

-- G4. SHARED KEY VIA MEMBERSHIP ACROSS GROUPS (blocker if non-empty)
SELECT m.api_key_id, count(DISTINCT n.group_id) AS distinct_groups,
       array_agg(DISTINCT n.group_id) AS groups
  FROM profile_api_keys m JOIN profile_names n ON n.profile_id=m.profile_id
 WHERE n.group_id IS NOT NULL AND m.state='ACTIVE'
 GROUP BY m.api_key_id HAVING count(DISTINCT n.group_id) > 1;

-- G5. KEY MIXING STANDALONE + GROUP CHILDREN (blocker if non-empty)
SELECT m.api_key_id,
       count(*) FILTER (WHERE n.group_id IS NULL)     AS standalone_profiles,
       count(*) FILTER (WHERE n.group_id IS NOT NULL) AS group_child_profiles
  FROM profile_api_keys m JOIN profile_names n ON n.profile_id=m.profile_id
 WHERE m.state='ACTIVE'
 GROUP BY m.api_key_id
HAVING count(*) FILTER (WHERE n.group_id IS NULL) > 0
   AND count(*) FILTER (WHERE n.group_id IS NOT NULL) > 0;

-- G6. Selector overlap that actually collides (endpoint_slug aware — cf. F-06)
SELECT api_key_id, business_id, business_version, action,
       coalesce(endpoint_slug,'<generic>') AS slug, count(DISTINCT profile_id) AS profiles
  FROM (SELECT m.api_key_id, p.business_id, p.business_version, p.action,
               p.endpoint_slug, p.profile_id
          FROM profile_api_keys m
          JOIN profile_active_revisions a ON a.profile_id=m.profile_id
          JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
         WHERE m.state='ACTIVE') s
 GROUP BY api_key_id, business_id, business_version, action, endpoint_slug
HAVING count(DISTINCT profile_id) > 1;

-- G7. Generic + specific overlap for one key (real ambiguity)
SELECT api_key_id, business_id, business_version, action
  FROM (SELECT m.api_key_id, p.business_id, p.business_version, p.action,
               count(*) FILTER (WHERE p.endpoint_slug IS NULL)     AS generic,
               count(*) FILTER (WHERE p.endpoint_slug IS NOT NULL) AS specific
          FROM profile_api_keys m
          JOIN profile_active_revisions a ON a.profile_id=m.profile_id
          JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
         WHERE m.state='ACTIVE'
         GROUP BY m.api_key_id, p.business_id, p.business_version, p.action) x
 WHERE x.generic > 0 AND x.specific > 0;

-- G8. Tombstone-only keys  => LEGACY_STANDALONE (never UNMANAGED)
SELECT k.id, k.tenant_id, k.status,
       count(*) FILTER (WHERE m.state='ACTIVE')  AS active_m,
       count(*) FILTER (WHERE m.state='REVOKED') AS revoked_m
  FROM api_keys k JOIN profile_api_keys m ON m.api_key_id=k.id
 GROUP BY k.id, k.tenant_id, k.status
HAVING count(*) FILTER (WHERE m.state='ACTIVE') = 0;

-- G9. UNMANAGED_LEGACY candidates: negative proof over every association table
SELECT k.id, k.tenant_id, k.status, k.name, k.prefix
  FROM api_keys k
 WHERE NOT EXISTS (SELECT 1 FROM profile_api_keys m           WHERE m.api_key_id=k.id)
   AND NOT EXISTS (SELECT 1 FROM profile_group_revisions r   WHERE r.api_key_id=k.id)
   AND NOT EXISTS (SELECT 1 FROM profile_names n             WHERE n.api_key_id=k.id)
   AND NOT EXISTS (SELECT 1 FROM profile_bindings b          WHERE b.api_key_id=k.id);

-- G10. Operation owner projection integrity
SELECT count(*) AS operations,
       count(*) FILTER (WHERE api_key_id IS NULL) AS null_owner,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id=o.api_key_id)) AS owner_key_missing,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM api_keys k WHERE k.id=o.api_key_id AND k.status<>'ACTIVE')) AS owner_key_not_active,
       count(*) FILTER (WHERE o.deleted_at IS NULL AND o.state NOT IN
             ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','EXPIRED')) AS inflight
  FROM operations o;

-- G11. Which patches are blocked by active operations? (block, don't mutate)
SELECT n.group_id, count(DISTINCT o.id) AS ops
  FROM profile_names n JOIN operations o ON o.profile_id=n.profile_id
 WHERE n.group_id IS NOT NULL AND o.deleted_at IS NULL
 GROUP BY n.group_id;

-- G12. Name collisions (legacy index is key-scoped — cf. §6.9)
SELECT tenant_id, profile_name, count(*) FROM profile_names
 GROUP BY tenant_id, profile_name HAVING count(*) > 1;

-- G13. Grant-ledger preconditions
SELECT to_regclass('public.profile_group_api_keys') AS grant_table,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_name='profile_groups'
           AND column_name IN ('auth_mode','auth_authority','access_version')) AS group_cols,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_name='profile_group_revisions' AND column_name='api_key_id') AS group_rev_key_nullable;
```

**Gate reading (proposed, for PC-02 to ratify):**

* G3/G4/G5/G7 non-empty → conversion **blocked** for the affected groups/keys until an
  explicit replacement-key/client-migration decision is recorded.
* G2 rows with `members = 0` or `active_rows = 0` → group is convertible to `GROUP_GRANT`
  with **zero** grants (the new model's headline case), *provided* G1 shows the author key
  is deterministic (never shared) or the group has no author key after PC-02.
* G8 rows → `LEGACY_STANDALONE`; rotate preserves the mode.
* G9 rows → the **only** `UNMANAGED_LEGACY` set. Anything not provable by G9 stays fenced.
* G10 `owner_key_missing`/`owner_key_not_active` > 0 → conversion is still allowed (owner
  projection is independent), but retry authorization (PC-07) must deny those operations.
* G11 non-empty → do not mutate that group's config while operations are live; the plan
  allows in-flight operations to continue on their pinned snapshot.

---

## 10. Handoff notes per package

**PC-01 (contracts).** v1 `ProfileGroupSaveSchema` requires a singular `apiKey`; the v1
`ProfileGroup` DTO carries `apiKey {apiKeyId,prefix,status}` (`profile-groups.ts:406-415`)
which is a *derived* value today. v2 must be additive: `authMode`, `authAuthority`,
`accessVersion`, `apiKeyGrants[]`, per-function `profileSettings` + `requestDefaults`.
Keep `.strict()` — the current v1 parsers are strict everywhere (e.g.
`admin-profile-groups.ts:110,141,163`).

**PC-02 (storage).** Use prefix **`0070`** (§6.10). Relax `profile_group_revisions.api_key_id`,
`profile_bindings.api_key_id`, `profile_names.api_key_id` to nullable while preserving
values. Add `profile_group_api_keys` with the tenant-safe composite FKs and the
"at most one group per key id, across ACTIVE and REVOKED rows" uniqueness. Add
`profile_bindings.request_defaults jsonb NOT NULL DEFAULT '{}'`. The legacy name index
change (§6.9) is a semantic change: `profile_names_identity` is `(tenant, api_key, business,
version, action, profile_name)` — a partial legacy index plus a group-scoped index must
still permit multiple group children for the same `(business, version, action)` with
distinct generated names, which is exactly the current group shape.

**PC-03 (group service).** `resolveCurrentGroupKey` must be replaced by the grant ledger;
v2 reads must succeed with zero grants. Remove/guard the destructive membership revocation
(F-03) and the rollback re-grant. The child author path needs a group-owned append that
takes tenant from the locked group and records the Admin actor separately
(`createGroupChildRevision` today still requires `apiKeyHash`, `profiles.ts:522-531`).

**PC-04 (key lifecycle).** Every mutation surface is enumerated in §4.5. The three
authority sources that must agree are: `dispatcher.ts` table gates, `internal-parity.ts`
`requireWrite`/`scopedTenant`, and `identity/api-keys.ts` `requireAdmin`. Note the
divergence that makes E6/E8 dangerous (F-08, F-09) and the fact that E1 cannot attach
profiles at all.

**PC-05 (resolution + v2 admission).** The single resolver to extend is
`resolveEffectiveProfile` (`profiles.ts:1023`) via `selectActiveRow`; the admission seam is
`submission.ts:789-820`. All public callers of the resolver are A1–A5, B3, §C1–C2, F13–F15
— no others exist. v1 bodies must not gain fields; the resolution branch is server-side only.

**PC-07 (retry).** See F-05. `retryOperation` needs the grant/key/enabled recheck inserted
**before** both coalescing points (`retry.ts:25-28` and `:107-112`) and before the insert at
`:153-162`. All encrypted carriers are already resealed for new AAD (`:80-96`), which the
plan requires; the gap is purely authorization.

**PC-08 (UI/BFF).** `bff/profile-groups.ts` is the v1 proxy and will need a v2 sibling;
`bff/profiles.ts:371` targets a nonexistent route (F-04). The local-USER read filter
(`bff/profile-groups.ts:235-264`) depends on a key existing — it must become grant-aware so
a keyless group stays readable.

---

## 11. Reproducibility

| Artifact | Purpose |
|---|---|
| `.tmp-pc00/inventory.mjs` → `inventory-out.json` | schema presence, counts, group/key join, tombstones, never-membered keys, owner projection |
| `.tmp-pc00/inventory2.mjs` → `inventory-out2.json` | membership scope classification, cross-group spans, schema columns, index list |
| `.tmp-pc00/inventory3.mjs` → `inventory-out3.json` | endpoint-slug-aware overlap, group projection, raw rows for keys/operations/artifacts/members |
| `.tmp-pc00/inventory4.mjs` → `inventory-out4.json` | index definitions, ledger tail, PC-02 column presence, child pointer integrity |
| `.tmp-pc00/inventory5.mjs` → `inventory-out5.json` | `0069` application check, ledger counts, idempotency/local-user counts |

All scripts connect with the DSN from `du-rework/.env.orchestrator.local` and issue only
`SELECT`s. No `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CREATE`, `LOCK` or `TRUNCATE` appears
in any of them.

---

## 12. Completion

* Route inventory (§4) covers every public action/catalog path, connector and provider
  probe, workflow test, settings/artifacts surface, operation read/owner surface, key
  lifecycle mutation, profile mutation and retry path — each with its **current authority
  source (file:line)** and its **target resolver**.
* Data inventory (§6) records shared-key, zero-key, tombstone and owner-projection state
  from a read-only dry-run, and states clearly which cohorts the local dataset **cannot**
  exercise.
* Classification rules (§7) confirm: no name/prefix-based grouping; `UNMANAGED_LEGACY`
  only on a deterministic never-member proof; ambiguity stays fenced; tombstones stay
  `LEGACY_STANDALONE`.
* No source file was modified. The only file written is this report.

**PC-00_INVENTORY_COMPLETE** — `du-rework/coordination/reports/inventory-pc00-profile-control-plane.md`
