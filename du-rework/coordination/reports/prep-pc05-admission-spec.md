# PREP-PC-05 — Resolution and v2 admission design

| Field | Value |
|---|---|
| Packet | PREP-PC-05 (pre-analysis for **PC-05 Resolution and v2 admission**) |
| Role | DeepSeek Worker 3 — Resolution & Admission Specialist |
| Master plan | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) §PC-05, §Settled data and authorization model, §Manifest parameter and lock resolution |
| Contract source | PC-01 receipt [`receipt-pc01-contracts.md`](receipt-pc01-contracts.md); `packages/contracts/src/profile-groups.ts` (v2 DTOs), `manifest.ts` (capability), `admin-workbench.ts` (workbench v2) |
| Storage source | PC-02 (closed) `migrations/0070_profile_control_plane_storage.sql` |
| Peer state | PC-03 and PC-04 are **in flight** (working tree shows `profile-groups.ts`, `profiles.ts`, `profile-actions.ts` being edited) |
| Source files modified | **None.** Read-only audit; this report is the only artifact. |

## 0. TL;DR

1. **One seam already exists** for v1: every admission path funnels through `profiles.resolveEffectiveProfile` (`profiles.ts:1186`), which resolves by `profile_api_keys` membership. Group-managed keys must not use that membership edge, so PC-05 introduces a **single front resolver** returning a discriminated union (`legacy` | `standalone` | `group`) and keeps the membership query as the `standalone` branch — v1 behavior is preserved by delegation, not by reward.
2. **Idempotency ordering must be inverted for v2.** The current `submit` looks up the idempotency record *before* any admission policy read (`submission.ts:711-743`, RCR-03). The plan requires v2 to authorize first and replay second. This is a new code path, not a reorder of the existing one, because v1 must stay byte-identical.
3. **Blocker found: the resolution fingerprint has nowhere to live.** `computeResolutionFingerprint` exists in contracts, but no column exists on `operations`, `submission_keys`, or anywhere else (verified: zero matches for `fingerprint|resolution` beyond `0064.actor_fingerprint` and `0046.applied_fingerprint`). Exact replay after config drift requires the *original* fingerprint. Options in §7; recommended is a one-column migration `0071` — which is **outside PC-05's lease** and needs a coordinator decision.
4. **`server.ts` is not needed.** `/api/v2/profile-groups/...` can be claimed inside `handlePublicRoutes` (in lease) because the v2 prefix does not collide with any handler tried before it (`server.ts:436-467`); the workbench v2 routes are new suffixes of `internal-admin-workbench.ts` (in lease). No route-registration dependency on PC-03.
5. **Ambiguity is a first-class v1 outcome.** A v1 request carries no `functionId`, so two group functions can match one selector; the plan requires denying rather than choosing. v2 preview/submit carries `functionId`, so the exact-match rule applies there.
6. **`defaultLocked` is currently unread on the admission path.** Only `self-service.ts:615` consults it. PC-05 must apply `explicit isLocked ?? mapped schema.defaultLocked ?? false` at v2 publish-time normalization and at resolution.
7. **`parameterResolution` has no semantic validation today.** `manifest-validator.ts` validates structure, unique actions/slots and artifact policy only; the capability is parsed by Zod and hashed but never checked against the schemas it maps. PC-05 owns that validation.

**Tóm tắt (VI).**

1. **Chỉ có một điểm phân giải cho v1** (`profiles.resolveEffectiveProfile`, `profiles.ts:1186`) và nó phân giải qua *membership* `profile_api_keys`. Key thuộc group không được đi qua nhánh đó, nên PC-05 thêm resolver đầu vào trả về union `legacy | standalone | group`; nhánh `standalone` gọi lại hàm cũ để v1 không đổi hành vi.
2. **Thứ tự idempotency của v2 phải đảo lại**: v1 tra idempotency *trước* khi kiểm tra quyền (`submission.ts:724-743`), còn v2 phải authorize trước rồi mới replay — nếu không, một retry mạng bình thường sau khi cấu hình đổi sẽ bị 409 thay vì replay.
3. **Chặn: chưa có chỗ lưu `resolutionFingerprint`.** `computeResolutionFingerprint` có trong contracts nhưng không cột nào trong DB chứa fingerprint (đã kiểm tra toàn bộ 67 migration). Muốn replay đúng sau khi cấu hình trôi thì phải lưu fingerprint gốc → cần migration `0071`, mà migration **nằm ngoài lease của PC-05** (xem §10 Q-2).
4. **Không cần sửa `server.ts`**: route public `/api/v2/...` nhận ngay trong `handlePublicRoutes`, workbench v2 là suffix mới của `internal-admin-workbench.ts` — cả hai đều thuộc lease PC-05, nên không phụ thuộc PC-03 để đăng ký route.
5. **Nhập nhằng là kết quả hợp lệ ở v1**: request v1 không mang `functionId`, nên hai function trong cùng group có thể cùng khớp selector → phải từ chối, không được chọn hộ. v2 có `functionId` nên so khớp tuyệt đối.

