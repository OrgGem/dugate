# Receipt — PC-05 Execute (resolution and v2 admission)

| Field | Value |
|---|---|
| Packet | `PC-05-EXECUTE` — *Resolution and V2 Admission Implementation* |
| Worker | `dsh_3` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** — service tsc 0, contracts 622/622, offline suite 29/29, PG suite 14/14 |
| Design source | [`prep-pc05-admission-spec.md`](prep-pc05-admission-spec.md) §3-§8, all six Qs approved |
| Baseline | PC-01 contracts and PC-02 migrations landed; PC-03/PC-04 landed while this packet ran |
| Lease respected | Only the eight listed files were written |

**Tóm tắt (VI).** Đã triển khai đủ 6 chỉ thị: migration `0071` (Option A — cột `resolution_fingerprint` trên `submission_keys`), front resolver phân nhánh theo `key_mode` với nhánh `GROUP_MANAGED` chỉ đi qua root grant và **không bao giờ** fallback sang child membership, idempotency đảo thứ tự (authorize → replay → fingerprint cho request mới), phân vùng `requestDefaults`/`profileSettings` + chuẩn hóa `isLocked`, 8 kiểm định ngữ nghĩa trong `manifest-validator.ts`, và route public v2 + workbench v2. Bằng chứng: 14 test PostgreSQL thật (có case key có membership ACTIVE nhưng không có grant vẫn bị 403), 29 test offline, `verifyMigrations` xanh trên ledger 71 file.

---

## 1. Files delivered

| File | Δ | Content |
| :--- | :--- | :--- |
| `orchestrator/services/orchestrator/migrations/0071_resolution_fingerprint.sql` | new (1,828 B) | `submission_keys.resolution_fingerprint text` + `^sha256:[0-9a-f]{64}$` CHECK; nullable so every v1 row and every pre-PC-05 v2 row reads as "no fingerprint" |
| `src/modules/operations/submission.ts` | +~600 | `GroupAdmissionPin` / `ResolvedAdmission` / `AdmissionSelector` types, `resolveGroupAdmission`, `resolveAdmission` (front resolver), `profileV2RouteAction`, `canonicalSubmissionHash`, `assertGroupKeyAuthorized`, `lockGroupRootForAdmission`, `lockGroupKeyAndGrant`, `buildProfileResolutionV2`, `previewProfileV2`, `submitProfileV2`; `submit` now resolves through the front resolver, supports `resolvedAdmission`/`v2`, persists and compares the fingerprint |
| `src/modules/profiles/policy.ts` | +~200 | `resolveRequestParameters` (source partition + top-level defaults), `normalizeConfiguredLock`, `declaredDefaultLocked` |
| `packages/contracts/src/manifest-validator.ts` | +~180 | `parameterResolutionProblems` — the eight semantic checks, capability-gated |
| `src/http/routes/public.ts` | +~95 | `handlePublicProfileGroupsV2` for `POST /api/v2/profile-groups/:groupId/{preview,operations}` |
| `src/http/routes/internal-admin-workbench.ts` | +8 | `/v2/preview`, `/v2/submit` suffixes behind the existing session/CSRF/audience gates |
| `src/modules/admin-workbench/service.ts` | +~130 | `previewProfileGroupV2`, `submitProfileGroupV2`, `resolveWorkbenchGroupId`, local-USER fence binding key **and** child profile |
| `tests/profile-v2-http.test.ts` | new | 29 offline tests: 8 manifest checks, partition/lock matrix, fingerprint determinism, DTO strictness, route refusals |
| `tests/profile-resolution-pg.test.ts` | new | 14 live tests: ledger/drift, resolver branches, no-fallback proof, preview/submit round-trip, replay after drift, stale fingerprint, idempotency conflict |
| `jest.unit.config.cjs` | +1 | registers the PG suite as window-gated |

## 2. Instruction-by-instruction

### 2.1 Migration `0071` (Option A) — done

