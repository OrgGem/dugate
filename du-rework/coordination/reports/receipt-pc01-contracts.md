# Receipt — PC-01 Execute (V2 contracts applied)

| Field | Value |
| :--- | :--- |
| Packet | `PC-01-EXECUTE` — *Apply V2 Contracts & Tests* |
| Worker | `dsh_2` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Timestamp | 2026-10-21 01:53 +07:00 |
| Status | **COMPLETE** — typecheck 0, new suite 36/36, full suite 36/622, build 0 |
| Baseline before | 35 suites / 586 tests (measured in the PREP packet, same toolchain) |
| Design source | [`prep-pc01-contracts-spec.md`](prep-pc01-contracts-spec.md) (Appendix A = the 36 cases) |
| Lease respected | Only the listed contracts paths were written; no other lane touched |

**Tóm tắt (VI).** Đã áp các Zod schema V2 đã kiểm chứng 36/36 vào `profile-groups.ts`, `manifest.ts`, `admin-workbench.ts`, `index.ts`; tạo `tests/profile-groups-v2.test.ts` (36 case, import qua barrel). Typecheck exit 0, suite mới 36/36, toàn bộ contracts 36 suite / 622 test pass, build (emit `dist`) exit 0. Một sai lệch bắt buộc so với dispatch: **`public-api.ts` không đổi** vì thêm cạnh `public-api -> profile-groups` tạo cycle chết ở import-time; 2 DTO preview/submit được đặt trong `profile-groups.ts` và vẫn export đầy đủ qua barrel (§4).

---

## 1. Files delivered

| File | Δ | Content |
| :--- | :--- | :--- |
| `orchestrator/packages/contracts/src/profile-groups.ts` | +479 (618 lines) | V2 primitives (`authMode`/`authAuthority`/`accessVersion`/digest pin+read), grant DTOs (grant / revoked tombstone / issue / revoke in+out), `requestDefaults` (+ read projection, credential refusal), v2 function/business/save, v2 read DTO + list, rollback alias, selector, resolution refs + effective preview + preview response, `ResolutionFingerprintPartsV2` + `computeResolutionFingerprint`, public preview/submit **request** DTOs, `PROFILE_GROUP_PROBLEM_CODES` |
| `src/manifest.ts` | +31 (145 lines) | `ParameterResolutionSourceSchema`, `ParameterResolutionCapabilitySchema` (`.strict()`, `version: 2` literal), optional `parameterResolution` on `ActionManifestSchema` (schema left non-strict on purpose) |
| `src/admin-workbench.ts` | +68 (132 lines) | Workbench v2 selector (required `tenantId`/`apiKeyId`, free-string `businessId`, `endpointSlug: null` allowed), preview/submit requests, preview response (echoes `apiKeyId`), submit response = existing `AdminWorkbenchOperationAcceptedSchema` |
| `src/index.ts` | +48 (115 lines) | Explicit value-export list for the whole V2 surface (browser-bundler reason documented at `ConnectorRecipeSchema`/`isTenantUuid`), grant/capability/workbench groups included |
| `src/public-api.ts` | **0** (819 lines, unmodified) | See §4.1 — deliberate deviation |
| `tests/profile-groups-v2.test.ts` | new (716 lines) | 36 contract cases (A1..I4), imported **from `../src`** so the file also proves the barrel surface |

```text
git diff --stat -- du-rework/orchestrator/packages/contracts
 admin-workbench.ts |  70 ++-
 index.ts           |  48 +++
 manifest.ts        |  31 ++
 profile-groups.ts  | 479 +++++++++++++++++++++
 4 files changed, 627 insertions(+), 1 deletion(-)
?? tests/profile-groups-v2.test.ts
```

The single deletion is the `admin-workbench.ts` import line (`OperationViewSchema` → `OperationViewSchema, SubmissionSchema`). Diff hunks in `profile-groups.ts` are **only** import additions (4 lines) plus one 475-line append at EOF — no v1 declaration was touched.

## 2. Verification (actually run, in `orchestrator/packages/contracts`)

