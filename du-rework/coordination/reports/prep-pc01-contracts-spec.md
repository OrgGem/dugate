# PREP-PC-01 — Contracts pre-analysis & V2 schema design (READ-ONLY)

| Field | Value |
| :--- | :--- |
| Packet | `PREP-PC-01` — *Contracts Pre-Analysis & V2 Schema Design* |
| Dispatch | [`du-rework/coordination/dispatch-specs/PC-01-prep-dispatch.txt`](../dispatch-specs/PC-01-prep-dispatch.txt) |
| Master plan | [`du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) — §"DTO and route contract", §"Manifest parameter and lock resolution", PC-01 row |
| Worker | `dsh_2` (DeepSeek Harness, `deepseek-v4.1-flash`) — role *Contracts & Schema Specialist* |
| Mode | **READ-ONLY.** No file under `orchestrator/**` was created, modified or deleted. |
| Output | This report only, plus two evidence logs (§0.3). |
| Verdict for PC-01 | Draft is implementation-ready: strict-compiles, and a jest-shaped test file passes **36/36** against it. |

**Tóm tắt (VI).** Đã khảo sát cách `ProfileGroupSaveSchema` v1 bắt buộc `apiKey` (ở cả contract lẫn service), rồi thiết kế đầy đủ DTO v2 cho profile-group control plane: root save/read không có key selector, grant ledger tách rời với `accessVersion`, `requestDefaults`/`profileSettings` tách nguồn, `resolutionFingerprint` (SHA-256 có domain-separation) và capability `parameterResolution` trong manifest. Toàn bộ Zod draft trong report đã được biên dịch strict và kiểm chứng bằng 36 test case (xem §0.3, §4). Không sửa source. Có 12 quyết định cần coordinator chốt (§6).

---

## 0. Evidence boundary

### 0.1 What was inspected (read-only)

| Area | Files / anchors |
| :--- | :--- |
| Contracts (v1 group DTOs) | `orchestrator/packages/contracts/src/profile-groups.ts` (whole file, 139 lines) |
| Contracts (policy / parameter primitives) | `profile-policy.ts` 79-151, 316-369, 622-639 |
| Contracts (manifest) | `manifest.ts` 30-71; `manifest-validator.ts` 14-34, 46-118 |
| Contracts (runtime) | `runtime.ts` 124-213 |
| Contracts (public API / operations) | `public-api.ts` 632-745, 806-819; `operations.ts` 289-312 |
| Contracts (workbench) | `admin-workbench.ts` 25-63 |
| Contracts (hashing / key lifecycle precedent) | `hashing.ts` 23-52, 84-104; `parity.ts` 58-106 |
| Contracts (barrel) | `index.ts` (full) |
| Orchestrator service (current coupling) | `modules/profiles/profile-groups.ts` 321-365, 368-416, 628-747; `http/routes/admin-profile-groups.ts` 84-157 |
| Migration | `services/orchestrator/migrations/0067_profile_groups.sql:21` |
| Plan / packets | master plan §"Current implementation seams", §"Settled data and authorization model", §"DTO and route contract", §"Manifest parameter and lock resolution", PC-01 row; `PC-01-dispatch.txt`; task ledger |

### 0.2 What was *not* done

- No source edit, no new file under `orchestrator/`, no `pnpm install`, no migration.
- The PC-01 acceptance commands were **not** executed as written, because this machine runs **Node v22.23.3** while `orchestrator/package.json` declares `>=24.21.0 <25`; the `pnpm` on `PATH` is a bundled shim (`C:\Users\Gem\.local\share\deepseek-cli\...`), not the workspace-pinned 10.18.3. The implementer must re-run the DoD commands under the pinned toolchain (§7).
- No claim about built images, running containers, or deployed behaviour.

### 0.3 Verification actually executed

All of it ran against a **throwaway copy** of `packages/contracts/src` under `%TEMP%\pc01-verify` (byte copy + the four draft modules + harness). The repository tree was never written to.

| # | Command (in `%TEMP%\pc01-verify`) | Result |
| :--- | :--- | :--- |
| 0 | `.\node_modules\.bin\jest.CMD --runInBand` (package-local jest, **in repo**, baseline) | **35 suites / 586 tests passed**, exit 0 → `reports/prep-pc01-baseline-contracts-tests.log` |
| 0b | `node <contracts>/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (**in repo**, baseline) | exit 0 (clean) |
| 1 | `tsc -p tsconfig.json` over copied `src` + drafts + harness | **exit 0, no diagnostics** (same `strict` + `noUncheckedIndexedAccess` as `orchestrator/tsconfig.base.json`, zod 3.25.76) |
| 2 | `node out/check.js` (standalone harness) | **36/36 checks passed**, exit 0 |
| 3 | `jest --config jest.config.cjs --runInBand` on the drafted `tests/profile-groups-v2.test.ts` | **1 suite / 36 tests passed**, exit 0 |

Evidence log: [`prep-pc01-draft-verification.log`](prep-pc01-draft-verification.log). Baseline log: [`prep-pc01-baseline-contracts-tests.log`](prep-pc01-baseline-contracts-tests.log).

> Node here is the same v22.23.3 for all four runs, so this is a *consistent* but non-canonical toolchain. It proves the schemas typecheck and behave as specified; it does not prove the Node-24 DoD run.

### 0.4 Read-only proof

```text
git status --porcelain -- du-rework/orchestrator/packages/contracts
(no output — 0 modified, 0 untracked)
```

Reproduction note for this harness: it exports `GIT_CONFIG_COUNT=2` with `GIT_CONFIG_VALUE_0/1` but no matching `GIT_CONFIG_KEY_*`, so every `git` invocation aborts with *"missing config key GIT_CONFIG_KEY_0"* until those variables are cleared in the child shell (`Get-ChildItem Env: | Where-Object Name -like 'GIT_*' | ForEach-Object { Remove-Item ("Env:" + $_.Name) }`). The empty `git status` above was taken after that clear, so it is a real result, not a silent failure.

---

## 1. Current v1 state: exactly how `apiKey` is mandatory today

### 1.1 Contract facts

| # | Fact | Anchor |
| :--- | :--- | :--- |
| C1 | `ProfileGroupApiKeyRefSchema` = `{ apiKeyId: uuid }`, `.strict()` | `profile-groups.ts:18` |
| C2 | `ProfileGroupSaveSchema.apiKey` is **required** — no `.optional()`, no default, no union | `profile-groups.ts:51-57` (field at `:54`) |
| C3 | The whole save object is `.strict()` → sending a v2 body to the v1 route is a hard 422, never silently accepted | `profile-groups.ts:57` |
| C4 | `expectedRevision` is required and `ProfileRevisionSchema` allows `0` (create) | `profile-groups.ts:55`; `profile-policy.ts:58-62` |
| C5 | `businesses` 1..64, `functions` 1..256, `kind` ∈ {endpoint, workflow} | `profile-groups.ts:47,56,21` |
| C6 | Kind refinements: endpoint ⇒ `endpointSlug` required; workflow ⇒ `endpointSlug` forbidden (`workflowRevision` is *not* required in v1) | `profile-groups.ts:33-40` |
| C7 | Read DTO `ProfileGroupSchema.apiKey` is a **required object** `{apiKeyId, prefix, status}` | `profile-groups.ts:118-122` |
| C8 | There is **no** `requestDefaults` field anywhere in v1 group DTOs; `policy` is `ProfileEndpointPolicySchema` (write) / `ProfileEndpointPolicyReadSchema` (read) | `profile-groups.ts:31,100` |
| C9 | v1 function bindings carry `childProfileId` + `childRevision` + `enabled` + `policy` + `connectorBindings` | `profile-groups.ts:90-102` |
| C10 | The function catalog's `manifestDigest` is loose `min(1)` | `profile-groups.ts:135` |

### 1.2 Service facts — why the key is not merely a DTO detail

| # | Fact | Anchor (service) |
| :--- | :--- | :--- |
| S1 | `profile_group_revisions.api_key_id` is `uuid NOT NULL REFERENCES api_keys(id)` | `migrations/0067_profile_groups.sql:21` |
| S2 | Save loads the selected key (`loadSelectedKey`) and rejects a key outside the group tenant | `modules/profiles/profile-groups.ts:673-674` |
| S3 | Every child revision is **authored by that key** (`createChildRevision(..., key, ...)`) | `:701` |
| S4 | Save then **revokes every other ACTIVE `profile_api_keys` membership** on the member profiles (`state='REVOKED'`, `api_key_id<>key.id`) — the singular key becomes the only membership | `:722-729` |
| S5 | The config revision row stores `api_key_id` | `:735` |
| S6 | Read must *derive* the displayed key by intersecting ACTIVE child memberships; 0 or >1 candidates ⇒ **409 STATE_CONFLICT** | `:321-365` (`:356-364`) |
| S7 | Read projects `apiKey: {apiKeyId, prefix, status}` into the DTO | `:368-416` (`:411`) |
| S8 | Route parses the same `ProfileGroupSaveSchema` on POST and PUT | `http/routes/admin-profile-groups.ts:110,141` |

### 1.3 Why v1 must stay strict (and cannot be "relaxed" for v2)

1. **Read fails hard with zero grants.** S6 throws 409 when the intersection is empty — precisely the "zero active API keys" state the plan requires to be readable. Making `apiKey` optional in v1 would leave S6/S7 returning `undefined` where the DTO demands an object, i.e. a runtime 500 instead of a contract error.
2. **Save revokes memberships as a side effect of the key choice** (S4). If a v2 body (no key) were accepted by the v1 schema, the service would dereference `input.apiKey.apiKeyId` and fail *after* the group lock and selector locks — a worse failure mode than a 422 at the boundary.
3. **v1 is the compatibility surface.** The plan (master plan §"DTO and route contract") requires v1 bodies to keep parsing byte-for-byte, and v1 read projections to return `409 PROFILE_GROUP_V2_REQUIRED` when the singular key cannot be represented. Loosening `.strict()` or making `apiKey` optional would destroy the only signal that distinguishes a v1 writer from a v2 writer.

**Conclusion:** v1 schemas are frozen as-is (identical bytes), and v2 is a *parallel, additive* surface in the same module.

### 1.4 What v2 has to change at the contract boundary

| Requirement (plan) | Contract-boundary consequence |
| :--- | :--- |
| Group readable/editable with zero keys | No key field in v2 save; grants are a separate array in v2 read |
| Root grant ledger with tombstones | Dedicated grant DTOs + issue/revoke request/result DTOs; `accessVersion` CAS |
| Config revision ≠ access version | `revision` and `accessVersion` are separate, both server-owned |
| `profileSettings` vs `requestDefaults` | `requestDefaults` is a sibling of `policy`; `policy.parameters` remains `profileSettings` |
| Reproducible Workbench resolution | `resolutionFingerprint` on every v2 preview *response* and every v2 submit *request* |
| Parameter resolution is opt-in and declared | `parameterResolution` capability on the action manifest |

---

## 2. V2 contract design

### 2.1 Placement map (append-only inside the existing lease)

| Target file (PC-01 lease) | New exports |
| :--- | :--- |
| `src/profile-groups.ts` | `ProfileGroupAuthModeSchema`, `ProfileGroupAuthAuthoritySchema`, `ProfileGroupAccessVersionSchema`, `ProfileGroupDigestPinSchema`, `ProfileGroupDigestReadSchema`, `ResolutionFingerprintSchema`, `ProfileGroupKeyGrantSchema`, `ProfileGroupRevokedKeyGrantSchema`, `ProfileGroupKeyIssueInputSchema/ResultSchema`, `ProfileGroupKeyRevokeInputSchema/ResultSchema`, `ProfileGroupRequestDefaultsSchema(+Read)`, `ProfileGroupV2FunctionInputSchema`, `ProfileGroupV2BusinessInputSchema`, `ProfileGroupV2SaveSchema`, `ProfileGroupV2FunctionSchema`, `ProfileGroupV2BusinessSchema`, `ProfileGroupV2Schema`, `ProfileGroupV2ListSchema`, `ProfileGroupV2RollbackSchema`, `ProfileGroupFunctionSelectorV2Schema`, `ProfileGroupResolutionRefsV2Schema`, `ProfileGroupEffectiveParametersV2Schema`, `ProfileGroupPreviewV2ResponseSchema`, `ResolutionFingerprintPartsV2` + `computeResolutionFingerprint`, `PROFILE_GROUP_PROBLEM_CODES` |
| `src/manifest.ts` | `ParameterResolutionSourceSchema`, `ParameterResolutionCapabilitySchema`, and one optional field on `ActionManifestSchema` |
| `src/public-api.ts` | `ProfileGroupPreviewV2RequestSchema`, `ProfileGroupSubmitV2RequestSchema` |
| `src/admin-workbench.ts` | `AdminWorkbenchProfileSelectorV2Schema`, `AdminWorkbenchProfilePreviewV2RequestSchema`, `AdminWorkbenchProfileSubmitV2RequestSchema`, `AdminWorkbenchProfilePreviewV2ResponseSchema`, `AdminWorkbenchProfileSubmitV2ResponseSchema` |
| `src/runtime.ts` | **no change** (§2.7) |
| `src/index.ts` | **no change required** — `export * from './profile-groups'`, `'./public-api'`, `'./admin-workbench'`, `'./manifest'` already exist; all new identifiers are collision-free (37/37 names grepped over `src/*.ts`: 0 existing definitions, §2.8) |

### 2.2 Taxonomy and boundary decisions baked into the drafts

- **`authMode` is a required literal, not an optional default.** Every write states `'API_KEY'`. Widening the enum later is additive for clients that already send it; an optional field would silently become two ways to express the same intent.
- **`authAuthority` and `accessVersion` never appear on a write.** They are server state; `.strict()` turns any attempt into `unrecognized_keys`.
- **Two CAS domains.** `expectedRevision` guards configuration (`active_revision`), `expectedAccessVersion`/`If-Match` guards grants. A config save can never assert access state, and a grant mutation can never publish config.
- **No key field at any level of the v2 group body.** Grants are their own ledger and their own routes; the save body cannot name, infer or rotate a key.
- **`requestDefaults` is a sibling of `policy`, never inside it.** `ProfileEndpointPolicySchema` therefore stays byte-identical, and `policy.requestDefaults` is rejected as unrecognized → one source per field, no ambiguity for the resolver.
- **`requestDefaults` refuses credential-shaped keys at the DTO** (reusing `findSecretParameterKeys`, `profile-policy.ts:116-121`). `requestDefaults` becomes request input, so this is the same CR06-06 reasoning that already guards the admission snapshot (`ProfileSnapshotParametersSchema`). `policy.parameters` (profileSettings) keeps v1 parity: values are accepted verbatim and refused only when a snapshot leaves the process.
- **Reads reuse `ProfileEndpointPolicyReadSchema`.** A v2 read therefore cannot carry `fileUrlAuthConfig`; the v1 "write vs read are different schemas" rule (`profile-policy.ts:1-30`) is inherited rather than re-derived.
- **Digest pin: strict on write, lenient on read.** Writes must be `sha256:<64 lowercase hex>` (the only shape `hashManifest` produces, `manifest-validator.ts:31-34`); reads accept `min(1).max(256)` so a historical row can never turn a projection into a 500.
- **One save schema for POST and PUT.** Create is `expectedRevision: 0` + `tenantId` (route-enforced, exactly as v1 does at `admin-profile-groups.ts:111`); update is a full replacement plus CAS.
- **Rollback reuses the v1 body** (alias, not a copy) — identical semantics, and a test proves `accessVersion` is *not* accepted there.
- **Fingerprint is `sha256:<64 hex>`**, domain-separated, derived only from server refs + normalized request data (§3).

### 2.3 Draft — `src/profile-groups.ts` additions

Append below the existing v1 block. The draft is a standalone module so it imports symbols that are same-file locals in the real `profile-groups.ts`; merging it needs exactly three edits at the top of the file:

1. extend the existing `./profile-policy` import (`profile-groups.ts:2-6`) with `ProfileParameterValueSchema` and `findSecretParameterKeys`;
2. add `import { canonicalRequestHash, contentHash } from './hashing';` and `import type { Submission } from './operations';`;
3. delete the draft's four local imports (`./profile-groups` value import, `./profile-groups` type import) — `ProfileGroupConnectorPinSchema`, `ProfileGroupFunctionKindSchema`, `ProfileGroupFunctionKind`, `ProfileGroupRollbackSchema` already exist above.

```ts
import { z } from 'zod';
import type { Submission } from './operations';
import { canonicalRequestHash, contentHash } from './hashing';
import {
  ProfileEndpointPolicyReadSchema,
  ProfileEndpointPolicySchema,
  ProfileParameterValueSchema,
  ProfileRevisionSchema,
  findSecretParameterKeys,
} from './profile-policy';
import {
  ProfileGroupConnectorPinSchema,
  ProfileGroupFunctionKindSchema,
  ProfileGroupRollbackSchema,
} from './profile-groups';
import type { ProfileGroupFunctionKind } from './profile-groups';

/* ------------------------------------------------------------------ */
/* Shared primitives                                                  */
/* ------------------------------------------------------------------ */

export const ProfileGroupAuthModeSchema = z.enum(['API_KEY']);
export type ProfileGroupAuthMode = z.infer<typeof ProfileGroupAuthModeSchema>;

export const ProfileGroupAuthAuthoritySchema = z.enum(['CHILD_PROJECTION', 'GROUP_GRANT']);
export type ProfileGroupAuthAuthority = z.infer<typeof ProfileGroupAuthAuthoritySchema>;

export const ProfileGroupAccessVersionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
export type ProfileGroupAccessVersion = z.infer<typeof ProfileGroupAccessVersionSchema>;

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Write-side pin: the only digest shape the manifest registry produces. */
export const ProfileGroupDigestPinSchema = z
  .string()
  .regex(SHA256_DIGEST_RE, 'manifestDigest must be sha256:<64 lowercase hex>');

/** Read-side pin: historical rows are projected, never re-validated into a 500. */
export const ProfileGroupDigestReadSchema = z.string().min(1).max(256);

export const ResolutionFingerprintSchema = z
  .string()
  .regex(SHA256_DIGEST_RE, 'resolutionFingerprint must be sha256:<64 lowercase hex>');
export type ResolutionFingerprint = z.infer<typeof ResolutionFingerprintSchema>;

/* ------------------------------------------------------------------ */
/* Root key grants                                                    */
/* ------------------------------------------------------------------ */

export const ProfileGroupKeyGrantSchema = z
  .object({
    apiKeyId: z.string().uuid(),
    prefix: z.string().min(1).max(32),
    /** Projected verbatim from api_keys.status; never inferred. */
    status: z.string().min(1).max(32),
    grantedAt: z.string().datetime({ offset: true }),
    grantedBy: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ProfileGroupKeyGrant = z.infer<typeof ProfileGroupKeyGrantSchema>;

export const ProfileGroupRevokedKeyGrantSchema = ProfileGroupKeyGrantSchema.extend({
  revokedAt: z.string().datetime({ offset: true }),
  revokedBy: z.string().min(1).max(128).optional(),
}).strict();
export type ProfileGroupRevokedKeyGrant = z.infer<typeof ProfileGroupRevokedKeyGrantSchema>;

export const ProfileGroupKeyIssueInputSchema = z
  .object({
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export type ProfileGroupKeyIssueInput = z.infer<typeof ProfileGroupKeyIssueInputSchema>;

export const ProfileGroupKeyIssueResultSchema = z
  .object({
    grant: ProfileGroupKeyGrantSchema,
    /** Returned exactly once; the only place a raw group key ever appears. */
    secret: z.string().min(32).optional(),
    secretAvailable: z.boolean(),
  })
  .strict();
export type ProfileGroupKeyIssueResult = z.infer<typeof ProfileGroupKeyIssueResultSchema>;

export const ProfileGroupKeyRevokeInputSchema = z
  .object({
    expectedAccessVersion: ProfileGroupAccessVersionSchema,
  })
  .strict();
export type ProfileGroupKeyRevokeInput = z.infer<typeof ProfileGroupKeyRevokeInputSchema>;

export const ProfileGroupKeyRevokeResultSchema = z
  .object({
    grant: ProfileGroupRevokedKeyGrantSchema,
    /** Post-revoke access version, monotonic; config revisions never move it. */
    accessVersion: ProfileGroupAccessVersionSchema,
  })
  .strict();
export type ProfileGroupKeyRevokeResult = z.infer<typeof ProfileGroupKeyRevokeResultSchema>;

/* ------------------------------------------------------------------ */
/* requestDefaults: v2-only per-field request config                  */
/* ------------------------------------------------------------------ */

export const ProfileGroupRequestDefaultsSchema = z
  .record(z.string().min(1).max(128), ProfileParameterValueSchema)
  .superRefine((defaults, ctx) => {
    for (const key of findSecretParameterKeys(defaults)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message:
          'requestDefaults must not carry credentials; provider credentials belong to the connector',
      });
    }
  });
export type ProfileGroupRequestDefaults = z.infer<typeof ProfileGroupRequestDefaultsSchema>;

/** Read projection: never fail closed on a stored row the writer already accepted. */
export const ProfileGroupRequestDefaultsReadSchema = z.record(
  z.string().min(1).max(128),
  ProfileParameterValueSchema,
);

/* ------------------------------------------------------------------ */
/* Save: create (expectedRevision 0) and full replacement             */
/* ------------------------------------------------------------------ */

export const ProfileGroupV2FunctionInputSchema = z
  .object({
    kind: ProfileGroupFunctionKindSchema,
    functionId: z.string().min(1).max(256),
    action: z.string().min(1).max(128),
    endpointSlug: z.string().min(1).max(128).optional(),
    workflowRevision: z.number().int().positive().optional(),
    /** profileSettings source. Carried through untouched; never request input. */
    policy: ProfileEndpointPolicySchema,
    requestDefaults: ProfileGroupRequestDefaultsSchema.default({}),
    connectorBindings: z
      .record(z.string().min(1), ProfileGroupConnectorPinSchema)
      .default({}),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind === 'endpoint') {
      if (!input.endpointSlug) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpointSlug'],
          message: 'endpoint functions require endpointSlug',
        });
      }
      if (input.workflowRevision !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workflowRevision'],
          message: 'endpoint functions cannot carry workflowRevision',
        });
      }
      return;
    }
    if (input.endpointSlug !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpointSlug'],
        message: 'workflow functions cannot carry endpointSlug',
      });
    }
    if (input.workflowRevision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflowRevision'],
        message: 'workflow functions require workflowRevision',
      });
    }
  });
