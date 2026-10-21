# Receipt — PC-04 Execute (key & auth lifecycle, 3 waves)

| Field | Value |
| :--- | :--- |
| Packet | `PC-04-EXECUTE` — *Key and Auth Lifecycle Implementation* |
| Dispatch | [`PC-04-execute-dispatch.txt`](../dispatch-specs/PC-04-execute-dispatch.txt) (all D-1..D-11 approved; test + contracts lease extension granted) |
| Worker | `dsh_2` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Timestamp | 2026-10-21 04:08 +07:00 |
| Status | **COMPLETE for the PC-04 scope.** Source typecheck 0; contracts 36/36 suites; PC-04 offline matrix 25 suites / 483 tests green. Full-suite residual failures are owned by PC-02/PC-03/PC-05 (attribution in §5). Live PG suites **could not start** — shared DB migration-ledger baseline is missing (§6). |

**Tóm tắt (VI).** Đã thực hiện đủ 3 wave: (A) mọi đường mint key ghi `key_mode` tường minh, attach chặn group-child/`GROUP_MANAGED` bằng `409 PROFILE_GROUP_V2_REQUIRED`, parity issue từ chối `profileIds` là group child, idempotency marker không còn lưu raw key; (B) global revoke gọi `revokeAllGroupGrantsForApiKey` (khoá group root trước key row) và rotation `GROUP_MANAGED` dùng seam PC-03 (`issueGroupKey` + `revokeAllGroupGrantsForApiKey`); (C) `resolveApiKey` trả `keyMode` và fail-closed 401 khi mode NULL/unknown, kèm sweep fixture toàn bộ test. Typecheck 0, contracts 622 test xanh, 25 suite offline thuộc PC-04 xanh (483 test). 11 suite còn đỏ thuộc PC-02/03/05 (bảng §5). Live PG bị chặn bởi migration-ledger baseline của DB dùng chung (§6) — không phải lỗi code.

---

## 1. Wave A — writers, attach, parity issue, idempotency, revoke completeness

| Item | Change | Anchor |
| :--- | :--- | :--- |
| M1 `apikey.issue` mode | INSERT now names `key_mode` with the literal `'LEGACY_STANDALONE'`; a caller passing `keyMode` ≠ `LEGACY_STANDALONE` is refused with `409 PROFILE_GROUP_V2_REQUIRED` before any write | `dispatcher.ts:947`, `:969` |
| M2 `apikey.rotate` mode | pre-reads `key_mode` (unlocked), inserts the replacement with `key_mode = mode`; NULL/unknown ⇒ `409 STATE_CONFLICT` | `dispatcher.ts:1288-1289`, `:1384-1390` (insert) |
| M3 parity issue | `INSERT … key_mode … 'LEGACY_STANDALONE'` | `api-keys.ts:237` |
| M4 parity rotate | inherits `key_mode`; `GROUP_MANAGED` branch (Wave B) | `api-keys.ts:305-346` |
| M5 dev seed | **not changed — `create-app.ts` is outside this lease**; one-line follow-up in §8 | — |
| Attach guard | `GROUP_MANAGED` key ⇒ `409 PROFILE_GROUP_V2_REQUIRED`; NULL mode ⇒ `409 STATE_CONFLICT`; both group-child fences now return `PROFILE_GROUP_V2_REQUIRED` (D-3: block every group child) | `dispatcher.ts:1119-1141`, `:1163`, `:1203` |
| Parity issue child profiles | `profilesExistForClient` now selects `group_id` and refuses any grouped child with `409 PROFILE_GROUP_V2_REQUIRED` (existence/foreign check preserved) | `api-keys.ts:110-124` |
| Idempotency redaction | `apikey.issue` / `apikey.rotate` markers store `rawKey: null, secretAvailable: false`; the first 201 still carries the value once. Replay can no longer re-emit or persist the secret | `dispatcher.ts:551-553`, `:993` (issue), `:1434` (rotate marker) |
| Global revoke (parity) | group-grant seam first, then key lock/CAS, memberships, local-user grants, `version=version+1`, audit with group ids | `api-keys.ts:373-408` |
| Global revoke (dispatcher) | same sequence; previously only flipped `status` | `dispatcher.ts:1055-1090` |

## 2. Wave B — PC-03 root-grant seam

