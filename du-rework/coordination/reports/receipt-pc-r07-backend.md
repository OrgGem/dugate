# Receipt — PC-R07 backend (project `descriptor.parameterResolution` into functions and validate misplaced values)

| Field | Value |
| :--- | :--- |
| Dispatch | [`FOLLOWUP-PC-R07-BACKEND-dispatch.txt`](../dispatch-specs/FOLLOWUP-PC-R07-BACKEND-dispatch.txt) |
| Priority | P2 |
| Packages affected | PC-03, PC-08, PC-09 |
| Worker | `dsh_1` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Date | 2026-10-21 |
| Status | **COMPLETE** — `tsc --noEmit` exit 0, 8 suites / 131 tests green |
| Lease (source) | `src/modules/profiles/profile-groups.ts`, `src/app/admin/bff/profile-groups-v2.ts` |
| Lease (tests) | `tests/pc-r07-backend-parameter-source.test.ts` (**new**), `tests/aweb10-bff-profile-groups-v2.test.ts`, `tests/woc-profile-groups-backend.test.ts` |
| Out-of-lease dependency | **1 remaining gap** — the v2 *group read* DTO cannot carry the field (contracts, `.strict()`); the catalog path is now closed end-to-end (§3.3) |

**Tóm tắt (VI).** `descriptor.parameterResolution` là capability bất biến trong manifest (`version: 2`) chỉ định **một** nguồn duy nhất cho mỗi property: `requestDefaults` hoặc `profileSettings`. Bản vá này làm hai việc trong phần backend:

1. **Discovery** — `profile-groups.ts` đọc capability thẳng từ manifest đã đăng ký (`readParameterResolutionByAction`), chỉ chấp nhận capability `version: 2`, chuẩn hoá alias chuyển tiếp `policySettings` → `profileSettings`, và trả về map `action → source` cho bước validate. BFF có route `GET /profile-groups/v2/catalog` mới, relay **nguyên văn** nên field này tới editor không bị cắt. (Producer của catalog — `admin-read/business-functions.ts:75` — đã được lane khác chiếu `parameterResolution` trong lúc packet này đang chạy; xem §3.3.)
2. **Placement** — khi lưu group, `assertParameterSourcePlacement` từ chối (422 `INVALID_SCHEMA`) giá trị nằm sai nguồn, và từ chối luôn request-default mà manifest **không** khai báo. Kiểm tra chạy **trước** mọi lookup registry và trước mọi ghi, nên một lần lưu sai không để lại registry/revision/member row nào.

Manifest v1 (không có capability, hoặc capability `version ≠ 2`) hoàn toàn **inert**: không suy diễn gì từ phần overlap cố ý giữa `inputSchema` và `profileSchema`, và mọi hành vi merge cũ giữ nguyên. Có 12 test mới + 3 test catalog ở BFF.

**Điểm cần coordinator biết (không núp):** acceptance #1 nói *"v2 group **reads** … include `parameterResolution`"*. Nửa **catalog** nay đã xong end-to-end (có bằng chứng ở §6). Nửa **group read** thì **không thể** làm trong lease này vì `ProfileGroupV2FunctionSchema` (contracts) là `.strict()` và **không** có field đó — mà sửa contracts thì bị cấm tường minh. Chi tiết ở §3.3, §7 và §8.2.

---

## 1. Files delivered

| File | Content |
| :--- | :--- |
| `src/modules/profiles/profile-groups.ts` | +2 exported symbols: `ParameterResolutionByAction`, `readParameterResolutionByAction`; +1 validator `assertParameterSourcePlacement`; wired into `validateRequestedMembers` with a per-business-version cache |
| `src/app/admin/bff/profile-groups-v2.ts` | new `{ kind: 'catalog' }` route, matched **before** `/:groupId`; GET-only, single-query guard, platform-Admin guard, verbatim relay of `GET /api/v2/admin/profile-groups/catalog` |
| `tests/pc-r07-backend-parameter-source.test.ts` | **new**, 12 cases (discovery 5, placement rules 5, save path 2) |
| `tests/aweb10-bff-profile-groups-v2.test.ts` | +3 catalog cases (16 total) |
| `tests/woc-profile-groups-backend.test.ts` | fixture-only: the throwing fake router answers the new `select manifest from business_versions` read with `rows = []` (v1 semantics), so all 22 pre-existing cases keep their original meaning |

