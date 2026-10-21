# Receipt — PC-07 Execute (Retry and Operation Ownership)

| Field | Value |
| :--- | :--- |
| Packet | `PC-07-EXECUTE` — *Retry and Operation Ownership* |
| Worker | `dsh_1` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Date | 2026-10-21 |
| Master plan | `du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` (PC-07 row, "Retry") |
| Prerequisites | PC-01 / PC-02 / PC-03 / PC-05 / PC-06 accepted |
| Status | **COMPLETE** — typecheck 0, new suite 21/21, full retry set 39/39, adjacent suites 38/38 |

**Tóm tắt (VI).** Retry giờ **tái cấp quyền theo quyền hiện tại** (không dùng quyền đã pin): chạy hai lần — trước
bước coalescing và ngay trước INSERT — nên key bị thu hồi, root grant bị revoke hay function bị disable
đều bị từ chối 409 với mã lỗi cụ thể. Toàn bộ **5 carrier mã hoá** (input, payload, prompt overrides,
tenant defaults, connector recipe pins) được mở bằng AAD cũ và **đóng lại bằng AAD mới**; không có
ciphertext nào được copy. 21 test mới, gồm phần chứng minh AAD isolation bằng một crypto giả mô phỏng
đúng hành vi `CONTEXT_MISMATCH`.

---

## 1. Files delivered

| File | Δ | Content |
| :--- | :--- | :--- |
| `src/modules/operations/retry.ts` | 178 → 400 lines | `authorizeRetry` + `readCurrentGroupFunction`, dual reauthorization, five-carrier resealing, explicit carrier columns in the retry INSERT, `RETRY_AUTHORIZATION_CODES` |
| `tests/profile-control-plane-retry.test.ts` | **new** (21 cases) | AAD-isolating crypto fake + scripted world; authorization, resealing, coalescing, state invariants |
| `src/http/routes/internal-operations.ts` | **0** | no change required — see §6 |

Read-only references actually consulted: `profile-groups.ts` (`resolveRootGrant`, `readGroupAuthority`),
`profiles.ts`, `submission.ts` (admission + `sealTenantDefaultsSnapshot` / `sealConnectorRecipePins`
usage), `runtime/metadata-crypto.ts` (`METADATA_SLOTS`), `global-settings/{snapshot,workflow-recipe-pins}.ts`,
`encryption/metadata-read-policy.ts`.

---

## 2. Requirement mapping

### 2.1 Admin-only fresh execution with ownership preservation

Retry stays Admin-only at the route (`internal-operations.ts`: `principal.role !== 'platform'` → 403,
plus `assertWriteAccess`/CSRF and the no-override body rule) and at the dispatcher table
(`operations.retry`: `bearerRoles: ['platform']`, `cookieRoles: ['admin']`).

The fresh row is a **column-explicit copy** of the pinned original — `retry_of` points at it, identity
is new (`id`, `root_task_id`, `correlation_id`), and every preserved fact rides along by column name:

| Preserved | Column(s) |
|---|---|
| Owner key | `api_key_id` |
| Config snapshot | `profile_id`, `profile_revision`, `profile_policy_snapshot` |
| Connector pins | `connector_bindings`, `connector_recipe_pins_ref` (re-sealed, §2.3) |
| Callback policy | `callback_policy`, `callback_url` |
| Prompt pins | `prompt_revisions_pin`, `prompt_overrides_ref` (re-sealed) |
| Manifest/workflow revision | `workflow_schema_slug`, `workflow_schema_revision`, `workflow_schema_digest` |
| Tenant defaults | `tenant_defaults_ref` (re-sealed), `tenant_defaults_digest`, `tenant_defaults_ai_revision`, `tenant_defaults_prompt_revision`, `tenant_default_connector_id`, `tenant_default_connector_revision` |
| Projection | `pipeline_json`, `output_format`, `endpoint_slug`, `submit_artifacts` |
| Deadline | recomputed relatively (`deadline_at - created_at` → `now() + delta`), unchanged formula |

`state_version`, `current_step` and `progress_*` are deliberately **not** copied: a retry starts a
fresh execution, and inheriting progress would make a never-run operation look partially done.

### 2.2 Strict reauthorization — twice, and against current authority

`authorizeRetry(client, op, tenantId)` is called **(a)** immediately after the source-state check, i.e.
before the coalescing lookup, and **(b)** immediately after the `FOR UPDATE` operation lock, before the
insert. Both passes read live tables; nothing is cached from admission.

