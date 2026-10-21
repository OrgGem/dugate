# PREP-PC-03 — Group Config Service V2: architecture and test plan

**Packet:** PREP-PC-03 (design-only, while PC-01/PC-02 land)
**Master plan:** `du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` — PC-03 row, "DTO and route contract", "Settled data and authorization model"
**Status:** design complete; **no source file modified**
**Date:** 2026-10-21

---

## 0. TL;DR

PC-03 replaces the *derived* group key (`resolveCurrentGroupKey`'s child-membership
intersection) with an explicit **root grant ledger**, and makes group configuration
authorable with **zero API keys**. It also becomes the compatibility firewall: v1
group/child writes and the unprojectable v1 read must fail with
`409 PROFILE_GROUP_V2_REQUIRED`.

Dependencies are materially landed as of this writing:

| Dependency | State |
|---|---|
| **PC-01** contracts | **landed** — `ProfileGroupV2*`, grant DTOs, `ResolutionFingerprintSchema`, `computeResolutionFingerprint`, `PROFILE_GROUP_PROBLEM_CODES` in `packages/contracts/src/profile-groups.ts`; `parameterResolution` capability in `manifest.ts`; receipt: `coordination/reports/receipt-pc01-contracts.md` |
| **PC-02** migration | **landed on disk** — `migrations/0070_profile_control_plane_storage.sql`; **not yet applied** to the dev database (`schema_migrations` has no `0070` row) |
| Old group service | unchanged — `profile-groups.ts` still requires a key on save, derives the key on read, and re-grants children on rollback |

Nine design decisions need a coordinator ruling (§9); five are **lease gaps** that PC-03
cannot close alone (§8). The single most important architectural constraint is **G-1**:
conversion to `GROUP_GRANT` makes group children unreachable through the legacy
`selectActiveRow` resolver, so conversion must not be reachable by any HTTP route until
PC-05's root-grant resolver ships.

---

## 1. Evidence boundary

**Inspected read-only:** `modules/profiles/profile-groups.ts` (899 lines),
`modules/profiles/profiles.ts` (1146), `modules/profiles/self-service.ts` (667),
`modules/profiles/publish.ts`, `modules/admin-actions/profile-actions.ts` (390),
`modules/admin-actions/rbac.ts`, `modules/audit/audit.ts`,
`modules/admin-read/profile-detail.ts`, `modules/admin-read/business-functions.ts`,
`modules/admin-read/profile-workflows.ts`, `modules/idempotency/idempotency.ts`,
`http/routes/admin-profile-groups.ts`, `http/routes/admin.ts` (dispatch head),
`server.ts` (dispatch tail), `migrations/0039/0040/0067/0070`,
`packages/contracts/src/profile-groups.ts` (618), `profile-policy.ts`, `manifest.ts`,
`tests/woc-profile-groups-backend.test.ts` (structure only),
`tests/profile-control-plane-migration.test.ts` (structure only), both jest configs.

**Executed:** one read-only SQL check confirming `0070` is **not** applied
(`schema_migrations` has no `0070` row; `api_keys.key_mode` absent;
`profile_group_api_keys` absent; `profile_names_identity` still the 0028 tuple).
No migrations applied, no DDL, no writes.

**Not** done: no implementation, no test authoring, no build. Every code fragment below is
a *design draft*, not applied.

---

## 2. What v1 does today (the baseline PC-03 replaces)

### 2.1 The key is load-bearing in five independent places

| # | Site | How the key is used |
|---|---|---|
| 1 | `ProfileGroupSaveSchema.apiKey` (`contracts/profile-groups.ts:58`) | **required** on every create/update |
| 2 | `saveProfileGroupOn` → `loadSelectedKey` (`profile-groups.ts:673-674`) | must be `ACTIVE` and in the group tenant, else 403/404 |
| 3 | `createChildRevision` (`profile-groups.ts:498-545`) | writes `profile_names.api_key_id`, authors the child revision with `apiKeyHash: key.hash`, and **creates an ACTIVE `profile_api_keys` membership** per child |
| 4 | `resolveCurrentGroupKey` (`profile-groups.ts:321-366`) | derives the displayed key by intersecting ACTIVE memberships; 0 or >1 candidates ⇒ 409 |
| 5 | `rollbackProfileGroupOn` (`profile-groups.ts:805-807, 843`) | re-derives the key and **re-grants it to every target child** |

### 2.2 Consequent behaviours PC-03 must keep or deliberately change

| Behaviour | Today | PC-03 target |
|---|---|---|
| Create a group with zero keys | impossible (schema + `loadSelectedKey`) | **required** for new groups (`GROUP_GRANT`, zero grants) |
| Read a group whose key was revoked | 409 (`no single ACTIVE tenant API key…`) | read succeeds, `apiKeyGrants: []` |
| Roll back config | moves pointer **and** re-grants memberships | moves pointer only; never touches grants or `access_version` |
| Child revision author | the selected key (`api_key_id NOT NULL`) | `api_key_id NULL` + `created_by` actor |
| Group save revokes "other" child memberships | yes (`:722-729`) | must not silently destroy a shared key (blocked by conversion proof instead) |
| Workflow functions | rejected (`workflowRevision` non-null ⇒ 422, `:233-235`) | accepted and pinned per group revision |
| v1 child mutation | `409 STATE_CONFLICT '… edit it through the profile group'` | `409 PROFILE_GROUP_V2_REQUIRED` for `GROUP_GRANT` groups |

### 2.3 Current lock order in `saveProfileGroupOn` (to be replaced)

```
loadActiveGroup            -- profile_groups FOR UPDATE   (group root)
assertNameAvailable        -- pg_advisory_xact_lock('profile-group:<tenant>:<name>')
lockSelectors              -- business/version/action selector advisory locks
loadSelectedKey            -- api_keys FOR SHARE
validateRequestedMembers   -- business_catalog FOR SHARE + function catalog reads
assertNoAmbiguousBindings  -- membership reads
createChildRevision        -- lockProfileMutation (selectors, key rows, memberships),
                              profile_names INSERT/UPDATE, profile_bindings INSERT,
                              pinActiveRevision, profile_api_keys INSERT
insertGroupSnapshot        -- profile_group_revisions + members + CAS pointer move
```

**Deviation from plan §"Transaction and lock order" item 7:** the plan requires
business/version/selector locks **before** API-key locks; today the business availability
lock happens *inside* `validateRequestedMembers`, i.e. **after** `loadSelectedKey`. PC-03
must move `validateRequestedMembers` ahead of `loadSelectedKey` (both only need
`tenantId`, known from `root`), which is a two-line reorder plus a regression test.

---

## 3. Target model

### 3.1 State

```
profile_groups
  auth_mode            'API_KEY'                       (closed enum)
  auth_authority       'CHILD_PROJECTION' | 'GROUP_GRANT'   (one-way per group)
  access_version       bigint > 0                      (grant-ledger CAS counter)
  active_revision      integer                          (config CAS pointer, unchanged)

profile_group_api_keys          -- the root grant ledger (one row per key, PK api_key_id)
  state 'ACTIVE' | 'REVOKED'  + granted_by/at, revoked_by/at (+issuer/sub)

api_keys.key_mode               -- 'GROUP_MANAGED' | 'LEGACY_STANDALONE' | 'UNMANAGED_LEGACY'
```

