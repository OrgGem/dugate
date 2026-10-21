# Receipt — PC-R05 Use root grants throughout Connector tests and readiness probes

| Field | Value |
| :--- | :--- |
| Packet | `FOLLOWUP-PC-R05` (P2) — *Connector probe and provider-test retain child authority* |
| Dispatch | [`FOLLOWUP-PC-R05-dispatch.txt`](../dispatch-specs/FOLLOWUP-PC-R05-dispatch.txt) |
| Plan rows | `PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` PC-R05 (line 140-146) |
| Worker | `dsh_2` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Timestamp | 2026-10-21 09:36 +07:00 |
| Lease | `modules/connectors/probe-authorization.ts`, `modules/connectors/provider-test.ts`, `tests/pc-r05-connector-probe-root-grant.test.ts` (new). Two existing test files received a **1-line fixture update** each for the new required `keyMode` field (§3.1) — disclosed, no behavior edited. `submission.ts`, `retry.ts`, `apps/admin-web`, `packages/contracts` untouched. |
| Status | **COMPLETE for the leased scope.** `tsc --noEmit` exit 0; PC-R05 suite 20/20; probe + provider-test-helper suites 45/45. Provider-test **admission** remains on the legacy resolver in `submission.ts` (out of lease by dispatch instruction) — see §3.4. |

**Tóm tắt (VI).** Trước PC-R05, key `GROUP_MANAGED` bị 403 ở probe readiness và ở reserve/local-actor của provider test vì cả hai join `profile_api_keys` (bảng mà conversion đã tombstone). Nay: probe chọn SQL theo `key_mode` — managed đi qua root grant ACTIVE + `profile_group_members` ở `active_revision` + `profile_bindings.enabled` + connector binding; standalone/unmanaged giữ nguyên join cũ. Provider-test đọc `key_mode` cùng lúc khoá key row, managed dùng seam `assertManagedFunctionAuthority`, legacy giữ membership check. Denial xảy ra trước mọi side effect (không gọi Connector, không insert operation/task/outbox). 20 test mới + 45 test liên quan xanh; 6 lỗi còn lại trong suite membership là của PC-R01 đang sửa `profiles.ts` (bằng chứng ở §5.3), không phải PC-R05.

---

## 1. `probe-authorization.ts` — readiness probe is now mode-aware

