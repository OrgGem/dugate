# Receipt — PC-R07-UI (Render only declared parameter source in editor)

| Field | Value |
| :--- | :--- |
| Finding | `PC-R07` (P2) — *Editor ignores manifest parameter source mapping*; this packet covers the **UI rendering** half |
| Dispatch | [`du-rework/coordination/dispatch-specs/FOLLOWUP-PC-R07-UI-dispatch.txt`](../dispatch-specs/FOLLOWUP-PC-R07-UI-dispatch.txt) |
| Plan row | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) §"PC-R07": *"Discovery exposes the capability and the editor saves each parameter only to its declared effective source."* |
| Worker | DeepSeek Worker 0 (Frontend & Admin Workbench Specialist) — `deepseek-v4.1-flash` |
| Status | **COMPLETE (UI source + tests).** Declared-source partition, rendering, validation and save boundary implemented; 11-case regression suite green; mutation check fails on the defect; typechecks and bundle build pass. |
| Evidence level | **Source and offline test level only.** No PostgreSQL/Redis, no container, no browser run. One upstream dependency is still missing and is reported explicitly (§3); it is outside this packet's lease. |
| Date | 2026-10-21 (host clock at run time) |

**Tóm tắt (VI).** Trước bản vá, editor render **mọi** property của `profileSchema` vào Profile settings và **mọi** property của `inputSchema` vào Request defaults, bỏ qua bản đồ `parameterResolution` của manifest. Hệ quả: với manifest opt-in (ví dụ `example-review` v3, `enableReasoning: requestDefaults`) giá trị bị lưu vào `policy.parameters` — nguồn mà resolver bỏ qua; và với manifest v1 (không có capability) UI vẫn bày request-defaults vốn vô tác dụng.

Đã sửa trong lease UI:
1. **Partition thuần** trong `profile-group-state.ts`: `partitionParameterSchemas`, `parameterSourceOf`, `requestDefaultsCapabilityNotice`, `requestDefaultsEmptyMessage`, `filterParameterEntriesForSource`, `misplacedParameterEntries`.
2. **Render theo nguồn**: Profile settings chỉ nhận property `profileSettings`/không khai báo; Request defaults chỉ nhận property khai báo `requestDefaults`; `required` cũng được lọc theo; manifest v1 hiển thị thông báo "request defaults không khả dụng" và **không render control**.
3. **Biên lưu và validation cũng phải lọc** (phát hiện thêm khi audit): nếu chỉ sửa UI thì `writePolicy` vẫn tự điền default của property `requestDefaults` vào `parameters`, và validation vẫn đòi property đó như profile setting. Cả hai đã được lọc theo partition; với v1 thì giữ nguyên hành vi cũ (không phá dữ liệu inert).

**Phát hiện quan trọng (ngoài lease):** type `ProfileGroupFunction.parameterResolution` đã có trong `@du/contracts`, nhưng **catalog producer chưa emit field này** — `services/orchestrator/src/modules/admin-read/business-functions.ts:62-75` dựng descriptor mà không chuyển `action.parameterResolution.fields`. Vì vậy, cho tới khi catalog được vá (một dòng, thuộc owner khác), mọi manifest opt-in sẽ đọc như capability-free và UI hiển thị đúng thông báo "không thể chỉnh request defaults" — an toàn (không ghi sai nguồn) nhưng chưa dùng được tính năng. Bàn giao chính xác ở §3.

---

## 1. Defect analysis

### 1.1 Pre-fix rendering (PC-08 build)

`profile-group-editor.tsx` rendered both raw schemas:

```tsx
<ProfileGroupSchemaFields schema={descriptor.profileSchema} … />          // all profileSchema properties
<ProfileGroupSchemaFields schema={(descriptor.inputSchema ?? {})} … />    // all inputSchema properties
```

The manifest's declared source was never read, although the descriptor already carried it:

```ts
// packages/contracts/src/profile-groups.ts:80-90, 107
export const ParameterSourceSchema = z.enum(['requestDefaults','profileSettings','policySettings'])
  .transform((v) => (v === 'policySettings' ? 'profileSettings' : v));
export const ParameterResolutionSchema = z.record(z.string(), ParameterSourceSchema);
export type ParameterResolution = Record<string, 'requestDefaults' | 'profileSettings'>;
// ProfileGroupFunctionSchema: parameterResolution: ParameterResolutionSchema.optional()
```

### 1.2 Consequences