| # | Command | Result |
| :--- | :--- | :--- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0**, no diagnostics |
| 2 | `node node_modules/jest/bin/jest.js --runInBand tests/profile-groups-v2.test.ts` | **exit 0** — `Test Suites: 1 passed`, `Tests: 36 passed, 36 total`, 2.2 s |
| 3 | `node node_modules/jest/bin/jest.js --runInBand` (whole package) | **exit 0** — `Test Suites: 36 passed, 36 total`, `Tests: 622 passed, 622 total`, 8.4 s |
| 4 | `node node_modules/typescript/bin/tsc -p tsconfig.json` (emit `dist`) | **exit 0** — downstream `@du/*` consumers can resolve the V2 surface |
| 5 | `node %TEMP%\pc01-barrel-check.js` (requires `dist`, asserts names) | **exit 0** — 37/37 V2 names present, 4/4 v1 group names still present, `computeResolutionFingerprint` is a function, capability schema is a parser |

Regression arithmetic: `586 + 36 = 622` tests, `35 + 1 = 36` suites — exactly the additive delta, no existing case changed status.

## 3. Coordinator decisions as applied

| Decision | Applied |
| :--- | :--- |
| **D1** `businesses.min(1)` | `ProfileGroupV2SaveSchema.businesses` = `z.array(...).min(1).max(64)`; `functions` = `.min(1).max(256)` |
| **D2** credential keys in `requestDefaults` fail closed | `ProfileGroupRequestDefaultsSchema` reuses `findSecretParameterKeys` → `superRefine` issue on the offending key (case D1/D2/D3 pin it; `maxTokens`/`passwordPolicy`/`tokenizer` still parse) |
| **D5** DTO naming per draft | `ProfileGroupV2Schema` / `ProfileGroupV2SaveSchema` / `ProfileGroupV2FunctionInputSchema` / `ProfileGroupV2BusinessInputSchema` / `ProfileGroupV2ListSchema` / `ProfileGroupV2RollbackSchema` — no `…ResponseSchema` duplicate |
| **D7/D8** Workbench `businessId` free, `endpointSlug` nullable | `AdminWorkbenchProfileSelectorV2Schema.businessId = z.string().min(1).max(128)`; `endpointSlug: z.string().min(1).max(128).nullable().optional()` (v1 meaning of `null` preserved in the doc comment) |
| **D9** `expectedAccessVersion` via header **and** body | Body form shipped: `ProfileGroupKeyRevokeInputSchema { expectedAccessVersion }`; issue body is `{ note? }` only, so the access version arrives as `If-Match` (route contract lives in PC-03; the DTOs do not forbid either transport). Acceptance of `"7"` / `7` is a PC-03 route rule — recorded here so it is not lost |

## 4. Deviations from the dispatch (3, all deliberate)

### 4.1 `public-api.ts` is unchanged — a module cycle made the instructed placement fatal

The two public v2 request DTOs were drafted in `public-api.ts` (report §2.5). Applying that literally failed at **import time**, not at typecheck:

```text
src/profile-groups.ts:66  targetRevision: ProfileGroupRevisionSchema.min(1)
TypeError: Cannot read properties of undefined (reading 'min')
  at src/profile-groups.ts:66
  at src/public-api.ts:3        <- new edge public-api -> profile-groups
  at src/profile-callback.ts:24
  at src/profile-policy.ts:33
  at src/index.ts:14
```

The package already contains the cycle `profile-policy.ts:33 → profile-callback.ts:24 → public-api.ts`, and `profile-callback.ts:24` imports `WebhookEventTypes` from `public-api`. Adding `public-api → profile-groups → profile-policy` closes the loop: `profile-groups` is evaluated while `profile-policy` is still mid-initialisation, so `ProfileRevisionSchema` is `undefined` and the module throws before any test runs.

Both remaining repair options were out of lease (`profile-policy.ts`, `profile-callback.ts`), so the fix was to keep the import edge out of `public-api.ts`:

- `ProfileGroupPreviewV2RequestSchema` and `ProfileGroupSubmitV2RequestSchema` now live in `profile-groups.ts` (same section as the selector they extend, with a doc comment explaining the cycle).
- They are still exported from the package barrel (`index.ts`), so consumers and the Admin BFF see no difference; nothing in the contract shape changed — the 36 cases are the §Appendix-A cases.
- `public-api.ts` is byte-identical to HEAD (verified by `git status`).