export type ProfileGroupV2FunctionInput = z.infer<typeof ProfileGroupV2FunctionInputSchema>;

export const ProfileGroupV2BusinessInputSchema = z
  .object({
    businessId: z.string().min(1).max(256),
    businessVersion: z.string().min(1).max(128),
    manifestDigest: ProfileGroupDigestPinSchema,
    functions: z.array(ProfileGroupV2FunctionInputSchema).min(1).max(256),
  })
  .strict();
export type ProfileGroupV2BusinessInput = z.infer<typeof ProfileGroupV2BusinessInputSchema>;

export const ProfileGroupV2SaveSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    tenantId: z.string().uuid().optional(),
    authMode: ProfileGroupAuthModeSchema,
    expectedRevision: ProfileRevisionSchema,
    businesses: z.array(ProfileGroupV2BusinessInputSchema).min(1).max(64),
  })
  .strict();
export type ProfileGroupV2Save = z.infer<typeof ProfileGroupV2SaveSchema>;

/* ------------------------------------------------------------------ */
/* Read: v2 root DTO                                                  */
/* ------------------------------------------------------------------ */

export const ProfileGroupV2FunctionSchema = z
  .object({
    kind: ProfileGroupFunctionKindSchema,
    functionId: z.string().min(1).max(256),
    action: z.string().min(1).max(128),
    endpointSlug: z.string().min(1).max(128).optional(),
    workflowRevision: z.number().int().positive().optional(),
    manifestDigest: ProfileGroupDigestReadSchema,
    childProfileId: z.string().uuid(),
    childRevision: z.number().int().positive(),
    enabled: z.boolean(),
    policy: ProfileEndpointPolicyReadSchema,
    requestDefaults: ProfileGroupRequestDefaultsReadSchema,
    connectorBindings: z.record(z.string().min(1), ProfileGroupConnectorPinSchema),
  })
  .strict();