## 1. Evidence boundary

Read (source): `modules/operations/submission.ts` (1935 lines), `http/routes/public.ts` (741), `modules/admin-workbench/service.ts`, `http/routes/internal-admin-workbench.ts`, `modules/profiles/policy.ts`, `modules/profiles/profiles.ts`, `packages/contracts/src/manifest-validator.ts`, `manifest.ts`, `profile-groups.ts`, `admin-workbench.ts`, `profile-policy.ts`, `hashing.ts`, `operations.ts`, `public-api.ts`, `http/route-context.ts`, `server.ts` (dispatch chain), `compat/legacy-http-mount.ts`, `compat/legacy-host-adapter.ts`, `compat/legacy-action-router.ts`, `http/routes/api-key-auth.ts`, migrations through `0070`.

Not done: no code written, no database touched, no peer packet (PC-03/PC-04) modified. PC-03 and PC-04 were mid-flight during this audit; anything in this report that references their output is labelled as an **interface expectation**, not observed behavior. No claim is made about deployed behavior.

## 2. Current state of the admission surface

### 2.1 Entry points (all read-only verified)

| Entry point | File:line | Path into admission |
|---|---|---|
| Canonical public action | `public.ts:513-543` | `ctx.submission.submit` |
| Legacy six-service routers | `legacy-action-router.ts:415` → `legacy-host-adapter.ts:182,283` | `submit` (+ `preflightLegacyWorkflow`, `replayLegacy`) |
| Legacy compat facade | `legacy-host-adapter.ts:132-283` | same three seams |
| Admin Workbench v1 `test-endpoint` / `prompt-wizard` | `admin-workbench/service.ts:178,255` | `preflightLegacyWorkflow` → `submit` |
| Workflow test | `workflow-test/workflow-test.ts:66,83` | `preflightLegacyWorkflow` → `submit` |
| Provider test | `submission.ts:492` (`admitProviderTest`) | read-only admission, no operation row |

Six call sites, three seams (`submit`, `preflightLegacyWorkflow`, `replayLegacy`), one resolver.

### 2.2 The one resolver (`profiles.ts:1186-1248`)

`resolveEffectiveProfile(apiKeyId, businessId, businessVersion, action, clientInput, declaredKeys, endpointSlug)`:

1. `selectActiveRow` (`profiles.ts:414-473`) joins `profile_active_revisions` → `profile_bindings` → **`profile_api_keys` membership** `m.api_key_id=$1 AND m.state='ACTIVE'`.
2. Returns `'legacy'` (no rows at all for the key), `'pointer-missing'` (404), `'not-authorized'` (403), or the pinned row.
3. `decodePolicy`, `mergeParameters(policy.parameters, clientManaged, declaredKeys)` → `effectiveParameters`; keys the profile does not manage go to `passthrough`; `effectiveInput = {...effectiveParameters, ...passthrough}`.

Consequences for PC-05:

- The membership join *is* the v1 authorization. A `GROUP_MANAGED` key with no child membership would fall to `'legacy'` — the exact fallback the plan forbids. **Group keys must never reach this function's membership branch**, not even as a fallback.
- The v1 merge injects profile `parameters` into request input. Under a `parameterResolution` capability, `profileSettings` must **not** be injected (plan item 3). So the merge cannot be reused unchanged for capability-enabled manifests (§5).

### 2.3 Admission ordering inside `submit` (`submission.ts:679-1230`)

```
parse Submission                                                    :683
requestHash = canonicalRequestHash(raw input, artifacts, ...)       :711-722
FAST-PATH idempotency lookup (BEFORE any policy read)               :724-743   <- RCR-03
storage/sourceUrl checks                                            :745-761
artifact readiness (pre-lock)                                       :763-768
resolveEnabledVersion (business_catalog enabled/paused + active)    :772-778
profiles.resolveEffectiveProfile  <- THE admission seam             :789-799
tenantDefaults + connector bindings                                 :800-812
legacyExpectedProfile comparison (PROFILE_CHANGED)                  :813-820
AJV on EFFECTIVE input                                              :834-842
seal tenant defaults / recipes / prompt carrier (before tx)          :874-900
tx: backupSnapshotWriteGate → advisory idempotency lock
    → dup recheck → business_catalog+version FOR SHARE
    → artifact FOR SHARE → spend → extension gate                   :960-1046
    INSERT operations → tasks → submission_keys → outbox            :1048-1200
```

