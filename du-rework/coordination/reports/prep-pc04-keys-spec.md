# PREP-PC-04 — Key & auth lifecycle pre-analysis and design (READ-ONLY)

| Field | Value |
| :--- | :--- |
| Packet | `PREP-PC-04` — *Key and Auth Lifecycle Pre-Analysis & Design* |
| Dispatch | [`du-rework/coordination/dispatch-specs/PC-04-prep-dispatch.txt`](../dispatch-specs/PC-04-prep-dispatch.txt) |
| Master plan | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) — PC-04 row, §"Settled data and authorization model" items 2, 3, 5, 6, 7 |
| Worker | `dsh_2` (DeepSeek Harness, `deepseek-v4.1-flash`) — *Identity & Auth Subsystem Specialist* |
| Mode | **READ-ONLY.** No production source edited; no DB/Redis used; no test executed. |
| Output | This report only. |
| Verdict | **Not shippable as-is.** 5 production mint sites write `key_mode = NULL` (0 occurrences of `key_mode` anywhere in `src/`), global revoke touches no group grant, and the dispatcher's idempotency marker stores the raw key in plaintext. Design + decisions below; 2 hard dependencies block execution. |

**Tóm tắt (VI).** Đã audit read-only 7 nhóm file (identity, dispatcher, parity, auth, BFF, migration 0070, read projections). Kết quả chính: (1) **không có đường mint nào ghi `key_mode`** — 4 INSERT production + 1 seed dev đều để NULL, và `key_mode` không xuất hiện lần nào trong `src/`; (2) `apikey.revoke` (dispatcher) chỉ đổi `api_keys.status`, **không** thu hồi `profile_group_api_keys`, **không** tăng `access_version`, không đụng membership/local-user grant, không bump `version`; (3) `apikey.attach` đã chặn child nhưng trả `STATE_CONFLICT` thay vì `PROFILE_GROUP_V2_REQUIRED`, và không chặn key `GROUP_MANAGED`; (4) replay `apikey.issue`/`apikey.rotate` **tái phát raw key** từ `admin_idempotency.response_body` — trái với invariant đã ghi ở `0054_admin_parity.sql` và trái với đường parity (đã đúng); (5) rotate bỏ qua group grant, không copy local-user grant ở dispatcher, và yêu cầu ≥1 membership nên không thể rotate `UNMANAGED_LEGACY`/`GROUP_MANAGED`. Có 2 dependency chặn thực thi (test-lease + grant helper của PC-03) và 11 quyết định cần coordinator chốt (§8).

---

## 0. Evidence boundary

### 0.1 Read (whole files unless noted)

| # | Path | Lines |
| :--- | :--- | :--- |
| 1 | `services/orchestrator/src/modules/identity/api-keys.ts` | 351 (full) |
| 2 | `services/orchestrator/src/modules/identity/service.ts` | 420 (full) |
| 3 | `services/orchestrator/src/modules/admin-actions/dispatcher.ts` | 770-1264 (all `apikey.*` cases) + 118-196 (action table) |
| 4 | `services/orchestrator/src/http/routes/internal-parity.ts` | 80-330 + 282-321 (key routes) |
| 5 | `services/orchestrator/src/http/routes/api-key-auth.ts` | 26 (full) |
| 6 | `services/orchestrator/src/app/admin/bff/identity.ts` | 337 (full) |
| 7 | `services/orchestrator/src/app/admin/bff/key-minting.ts` | 31 (full) |
| 8 | `migrations/0070_profile_control_plane_storage.sql` | 255 (full) |
| 9 | Supporting: `modules/idempotency/idempotency.ts` (166), `modules/profiles/profiles.ts` 750-1000 + 1020-1305, `modules/profiles/self-service.ts` (key/membership anchors), `modules/admin-read/profile-api-keys.ts` (93), `http/routes/admin.ts` 420-500 + 578-626 + 1368-1421, `app/admin/bff/handle.ts` 745-803, `app/admin/bff/profiles.ts` 395-422, `app/bootstrap/create-app.ts` 495-526, `migrations/0001_platform_v1.sql` + `0024` + `0054` (api_keys shape) | — |
| 10 | Peer prep specs, for seam alignment: `prep-pc03-service-spec.md` §4.2/§4.7/§4.8/§4.9 (grant seam, group-key mint, conversion), `prep-pc05-admission-spec.md` 120-121, 139-140, 164-167, 393 (mode pre-read, NULL must deny) | — |

Grep sweeps (whole `orchestrator/`): `key_mode`, `profile_group_api_keys`, `INSERT INTO api_keys`, `apikey.(issue|rotate|revoke|attach)`, `identity.issue`, `purgeIdempotencyMarkers`, `LEGACY_STANDALONE|GROUP_MANAGED|UNMANAGED_LEGACY|KeyMode`.

### 0.2 Not done

- No source edit (PC-04 lease untouched), no migration, no `pnpm`.
- **No live evidence.** Every statement below is source-level; nothing was executed against PostgreSQL, so no claim about runtime behavior, data state, or deployed keys is made.
- Working tree already contains PC-01 changes (4 modified contract files + `tests/profile-groups-v2.test.ts`, uncommitted) and PC-03 work in `profiles.ts`/`profile-groups.ts`; line numbers are the tree as of this audit.

---

## 1. Inventory: every path that writes `api_keys`

`grep -n "key_mode" services/orchestrator/src` → **0 hits**. `0070:26-29` deliberately has **no DEFAULT**, so all five writers below produce `NULL` today.

| # | Writer | Anchor | INSERT statement | `key_mode` today | Required |
| :--- | :--- | :--- | :--- | :--- | :--- |
| M1 | `apikey.issue` (dispatcher) | `dispatcher.ts:839-931`, INSERT `:882-885` | `(tenant_id, hash, prefix, name)` | **NULL** | `LEGACY_STANDALONE` literal |
| M2 | `apikey.rotate` (dispatcher) | `dispatcher.ts:1125-1264`, INSERT `:1211-1214` | `(tenant_id, hash, prefix, name)` | **NULL** | inherit old mode |
| M3 | `POST /api/internal/parity/api-keys` → `keys.issue` | `internal-parity.ts:284-297`; `api-keys.ts:179-220`, INSERT `:201-205` | `(id, tenant_id, hash, prefix, name, status, version, updated_at)` | **NULL** | `LEGACY_STANDALONE` literal |
| M4 | `POST …/api-keys/:id/rotate` → `keys.rotate` | `internal-parity.ts:312-315`; `api-keys.ts:246-312`, INSERT `:278-282` | same as M3 | **NULL** | inherit old mode |
| M5 | Dev fallback seed | `create-app.ts:505-526`, INSERT `:519-525` | `(id, tenant_id, hash, prefix, status)` | **NULL** | `UNMANAGED_LEGACY` (or documented exception) |
| M6 | Group-key operation (**not in the tree yet**) | PC-03 owns; `profile-groups.ts` currently has only `getProfileGroup` `:424`, `listProfileGroups` `:437`, `saveProfileGroup` `:749`, `rollbackProfileGroup` `:890`. PC-03's own spec already plans `issueGroupKey` inserting `key_mode='GROUP_MANAGED'` (`prep-pc03-service-spec.md` §4.2 line 199, §4.7 line 333, §4.23 line 418) | — | — | `GROUP_MANAGED` + grant row, atomically (PC-03) |