| Item | Change |
| :--- | :--- |
| Global revoke → grants | both revoke surfaces call `revokeAllGroupGrantsForApiKey(client, keyId, tenantId, groupActor)` **before** locking the key row, so the seam's sorted group-root lock precedes the key lock (plan item 7). `access_version` is bumped by the seam; the audit resource records `groups:<ids>`. |
| `GROUP_MANAGED` rotation | PC-03 exports no `grantExistingGroupKey`, so rotation composes the two existing seams: `issueGroupKey(..., { mintRawKey: () => rawValue }, grant.groupId, ..., grant.accessVersion)` inserts the new `GROUP_MANAGED` key + grant, then `revokeAllGroupGrantsForApiKey(oldKeyId)` tombstones the old grant, then the old key row is revoked (`version+1`). Local-user grants follow the credential. No child memberships are created (plan item 5). Implemented twice (parity service + dispatcher) with the same order. |
| Standalone rotation | inherits the exact ACTIVE membership set + local-user grants; `UNMANAGED_LEGACY` inherits nothing; the old "nothing to inherit ⇒ 409" guard is **dropped for known modes** (D-6). Selector-locked snapshot mismatch still returns a retryable 409. |

## 3. Wave C — fail-closed resolver + fixtures

```ts
export interface ResolvedApiKey { id: string; tenantId: string; keyMode: ApiKeyMode }
// SELECT id, tenant_id, key_mode FROM api_keys WHERE hash=$1 AND status='ACTIVE'
// NULL/unknown mode → 401 UNAUTHENTICATED 'api key has no declared authority mode'
```

- `api-key-auth.ts:24-44` — additive return type; every existing caller destructures `{id, tenantId}` unchanged; PC-05 branches on `keyMode`.
- Contracts: `API_KEY_MODES`, `ApiKeyModeSchema`, `ApiKeyMode` added to `packages/contracts/src/profile-groups.ts` and the explicit barrel list in `index.ts` (lease extension used).
- Fixture sweep (lease extension): **40 test files + 1 shared helper** now supply `key_mode`:
  - `admin-action-rbac-live`, `admin-audit`, `admin-base-routes`, `artifact-grant-fencing`, `data-02-04-live-s3`, `gate-authenticate-808-pg16`, `operation-tenant-fence`, `orv12-settings`, `profile-control-plane-migration`, `runtime.test`, `runtime-admin-auth`, `tests/helpers/runtime-harness`, `usage-summary`, `woc-independent-profile-pg`, `woc-independent-runtime-pg` (INSERT fixtures);
  - `admin-api-keys`, `api-keys-parity`, `woc-profile-groups-backend`, `rv01-loopback-http-offline`, `multipart-routes-offline`, `public-upload-encryption-gateway`, `usage-drilldown`, `wfa-section8-med2-existence-oracle`, `wfa-api-key-fence`, `request-redaction-http`, `orv15-vfy-public-operation`, `orv11-operations-routes`, `orv11-admin-upload`, `rcr-luna-verification`, `delivery-encryption`, `enc08-wire-enc07`, `artifact-read-download-route`, `crx02-rfx05res-s3-read-guard`, `rcr-luna-http-encryption`, `plat-mig-02-probe-authorization`, `orv14-workbench-owner`, `br12-isolation-offline`, `w1-sub03-sourceurl-extension`, `admin-operations-sql` + `tests/helpers/operations-page-fixture.ts` (fake-DB rows).

## 4. Verification actually run

| # | Command (cwd: `orchestrator/services/orchestrator` unless noted) | Result |
| :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0**, no diagnostics |
| 2 | contracts: `tsc --noEmit`, `tsc -p`, `jest --runInBand` | **exit 0 / 0 / 0** — `36 suites, 622 tests passed` |
| 3 | `jest --config jest.unit.config.cjs --runInBand` on the **27 PC-04-affected suites** | **exit 0** — `25 passed, 2 skipped`, `483 passed, 9 skipped` |
| 4 | full offline suite `jest --config jest.unit.config.cjs --runInBand` | exit 1 — `6098 passed, 86 failed, 203 skipped` (`376/406` suites passed, 11 failed); every residual is attributed in §5 and none is PC-04 code |
| 5 | live: `DU_LIVE_INFRA=1 jest --runInBand tests/admin-action-rbac-live.test.ts` | **blocked before tests** — see §6 |

PC-04 matrix suites in row 3 include: `admin-api-keys`, `api-keys-parity`, `woc-profile-groups-backend`, `rv01-loopback-http-offline`, `multipart-routes-offline`, `public-upload-encryption-gateway`, `usage-drilldown`, `wfa-*`, `request-redaction-http`, `orv15`, `orv11-operations-routes`, `orv11-admin-upload`, `orv14-workbench-owner`, `rcr-luna-verification`, `rcr-luna-http-encryption`, `delivery-encryption`, `enc08-wire-enc07`, `artifact-read-download-route`, `crx02`, `plat-mig-02`, `br12`, `w1-sub03`, `admin-operations-sql`, `runtime-admin-auth`, `orv12-settings`.

## 5. Full-suite residual failures — attribution (none in PC-04 code)

Recorded at 2026-10-21 04:0x. Other lanes were editing `src/` during these runs (PC-03/PC-05 files changed mid-run), so suite counts fluctuate between runs; the list below is from the captured JSON run.