Two properties are load-bearing for PC-05:

- **Nothing is written before line 1048**, and every refusal above leaves zero rows (T-SUB-01). A v2 implementation must preserve that: a stale fingerprint is a 409 *before* any durable write.
- The advisory idempotency lock is taken on `(tenantId, apiKeyId, routeAction, key)` (`:976`). For v2 the same scope is required by the plan, so the lock stays, but it must be acquired only after authorization (§4.3).

### 2.4 v1 catalogue (the "catalog/preflight" surface)

`legacy-host-adapter.ts:541-571` builds the six-service catalogue by calling `resolveEffectiveProfile` once per `(action, endpointSlug)` and **skipping** 403/404 (`:560-563`). A `GROUP_MANAGED` key therefore currently sees the catalogue projected from *child memberships*. After cutover it must see only what its group grant authorizes — this is a PC-05 route-authorization item, and the "skip denied branches" behavior conveniently already matches "show only what resolves".

### 2.5 Admin Workbench v1 (`admin-workbench/service.ts`)

- `preflightProfile` (`:132-160`) hardcodes `businessId: 'document-core'` and validates profile name + `expectedProfileRevision` + the persisted `endpoint_slug`.
- `assertAdminWorkbenchAdmissionScope` (`:67-83`) requires the local USER's scope to contain **both** the chosen `apiKeyId` and the resolved `profileId`.
- `submit` passes `legacyExpectedProfile` (re-checked inside admission, `submission.ts:813`) and `adminWorkbenchProfileIdentity` — the latter is folded into the idempotency hash only (`:711-713`), never into the public hash.

The v2 workbench flow reuses the *identity* rules but not the `document-core` pin or the revision-equality gate: v2 resolution is by group function, and the fingerprint replaces `expectedRevision` as the drift guard.

### 2.6 Parameter policy (`policy.ts`)

- `mergeParameters` (`:233-275`): profile defaults first, client values overwrite unless `isLocked` — and a locked key is refused **on presence**, even when the value is identical (`:264-270`, 400 `PROFILE_LOCKED_FIELD`).
- Unknown client keys are refused with 400 `PROFILE_UNKNOWN_FIELD` **only when they are "managed"**; `resolveEffectiveProfile` partitions input into `clientManaged` vs `passthrough` (`profiles.ts:1221-1229`), so a stray key is left to AJV.
- `defaultLocked` is **not** consulted here. The only reader is `self-service.ts:615-616`.

### 2.7 Manifest validation (`packages/contracts/src/manifest-validator.ts`)

`validateManifest` checks: Zod structure → unique action names → JSON-Schema guard on `inputSchema`/`outputSchema`/`profileSchema` → unique slot names → `minFiles <= maxFiles` → handler-kind coverage. It never inspects `parameterResolution`, and `hashManifest` (`:31-34`) canonicalizes the whole manifest, so declaring the capability changes the digest automatically (PC-01 case `I2`).

## 3. Root-grant resolution design

### 3.1 New module: `modules/profiles/resolution.ts` (new file in a leased directory)

Pure-ish resolver shared by **all** v2 paths and by the v1 `GROUP_MANAGED` branch. It must not import `public-api` (PC-01 cycle note) and must not duplicate SQL owned by PC-03.

```ts
export type AdmissionResolution =
  | { mode: 'legacy' }                                     // key_mode UNMANAGED_LEGACY, no profile
  | { mode: 'standalone'; profile: EffectiveProfilePinned } // key_mode LEGACY_STANDALONE
  | {
      mode: 'group';
      groupId: string;
      groupRevision: number;      // profile_groups.active_revision
      accessVersion: number;      // profile_groups.access_version at resolution
      ref: ProfileGroupResolutionFunctionRefV2;
      childProfileId: string;
      childRevision: number;
      policy: EffectiveProfilePolicy;   // decoded from the child profile_bindings row
      requestDefaults: Record<string, ProfileParameterValue>;  // v2 columns
    };
```

Resolution algorithm (group branch), in order:

| # | Check | Failure |
|---|---|---|
| G1 | presented key is ACTIVE (`resolveApiKey`, `api-key-auth.ts:16`) | 401 `UNAUTHENTICATED` |
| G2 | `api_keys.key_mode = 'GROUP_MANAGED'` (PC-04 column, `0070` block 1) | not group-managed → standalone path |
| G3 | `profile_group_api_keys(api_key_id = key, tenant_id = key.tenant)` row exists **and** `state='ACTIVE'` | 403 `PROFILE_GROUP_UNAUTHORIZED` |
| G4 | group root `auth_authority='GROUP_GRANT'` and `tenant_id` matches | 409 `PROFILE_CHANGED` (authority) / 404 |
| G5 | function selector matches exactly **one** row of `profile_group_members` at `group_revision = active_revision` | 0 → 404 `NOT_FOUND`; >1 → 409 `PROFILE_GROUP_UNAUTHORIZED` (ambiguous, never choose) |
| G6 | child `profile_bindings(profile_id, binding_revision)` exists and `profile_names(profile_id, group_id)` proves group ownership | 409 `PROFILE_CHANGED` |
| G7 | child revision `enabled = true` | 403 `PROFILE_GROUP_UNAUTHORIZED` |
| G8 | member `manifest_digest` equals the digest of the currently active registered version | 409 `PROFILE_CHANGED` |

Notes that are not obvious and matter:

- **G5 for v1 is selector-based, for v2 exact.** v1 gives `(businessId, businessVersion, action[, endpointSlug])`; two functions of the same group may both match (e.g. `endpoint_slug IS NULL` and `endpoint_slug='extract:invoice'`). The plan's "unique active member selector … a selector matches multiple active members → deny" is implemented here, and it is the single place that turns ambiguity into a denial. v2 adds `functionId`, so ambiguity is structurally impossible and G5 becomes an equality.
- **G8 is the "current business/version readiness" recheck** the plan requires for retry and submit. It compares the *group-pinned* digest with the live `business_versions.digest` for the active version, not with the request.
- **`profile_names.group_id` is the ownership proof** (`0067:78-81` FK), so a child profile cannot be stolen by another group and a v2 append can never resolve a foreign profile.
- **No fallback, ever.** If G2–G8 fail, the request denies; the resolver must not call `resolveEffectiveProfile` afterwards "just in case". That is the one behavior the acceptance matrix tests explicitly.

### 3.2 Standalone branch stays delegated

For `LEGACY_STANDALONE` / `CHILD_PROJECTION` groups the resolver calls the existing `profiles.resolveEffectiveProfile` unchanged. This is deliberate: v1's lock semantics, disabled-profile 403, pointer-missing 404 and `PROFILE_UNKNOWN_FIELD`/`PROFILE_LOCKED_FIELD` codes stay byte-identical without a second implementation to drift.

### 3.3 Lock order for admission

The plan (§7) fixes one order. Applied to this resolver, the v2 submit transaction must be:

```
(1) pre-read OUTSIDE any lock: key hash -> api_keys row, key_mode, grant row, group id
(2) lock profile_groups root           FOR SHARE   (sorted group ids; one here)
(3) lock business_catalog + business_versions     FOR SHARE   (existing :996-1016)
(4) lock api_keys row                  FOR SHARE   (status + key_mode unchanged)
(5) lock profile_group_api_keys grant  FOR SHARE   (state + access_version unchanged)
(6) lock profile_active_revisions + profile_bindings pins FOR SHARE
(7) locks for submission_keys / operations / tasks / outbox (existing path)
```

Two consequences worth stating because they are easy to get wrong:

- **Group before key.** The existing code locks the API-key row inside `lockProfileMutationOn` (profiles.ts) on the *profile* path. The group path must not reuse that helper, or it will create the forbidden key→group edge.
- **The grant row is locked after the key row** (step 5 after 4), exactly as the plan lists it. A concurrent `POST .../keys/:keyId/revoke` takes the group root first (PC-03/PC-04 lock order), so it serializes against step 2 and the admission either sees the tombstone (403) or completes before it.

## 4. v2 preview and submit

### 4.1 Route shapes (already frozen by PC-01)

| Route | Request DTO | Response |
|---|---|---|
| `POST /api/v2/profile-groups/:groupId/preview` | `ProfileGroupPreviewV2RequestSchema` = selector + `submission` | `ProfileGroupPreviewV2ResponseSchema` (`refs`, `resolutionFingerprint`, `effective`) |
| `POST /api/v2/profile-groups/:groupId/operations` | + required `resolutionFingerprint`; `Idempotency-Key` header | unchanged `SubmitAckSchema` |
| `POST /api/internal/admin-workbench/v2/preview` | `AdminWorkbenchProfilePreviewV2RequestSchema` (`tenantId` + `apiKeyId` required) | preview + echoed `apiKeyId` |
| `POST /api/internal/admin-workbench/v2/submit` | + `resolutionFingerprint` | `AdminWorkbenchOperationAcceptedSchema` |

Placement note (no `server.ts` change): public v2 is claimed at the top of `handlePublicRoutes` — the `/api/v2` prefix is disjoint from every handler tried before it (`server.ts:436-464`) and from the legacy public regexes. Workbench v2 is two new suffixes in `internal-admin-workbench.ts:20-27`, which already runs its auth/CSRF/`ingressAudience` gates before dispatch.