export type ProfileGroupV2Function = z.infer<typeof ProfileGroupV2FunctionSchema>;

export const ProfileGroupV2BusinessSchema = z
  .object({
    businessId: z.string().min(1).max(256),
    businessVersion: z.string().min(1).max(128),
    manifestDigest: ProfileGroupDigestReadSchema,
    functions: z.array(ProfileGroupV2FunctionSchema),
  })
  .strict();
export type ProfileGroupV2Business = z.infer<typeof ProfileGroupV2BusinessSchema>;

export const ProfileGroupV2Schema = z
  .object({
    groupId: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    authMode: ProfileGroupAuthModeSchema,
    authAuthority: ProfileGroupAuthAuthoritySchema,
    revision: ProfileRevisionSchema,
    accessVersion: ProfileGroupAccessVersionSchema,
    businesses: z.array(ProfileGroupV2BusinessSchema),
    /** ACTIVE grants only; tombstones stay out of the read projection. */
    apiKeyGrants: z.array(ProfileGroupKeyGrantSchema),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProfileGroupV2 = z.infer<typeof ProfileGroupV2Schema>;

export const ProfileGroupV2ListSchema = z
  .object({ groups: z.array(ProfileGroupV2Schema) })
  .strict();
export type ProfileGroupV2List = z.infer<typeof ProfileGroupV2ListSchema>;

/** Same body as v1: rollback CASes the config pointer and never touches grants. */
export const ProfileGroupV2RollbackSchema = ProfileGroupRollbackSchema;

/* ------------------------------------------------------------------ */
/* Resolution fingerprint                                             */
/* ------------------------------------------------------------------ */

export interface ProfileGroupResolutionFunctionRefV2 {
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  kind: ProfileGroupFunctionKind;
  functionId: string;
  action: string;
  endpointSlug?: string;
  workflowRevision?: number;
}

export interface ProfileGroupChildPinV2 {
  functionId: string;
  childProfileId: string;
  childRevision: number;
}

export interface ProfileGroupConnectorBindingRefV2 {
  slot: string;
  connectorId: string;
  revision: number;
}

export interface ResolutionFingerprintPartsV2 {
  tenantId: string;
  apiKeyId: string;
  groupId: string;
  groupRevision: number;
  accessVersion: number;
  function: ProfileGroupResolutionFunctionRefV2;
  children: readonly ProfileGroupChildPinV2[];
  tenantDefaultsRevision: number | null;
  connectorBindings: readonly ProfileGroupConnectorBindingRefV2[];
  workflow: { revision: number; digest: string } | null;
  submission: Submission;
}

const FINGERPRINT_DOMAIN = 'du.profile-resolution';
const FINGERPRINT_VERSION = '2';

export function computeResolutionFingerprint(parts: ResolutionFingerprintPartsV2): string {
  const children = [...parts.children]
    .map((child) => ({
      functionId: child.functionId,
      childProfileId: child.childProfileId,
      childRevision: child.childRevision,
    }))
    .sort((left, right) =>
      left.functionId < right.functionId
        ? -1
        : left.functionId > right.functionId
          ? 1
          : left.childProfileId < right.childProfileId
            ? -1
            : left.childProfileId > right.childProfileId
              ? 1
              : 0,
    );
  const connectorBindings = [...parts.connectorBindings]
    .map((binding) => ({
      slot: binding.slot,
      connectorId: binding.connectorId,
      revision: binding.revision,
    }))
    .sort((left, right) =>
      left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0,
    );
  const fn = parts.function;
  return contentHash({
    domain: FINGERPRINT_DOMAIN,
    contractVersion: FINGERPRINT_VERSION,
    tenantId: parts.tenantId,
    apiKeyId: parts.apiKeyId,
    groupId: parts.groupId,
    groupRevision: parts.groupRevision,
    accessVersion: parts.accessVersion,
    function: {
      businessId: fn.businessId,
      businessVersion: fn.businessVersion,
      manifestDigest: fn.manifestDigest,
      kind: fn.kind,
      functionId: fn.functionId,
      action: fn.action,
      endpointSlug: fn.endpointSlug,
      workflowRevision: fn.workflowRevision,
    },
    children,
    tenantDefaultsRevision: parts.tenantDefaultsRevision,
    connectorBindings,
    workflow: parts.workflow,
    requestDigest: canonicalRequestHash(parts.submission),
  });
}

/* ------------------------------------------------------------------ */
/* Public v2 preview / submit                                         */
/* ------------------------------------------------------------------ */

export const ProfileGroupFunctionSelectorV2Schema = z
  .object({
    businessId: z.string().min(1).max(128),
    businessVersion: z.string().min(1).max(128),
    action: z.string().min(1).max(128),
    functionId: z.string().min(1).max(256),
    endpointSlug: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ProfileGroupFunctionSelectorV2 = z.infer<
  typeof ProfileGroupFunctionSelectorV2Schema
>;

export const ProfileGroupResolutionRefsV2Schema = z
  .object({
    groupId: z.string().uuid(),
    groupRevision: ProfileRevisionSchema,
    accessVersion: ProfileGroupAccessVersionSchema,
    businessId: z.string().min(1).max(256),
    businessVersion: z.string().min(1).max(128),
    manifestDigest: ProfileGroupDigestReadSchema,
    kind: ProfileGroupFunctionKindSchema,
    functionId: z.string().min(1).max(256),
    action: z.string().min(1).max(128),
    endpointSlug: z.string().min(1).max(128).optional(),
    workflowRevision: z.number().int().positive().optional(),
    workflowDigest: ProfileGroupDigestPinSchema.optional(),
    childProfileId: z.string().uuid(),
    childRevision: z.number().int().positive(),
    tenantDefaultsRevision: z.number().int().positive().nullable(),
    connectorBindings: z
      .array(
        z
          .object({
            slot: z.string().min(1).max(128),
            connectorId: z.string().min(1).max(128),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type ProfileGroupResolutionRefsV2 = z.infer<
  typeof ProfileGroupResolutionRefsV2Schema
>;

export const ProfileGroupEffectiveParametersV2Schema = z
  .object({
    /** The resolved request parameters the action will actually receive. */
    parameters: z.record(z.string(), z.unknown()),
    /** Property names filled from configured requestDefaults, not client input. */
    appliedRequestDefaults: z.array(z.string().min(1).max(128)).max(256),
    /** Property names filled from inputSchema top-level defaults. */
    appliedSchemaDefaults: z.array(z.string().min(1).max(128)).max(256),
    /** Mapped properties locked by config; a submission carrying any is rejected. */
    lockedParameters: z.array(z.string().min(1).max(128)).max(256),
  })
  .strict();
export type ProfileGroupEffectiveParametersV2 = z.infer<
  typeof ProfileGroupEffectiveParametersV2Schema
>;

export const ProfileGroupPreviewV2ResponseSchema = z
  .object({
    refs: ProfileGroupResolutionRefsV2Schema,
    resolutionFingerprint: ResolutionFingerprintSchema,
    effective: ProfileGroupEffectiveParametersV2Schema,
  })
  .strict();
export type ProfileGroupPreviewV2Response = z.infer<
  typeof ProfileGroupPreviewV2ResponseSchema
>;
```

### 2.4 Draft — `src/manifest.ts` addition

`ActionManifestSchema` is currently a **non-strict** `z.object` (`manifest.ts:30-45`). Do **not** add `.strict()` — that would reject third-party manifests that carry extra keys today. Adding one optional field is additive for both types and digests: `canonicalize` drops `undefined` (`manifest-validator.ts:14-29`), so every already-registered manifest without the capability keeps its digest bit-for-bit (§5.2 proves this with a golden pin).

```ts
import { z } from 'zod';

/**
 * Opt-in, immutable manifest capability. Absence means v1 semantics exactly:
 * no property is inferred from `inputSchema`/`profileSchema` overlap, and no
 * schema default is applied.
 */
export const ParameterResolutionSourceSchema = z.enum([
  'requestDefaults',
  'profileSettings',
]);
export type ParameterResolutionSource = z.infer<typeof ParameterResolutionSourceSchema>;

export const ParameterResolutionCapabilitySchema = z
  .object({
    version: z.literal(2),
    /** Declared property -> the single source that owns it. */
    fields: z.record(z.string().min(1).max(128), ParameterResolutionSourceSchema),
    /** When true, `inputSchema.properties.<name>.default` fills absent top-level fields. */
    applyTopLevelDefaults: z.boolean(),
  })
  .strict();
export type ParameterResolutionCapability = z.infer<
  typeof ParameterResolutionCapabilitySchema
>;
```

Mount it on the action, not on the business root: the mapping is per action, because the property names it resolves are per action (`inputSchema`/`profileSchema`). A business-level map would be ambiguous the moment two actions share a property name.

```ts
// inside ActionManifestSchema, after `defaultLimits`
parameterResolution: ParameterResolutionCapabilitySchema.optional(),
```

### 2.5 Draft — `src/public-api.ts` additions

```ts
import { z } from 'zod';
import { SubmissionSchema } from './operations';
import {
  ProfileGroupFunctionSelectorV2Schema,
  ResolutionFingerprintSchema,
} from './profile-groups-v2-draft';

/** POST /api/v2/profile-groups/:groupId/preview */
export const ProfileGroupPreviewV2RequestSchema = ProfileGroupFunctionSelectorV2Schema.extend({
  submission: SubmissionSchema,
}).strict();
export type ProfileGroupPreviewV2Request = z.infer<typeof ProfileGroupPreviewV2RequestSchema>;

/** POST /api/v2/profile-groups/:groupId/operations */
export const ProfileGroupSubmitV2RequestSchema = ProfileGroupPreviewV2RequestSchema.extend({
  resolutionFingerprint: ResolutionFingerprintSchema,
}).strict();
export type ProfileGroupSubmitV2Request = z.infer<typeof ProfileGroupSubmitV2RequestSchema>;
```

Notes:
- `groupId` is **path-only** (`/api/v2/profile-groups/:groupId/...`); a body `groupId` is `unrecognized_keys` (test G2).
- `SubmissionSchema` is imported unchanged from `operations.ts:289-301` so v2 cannot drift from v1 submission semantics.
- The **response** for `/operations` is the existing `SubmitAckSchema` (`public-api.ts:733-745`), unmodified — the plan asks for "the existing submit acknowledgement shape".

### 2.6 Draft — `src/admin-workbench.ts` additions

```ts
import { z } from 'zod';
import { SubmissionSchema } from './operations';
import { AdminWorkbenchOperationAcceptedSchema } from './admin-workbench';
import {
  ProfileGroupFunctionSelectorV2Schema,
  ProfileGroupPreviewV2ResponseSchema,
  ResolutionFingerprintSchema,
} from './profile-groups-v2-draft';

/**
 * Workbench v2 selector: the server is told which key to resolve; it never
 * guesses the first active grant.
 */
export const AdminWorkbenchProfileSelectorV2Schema = ProfileGroupFunctionSelectorV2Schema.extend({
  tenantId: z.string().uuid(),
  apiKeyId: z.string().uuid(),
  /** null keeps the v1 meaning: an action-level profile. */
  endpointSlug: z.string().min(1).max(128).nullable().optional(),
}).strict();
export type AdminWorkbenchProfileSelectorV2 = z.infer<
  typeof AdminWorkbenchProfileSelectorV2Schema
>;

export const AdminWorkbenchProfilePreviewV2RequestSchema =
  AdminWorkbenchProfileSelectorV2Schema.extend({
    submission: SubmissionSchema,
  }).strict();
export type AdminWorkbenchProfilePreviewV2Request = z.infer<
  typeof AdminWorkbenchProfilePreviewV2RequestSchema
>;

export const AdminWorkbenchProfileSubmitV2RequestSchema =
  AdminWorkbenchProfilePreviewV2RequestSchema.extend({
    resolutionFingerprint: ResolutionFingerprintSchema,
  }).strict();
export type AdminWorkbenchProfileSubmitV2Request = z.infer<
  typeof AdminWorkbenchProfileSubmitV2RequestSchema
>;

export const AdminWorkbenchProfilePreviewV2ResponseSchema = ProfileGroupPreviewV2ResponseSchema.extend({
  /** Echo of the explicitly selected key the preview resolved. */
  apiKeyId: z.string().uuid(),
}).strict();
export type AdminWorkbenchProfilePreviewV2Response = z.infer<
  typeof AdminWorkbenchProfilePreviewV2ResponseSchema
>;

/** Submit reuses the accepted-operation envelope unchanged. */
export const AdminWorkbenchProfileSubmitV2ResponseSchema = AdminWorkbenchOperationAcceptedSchema;
```

Notes:
- `apiKeyId` is required: the server never selects "the first active grant" (plan: "It never chooses the first key"; acceptance: "Empty grant set disables submit").
- `endpointSlug` accepts `null` in the Workbench selector to preserve the v1 comment's meaning (`admin-workbench.ts:34`: *null denotes an action-level Profile*).
- Preview response extends the public preview response with the selected `apiKeyId`; submit reuses `AdminWorkbenchOperationAcceptedSchema` (`admin-workbench.ts:59-63`).
- The `Idempotency-Key` header is **not** in the body; routes validate it with the existing `IdempotencyKeySchema` (`operations.ts:312`).

### 2.7 `src/runtime.ts` — explicit no-change decision

The plan requires the resolved request `parameters` to travel in the **existing** Runtime API v1 task input, with `profileSettings` staying in the existing profile snapshot: *"no new required Runtime wire field or SDK dependency"* (master plan §"Manifest parameter and lock resolution" item 3). Evidence that the current wire already carries both:

| Carrier | Existing field | Anchor |
| :--- | :--- | :--- |
| Resolved properties + `profileSettings` | `pinned.profilePolicy` (`ProfilePolicySnapshotSchema`, nullable) | `runtime.ts:141-142, 203` |
| Tenant defaults | `pinned.tenantDefaults` (optional, nullable, opened at claim) | `runtime.ts:205` |
| Task payload | `payloadRef` / `resolvedInputRef` | `runtime.ts:171-172, 209` |

Therefore **PC-01 adds nothing to `runtime.ts`**. Adding an optional field "for clarity" would create a second source of truth for the same values and a mixed-rollout parsing surface (`runtime.ts:177-201` documents how painful the legacy/nullable distinctions already are). If PC-06 later proves a wire field is unavoidable, it must be additive and nullable, and that is a PC-06 decision with its own manifest re-registration.

Consequence for PC-03/PC-05: the fingerprint must be *recomputable* from durable refs (group revision, access version, child revisions, manifest digest, defaults revision, connector pins, workflow revision, request digest) — not from the resolved payload, because the payload is sealed at admission and may be encrypted.

### 2.8 `src/index.ts` — no change required

`export * from './profile-groups'` (`index.ts:63`) already re-exports everything appended there; `./public-api` (`:21`), `./manifest` (`:10`), `./admin-workbench` (`:49`) are likewise already exported. A grep for all **37** new exported identifiers over `src/*.ts` returned **0 existing definitions** (`ProfileGroupV2*`, `ResolutionFingerprintSchema`, `computeResolutionFingerprint`, `ParameterResolution*`, every grant/key DTO and every Workbench v2 DTO), so there is no shadowing or re-export conflict. (The one explicit-value-export note in `index.ts:51-54` applies to Rollup static scanning of *re-exported values*; nothing here needs that.)

### 2.9 Problem codes — where they must live

`PROFILE_PROBLEM_CODES` sits in `profile-policy.ts:622-639`, which is **outside** the PC-01 lease. To avoid a lease extension, add the v2 codes next to the v2 schemas:

```ts
export const PROFILE_GROUP_PROBLEM_CODES = {
  /** 409 — a v1 group/child write on a GROUP_GRANT group, or a v1 read that cannot project one key. */
  PROFILE_GROUP_V2_REQUIRED: 'PROFILE_GROUP_V2_REQUIRED',
  /** 409 — v2 submit carried a fingerprint that no longer matches current refs. Emitted before any write. */
  PROFILE_CHANGED: 'PROFILE_CHANGED',
  /** 403 — no current root grant, or no unique active member for the presented key. */
  PROFILE_GROUP_UNAUTHORIZED: 'PROFILE_GROUP_UNAUTHORIZED',
} as const;
export type ProfileGroupProblemCode =
  (typeof PROFILE_GROUP_PROBLEM_CODES)[keyof typeof PROFILE_GROUP_PROBLEM_CODES];
```

Route-level status codes stay with PC-03/PC-05; this only freezes the strings so the Admin UI cannot drift.

### 2.10 Deltas from the literal dispatch text (and why)

| Dispatch said | Draft does | Why |
| :--- | :--- | :--- |
| `ProfileGroupV2ResponseSchema` | `ProfileGroupV2Schema` (+ `ProfileGroupV2ListSchema`) | PC-01 dispatch fixes this name; one schema serves both `GET /:groupId` and the list, so a second name would be a silent drift risk. Type aliases may be added, schemas may not be duplicated. |
| `resolutionFingerprint` "sha256 hex" | `sha256:<64 lowercase hex>` | Matches every existing digest in the package (`hashManifest`, `contentHash`, `canonicalRequestHash`) and is visually distinguishable from a bare hex string. |
| Only `ProfileGroupV2SaveSchema` / `ProfileGroupV2Schema` listed | Added selector / refs / effective-parameters / preview-response DTOs | Route table rows 7-9 of the master plan need a typed preview response; the fingerprint alone is not a preview. |
| `ProfileGroupKeyIssueInputSchema {note?}`, `ProfileGroupKeyRevokeInputSchema {expectedAccessVersion}` | Kept, plus issue/revoke **result** DTOs | The one-time raw secret needs a frozen envelope (`secret` + `secretAvailable`, mirroring `ApiKeyMutationResultSchema`, `parity.ts:100-106`), and revoke must return its tombstone + new access version. |
| No digest strictness stated | Strict write pin / lenient read pin | A malformed historical row must not 500 the read; a new write must not store a digest the registry cannot have produced. |

---

## 3. `resolutionFingerprint` specification

### 3.1 Wire schema

```ts
export const ResolutionFingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'resolutionFingerprint must be sha256:<64 lowercase hex>');
```

It is required on **every v2 preview-backed submit** (`POST /api/v2/profile-groups/:groupId/operations`, `POST /api/internal/admin-workbench/v2/submit`) and is **absent** from every v1 request. It is returned by both preview routes.

### 3.2 Algorithm (normative)

`computeResolutionFingerprint` = `contentHash(payload)` where `contentHash` is the existing helper (`hashing.ts:50-52` = `sha256:` + SHA-256 over `canonicalize(value)`), and `requestDigest` = `canonicalRequestHash(submission)` (`hashing.ts:23-37`, which already excludes `clientReference`/correlation ID and normalizes absent optionals to `null`).

Payload (all values server-derived except the submission):

```text
{
  domain: 'du.profile-resolution',      // domain separation
  contractVersion: '2',                 // resolver-version separation
  tenantId, apiKeyId,                   // authenticated or explicitly selected owner key
  groupId, groupRevision, accessVersion,
  function: {                           // exact selector + immutable pins
    businessId, businessVersion, manifestDigest, kind,
    functionId, action, endpointSlug?, workflowRevision?
  },
  children: [ { functionId, childProfileId, childRevision } ]   // sorted
  tenantDefaultsRevision,               // number | null
  connectorBindings: [ { slot, connectorId, revision } ],      // sorted by slot
  workflow: { revision, digest } | null,
  requestDigest: 'sha256:…'
}
```

**Normalization rules** (each one is pinned by a test in §4):

| Rule | Behavior |
| :--- | :--- |
| Object key order | Irrelevant — `canonicalize` sorts recursively |
| `children[]` order | Irrelevant — sorted by `functionId`, tie-break `childProfileId` |
| `connectorBindings[]` order | Irrelevant — sorted by `slot` |
| `undefined` values | Dropped (so an omitted optional and an explicit `undefined` are identical) |
| `submission.clientReference`, correlation ID | Excluded (`canonicalRequestHash` semantics) |
| `submission.output: null` vs absent | **Identical** (`output ?? null` in `canonicalRequestHash`) |
| `input.<prop>: null` vs absent property | **Different** (an explicit null is a value) |
| `profileSettings` | Never hashed into the fingerprint; it lives in the pinned policy |
| Resolution *result* | Never hashed; only refs + request, so the value can be recomputed after admission without decrypting a sealed payload |

### 3.3 Golden vectors

The reference preimage for the canonical fixture (fixture UUIDs `1111…/2222…/3333…/4444…`, `manifestDigest = sha256:aaaa…`, revision 4, accessVersion 7, one child at rev 2, one connector binding, no tenant defaults, no workflow):

```text
{"accessVersion":7,"apiKeyId":"22222222-2222-4222-8222-222222222222","children":[{"childProfileId":"44444444-4444-4444-8444-444444444444","childRevision":2,"functionId":"extract.invoice"}],"connectorBindings":[{"connectorId":"acme-llm","revision":7,"slot":"reasoning"}],"contractVersion":"2","domain":"du.profile-resolution","function":{"action":"extract","businessId":"document-core","businessVersion":"1.0.0","endpointSlug":"extract.invoice","functionId":"extract.invoice","kind":"endpoint","manifestDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"groupId":"33333333-3333-4333-8333-333333333333","groupRevision":4,"requestDigest":"sha256:5670835bd3436b8af329dc069f5e9eb5938239e07d71f4be02bc220503f55a64","tenantDefaultsRevision":null,"tenantId":"11111111-1111-4111-8111-111111111111","workflow":null}
```

| Value | Expected |
| :--- | :--- |
| `canonicalRequestHash({ input: { documentType: 'invoice', language: 'vi' } })` | `sha256:5670835bd3436b8af329dc069f5e9eb5938239e07d71f4be02bc220503f55a64` |
| `computeResolutionFingerprint(<fixture>)` | `sha256:b226e4ef5fe63282b5286d64dfe63e3bdf535a5867fc8816b1db31445c8a7b46` |

Both constants were computed **before** the draft code existed, with a standalone canonicalizer + `createHash` script; the draft implementation then reproduced them exactly on the first run that used the same fixture UUIDs. That is the strongest available proof that §3.2 is unambiguous rather than "whatever the implementation does".

Informational variants (asserted as *inequality* in the test, not as fixed constants): `groupRevision 5` → `sha256:8bd7463e…`, `accessVersion 8` → `sha256:587e1a37…`, `tenantDefaultsRevision 3` → `sha256:7a618d9c…`.

### 3.4 Anti-patterns (explicitly rejected)

- No signing secret, no HMAC key, no bearer semantics: the value is a **concurrency guard**, not authority (plan §"DTO and route contract"). Authorization is re-checked inside the submit transaction.
- Never accept a client-chosen "resolver version" or client-supplied ref snapshot.
- Never hash the resolved parameter *values*: that would make replay require decrypting the sealed admission payload, and would leak config equality through the digest.
- Never reuse `canonicalRequestHash` alone as the fingerprint — it does not contain any config ref, so a config change would go unnoticed.

---

## 4. Test plan for `orchestrator/packages/contracts/tests/profile-groups-v2.test.ts`

### 4.1 Status

The drafted file exists as Appendix A (jest-shaped, `it(...)` + `node:assert/strict`) and **passed 36/36** in the throwaway project against the drafts in §2.3-2.4. Its only difference from the shippable file is the import specifiers (§4.5).

### 4.2 Verified cases (36)

| ID | Case | Core assertion |
| :--- | :--- | :--- |
| A1 | v1 save still requires the singular key | missing `apiKey` ⇒ issue path `apiKey`; with it ⇒ parses |
| A2 | v1 read shape is not a v2 DTO | a v1 `ProfileGroup` object fails `ProfileGroupV2Schema` |
| B1 | v2 save with **no key selector at all** | parses; result has no `apiKey`; `requestDefaults` preserved |
| B2 | a lingering singular `apiKey` is refused | `unrecognized_keys` |
| B3 | `authMode` explicit + literal | missing ⇒ fail; `'LEGACY'` ⇒ fail |
| B4 | create vs update share one body | `expectedRevision: 0` and `: 4` both parse |
| B5 | `requestDefaults` omitted | defaults to `{}` |
| C1 | endpoint without `endpointSlug` | issue path `endpointSlug` |
| C2 | endpoint with `workflowRevision` | issue path `workflowRevision` |
| C3 | workflow without `workflowRevision` | issue path `workflowRevision` (v2 tightening vs C6 in §1.1) |
| C4 | workflow with `endpointSlug` | issue path `endpointSlug` |
| C5 | workflow with `workflowRevision` | parses |
| D1 | credential-shaped `requestDefaults` keys | refused at `openaiToken`, `apiKey` |
| D2 | lookalike names stay usable | `maxTokens`, `passwordPolicy`, `tokenizer` parse |
| D3 | `policy.parameters` keeps v1 parity | `apiKey` accepted there (snapshot still refuses it) |
| E1 | **zero grants** is readable/editable | `apiKeyGrants: []`, `authAuthority`, `accessVersion` parse |
| E2 | grant rows are secret-free | a `secret` field on a grant ⇒ fail |
| E3 | revoke keeps a tombstone | missing `revokedAt` ⇒ fail |
| E4 | issue/revoke bodies | `{}` ok; note >200 chars fail; `expectedAccessVersion: 0` fail; extra field fail; issue result requires `secretAvailable` |
| E5 | rollback shares the v1 body | `accessVersion` there ⇒ fail |
| F1 | golden fingerprint | `requestDigest` and fingerprint constants of §3.3 |
| F2 | order invariance | permuted input/children/bindings ⇒ same digest; extra child/binding ⇒ different |
| F3 | every pinned ref moves the digest | revision, access version, defaults rev, child rev, manifest digest, workflow, request each change it; all 7 differ from each other |
| F4 | normalization | `clientReference` ignored; `output: null` ≡ absent; `input.x: null` ≠ absent |
| F5 | wire shape | bare hex, uppercase hex, 63 hex ⇒ fail |
| G1 | v2 preview needs no fingerprint | parses |
| G2 | group is path-only | body `groupId` ⇒ `unrecognized_keys` |
| G3 | v2 submit requires the fingerprint | missing ⇒ issue path `resolutionFingerprint` |
| G4 | preview response | `refs` + fingerprint + redacted `effective` parse |
| H1 | Workbench needs an explicit `apiKeyId` | missing ⇒ issue path `apiKeyId` |
| H2 | Workbench submit requires the fingerprint | preview parses, submit without it fails, with it passes |
| H3 | Workbench preview response | requires the echoed `apiKeyId` |
| I1 | **v1 manifest digest golden pin** | `sha256:eb89c236…0533` (see §5.2) |
| I2 | an undeclared capability is stripped | adding `parameterResolution` to a v1 action leaves the digest unchanged and the parsed action without the field |
| I3 | capability schema strictness | `version: 1`, `'inputSchema'` source, extra key, missing boolean ⇒ fail |
| I4 | authority enum | exactly `CHILD_PROJECTION` / `GROUP_GRANT` |

### 4.3 Recommended additions (not yet executed — add during PC-01)

| ID | Case | Why |
| :--- | :--- | :--- |
| B6 | v2 save rejects every server-owned field (`groupId`, `revision`, `authAuthority`, `accessVersion`, `apiKeyGrants`) | `.strict()` implies it; an explicit list documents the invariant and catches a future `.strip()` regression |
| B7 | `policy.requestDefaults` is rejected | proves the "one source per field" rule at contract level |
| E6 | `apiKeyGrants` accepts 1..N grants | multi-key Workbench display (acceptance row) |
| F6 | `ProfileGroupV2Schema` round-trips a full v2 save projection | guards the read/write field-name drift |
| I5 | `fields` map with an empty object parses, and `applyTopLevelDefaults: false` parses | opt-in boundary |

### 4.4 `tests/manifest.test.ts` additions

1. **Digest freeze (highest value):** assert `validateManifest(exampleManifest()).digest === 'sha256:eb89c23697ebf1181a3e4a0fbb3421cd6d3f1e1cf340108019e6636f8c980533'`. This turns "we did not change v1 manifest semantics" from a claim into a failing build. The constant was produced from a fresh `tsc` build of `src` (not from `dist`) during this packet.
2. **Capability is opt-in:** a manifest action with `parameterResolution` parses and the capability survives `.parse()` (this assertion *fails now* and *passes after* §2.4 — it is the red test for the change).
3. **Capability changes the digest only when declared:** compare `hashManifest(withCapability)` vs `hashManifest(without)` — different; and `hashManifest(without)` unchanged vs the pin.
4. **Capability shape:** covered by I3 already; keep it in the v2 file to avoid duplicating fixtures.

### 4.5 Porting map (draft module → shippable import)

| Appendix A import | Shippable import |
| :--- | :--- |
| `'../src/profile-groups'` (v1 symbols) | unchanged |
| `'../src/profile-groups-v2-draft'` | `'../src/profile-groups'` |
| `'../src/manifest-parameter-resolution-draft'` | `'../src/manifest'` |
| `'../src/public-api-profile-v2-draft'` | `'../src/public-api'` |
| `'../src/admin-workbench-profile-v2-draft'` | `'../src/admin-workbench'` |
| `'../src/manifest-validator'`, `'../src/hashing'` | unchanged |

The local `test(name, fn)` shim stays valid under jest (it forwards to `it`); it exists only so the same file also runs as a plain script. Either keep it or rewrite the `test(...)` calls as `it(...)` — mechanical and behaviour-neutral.

---

## 5. Compatibility and freeze analysis

### 5.1 v1 is byte-identical

- Every v1 schema function is untouched; the draft only *appends* new declarations. Re-running the repository baseline must therefore stay at **35 suites / 586 tests** (measured, §0.3).
- v1 `.strict()` objects are unchanged, so a v2 body on a v1 route remains a 422 (`profile-groups.ts:57`), and a v1 body on a v2 route also fails (`apiKey` unrecognized ⇒ test B2). The two generations cannot be confused in either direction.
- The additive `ActionManifestSchema` field is the only change to an existing declaration; it is optional, and `canonicalize` drops `undefined`.

### 5.2 Manifest digest stability (golden pin)

| Input | Digest |
| :--- | :--- |
| `exampleManifest()` from `tests/manifest.test.ts` | `sha256:eb89c23697ebf1181a3e4a0fbb3421cd6d3f1e1cf340108019e6636f8c980533` |
| same, with an *undeclared* `parameterResolution` key on the action | identical (the non-strict v1 schema strips it) |

Produced by compiling `packages/contracts/src` to a temp `outDir` and calling `validateManifest` from that build — **not** from the pre-existing `dist`, which could have been stale. This is why PC-06's "register a new immutable manifest version" rule matters: the capability can only reach a digest through a declared field on a newly registered version; nothing re-hashes in place.

### 5.3 Non-relaxation checklist (must be verifiable in review)

- [ ] No `.strict()` removed anywhere.
- [ ] No v1 field made optional or defaulted.
- [ ] No v1 schema renamed or moved.
- [ ] `ProfileEndpointPolicySchema` / `ProfileEndpointPolicyReadSchema` untouched.
- [ ] `ProfileGroupV2Schema` contains no `apiKey` field.
- [ ] `requestDefaults` is not nested inside `policy`.
- [ ] `runtime.ts` unchanged.
- [ ] `index.ts` unchanged.

### 5.4 Consumer expectations created by this packet

| Consumer packet | May now import | Must not do |
| :--- | :--- | :--- |
| PC-02 (migration) | `ProfileGroupAuthAuthoritySchema`, `ProfileGroupAccessVersionSchema` | infer a DB enum from the Zod enum without a migration ledger update |
| PC-03 (group service) | all v2 group/grant DTOs, `PROFILE_GROUP_PROBLEM_CODES` | accept a raw key on create, or reuse the v1 save schema for v2 |
| PC-04 (key lifecycle) | `ProfileGroupKeyIssueInput/Result`, `ProfileGroupKeyRevokeInput/Result` | return a raw secret from any read route |
| PC-05 (resolution/admission) | `computeResolutionFingerprint`, `ProfileGroupPreviewV2ResponseSchema`, `ResolutionFingerprintSchema` | implement a second fingerprint derivation |
| PC-06 (manifest/worker) | `ParameterResolutionCapabilitySchema` | enable the capability for an already-registered version |
| PC-08 (Admin UI) | v2 save/read/grant request+result DTOs | send `apiKeyId` on a group save; omit `resolutionFingerprint` on Workbench submit |

---

## 6. Decisions required from the coordinator

Each has a recommendation; none blocks the draft as written.

| # | Question | Recommendation | Cost if changed later |
| :--- | :--- | :--- | :--- |
| **D1** | Must a v2 group have ≥1 business/function (`businesses.min(1)`)? | **Keep `.min(1)`** (v1 parity). Note: no delete route exists, so a group can never be emptied — flag as a plan gap, not a PC-01 change. | Relaxing to `min(0)` later is non-breaking for clients; tightening would be breaking. So start strict. |
| **D2** | Refuse credential-shaped `requestDefaults` keys at the DTO? | **Yes** (§2.2). | Removing the check later is breaking for configs that stored such keys, so decide now. |
| **D3** | Strict or lenient `manifestDigest` on v2 reads? | **Lenient read / strict write** as drafted. | Making the read strict later would surface legacy rows as 500s — do it only with a data audit. |
| **D4** | Are revoked grants in `apiKeyGrants[]`? | **No** — ACTIVE only; `status` still exposed so an invariant violation is visible. Matches "reads show empty grants after revoke". | Adding a tombstone array later is additive (`apiKeyGrantsRevoked`), so safe. |
| **D5** | Name: `ProfileGroupV2Schema` vs `ProfileGroupV2ResponseSchema`? | **`ProfileGroupV2Schema`** (PC-01 dispatch), plus a type alias if the UI wants the word "Response". | Renaming a schema later is a repo-wide edit; pick once now. |
| **D6** | Separate v2 rollback schema? | **Alias of v1** as drafted. | Adding a v2-only field later is additive. |
| **D7** | Workbench v2 `businessId`: literal `'document-core'` or free string? | **Free bounded string** — group functions can target any registered business; the UI still defaults to `document-core`. | Tightening to a literal later would be breaking. |
| **D8** | Allow `endpointSlug: null` in the Workbench v2 selector? | **Yes** (v1 meaning: action-level profile). Public v2 keeps optional-only. | Removing null later is breaking for saved UI payloads. |
| **D9** | Transport of `expectedAccessVersion` for `POST /keys` | Body carries `{note?}` (dispatch); access CAS via `If-Match` (accept `"7"` or `7`), mismatch ⇒ **412**; `GET` v2 returns `ETag` + `accessVersion`. Revoke carries `expectedAccessVersion` in the body as drafted. | Route-header convention is PC-03 scope; changing later breaks one client shim only. |
| **D10** | `sha256:` prefix on the fingerprint? | **Yes** (consistency + accidental-confusion resistance). | Dropping the prefix later is breaking on the wire. |
| **D11** | Where do the new problem codes live? | **New `PROFILE_GROUP_PROBLEM_CODES`** in `profile-groups.ts` (lease-safe). Alternative: extend `PROFILE_PROBLEM_CODES` + a lease extension for `profile-policy.ts`. | Moving a const later is a mechanical follow-up. |
| **D12** | Who validates `parameterResolution.fields` semantics (property exists in the declared source; defaults only at top level)? | **PC-05** in `manifest-validator.ts`; PC-01 only freezes the shape. Rules PC-05 must implement: each `fields[key]` must exist in the declared source schema's `properties`; a mapped property declared in neither schema is an error; `applyTopLevelDefaults` requires every mapped-property default to be a top-level literal (no `$ref`, combinators, nesting). | Doing it in PC-01 would duplicate PC-05's manifest validator and split the error taxonomy. |

---

## 7. Definition-of-done mapping (PC-01) and handoff

| PC-01 DoD item | Status from this packet | What the implementer must still do |
| :--- | :--- | :--- |
| Zod v2 DTOs designed | **Done** — §2, strict-compiles | apply the appends to the 4 leased files, add `PROFILE_GROUP_PROBLEM_CODES` |
| `resolutionFingerprint` designed + deterministic | **Done** — §3 with goldens reproduced | port the helper into `profile-groups.ts` (imports `canonicalRequestHash`, `contentHash`) |
| `parameterResolution` capability designed | **Done** — §2.4 | mount the optional field on `ActionManifestSchema`; add §4.4 tests |
| Test plan prepared | **Done** — §4, 36/36 verified under jest | create `tests/profile-groups-v2.test.ts` from Appendix A (§4.5 import map), add §4.3 cases |
| `pnpm --filter @du/contracts build` | **Not run** (toolchain mismatch, §0.2) | run under Node 24 + pnpm 10.18.3 |
| `pnpm --filter @du/contracts exec jest tests/profile-groups-v2.test.ts` | **Equivalent proven** in a throwaway project (same jest/ts-jest config) | run in-repo; expect 36+ green |
| `pnpm --filter @du/contracts lint` | **Baseline proven clean**; drafts lint-clean under the same options | run in-repo |
| No source edit in this packet | **Confirmed** — §0.4 | — |

**Suggested execution order for PC-01** (all inside the existing lease): append §2.3 to `profile-groups.ts` → §2.4 to `manifest.ts` → §2.5 to `public-api.ts` → §2.6 to `admin-workbench.ts` → add §4.4 to `manifest.test.ts` → create `tests/profile-groups-v2.test.ts` (Appendix A + §4.3) → `pnpm --filter @du/contracts build` → the three DoD commands. `dist/` is git-ignored (`orchestrator/.gitignore:2`) but downstream service tests resolve `@du/*` through it, so the build is mandatory locally even though nothing from `dist/` is committed.

**Known limitations of this packet.** (1) The 36-case evidence ran on Node v22.23.3, not the declared Node 24 — the in-repo run is still required. (2) The drafts were verified as *separate modules* in `%TEMP%`; merging four appends into three existing files can still surface a duplicate-import or ordering mistake (low risk: zero identifier collisions measured). (3) Everything here is contract-level: no grant/access-version behaviour, no CAS, no HTTP or PG behaviour was exercised — those belong to PC-02..PC-05 and PC-09. (4) The Appendix A file is ephemeral (it lives in `%TEMP%`); the text in this report is the source of truth.

---

## Appendix A — draft `tests/profile-groups-v2.test.ts` (jest-shaped, verified 36/36)

Verified exactly as printed, against the §2.3-2.4 draft modules, with the import specifiers that §4.5 maps to the final modules. jest: `1 suite / 36 tests passed`, exit 0.

```ts
import assert from 'node:assert/strict';
import {
  ProfileGroupSaveSchema,
  ProfileGroupRollbackSchema,
} from '../src/profile-groups';
import {
  ProfileGroupAuthAuthoritySchema,
  ProfileGroupKeyGrantSchema,
  ProfileGroupKeyIssueInputSchema,
  ProfileGroupKeyIssueResultSchema,
  ProfileGroupKeyRevokeInputSchema,
  ProfileGroupRevokedKeyGrantSchema,
  ProfileGroupV2FunctionInputSchema,
  ProfileGroupV2SaveSchema,
  ProfileGroupV2Schema,
  ProfileGroupV2RollbackSchema,
  ProfileGroupPreviewV2ResponseSchema,
  ProfileGroupRequestDefaultsSchema,
  ResolutionFingerprintSchema,
  computeResolutionFingerprint,
  type ResolutionFingerprintPartsV2,
} from '../src/profile-groups-v2-draft';
import {
  ProfileGroupPreviewV2RequestSchema,
  ProfileGroupSubmitV2RequestSchema,
} from '../src/public-api-profile-v2-draft';
import {
  AdminWorkbenchProfilePreviewV2RequestSchema,
  AdminWorkbenchProfilePreviewV2ResponseSchema,
  AdminWorkbenchProfileSubmitV2RequestSchema,
} from '../src/admin-workbench-profile-v2-draft';
import { ParameterResolutionCapabilitySchema } from '../src/manifest-parameter-resolution-draft';
import { validateManifest } from '../src/manifest-validator';
import type { BusinessManifest } from '../src/manifest';
import { canonicalRequestHash } from '../src/hashing';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}`;
const DIGEST_A = sha('a');
const DIGEST_B = sha('b');

const test = (name: string, fn: () => void): void => {
  it(name, fn);
};

interface ParseLike {
  success: boolean;
  error?: { issues: readonly { code: string; path: readonly PropertyKey[] }[] };
}

const paths = (result: ParseLike): string[] =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.map(String).join('.'));
const codes = (result: ParseLike): string[] =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.code);

/* ---------------------------- fixtures ---------------------------- */

const v1GroupSave = {
  name: 'Acme invoices',
  tenantId: uuid(1),
  apiKey: { apiKeyId: uuid(2) },
  expectedRevision: 0,
  businesses: [
    {
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      functions: [
        {
          kind: 'endpoint' as const,
          functionId: 'extract.invoice',
          action: 'extract',
          endpointSlug: 'extract.invoice',
          policy: { enabled: true },
        },
      ],
    },
  ],
};

const v2Function = {
  kind: 'endpoint' as const,
  functionId: 'extract.invoice',
  action: 'extract',
  endpointSlug: 'extract.invoice',
  policy: { enabled: true, parameters: { maxPages: { value: 10, isLocked: true } } },
  requestDefaults: { documentType: { value: 'invoice' } },
  connectorBindings: { reasoning: { connectorId: 'acme-llm', revision: 7 } },
};

const v2GroupSave = {
  name: 'Acme invoices',
  tenantId: uuid(1),
  authMode: 'API_KEY' as const,
  expectedRevision: 0,
  businesses: [
    {
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      functions: [v2Function],
    },
  ],
};

const policyRead = {
  enabled: true,
  parameters: { maxPages: { value: 10, isLocked: true } },
  jobPriority: 'MEDIUM' as const,
  allowedFileExtensions: '',
  fileUrlAuthConfigured: false,
  allowedOrigins: [] as string[],
  connectionsOverride: [] as { slug: string }[],
};

const v2GroupRead = {
  groupId: uuid(3),
  tenantId: uuid(1),
  name: 'Acme invoices',
  authMode: 'API_KEY' as const,
  authAuthority: 'GROUP_GRANT' as const,
  revision: 4,
  accessVersion: 7,
  businesses: [
    {
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      functions: [
        {
          kind: 'endpoint' as const,
          functionId: 'extract.invoice',
          action: 'extract',
          endpointSlug: 'extract.invoice',
          manifestDigest: DIGEST_A,
          childProfileId: uuid(4),
          childRevision: 2,
          enabled: true,
          policy: policyRead,
          requestDefaults: { documentType: { value: 'invoice' } },
          connectorBindings: { reasoning: { connectorId: 'acme-llm', revision: 7 } },
        },
      ],
    },
  ],
  apiKeyGrants: [] as unknown[],
  createdAt: '2026-10-21T01:00:00+07:00',
  updatedAt: '2026-10-21T01:00:00+07:00',
};

const submission = { input: { documentType: 'invoice', language: 'vi' } };

const fingerprintParts: ResolutionFingerprintPartsV2 = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  apiKeyId: '22222222-2222-4222-8222-222222222222',
  groupId: '33333333-3333-4333-8333-333333333333',
  groupRevision: 4,
  accessVersion: 7,
  function: {
    businessId: 'document-core',
    businessVersion: '1.0.0',
    manifestDigest: DIGEST_A,
    kind: 'endpoint',
    functionId: 'extract.invoice',
    action: 'extract',
    endpointSlug: 'extract.invoice',
  },
  children: [
    {
      functionId: 'extract.invoice',
      childProfileId: '44444444-4444-4444-8444-444444444444',
      childRevision: 2,
    },
  ],
  tenantDefaultsRevision: null,
  connectorBindings: [{ slot: 'reasoning', connectorId: 'acme-llm', revision: 7 }],
  workflow: null,
  submission,
};

const exampleManifest: BusinessManifest = {
  contractVersion: '1',
  businessId: 'example-review',
  version: '1.0.0',
  displayName: 'Example Review',
  description: 'Example business for contract tests',
  imageDigest: `sha256:${'0'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root', 'review-item'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [
    {
      name: 'review',
      displayName: 'Review documents',
      description: 'Review a document',
      inputSchema: {
        type: 'object',
        properties: { requireApproval: { type: 'boolean' } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
      },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [],
      artifactPolicy: { minFiles: 1, maxFiles: 10 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 2 },
    },
  ],
} as BusinessManifest;

/* ------------------------- A. v1 freeze -------------------------- */

test('A1 v1 save still requires the singular apiKey', () => {
  assert.equal(ProfileGroupSaveSchema.safeParse(v1GroupSave).success, true);
  const { apiKey: _apiKey, ...withoutKey } = v1GroupSave;
  const parsed = ProfileGroupSaveSchema.safeParse(withoutKey);
  assert.equal(parsed.success, false);
  assert.ok(paths(parsed).includes('apiKey'));
});

test('A2 v1 read DTO still requires apiKey metadata', () => {
  const v1Read = {
    groupId: uuid(3),
    name: 'Acme invoices',
    tenantId: uuid(1),
    revision: 4,
    apiKey: { apiKeyId: uuid(2), prefix: 'du_live_abc', status: 'ACTIVE' },
    businesses: [],
    createdAt: '2026-10-21T01:00:00+07:00',
    updatedAt: '2026-10-21T01:00:00+07:00',
  };
  const parsed = ProfileGroupV2Schema.safeParse(v1Read);
  assert.equal(parsed.success, false, 'v1 read shape must not satisfy the v2 DTO');
});

/* ------------------------ B. v2 save ---------------------------- */

test('B1 v2 save accepts a group body with no key selector at all', () => {
  const parsed = ProfileGroupV2SaveSchema.safeParse(v2GroupSave);
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.data, 'apiKey'), false);
  assert.deepEqual(parsed.data.businesses[0]?.functions[0]?.requestDefaults, {
    documentType: { value: 'invoice' },
  });
});

test('B2 v2 save rejects a lingering singular apiKey', () => {
  const parsed = ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, apiKey: { apiKeyId: uuid(2) } });
  assert.equal(parsed.success, false);
  assert.ok(codes(parsed).includes('unrecognized_keys'));
});

test('B3 authMode is an explicit required literal', () => {
  const { authMode: _authMode, ...withoutMode } = v2GroupSave;
  assert.equal(ProfileGroupV2SaveSchema.safeParse(withoutMode).success, false);
  assert.equal(
    ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, authMode: 'LEGACY' }).success,
    false,
  );
});

test('B4 create uses expectedRevision 0 and update keeps the same body', () => {
  assert.equal(ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, expectedRevision: 0 }).success, true);
  assert.equal(ProfileGroupV2SaveSchema.safeParse({ ...v2GroupSave, expectedRevision: 4 }).success, true);
});

test('B5 requestDefaults defaults to {} when omitted', () => {
  const { requestDefaults: _defaults, ...fn } = v2Function;
  const parsed = ProfileGroupV2SaveSchema.safeParse({
    ...v2GroupSave,
    businesses: [
      { ...v2GroupSave.businesses[0], functions: [fn] },
    ],
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.businesses[0]?.functions[0]?.requestDefaults, {});
});

/* ------------------- C. function selector rules ------------------ */

const fnBase: Record<string, unknown> = {
  kind: 'endpoint',
  functionId: 'extract.invoice',
  action: 'extract',
  endpointSlug: 'extract.invoice',
  policy: { enabled: true },
};

const fnCase = (fn: Record<string, unknown>) =>
  ProfileGroupV2FunctionInputSchema.safeParse({ ...fnBase, ...fn });

test('C1 endpoint without endpointSlug is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'endpoint', endpointSlug: undefined })).includes('endpointSlug'));
});

test('C2 endpoint carrying workflowRevision is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'endpoint', workflowRevision: 3 })).includes('workflowRevision'));
});

test('C3 workflow without workflowRevision is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'workflow', endpointSlug: undefined })).includes('workflowRevision'));
});

test('C4 workflow carrying endpointSlug is rejected', () => {
  assert.ok(paths(fnCase({ kind: 'workflow', endpointSlug: 'x', workflowRevision: 3 })).includes('endpointSlug'));
});

test('C5 workflow with workflowRevision is accepted', () => {
  const parsed = fnCase({ kind: 'workflow', endpointSlug: undefined, workflowRevision: 3 });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

/* ---------------------- D. requestDefaults ---------------------- */

test('D1 credential-shaped requestDefaults keys are refused', () => {
  assert.ok(paths(ProfileGroupRequestDefaultsSchema.safeParse({ openaiToken: { value: 'x' } })).includes('openaiToken'));
  assert.ok(paths(ProfileGroupRequestDefaultsSchema.safeParse({ apiKey: { value: 'x' } })).includes('apiKey'));
});

test('D2 non-credential lookalike names stay usable', () => {
  const parsed = ProfileGroupRequestDefaultsSchema.safeParse({
    maxTokens: { value: 512 },
    passwordPolicy: { value: 'strict' },
    tokenizer: { value: 'bpe' },
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

test('D3 profileSettings keeps v1 parity (credentials refused only at the snapshot)', () => {
  const parsed = fnCase({ policy: { enabled: true, parameters: { apiKey: { value: 'x' } } } });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

/* -------------------------- E. grants --------------------------- */

test('E1 zero active grants is a valid readable/editable profile', () => {
  const parsed = ProfileGroupV2Schema.safeParse(v2GroupRead);
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.apiKeyGrants, []);
  assert.equal(parsed.data.authAuthority, 'GROUP_GRANT');
  assert.equal(parsed.data.accessVersion, 7);
});

test('E2 grant rows carry safe metadata only', () => {
  const grant = {
    apiKeyId: uuid(2),
    prefix: 'du_live_abc',
    status: 'ACTIVE',
    grantedAt: '2026-10-21T01:00:00+07:00',
    grantedBy: 'admin',
  };
  assert.equal(ProfileGroupKeyGrantSchema.safeParse(grant).success, true);
  assert.equal(
    ProfileGroupKeyGrantSchema.safeParse({ ...grant, secret: 'du_live_raw' }).success,
    false,
    'a raw secret must not be representable in the grant DTO',
  );
});

test('E3 revoke keeps a tombstone with revokedAt', () => {
  const tombstone = {
    apiKeyId: uuid(2),
    prefix: 'du_live_abc',
    status: 'ACTIVE',
    grantedAt: '2026-10-21T01:00:00+07:00',
  };
  assert.equal(ProfileGroupRevokedKeyGrantSchema.safeParse(tombstone).success, false);
  assert.equal(
    ProfileGroupRevokedKeyGrantSchema.safeParse({ ...tombstone, revokedAt: '2026-10-21T02:00:00+07:00' }).success,
    true,
  );
});

test('E4 issue/revoke bodies validate', () => {
  assert.equal(ProfileGroupKeyIssueInputSchema.safeParse({}).success, true);
  assert.equal(ProfileGroupKeyIssueInputSchema.safeParse({ note: 'a'.repeat(201) }).success, false);
  assert.equal(ProfileGroupKeyRevokeInputSchema.safeParse({ expectedAccessVersion: 7 }).success, true);
  assert.equal(ProfileGroupKeyRevokeInputSchema.safeParse({ expectedAccessVersion: 0 }).success, false);
  assert.equal(
    ProfileGroupKeyRevokeInputSchema.safeParse({ expectedAccessVersion: 7, revokeKey: true }).success,
    false,
  );
  assert.equal(
    ProfileGroupKeyIssueResultSchema.safeParse({
      grant: {
        apiKeyId: uuid(2),
        prefix: 'du_live_abc',
        status: 'ACTIVE',
        grantedAt: '2026-10-21T01:00:00+07:00',
      },
      secret: 'du_live_' + 'x'.repeat(32),
      secretAvailable: true,
    }).success,
    true,
  );
});

test('E5 v2 rollback shares the v1 body and accepts no access version', () => {
  assert.equal(ProfileGroupV2RollbackSchema.safeParse({ expectedRevision: 4, targetRevision: 2 }).success, true);
  assert.equal(
    ProfileGroupV2RollbackSchema.safeParse({ expectedRevision: 4, targetRevision: 2, accessVersion: 7 }).success,
    false,
  );
  assert.equal(ProfileGroupRollbackSchema.safeParse({ expectedRevision: 4, targetRevision: 2 }).success, true);
});

/* ----------------------- F. fingerprint ------------------------- */

test('F1 golden fingerprint for the canonical fixture', () => {
  assert.equal(
    canonicalRequestHash(submission),
    'sha256:5670835bd3436b8af329dc069f5e9eb5938239e07d71f4be02bc220503f55a64',
  );
  assert.equal(
    computeResolutionFingerprint(fingerprintParts),
    'sha256:b226e4ef5fe63282b5286d64dfe63e3bdf535a5867fc8816b1db31445c8a7b46',
  );
});

test('F2 key order and pin order never change the fingerprint', () => {
  const base = computeResolutionFingerprint(fingerprintParts);
  const reordered = computeResolutionFingerprint({
    ...fingerprintParts,
    submission: { input: { language: 'vi', documentType: 'invoice' } },
    children: [
      { functionId: 'zzz', childProfileId: uuid(9), childRevision: 1 },
      { functionId: 'extract.invoice', childProfileId: uuid(4), childRevision: 2 },
    ],
    connectorBindings: [
      { slot: 'zzz', connectorId: 'other', revision: 1 },
      { slot: 'reasoning', connectorId: 'acme-llm', revision: 7 },
    ],
  });
  const sorted = computeResolutionFingerprint({
    ...fingerprintParts,
    submission: { input: { documentType: 'invoice', language: 'vi' } },
    children: [
      { functionId: 'extract.invoice', childProfileId: uuid(4), childRevision: 2 },
      { functionId: 'zzz', childProfileId: uuid(9), childRevision: 1 },
    ],
    connectorBindings: [
      { slot: 'reasoning', connectorId: 'acme-llm', revision: 7 },
      { slot: 'zzz', connectorId: 'other', revision: 1 },
    ],
  });
  assert.equal(reordered, sorted);
  assert.notEqual(base, reordered);
});

test('F3 every pinned ref moves the fingerprint', () => {
  const base = computeResolutionFingerprint(fingerprintParts);
  const variants = [
    computeResolutionFingerprint({ ...fingerprintParts, groupRevision: 5 }),
    computeResolutionFingerprint({ ...fingerprintParts, accessVersion: 8 }),
    computeResolutionFingerprint({ ...fingerprintParts, tenantDefaultsRevision: 3 }),
    computeResolutionFingerprint({
      ...fingerprintParts,
      children: [{ functionId: 'extract.invoice', childProfileId: uuid(4), childRevision: 3 }],
    }),
    computeResolutionFingerprint({
      ...fingerprintParts,
      function: { ...fingerprintParts.function, manifestDigest: DIGEST_B },
    }),
    computeResolutionFingerprint({
      ...fingerprintParts,
      workflow: { revision: 3, digest: DIGEST_B },
    }),
    computeResolutionFingerprint({ ...fingerprintParts, submission: { input: { documentType: 'invoice' } } }),
  ];
  for (const variant of variants) assert.notEqual(variant, base);
  assert.equal(new Set(variants).size, variants.length);
});

test('F4 non-fingerprinted request fields are excluded', () => {
  const base = computeResolutionFingerprint(fingerprintParts);
  assert.equal(
    computeResolutionFingerprint({
      ...fingerprintParts,
      submission: { ...submission, clientReference: 'invoice-2026-10' },
    }),
    base,
  );
  assert.equal(
    computeResolutionFingerprint({ ...fingerprintParts, submission: { ...submission, output: undefined } }),
    base,
    'absent and undefined output normalize identically',
  );
  assert.equal(
    computeResolutionFingerprint({
      ...fingerprintParts,
      submission: { ...submission, output: null } as unknown as ResolutionFingerprintPartsV2['submission'],
    }),
    base,
    'canonicalRequestHash normalizes an explicit null output exactly like an absent one',
  );
  assert.notEqual(
    computeResolutionFingerprint({
      ...fingerprintParts,
      submission: { input: { documentType: null, language: 'vi' } },
    }),
    base,
    'inside input, an explicit null is a different value than an absent property',
  );
});

test('F5 fingerprint wire schema is sha256-prefixed lowercase hex', () => {
  assert.equal(ResolutionFingerprintSchema.safeParse(DIGEST_A).success, true);
  assert.equal(ResolutionFingerprintSchema.safeParse('a'.repeat(64)).success, false);
  assert.equal(ResolutionFingerprintSchema.safeParse(sha('A')).success, false);
  assert.equal(ResolutionFingerprintSchema.safeParse(`sha256:${'a'.repeat(63)}`).success, false);
});

/* -------------------- G. public v2 preview/submit --------------- */

test('G1 preview parses without any fingerprint', () => {
  const parsed = ProfileGroupPreviewV2RequestSchema.safeParse({
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    functionId: 'extract.invoice',
    submission,
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

test('G2 the group is addressed by path, never by body', () => {
  const parsed = ProfileGroupPreviewV2RequestSchema.safeParse({
    groupId: uuid(3),
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    functionId: 'extract.invoice',
    submission,
  });
  assert.ok(codes(parsed).includes('unrecognized_keys'));
});

test('G3 submit requires the fingerprint', () => {
  const body = {
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    functionId: 'extract.invoice',
    submission,
  };
  const missing = ProfileGroupSubmitV2RequestSchema.safeParse(body);
  assert.equal(missing.success, false);
  assert.ok(paths(missing).includes('resolutionFingerprint'));
  assert.equal(
    ProfileGroupSubmitV2RequestSchema.safeParse({ ...body, resolutionFingerprint: DIGEST_A }).success,
    true,
  );
});

test('G4 preview response carries refs, fingerprint and redacted effective input', () => {
  const parsed = ProfileGroupPreviewV2ResponseSchema.safeParse({
    refs: {
      groupId: uuid(3),
      groupRevision: 4,
      accessVersion: 7,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      kind: 'endpoint',
      functionId: 'extract.invoice',
      action: 'extract',
      endpointSlug: 'extract.invoice',
      childProfileId: uuid(4),
      childRevision: 2,
      tenantDefaultsRevision: null,
      connectorBindings: [{ slot: 'reasoning', connectorId: 'acme-llm', revision: 7 }],
    },
    resolutionFingerprint: DIGEST_A,
    effective: {
      parameters: { documentType: 'invoice', language: 'vi' },
      appliedRequestDefaults: ['documentType'],
      appliedSchemaDefaults: [],
      lockedParameters: [],
    },
  });
  assert.equal(parsed.success, true, JSON.stringify(paths(parsed)));
});

/* --------------------- H. workbench v2 -------------------------- */

const workbenchSelector = {
  tenantId: uuid(1),
  apiKeyId: uuid(2),
  businessId: 'document-core',
  businessVersion: '1.0.0',
  action: 'extract',
  functionId: 'extract.invoice',
  submission,
};

test('H1 workbench requires an explicitly selected key', () => {
  const { apiKeyId: _key, ...withoutKey } = workbenchSelector;
  const parsed = AdminWorkbenchProfilePreviewV2RequestSchema.safeParse(withoutKey);
  assert.equal(parsed.success, false);
  assert.ok(paths(parsed).includes('apiKeyId'));
});

test('H2 workbench submit requires the preview fingerprint', () => {
  assert.equal(AdminWorkbenchProfilePreviewV2RequestSchema.safeParse(workbenchSelector).success, true);
  assert.equal(AdminWorkbenchProfileSubmitV2RequestSchema.safeParse(workbenchSelector).success, false);
  assert.equal(
    AdminWorkbenchProfileSubmitV2RequestSchema.safeParse({
      ...workbenchSelector,
      resolutionFingerprint: DIGEST_A,
    }).success,
    true,
  );
});

test('H3 workbench preview response echoes the selected key', () => {
  const preview = {
    refs: {
      groupId: uuid(3),
      groupRevision: 4,
      accessVersion: 7,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST_A,
      kind: 'endpoint',
      functionId: 'extract.invoice',
      action: 'extract',
      childProfileId: uuid(4),
      childRevision: 2,
      tenantDefaultsRevision: null,
      connectorBindings: [],
    },
    resolutionFingerprint: DIGEST_A,
    effective: {
      parameters: {},
      appliedRequestDefaults: [],
      appliedSchemaDefaults: [],
      lockedParameters: [],
    },
  };
  assert.equal(AdminWorkbenchProfilePreviewV2ResponseSchema.safeParse(preview).success, false);
  assert.equal(
    AdminWorkbenchProfilePreviewV2ResponseSchema.safeParse({ ...preview, apiKeyId: uuid(2) }).success,
    true,
  );
});

/* ------------------ I. manifest capability ---------------------- */

test('I1 v1 manifest digest is unchanged by this packet (golden pin)', () => {
  const result = validateManifest(exampleManifest);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.digest, 'sha256:eb89c23697ebf1181a3e4a0fbb3421cd6d3f1e1cf340108019e6636f8c980533');
});

test('I2 an undeclared capability is stripped, not silently hashed', () => {
  const withCapability = {
    ...exampleManifest,
    actions: [
      {
        ...exampleManifest.actions[0],
        parameterResolution: {
          version: 2,
          fields: { requireApproval: 'requestDefaults' },
          applyTopLevelDefaults: true,
        },
      },
    ],
  } as unknown as BusinessManifest;
  const result = validateManifest(withCapability);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.digest,
    'sha256:eb89c23697ebf1181a3e4a0fbb3421cd6d3f1e1cf340108019e6636f8c980533',
    'until the field is declared, the capability cannot reach the digest',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.manifest.actions[0], 'parameterResolution'),
    false,
  );
});

test('I3 capability schema is strict and version-locked', () => {
  const valid = { version: 2, fields: { requireApproval: 'requestDefaults' }, applyTopLevelDefaults: true };
  assert.equal(ParameterResolutionCapabilitySchema.safeParse(valid).success, true);
  assert.equal(ParameterResolutionCapabilitySchema.safeParse({ ...valid, version: 1 }).success, false);
  assert.equal(
    ParameterResolutionCapabilitySchema.safeParse({ ...valid, fields: { requireApproval: 'inputSchema' } }).success,
    false,
  );
  assert.equal(ParameterResolutionCapabilitySchema.safeParse({ ...valid, extra: true }).success, false);
  assert.equal(
    ParameterResolutionCapabilitySchema.safeParse({ ...valid, applyTopLevelDefaults: undefined }).success,
    false,
  );
});

test('I4 auth authority enum is exactly the two documented modes', () => {
  assert.equal(ProfileGroupAuthAuthoritySchema.safeParse('CHILD_PROJECTION').success, true);
  assert.equal(ProfileGroupAuthAuthoritySchema.safeParse('GROUP_GRANT').success, true);
  assert.equal(ProfileGroupAuthAuthoritySchema.safeParse('API_KEY').success, false);
});
```