Column on `submission_keys`, not `operations`: replay is decided by the same `(tenant, api_key, route, key)` lookup that already reads this table, and the row's TTL is the replay window. `NULL` is never treated as a match. Applied by the real runner and asserted in the PG suite (`verifyMigrations` resolves ⇒ declared-object drift guard green; ledger row 71 carries `checksum_provenance='migration'`).

### 2.2 Front resolver — done

`resolveAdmission` branches on `api_keys.key_mode`:

- `GROUP_MANAGED` → `resolveGroupAdmission`, which requires an ACTIVE `profile_group_api_keys` row, `auth_authority='GROUP_GRANT'`, an access-version match, exactly one matching `profile_group_members` row, group ownership through `profile_names.group_id`, and `enabled=true`. Every failure throws. **It cannot reach the membership query**, and the PG suite proves it: a `GROUP_MANAGED` key holding an ACTIVE child membership but no grant is `403 PROFILE_GROUP_UNAUTHORIZED`.
- every other mode (including `NULL`, the transitional bridge) → the untouched v1 `profiles.resolveEffectiveProfile`.

Ambiguity is a denial: a v1 selector that matches two functions (same `endpoint_slug`, different `function_id`) returns 403 rather than choosing. v2 adds `functionId` and requires an exact `endpoint_slug` match.

### 2.3 Inverted idempotency — done

`submitProfileV2` order is exactly: authenticate (401) → authorize the grant/authority (403/409) → idempotency lookup → fingerprint verification (409) → write. Nothing that can drift is read before the replay lookup, so an exact retry survives a configuration change; nothing durable is written before the fingerprint matches.

The PG suite pins all three outcomes: replay returns the original operation after an `access_version` bump; a stale fingerprint on a new key is a 409 with a byte-identical `operations` count; the same key with a different fingerprint is `IDEMPOTENCY_CONFLICT`.

### 2.4 Parameter resolution and semantic validation — done

`resolveRequestParameters` implements the plan's rules: `profileSettings` never enters request input (supplying one is `PROFILE_UNKNOWN_FIELD`; supplying a locked one is `PROFILE_LOCKED_FIELD`), `requestDefaults` fill only absent properties, a configured value beats a schema default, and `applyTopLevelDefaults` fills absent top-level properties for both mapped and unmapped keys. No deep merge; falsy values are values.

`normalizeConfiguredLock` is `explicit ?? schema.defaultLocked ?? false`.

The eight manifest checks: (1) non-empty mapping, (2)/(3) target exists in the owning schema, (4) no credential-like request default, (5) no `$ref` declaration, (6) no combinator declaration, (7) object-shaped schema when top-level defaults are claimed, (8) no nested-only default when defaults are claimed. Absence of the capability produces zero problems — the frozen v1 digest test still passes.

### 2.5 Public v2 and Workbench v2 routes — done

`POST /api/v2/profile-groups/:groupId/preview` (200) and `/operations` (202 new / 200 replay) are claimed inside `handlePublicRoutes`; `/api/v2` collides with no earlier handler family, so `server.ts` was not needed. The workbench adds `/v2/preview` (200) and `/v2/submit` (202) as suffixes of the existing internal route, reusing its admin-session, CSRF, viewer-denial and `ingressAudience` gates. The workbench derives the group from the explicitly selected key and requires the local USER to hold both that key and the resolved child profile.

## 3. Deviations and known limitations (explicit)

| # | Item | Impact / follow-up |
|---|---|---|
| 1 | `create-app.ts` is outside this lease, so `createSubmissionService` receives no `cryptoEnv` and defaults to `process.env`. | A deployment that passes a custom `profileCipherKey` to `createProfileService` must pass the same object here or a group child's encrypted `file_url_auth_cipher` decrypts to `null` (fail-closed: no URL credential, not a leak). One-line wiring for PC-09. |
| 2 | `buildProfileResolutionV2` passes `workflow: null` to the fingerprint. | PC-06 owns the workflow registry read; the function's `workflowRevision` is already inside `function.workflowRevision`, so a workflow function is still pinned — only the digest slot stays empty. Recorded, not hidden. |
| 3 | Group policy decoding reproduces two module-private parsers from `profiles.ts` (`parseStoredCallbackPolicy`, `parseStoredCredentialAllowedOrigins`). | That file is PC-03's lease. A later packet should export the pair and delete the copies; the semantics are identical (same contract schemas, same 500 code). |
| 4 | v1 `submit` keeps its pre-admission replay fast path. | Required: v1 requests carry no fingerprint and must stay byte-compatible. The inversion applies to the v2 path only. |
| 5 | Workbench v2 submit resolves twice (preview, then submit). | Deliberate: the local-USER fence must bind the exact child profile before the write, and the submit re-resolves under its own locks. |
| 6 | `NULL` `key_mode` falls through to standalone in v1. | Transitional bridge, documented in code. PC-04 now sets an explicit mode on every issuance/rotation path; the bridge can be removed once no NULL rows exist (a 0072-style assert). |