### 4.2 Preview pipeline (one function, two callers)

```
parse DTO (strict)
  -> auth: public = resolveApiKey; workbench = existing admin session/CSRF + apiKeyId
  -> selector -> admission resolution (§3.1, exact functionId)
  -> business version check: group pin digest == live active version digest   (G8)
  -> parameter resolution (§5)      -> parameters, appliedRequestDefaults, appliedSchemaDefaults, lockedParameters
  -> refs projection (ProfileGroupResolutionRefsV2Schema)
  -> fingerprint = computeResolutionFingerprint(parts)   [contracts, DO NOT re-implement]
  -> redact: no provider secret, no raw key, no connector credential
```

The **same** function backs public preview, public submit and workbench preview — the plan's "One resolver serves preview/submit". Workbench only adds: `tenantId` assert, explicit `apiKeyId` (never "first active grant"), and the local-USER scope check.

### 4.3 Submit pipeline and the exact ordering

The plan's requirement is a specific order, and every step has a test in the acceptance matrix:

```
1. parse DTO                                    -> 422
2. Idempotency-Key header present?              -> 422 (matches workbench v1 behavior)
3. auth: ACTIVE key                             -> 401
4. authorize: grant ACTIVE + authority + tenant + child enabled  -> 403/404
5. idempotency lookup (tenant, apiKeyId, routeAction, key)
      hit  -> compare request digest AND stored original fingerprint
              exact      -> 200 replay of the pinned operation (despite later drift)
              different  -> 409 IDEMPOTENCY_CONFLICT
      miss -> continue
6. recompute current refs + fingerprint
      client fingerprint != current -> 409 PROFILE_CHANGED   (no writes yet)
7. authorization re-check inside the tx (§3.3 lock order)      -> 403/409
8. INSERT operation(snapshot, pins, fingerprint) + task + submission_keys + outbox
9. post-commit dispatch (existing dispatcher), 202
```

Why step 5 precedes step 6: after a config change, the client's fingerprint is stale by definition. If the server recomputed before looking up the idempotency record, an exact network retry would 409 instead of replaying. That is precisely the failure mode the plan calls out ("an exact replay … returns its pinned operation despite later config drift").

Why step 7 must re-run the whole authorization: step 4 is a preflight. The plan forbids authorizing from a preflight-only read — a grant can be revoked between 4 and 8, and the operation must not be created on the strength of a stale read.

### 4.4 The `routeAction` scope for v2

Scope stays `(tenantId, apiKeyId, routeAction, idempotencyKey)` per the plan. Two clients of the same key hitting v1 and v2 must not collide, so `routeAction` must be injective and stable:

- public v2 submit: `profile-v2:${groupId}:${businessId}/${action}/${functionId}` 
- workbench v2 submit: `admin-workbench-v2:${groupId}:${businessId}/${action}/${functionId}`

Rationale: a different group/function under the same Idempotency-Key is a different logical request, and folding those into the hash would make the conflict message misleading. This is a design choice, not a plan mandate — flagged as Q-3.

### 4.5 Status-code matrix

| Situation | Status / code |
|---|---|
| missing/invalid/revoked key | 401 `UNAUTHENTICATED` |
| key valid, no ACTIVE grant on the group | 403 `PROFILE_GROUP_UNAUTHORIZED` |
| grant exists, wrong tenant | 404 `NOT_FOUND` |
| function not in the active group revision | 404 `NOT_FOUND` |
| two functions match the v1 selector | 409 `PROFILE_GROUP_UNAUTHORIZED` |
| group authority not `GROUP_GRANT` (mid-conversion) | 409 `PROFILE_CHANGED` |
| business version/manifest digest drift | 409 `PROFILE_CHANGED` |
| stale v2 fingerprint on a new submission | 409 `PROFILE_CHANGED` |
| same idempotency key, different request/fingerprint | 409 `IDEMPOTENCY_CONFLICT` |
| locked mapped parameter supplied (even equal) | 400 `PROFILE_LOCKED_FIELD` (v1 code, reused) |
| unknown/credential field in requestDefaults | 422 `INVALID_SCHEMA` |

## 5. Parameter resolution and the `parameterResolution` capability

### 5.1 The partition rule

Under a manifest that declares `parameterResolution`, every configured field has exactly one source:

| Source | Where it lives | Reaches request input? |
|---|---|---|
| `requestDefaults` | `profile_bindings.request_defaults` (new column, `0070` block 6) | yes, fills **absent** properties only |
| `profileSettings` | `profile_bindings.parameters` (existing policy column) | **never** (plan item 3) |

