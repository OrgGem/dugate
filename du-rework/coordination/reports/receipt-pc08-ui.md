# Receipt — PC-08 Execute (Admin Workbench and Operations UI)

| Field | Value |
| :--- | :--- |
| Packet | `PC-08-EXECUTE` — Admin Workbench and Operations UI Implementation |
| Dispatch | [`du-rework/coordination/dispatch-specs/PC-08-dispatch.txt`](../dispatch-specs/PC-08-dispatch.txt) |
| Approved spec | [`du-rework/coordination/reports/prep-pc08-ui-spec.md`](prep-pc08-ui-spec.md) (D-01…D-12 approved as recommended) |
| Master plan | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) — PC-08 row |
| Worker | DeepSeek Worker 0 (Frontend & Admin Workbench Specialist) — `deepseek-v4.1-flash` |
| Status | **COMPLETE (source + tests).** All 8 acceptance criteria implemented; 40/40 new tests green; service + admin-web typecheck clean; admin-web bundle builds. |
| Evidence level | **Source and disposable test level only.** No PostgreSQL/Redis used, no container built or deployed. The browser spec was authored and type-checked but NOT executed (no `AWEB01B_*` harness in this session). |
| Date | 2026-10-20 (host clock at run time) |

**Tóm tắt (VI).** Đã triển khai toàn bộ bề mặt PC-08 trong file lease:

- **BFF V2 mới** (`bff/profile-groups-v2.ts`, 304 dòng): 7 route list/create/read/replace/rollback/issue/revoke; dispatch đặt **trước** matcher v1 (nếu không `/profile-groups/v2` bị v1 trả `invalid` → 404); local USER bị từ chối theo **D-01**; mutation chỉ platform Admin + CSRF; `If-Match` được forward nguyên văn; chỉ `ETag` và `idempotent-replay` được relay.
- **BFF workbench V2**: thêm `/admin-workbench/v2/preview` (không cần Idempotency-Key) và `/submit` (bắt buộc), giữ nguyên session/CSRF/viewer gate và session-proof cho local operator.
- **Client/admin-web**: 9 method mới + type re-export + khả năng gửi `If-Match`.
- **Editor V2 viết lại** thành 3 pane (Configuration / Root access / Revisions): zero-key CRUD, hai bộ đếm `revision` ≠ `accessVersion`, issue/revoke grant với secret hiển thị một lần, rollback chỉ đổi config pointer, và chế độ **read-only + banner** cho group `CHILD_PROJECTION`.
- **Workbench V2** trong `docs-screen.tsx`: chọn key tường minh → preview (refs + effective + fingerprint) → submit đúng fingerprint + Idempotency-Key; fingerprint cũ bị vô hiệu hoá khi input đổi hoặc khi `409 PROFILE_CHANGED`.
- **Operations**: giữ nguyên ma trận action; thêm khối "Pinned profile" **chỉ khi** server thực sự trả `resolution` (D-02(c) — không bịa dữ liệu).

Bằng chứng: 3 suite mới **40/40 pass**, 6 suite BFF liền kề **82/82**, 5 suite UI liền kề **25/25**, full offline **389 suite pass / 1 fail có sẵn từ trước** (`rfx10-seed-gate`, không thuộc PC-08), `tsc` service + admin-web đều exit 0, `vite build` exit 0.

---

## 1. Files delivered