### 3.2 Two independent clocks (the core invariant)

| Clock | Moved by | Never moved by |
|---|---|---|
| `profile_groups.active_revision` | config create/save/rollback | grant issue/revoke |
| `profile_groups.access_version` | grant issue/revoke/conversion | config save/rollback |

Consequence: a config rollback **cannot** restore a revoked grant, and a revoke **cannot**
invalidate a config revision. Every acceptance case in the plan's matrix hangs off this.

### 3.3 Read DTO derivation (authority-independent)

`ProfileGroupV2Schema` is derived, not stored. Field map:

| DTO field | Source |
|---|---|
| `groupId`, `tenantId`, `name`, `authMode`, `authAuthority`, `accessVersion`, `createdAt`, `updatedAt` | `profile_groups` |
| `revision` | `profile_groups.active_revision` (must equal the revision row's `revision`) |
| `businesses[].businessId/businessVersion/manifestDigest` | `profile_group_members` at `group_revision = active_revision` |
| `businesses[].functions[]` | same row + the child's `profile_bindings` at `binding_revision` |
| `functions[].childProfileId/childRevision` | `profile_group_members.profile_id / binding_revision` |
| `functions[].enabled` | `profile_bindings.enabled` (`!== false`) |
| `functions[].policy` | `profileDetailPolicyRead(row)` (read projection; `fileUrlAuthConfigured`, never the cipher) |
| `functions[].requestDefaults` | `profile_bindings.request_defaults` — **`{}` when NULL/absent (v1 rows)** |
| `functions[].connectorBindings` | `profileDetailConnectorBindingsRead(row)` |
| `apiKeyGrants[]` | `profile_group_api_keys WHERE state='ACTIVE' ORDER BY granted_at, api_key_id`, joined to `api_keys` for `prefix` / `status` |

**No key is ever derived.** `resolveCurrentGroupKey` is not called on the v2 path.

### 3.4 Why `apiKeyGrants[].status` matters

`ProfileGroupKeyGrantSchema.status` is projected verbatim from `api_keys.status`. After a
PC-04 global revoke the grant row stays `ACTIVE` while the key is `REVOKED`; that
combination is the visible "grant not yet tombstoned" invariant, and admission must deny
on either signal. PC-03 must **not** tombstone grants on key revoke — that is PC-04's
transactional duty.

---

## 4. Service API design (`modules/profiles/profile-groups.ts`)

### 4.1 Types

```ts
/** Admin actor in the shape 0070 stores (granted_by / created_by + issuer/sub). */
export interface ProfileGroupActor {
  actor: string;          // 'admin' | 'shell:<role>' | 'local-user:<uuid>' | 'platform-token'
  role: string;           // 'platform' | 'tenant_operator' | 'admin' | 'operator'
  issuer?: string;
  sub?: string;
}

export interface ProfileGroupGrantDeps {
  /** Injected so PC-04 can re-point minting without a cross-package edit. */
  hashApiKey(raw: string): string;
  mintRawKey(): string;          // `du_${randomBytes(32).toString('base64url')}`
}

export interface ProfileGroupConversionReport {
  groupId: string;
  previousAuthority: 'CHILD_PROJECTION';
  authority: 'GROUP_GRANT';
  accessVersion: number;
  grantedKeyId: string;
  revokedChildMemberships: number;
  blocked?: { check: string; detail: string };
}
```

### 4.2 New/changed functions

| Function | Status | Contract |
|---|---|---|
| `getProfileGroupV2(db, groupId, tenantId?)` | **new** | zero-grant safe; 404 only when the group row is absent |
| `listProfileGroupsV2(db, tenantId)` | **new** | N+1 removal: one query for roots, one for members+bindings, one for grants |
| `saveProfileGroupV2(client, profiles, connectors, input: ProfileGroupV2Save, groupId, actor, tenantScope?)` | **new** | create (`expectedRevision: 0`) and full replacement, **no key** |
| `rollbackProfileGroupV2(client, profiles, connectors, groupId, input, actor, tenantScope?)` | **new** | config pointer only |
| `issueGroupKey(client, deps, groupId, input, actor, expectedAccessVersion, idempotencyKey)` | **new** | mint + grant atomically |
| `revokeGroupGrant(client, groupId, apiKeyId, expectedAccessVersion, actor)` | **new** | grant tombstone + `access_version++` |
| `revokeAllGroupGrantsForApiKey(client, apiKeyId, tenantId, actor)` | **new** | cross-package seam for PC-04's global revoke |
| `convertGroupToGrantAuthority(client, deps, groupId, actor, report)` | **new** | one-way cutover; **no HTTP route** |
| `getProfileGroup(db, groupId, tenantId?)` | **changed** | authority-aware v1 projection (§6) |
| `saveProfileGroup` / `rollbackProfileGroup` | **changed** | reject `GROUP_GRANT` groups with 409 `PROFILE_GROUP_V2_REQUIRED`; `CHILD_PROJECTION` path unchanged |
| `createChildRevision` | **changed** | no key; actor attribution; no `profile_api_keys` write |
| `validateRequestedMembers` | **changed** | accept `workflowRevision`; validate against the workflow registry |

The v1 exports keep their names and signatures so `http/routes/admin.ts` and
`tests/woc-profile-groups-backend.test.ts` continue to compile.

### 4.3 `appendRevision` — the one signature change that unlocks zero-key appends

`profiles.ts:717` currently requires `input.apiKeyHash` and resolves the key by hash
(`:727-731`), throws 404 when absent, and unconditionally writes
`profile_api_keys` (`:838-842`).

Design: make the author reference a discriminated union.

```ts
export type CreateBindingInput = {
  profileId?: string;
  businessId: string;
  businessVersion: string;
  action: string;
  endpointSlug?: string;
  connectorBindings?: unknown;
  policy?: Record<string, unknown>;
  /** v2: per-field request defaults, immutable with the revision. */
  requestDefaults?: Record<string, { value: unknown; isLocked?: boolean }>;
} & (
  | { apiKeyHash: string; groupOwnerId?: never; actor?: never }   // legacy standalone
  | { groupOwnerId: string; actor: ProfileGroupActor; apiKeyHash?: never } // group child
);
```

Runtime behaviour of `appendRevision`:

| Branch | `profile_bindings.api_key_id` | `profile_names.api_key_id` | `created_by*` | `profile_api_keys` write |
|---|---|---|---|---|
| standalone (`apiKeyHash`) | `key.id` | `key.id` | `NULL` (DB allows) | **yes**, today's behaviour |
| group (`groupOwnerId`) | `NULL` | `NULL`, `group_id` set | `actor` | **no** |

Additional guard for the group branch (defence in depth against a caller passing a
profileId that belongs to a different group):

```sql
SELECT tenant_id FROM profile_groups WHERE group_id=$1 FOR UPDATE;
-- tenant must equal the tenant read from the LOCKED group, never from input
SELECT group_id FROM profile_names WHERE profile_id=$1 FOR UPDATE;
-- must equal input.groupOwnerId
```

`request_defaults` must be carried forward by `carryForwardPolicy` exactly like
`parameters` (absent ⇒ previous revision's value; no previous ⇒ `{}`), and written in the
`INSERT INTO profile_bindings` at `profiles.ts:809-836`.

### 4.4 Create / update with zero keys — `saveProfileGroupV2`

Pseudo-transaction (lock order per plan item 7):

```
1. normalizeRequestedFunctions(input.businesses)      -- pure, rejects overlaps (existing helper)
2. lock group root when updating:
     SELECT ... FROM profile_groups WHERE group_id=$1 FOR UPDATE
   (create path has no lock; it inserts)
3. assertNameAvailable(tenant, name, groupId)          -- existing advisory lock
4. validateRequestedMembers(...)                       -- business_catalog FOR SHARE, digest,
                                                          descriptor, workflow revision, pins
5. loadActiveGroup / existingGroupMembers               -- current active revision
6. CAS: expectedRevision === root.active_revision      -- 409 REVISION_CONFLICT
7. assertNoAmbiguousBindings(groupId, members)         -- now group-aware (see §7)
8. INSERT/UPDATE profile_groups(name, auth_mode='API_KEY',
      auth_authority = existing ?? 'GROUP_GRANT', active_revision=0)   -- create path
9. per requested member:
     createChildRevision(...) -> profiles.createGroupChildRevision(
        { groupOwnerId, actor, businessId, businessVersion, action,
          endpointSlug, policy, requestDefaults, connectorBindings }, groupId, client)
   per removed member: disableRemovedChild(...) -- same actor, api_key_id NULL
10. insertGroupSnapshot(revision = active+1, apiKeyId = NULL, createdBy = actor,
      actor, expectedRevision)                          -- CAS UPDATE ... WHERE active_revision=$4
11. NO profile_api_keys mutation, NO access_version change
12. return getProfileGroupV2 on the same client
```

**New groups are `GROUP_GRANT` on creation.** Existing `CHILD_PROJECTION` groups stay
`CHILD_PROJECTION` until an explicit conversion; a v2 `PUT` on a `CHILD_PROJECTION` group
must **not** silently upgrade it — it returns `409 PROFILE_GROUP_V2_REQUIRED` with
`detail: 'this group still uses child-projection authority; run the conversion first'`
(decision D-3 recommends this over silent upgrade).

**`insertGroupSnapshot` change.** Current statement
(`profile-groups.ts:591-595`) inserts `api_key_id` for the revision. It becomes nullable
and gets `created_by*`:

```sql
INSERT INTO profile_group_revisions
  (group_id, revision, tenant_id, name, api_key_id, created_by, created_by_issuer, created_by_sub)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
```

`profile_group_revisions_attribution_shape` (`api_key_id IS NOT NULL OR created_by IS NOT
NULL`) makes the actor mandatory on the v2 path — a missing actor is a DB error, which is
the intended last line of defence.

### 4.5 Rollback — config only

```
1. lock group root FOR UPDATE
2. current = active; input.expectedRevision === current  else 409 REVISION_CONFLICT
3. target revision row must exist for this group+tenant   else 404
4. validateRequestedMembers(targetMembers)               -- re-validate against live registry
5. assertNoAmbiguousBindings(groupId, targetMembers)
6. for each target child: lock profile_active_revisions FOR UPDATE, require the pointer
   still equals the revision the target snapshot pinned, then pinActiveRevision(target)
7. per current-but-not-target child: disableRemovedChild
8. insertGroupSnapshot(revision = current+1, apiKeyId = NULL, createdBy = actor,
      expectedRevision = current)         -- CAS
9. NO profile_api_keys writes, NO access_version change
```

This removes both v1 rollback defects: the re-grant at `:843` and the membership revoke at
`:864-870`. The plan's acceptance case — *"Revoke last root grant, then read config and
roll back config → read/rollback succeed; `accessVersion` remains monotonic and old config
cannot restore the grant"* — is exactly test **V2-W6**.

### 4.6 Grant issue — `issueGroupKey`

```
0. idempotencyKey required (else 422 INVALID_SCHEMA, same wording as self-service)
1. lock group root FOR UPDATE
2. access_version CAS: input expectedAccessVersion must equal current   else 412
3. raw = deps.mintRawKey(); hash = deps.hashApiKey(raw)
4. INSERT INTO api_keys (id, tenant_id, hash, prefix, name, status, version, key_mode)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,'GROUP_MANAGED')
   prefix = raw.slice(0,4);  name = input.note ?? NULL
5. INSERT INTO profile_group_api_keys
     (api_key_id, group_id, tenant_id, state, granted_by, granted_by_issuer, granted_by_sub)
     VALUES (..., 'ACTIVE', ...)
   -- PK conflict => that key id already belongs to another group (or this one):
   --   same group + REVOKED  => re-grant: UPDATE state='ACTIVE', cleared revoked_*, new granted_*
   --   other group           => 409 STATE_CONFLICT, no mutation
6. UPDATE profile_groups SET access_version = access_version + 1 WHERE group_id=$1
   -- do NOT touch updated_at
7. idempotency marker inside the same tx (executeIdempotent + withMarker)
8. audit 'profile_group.grant.issue'
```

Return `{ grant, secret: raw, secretAvailable: true }`. The HTTP layer adds
`Cache-Control: no-store`. Idempotent replay returns the stored body — which, because the
marker stores the *first* response, would replay the raw secret. **Decision D-5** covers
this: either store a redacted body (`secretAvailable:false`, no `secret`) or accept one
replay window. Recommendation: store the redacted shape; a replayed issue response must not
re-emit a credential.

### 4.7 Grant revoke — `revokeGroupGrant`

```
1. lock group root FOR UPDATE
2. access_version CAS (expectedAccessVersion)      else 412
3. lock grant row FOR UPDATE
     absent            => 404 NOT_FOUND
     state='REVOKED'   => 409 STATE_CONFLICT 'grant is already revoked'
4. UPDATE profile_group_api_keys
     SET state='REVOKED', revoked_at=now(), revoked_by=$actor, revoked_by_issuer=$i,
         revoked_by_sub=$s
   WHERE api_key_id=$1 AND state='ACTIVE'
5. UPDATE profile_groups SET access_version = access_version + 1
6. **api_keys.status is NOT touched** — the key stays live for any other surface
7. audit 'profile_group.grant.revoke'
```

Return `{ grant: <revoked tombstone shape>, accessVersion: <new> }`, matching
`ProfileGroupKeyRevokeResultSchema`.

### 4.8 Cross-package seam for PC-04 global revoke

```ts
/** Called INSIDE PC-04's global-revoke transaction, after api_keys.status flips. */
export async function revokeAllGroupGrantsForApiKey(
  client: PoolClient,
  apiKeyId: string,
  tenantId: string,
  actor: ProfileGroupActor,
): Promise<{ revoked: number; groupIds: string[] }>;
```

It locks the affected group roots **in sorted `group_id` order** first, then the grant row,
then bumps each group's `access_version` — the plan's "global revoke enumerates candidate
roots before locks, then revalidates after acquiring roots and keys". PC-04 must not
implement its own SQL against `profile_group_api_keys`.

### 4.9 Conversion — `convertGroupToGrantAuthority` (service only, no route)

The plan defines no route for conversion and lists none in the v2 route table. That is
deliberate: cutover is an operator action gated by the dry-run inventory, not a client
operation. PC-03 therefore exports the function and PC-09/ops invoke it.

```
convertGroupToGrantAuthority(client, deps, groupId, actor):
 1. lock group root FOR UPDATE
 2. if auth_authority='GROUP_GRANT' -> return idempotent no-op report
 3. load active revision + members + the derived candidate key K
 4. PROOF SET (all must pass; each failure returns 409 CONVERSION_BLOCKED + check name,
    with ZERO writes):
      P1  K exists, status='ACTIVE', tenant matches, key_mode in (NULL,'LEGACY_STANDALONE')
      P2  every member profile has exactly ONE ACTIVE membership and it is K
      P3  K has no ACTIVE membership on any profile outside this group's children
      P4  no other group's active revision names K  (profile_group_revisions)
      P5  every member profile_names.group_id = groupId
      P6  every member pointer equals its pinned binding_revision
      P7  the group has no in-flight operations on its children
          (operations.profile_id = ANY(children) AND state not terminal)
 5. INSERT profile_group_api_keys(... 'ACTIVE', granted_by=actor)
 6. UPDATE profile_groups SET auth_authority='GROUP_GRANT',
      access_version = access_version + 1
 7. UPDATE profile_api_keys SET state='REVOKED', revoked_at=now()
      WHERE api_key_id=K AND profile_id = ANY(children) AND state='ACTIVE'
 8. UPDATE api_keys SET key_mode='GROUP_MANAGED' WHERE id=K
 9. audit 'profile_group.convert'
10. return report (counts + new accessVersion)
```

`P7` is not in the plan's text but follows from "in-flight operations continue on pinned
snapshots": revoking the child memberships while an operation is admitted but not yet
dispatched would be invisible to retry authorization. Where P7 is too strict, the
conversion is deferred, never forced.

**G-1 (release blocker for enabling conversion).** After step 7 the children have no
`profile_api_keys` rows, so `selectActiveRow` (`profiles.ts:414-473`) returns
`'not-authorized'` for every legacy call. That is *intended* once PC-05's root-grant
resolver is live, and *catastrophic* before it. Therefore: PC-03 ships the function, ships
**no route**, and PC-09 invokes it only after PC-05 is deployed. Recorded as blocker **B-1**.

---

## 5. Route design

### 5.1 New module `http/routes/admin-profile-groups-v2.ts`

`PREFIX = '/api/v2/admin/profile-groups'`. Registration in `server.ts` **before**
`handleAdminRoutes`, because `handleAdminRoutes` owns `/api/v1/admin/*` only and would
404 the v2 paths:

```ts
// server.ts, immediately before `const adminResult = await handleAdminRoutes(ctx);`
const adminProfileGroupsV2Result = await handleAdminProfileGroupsV2Routes(ctx);
if (adminProfileGroupsV2Result) return adminProfileGroupsV2Result;
```

The module must not gate on `ctx.ingressAudience === 'internal'` (admin routes are on the
public ingress), but must reject a non-admin caller before parsing the body.

### 5.2 Routes and authorization

| Method + path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/v2/admin/profile-groups?tenantId=` | — | 200 `ProfileGroupV2List` | `authorizeAuditTenantRead`; platform requires `tenantId` |
| `GET /api/v2/admin/profile-groups/:groupId` | — | 200 `ProfileGroupV2` + `ETag: "<accessVersion>"` | tenant-scoped principals may omit `tenantId` |
| `POST /api/v2/admin/profile-groups` | `ProfileGroupV2Save` (`expectedRevision: 0`) | 201 `ProfileGroupV2` | `requirePlatform` |
| `PUT /api/v2/admin/profile-groups/:groupId` | `ProfileGroupV2Save` | 200 `ProfileGroupV2` | `requirePlatform`; tenant cannot move |
| `POST /api/v2/admin/profile-groups/:groupId/rollback` | `ProfileGroupV2Rollback` | 200 `ProfileGroupV2` | `requirePlatform` |
| `POST /api/v2/admin/profile-groups/:groupId/keys` | `ProfileGroupKeyIssueInput` + `Idempotency-Key` + `If-Match` | 201 `ProfileGroupKeyIssueResult` + `Cache-Control: no-store` | `requirePlatform` |
| `POST /api/v2/admin/profile-groups/:groupId/keys/:keyId/revoke` | `ProfileGroupKeyRevokeInput` + `Idempotency-Key` | 200 `ProfileGroupKeyRevokeResult` | `requirePlatform` |
| `GET /api/v2/admin/profile-groups/catalog?businessId=&businessVersion=` | — | 200 `ProfileGroupFunctionCatalog` | `requirePlatform`; **route must be matched before `/:groupId`** |

Authorization parity with v1: `resolveAdminPrincipal` (bearer) + `requirePlatform` for every
mutation + `authorizeAuditTenantRead` for every read. Cookie/CSRF handling stays in the BFF
(PC-08), exactly as v1 group routes do. Putting CSRF in the orchestrator route would create
a second, divergent auth model.

**Route ordering hazard:** `/api/v2/admin/profile-groups/catalog` collides with the
`/:groupId` pattern. Match `catalog` first and validate `groupId` as a UUID (v1 already
does this at `admin-profile-groups.ts:53-55`), so `/catalog` can never be read as a group id.

### 5.3 `If-Match` / access-version transport (implements PC-01 decision D9)

```
parseAccessVersion(raw: string):
  trim; optional surrounding quotes; reject W/ prefix; must be /^[1-9]\d*$/ and safe integer
  -> { ok: true, version } | { ok: false }

missing  -> 428 PRECONDITION_REQUIRED  'If-Match with the current access version is required'
malformed-> 400 INVALID_SCHEMA
stale    -> 412 PRECONDITION_FAILED    'access version is stale; reload the group'
```

Accept both `7` and `"7"` (D9). Reject `*` explicitly: client-selected wildcards defeat the
CAS the ledger exists for.

### 5.4 Error mapping (single table, used by both service and route)

| Condition | Status | Code |
|---|---|---|
| v1 write on a `GROUP_GRANT` group/child | 409 | `PROFILE_GROUP_V2_REQUIRED` |
| v1 read with 0 or >1 ACTIVE grants | 409 | `PROFILE_GROUP_V2_REQUIRED` |
| v2 `PUT` on a still-`CHILD_PROJECTION` group | 409 | `PROFILE_GROUP_V2_REQUIRED` |
| `expectedRevision` mismatch | 409 | `REVISION_CONFLICT` (existing vocabulary) |
| `expectedAccessVersion` mismatch | 412 | `PRECONDITION_FAILED` |
| grant target already revoked | 409 | `STATE_CONFLICT` |
| key already granted to another group | 409 | `STATE_CONFLICT` |
| conversion proof failure | 409 | `CONVERSION_BLOCKED` (needs a problem code — D-4) |
| idempotency reuse with different payload/route | 409 | `IDEMPOTENCY_CONFLICT` (existing) |
| no current root grant at admission | 403 | `PROFILE_GROUP_UNAUTHORIZED` (PC-05) |

`PROFILE_GROUP_V2_REQUIRED` / `PROFILE_CHANGED` / `PROFILE_GROUP_UNAUTHORIZED` already
exist in `PROFILE_GROUP_PROBLEM_CODES`. `CONVERSION_BLOCKED` does **not** and PC-01 is
frozen — decision **D-4**: either reuse `STATE_CONFLICT` with a `detail` string, or take a
one-line contract addition in a follow-up PC-01 delta.

---

## 6. v1 compatibility layer (the firewall)

### 6.1 Read projection

```
getProfileGroup(db, groupId, tenantId?):
  root = SELECT ... FROM profile_groups WHERE group_id=$1 [AND tenant_id=$2]
  404 if absent
  switch (root.auth_authority):
    case 'CHILD_PROJECTION':  return readGroupOn(...)   // today's behaviour verbatim
    case 'GROUP_GRANT':
       grants = SELECT ACTIVE grants joined to api_keys
       if (grants.length !== 1) throw HttpError(409, 'PROFILE_GROUP_V2_REQUIRED',
            'this profile group is managed by root grants; use /api/v2/admin/profile-groups')
       return toGroupWire(root, revision, grants[0], members)
```

The 409 shape is the same for 0 and >1 because the message must not disclose the grant
count to a caller that is being told to migrate.

`GET /api/v1/admin/profile-groups` (list) maps over groups and therefore 409s the **whole
page** if any converted group has ≠1 grant. That is literal plan behaviour ("zero or
multiple grants return 409") but it makes the v1 list unusable as soon as one converted
group with 0 grants exists — which is the intended migration pressure. Decision **D-3**
offers the alternative (omit unprojectable rows); recommendation: keep the 409.

### 6.2 Write rejection

Implement one helper used everywhere:

```ts
/** 409 when the addressed group (or the profile's owning group) is GROUP_GRANT. */
export async function assertLegacyGroupWriteAllowed(
  client: PoolClient,
  subject: { groupId: string } | { profileId: string },
): Promise<void>;
```

Call sites and their leases:

| Call site | File | In PC-03 lease | Action |
|---|---|---|---|
| `saveProfileGroup` (v1 POST/PUT) | `profile-groups.ts` | **yes** | check the addressed group |
| `rollbackProfileGroup` (v1 rollback) | `profile-groups.ts` | **yes** | check the addressed group |
| `appendRevision` (all child/standalone writes) | `profiles.ts` | **yes** | check the profile's owning group |
| `apikey.attach` | `dispatcher.ts` | **no** (PC-04) | PC-04 calls the same helper |
| self-service edit | `self-service.ts` | **no** | **lease gap L-1** |
| `profile.upsert/publish/rollback` | `profile-actions.ts` | **yes** | replace `assertProfileNotGroupOwned`'s 409 code |

Because `appendRevision` is the single write seam for `createRevision`,
`createGroupChildRevision` **and** the public `POST /api/v1/admin/profile-bindings`, putting
the check there covers that route without editing `admin.ts`.

### 6.3 The v1 mutation path forks or 404s instead of rejecting (must fix)

`profile-actions.ts:resolveProfileByName` (`:92-113`) resolves a profile only when
`n.api_key_id = key.id` **or** an ACTIVE `profile_api_keys` membership exists:

```sql
LEFT JOIN profile_api_keys m ON m.profile_id=n.profile_id AND m.api_key_id=$2
                            AND m.tenant_id=$1 AND m.state='ACTIVE'
WHERE n.tenant_id=$1 AND (n.api_key_id=$2 OR m.profile_id IS NOT NULL)
```

A v2 group child has `api_key_id = NULL` and, after conversion, **no membership**, so this
lookup returns `null` for it. The three v1 commands then diverge — and two of the three
outcomes are worse than a missing 409:

| v1 command | Trace | Actual outcome today |
|---|---|---|
| `profile.publish` / `profile.rollback` | `resolveExistingProfile` → `notFound('profile not found for this api key')` | **404**, so the required 409 never happens |
| `profile.upsert` | `existingProfileId = null` → `lockProfileMutation(null, …)` → `ensureProfileId` **INSERTs a new `profile_names` row** (`:142-156`) → `assertProfileNotGroupOwned` runs against the *new* row (`group_id = NULL`, passes) → `assertUpsertCas(created = true)` passes → `createRevision` | **a silent shadow standalone profile** with the same `profile_name`, not an error at all |

The shadow path is reachable: `childProfileName` (`profile-groups.ts:114-117`) is
`__du_group_<groupIdHex>_<sha256(identity)[:32]>`, and every input of that digest
(`businessId`, `businessVersion`, `kind`, `functionId`, `action`, `endpointSlug`) is present
in `ProfileGroupV2FunctionSchema`. So any caller able to read the group can compute the
child's name. The 0028-derived partial index does not collide (`profile_names_identity` is
`WHERE group_id IS NULL`, the child row is `WHERE group_id IS NOT NULL`), so PostgreSQL will
not stop it either.

Fix inside `profile-actions.ts` (in lease): resolve the registry row for
`(tenant, business, version, action, profileName)` **across both scopes** before any
key-scoped work, then

1. if that row has `group_id IS NOT NULL` → look up the owning group's `auth_authority`
   and return `409 PROFILE_GROUP_V2_REQUIRED` (for `GROUP_GRANT`) — this runs **before**
   `ensureProfileId` can insert anything, which is what closes the shadow path;
2. otherwise keep today's `n.api_key_id = key.id` / membership semantics and 404.

The same prefix check must guard `runProfilePublish` and `runProfileRollback`, which share
`resolveExistingProfile`.

This is the ordering that makes the plan's acceptance case *"Group child direct v1
upsert, attach, self-service edit or group/child admin write after cutover → Denied with
`PROFILE_GROUP_V2_REQUIRED`"* actually true rather than 404 or — worse — a silent fork.

**Related observation (pre-existing, not introduced by PC-03):**
`POST /api/v1/admin/profile-bindings` calls `createRevision` with an optional `profileId`;
when it is omitted, `appendRevision` mints a fresh `profile_id` and writes a
`profile_bindings` row with **no** `profile_names` entry, so `profile_names_owner_shape`
never sees it. That is today's behaviour and out of PC-03 scope; recorded so it is not
mistaken for a PC-03 regression.

### 6.4 Preserved v1 behaviour (must not regress)

* v1 create (`POST /api/v1/admin/profile-groups`) keeps working and keeps writing
  `auth_authority='CHILD_PROJECTION'` with the singular `apiKey`. Two creation paths with
  different default authority is intentional (decision **D-2**) — it is what lets
  unconverted cohorts stay on the legacy writer.
* `.strict()` parsing on both generations is untouched: `ProfileGroupV2SaveSchema` rejects
  a body carrying `apiKey` (PC-01 case B2), and `ProfileGroupSaveSchema` rejects v2 fields.
* `resolveCurrentGroupKey` stays exported and unchanged for `CHILD_PROJECTION` reads.

---

## 7. Group-awareness changes to shared helpers

| Helper | Today | Change |
|---|---|---|
| `assertNoAmbiguousBindings` (`profile-groups.ts:240-264`) | requires the selected key to have no overlapping binding outside this group | v2 has no key: the check becomes "no **current root grant** of this group has an overlapping binding outside this group" (0 grants ⇒ trivially passes) |
| `assertSelectorAvailable` (`profiles.ts:652-682`) | key-membership based | group path passes `groupId` so children of the *same* group are excluded (`n.group_id IS DISTINCT FROM $7` already supports it) |
| `lockProfileMutation` (`profiles.ts:860`) | resolves member keys | group path passes an empty additional-key list; membership set is empty after conversion |
| `lookupChildProfile` (`profile-groups.ts:479-496`) | by generated `profile_name` + business/version/action | unchanged lookup, but must tolerate `api_key_id IS NULL` and rely on `profile_names_group_identity` |
| `disableRemovedChild` (`profile-groups.ts:547-577`) | writes `profile_names.api_key_id = key.id` and revokes memberships | writes `api_key_id = NULL`, revokes nothing, sets `created_by = actor` |
| `createChildRevision` | writes key into registry + membership | see §4.3 |

**`profile_names_group_identity` (tenant, group_id, profile_name)** means the generated
child name (`__du_group_<hex>_<hash32>` `profile-groups.ts:114-117`) is now unique per
group, not per key. Keep the generator unchanged: it already embeds the group id and a
per-function digest, so no backfill and no collision with standalone names.

### 7.1 Workflow functions become selectable

`validateRequestedMembers` currently rejects any `workflowRevision` (`:233-235`). Replace
with:

```
if (member.kind === 'endpoint')  -> endpointSlug required, workflowRevision forbidden
if (member.kind === 'workflow')  -> workflowRevision required (contract enforces)
   verify: SELECT 1 FROM legacy_workflow_schemas
            WHERE tenant_id=$1 AND slug=$2 AND revision=$3 AND status='ACTIVE'
   -- slug = member.functionId (see decision D-6)
   missing => 404 NOT_FOUND 'workflow revision … is not active in this tenant'
```

**D-6 (decision):** `ProfileGroupV2FunctionInputSchema` carries `workflowRevision` but no
workflow slug, so the workflow identity must be `functionId`. That is consistent with
`getBusinessFunctionCatalog`, which sets `functionId = action.name` for workflow functions
(`business-functions.ts:130-147`). If the registry slug can differ from the manifest action
name, PC-01 needs a `workflowSlug` field — **flag now, because adding it later is a
breaking contract change.**

`profile_workflow_bindings` is **not** written for group children: it is a mutable,
profile-scoped table with no revision dimension (`migrations/0040:12-20`), so writing it
would let a mutable row contradict the immutable group revision. The group revision
(`profile_group_members.workflow_revision`) is the single authority; PC-05 resolves from
there. Consequence: `GET /api/v1/admin/profiles/:b/:v/:name/workflows` keeps returning
only `profile_workflow_bindings` rows, which is correct for standalone profiles and empty
for group children — documented, not a defect.

### 7.2 `requestDefaults` persistence

`profile_bindings.request_defaults jsonb NOT NULL DEFAULT '{}'` already exists after 0070.
PC-03 responsibilities:

1. **write**: `saveProfileGroupV2` passes `requestDefaults` into `createGroupChildRevision`
   → `appendRevision` → `carryForwardPolicy` (add the field) → the INSERT column list.
2. **carry forward**: a new revision without `requestDefaults` inherits the previous
   revision's value; no previous revision ⇒ `{}`.
3. **read**: `getProfileGroupV2` projects `request_defaults` as `{}` when the column is
   `NULL` (v1 rows) or absent.
4. **not** PC-03's job: semantic validation of `parameterResolution.fields` — PC-01 D12
   assigns that to PC-05's `manifest-validator.ts`. PC-03 must **not** duplicate it.

---

## 8. Lease analysis

### 8.1 In lease

`modules/profiles/profile-groups.ts`, `modules/profiles/profiles.ts`,
`modules/admin-actions/profile-actions.ts`, `http/routes/admin-profile-groups.ts`,
new `http/routes/admin-profile-groups-v2.ts`, `server.ts` (registration only).

### 8.2 Lease gaps — PC-03 cannot complete its own acceptance without these

| ID | File | Why PC-03 needs it | Recommended resolution |
|---|---|---|---|
| **L-1** | `modules/profiles/self-service.ts` | the plan requires child self-service writes to return `409 PROFILE_GROUP_V2_REQUIRED`; the current guard at `:316` returns `409 STATE_CONFLICT` | extend PC-03's lease by one file, **or** route the change to PC-04 (whose acceptance mentions the same code) |
| **L-2** | `modules/admin-actions/dispatcher.ts` | `apikey.attach`'s child guard at `:1034-1036`/`:1074-1076` returns `STATE_CONFLICT`; PC-04 owns the file | PC-04 calls `assertLegacyGroupWriteAllowed`; PC-03 exports it |
| **L-3** | `modules/admin-read/business-functions.ts` | the v2 catalog route must publish `parameterResolution` per function (plan: "Include the capability in the manifest digest and function catalog"), but `ProfileGroupFunction` has no field for it and the catalog reader drops it | either a one-file lease extension, **or** the v2 catalog route re-reads `business_versions.manifest` and merges `parameterResolution` itself (duplicated manifest parse — acceptable but noted) |
| **L-4** | `packages/contracts/src/profile-groups.ts` | `ProfileGroupFunctionSchema` (catalog DTO) has no `parameterResolution`, so L-3's clean fix needs a contract field | PC-01 delta; additive and non-breaking |
| **L-5** | `jest.unit.config.cjs` | a new **live** PC-03 suite must be added to `liveSuites` or the offline unit run will boot PG/Redis | one-line config edit; recommend bundling with PC-09's harness work |

### 8.3 Cross-package seams PC-03 must publish (not implement)

| Seam | Consumer | Contract |
|---|---|---|
| `assertLegacyGroupWriteAllowed(client, subject)` | PC-04 (`apikey.attach`), self-service | throws 409 `PROFILE_GROUP_V2_REQUIRED` |
| `revokeAllGroupGrantsForApiKey(client, apiKeyId, tenantId, actor)` | PC-04 global revoke | see §4.8 |
| `readGroupAuthority(client, groupId)` | PC-05 admission (to pick the resolver) | `'CHILD_PROJECTION' | 'GROUP_GRANT'` |
| `resolveRootGrant(client, apiKeyId)` | PC-05 | ACTIVE grant row + group + `access_version` |
| `getProfileGroupV2` | PC-04 (rotate must not re-grant child memberships), PC-08 (UI) | read-only |

---

## 9. Decisions required from the coordinator

| # | Question | Recommendation | Cost if changed later |
|---|---|---|---|
| **D-1** | Does a v2 `PUT`, `POST /keys`, or `rollback` on a still-`CHILD_PROJECTION` group auto-convert it? | **No** — 409 `PROFILE_GROUP_V2_REQUIRED`. Auto-conversion would let a config save silently revoke child memberships (F-03 data loss) | Making it strict later breaks any client that relied on auto-upgrade; being strict now is free |
| **D-2** | Is v1 `POST /api/v1/admin/profile-groups` still allowed after PC-03? | **Yes**, creating `CHILD_PROJECTION` groups. Otherwise unconverted cohorts lose their writer before PC-05 ships | Removing it later is a breaking change for the legacy editor; keeping it is a permanent second creation path |
| **D-3** | v1 list read when one converted group has 0/many grants | **409 the whole page** (literal plan text) | Omitting rows instead is purely additive later |
| **D-4** | New problem code `CONVERSION_BLOCKED`? | **Reuse `409 STATE_CONFLICT` + `detail.check`** for PC-03; schedule a PC-01 delta if the UI needs to branch | Adding a code later is additive on the wire |
| **D-5** | Replayed `POST /keys` response | Store the **redacted** body (`secretAvailable:false`, no `secret`) in the idempotency marker | Emitting the secret on replay is a credential-leak window; cannot be undone |
| **D-6** | Workflow identity = `functionId`? (no `workflowSlug` in the v2 function input) | **Yes**, matching the catalog's `functionId = action.name` | Adding `workflowSlug` later is a breaking contract change — decide before PC-05 |
| **D-7** | Does a grant mutation bump `profile_groups.updated_at`? | **No**; `access_version` is the grant clock | Bumping later changes ETag/`updatedAt` semantics for clients |
| **D-8** | `Idempotency-Key` required for issue/revoke? | **Required** → 422 `INVALID_SCHEMA` (same wording as self-service) | Making it required later breaks callers that omitted it |
| **D-9** | Is `P7` (no in-flight child operations) a conversion proof? | **Yes** — it is the only way to honour "in-flight operations continue on pinned snapshots" while revoking memberships | Adding a proof later can retroactively block already-converted groups |

---

## 10. Test plan

Conventions: **offline** suites use the established hand-rolled `db` stub pattern of
`tests/woc-profile-groups-backend.test.ts` (stub `query`/`tx`, assert SQL shape and
sequence). **live** suites are gated `process.env.DU_LIVE_INFRA === '1'` and use a scratch
database, following `tests/profile-control-plane-migration.test.ts`. Proposed files:

* `tests/profile-groups-v2-offline.test.ts` — service semantics + SQL/lock-order assertions
* `tests/profile-groups-v2-routes-offline.test.ts` — route matching, auth, headers, error map
* `tests/profile-groups-v2-pg.test.ts` — live: CAS, grants, conversion, concurrency

### 10.1 Offline — read projection (V2-R)

| ID | Case | Assertion |
|---|---|---|
| V2-R1 | Zero-grant `GROUP_GRANT` read | 200; `apiKeyGrants: []`; no `resolveCurrentGroupKey` query issued |
| V2-R2 | One ACTIVE grant | `apiKeyGrants[0]` = `{apiKeyId, prefix, status, grantedAt}`; no secret field |
| V2-R3 | Revoked grant excluded | grant row absent from `apiKeyGrants`; `accessVersion` still returned |
| V2-R4 | `requestDefaults` absent on a v1 revision | projects `{}` |
| V2-R5 | `requestDefaults` present | verbatim `{value,isLocked?}` per key |
| V2-R6 | `policy.parameters` and `requestDefaults` both projected | intentional overlap preserved; neither is derived from the other |
| V2-R7 | Group header/revision mismatch | child pointer ≠ pinned `binding_revision` ⇒ 409 `STATE_CONFLICT` (today's fail-closed rule) |
| V2-R8 | Unknown group | 404, no tenant leak for a scoped principal |

### 10.2 Offline — create/update (V2-W)

| ID | Case | Assertion |
|---|---|---|
| V2-W1 | Create with **no** key, `expectedRevision: 0` | inserts `profile_groups(auth_authority='GROUP_GRANT', active_revision=0)`, revision 1 with `api_key_id NULL` + `created_by`; **no** `profile_api_keys` INSERT |
| V2-W2 | Update CAS | stale `expectedRevision` ⇒ 409 `REVISION_CONFLICT`, zero writes |
| V2-W3 | `apiKey` present in a v2 body | 422 (contract enforces; service never reads it) |
| V2-W4 | Tenant move | 403 |
| V2-W5 | Removed function | child revision with `enabled=false`, actor recorded, **no membership revoke** |
| V2-W6 | `requestDefaults` carry-forward | revision N+1 without the field inherits revision N's value; a new profile gets `{}` |
| V2-W7 | Lock order | business availability lock precedes the API-key lock (regression for §2.3) |
| V2-W8 | Overlapping functions | 409 before any DB read (existing helper, unchanged) |
| V2-W9 | Workflow function with an inactive revision | 404 |
| V2-W10 | Workflow function accepted | `profile_group_members.workflow_revision` set; **no** `profile_workflow_bindings` write |

### 10.3 Offline — rollback (V2-B)

| ID | Case | Assertion |
|---|---|---|
| V2-B1 | Rollback moves only the pointer | executed statements contain no `profile_api_keys` / `access_version` write |
| V2-B2 | `expectedRevision` stale | 409, zero writes |
| V2-B3 | Target revision of another tenant | 404 |
| V2-B4 | Target child pointer changed | 409 `STATE_CONFLICT` |
| V2-B5 | Rollback preserves `requestDefaults` of the target revision | projected value equals the target's stored value |

### 10.4 Offline — grants (V2-G)

| ID | Case | Assertion |
|---|---|---|
| V2-G1 | Issue mints + grants in one tx | `api_keys(key_mode='GROUP_MANAGED')` insert, grant insert, `access_version+1`, audit |
| V2-G2 | Issue returns the raw secret exactly once | body has `secret`; the idempotency marker body does **not** |
| V2-G3 | Issue with a stale `If-Match` | 412, zero writes |
| V2-G4 | Issue without `Idempotency-Key` | 422 |
| V2-G5 | Revoke tombstones the grant and bumps `access_version` | `state='REVOKED'`, `revoked_by` set, key `status` untouched |
| V2-G6 | Revoke an already-revoked grant | 409 `STATE_CONFLICT`, no second bump |
| V2-G7 | Revoke with a stale `expectedAccessVersion` | 412 |
| V2-G8 | Re-grant the same key to the same group | row UPDATE back to `ACTIVE`, tombstones cleared, `access_version+1` |
| V2-G9 | Grant a key already owned by another group | 409 `STATE_CONFLICT`, zero writes (PK `api_key_id`) |
| V2-G10 | Replay of a revoke with the original key | stored body returned, no second mutation |

### 10.5 Offline — v1 compatibility firewall (V2-X)

| ID | Case | Assertion |
|---|---|---|
| V2-X1 | v1 `PUT` on a `GROUP_GRANT` group | 409 `PROFILE_GROUP_V2_REQUIRED` |
| V2-X2 | v1 `POST` (create) | still allowed, writes `CHILD_PROJECTION` (D-2) |
| V2-X3 | v1 rollback on a `GROUP_GRANT` group | 409 `PROFILE_GROUP_V2_REQUIRED` |
| V2-X4 | v1 read, 0 grants | 409 `PROFILE_GROUP_V2_REQUIRED`; message does not reveal the count |
| V2-X5 | v1 read, 1 grant | 200 with the singular `apiKey` projection |
| V2-X6 | v1 read, 2 grants | 409 |
| V2-X7 | v1 read on a `CHILD_PROJECTION` group | byte-identical to today (including the legacy 409 messages when the intersection fails) |
| V2-X8 | `profile.upsert` on a zero-key child | **409** `PROFILE_GROUP_V2_REQUIRED`; assertion includes **zero** `INSERT INTO profile_names` (regression for the shadow-profile fork, §6.3) |
| V2-X8b | `profile.publish` / `profile.rollback` on a zero-key child | **409**, not today's 404 |
| V2-X9 | `POST /api/v1/admin/profile-bindings` on a child | 409 via the `appendRevision` guard |
| V2-X10 | `apikey.attach` on a child | 409 (PC-04 wires the helper; PC-03 test asserts the helper itself) |

### 10.6 Offline — route layer (V2-P)

| ID | Case | Assertion |
|---|---|---|
| V2-P1 | Prefix isolation | `/api/v1/admin/...` never matches the v2 handler and vice versa |
| V2-P2 | `catalog` vs `/:groupId` | `/catalog` wins; `/not-a-uuid` ⇒ 422 |
| V2-P3 | Auth | no bearer ⇒ 401; tenant principal mutating ⇒ 403; viewer cookie ⇒ 403 (BFF rejects earlier) |
| V2-P4 | `If-Match` parsing | `7`, `"7"` accepted; `*`, `W/"7"`, `7.0`, `-1`, `` ⇒ 400; absent ⇒ 428 |
| V2-P5 | `Cache-Control: no-store` | present on the issue response only |
| V2-P6 | `ETag` | matches `accessVersion`, quoted |
| V2-P7 | Error map | table §5.4 row-by-row |

### 10.7 Live PostgreSQL (`DU_LIVE_INFRA=1`) — V2-L

| ID | Case | Assertion |
|---|---|---|
| V2-L1 | 0070 prerequisites | `profile_group_api_keys` exists; `api_keys.key_mode` assignable; `profile_bindings.request_defaults` defaults `'{}'` |
| V2-L2 | Attribution constraints | a v2 revision with neither `api_key_id` nor `created_by` is rejected by `profile_bindings_attribution_shape` / `profile_group_revisions_attribution_shape` |
| V2-L3 | `profile_names_owner_shape` | a child row with neither a key nor a group is rejected |
| V2-L4 | Name uniqueness split | two grouped children may share a `profile_name` across groups; the same name inside one group conflicts; a standalone name still uses the 0028 tuple |
| V2-L5 | Grant PK | a second group for one `api_key_id` fails at the database |
| V2-L6 | Revocation shape check | `state='ACTIVE'` with `revoked_at` set fails; `state='REVOKED'` without `revoked_by` fails |
| V2-L7 | **Concurrency:** two concurrent `PUT`s | exactly one wins; the loser gets 409; `active_revision` advances by exactly 1 |
| V2-L8 | **Concurrency:** grant revoke vs config rollback | both succeed independently; `access_version` and `active_revision` each move once; the rollback does not resurrect the grant |
| V2-L9 | **Concurrency:** two concurrent issues with the same `If-Match` | one 201, one 412 |
| V2-L10 | **Concurrency:** issue vs revoke | serialized on the group root lock; no lost `access_version` increment |
| V2-L11 | Conversion happy path | authority flips, one grant, child memberships revoked, `key_mode` promoted, `access_version+1` |
| V2-L12 | Conversion blocked: shared key | P3 fails ⇒ 409, **zero writes** (verify by row counts) |
| V2-L13 | Conversion blocked: in-flight op | P7 fails ⇒ 409 |
| V2-L14 | Conversion idempotent | second call returns the same report, no double bump |
| V2-L15 | `revokeAllGroupGrantsForApiKey` | revokes grants in N groups, bumps each `access_version`, leaves `api_keys.status` to PC-04 |

### 10.8 Acceptance-matrix traceability

| Plan acceptance case | Covered by |
|---|---|
| Create/read/update/rollback a managed group with zero keys | V2-W1, V2-R1, V2-W2, V2-B1 |
| Revoke last root grant, then read config and roll back | V2-G5, V2-R3, V2-B1, V2-L8 |
| Global revoke vs grant revoke | V2-G5, V2-L15 (+ PC-04 suite) |
| Same key proposed for another group / shared legacy key | V2-G9, V2-L5, V2-L12 |
| `CHILD_PROJECTION` group before conversion unchanged | V2-X7, V2-X2 |
| Group child direct v1 upsert/attach/self-service after cutover | V2-X1, V2-X3, V2-X8, V2-X8b, V2-X9, V2-X10, **L-1** |
| Read with 0/many grants returns v2-required | V2-X4, V2-X6 |
| Empty grant set keeps config readable | V2-R1 |
| Revoke-then-config-read 409 regression | V2-R3, V2-X5 |

### 10.9 Suggested execution order

1. Offline suites (no DB dependency) while 0070 is still unapplied — everything in
   §10.1–§10.6.
2. Apply 0070 to the dev database once PC-02's receipt lands.
3. Live suite §10.7, one file, `--runInBand`, window-gated.

---

## 11. Risks and pre-mortem

| # | Risk | Mitigation |
|---|---|---|
| **B-1** | Conversion revokes child memberships before PC-05's resolver exists ⇒ every grouped public request 403s | no conversion route; PC-09 invokes it only post-PC-05 (§4.9) |
| **B-2** | v2 `PUT` on a `CHILD_PROJECTION` group silently revokes "other" child memberships (the existing F-03 data-loss path) | D-1: 409, never auto-convert |
| **B-3** | v1 child commands do not reject: `publish`/`rollback` 404, and `upsert` **silently forks a standalone profile** under the child's derivable name (§6.3) | explicit resolve-before-create fix + V2-X8/X8b |
| **B-3b** | The 0028-derived `profile_names_identity` cannot stop the fork (different partial index) | same fix; V2-X8 asserts zero registry inserts |
| **B-4** | Idempotent replay re-emits a raw key | D-5: store the redacted body |
| **B-5** | `profile_workflow_bindings` written for children, contradicting the immutable snapshot | §7.1: never write it; group revision is the authority |
| **B-6** | Catalog cannot express `parameterResolution` (L-3/L-4) | PC-03 merges it in the v2 module, or takes the lease extension |
| **B-7** | Live suite boots PG in the offline unit run | add to `liveSuites` (L-5) |
| **B-8** | `api_keys.key_mode` left `NULL` for keys minted before PC-04 lands | 0070 backfills every existing key; PC-03's mint always sets `GROUP_MANAGED`; a `NULL` mode only arises from a non-PC-03 writer, which is exactly the case PC-04 must deny |

---

## 12. Definition of done and handoff

PC-03 is done when, at source and test level:

1. §10.1–§10.6 are green offline and §10.7 is green live.
2. `git diff --stat` touches only the in-lease files, plus whatever the coordinator grants
   under L-1/L-3/L-5.
3. v1 behaviour for `CHILD_PROJECTION` cohorts is byte-identical (V2-X7).
4. No route exists that can convert a group.
5. The five cross-package seams of §8.3 are exported and documented for PC-04/PC-05.

**Handoff to PC-04:** use `assertLegacyGroupWriteAllowed` in `apikey.attach`, use
`revokeAllGroupGrantsForApiKey` in global revoke, and do not write
`profile_group_api_keys` directly.
**Handoff to PC-05:** use `readGroupAuthority` to pick the resolver and `resolveRootGrant`
for admission; do not re-derive grants. PC-05 also owns `parameterResolution` semantics
(PC-01 D12) and fingerprint recomputation.
**Handoff to PC-08:** the v2 read DTO is authoritative for the editor; the v1 read is a
compatibility projection that will 409 once a group is converted.

---

## 13. Reproducibility

| Artefact | Purpose |
|---|---|
| `.tmp-pc03/dbcheck.mjs` | read-only check that 0070 is unapplied on the dev database |

The check issued `SELECT`s only. No migration was applied, no table created, no row
written.

---

## 14. Completion

Deliverables of this packet: the v2 service architecture (§3–§4), the route and error
contract (§5), the v1 compatibility firewall (§6), the lease analysis with five gaps (§8),
nine coordinator decisions (§9), and a test plan traceable to the plan's acceptance matrix
(§10).

**PREP-PC-03_COMPLETE** — `du-rework/coordination/reports/prep-pc03-service-spec.md`