Resolution for one mapped `requestDefaults` property:

```
if client supplied the property:
    locked -> 400 PROFILE_LOCKED_FIELD   (reject even when the value is equal)
    else   -> client value wins
else if configured requestDefault exists -> configured value
else if applyTopLevelDefaults && inputSchema.properties[name].default exists -> default
else -> property stays absent
```

There is no deep merge and the falsy/empty distinction is preserved (`null`, `false`, `0`, `''`, `[]`, `{}` are values, not absences).

**Capability absent.** v1 semantics exactly: `profileSettings` is merged into request input as today (`profiles.ts:1231-1245`). This is required by "absence means v1 semantics exactly" and by the frozen v1 digest; making v2 groups universally partitioned would silently change any manifest that has never opted in. Consequence: the partition is a property of the **manifest action**, not of the route generation. Flagged as Q-1 because the alternative reading (partition every v2 group) is defensible and changes PC-03's publish validation.

### 5.2 Publish-time normalization (`isLocked`)

At v2 publish (`PC-03`) and in the resolver, normalize:

```
effectiveIsLocked = explicitIsLocked ?? mappedSchema.defaultLocked ?? false
```

where `mappedSchema` is `inputSchema.properties[name]` for a `requestDefaults` mapping and `profileSchema.properties[name]` for a `profileSettings` mapping. Today only `self-service.ts:615` reads `defaultLocked`, so without this step a manifest that relies on `defaultLocked` would publish as unlocked and a client could override an administrator's intended lock. Stored legacy `true`/`false` must keep working unchanged.

### 5.3 Manifest semantic validation (PC-05 owns; current file has none)

`validateManifest` gains a `parameterResolution` pass, active **only when the capability is declared**:

| Check | Problem pointer | Rationale |
|---|---|---|
| `version` is `2` | `$.actions[i].parameterResolution.version` | Zod literal already; semantic pass asserts the mapping matches the version's rules |
| every `fields` key exists in the mapped source's `properties` | `$.actions[i].parameterResolution.fields.<name>` | A mapping to a non-existent property is a silent no-op |
| `requestDefaults` mapping requires the property in `inputSchema.properties` | same | It fills request input |
| `profileSettings` mapping requires the property in `profileSchema.properties` | same | It fills the profile policy |
| a property mapped to `requestDefaults` must not also be declared secret (`findSecretParameterKeys`) | same | Defense in depth beside `ProfileGroupRequestDefaultsSchema` |
| when the mapped property declares a `default`, it must be the **top-level** `properties.<name>.default` | `$.actions[i].parameterResolution` | Nested / `$ref` / combinator defaults are unsupported; the plan requires rejecting them at publication *only when the capability is enabled* |
| a mapped property whose schema is a `$ref` or a combinator is rejected when `applyTopLevelDefaults` is true | same | Cannot resolve a top-level default safely |
| duplicate resolution across schemas is **not** an error | — | Intentional overlap (`example-review.enableReasoning`, `lc-checker.maxConcurrency`) must stay legal |

The capability is part of the canonical manifest, so it is already inside the digest — no extra digest work.

## 6. Workbench v2

Reuses the preview/submit pipeline with three additions:

1. **Explicit key only.** `apiKeyId` is required by the DTO; the server resolves *that* key's single ACTIVE group grant. It never lists grants and picks one. Empty grant set → preview succeeds (config stays readable) but submit denies; this matches "empty grant set disables submit while leaving the config editor readable".
2. **Local USER assignment.** `assertAdminWorkbenchAdmissionScope` gets a v2 variant that binds `(tenantId, apiKeyId, childProfileId)`: `scope.apiKeyIds` must contain the key **and** `scope.profileIds` must contain the resolved child profile. The v1 helper stays untouched for the v1 routes.
3. **Fingerprint required.** Submit recomputes and compares exactly like public submit; the response envelope is `AdminWorkbenchOperationAcceptedSchema` unchanged.

Workbench v2 deliberately does **not** reuse `preflightProfile` (`admin-workbench/service.ts:132`): that helper hardcodes `document-core`, expects a profile *name*, and compares `expectedProfileRevision`. v2 selects a group function, so name/revision equality would reject every group-configured function.

## 7. Blocker: durable storage for the resolution fingerprint

`computeResolutionFingerprint` is deterministic and needs no storage to *compute*, but replay needs the value the **client actually submitted** at first acceptance. No such column exists.

Verified: `grep -i 'fingerprint|resolution'` over all 67 migrations yields only `0046.applied_fingerprint` (settings) and `0064.actor_fingerprint` (finance adjustments). `operations` and `submission_keys` carry nothing comparable (`0001:58-68`, `0009`, `0035`).