**Coordinator action:** PC-03/PC-05/PC-08 must import these two DTOs from `@du/contracts` (barrel) or `./profile-groups`, **not** from `public-api`. If the layout must match the plan literally, the unblocking change is a separate packet that removes `profile-callback → public-api` (e.g. move `WebhookEventTypes` to its own leaf module) — that file is outside the PC-01 lease.

### 4.2 Test `I2` expectation inverted (PREP → POST)

`I2` in the PREP Appendix A asserted the *pre-change* behaviour ("an undeclared capability is stripped, digest unchanged"). Once `ActionManifestSchema.parameterResolution` exists, the field is no longer stripped, so the same assertion would fail — correctly. `I2` now asserts the implementation:

- `result.manifest.actions[0].parameterResolution` deep-equals the declared capability, and
- the digest **differs** from the pinned v1 digest (so PC-06 must register a new manifest version instead of re-hashing one in place).

This is report §4.4 item 3 ("capability changes the digest only when declared"), not a relaxation. Case count stays 36, IDs unchanged. The v1 freeze pin `I1` still passes with the exact PREP constant `sha256:eb89c236…0533`.

### 4.3 `index.ts` got an explicit export list

Instruction #2 asked for a full export of the new schema/type surface. `export *` already covered it, but the file's own bundler note (Rollup cannot see through `__exportStar`) makes the explicit value list the repo's convention — same treatment as `ConnectorRecipeSchema` and `isTenantUuid`. Verified at runtime against `dist` (§2 row 5): 37/37 names present.

## 5. Contract-freeze evidence

- No v1 declaration edited: `profile-groups.ts` diff hunks are 4 import additions + one EOF append; `manifest.ts` adds a new block plus one optional field; `admin-workbench.ts` adds an import symbol and an EOF append.
- v1 strictness intact: the new suite proves `ProfileGroupSaveSchema` still rejects a body without `apiKey` (A1) while `ProfileGroupV2SaveSchema` rejects a body **with** one (B2) — neither generation can be silently accepted by the other.
- v1 manifest digest frozen by golden pin (I1), measured pre-change and unchanged post-change.
- `ProfileEndpointPolicySchema` / `ProfileEndpointPolicyReadSchema` untouched; `runtime.ts` untouched.

## 6. Environment and evidence boundary

- Toolchain actually used: **Node v22.23.3**, TypeScript 5.9.3, zod 3.25.76, package-local `jest`/`tsc` binaries. The workspace declares Node `>=24.21.0 <25` and pnpm 10.18.3, so the `pnpm --filter @du/contracts …` forms of the same four checks have **not** been run here; the underlying commands are the ones in §2 and must be re-run under the pinned toolchain for DoD sign-off.
- `dist/` is git-ignored (`orchestrator/.gitignore:2`) but was built locally so downstream service tests resolve the new exports; nothing from `dist/` is committed.
- Scope is contract-level only. No grant/access-version behaviour, no CAS, no HTTP route, no PostgreSQL was exercised — that is PC-02/PC-03/PC-04/PC-05 and the PC-09 harnesses.
- Uncommitted by design: 4 modified files + 1 new test file. No commit, no stage, no branch operation, no other lane touched.

## 7. Suggested next packets

1. **PC-02** (migration) can start immediately: `ProfileGroupAuthAuthoritySchema` / `ProfileGroupAccessVersionSchema` are frozen and exported.
2. **PC-03** must consume the request DTOs from the barrel (§4.1) and implement the `If-Match`/`"7"|7` → 412 rule plus `PROFILE_GROUP_PROBLEM_CODES` (`PROFILE_GROUP_V2_REQUIRED`, `PROFILE_CHANGED`, `PROFILE_GROUP_UNAUTHORIZED`).
3. **PC-05** owns the semantic validation of `parameterResolution.fields` (report §6 D12) and the single fingerprint derivation (`computeResolutionFingerprint`) — do not re-implement it.
4. If the coordinator wants the literal file layout of report §2.5, schedule the `profile-callback → public-api` decoupling separately (§4.1).