1. **Wrong-source save (the reported defect).** `example-review` v3 (`businesses/example-review/src/manifest.ts:126-161`) deliberately declares `enableReasoning` in **both** `inputSchema.properties` and `profileSchema.properties` and assigns it one source: `requestDefaults`. The editor offered it under Profile settings, so a save wrote `policy.parameters.enableReasoning`. The resolver (`services/orchestrator/src/modules/profiles/policy.ts:547-646`) only honours the declared source, so the stored value was inert and the operator saw a "saved" setting that never applied.
2. **Inert controls on v1 manifests.** A capability-free manifest keeps legacy merge semantics (`submission.ts:202`, `:393-401`); request defaults are ignored. The UI still rendered them.
3. **Two deeper instances found while auditing the same defect** (fixed here, otherwise the UI-only fix would be incomplete):
   - **Validation**: `validateProfileGroupDraft` read `profileSchema.required` unfiltered, so a requestDefaults-declared property that is also `required` in `profileSchema` was demanded as a profile setting — even after hiding the control, the save would be blocked.
   - **Save-time default injection**: `writePolicy` called `profileParametersWithDefaults(config.parameters, descriptor.profileSchema)`, which re-adds `profileSchema` defaults for requestDefaults-mapped properties. Hiding a control without filtering this path would still write the wrong source.
4. **Transparency**: stored values that sit in the wrong source were invisible; the fix surfaces them instead of silently moving or hiding them.

---

## 2. Fix

### 2.1 Pure partition helpers — `profile-group-state.ts`

| Helper | Contract |
| :--- | :--- |
| `parameterSourceOf(resolution, name)` | declared source; undeclared ⇒ `profileSettings` (contract default) |
| `partitionParameterSchemas(descriptor)` | `{declared, profileSettingsSchema, requestDefaultsSchema, profileSettingNames, requestDefaultNames}` — filters `properties` **and** `required` |
| `requestDefaultsCapabilityNotice(partition)` | v1 copy: "requires an opt-in manifest capability (parameterResolution)… inert and not editable here"; `null` when declared |
| `requestDefaultsEmptyMessage(partition)` | opt-in with zero declared requestDefaults: "This function declares no request defaults." |
| `filterParameterEntriesForSource(entries, resolution, keep)` | partitions stored entries; **no capability ⇒ entries returned untouched** (v1 inert values are not destroyed) |
| `misplacedParameterEntries(...)` | wrong-source stored keys in both directions, for warnings |

Partition rules, exactly as dispatched:

- `profileSettingsSchema` keeps properties where `parameterResolution[name] !== 'requestDefaults'` (undeclared ⇒ kept).
- `requestDefaultsSchema` keeps only `parameterResolution[name] === 'requestDefaults'`.
- `inputSchema` properties that are caller input appear in **neither** pane.
- `undefined` capability ⇒ profile settings unchanged, `requestDefaultsSchema = null`.

### 2.2 Editor rendering — `profile-group-editor.tsx`

- Profile settings renders `partition.profileSettingsSchema`.
- Request defaults renders `partition.requestDefaultsSchema` only; two explicit notices:
  - capability absent → info banner "Request defaults are not editable for this function" (controls omitted);
  - capability present but no declared defaults → info banner "This function declares no request defaults." plus the note that undeclared parameters are caller input.
- Wrong-source stored values produce warning banners naming the exact parameters and stating that the resolver ignores them and they are not saved in the next revision.
- Credential-shaped warning is now computed from the **declared** request-default names only (a client-input field named `…Token` no longer raises a misleading banner).
- PC-R06 lock wiring is preserved on the filtered schema (`lockMeta` + `schemaDeclaredLock(requestDefaultsSchema, …)`).

### 2.3 Validation and save boundary — `profile-group-state.ts`

- `validateProfileGroupDraft` reads the filtered `profileSettingsSchema` for `properties`/`required`, so a requestDefaults property is never demanded as a profile setting.
- `buildProfileGroupSaveBody`:
  - `policy.parameters` = stored entries whose declared source is `profileSettings` (declared capability only);
  - `requestDefaults` = stored entries whose declared source is `requestDefaults`;
  - `writePolicy` receives the filtered schema and filtered entries, so schema-default injection cannot re-add a requestDefaults property;
  - v1 (no capability): both maps pass through unchanged — identical output to the pre-fix builder.
- PC-R06 interplay is asserted: a value that moves source keeps `isLocked` (`{value:true, isLocked:true}` survives).

---

## 3. Open dependency (out of lease): the catalog does not emit `parameterResolution`