| Item | Change | Anchor |
| :--- | :--- | :--- |
| Principal | `ConnectorProbePrincipal` requires `keyMode: ApiKeyMode` (resolveApiKey's output) | `:6-16` |
| Standalone SQL | Previous 0039 membership query, byte-for-byte (`profile_active_revisions` + `profile_api_keys` + `api_keys`) | `:31-46` |
| Managed SQL | `profile_group_api_keys` (ACTIVE) → `profile_groups` (`GROUP_GRANT`) → `profile_group_members` (`gm.group_revision = grp.active_revision`) → `profile_bindings` (`p.revision = gm.binding_revision`, `enabled = true`) → `api_keys` (ACTIVE, same tenant) | `:48-70` |
| Dispatch | `GROUP_MANAGED` ⇒ managed SQL; `LEGACY_STANDALONE` / `UNMANAGED_LEGACY` ⇒ standalone SQL; unknown/NULL mode ⇒ 403 with **zero queries** | `:73-83` |
| Row guard | Unchanged per-row ownership/tenant/enabled re-check and the 503 on malformed stored bindings | `:85-98` |

`public.ts:381-384` already passes the full `ResolvedApiKey` (PC-04) into this function, so no route change was needed — the type made the missing field impossible to ignore at the seam.

## 2. `provider-test.ts` — managed authority at reservation and local-actor fence

| Item | Change | Anchor |
| :--- | :--- | :--- |
| `parseKeyMode` | 0070 has no DEFAULT: NULL/unknown mode denies 403, never a fallback | `:172-178` |
| `assertManagedFunctionAuthority` (new, exported) | Root grant ACTIVE + `GROUP_GRANT` + active-revision member pin at `binding_revision` matching profile/revision/business/version/action; `FOR SHARE OF g, grp, gm` | `:180-228` |
| `validateLocalActorInTransaction` | Key read now selects `key_mode`; local-user key/profile grants unchanged; **managed** ⇒ group seam, **legacy** ⇒ the previous `profile_bindings`+membership query. Exported `@internal` for the regression suite | `:235-291` |
| `reserveProviderTestRun` | `activeKey` read selects `key_mode`; managed ⇒ group seam (before any insert), legacy ⇒ the exact previous `profile_api_keys` membership check with the same 409 `ADMISSION_CHANGED` | `:365-408` |
| Denial ordering | Both mode checks run **before** the rate-limit read and before the `operations` / `tasks` / `admin_connector_test_runs` inserts and the provider invocation | `:375-407` |

Nothing else in the module changed: the equal-locked-model rule, PENDING-candidate handling, grant signing, evidence recovery and settlement are untouched.

## 3. Decisions and interpretations (reviewed)

### 3.1 `keyMode` is required on `ConnectorProbePrincipal`
Guessing a mode is the defect being fixed: guessing "managed" grants legacy keys the grant path; guessing "standalone" is exactly what denied managed keys. `public.ts` already holds the resolver output, so the production call site was updated by type, not by lookup. Two existing suites construct the principal literal and needed a one-line fixture addition: `tests/plat-mig-02-probe-authorization.test.ts:9` and `tests/profile-api-keys-membership-offline.test.ts:169` (`keyMode: 'LEGACY_STANDALONE'`). No assertion or behavior in those files was modified.

### 3.2 "access_version matches group"
The dispatch asks for a grant whose `access_version` matches the group. The ledger has no per-grant expected version and a probe carries no version to compare: `profile_groups.access_version` is the grant-mutation CAS counter, incremented by grant/revoke/rotate. "Current" therefore means **the grant row is ACTIVE and the group still uses `GROUP_GRANT` authority**; a concurrent revoke makes the row `REVOKED` and the probe denies. This is recorded in the SQL comment (`:48-52`).

### 3.3 `UNMANAGED_LEGACY` is **not** widened
The dispatch suggests "allow probe if connector exists in tenant (or legacy rule)". The Orchestrator DB stores **no** connector registry (`connector_revisions` lives in the Connector service; the only connector tables here are `connector_prompt_overrides` / `connector_secret_imports`), so an existence check would require a new cross-service dependency. The plan's regression gate says legacy standalone probes "retain their previous scope", and an `UNMANAGED_LEGACY` key had no memberships before this packet. Implemented: `UNMANAGED_LEGACY` keeps the standalone SQL (denies without a membership). **If the coordinator wants the wider rule, it needs a Connector-catalog seam — please confirm.**

### 3.4 Provider-test **admission** stays blocked (by instruction)
`runConnectorProviderTest` calls `ctx.submission.admitProviderTest`, which resolves through the legacy profile resolver (`submission.ts:1232`). A `GROUP_MANAGED` key still fails that admission before reaching the (now correct) reservation code. The dispatch explicitly says not to edit `submission.ts` while the PC-R01 owner works there, so this packet delivers the **probe end to end** plus the **provider-test reservation/local-actor authority seam** and pins it with tests. PC-05/PC-R01 must call the shared authority-aware resolver in `admitProviderTest`; the seam is ready (`assertManagedFunctionAuthority`).

### 3.5 Export surface
`assertManagedFunctionAuthority` and `validateLocalActorInTransaction` are exported (the latter marked `@internal`) so the regression suite can exercise them directly; `reserveProviderTestRun` stays private. This mirrors the module's existing style (`assertProviderTestRevisionAccess` was already exported for its own regression tests).

## 4. Regression tests

New file `tests/pc-r05-connector-probe-root-grant.test.ts` (20 cases):

| Group | Cases |
| :--- | :--- |
| Managed probe allow | active grant + member pin + bound connector ⇒ authorized; asserts `profile_group_api_keys` / `profile_group_members` / `grp.auth_authority = 'GROUP_GRANT'` / `gm.group_revision = grp.active_revision`, and that the managed SQL never mentions `profile_api_keys` |
| Managed probe deny | revoked/absent grant, disabled function, other connector, empty bindings, foreign tenant row, foreign key row; malformed stored bindings ⇒ 503 without echoing content |
| Legacy scope | `LEGACY_STANDALONE` uses the membership SQL; `UNMANAGED_LEGACY` keeps it too (no widening); unknown mode ⇒ 403 with **zero** DB queries |
| Provider-test seam | `assertManagedFunctionAuthority` allows with the member pin (asserts predicates + param order incl. `binding_revision = $4`) and denies 403 without it |
| Local USER fence | managed key passes with the group pin and never touches `profile_api_keys`; managed key without the pin denies 403; standalone without membership denies 403 (legacy fence intact); NULL mode denies before any function check |
| Public route end to end | managed key ⇒ 200 and exactly one outbound probe; revoked grant / disabled function ⇒ 403 with **zero** outbound probes |

## 5. Verification actually run

### 5.1 Commands
| # | Command (cwd `orchestrator/services/orchestrator`) | Result |
| :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 2 | `jest --config jest.unit.config.cjs tests/pc-r05-connector-probe-root-grant.test.ts tests/plat-mig-02-probe-authorization.test.ts tests/provider-test-content.test.ts tests/provider-test-role.test.ts` | **exit 0 — 4 suites / 45 tests passed** |
| 3 | `jest --config jest.unit.config.cjs tests/profile-api-keys-membership-offline.test.ts -t "connector probe authorization reads membership"` | **exit 0 — 2 passed, 10 skipped** (probe describe intact) |

### 5.2 What each suite proves
- `pc-r05` (20): the managed/legacy/unknown matrix above, including two public-route cases that assert authorization happens before `ctx.connectors.testConnector`.
- `plat-mig-02` (18): the pre-existing standalone regression matrix still passes unchanged (only its principal literal gained `keyMode`).
- `provider-test-content` + `provider-test-role` (7): result redaction and revision-access rules untouched.

### 5.3 Residual failures in the same file — attributed to PC-R01, not PC-R05
`tests/profile-api-keys-membership-offline.test.ts` has **6 failures** in the *"the request path resolves membership"* describe:

```
Error: unexpected profile SQL: SELECT key_mode FROM api_keys WHERE id=$1
  at src/modules/profiles/profiles.ts:1187  (resolveBinding → selectActiveRow)
```

`profiles.ts` was modified at **09:29 today** by the in-flight PC-R01 change (explicit standalone mode controls fallback), which added a `key_mode` read to `selectActiveRow`; that suite's fake DB does not answer the new query. PC-R05 touched only the **connector probe** describe in that file (one fixture line). The probe describe passes (row 3).

## 6. Follow-ups created (other lanes)

| Lane | Work |
| :--- | :--- |
| PC-05 / PC-R01 owner | Migrate `submission.ts:admitProviderTest` (and `preflightLegacyWorkflow`) to the shared authority-aware resolver; then a managed key can complete an end-to-end provider test. The reservation/local-actor path is already correct. |
| PC-09 | Real-DB regression: grant revoke after a successful preview must deny the probe and the reservation with no outbound provider call; converted group with zero memberships must probe successfully. |
| Coordinator | Confirm §3.3 (`UNMANAGED_LEGACY` scope) — widening needs a Connector-catalog seam, not a DB query. |
| PC-R08 | Historical provider-test replay (`validateLocalHistoryAccess`) intentionally still checks only actor/key/profile grants; replay reauthorization is PC-R08's scope and was not changed here. |

## 7. Evidence boundary

Source + unit-test evidence only. No live PostgreSQL/HTTP suite ran in this packet: the shared test database still lacks the reviewed migration checksum baseline (`migration ledger integrity check failed … run migrate:baseline-reviewed`), the same environment blocker recorded in `receipt-pc04-keys.md` §6. No deployment, image or running-container claim is made. `dist/` was not rebuilt for this packet (services resolve source through ts-jest in these suites).