| Condition | Status | Code |
|---|---|---|
| Operation has no `api_key_id` | 409 | `KEY_INACTIVE` |
| Key row missing | 409 | `KEY_INACTIVE` |
| Key `status <> 'ACTIVE'` | 409 | `API_KEY_REVOKED` |
| Key tenant ≠ operation tenant | 404 | `NOT_FOUND` (never a cross-tenant oracle) |
| `GROUP_MANAGED` and no ACTIVE root grant | 409 | `GRANT_REVOKED` |
| `GROUP_MANAGED` and the function is gone / ambiguous / `enabled=false` in the group's **current** revision | 409 | `ENDPOINT_DISABLED` |
| Standalone/legacy, profile pinned, membership not ACTIVE | 409 | `GRANT_REVOKED` |
| Any mode, spend admission fails | 429/402 | existing `assertKeySpendAvailable` codes |

Group-managed retries **never** fall back to child membership: the branch is selected by
`api_keys.key_mode`, and a missing grant throws instead of continuing.

### 2.3 Cryptographic carrier resealing (AAD isolation)

Five operation/task-bound carriers are opened under the **old** AAD and re-sealed under the **new**
one. Ciphertext is never copied.

| Carrier | Slot | Old `refId` → New `refId` |
|---|---|---|
| `operations.input_ref` | `operations.input_ref` | old operation → **new operation** |
| `tasks.payload_ref` | `tasks.payload_ref` | old root task → **new root task** |
| `operations.prompt_overrides_ref` | `operations.prompt_overrides_ref` | old operation → **new operation** |
| `operations.tenant_defaults_ref` | `operations.tenant_defaults_ref` | old operation → **new operation** |
| `operations.connector_recipe_pins_ref` | `operations.connector_recipe_pins_ref` | old operation → **new operation** |
| outbox `sourceUrl` (ingestion gate) | `tasks.payload_ref` | new task (unchanged rule) |

`tenant_defaults_ref` and `connector_recipe_pins_ref` are the two the pre-PC-07 code copied **verbatim**
inside the `INSERT ... SELECT`; they are now parameters holding freshly sealed envelopes, while their
immutable metadata (`*_digest`, `*_revision`, connector id/revision) is still copied by column name.
`profile_policy_snapshot` and `prompt_revisions_pin` are **not** sealed carriers (they are secret-free
JSON / non-secret digests) and stay copy-by-name.

A null carrier stays null: `openNullable` short-circuits, so an operation with no tenant defaults does
not gain an empty envelope.

### 2.4 State and replay invariants

Unchanged and still covered: `INVOCATION_UNKNOWN` / `state='UNKNOWN'` / any task `UNKNOWN` blocks
before any write; the source must be `FAILED|CANCELLED|TIMED_OUT`; version pre-drain pauses fresh
retries; an active sibling is returned as a replay; the operation/task snapshot checks
(`business_version`, `root_task_id`, `input_ref`, `payload_ref`, `kind`, `max_attempts`) still run
under the locks.

One deliberate refinement: the **replay path now reauthorizes first**. Previously a revoked key could
still receive `{replayed:true}` for an active sibling. A denied caller also no longer learns whether a
sibling exists, because the coalescing read happens after authorization.

### 2.5 Verification

`tests/profile-control-plane-retry.test.ts` — 21 cases, all six required scenarios:

| Required scenario | Cases |
|---|---|
| Successful retry under active key + active grant | `creates a fresh execution…`, `reads authority before the coalesced-replay check`, `reauthorizes a second time immediately before the insert` |
| Key revoked | `denies a globally revoked key…`, `denies a missing key`, `denies an operation with no recorded owner key` |
| Group root grant revoked | `denies a revoked root grant with GRANT_REVOKED` |
| Function disabled | `denies a function disabled…`, `denies a function removed…` |
| Carrier re-encryption binds to the new AAD | `opens every carrier under the old AAD and seals it under the new one`, `binds each resealed carrier to the new row and never copies ciphertext`, `proves the AAD isolation…`, `keeps a null carrier null…` |
| Coalescing re-authorizes | `re-authorizes before answering a replayed sibling`, `denies a revoked key even when a sibling execution is active`, `denies a revoked grant even when…` |

The AAD proof uses a crypto fake that records the AAD each envelope was sealed under and throws
`CONTEXT_MISMATCH` when opened with a different one — i.e. the same fail-closed property the real
`metadata-crypto` enforces.

---

## 3. Verification (actually run, in `orchestrator/services/orchestrator`)