So the invariant the coordinator asked for ("never NULL") is violated by construction on **every** current mint path. `api_keys.version` has a default of 1 (`0054:10`) and `name` is nullable (`0024:80`), so M1/M2 happen to be valid rows — which is exactly why this defect is silent rather than a hard error.

**Blast-radius ordering risk.** `0070` backfills rows that existed at migration time (`0070:48-57`), and PC-02 is already live-tested. Any key minted after 0070 has `key_mode = NULL`; the moment PC-05's resolver fails closed (plan item 2: "A missing or unknown value after migration is an authorization error"), **all keys minted since 0070 stop authenticating**. PC-04 must land the writers (and a remediation pass, D-9) before PC-05 tightens auth.

---

## 2. Inventory: revoke, rotate, attach, issue-with-profiles

### 2.1 Global revoke — two implementations, neither complete

| | `apikey.revoke` (dispatcher) `:932-990` | parity `POST /api-keys/:id/revoke` → `keys.revoke` `api-keys.ts:314-343` |
| :--- | :--- | :--- |
| Key status → `REVOKED` | yes (`:962-965`) | yes (`:332-335`) |
| ACTIVE-status guard | yes | CAS on `expectedVersion` |
| `api_keys.version` bump | **no** | yes (`version=version+1`) |
| `profile_api_keys` memberships | **no** | yes (`:325-326`) |
| `admin_local_user_api_key_grants` | **no** | deletes + bumps `assignment_version` (`:327-331`) |
| `profile_group_api_keys` grants | **no** | **no** |
| `profile_groups.access_version` | **no** | **no** |
| Idempotent replay | header marker (`:983-985`) | none (CAS replay ⇒ 409) |
| Key row lock order | **none** — unlocked read (`:945-948`), guarded conditional UPDATE (`:962-965`) | key `FOR UPDATE` first (`:318-320`) |

The parity route also requires `expectedVersion` in the body (`internal-parity.ts:316-318`) while the dispatcher action takes none — the same key can be revoked through two surfaces with different preconditions and different side effects.

### 2.2 Rotation — three gaps per implementation

`dispatcher.ts:1125-1264`:
- `:1167-1175` — **requires ≥1 ACTIVE `profile_api_keys` membership**; otherwise 409 `STATE_CONFLICT` "nothing to inherit". A `GROUP_MANAGED` key has no child memberships by design (plan item 4: group-owned append "never creates an ACTIVE `profile_api_keys` membership"), and an `UNMANAGED_LEGACY` key has none ever — both are unrotatable.
- `:1180-1201` — selector-locked snapshot of child memberships (good, reusable pattern).
- `:1202-1225` — copies **only** child memberships; **no** group grant, **no** `admin_local_user_api_key_grants`.
- `:1211-1214` — INSERT without mode.
- `:1256-1259` — marker body is the full response **including `rawKey`**.

`api-keys.ts:246-312`:
- `:274-288` — copies child memberships, revokes the old ones.
- `:289-298` — copies `admin_local_user_api_key_grants` and bumps the users' `assignment_version` (the dispatcher is missing exactly this).
- No mode, no group grant, no `access_version` bump.

Plan item 5 requires: "Rotation creates a new key ID and copies only the current same-group grant (or, for legacy modes, the exact existing legacy memberships); it never adds functions or profiles."

### 2.3 Attach — right idea, wrong code, missing key-mode fence

`dispatcher.ts:991-1124`:
- `:1017-1036` — profile ownership read; a child (`group_id NOT NULL`) ⇒ **409 `STATE_CONFLICT`**.
- `:1070-1076` — the same check again after `profile_names … FOR UPDATE` (correct TOCTOU ordering).
- `:1077-1091` — overlapping-binding guard.
- `:1092-1095` — `addMembership` (UPSERT; can resurrect a REVOKED membership, `profiles.ts:1255-1269`).
- **No check on the key's own mode**: a `GROUP_MANAGED` key could be attached to a *standalone* profile, creating the child-membership fallback that plan item 2 explicitly forbids ("cannot use child-membership fallback").
- The plan's contract code for this denial is `409 PROFILE_GROUP_V2_REQUIRED` (plan §"DTO and route contract": "child attach/upsert/self-service mutations for a `GROUP_GRANT` group or its children return 409 `PROFILE_GROUP_V2_REQUIRED`"), and PC-03 already emits exactly that on the sibling path (`profiles.ts:871-885`).

### 2.4 Issue with `profileIds` — child memberships can still be created

- Parity body schema accepts `profileIds` (`packages/contracts/src/parity.ts:81-86`).
- `api-keys.ts:182` normalizes them, `:200` validates only *existence in the tenant* (`profilesExistForClient`, `:103-109` — no `group_id` predicate), `:208-210` inserts ACTIVE memberships.
- Plan item 6: "`identity.issue`/`apikey.issue` routes must reject grouped child profile IDs; use the root grant operation instead." (`identity.issue` does not exist in the action table `dispatcher.ts:138-196`; the parity route is the live equivalent.)
- `apikey.issue` (dispatcher) accepts **no** `profileIds` — it cannot attach today. Good.

---

## 3. Inventory: auth, idempotency, BFF, reads

### 3.1 Public key resolution

`api-key-auth.ts:10-22` selects `id, tenant_id` from `api_keys WHERE hash=$1 AND status='ACTIVE'` and returns `{ id, tenantId }`. No mode, no grant lookup, no authority decision — by design, that is PC-05's job. The contract PC-04 owes PC-05 is: **the resolver must surface the mode and refuse a NULL/unknown one**, otherwise PC-05 has to add a second key query (or silently default).