| Option | Change | Assessment |
|---|---|---|
| **A (recommended)** `ALTER TABLE submission_keys ADD COLUMN resolution_fingerprint text` + `CHECK (resolution_fingerprint IS NULL OR resolution_fingerprint ~ '^sha256:[0-9a-f]{64}$')` | one additive migration (`0071`) | Replay is scoped exactly like the row; the TTL already bounds retention. **Outside PC-05's lease** → needs a coordinator decision (§10 Q-2). |
| B `operations.resolution_fingerprint` | migration | Permanent and immutable, but replay only needs it inside the idempotency window, and `operations` is the hot table. |
| C fold the fingerprint into `submission_keys.request_hash` (`contentHash({requestHash, fingerprint})`) | **no migration** | Implements "changed fingerprint under the same key conflicts" for free, but loses the original fingerprint as data, and the 409 for a changed fingerprint becomes indistinguishable from a changed body. |

Recommendation: **A**, with **C** as the fallback if the coordinator refuses new DDL. If C ships, the report must record that the operation row cannot reconstruct the admitted fingerprint, which weakens PC-09's replay evidence.

## 8. Test plan (PC-05)

Offline (default unit suite, no DB):

1. **Resolution matrix** — `resolveV2Parameters`: client-wins, configured-fills, schema-default-fills, locked-rejects-even-equal, falsy preservation (`false/0/''/[]/{}`/`null`), no-deep-merge, unmapped passthrough.
2. **Lock normalization** — `explicit ?? defaultLocked ?? false` for both sources; stored legacy booleans unchanged.
3. **Manifest validator** — the eight checks of §5.3, each with a passing and a failing manifest; capability-absent manifests stay byte-identical (reuse the PC-01 `I1` golden digest test).
4. **Fingerprint determinism** — `computeResolutionFingerprint` is stable across `children`/`connectorBindings` array order, changes for each ref field, and changes for a different request digest; no local re-implementation (import the contract function).
5. **Route shape** — v2 DTOs reject extra keys (`.strict()`), reject a `groupId` in the body (path-only addressing), and reject a preview body on submit without `resolutionFingerprint`.

PostgreSQL (window-gated, `DU_LIVE_INFRA=1`):

6. **Resolver** — grant ACTIVE/REVOKED/tombstone; wrong tenant; authority `CHILD_PROJECTION` on a `GROUP_MANAGED` key (denies); group with zero members; v1 selector matching two members (denies); child disabled; manifest digest drift.
7. **No fallback proof** — a `GROUP_MANAGED` key with **no** grant but **with** an ACTIVE child membership still denies (403), i.e. the resolver never reached the membership branch.
8. **Submit ordering** — stale fingerprint writes zero rows in `operations`/`tasks`/`submission_keys`/`outbox`; exact replay after a grant revoke/config update returns the original operation (this is why §7 storage matters); same key + different body → 409.
9. **Concurrency** — two clients submit with the same `Idempotency-Key` (one operation, one replay); concurrent grant revoke vs submit (either 403 or a committed operation, never a partially written operation); concurrent access-version bump vs submit (409 `PROFILE_CHANGED`).
10. **Tenant isolation** — a key from tenant B can neither preview nor submit against tenant A's group, even with a forged `groupId`; workbench `tenantId`/`apiKeyId` mismatch denies.

HTTP:

11. **Public v2** — 202 first submit, 200 replay, 409 stale, 401 revoked key, 403 no grant, 422 malformed body, and the "no provider secret / no raw key in the preview body" redaction assertion.
12. **Workbench v2** — CSRF missing → 403; viewer → 403; local USER without the key or without the child profile → 403; viewer can still read preview? (no: preview is a POST that needs admission scope — assert the documented behavior).
13. **v1 regression** — the existing v1 suites must pass unchanged with a `LEGACY_STANDALONE` key, and a `CHILD_PROJECTION` group must still resolve through memberships.

## 9. Acceptance-matrix coverage map

| Plan acceptance case | Covered by |
|---|---|
| Create/read/update/rollback a managed group with zero keys | PC-03 (not this packet) |
| Public v1 action/catalog/preflight with a `GROUP_MANAGED` key | §3.1, §2.4, test 6/7 |
| Same key proposed for another group | schema (PK `api_key_id`, `0070`) + PC-03 |
| `CHILD_PROJECTION` group before conversion | §3.2 (delegation), test 13 |
| Workbench multi-key root display and submit | §6, test 12 |
| Workbench preview followed by config change | §4.3 step 6, test 8 |
| Existing v1 submission and old client | §3.2, test 13 |
| Idempotent submit after config drift | §4.3 step 5, §7, test 8 |
| Manifest overlap and schema defaults | §5.1, §5.3, tests 1/3 |
| Locked parameter, model test and handler invoke | §5.1/§5.2, test 2 |
| In-flight operation during config/grant change | §3.3 (pins), PC-07 |