| # | Path (root = `du-rework/`) | Lines | Change |
| :--- | :--- | ---: | :--- |
| 1 | `orchestrator/services/orchestrator/src/app/admin/bff/profile-groups-v2.ts` | 304 | **new** — 7 V2 routes, `If-Match` forward, ETag/replay relay, D-01 denial |
| 2 | `orchestrator/services/orchestrator/src/app/admin/bff/admin-workbench.ts` | 137 | +`preview-v2` / `submit-v2` suffixes; preview exempt from Idempotency-Key, submit requires it |
| 3 | `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts` | 842 | dispatch order: V2 family matched **before** v1 |
| 4 | `orchestrator/services/orchestrator/src/app/admin/bff/upstream.ts` | 245 | additive `ifMatch` request option + allowlisted `relayHeaders` (etag / idempotent-replay) |
| 5 | `orchestrator/apps/admin-web/src/features/profiles/profile-group-state.ts` | 414 | **rewritten** — V2 draft, zero-key save body, validation, error-copy resolver |
| 6 | `orchestrator/apps/admin-web/src/features/profiles/profile-group-editor.tsx` | 1 035 | **rewritten** — rail + header + 3 panes, registry enrichment, read-only projection |
| 7 | `orchestrator/apps/admin-web/src/features/profiles/profile-group-access-pane.tsx` | 356 | **new** — grants table, issue (secret once), revoke |
| 8 | `orchestrator/apps/admin-web/src/features/profiles/profile-group-schema-fields.tsx` | 194 | **new** — one renderer for `profileSchema` and `inputSchema` |
| 9 | `orchestrator/apps/admin-web/src/features/docs/docs-screen.tsx` | 1 618 | +`GroupWorkbenchPanel` (preview → fingerprint → submit), endpoint inventory |
| 10 | `orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx` | 1 507 | forward-compatible `resolution` block (renders only when server sends it) |
| 11 | `orchestrator/apps/admin-web/src/lib/api/client.ts` | 1 434 | +9 methods, `ifMatch` header capability |
| 12 | `orchestrator/apps/admin-web/src/lib/api/types.ts` | 1 176 | +V2/grant/workbench type re-exports |
| 13 | `orchestrator/apps/admin-web/src/lib/api/index.ts` | 255 | +barrel re-exports (lease exception LE-1) |
| 14 | `orchestrator/services/orchestrator/tests/aweb10-profile-group-v2-state.test.ts` | 295 | **new** — 16 pure-module cases |
| 15 | `orchestrator/services/orchestrator/tests/aweb10-bff-profile-groups-v2.test.ts` | 402 | **new** — 14 BFF cases |
| 16 | `orchestrator/services/orchestrator/tests/aweb10-bff-workbench-v2.test.ts` | 338 | **new** — 10 BFF cases |
| 17 | `tests/browser/admin-web/profile-groups-v2.spec.ts` | 364 | **new** — 7 browser cases (authored, not executed) |

Not touched (confirmed by `git status` scoping): `packages/contracts/**`, `migrations/**`, `modules/profiles/**`, `modules/operations/**`, `identity/**`, `worker-sdk/**`, `modules/operations/retry.ts`, and `features/profiles/**` files outside the listed set.

---

## 2. Acceptance criteria — implementation and evidence

### 2.1 Zero-key V2 group CRUD

- `ProfileGroupEditorDraft` has **no** `apiKeyId`; `buildProfileGroupSaveBody` emits `{name, tenantId?, authMode, expectedRevision, businesses[].functions[]}` and never `apiKey` (`profile-group-state.ts`).
- The editor's create flow asks only for a name, then lets the operator bind businesses/functions. A tenant without any active key keeps the whole editor usable (rail hint: "Groups can still be configured; submission needs a granted key.").
- Save success copy: `Created <name> with configuration revision N. No API key was minted.`
- Test proof: `aweb10-profile-group-v2-state` "builds a zero-key save body that satisfies the frozen contract" asserts `ProfileGroupV2SaveSchema.safeParse(body).success === true` and `'apiKey' in body === false`; BFF test "create … forwards a key-free body" asserts the exact forwarded JSON.

### 2.2 Independent `active_revision` / `access_version`

- Header renders both counters with distinct labels ("Config revision" / "Access version (grants)") and one legend sentence.
- `profileGroupDraftFromRead` copies `revision`, `accessVersion`, `authAuthority` independently; save updates only `revision`, grant responses update only `accessVersion`.
- Success copy after a save: `Saved configuration revision N; the access version remains M.`
- Tests: state suite "keeps config revision, access version and authority separate"; browser spec case 2 (two counters visible, v1 key selector absent).

### 2.3 Root grant panel with `expectedAccessVersion`

- Access pane lists ACTIVE grants (prefix, key id, status, grantedAt, grantedBy), an explicit empty state, and two mutations:
  - **Issue**: sends `If-Match: "<accessVersion>"` and a per-dialog `Idempotency-Key`; the raw secret is rendered once, requires an acknowledgement checkbox, and is cleared on close. A replay (`secretAvailable:false`) says the secret cannot be redisplayed.
  - **Revoke**: sends `{expectedAccessVersion}` + `Idempotency-Key`, is destructive-confirmed, and on `412` closes + reloads without retrying.
- The issue response does **not** carry the new access version, so the pane re-reads the group before enabling further mutations (documented in code).
- Tests: BFF "grant issue requires Idempotency-Key and forwards If-Match verbatim" (428 on missing, `"7"` forwarded, `no-store`), "grant revoke forwards the expected access version and returns the new one"; browser spec cases 3 and 4.

### 2.4 Workbench V2: explicit key + preview + fingerprint

- New `GroupWorkbenchPanel` in `docs-screen.tsx`:
  1. requires an explicitly selected ACTIVE key (no default, no group picker);
  2. offers the group functions whose group has an active grant for that key;
  3. calls `POST /admin/api/admin-workbench/v2/preview` and renders `refs` (group/access/child/manifest/connector/tenant-defaults), `effective` (parameters, applied request/schema defaults, locked fields) and the fingerprint;
  4. submits `POST …/v2/submit` with that exact fingerprint and an `Idempotency-Key`;
  5. on `409 PROFILE_CHANGED` invalidates the preview and requires a re-preview; any input edit also invalidates it.