| # | Command | Result |
| :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0**, no diagnostics |
| 2 | `… jest --runInBand --config jest.unit.config.cjs tests/profile-control-plane-retry.test.ts` | **exit 0** — `Test Suites: 1 passed`, `Tests: 21 passed, 21 total` |
| 3 | same, the six retry suites together (`profile-control-plane-retry`, `runtime-retry-admission`, `cb02c-retry-callback-pin`, `or10-04-retry-workflow-schema`, `orv15-admin-retry-regression`, `orv12-callback-owner`) | **exit 0** — `Test Suites: 6 passed`, `Tests: 39 passed, 39 total` |
| 4 | same, `orv14-ui-admission-retry-owner` + `orv11-operations-routes` | **exit 0** — `Tests: 38 passed, 38 total` |

---

## 4. Deviations and judgement calls

1. **Unclassified `key_mode` (`NULL`) takes the legacy branch.** The dispatch's retry requirement
   names exactly two branches (`GROUP_MANAGED`, standalone/legacy). `0070` backfills every existing
   key, so `NULL` only appears for pre-migration rows and fixtures; treating it as group-managed would
   invent authority, and refusing it outright would strand those rows. It is **never** promoted to
   `GROUP_MANAGED`, and the branch rechecks the legacy profile membership + spend.
2. **A revoked legacy membership reports `GRANT_REVOKED`.** The dispatch fixes four codes and does not
   name a fifth for the legacy membership; reusing `GRANT_REVOKED` keeps the client-facing set closed
   and the detail string distinguishes the case.
3. **`internal-operations.ts` is unchanged.** Its retry route is already platform-only with the
   no-override rule, and the dispatcher already gates the action. Editing it would have added no
   behaviour; the file stays as shipped.
4. **The retry INSERT keeps the `INSERT … SELECT` shape** (rather than an explicit `VALUES` list) so
   the pinned row remains the source of truth for every preserved column, while the five sealed
   carriers become parameters. This also keeps `cb02c`'s column/expression contract intact.
5. **Second authorization runs before the locked coalescing read but after the locked snapshot
   checks** — specifically: lock → reauthorize → locked-coalesce → task lock → insert. That ordering
   keeps "deny before any write" and "replay only for an authorized caller" both true.

---

## 5. Lease exception requested

`PC-07`'s lease is `retry.ts`, `internal-operations.ts` and the new suite. Universal reauthorization
necessarily adds one read (`SELECT id, tenant_id, status, key_mode FROM api_keys`) plus two
authorization reads to **every** retry, which four pre-existing retry suites did not script. I updated
their fakes/expectations minimally, with comments citing PC-07:

| File | Change |
|---|---|
| `tests/runtime-retry-admission.test.ts` | one extra `if` branch for the key read (fixture key is unclassified) |
| `tests/cb02c-retry-callback-pin.test.ts` | fixture gains `api_key_id`; one extra branch |
| `tests/or10-04-retry-workflow-schema.test.ts` | fixture gains `api_key_id`; one extra branch |
| `tests/orv12-callback-owner.test.ts` | two cases re-scripted: reauthorization now precedes coalescing, so the query count grows and the "replay does not recheck spent budget" assertion is replaced by "replay reauthorizes first" |

No production behaviour in those suites was weakened: each still asserts the property it was written
for (pre-drain pausing, callback pin copy, workflow-schema pin reuse, unknown-outcome blocking).
Reverting the four files would leave the mandated reauthorization untested at those seams; if the
coordinator prefers another owner for them, the source change stands on its own.

---

## 6. Handoff

**PC-09** — the retry acceptance case ("Retry of managed operation") is now test-backed at the unit
level. A live PG run remains for the concurrency story (two concurrent retries, grant revoked between
the two authorization passes); the second pass exists precisely so the insert cannot depend on a stale
decision.

**PC-04** — global key revoke already invalidates retries through `api_keys.status`; the group-grant
helper (`revokeAllGroupGrantsForApiKey`) additionally closes the `GRANT_REVOKED` path. No retry-side
change is needed when those land.

**Operations UI (PC-08)** — retry denials now carry the four codes above; surface them as
"authorization changed" rather than a generic conflict, and never as a retryable transient.

---

## 7. Evidence boundary

Source + offline-test evidence only. No built image, no deployed container, no live database was
exercised by this packet: the suite is a scripted world plus an AAD-faithful crypto fake. `0070` is
still not applied to the project dev database; the PC-03 live suite remains the only PostgreSQL
evidence in this lane.