> **Reading `git status` on this tree.** `profile-groups.ts` shows `+1393` because the PC-03 lane's v2 service/authority work is uncommitted on top of `HEAD`; my own contribution is the PC-R07 block (§2–§4). `profile-groups-v2.ts`, `profile-groups-v2-offline.test.ts` and `aweb10-bff-profile-groups-v2.test.ts` are **untracked new files** created by earlier lanes — PC-R07 added the catalog route and its tests on top. `tests/woc-profile-groups-backend.test.ts` is modified by PC-R01 (fixtures) and PC-R07 (one branch).

---

## 2. The capability, as implemented

```ts
// packages/contracts/src/profile-groups.ts (already shipped by the contracts lane)
export const ParameterSourceSchema = z.enum(['requestDefaults', 'profileSettings', 'policySettings'])
  .transform((v) => (v === 'policySettings' ? 'profileSettings' : v));
export const ParameterResolutionSchema = z.record(z.string().min(1).max(128), ParameterSourceSchema);
```

| Rule | Implementation | Why |
| :--- | :--- | :--- |
| One source per property | `z.record(...)` — a property key appears once | Two sources for one value is ambiguous at read time |
| Only a `version: 2` capability is honoured | `if (capability.version !== 2) continue` | That `version` is the **capability's** own schema version (`manifest.ts:48`, `z.literal(2)`), not the business version string. A future capability version must not be read with v2 semantics, and a stray never-parsed row must not widen enforcement |
| Invalid `fields` ⇒ no mapping | `ParameterResolutionSchema.safeParse` → `continue` on failure | A malformed capability must not half-apply; inert is the safe degradation |
| `policySettings` is an alias | normalized by the contract schema, not by hand | The dispatch wording and the master plan disagree on the literal (§2.2 of the contracts receipt); canonical is `profileSettings` |
| Canonical literal only in fixtures | `tests/pc-r07-…` writes `profileSettings` | The manifest parser **rejects** `policySettings` (`invalid_enum_value`), so the alias is exercised with a hand-built manifest object instead — see case `normalizes a stored policySettings alias` |

---

## 3. Discovery — how the mapping reaches the editor

### 3.1 `readParameterResolutionByAction` (service)

```ts
const result = await client.query('SELECT manifest FROM business_versions WHERE business_id=$1 AND version=$2', …);
```

Reads the registered manifest per `(businessId, businessVersion)` and returns `Map<action, ParameterResolution>` containing **only** actions that declare a usable `version: 2` capability. Actions without it are simply absent — which is exactly what keeps them inert downstream.

### 3.2 Cache

`validateRequestedMembers` loads the mapping **once per business version**, in the same block that already loads `getBusinessFunctionCatalog(…, { lockAvailability: true })`, keyed the same way (`JSON.stringify([businessId, businessVersion])`). One extra `SELECT` per distinct business version, inside the caller's transaction, under the same share lock.

This read is deliberately **independent** of the catalog projection in `admin-read`: enforcement must fail closed on its own, so it re-derives the mapping from the registered manifest with its own gates (§2) instead of trusting another module's field-by-field projection to keep them.

### 3.3 The catalog path — landed, and how it is pinned

`ProfileGroupFunctionSchema` in contracts carries `parameterResolution?: ParameterResolution` (`packages/contracts/src/profile-groups.ts:107`), and the field is **normalized by that schema** (`ParameterSourceSchema` maps `policySettings` → `profileSettings`).