This is the one thing that prevents the feature from being usable end-to-end, and it is **not** in this packet's lease ("DO NOT touch any backend service modules").

- The contract field exists: `packages/contracts/src/profile-groups.ts:80-90, 107`; the built artifact exposes it (`packages/contracts/dist/profile-groups.d.ts`), so the admin-web compiles against it.
- The catalog producer drops it: `services/orchestrator/src/modules/admin-read/business-functions.ts:62-75` builds each descriptor field-by-field and never copies `action.parameterResolution` (the manifest type has it at `packages/contracts/src/manifest.ts:75`).
- Effect today: `GET …/functions` and `GET /api/v2/admin/profile-groups/catalog` return descriptors **without** `parameterResolution`, so the editor treats even `example-review` v3 as capability-free and shows the "not editable" notice. This is the safe direction (no wrong-source writes), but operators cannot configure request defaults until the producer is fixed.

**Hand-off (one line, catalog owner):**

```ts
// business-functions.ts — inside manifestActionFunction's returned object
...(action.parameterResolution
  ? { parameterResolution: action.parameterResolution.fields }
  : {}),
```

`ParameterResolutionSchema` already normalizes `'policySettings'` → `'profileSettings'`, so no mapping code is needed. The PC-R07-UI tests below use descriptors in the contract shape, so they prove the UI behaviour as soon as this lands.

### 3.1 Also observed, out of scope

`ProfileGroupV2FunctionInputSchema` requires an explicit `workflowRevision` for `kind: 'workflow'`, but the catalog never exposes one for manifest actions and the service accepts `null` unless `requireWorkflowRevision` is set (`profile-groups.ts:319-337`). Consequence: a group bound to a manifest **workflow** action cannot build a contract-valid save body from the UI. Source partitioning is kind-independent, so the save-boundary regression test uses the endpoint form of the same action and records this contract/service mismatch for the owners. Not fixed here.

---

## 4. Files changed

| Path (root = `du-rework/`) | Lines | Change |
| :--- | ---: | :--- |
| `orchestrator/apps/admin-web/src/features/profiles/profile-group-state.ts` | 647 | +PC-R07 partition/notice/filter helpers; filtered validation; filtered save body |
| `orchestrator/apps/admin-web/src/features/profiles/profile-group-editor.tsx` | 1 096 | renders filtered schemas, notices, misplaced-entry warnings; filtered lock wiring |
| `orchestrator/services/orchestrator/tests/aweb10-profile-group-r07-parameter-source.test.ts` | 314 | **new** — 11 regression cases (partition, catalog parse, save boundary, validation, wiring guard) |

Lease compliance: only the two leased admin-web files and a new test were touched. **No backend service module, contract, migration or other package file was modified.**

---