| Owner | Suites (failed tests) | Evidence (deepest src frame / assertion) |
| :--- | :--- | :--- |
| **PC-05** | `submission-metadata-crypto-e2e` (43), `w1-sub02-snapshot-secret` (7), `p730-profile-snapshot` (6), `enc-meta-sentinel-outbox-source-url` (5), `crx01-creatapp-metadata-seam` (3), `url-ingestion-offline.functional` (2), `url-ingestion-backend-failclosed-offline` (2) | `submission.ts:453 resolveGroupAdmission` → their new `readApiKeyAuthorization` (`submission.ts:315-326`, `SELECT id, tenant_id, status, key_mode FROM api_keys WHERE id=$1`) is not answered by those fakes ⇒ 401 before the assertion under test |
| **PC-03** | `p730-admin-mutate-offline` (15), `tapi01-closure-offline` (1) | `profile-actions.ts:138 assertProfileIdentityNotGroupOwned` → `unhandled SQL: SELECT n.group_id, g.auth_authority` (their new query in those fakes) |
| **PC-02** | `profile-control-plane-migration-offline` (1) | expects `max(sequence) = 70`; tree now has `0071_*` (their remediation migration) |
| **Pre-existing (no PC-04 code)** | `rfx10-seed-gate` (1) | `create-app.ts:512` passes `zeroConfigBoot: autoMigrate && NODE_ENV !== 'production'` while the test expects a production `autoMigrate=true` boot to seed; PC-04 does not touch seeding |
| **PC-04** | **none** | — |

The seven PC-05 suites are the same class of fixture gap I fixed for `orv14`/`br12` (a fake DB that does not answer the new key reader); they need PC-05's own fixture sweep, not a source change.

## 6. Live PG suites — blocked (environment, not code)

```
$env:DU_LIVE_INFRA='1'; node node_modules/jest/bin/jest.js --runInBand tests/admin-action-rbac-live.test.ts
→ 12 failed / 12 total, ALL before the first assertion:
  migration ledger integrity check failed: checksum baseline is unknown for
  [0001_platform_v1.sql … 0037_legacy_workflow_schema_catalog.sql];
  review the existing database and run "pnpm run migrate:baseline-reviewed" once
  at src/db/migrations.ts:342 ← create-app.ts:493
```

The shared test database (`postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test`) has no reviewed checksum baseline, so every live suite aborts at boot. Fixing that requires `pnpm run migrate:baseline-reviewed` inside a claimed DB window — a shared-window action that this packet does not hold. No live evidence is claimed; PC-09/testing-lane verification remains outstanding for PC-04.

## 7. Files changed by this packet

Source (lease):
- `src/modules/identity/api-keys.ts` (+~200)
- `src/modules/admin-actions/dispatcher.ts` (+~230 / −100)
- `src/http/routes/api-key-auth.ts` (34 lines)
- `packages/contracts/src/profile-groups.ts` (ApiKeyMode block)
- `packages/contracts/src/index.ts` (export `API_KEY_MODES`, `ApiKeyModeSchema`)

Tests (extended lease): 40 suites + `tests/helpers/operations-page-fixture.ts` as listed in §3. No commit, no stage, no branch operation; other lanes' files were not edited beyond the fixture rows listed.

## 8. Follow-ups / decisions to record

1. **M5 dev seed** (`create-app.ts:519-525`, outside lease): add `key_mode` with `'UNMANAGED_LEGACY'`. The placeholder hash never authenticates, so fail-closed auth is unaffected — it is only the "no NULL after 0070" invariant.
2. **Remediation for post-0070 NULL keys** (D-9) remains a PC-02 additive migration; the classification query is in `prep-pc04-keys-spec.md` §7. Until it runs, any key minted between 0070 and this packet is denied by Wave C (fail-closed by design).
3. **PC-03 seam gap**: no `grantExistingGroupKey`; rotation compensates with `issueGroupKey` (injected minter) + `revokeAllGroupGrantsForApiKey`. If PC-03 later adds an atomic re-grant helper, rotation can collapse to one call; until then the two-call form is normative and already bumps `access_version` twice (monotonic, one commit).
4. **D-6 applied**: the "nothing to inherit" 409 is gone for known modes; `admin-api-keys.test.ts` was rewritten to assert the new contract (a membership-less `LEGACY_STANDALONE` key rotates and inherits nothing).
5. **D-3 applied (strict)**: attach refuses every group child, not only `GROUP_GRANT` ones; rationale in `prep-pc04-keys-spec.md` §5.6 (a second membership would break the v1 read's single-key intersection).
6. **Wave C is deployed-behaviour relevant**: after this lands, any key with NULL/unknown `key_mode` is denied by every public/admin route. Existing rows are covered by 0070's backfill; only post-0070 rows need the remediation migration (item 2).
7. No deployment claim: evidence is source + offline tests only; image/container/live-DB behaviour is a PC-09 task.