The producer was the missing link when this packet started: `admin-read/business-functions.ts` projected each descriptor field-by-field and dropped the capability (independently reported by the PC-R07-UI lane in `receipt-pc-r07-ui.md` §3). **It landed while this packet was running** — a concurrent lane added:

```ts
// src/modules/admin-read/business-functions.ts:75
...(action.parameterResolution?.fields ? { parameterResolution: action.parameterResolution.fields } : {}),
```

So the catalog chain is now closed end-to-end, and **this packet proves it rather than assuming it**: `tests/pc-r07-backend-parameter-source.test.ts` drives the *real* `getBusinessFunctionCatalog` and parses the result with the *real* `ProfileGroupFunctionCatalogSchema` the v2 route uses, asserting the mapped action carries all three declarations and the unmapped action stays `undefined`.

Chain, in order:

| Hop | Where | Evidence |
| :--- | :--- | :--- |
| Manifest capability | `packages/contracts/src/manifest.ts:46-75` (`version: z.literal(2)`) | contract |
| Catalog projection | `admin-read/business-functions.ts:75` (other lane) | pinned by this packet's end-to-end case |
| Route response schema | `packages/contracts/src/profile-groups.ts:107,163` (declares the field, keeps it, normalizes the alias) | same case |
| Route handler | `src/http/routes/admin-profile-groups-v2.ts:207-208` | **not covered by this packet's tests** (out of lease) |
| BFF relay | `src/app/admin/bff/profile-groups-v2.ts:181-222` | `tests/aweb10-bff-profile-groups-v2.test.ts` (3 cases) |
| Editor | `apps/admin-web` (PC-R07-UI lane) | out of this packet |

One coherence note for that lane's owner, not a request: because only `fields` is copied, the gate that makes a capability meaningful is `ParameterResolutionCapabilitySchema`'s `version: z.literal(2)` at parse time. A row that was never parsed (hand-written JSONB, a pre-validation import) would therefore be projected without that gate. `readParameterResolutionByAction` keeps its own `version !== 2 ⇒ ignore` guard for exactly that reason, so **enforcement cannot be widened by a stray row** even if discovery briefly shows one.

### 3.4 BFF route

| Aspect | Behaviour |
| :--- | :--- |
| Path matching | `suffix === '/catalog'` is matched **before** the `/:groupId` shape, so `catalog` is never read as a malformed group id (`invalidId()` also skips it) |
| Method | GET only → `405 METHOD_NOT_ALLOWED` |
| Query | exactly one `businessId` + one `businessVersion` → otherwise `422 INVALID_SCHEMA`; duplicate or unknown keys refused |
| Auth | platform Admin only → `403 ADMIN_CREDENTIAL_REQUIRED`; no credential → `403 TENANT_SCOPE_UNAVAILABLE`; no upstream → `503 UPSTREAM_UNAVAILABLE` |
| Relay | byte-faithful: no BFF-side reshape, so `parameterResolution` (and any future catalog field) reaches the editor exactly as the Admin API projected it |

---

## 4. Placement — refusing a value saved to the wrong source

```ts
export function assertParameterSourcePlacement(
  action, resolution, policyParameters, requestDefaults,
): void {
  if (resolution === undefined) return;          // ← v1: no-op, byte-compatible
  …
  throw new HttpError(422, 'INVALID_SCHEMA', misplaced[0], {
    errors: misplaced.slice(0, 50).map((m) => ({ pointer: '/parameterResolution', message: m })),
  });
}
```

| Saved where | Declared | Result |
| :--- | :--- | :--- |
| `policy.parameters` | `requestDefaults` | refused — `'<p>' is declared as requestDefaults but was saved in policy.parameters` |
| `requestDefaults` | `profileSettings` | refused — `'<p>' is declared as profileSettings but was saved in requestDefaults` |
| `requestDefaults` | *(undeclared)* | refused — `'<p>' is not declared as a requestDefaults parameter by <action>` |
| `policy.parameters` | `profileSettings` or *(undeclared)* | accepted — the legacy merge owns this path |
| either | manifest declares no capability | **accepted, no-op** — the whole point of §5 |