- BFF: preview is the only workbench action without `Idempotency-Key`; both keep the v1 session/CSRF/viewer gates and forward the local operator's session proof instead of a bearer.
- Tests: 10 BFF workbench cases (including session-proof forwarding and tenant 404) and browser spec case 7.

### 2.5 CHILD_PROJECTION read-only projection

- When `authAuthority !== 'GROUP_GRANT'` every write control (Save, Rollback, Issue, Revoke) is disabled and both the configuration banner and the access pane explain that the service refuses writes with `409 PROFILE_GROUP_V2_REQUIRED` until the group is converted (conversion has no route).
- The editor still renders the full configuration read-only, including server-owned child pins and manifest digests.
- Tests: state suite `profileGroupWritesAllowed`; BFF test that reads/put on the conflict fixture pass the upstream code through; browser spec case 6.

### 2.6 Schema inspection (businesses / versions / functions / input-output-profile)

- Each selected function has an expandable editor with: Profile settings (`profileSchema` → `policy.parameters`), **Request defaults** (`inputSchema` → `requestDefaults`), connector slots, and a read-only strip (`manifestDigest`, `childProfileId`, `childRevision`, selector, workflow revision).
- Credential-shaped request-default keys are refused client-side (`secretLikeParameterKey`) and hidden from the field list; the server remains authoritative.
- Tests: state suite validation cases; editor renders the inputs consumed by the browser spec.

### 2.7 Legacy UI stays compatibility-only

- No group affordance was added to the server-rendered shell; the React app no longer calls the v1 group endpoints for groups (the v1 client methods remain for compatibility consumers only).
- Error copy is code-driven (`resolveProfileGroupV2Error`), because the BFF replaces upstream titles: `PROFILE_GROUP_V2_REQUIRED`, `PROFILE_CHANGED`, `PROFILE_GROUP_UNAUTHORIZED`, `REVISION_CONFLICT`, `PRECONDITION_REQUIRED`, `PRECONDITION_FAILED`, `STATE_CONFLICT`.
- Test: BFF "passes the upstream problem code through without leaking its message".

### 2.8 Operations diagnostics (D-02(c))

- The action matrix is unchanged (Stop/Retry/Delete rules and the unknown-outcome fence are untouched).
- No fabricated refs: a "Pinned profile" block renders **only** if the detail payload carries a `resolution` object (`operations-screen.tsx` helper `resolutionFromRaw`). Group `accessVersion` at admission is not stored on `operations`, so it is never claimed.
- Consequence recorded as a documented partial for R6 until a projection is added by PC-07/PC-09.

---

## 3. Approved decisions as implemented

| Decision | Implementation |
| :--- | :--- |
| **D-01** operator discovery | V2 group BFF routes are platform-Admin only; a local USER session gets `403 PROFILE_GROUP_ASSIGNMENT_REQUIRED` before any upstream call. Operators keep the v1 workbench. |
| **D-02** operations refs | Option (c): no fabricated refs; forward-compatible render only when `resolution` is present. |
| **D-03** group rail read | Always `GET /admin/api/profile-groups/v2?tenantId=`; v1 list is never called by the React app. |
| **D-04** issue idempotency | One UUID per dialog open, retained across transport failure; reset on close. |
| **D-05** access version transport | Browser sends `If-Match`; client validates `^"?[1-9]\d*"?$`; BFF forwards verbatim; service owns 428/412. |
| **D-06** issue note | Accepted but labelled "The API does not project the note back after issue." |
| **D-07** client secret refusal | `secretLikeParameterKey` mirrors the server rule for immediate feedback, with server authority stated in copy. |
| **D-08** CHILD_PROJECTION UX | Read-only + conversion banner; writes disabled. |
| **D-09** workbench function discovery | UI filters the V2 group list by the selected key's grants; server still derives/verifies the group. |
| **D-10** v1 editor retirement | React group editor replaced; v1 client methods/route family retained for compatibility consumers. |
| **D-11** replay visibility | UI relies on `secretAvailable`; `idempotent-replay` is relayed by the BFF but not required by the UI. |
| **D-12** retry re-authorization | Cross-packet dependency recorded; no UI change. |

---

## 4. Deviations, lease exceptions, limitations

1. **LE-1 (lease exception, requested): `apps/admin-web/src/lib/api/index.ts`.**
   The lease lists `client.ts` and `types.ts` but the app's public API barrel is `index.ts`; the new types are imported as `from '@/lib/api'`, so the barrel re-export is required for typecheck/build. The edit is additive re-exports only (no logic, no removals). Coordinator approval requested retroactively.
