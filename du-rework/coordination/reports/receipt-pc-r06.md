# Receipt — PC-R06 (Preserve locks during value edits)

| Field | Value |
| :--- | :--- |
| Finding | `PC-R06` (P2) — *Editing request defaults removes lock metadata* |
| Dispatch | [`du-rework/coordination/dispatch-specs/FOLLOWUP-PC-R06-dispatch.txt`](../dispatch-specs/FOLLOWUP-PC-R06-dispatch.txt) |
| Plan row | [`PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) §"PC-R06": *"Editing a value preserves its `isLocked` state and never silently enables client override."* |
| Worker | DeepSeek Worker 0 (Frontend & Admin Workbench Specialist) — `deepseek-v4.1-flash` |
| Status | **COMPLETE (source + tests).** Defect fixed at both parameter updaters; 11-case regression suite green; mutation check proves the suite fails on the defect; typechecks and bundle build pass. |
| Evidence level | **Source and offline test level only.** No PostgreSQL/Redis, no container, no browser run. The full offline suite was contaminated by a concurrent PC-R01 rewrite and is reported as such (§5.1); no claim is made about it. |
| Date | 2026-10-21 (host clock at run time) |

**Tóm tắt (VI).** `updateRequestDefault` ghi đè cả entry bằng `{ value }`, làm mất `isLocked`. Vì server phân giải khóa theo chuỗi `explicit isLocked ?? schema.defaultLocked ?? false`, việc mất `isLocked: true` **âm thầm mở khóa** trường (client override trái phép), còn mất `isLocked: false` lại **âm thầm khóa lại** trường mà operator đã cố ý mở (schema `defaultLocked: true` quay lại áp dụng).

Sửa: thêm helper thuần trong `profile-group-state.ts` — `withParameterValue` / `setParameterValue` — chỉ thay `value`, giữ nguyên toàn bộ metadata (kể cả trạng thái **không có** `isLocked`, để `defaultLocked` tiếp tục áp dụng), không ép giá trị bằng truthiness (`null`/`false`/`0`/`''` được giữ nguyên). Cả hai updater (`requestDefaults` **và** `policy.parameters`) chuyển sang helper này. Thêm chỉ báo khóa read-only dưới mỗi trường request default (effective lock theo đúng chuỗi của server).

Regression: 11 case mới, gồm load → edit → save payload → parse lại bằng contract, và một **source guard** đảm bảo editor thực sự gọi helper (app không có Jest runner). Mutation check: đưa lại đúng lỗi `{ value }` → 2 test guard fail; phục hồi file → hash khớp byte-for-byte, suite xanh lại.

---

## 1. Defect analysis

### 1.1 The defect (pre-fix)

`apps/admin-web/src/features/profiles/profile-group-editor.tsx` (PC-08 build):

```ts
function updateRequestDefault(member, functionId, parameter, value): void {
  updateFunctionDraft(member, functionId, (current) => ({
    ...current,
    requestDefaults: { ...current.requestDefaults, [parameter]: { value } }, // ← drops isLocked
  }));
}
```

### 1.2 Why it is a real unlock (server contract)

- The effective lock is `explicit isLocked ?? schema.defaultLocked ?? false` — `orchestrator/services/orchestrator/src/modules/profiles/policy.ts:524-535` (`normalizeConfiguredLock`), and the same chain is documented on `ProfileParameterValueSchema` (`packages/contracts/src/profile-policy.ts:74-84`).
- `false` is a **real value**: only `undefined` falls through to the schema annotation.
- Therefore dropping `isLocked: true` on save makes the field client-overridable at the next preview/submit — the exact "silently enables client override" outcome the plan forbids.
- Symmetrically, dropping `isLocked: false` re-applies a manifest `defaultLocked: true`, silently locking a field the operator had deliberately opened.

### 1.3 Adjacent defect found during the audit (same class, opposite direction)

`updatePolicyParameter` (the function the dispatch listed as correct) did:

```ts
parameters: { ...current.parameters, [parameter]: { value, isLocked: current.parameters[parameter]?.isLocked ?? false } }
```

That *invents* `isLocked: false` for every edited profile-settings parameter. For a manifest property with `defaultLocked: true`, a value edit silently **unlocks** it. The same helper now fixes this path too (`?? false` removed), so both sources obey one rule: an edit changes only the value.

---

## 2. Fix

### 2.1 New pure helpers — `profile-group-state.ts`

```ts
export function schemaDeclaredLock(schema, parameter): boolean | undefined;   // property.defaultLocked
export function effectiveParameterLock(entry, schemaDefaultLocked): boolean;  // explicit ?? schema ?? false
export type ParameterLockDisplay = 'locked' | 'unlocked-explicitly' | 'locked-by-schema' | 'unlocked';
export function parameterLockDisplay(entry, schemaDefaultLocked): ParameterLockDisplay;

export function withParameterValue(existing, value): ProfileParameterValue {
  const next: ProfileParameterValue = { ...(existing ?? {}), value };
  if (next.isLocked === undefined) delete next.isLocked;   // absent stays absent
  return next;
}
export function setParameterValue(entries, parameter, value) { … }            // immutable map update
```

Properties this guarantees:

| Input entry | After a value edit | Why it matters |
| :--- | :--- | :--- |
| `{ value, isLocked: true }` | `{ value: new, isLocked: true }` | never silently unlocks |
| `{ value, isLocked: false }` | `{ value: new, isLocked: false }` | deliberate unlock survives schema `defaultLocked: true` |
| `{ value }` | `{ value: new }` (no `isLocked` key) | schema `defaultLocked` keeps applying; no fabricated `false` |
| `{ value: null/false/0/'' }` | value preserved as-is | absence is decided by key presence, never truthiness |
| future per-field metadata | spread and preserved | forward-compatible within the frozen strict schema |

### 2.2 Editor wiring — `profile-group-editor.tsx`

```ts
parameters:      setParameterValue(current.parameters, parameter, value),
requestDefaults: setParameterValue(current.requestDefaults, parameter, value),
```

Both updaters now delegate; no `{ value }` replacement remains anywhere in `features/` (grep clean).

### 2.3 Operator visibility — `profile-group-schema-fields.tsx`

Request-default fields render a read-only lock line (`data-lock-state`) derived from the stored entry plus `schemaDeclaredLock`:

- `Locked: clients cannot override this value.` (explicit `true`)
- `Explicitly unlocked: overrides a schema default lock.` (explicit `false`)
- `Locked by the schema default; no explicit override is stored.` (absent + `defaultLocked: true`)
- `Unlocked.`

No lock **toggle** was added. The dispatch makes one optional ("if a dedicated lock toggle exists or is added"); adding an unlock control is a security-sensitive operation that deserves its own decision, and PC-R06's requirement is that a *value* edit never changes the lock — which a read-only indicator plus the preserving merge satisfies. An explicit unlock control is recorded as a follow-up (§6).

The renderer also no longer lets a schema default masquerade as a stored value: an entry that exists wins even when its value is `null`/`false`/`0`/`''`; only a **missing** entry falls back to the schema default for display.

---

## 3. Files changed

| Path (root = `du-rework/`) | Lines | Change |
| :--- | ---: | :--- |
| `orchestrator/apps/admin-web/src/features/profiles/profile-group-state.ts` | 494 | +`schemaDeclaredLock`, `effectiveParameterLock`, `parameterLockDisplay`, `withParameterValue`, `setParameterValue` |
| `orchestrator/apps/admin-web/src/features/profiles/profile-group-editor.tsx` | 1 051 | both updaters delegate to the helper; request-default `lockMeta` wiring; section copy |
| `orchestrator/apps/admin-web/src/features/profiles/profile-group-schema-fields.tsx` | 242 | stored-value precedence; read-only lock indicator; `lockMeta` prop |
| `orchestrator/services/orchestrator/tests/aweb10-profile-group-r06-lock-preservation.test.ts` | 290 | **new** — 11 regression cases (8 state + 3 wiring guards) |

Lease compliance: only the three leased admin-web files (the third explicitly "if relevant" — it renders the lock) and a new test matching the leased test pattern were touched. **No backend module, contract, migration or service file was modified.**

---

## 4. Regression tests

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb10-profile-group-r06-lock-preservation.test.ts`

| # | Case | Asserts |
| :--- | :--- | :--- |
| 1 | load every entry byte-for-byte | `isLocked:true`, explicit `false`, absent key, `null`, `false`, `0` all preserved |
| 2 | edit ONLY a locked default's value | entry stays `{value: new, isLocked:true}`; save body parses with `ProfileGroupV2SaveSchema` and still carries `true` |
| 3 | edit an entry with no explicit lock | no `isLocked` key is written; `defaultLocked:true` still resolves to locked after the edit |
| 4 | edit an explicit `false` | stays `false`; overrides schema `defaultLocked:true`; save payload keeps `false` |
| 5 | edit another field, then save | `null` / `false` / `0` survive in the payload and after contract parse |
| 6 | re-write `null`/`false`/`0` as the value | they remain values (never replaced by defaults or truthiness) |
| 7 | effective-lock chain | matches `explicit ?? schema.defaultLocked ?? false`, including `false` override and non-boolean annotation rejection |
| 8 | empty draft | starts with `{}` request defaults (nothing fabricated) |
| 9 | wiring guard: helper usage | editor source contains `requestDefaults: setParameterValue(…` and `parameters: setParameterValue(…` |
| 10 | wiring guard: defect pattern absent | no `{ value }` replacement, no `isLocked: current.requestDefaults`, no `?? false` fabrication |
| 11 | wiring guard: visibility | editor passes `lockMeta`/`schemaDeclaredLock`; fields render `data-lock-state` |

### 4.1 Mutation check (the tests are not vacuous)

1. Backed up `profile-group-editor.tsx`, re-introduced the exact defect (`requestDefaults: { ...current.requestDefaults, [parameter]: { value } }`), ran the guard group:
   ```
   × request defaults are edited through the metadata-preserving helper
   × the defect pattern ({ value } replacement) is gone from both updaters
   √ request-default fields expose the effective lock state to the operator
   Test Suites: 1 failed, 1 total
   Tests:       2 failed, 8 skipped, 1 passed, 11 total
   ```
2. Restored the file from the backup and verified `Get-FileHash` SHA-256 equals the pre-mutation hash → `RESTORED=True`.
3. Re-ran the suite → 11/11 green (see §5).

This is the strongest available proof without a React test runner: the suite fails on the defect and passes on the fix.

---

## 5. Verification (actually run)

| # | Command | Literal result | Exit |
| :--- | :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`apps/admin-web`) | no diagnostics | **0** |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`services/orchestrator`) | no diagnostics | **0** |
| 3 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb10-profile-group-r06-lock-preservation.test.ts` | `Test Suites: 1 passed` / `Tests: 11 passed, 11 total` | **0** |
| 4 | same, `tests/aweb10-profile-group-r06-lock-preservation.test.ts tests/aweb10-profile-group-v2-state.test.ts` | `Test Suites: 2 passed` / `Tests: 27 passed, 27 total` (11 + 16) | **0** |
| 5 | `node node_modules/vite/bin/vite.js build` (`apps/admin-web`) | `dist/assets/index-CrXWeu60.js 2,365.63 kB`; `✓ built in 7.15s` | **0** |
| 6 | full offline suite (`jest.unit.config.cjs`, all suites) | see §5.1 | see §5.1 |

### 5.1 Full offline run — contaminated by a concurrent lane (not a PC-R06 signal)

The full `jest.unit.config.cjs` run executed while **another lane (PC-R01) was actively rewriting backend retry/submission/auth modules**, so its result is not usable as PC-R06 evidence:

```
Test Suites: 21 failed, 20 skipped, 371 passed, 392 of 412 total
Tests:       78 failed, 223 skipped, 6172 passed, 6473 total
```

- The tree changed underneath the run: `src/modules/operations/submission.ts` (09:09), `src/modules/operations/retry.ts` (09:13), `src/modules/profiles/profiles.ts` (09:18), `src/http/routes/api-key-auth.ts`, plus new `tests/pc-r01-key-mode-fallback.test.ts` and edits to several test files — all PC-R01, none in this packet's lease.
- Representative failure is a PC-R01 mock-fixture mismatch, not a UI assertion:
  `Unexpected retry SQL: SELECT status, key_mode FROM api_keys WHERE id=$1 FOR SHARE` at `tests/runtime-retry-admission.test.ts:66/105`.
- **Proof PC-R06 cannot be the cause:** **none of the 21 failing suites imports `apps/admin-web`** (`Select-String -Pattern 'apps/admin-web'` over the exact failing list → no hits). PC-R06 touched only three admin-web files plus a new test.
- The same full suite was green on the pre-PC-R01 baseline recorded in `receipt-pc08-ui.md` §5.1 (`389 passed / 1 failed`, only `rfx10-seed-gate`), and the new PC-R01 suite itself passes 15/15 when run alone — consistent with a mid-flight transition, not with a regression here.

**PC-R06-relevant result:** 27/27 tests green across the two `aweb10` suites (§5 rows 3–4). The coordinator should re-run the full offline suite after PC-R01 settles; this receipt makes no claim about it.

---

## 6. Scope boundary, limitations, follow-ups

- **UI-only fix.** The server's lock resolution is unchanged and correct; no contract or migration change was needed or made. Backend tests are therefore unaffected.
- **No toast/dialog unlock path.** A deliberate per-field "unlock" control for request defaults is **not** part of this fix (see §2.3). If the coordinator wants one, it needs its own dispatch: it changes authorization-adjacent UI and should be audited like a grant mutation.
- **PC-R07 remains open.** The editor still does not implement manifest `parameterResolution.fields` source mapping (which parameter belongs to `profileSettings` vs `requestDefaults`). PC-R06 preserves metadata for whichever source a value is edited in; it does not decide the source. Recorded so the two fixes are not conflated.
- **Browser spec not run.** `tests/browser/admin-web/profile-groups-v2.spec.ts` (PC-08) was not re-executed in this session (no `AWEB01B_*` harness). The lock indicator adds `data-lock-state`/`data-testid` hooks but does not alter any selector that spec asserts.
- **Evidence level.** Source and offline test evidence only; no claim about a built image, deployed container or real tenant data.

---

*End of receipt. Pre-fix code retained above for auditability; working tree contains only the fixed implementation, the new regression suite and this receipt.*