## 5. Regression tests

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb10-profile-group-r07-parameter-source.test.ts`

| # | Case | Asserts |
| :--- | :--- | :--- |
| 1 | opt-in manifest (example-review v3 shape) | `enableReasoning` ∈ request defaults, ∉ profile settings; `text` (caller input) ∈ neither; `required` filtered on both sides |
| 2 | legacy manifest (no capability) | profile settings keeps all three properties; request defaults schema `null`; capability notice mentions `parameterResolution` |
| 3 | opt-in with zero declared defaults | explicit empty message; undeclared properties become profile settings |
| 4 | source defaults | undeclared ⇒ `profileSettings`; declared map is authoritative; `undefined` capability ⇒ `profileSettings` |
| 5 | catalog parser (discovery) | the editor's real parse path preserves `parameterResolution` when present and leaves it `undefined` when absent |
| 6 | save boundary (opt-in) | payload `policy.parameters` excludes `enableReasoning`; `requestDefaults` only `enableReasoning`; stale `text` dropped; **lock metadata preserved** |
| 7 | save boundary (legacy) | stored entries pass through untouched (inert values not destroyed) |
| 8 | helper matrices | misplaced entries both directions; no guessing for v1; v1 filter returns the same map |
| 9 | validation (opt-in) | a `required` requestDefaults property is not demanded as a profile setting |
| 10 | validation still blocks | a genuinely missing profile setting blocks the save; the requestDefaults-only property does not appear in the error |
| 11 | editor wiring guard | editor calls the partition, renders `profileSettingsSchema`/`requestDefaultsSchema`, shows both notices, and no longer renders the raw `inputSchema` |

### 5.1 Mutation check (tests are not vacuous)

1. Backed up `profile-group-state.ts`; changed `const declared = resolution !== undefined;` to `const declared = false;` (capability ignored — the pre-fix behaviour).
2. Guarded run:
   ```
   × opt-in manifest: enableReasoning is requestDefaults and never a profile setting
   × legacy manifest: profile settings keeps the whole schema and request defaults are unavailable
   × opt-in manifest with no declared requestDefaults renders the explicit empty message
   × drops wrong-source entries from the payload instead of re-saving them
   Test Suites: 1 failed, 1 total
   Tests:       4 failed, 7 passed, 11 total
   ```
3. Restored from backup; `Get-FileHash` SHA-256 equals the pre-mutation hash → `RESTORED=True`; suite green again (§6).

---

## 6. Verification (actually run)

| # | Command | Literal result | Exit |
| :--- | :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`apps/admin-web`) | no diagnostics | **0** |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`services/orchestrator`) | no diagnostics | **0** |
| 3 | `node node_modules/vite/bin/vite.js build` (`apps/admin-web`) | `dist/assets/index-D62uAjTZ.js 2,368.60 kB`; `✓ built in 6.55s` | **0** |
| 4 | jest `tests/aweb10-profile-group-r07-parameter-source.test.ts` | `Test Suites: 1 passed` / `Tests: 11 passed, 11 total` | **0** |
| 5 | jest, all five `aweb10` suites (R07 + R06 + state + BFF groups + BFF workbench) | `Test Suites: 5 passed` / `Tests: 62 passed, 62 total` (11 + 11 + 16 + 14 + 10) | **0** |
| 6 | `tsc --noEmit` in `tests/browser` | new/changed files contribute **0** diagnostics; 18 pre-existing errors elsewhere (`harness.ts`, `p745-ui-keys.spec.ts`, `@/` aliases) | 1 (pre-existing) |
| 7 | full offline suite (`jest.unit.config.cjs`) | see §6.1 | see §6.1 |

### 6.1 Full offline run — still blocked by the concurrent PC-R01 transition

```
Test Suites: 15 failed, 21 skipped, 379 passed, 394 of 415 total
Tests:       73 failed, 229 skipped, 6207 passed, 6509 total
```

- **Not PC-R07-UI:** none of the 15 failing suites imports `apps/admin-web`; 11 of them explicitly reference `key_mode` / `LEGACY_STANDALONE` / `UNMANAGED_LEGACY`. The representative failure is PC-R01's new admission denial reached from a fixture that mints a key without a mode:
  `HttpError: this API key has no assigned profile and is not an unmanaged legacy key` at `src/modules/operations/submission.ts:1520` (`tests/public-upload-encryption-gateway.test.ts:707`).
- The set is shrinking as that lane lands fixture updates (21 suites → 15 between the PC-R06 and PC-R07-UI runs), and `runtime-retry-admission` now passes.
- `tests/rfx10-seed-gate.test.ts` remains the pre-existing PC-04 seed-gate failure recorded in `receipt-pc08-ui.md` §4.5.
- Instability evidence: one batch run of the five `aweb10` suites reported two **suite-level** failures (0 tests) while that lane was mid-write; an immediate rerun compiled clean and passed 62/62, and `apps/admin-web` typechecked at 0. This is the same ts-jest-vs-concurrent-source-write artefact, not a PC-R07-UI regression.
- **PC-R07-UI-relevant result:** 62/62 tests green across the five `aweb10` suites. The coordinator should re-run the full offline suite after PC-R01 settles; this receipt makes no claim about it.

---

## 7. Scope boundary, limitations, follow-ups

- **UI-only change.** No backend, contract or migration edit; the server's resolution semantics are untouched.
- **Catalog dependency (§3)** must land for opt-in manifests to become editable in the UI. Until then the new fallback (notice, controls omitted) is the safe behaviour and no wrong-source write is possible from this pane.
- **No lock/unlock UX change.** PC-R06's read-only lock indicator remains; this packet only filters which schema feeds each pane.
- **Stored wrong-source values are dropped on the next save when the capability is declared**, and the UI names them beforehand. This is deliberate ("saves each parameter only to its declared effective source") and limited to values the resolver already ignored; v1 manifests keep everything.
- **Browser spec not run.** No `AWEB01B_*` harness in this session; the changed selectors are the request-default field labels, which the existing PC-08 spec only asserts for profile settings.
- **Evidence level.** Source and offline test evidence only; no claim about a built image, deployed container or real tenant data.