### 3.2 Two idempotency stacks with opposite secret policies

| | Parity path (`keys.issue`/`keys.rotate`) | Dispatcher path (`apikey.issue`/`apikey.rotate`) |
| :--- | :--- | :--- |
| Mechanism | body `idempotencyKey` → `admin_api_key_mutations` (`api-keys.ts:188-199`, table `0054:36-45`) | header `Idempotency-Key` → `admin_idempotency` (`idempotency.ts:30`, `:76-83`) |
| What is stored | `(tenant, idempotency_hash, operation, request_hash, api_key_id)` — **no key material** | `response_body = JSON.stringify(body)` — `idempotency.ts:127-135` |
| Replay result | `{ key, secretAvailable: false }`, no `secret` (`api-keys.ts:218-219`), asserted by `tests/api-keys-parity.test.ts:43-53` | the stored body verbatim (`idempotency.ts:103-111`), i.e. **`rawKey` is re-emitted** (`dispatcher.ts:900-914`, `:1256-1259`) |
| Migration intent | `0054:33-35`: *"Idempotency records intentionally store no key material. If the first response is lost, the replay identifies the already-created key and asks the operator to rotate it; it cannot recover the copy-once secret."* | violated |
| Retention | no purge job (row holds no secrets) | `purgeIdempotencyMarkers` (`idempotency.ts:156-166`) is exported but **not wired** — only tests call it |

So today: a raw `du_…` key is written in plaintext into `admin_idempotency.response_body`, survives indefinitely, and is handed back to any caller presenting the same idempotency key + body. The BFF forwards the header (`handle.ts:790-801`), so a normal browser retry exercises exactly this path.

### 3.3 BFF surface

| File | Fact |
| :--- | :--- |
| `bff/key-minting.ts:18-31` | `KEY_MINTING_ACTIONS = {apikey.issue, apikey.rotate}`; `withMintedRawKey` injects `du_<32 random bytes base64url>` **only when the caller sent nothing** |
| `bff/handle.ts:776-801` | generic `/admin/api/actions` passthrough: mints, forwards `Idempotency-Key` |
| `bff/profiles.ts:409-419` | profile key pane: `attach` / `rotate`; **`rotate` also sends `profileId`, which the dispatcher ignores** — the action is a global key rotation, not a profile-scoped one |
| `bff/identity.ts` | users/assignments only — **no key minting**; nothing in PC-04's lease to change here except consistency notes |
| `app/admin/shell-server.ts:800-810` | legacy shell mints its own raw value (out of lease, same wire) |

`bff/key-minting.ts` is the only key-minting file inside the PC-04 lease; the two call sites are not. That constrains the "mode injection" design to the dispatcher (which must be authoritative anyway).

### 3.4 Read surfaces

- `api-keys.ts:111-134` (`safeRow`) → `ApiKeyLifecycleRow` (`contracts/parity.ts:58-70`): no `keyMode`.
- `admin.ts:1368-1421` → `SELECT id, tenant_id, prefix, name, status, created_at, updated_at`; `buildApiKeyPage` projects grants from `profile_bindings` only.
- `admin-read/profile-api-keys.ts:50-93` → per-profile membership read; no mode, no group grant.
- Nothing reads `profile_group_api_keys` outside migrations/tests (`grep`).

Consequence: the Admin UI cannot tell a group-managed key from a standalone key today. The v2 group DTO (`apiKeyGrants[]`, PC-01) covers the Workbench list, so a wire change on the api-keys list is **optional** (D-8).

### 3.5 Migration 0070 facts relied on

| Fact | Anchor |
| :--- | :--- |
| `key_mode` nullable, **no default**, CHECK on the 3 values | `0070:26-29` |
| Backfill rule: any footprint ⇒ `LEGACY_STANDALONE`, else `UNMANAGED_LEGACY`; never `GROUP_MANAGED` | `0070:34-57` |
| `api_keys (id, tenant_id)` unique (FK target) | `0070:67-68` |
| `profile_groups.auth_mode/auth_authority/access_version` | `0070:86-94` |
| `profile_group_api_keys` — PK = `api_key_id` (one group per key **forever**), tenant-safe composite FKs, tombstone shape CHECK | `0070:114-150` |
| Child authors nullable + `created_by` attribution | `0070:158-204` |
| `profile_bindings.request_defaults` | `0070:211-217` |

Note for the rotation design: because the ledger PK is `api_key_id`, rotation cannot "move" a grant — it must INSERT a new row for the new key and REVOKE the old one (tombstone retained). That is consistent with the plan's "permanently associated with at most one group".

---

## 4. Findings (severity, evidence, consequence)