## 4. Verification (actually run)

Environment: Node v22.23.3, disposable `postgres:16-alpine` on host port 55440 (removed after the run). The project database was never contacted.

| # | Command | Result |
| :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (contracts) | exit 0 |
| 2 | `node node_modules/typescript/bin/tsc -p tsconfig.json` (contracts build) | exit 0 |
| 3 | `node node_modules/jest/bin/jest.js --runInBand` (contracts) | **36 suites / 622 tests passed**, exit 0 |
| 4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (service) | exit 0 |
| 5 | `jest --runInBand --config jest.unit.config.cjs tests/profile-v2-http.test.ts` | **29 passed, 29 total**, exit 0 |
| 6 | `DU_LIVE_INFRA=1 jest --runInBand --config jest.config.cjs tests/profile-resolution-pg.test.ts` | **14 passed, 14 total**, exit 0 |
| 7 | `jest --runInBand --config jest.unit.config.cjs tests/p730-medium1-parameter-policy.test.ts tests/profile-api-keys-membership-offline.test.ts tests/woc-backend-contracts.test.ts` | **3 suites / 46 tests passed**, exit 0 |

Live suite coverage (all against the real migration chain):

1. ledger records 0071 with a checksum and `verifyMigrations` resolves (drift guard green);
2. `resolution_fingerprint` is nullable `text` and a non-digest value is rejected with `23514`;
3. `GROUP_MANAGED` key resolves through its grant with no child membership;
4. the same key without a grant denies **even though it holds an ACTIVE child membership** (`PROFILE_GROUP_UNAUTHORIZED`);
5. revoked grant denies; 6. ambiguous v1 selector denies; 7. legacy key falls through to `null`;
8. cross-tenant key denies;
9. preview returns refs, a fingerprint, and the applied request defaults;
10. a supplied locked request default is `PROFILE_LOCKED_FIELD`;
11. submit persists the fingerprint and replay returns the original operation;
12. exact replay still returns the pinned operation after the access version drifts;
13. a stale fingerprint is `PROFILE_CHANGED` with zero durable rows;
14. the same idempotency key with a different fingerprint is `IDEMPOTENCY_CONFLICT`.

Migration file facts: `0071_resolution_fingerprint.sql`, 1,828 bytes, LF-only (no CR), no BOM, `sha256_lf = 90d37a3214981724a5a512c289373c0af1330a3de46e5aacf7e6244ce9ae25f5`.

## 5. Scope boundary

Source, built artifact and running container are distinct levels. This receipt covers **source and test level only**, on a disposable database. It makes no claim about a built image, a deployed container, or any production cohort. The conversion of real groups to `GROUP_GRANT` remains a per-cohort PC-03/PC-09 operation gated on the migration dry-run.

## 6. Suggested next packets

1. **PC-06** — register the opt-in manifest versions, fill the fingerprint's `workflow` slot from the registry, and keep Runtime API v1 unchanged.
2. **PC-07** — retry must re-run the same root-grant authorization before replay and before insert; it can reuse `assertGroupKeyAuthorized` and the two lock helpers.
3. **PC-09** — wire `cryptoEnv` into `createSubmissionService` in `create-app.ts`, then run the concurrency harness (grant revoke vs submit, access bump vs submit) and the real-HTTP v2 suites.