2. **`ProfileGroupV2Rollback` type does not exist in `@du/contracts`** (only `ProfileGroupV2RollbackSchema`). The client therefore types the rollback body with the v1 `ProfileGroupRollback`, which is the frozen alias body. No contract change made.
3. **Issue response carries no `accessVersion`.** The access pane reloads the group after a successful issue instead of guessing the new version.
4. **Browser spec not executed.** `tests/browser/admin-web/profile-groups-v2.spec.ts` requires the `AWEB01B_URL` / `AWEB01B_EVIDENCE` / `AWEB01B_TOKEN` harness (`run-browser-harness.ps1`) and a built shell; neither was available in this session. The file type-checks with **zero** diagnostics in the browser package.
5. **Pre-existing offline failure.** `tests/rfx10-seed-gate.test.ts` ("a zero-config boot seeds even under NODE_ENV=production") fails: expected one `INSERT INTO api_keys`, received zero. The seed block in `src/app/bootstrap/create-app.ts` is a **PC-04-owned** modification (`key_mode` added to the INSERT); the test file is unmodified and outside the PC-08 lease. Not caused by this packet, not fixed here.
6. **File artifacts not uploaded.** The workbench V2 panel submits parameters + optional `sourceUrl`; tenant artifact references remain in the v1 panel. Recorded as a scope choice, not a silent gap.

---

## 5. Verification (actually run)

All commands run in `du-rework/orchestrator` with the repo's own toolchain. No PostgreSQL/Redis, no container.

| # | Command | Literal result | Exit |
| :--- | :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`services/orchestrator`) | no diagnostics | **0** |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`apps/admin-web`) | no diagnostics | **0** |
| 3 | `node node_modules/vite/bin/vite.js build` (`apps/admin-web`) | `✓ 3060 modules transformed`; `dist/assets/index-BbUCu9zP.js 2,363.77 kB`; `✓ built in 6.34s` | **0** |
| 4 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb10-profile-group-v2-state.test.ts tests/aweb10-bff-profile-groups-v2.test.ts tests/aweb10-bff-workbench-v2.test.ts` | `Test Suites: 3 passed, 3 total` / `Tests: 40 passed, 40 total` (16 + 14 + 10) | **0** |
| 5 | same, `tests/aweb05-bff-reads... aweb06-bff-operations... aweb09-profile-api-keys-bff...` added | `Test Suites: 6 passed` / `Tests: 82 passed, 82 total` | **0** |
| 6 | same, `orv13-journeys-owner orv15-admin-retry-regression orv14-ui-admission-retry-owner aweb-17-workflow-test-honesty aweb-16a-overview-tenant-operations` | `Test Suites: 5 passed` / `Tests: 25 passed, 25 total` | **0** |
| 7 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs` (whole offline suite) | `Test Suites: 1 failed, 20 skipped, 389 passed` / `Tests: 1 failed, 223 skipped, 6223 passed, 6447 total`; the single failure is `rfx10-seed-gate` (§4.5) | 1 (pre-existing) |
| 8 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`tests/browser`) | new spec contributes **0** diagnostics; 18 pre-existing errors in `admin-web/harness.ts`, `p745-ui-keys.spec.ts`, and `@/` aliases in imported app files | 1 (pre-existing) |

New-suite coverage detail: 40 cases across contract conformance of the save body, revision/access independence, request-defaults semantics, validation gates, all documented problem codes, matcher precedence, tenant/role/CSRF fences, If-Match/Idempotency transport, ETag relay, preview/submit schemas, and session-proof forwarding.

---

## 6. Scope boundary and handoff

- **Source and test level only.** No built image, no deployed container, no production cohort, no real PostgreSQL. Claims about deployed behaviour are explicitly not made.
- **Contracts, migrations, service core and worker SDK untouched** (PC-01/02/03/04/05/06 ownership respected). No DB window claimed; no migration run.
- **Next packets:**
  - PC-09 cutover: wire `cryptoEnv`, run the real-HTTP v2 harness and the grant-revoke/submit concurrency drill against a real DB;
  - PC-07 (if still active): retry re-authorization against the group grant;
  - Optionally PC-09/PC-07: an operations `resolution` projection (option A of D-02) so the diagnostics block becomes populated rather than dormant;
  - Follow-up: an "assigned group functions" read to give local USER operators a V2 workbench path (D-01(b)).
- **Verification note for the coordinator:** the 40 new cases are the acceptance evidence for this packet; `rfx10-seed-gate` must be reconciled by the PC-04 owner (its `create-app.ts` seed change predates this packet).