| # | Sev | Finding | Evidence | Consequence if unfixed |
| :--- | :--- | :--- | :--- | :--- |
| **F1** | **HIGH** | No mint path writes `key_mode`; 0 references in `src/` | §1 M1-M5 | Every key minted after 0070 is `NULL`; PC-05 fail-closed turns that into a total auth outage; and the plan's invariant "missing mode is an authorization error" is untestable |
| **F2** | **HIGH** | Global revoke leaves active root grants and a stale `access_version` | §2.1; plan item 5 | Public auth still stops via the `status='ACTIVE'` filter, but the ledger keeps a live grant for a dead key and `access_version` never moves — so v2 preview/submit CAS, the fingerprint, and every grant-based check cannot observe the revoke. Violates "global revoke revokes every active root grant in the same transaction, incrementing each affected access version" |
| **F3** | **HIGH** | `apikey.issue`/`apikey.rotate` idempotency marker stores and replays the raw key | §3.2 | Plaintext credential at rest in `admin_idempotency` (no retention wiring), re-emitted on replay — contradicts `0054:33-35` and the parity contract |
| **F4** | **HIGH** | Rotation ignores the root grant and cannot rotate `GROUP_MANAGED`/`UNMANAGED_LEGACY` keys | §2.2 | Group keys cannot be rotated at all; legacy no-profile keys cannot be rotated; forced manual re-mint bypasses the ledger |
| **F5** | MED | `apikey.attach` returns `STATE_CONFLICT` instead of `PROFILE_GROUP_V2_REQUIRED`, and does not refuse `GROUP_MANAGED` keys | §2.3 | Wrong wire contract for the UI/tests; a group key can acquire child memberships (forbidden fallback) |
| **F6** | MED | Parity issue/rotate accepts grouped child `profileIds` | §2.4 | Creates ACTIVE child memberships for group children — the exact legacy write the cutover forbids |
| **F7** | MED | Dispatcher rotate drops `admin_local_user_api_key_grants` | §2.2 vs `api-keys.ts:289-298` | A local USER silently loses Workbench access when an admin rotates via the actions route |
| **F8** | MED | Dispatcher revoke neither bumps `api_keys.version` nor cleans memberships/user grants | §2.1 | CAS preconditions diverge between surfaces; profile key panes show ACTIVE memberships for a dead key; a stale `version` keeps admin note/rotate preconditions misleading |
| **F9** | MED | `resolveApiKey` exposes no mode and cannot fail closed | §3.1 | PC-05 would need a second query per request, or would default — the plan forbids defaulting |
| **F10** | MED | No shared `KeyMode` type in `@du/contracts` | `grep` 0 in `packages/contracts/src` | Mode strings would be duplicated in PC-03/04/05/08 with no compile-time protection; DB CHECK is the only guard (violation ⇒ 500) |
| **F11** | MED | Grant revoke is unsafe in both lock shapes: the parity revoke locks the key row first (`api-keys.ts:318-320`), so adding group locks *after* it violates "no path may lock a key and then a group"; the dispatcher revoke takes **no** row lock at all (`:945-948`), so an unlocked grant enumeration can race a concurrent grant | §2.1; plan item 7 | Either the forbidden order (deadlock against group writes) or a lost grant revoke (a grant outlives the key revoke) |
| **F12** | LOW | `apikey.issue` accepts a caller-chosen raw value from any platform caller (BFF mints only when absent) | `dispatcher.ts:845-851`; `key-minting.ts:25-31` | A platform admin can mint a low-entropy key; no policy forbids it |
| **F13** | LOW | `bff/profiles.ts` sends `profileId` to `apikey.rotate`, which ignores it | `bff/profiles.ts:409-419` vs `dispatcher.ts:1133` | UI implies profile-scoped rotation; the action revokes the key globally across every profile |
| **F14** | LOW | Dev fallback key row (M5) will be `NULL`-mode | `create-app.ts:519-525` | A NULL row survives in dev DBs; it never authenticates (placeholder hash) but pollutes the "no NULL" check |

---

## 5. Design

### 5.1 Shared `KeyMode` type (dependency D-5)