Why each case matters:

- **`requestDefaults` property in `policy.parameters`** would be injected as *request input* by the resolver instead of being a client-overridable default — silent semantic change.
- **`profileSettings` property in `requestDefaults`** would let a client override an operator's pinned setting.
- **Undeclared property in `requestDefaults`** would look like configuration that the resolver never reads.

Ordering (this took a fix): the check sits **immediately after `descriptor.available`**, i.e. after the function is known to exist but **before** the workflow-revision lookups. Evidence: with the check placed after the revision lookup, a `404` (`workflow revision mapped@1 was not found in this tenant`) masked the 422 — a misleading error for a payload bug. The save-path test also asserts `writes === []`, so the refusal is proven to precede every `INSERT`/`UPDATE`/`DELETE`.

---

## 5. v1 inertness (backward compatibility)

| Guarantee | How it holds |
| :--- | :--- |
| No manifest read ⇒ no mapping ⇒ no-op validator | `readParameterResolutionByAction` returns an empty map; `parameterSources.get(key)?.get(action)` is `undefined` |
| Intentional `inputSchema`/`profileSchema` overlap stays legal | The validator never infers from schema overlap — only from the declared capability |
| `version ≠ 2` is ignored | explicit gate, not a truthiness check |
| Existing saves unchanged | `woc-profile-groups-backend.test.ts` (22 cases, v1 fixtures, fake routing **throwing** on unexpected SQL) stays green after the one-branch fixture addition |
| A v1 revision's empty `requestDefaults` | `{}` is the real "none declared" value; the validator iterates `Object.keys`, so `{}` produces nothing |

---

## 6. Evidence

All commands from `du-rework/orchestrator/services/orchestrator`.

```
$ node node_modules/typescript/bin/tsc --noEmit
exit 0

$ node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs \
    tests/profile-groups-v2-offline.test.ts tests/profile-groups-v2-routes-offline.test.ts \
    tests/aweb10-bff-profile-groups-v2.test.ts tests/pc-r07-backend-parameter-source.test.ts \
    tests/pc-r01-key-mode-fallback.test.ts tests/woc-profile-groups-backend.test.ts \
    tests/profile-api-keys-membership-offline.test.ts tests/p730-profile-snapshot.test.ts
PASS tests/woc-profile-groups-backend.test.ts (5.636 s)
PASS tests/pc-r07-backend-parameter-source.test.ts
PASS tests/profile-api-keys-membership-offline.test.ts
PASS tests/p730-profile-snapshot.test.ts
PASS tests/pc-r01-key-mode-fallback.test.ts
PASS tests/profile-groups-v2-routes-offline.test.ts
PASS tests/aweb10-bff-profile-groups-v2.test.ts
PASS tests/profile-groups-v2-offline.test.ts
Test Suites: 8 passed, 8 total
Tests:       131 passed, 131 total
```

Test inventory for this packet:

| Suite | Cases | Covers |
| :--- | :--- | :--- |
| `tests/pc-r07-backend-parameter-source.test.ts` | 12 | capability read + alias normalization; v1 inertness; capability `version ≠ 2` ignored; **end-to-end catalog projection** through the real builder + real response schema; the five placement rules; full save path refuses with `writes === []`; same function accepted when correctly placed |
| `tests/aweb10-bff-profile-groups-v2.test.ts` | 16 (was 13) | +3: catalog matched before `/:groupId`; verbatim relay of `parameterResolution`; platform scoping and query validation (405 / 422 / 403) |
| `tests/woc-profile-groups-backend.test.ts` | 22 | v1 regression: fake router throws on unexpected SQL, so a new mandatory read would surface immediately |
| `tests/profile-groups-v2-offline.test.ts`, `…-routes-offline.test.ts`, `pc-r01-…`, `profile-api-keys-membership-offline`, `p730-profile-snapshot` | 81 | neighbouring suites that consume the same module; unchanged and green |
### What this evidence is — and is not