## 10. Open questions for the coordinator

| # | Question | Recommendation |
|---|---|---|
| Q-1 | Does the `profileSettings` → "never inject into request input" rule apply to **every** v2 group, or only to manifests that declare `parameterResolution`? | **Only capability-enabled manifests.** The alternative silently changes manifests that never opted in and conflicts with "absence means v1 semantics exactly". This decision changes PC-03's publish validation. |
| Q-2 | Who ships the fingerprint column (`submission_keys.resolution_fingerprint`)? PC-05's lease has no migrations. | Extend PC-05's lease with `migrations/0071_*.sql`, or accept option C (§7) and record the lost evidence. |
| Q-3 | Is `routeAction = profile-v2:<groupId>:<business>/<action>/<functionId>` acceptable, given the plan fixes the scope tuple but not the string? | Yes; it keeps v1/v2 and cross-group keys from colliding. |
| Q-4 | Should the **v1 catalogue** for a `GROUP_MANAGED` key list only that group's functions, and should a second, non-group profile binding on the same key be hidden? | Yes to both: after cutover a group key has exactly one authority source. |
| Q-5 | Workbench v2 preview for a local USER: is preview allowed when the user has the key but **not** the child profile? | Deny at submit, allow at preview only if the config editor is meant to stay readable; pick one and assert it. Default: deny both (least surprise, matches v1 `assertAdminWorkbenchAdmissionScope`). |
| Q-6 | Does PC-05 own the `parameterResolution` semantic validator, or does it belong to PC-06 (manifest/worker opt-in)? | PC-05. PC-01's receipt assigns it to PC-05 (`receipt-pc01-contracts.md` §7 item 3) and the plan lists `manifest-validator.ts` in the PC-05 lease. |

## 11. Interface expectations on PC-03 / PC-04 (not yet observable)

PC-03 and PC-04 were being written during this audit. PC-05 needs these surfaces; if PC-03 exports them differently, PC-05 adapts in the resolver only.

| Expectation | Why PC-05 needs it |
|---|---|
| A group reader returning `GroupAuthorityRecord` (`{groupId, tenantId, authority, accessVersion, activeRevision}` — already present in `profile-groups.ts:45-51`) | G4/G5/G8, and refs projection without duplicating SQL |
| A group-member reader that returns member pins including `request_defaults` and `created_by` | §5 resolution and preview refs |
| A grant reader scoped by `(apiKeyId, tenantId)` returning `state` | G3 |
| PC-04 issuing every new key with an explicit `key_mode`, and rotating it unchanged | G2; a NULL mode must deny, never fall back |
| PC-04 exposing "is this key group-managed and which group" as one read | avoids a second look-up order in admission |

If PC-03 publishes a different shape, the only file PC-05 should need to touch is `resolution.ts` — that containment is a design goal, not an accident.

## 12. References

| Topic | Location |
|---|---|
| Resolver (v1) | `services/orchestrator/src/modules/profiles/profiles.ts:414-473,1186-1248` |
| Admission transaction | `services/orchestrator/src/modules/operations/submission.ts:679-1230,1850-1905` |
| Idempotency scope + advisory lock | `submission.ts:724-743,971-989`; `migrations/0001:58-68` |
| v1 catalogue | `compat/legacy-host-adapter.ts:541-571` |
| Workbench v1 | `modules/admin-workbench/service.ts:67-83,132-160,162-269` |
| Workbench route gates | `http/routes/internal-admin-workbench.ts:10-27` |
| Public route chain | `http/routes/public.ts:135-147,510-544`; `server.ts:436-467` |
| Parameter merge/lock | `modules/profiles/policy.ts:233-275`; `defaultLocked` precedent `modules/profiles/self-service.ts:615-616` |
| Manifest validator | `packages/contracts/src/manifest-validator.ts:46-118` |
| Capability contract | `packages/contracts/src/manifest.ts:40-57,74-77` |
| V2 DTOs + fingerprint | `packages/contracts/src/profile-groups.ts:149-175,393-603,609-618` |
| Workbench v2 DTOs | `packages/contracts/src/admin-workbench.ts:71-132` |
| Credential-key refusal | `packages/contracts/src/profile-policy.ts:97-121` |
| Request hashing | `packages/contracts/src/hashing.ts:13-47` |
| Storage added by PC-02 | `migrations/0070_profile_control_plane_storage.sql` (blocks 1,3,4,5,6) |
| Master plan | `du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` §PC-05, §Manifest parameter and lock resolution |