Add to `@du/contracts` (PC-01 addendum — PC-01's `ProfileGroupAuthModeSchema` is the *group* auth mode `'API_KEY'`, a different concept):

```ts
// packages/contracts/src/identity.ts (or a new api-key-mode.ts re-exported by index.ts)
export const API_KEY_MODES = ['GROUP_MANAGED', 'LEGACY_STANDALONE', 'UNMANAGED_LEGACY'] as const;
export const ApiKeyModeSchema = z.enum(API_KEY_MODES);
export type ApiKeyMode = z.infer<typeof ApiKeyModeSchema>;
```

Why contracts and not a local const: PC-03 (group op), PC-04 (writers/revoke/rotate/attach), PC-05 (resolver branches), PC-08 (UI labels) all need the same three literals, and a typo must fail at compile time rather than at the DB CHECK (23514 ⇒ generic 500).

Until that lands, PC-04 can use a local `const` with `satisfies ApiKeyMode[]` — but the enum must not be spelled twice in runtime SQL paths.

### 5.2 Mint matrix — every INSERT names its mode explicitly

| Site | Statement change | Value | Notes |
| :--- | :--- | :--- | :--- |
| M1 `apikey.issue` | add `key_mode` column + param | `'LEGACY_STANDALONE'` (literal, never caller-driven) | reject `params.keyMode` when present and `!== 'LEGACY_STANDALONE'` → `409 PROFILE_GROUP_V2_REQUIRED` ("use the group-key operation"), zero writes |
| M2 `apikey.rotate` | add `key_mode` | `old.key_mode` (already loaded at `:1150-1155`) | unknown/NULL old mode ⇒ `409 STATE_CONFLICT` "key mode is not declared" before any write |
| M3 parity issue | add `key_mode` | `'LEGACY_STANDALONE'` | body schema has no mode field; leave the contract alone |
| M4 parity rotate | add `key_mode` | `old.key_mode` | same NULL guard |
| M5 dev seed | add `key_mode` | `'UNMANAGED_LEGACY'` | keeps the invariant measurable in dev |
| M6 group op (PC-03) | add `key_mode` | `'GROUP_MANAGED'` | plus the grant row + `access_version` increment in the same tx |

Hard rules: no `DEFAULT` in SQL, no fallback in code, and `NULL` on a write is a defect (add an assertion/test, §6 T1-T4).

### 5.3 Global revoke (F2, F8, F11) — algorithm and lock order

Both surfaces converge on one internal function so they cannot drift:

```ts
// modules/identity/api-keys.ts (or a shared key-lifecycle module inside the lease)
export interface RevokedKeyOutcome {
  apiKeyId: string;
  status: 'REVOKED';
  version: number;
  revokedGrants: Array<{ groupId: string; accessVersion: number }>;
  revokedMemberships: number;
  revokedUserAssignments: number;
}

export async function revokeApiKeyGlobally(
  client: PoolClient,
  input: { tenantId: string; apiKeyId: string; expectedVersion?: number; actor: ApiKeyActor },
): Promise<RevokedKeyOutcome>
```

Transaction body (order is normative, plan item 7):

1. **Pre-read, no locks**: `SELECT tenant_id FROM api_keys WHERE id=$1` → 404 if absent; caller's tenant fence on the returned tenant.
2. **Enumerate candidate roots, no locks**: `SELECT group_id FROM profile_group_api_keys WHERE api_key_id=$1 AND tenant_id=$2 AND state='ACTIVE' ORDER BY group_id`.
3. **Lock group roots in sorted id order**: `SELECT group_id FROM profile_groups WHERE group_id=ANY($1::uuid[]) AND tenant_id=$2 ORDER BY group_id FOR UPDATE`.
4. **Lock the key row** (only now): `SELECT … FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE`; re-read status/version; `expectedVersion` mismatch ⇒ `409 IDENTITY_VERSION_CONFLICT`; non-ACTIVE ⇒ `409 STATE_CONFLICT`.
5. **Delegate the grant revoke to the PC-03 seam** (`revokeAllGroupGrantsForApiKey`, §5.4) while the root locks are held: it tombstones every ACTIVE grant of the key and bumps each affected `access_version`, returning `{ revoked, groupIds }`. The statements PC-04 must **not** write itself, quoted for review only:
   `UPDATE profile_group_api_keys SET state='REVOKED', revoked_at=now(), revoked_by=$3 … WHERE api_key_id=$1 AND state='ACTIVE'`;
   `UPDATE profile_groups SET access_version=access_version+1 WHERE group_id=ANY($1) … RETURNING group_id, access_version`.
   (Under Shape B from §5.4 this step runs *before* step 4; the key update stays last either way.)
6. **Revoke child memberships** (`state='REVOKED', revoked_at=now()`), **delete local-user key grants** and bump those users' `assignment_version` (mirror `api-keys.ts:325-331`).
7. **Revoke the key**: `UPDATE api_keys SET status='REVOKED', version=version+1, updated_at=now() WHERE id=$1 AND status='ACTIVE' AND version=$2 RETURNING …`.
8. **Audit**: one `admin_api_key.revoke` row carrying `{ revokedGroupIds }` in the resource/extra, plus the actor triple — never the raw key.

Idempotent replay (header path) keeps returning `{ id, status:'REVOKED' }`; a second revoke without a marker is `409 STATE_CONFLICT` (unchanged).

Note on step 3 vs step 2: a concurrent grant between 2 and 3 adds a grant row that step 5 will still catch (it re-reads under the ledger lock), but its `access_version` bump (if the granter already committed) happens inside the granter's own tx on the same group row — the group lock in step 3 serializes the two. If the granter commits *after* step 3, it must wait on the root lock and then observe `api_keys.status='REVOKED'` (plan item 7: "a concurrent grant must see a revoked key and fail").

### 5.4 Root-grant helper seam (dependency D-2 — PC-03 owns, names already specified there)

`prep-pc03-service-spec.md` already commits to this exact seam, including the rule *"PC-04 must not implement its own SQL against `profile_group_api_keys`"* (`§4.8`, lines 375-390). PC-04 therefore codes against these two exports from `modules/profiles/profile-groups.ts`:

```ts
// prep-pc03-service-spec.md §4.2 (line 200-201) / §4.8 (line 379-384)
export async function revokeGroupGrant(
  client: PoolClient,
  groupId: string,
  apiKeyId: string,
  expectedAccessVersion: number,
  actor: ProfileGroupActor,
): Promise<{ grant: /* revoked tombstone */; accessVersion: number }>;

export async function revokeAllGroupGrantsForApiKey(
  client: PoolClient,
  apiKeyId: string,
  tenantId: string,
  actor: ProfileGroupActor,
): Promise<{ revoked: number; groupIds: string[] }>;
```

Three gaps to close before PC-04 wave B:

1. **Rotation re-grant has no seam.** `issueGroupKey` mints its own raw key (`§4.2` line 199), but rotation already carries a BFF-minted value, so it cannot be reused. Request one addition to PC-03:
   ```ts
   /** Grant an ALREADY-INSERTED key row to one group; bumps access_version. */
   export async function grantExistingGroupKey(
     client: PoolClient,
     input: { groupId: string; tenantId: string; apiKeyId: string; actor: ProfileGroupActor },
   ): Promise<{ groupId: string; accessVersion: number }>;
   ```
   Without it, `GROUP_MANAGED` rotation is not implementable inside the PC-04 lease (D-2, D-6).
2. **Call-order conflict with the plan.** `revokeAllGroupGrantsForApiKey`'s doc comment says it is *"called INSIDE PC-04's global-revoke transaction, after api_keys.status flips"* (`§4.8` line 378). That is the forbidden order: flipping status locks the `api_keys` row, and the helper then locks group roots ⇒ key→group (plan item 7: "No path may lock a key and then a group"). Resolve one way, explicitly:
   - **Shape A (plan-literal):** PC-04 pre-reads candidate roots unlocked, locks roots sorted, locks the key row, then calls the helper with roots already held (its `FOR UPDATE` on those rows is a same-transaction re-lock and cannot deadlock), then updates the key last.
   - **Shape B (helper-first):** PC-04 calls the helper *before* touching the key row (helper locks roots, revokes grants, bumps versions), then locks/updates the key. Safe only because a concurrent grant that blocks on the root lock must re-check `api_keys.status` after acquiring it.
   Either way the helper's comment must be corrected; PC-04 cannot implement the plan's lock order against the comment as written.
3. **`revokeGroupGrant` takes `expectedAccessVersion`.** PC-04's global revoke has no client-supplied access version for the *grant*; it must read the current version under the root lock and pass it, or PC-03 needs an unconditional internal variant. Rotation has the same issue. Recommend: PC-03 accepts an explicit `expectedAccessVersion: number | 'ANY'` for internal callers, documented as "internal seam, never route-reachable".

Do not create a second grant writer (`access_version` increments must have exactly one owner).


### 5.5 Rotation per mode (F4, F7)

| Old mode | New mode | Inherit | Never |
| :--- | :--- | :--- | :--- |
| `GROUP_MANAGED` | `GROUP_MANAGED` | read the current grant under the root lock → `revokeGroupGrant` (old ⇒ tombstone) + `grantExistingGroupKey` (new row, §5.4); each helper bumps `access_version` once, one commit | no `profile_api_keys` rows, no local-user grants invented |
| `LEGACY_STANDALONE` | `LEGACY_STANDALONE` | exact ACTIVE child memberships (existing selector-locked snapshot `:1167-1201`) + `admin_local_user_api_key_grants` + `assignment_version` bump | no group grant |
| `UNMANAGED_LEGACY` | `UNMANAGED_LEGACY` | nothing | no memberships, no grant, no user grants |
| `NULL`/unknown | — | — | `409 STATE_CONFLICT`, zero writes |

Also:
- **Drop the blanket "nothing to inherit ⇒ 409"** (`:1168-1175`, `:1199-1201`) when the mode is known: plan item 5 requires `UNMANAGED_LEGACY` rotation and tombstone-only `LEGACY_STANDALONE` rotation to succeed. Keep the snapshot-mismatch 409 (`:1196-1198`) — that one protects correctness, not inheritance size.
- A `GROUP_MANAGED` rotation must also copy local-user grants for the group (users keep Workbench access after a rotate) — decide once and apply to both implementations.
- Preserve the `(rotated)` name convention (`:1208-1210`) and the copy-once response shape.

### 5.6 Attach fences (F5)

Order inside the existing transaction (all before `addMembership`):

1. Key row as today; `status !== 'ACTIVE'` ⇒ `409 STATE_CONFLICT` (unchanged).
2. `key.key_mode === 'GROUP_MANAGED'` ⇒ `409 PROFILE_GROUP_V2_REQUIRED`, message "this key is authorized by a profile-group grant; manage it through the group".
3. `key.key_mode` NULL/unknown ⇒ `409 STATE_CONFLICT`, message "key authority mode is not declared".
4. Profile ownership (`profile_names.group_id`) — **keep the current strict block for every group child**, but change the code to `409 PROFILE_GROUP_V2_REQUIRED` (both fences `:1034-1036` and `:1074-1076`). Rationale for "strict" over the plan's authority-aware reading: `apikey.attach` adds a *second* ACTIVE membership on a child, and the v1 group read resolves its displayed key by intersecting child memberships (`profile-groups.ts` v1 path: 0 or >1 ⇒ 409). Allowing attach on a `CHILD_PROJECTION` child would make that read fail, which is a worse regression than requiring the group save path. See D-3.
5. Existing overlap/binding checks unchanged.

`apikey.bind-profile` needs no change: it funnels into `profiles.createRevision`, which already returns `PROFILE_GROUP_V2_REQUIRED` (`profiles.ts:871-885`). Cite that as the precedent to match.

### 5.7 Issue with `profileIds` (F6)

In `api-keys.ts::issue`, replace the existence-only check (`:103-109`) with an ownership-aware one:

```sql
SELECT n.profile_id, n.group_id
  FROM profile_names n
 WHERE n.tenant_id=$1 AND n.profile_id=ANY($2::uuid[])
 FOR SHARE;
-- rowCount must equal input length, else 422 FOREIGN_GRANT (unchanged)
-- any group_id IS NOT NULL ⇒ 409 PROFILE_GROUP_V2_REQUIRED
```

Same predicate for the "does this key already have an overlapping binding" style checks if a second membership path is added later. Note the parity body schema is frozen (`parity.ts:81-86`), so no shape change.

### 5.8 Idempotency and secret-once (F3)

Rule: **the marker never carries key material; a replay never returns it.**

`apikey.issue` (dispatcher, `:900-914`):

```ts
const responseBody = { id, tenantId, prefix, name, status, createdAt, secretAvailable: true, rawKey: p.apiKey };
const markerBody   = { ...responseBody, rawKey: null, secretAvailable: false };
// first response: responseBody; marker: markerBody
call.idempotencyKey ? (client) => withMarker(client, { status: 201, body: markerBody }) : undefined
```

`apikey.rotate` (`:1256-1259`) identical treatment of `rawKey`.

Then:
- Replay body gains `secretAvailable: false` and `rawKey: null`; the UI already renders a "rotate to get a new secret" path for the parity envelope (`ApiKeyMutationResultSchema`, `contracts/parity.ts:100-105`), so the two surfaces converge.
- Document the exception in `modules/idempotency/idempotency.ts` header ("one-shot secrets are stored redacted; a replay returns metadata only") so a future action does not reintroduce the leak.
- Optional: emit `idempotent-replay: true` from the actions route (the profile-bindings route already does at `admin.ts:499`); it makes the redaction observable to clients.
- Retention (F3 second half): with redaction the urgency drops, but wiring `purgeIdempotencyMarkers` remains an ops follow-up — do not add a timer in PC-04.

Consequence to accept explicitly: if the first 201 is lost in transit, the raw key is unrecoverable and the operator must rotate. That is already the documented parity behaviour (`0054:33-35`) and the safer default.

### 5.9 Auth resolver (F9) — two-step rollout

```ts
export interface ResolvedApiKey { id: string; tenantId: string; keyMode: ApiKeyMode; grantGroupId: string | null }
```

- **Step A (PC-04, additive):** `SELECT id, tenant_id, key_mode FROM api_keys WHERE hash=$1 AND status='ACTIVE'`; return `keyMode` and (single query, LEFT JOIN) the ACTIVE grant's `group_id`. Additive for all current callers (they destructure `id, tenantId`).
- **Step B (fail-closed):** unknown/`NULL` mode ⇒ `401 UNAUTHENTICATED` with a fixed message ("api key has no declared authority mode") + one structured log line (`warn`, key id, no hash) so operators can find the row. No 403, no mode echo in the body.

Step B is the fixture-breaking change: **≈21 real `INSERT INTO api_keys` fixtures in ≥15 test files** (grep: 20 files / 41 occurrences, mixed with fake-DB SQL assertions) omit `key_mode`, e.g. `tests/helpers/runtime-harness.ts:270`, `tests/runtime.test.ts:672,978,1575`, `tests/operation-tenant-fence.test.ts:120`. Those tests would start returning 401 for every request. This is the D-1 dependency (test lease).

**Alignment with PC-05.** `prep-pc05-admission-spec.md` already (a) keeps `resolveApiKey` as the public auth gate (`api-key-auth.ts:16`, its G1), (b) pre-reads the key row **including `key_mode`** in its own resolution step (line 164) and locks the row `FOR SHARE` while re-reading it (line 167), and (c) requires "a NULL mode must deny, never fall back" (line 393, G2 gates at lines 139-140). So Step A/B is additive to PC-05, not a duplicate authority decision: PC-04 denies at the auth boundary, PC-05 re-reads the same column under its own locks for the authority branch. Constraint this imposes on PC-04: **never rewrite `key_mode`** except when rotation inherits it and when PC-03 promotes a converted key to `GROUP_MANAGED`; a "repair" that flips modes at request time would defeat PC-05's re-read.

### 5.10 BFF and reads

- `bff/key-minting.ts`: no functional change required. Optional hardening: `withMintedRawKey` may also stamp `keyMode: 'LEGACY_STANDALONE'` so the intent is explicit on the wire, but the dispatcher must default anyway (defense in depth). Do **not** mint inside the dispatcher — the BFF owns the copy-once UX.
- `bff/identity.ts`: no change (users/assignments only).
- Reads (D-8): optional `keyMode` on `ApiKeyLifecycleRow` + the admin list SELECT. Not required for Workbench (the v2 group DTO already exposes `apiKeyGrants[]`), and it is a contract change PC-01 has frozen — treat as a separate UI-driven packet.

### 5.11 Transaction/audit shape (both surfaces)

| Mutation | Locks (order) | Rows written | Audit |
| :--- | :--- | :--- | :--- |
| issue | tenant advisory (parity only) → key INSERT | `api_keys` (+`profile_api_keys` only for standalone ids) | `admin_api_key.issue` / `apikey.create` |
| rotate | selectors → key row → group root (group mode) | `api_keys` ×2 (insert + revoke), memberships or grant, `admin_local_user_api_key_grants` | `admin_api_key.rotate` / `apikey.rotate` |
| global revoke | **group roots → key row** → grants → memberships/users | `api_keys`, `profile_group_api_keys`, `profile_groups.access_version`, `profile_api_keys`, `admin_local_user_api_key_grants` | `admin_api_key.revoke` / `apikey.revoke` + revoked group ids |
| attach | selectors → key row → profile ownership | `profile_api_keys` | `apikey.attach` |

Every audit row keeps the actor triple already in use (`actor`, `actorIssuer`, `actorSub`, `actorRole`, `correlationId`; `api-keys.ts:214-215`, `dispatcher.ts:974-982`).

---

## 6. Test plan

### 6.1 Offline / fake-DB (deterministic, no DB)

| ID | Case | Assertion |
| :--- | :--- | :--- |
| T1 | `apikey.issue` INSERT carries the mode | SQL includes `key_mode`; param list contains `'LEGACY_STANDALONE'`; no `null` for that column |
| T2 | `apikey.issue` rejects caller mode | `params.keyMode:'GROUP_MANAGED'` ⇒ 409 `PROFILE_GROUP_V2_REQUIRED`, zero writes/audit |
| T3 | parity issue INSERT carries the mode | same as T1 for `api-keys.ts` |
| T4 | dev fallback seed carries `UNMANAGED_LEGACY` | boot SQL assertion (or explicit documented exception) |
| T5 | `apikey.issue` first response has `rawKey`, marker has none | marker INSERT params `not.toContain(rawKey)`; `secretAvailable:false` in marker body |
| T6 | replay of T5 returns metadata only | replayed body has no `rawKey`, `secretAvailable:false`; audit still one row |
| T7 | `apikey.rotate` marker redacted | same as T5/T6 |
| T8 | rotate inherits `GROUP_MANAGED` | new key row mode `GROUP_MANAGED`; `profile_group_api_keys` insert for new key + revoke for old; `access_version` incremented; **no** `profile_api_keys` insert |
| T9 | rotate inherits `LEGACY_STANDALONE` | memberships + local-user grants copied; no grant insert |
| T10 | rotate `UNMANAGED_LEGACY` | succeeds with zero inherits; mode preserved |
| T11 | rotate NULL mode | 409 `STATE_CONFLICT`, zero writes |
| T12 | global revoke revokes grants + bumps access version | grant rows ⇒ `REVOKED`, `access_version+1` per group, key `REVOKED`, `version+1`, memberships revoked, user grants deleted, one audit row |
| T13 | global revoke with no grants | succeeds; no group UPDATE issued |
| T14 | revoke lock order | first `FOR UPDATE` on `profile_groups` precedes `api_keys` (query order assertion) |
| T15 | attach on group child | 409 `PROFILE_GROUP_V2_REQUIRED` at **both** fences, `addMembership` not called |
| T16 | attach `GROUP_MANAGED` key to standalone profile | 409 `PROFILE_GROUP_V2_REQUIRED`, no membership |
| T17 | attach NULL-mode key | 409 `STATE_CONFLICT` |
| T18 | parity issue with grouped child `profileIds` | 409 `PROFILE_GROUP_V2_REQUIRED`, zero writes |
| T19 | `resolveApiKey` returns mode + grant group | SELECT includes `key_mode`; `NULL` mode ⇒ 401 |
| T20 | BFF `apikey.issue` passthrough still mints once | unchanged (`tests/aweb05-bff-reads.test.ts` baseline) |

### 6.2 Live DB / HTTP (needs the PG window)

| ID | Case | Assertion |
| :--- | :--- | :--- |
| L1 | Concurrent grant vs global revoke | one direction wins; after commit either grant ACTIVE-and-key-ACTIVE or grant REVOKED-and-key-REVOKED — never grant ACTIVE with key REVOKED |
| L2 | Concurrent rotate ×2 | exactly one new ACTIVE key; old key REVOKED once; membership/grant set copied once |
| L3 | Rotate then use old key | 401 immediately (status filter) |
| L4 | Revoke group A only, key shared? | impossible by PK (one group per key) — assert 23505/refusal on regrant to another group |
| L5 | Revoked key's operation reads | original owner loses public auth (401); another key on the same group cannot read the old operation (PC-05 boundary) |
| L6 | `access_version` monotonicity | config publish/rollback leave it untouched; grant/revoke increment it; rotate increments it at least once (once per helper call, §5.4) |
| L7 | Post-0070 NULL remediation | a key seeded after 0070 (NULL) is classified by the remediation query (§7) and then authenticates |
| L8 | Idempotent issue replay across a lost response | first 201 lost ⇒ replay returns no raw key; the key row exists exactly once |

### 6.3 Existing tests that this change will break (must be updated in the same commit)

| Test | Line | Why |
| :--- | :--- | :--- |
| `tests/admin-api-keys.test.ts` | `:308`, `:318` | asserts the exact column list `INSERT INTO api_keys (tenant_id, hash, prefix, name)` — `key_mode` changes it |
| `tests/woc-profile-groups-backend.test.ts` | `:1276-1285` | expects `409 STATE_CONFLICT` for attach on a child — becomes `PROFILE_GROUP_V2_REQUIRED` |
| `tests/api-keys-parity.test.ts` | `:43-53` | replay/secret expectations still hold, but INSERT param assertions need the mode |
| fixtures in ≥15 files | see §5.9 | NULL mode + fail-closed resolver ⇒ 401 everywhere |

**These files are outside the PC-04 lease.** See D-1.

---

## 7. Rollout, remediation and sequencing

1. **Now (before PC-04 code):** classify any post-0070 `NULL` key. Owner: PC-02 lane (new additive migration, next free prefix), because PC-04 has no migration lease. Query shape:
   ```sql
   UPDATE api_keys k SET key_mode = CASE
     WHEN EXISTS (SELECT 1 FROM profile_group_api_keys g WHERE g.api_key_id = k.id) THEN 'GROUP_MANAGED'
     WHEN EXISTS (SELECT 1 FROM profile_api_keys m WHERE m.api_key_id = k.id)
       OR EXISTS (SELECT 1 FROM profile_bindings b WHERE b.api_key_id = k.id)
       OR EXISTS (SELECT 1 FROM profile_names n WHERE n.api_key_id = k.id)
       OR EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id) THEN 'LEGACY_STANDALONE'
     ELSE 'UNMANAGED_LEGACY' END
   WHERE k.key_mode IS NULL;
   ```
   Same deterministic rule as `0070:48-57`; no `GROUP_MANAGED` unless a grant exists.
2. **PC-04 wave A (no new dependencies):** M1-M5 writer modes (§5.2), attach fences (§5.6), parity issue child rejection (§5.7), idempotency redaction (§5.8), `revokeApiKeyGlobally` + both revoke surfaces (§5.3), rotation mode/inheritance for the standalone modes.
3. **PC-04 wave B (needs D-2):** group-grant revoke on global revoke + `GROUP_MANAGED` rotation via the PC-03 helpers.
4. **PC-04 wave C (needs D-1):** `resolveApiKey` returns `keyMode` (step A, additive) and then fails closed (step B) with the fixture sweep in the same commit.
5. **PC-05** can then branch on mode; until wave C lands it must not assume `keyMode` exists.
6. **PC-08** can add the Workbench key picker against the v2 group DTO's `apiKeyGrants[]` without any api-keys list change (D-8).

---

## 8. Decisions required from the coordinator

| # | Question | Recommendation | Impact if deferred |
| :--- | :--- | :--- | :--- |
| **D-1** | Test files are outside the PC-04 lease, but ~21 fixtures and 3 assertion sites must change in the same commit (or the suite goes red) | **Extend PC-04's lease to `services/orchestrator/tests/**` for `key_mode` fixtures/assertions only**, or approve a paired PC-04T packet that lands simultaneously | PC-04 cannot land the fail-closed resolver; if it lands writers only, PC-05 stays blocked |
| **D-2** | PC-03's seam exists on paper (`revokeGroupGrant`, `revokeAllGroupGrantsForApiKey` — `prep-pc03-service-spec.md` §4.2/§4.8) but has **3 gaps**: no re-grant-on-rotation helper, a call-order comment that contradicts the plan ("after api_keys.status flips"), and a mandatory `expectedAccessVersion` on the internal grant revoke | **PC-03 closes the 3 gaps in §5.4** (`grantExistingGroupKey`; correct the call-order comment to roots→key→grants or helper-first; allow `'ANY'` for internal callers). PC-04 codes only against the seam and never writes grant SQL | `GROUP_MANAGED` rotation unimplementable inside the lease; a key→group lock order (deadlock) or a lost grant revoke |
| **D-3** | Attach on a `CHILD_PROJECTION` group child: block (dispatch "hoàn toàn") or allow (plan: "pre-cutover projection writes remain available")? | **Block all group children** with `PROFILE_GROUP_V2_REQUIRED` — attach would break the v1 read's single-key intersection (`profile-groups.ts` read path) | Wrong wire contract; silent 409s in the legacy read |
| **D-4** | Does the fail-closed mode check land in PC-04 or PC-05? | **PC-04 wave C**, per `0070:12-13` ("the PC-04 resolver fails closed on NULL/unknown") — PC-05 only branches | PC-05 would add a second key query or default (forbidden) |
| **D-5** | Where does `KeyMode` live? | **`@du/contracts`** (PC-01 addendum) — one enum, four consumers | Three independent string sets; typos become 500s |
| **D-6** | Keep the "nothing to inherit ⇒ 409" rotation guard? | **Drop it for known modes** (plan item 5 requires `UNMANAGED_LEGACY` and tombstone-only rotation to work); keep only the selector-snapshot mismatch 409 | `GROUP_MANAGED`/`UNMANAGED_LEGACY` keys remain unrotatable |
| **D-7** | Error code for "key mode not declared" on an admin mutation | **`409 STATE_CONFLICT`** (`conflict('STATE_CONFLICT', …)`) with a fixed message; reuse `PROFILE_GROUP_V2_REQUIRED` for group-attach/group-managed refusals | Invents a wire code outside the frozen contract |
| **D-8** | Expose `keyMode` on `ApiKeyLifecycleRow` / the admin list? | **Not now** — Workbench reads `apiKeyGrants[]` from the v2 group DTO; treat a list change as a separate UI packet | Contract churn in a frozen package |
| **D-9** | Post-0070 NULL remediation owner | **PC-02 lane** (additive migration) before PC-04 wave C | Wave C denies every key minted after 0070 |
| **D-10** | Constrain the caller-supplied raw value on `apikey.issue` (F12)? | **Leave for now**; platform-admin-only, BFF mints when absent. If hardened later, require `^du_[A-Za-z0-9_-]{43}$` | Low: only a platform admin can plant a weak secret |
| **D-11** | Fix `bff/profiles.ts` sending `profileId` to a global rotate (F13)? | **Yes, follow-up** (out of lease): either drop the field or make the UI copy explicit that rotation is global | UI/API semantic mismatch, no security impact |

---

## 9. Acceptance checklist for the PC-04 execution packet

- [ ] `grep -c key_mode services/orchestrator/src` > 0 and every `INSERT INTO api_keys` in `src/` names the column.
- [ ] No code path can insert `NULL` mode (assertion test T1/T3/T4).
- [ ] Global revoke (both surfaces) revokes grants, bumps `access_version`, bumps key `version`, cleans memberships/user grants, audits; lock order groups → key (T12/T14/L1).
- [ ] Rotation honours the mode matrix (T8-T11), including `GROUP_MANAGED` grant copy and local-user grant copy on both surfaces.
- [ ] `apikey.attach` returns `PROFILE_GROUP_V2_REQUIRED` for group children and group-managed keys (T15/T16).
- [ ] Parity issue rejects grouped child `profileIds` (T18).
- [ ] No raw key in `admin_idempotency`; replay returns metadata only (T5-T7/L8).
- [ ] `resolveApiKey` returns `keyMode` and denies NULL/unknown (T19) — after the fixture sweep (D-1).
- [ ] Full `services/orchestrator` suite green on the same commit; baseline delta recorded (suites/tests + exit codes).
- [ ] No claim about deployed behavior: source + test evidence only; image/container evidence remains a PC-09/deploy task.

---

## 10. Known limitations of this packet

1. Source-only: no DB was touched, so the actual distribution of `NULL` modes in any live database (including the PC-02 live-tested environment) is **unknown**; the remediation query is a proposal, not a measurement.
2. The audit reflects a tree that already contains uncommitted PC-01 and in-flight PC-03 changes; line numbers can shift when PC-03 lands the grant helpers.
3. `apps/admin-web/` (React) was only grepped, not audited: PC-08 owns the UI. The two call sites named in §3.3 are inside the orchestrator's admin shell package, not `apps/admin-web`.
4. No performance or concurrency runtime measurement; the lock-order argument is analytic (plan item 7), not empirically proven here.