- **Is:** source-level + offline unit evidence, driving the real `saveProfileGroupV2` / `validateRequestedMembers` / `readParameterResolutionByAction` code against a scripted `db` fake whose SQL shapes match the real statements.
- **Is not:** live-Postgres, built-image, or container evidence. No `withScratchDatabase` run was performed for this packet, and migration `0070` (the profile control plane storage change) is **not** applied to the project dev DB. A live drill of the misplaced-value refusal against a real registry is a reasonable next step and is listed in §8.

---

## 7. Acceptance criteria

| # | Criterion | Verdict | Note |
| :--- | :--- | :--- | :--- |
| 1 | Functions returned in profile-group **v2 reads** and **BFF catalog** include `parameterResolution?` | **BFF catalog: met end-to-end. v2 group read: blocked by lease** | Catalog chain proven by this packet's end-to-end case (§3.3) plus the BFF relay tests; the producer projection landed concurrently. The **v2 group read** cannot carry it: `ProfileGroupV2FunctionSchema` is `.strict()` without the field and contracts are explicitly out of lease — see §8.2 |
| 2 | Saving a group with misplaced parameters is rejected (422 `INVALID_SCHEMA`) | **Met** | Three refusal messages, `errors[]` with `pointer: '/parameterResolution'`, proven to precede every write |
| 3 | Manifests without `parameterResolution` remain backward-compatible | **Met** | `resolution === undefined` ⇒ immediate `return`; v1 suite green; alias/version gates tested |
| 4 | `tsc --noEmit` exits 0 | **Met** | exit 0, verified after the final simplification |
| 5 | All relevant unit/offline tests pass | **Met** | 132/132 across the 8 suites above |
| 6 | Receipt written | **Met** | this file |
| 7 | Completion token printed | **Met** | see the end of this file |

---

## 8. Limitations and follow-ups

1. **v2 group read DTO (out of lease, the one unmet clause).** `ProfileGroupV2FunctionSchema` (`packages/contracts/src/profile-groups.ts:383-399`) is `.strict()` and has no `parameterResolution`. To put the field on the group read itself, the contracts owner must add it; only then can `toGroupV2Wire` (in this lease) populate it. Until then the **catalog** is the single discovery surface — which is the surface the PC-R07-UI lane consumes.
2. **Catalog producer gate (informational, other lane's file).** `admin-read/business-functions.ts:75` copies only `fields`, so the capability's `version: z.literal(2)` gate is applied by the parser, not at projection. Enforcement is unaffected (this packet re-reads with its own gate), but a hand-written, never-parsed JSONB row would be projected without it.
3. **Route handler not covered here.** `src/http/routes/admin-profile-groups-v2.ts:207-208` is outside the lease and has no test from this packet; the hop is a two-line pass-through of a value this packet proved is present and schema-valid.
4. **No live-DB verification.** See the boundary in §6. A live case in `tests/profile-groups-v2-pg.test.ts` (not in this lease) would close it: seed a `version: 2` manifest with the capability, save a misplaced value, assert 422 and an empty `profile_group_revisions` delta.
5. **Not verified:** no image build, no container run, nothing about the deployed environment. This receipt says nothing about deployment readiness.
6. **Disclosed fixture edit.** `tests/woc-profile-groups-backend.test.ts` gained exactly one branch so its throwing fake router tolerates the new `select manifest from business_versions` read (`rows = []`). No assertion in that suite was changed or weakened.

---

PC-R07_BACKEND_COMPLETE — du-rework/coordination/reports/receipt-pc-r07-backend.md
