import { z } from 'zod';
import { SubmissionSchema, type Submission } from './operations';
import { canonicalRequestHash, contentHash } from './hashing';
import {
  ProfileEndpointPolicyReadSchema,
  ProfileEndpointPolicySchema,
  ProfileParameterValueSchema,
  ProfileRevisionSchema,
  findSecretParameterKeys,
} from './profile-policy';

const ProfileGroupNameSchema = z.string().trim().min(1).max(120);
const ProfileGroupRevisionSchema = ProfileRevisionSchema;

/** Existing profile connector references remain ID + immutable revision pins. */
export const ProfileGroupConnectorPinSchema = z.object({
  connectorId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
}).strict();
export type ProfileGroupConnectorPin = z.infer<typeof ProfileGroupConnectorPinSchema>;

export const ProfileGroupApiKeyRefSchema = z.object({ apiKeyId: z.string().uuid() }).strict();
export type ProfileGroupApiKeyRef = z.infer<typeof ProfileGroupApiKeyRefSchema>;

export const ProfileGroupFunctionKindSchema = z.enum(['endpoint', 'workflow']);
export type ProfileGroupFunctionKind = z.infer<typeof ProfileGroupFunctionKindSchema>;

/** One selected endpoint or declared workflow action in a group save. */
export const ProfileGroupFunctionInputSchema = z.object({
  kind: ProfileGroupFunctionKindSchema,
  functionId: z.string().min(1).max(256),
  action: z.string().min(1).max(128),
  endpointSlug: z.string().min(1).max(128).optional(),
  workflowRevision: z.number().int().positive().optional(),
  policy: ProfileEndpointPolicySchema,
  connectorBindings: z.record(z.string().min(1), ProfileGroupConnectorPinSchema).default({}),
}).strict().superRefine((input, ctx) => {
  if (input.kind === 'endpoint' && !input.endpointSlug) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endpointSlug'], message: 'endpoint functions require endpointSlug' });
  }
  if (input.kind === 'workflow' && input.endpointSlug !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endpointSlug'], message: 'workflow functions cannot carry endpointSlug' });
  }
});
export type ProfileGroupFunctionInput = z.infer<typeof ProfileGroupFunctionInputSchema>;

export const ProfileGroupBusinessInputSchema = z.object({
  businessId: z.string().min(1).max(256),
  businessVersion: z.string().min(1).max(128),
  manifestDigest: z.string().min(1).max(256),
  functions: z.array(ProfileGroupFunctionInputSchema).min(1).max(256),
}).strict();
export type ProfileGroupBusinessInput = z.infer<typeof ProfileGroupBusinessInputSchema>;

export const ProfileGroupSaveSchema = z.object({
  name: ProfileGroupNameSchema,
  tenantId: z.string().uuid().optional(),
  apiKey: ProfileGroupApiKeyRefSchema,
  expectedRevision: ProfileGroupRevisionSchema,
  businesses: z.array(ProfileGroupBusinessInputSchema).min(1).max(64),
}).strict();
export type ProfileGroupSave = z.infer<typeof ProfileGroupSaveSchema>;

export const ProfileGroupRollbackSchema = z.object({
  expectedRevision: ProfileGroupRevisionSchema,
  targetRevision: ProfileGroupRevisionSchema.min(1),
}).strict();
export type ProfileGroupRollback = z.infer<typeof ProfileGroupRollbackSchema>;

/**
 * PC-R07 — the parameter source mapping discovery hands to the editor so each
 * parameter is saved only to its declared effective source.
 *
 * Canonical literals are the master plan's (`requestDefaults | profileSettings`)
 * and match the manifest capability (`ParameterResolutionCapabilitySchema` in
 * `manifest.ts`). The follow-up dispatch used `policySettings` for the same
 * concept; it is accepted as a transitional input alias and normalized to
 * `profileSettings`, so the wire carries exactly one vocabulary.
 */
export const ParameterSourceSchema = z
  .enum(['requestDefaults', 'profileSettings', 'policySettings'])
  .transform((value) => (value === 'policySettings' ? 'profileSettings' : value));
export type ParameterSource = z.infer<typeof ParameterSourceSchema>;

/** `{ <property>: <source> }` — one source per declared property, never inferred. */
export const ParameterResolutionSchema = z.record(
  z.string().min(1).max(128),
  ParameterSourceSchema,
);
export type ParameterResolution = z.infer<typeof ParameterResolutionSchema>;

export const ProfileGroupFunctionSchema = z.object({
  kind: ProfileGroupFunctionKindSchema,
  functionId: z.string().min(1),
  action: z.string().min(1),
  endpointSlug: z.string().min(1).optional(),
  workflowRevision: z.number().int().positive().optional(),
  manifestDigest: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  profileSchema: z.record(z.string(), z.unknown()),
  uiSchema: z.record(z.string(), z.unknown()).optional(),
  /**
   * PC-R07: the manifest's declared source for each parameter property.
   * Absent = the manifest declares no capability (v1 semantics: no inference).
   */
  parameterResolution: ParameterResolutionSchema.optional(),
  /** False only when the registered descriptor cannot be selected by the current admission facade. */
  available: z.boolean(),
  unavailableReason: z.string().min(1).optional(),
  connectorSlots: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean(),
    acceptedCapabilities: z.array(z.string().min(1)),
    allowedModelOptions: z.array(z.string()).optional(),
    promptConfigSchema: z.record(z.string(), z.unknown()).optional(),
  }).strict()),
}).strict();
export type ProfileGroupFunction = z.infer<typeof ProfileGroupFunctionSchema>;

export const ProfileGroupFunctionBindingSchema = z.object({
  kind: ProfileGroupFunctionKindSchema,
  functionId: z.string().min(1),
  action: z.string().min(1),
  endpointSlug: z.string().min(1).optional(),
  workflowRevision: z.number().int().positive().optional(),
  manifestDigest: z.string().min(1),
  childProfileId: z.string().uuid(),
  childRevision: z.number().int().positive(),
  enabled: z.boolean(),
  policy: ProfileEndpointPolicyReadSchema,
  connectorBindings: z.record(z.string().min(1), ProfileGroupConnectorPinSchema),
}).strict();
export type ProfileGroupFunctionBinding = z.infer<typeof ProfileGroupFunctionBindingSchema>;

export const ProfileGroupBusinessSchema = z.object({
  businessId: z.string().min(1),
  businessVersion: z.string().min(1),
  manifestDigest: z.string().min(1),
  functions: z.array(ProfileGroupFunctionBindingSchema),
}).strict();
export type ProfileGroupBusiness = z.infer<typeof ProfileGroupBusinessSchema>;

export const ProfileGroupSchema = z.object({
  groupId: z.string().uuid(),
  name: ProfileGroupNameSchema,
  tenantId: z.string().uuid(),
  revision: ProfileGroupRevisionSchema,
  apiKey: z.object({
    apiKeyId: z.string().uuid(),
    prefix: z.string().min(1),
    status: z.string().min(1),
  }).strict(),
  businesses: z.array(ProfileGroupBusinessSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ProfileGroup = z.infer<typeof ProfileGroupSchema>;

export const ProfileGroupListSchema = z.object({ groups: z.array(ProfileGroupSchema) }).strict();
export type ProfileGroupList = z.infer<typeof ProfileGroupListSchema>;

export const ProfileGroupFunctionCatalogSchema = z.object({
  businessId: z.string().min(1),
  businessVersion: z.string().min(1),
  manifestDigest: z.string().min(1),
  businessEnabled: z.boolean(),
  functions: z.array(ProfileGroupFunctionSchema),
}).strict();
export type ProfileGroupFunctionCatalog = z.infer<typeof ProfileGroupFunctionCatalogSchema>;

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

/**
 * PC-04 / 0070 `api_keys.key_mode` — the explicit authority mode of one key.
 *
 * Three values, frozen:
 *  - `GROUP_MANAGED`    authorized only by a current root grant (no child fallback);
 *  - `LEGACY_STANDALONE` legacy profile membership/self-service semantics;
 *  - `UNMANAGED_LEGACY`  proven never-associated legacy no-profile key.
 *
 * A missing or unknown value is an authorization error, never a fallback
 * (0070 deliberately has no DEFAULT). Finite list so writers, the resolver and
 * the UI cannot drift on the spelling.
 */
export const API_KEY_MODES = [
  'GROUP_MANAGED',
  'LEGACY_STANDALONE',
  'UNMANAGED_LEGACY',
] as const;
export const ApiKeyModeSchema = z.enum(API_KEY_MODES);
export type ApiKeyMode = z.infer<typeof ApiKeyModeSchema>;


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
  /**
   * PC-R04: the AI settings revision that shaped the admitted defaults.
   * Optional for callers written before PC-R04; the legacy single revision
   * below fills this slot when the field is null/absent.
   */
  tenantDefaultsAiRevision?: number | null;
  /** PC-R04: the prompt settings revision, a distinct fingerprint input. */
  tenantDefaultsPromptRevision?: number | null;
  /** PC-R04: digest of the exact tenant-defaults snapshot admitted for execution. */
  tenantDefaultsDigest?: string | null;
  /**
   * @deprecated PC-R04 back-compat — a single defaults revision from pre-R04
   * callers. Folded into `tenantDefaultsAiRevision` when that is null/absent;
   * the prompt revision then contributes `null`.
   */
  tenantDefaultsRevision?: number | null;
  connectorBindings: readonly ProfileGroupConnectorBindingRefV2[];
  workflow: { slug?: string; revision: number; digest: string } | null;
  submission: Submission;
}

const FINGERPRINT_DOMAIN = 'du.profile-resolution';
/**
 * The payload is versioned by its CONTENT: PC-R04 extended it (defaults are now
 * three inputs, workflows carry a slug), so a fingerprint produced by the
 * pre-R04 build is intentionally incomparable. The value is never stored as
 * authority — the server recomputes it at submit time (plan §"DTO and route
 * contract"), so a rolling deploy can only produce a fail-closed
 * `409 PROFILE_CHANGED`, never a stale acceptance.
 */
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
  // PC-R04: AI and prompt settings revisions are separate inputs, and the
  // legacy single revision folds into the AI slot so pre-R04 callers keep
  // meaningful (and distinct from prompt-only) fingerprints.
  const tenantDefaultsAiRevision =
    parts.tenantDefaultsAiRevision ?? parts.tenantDefaultsRevision ?? null;
  const tenantDefaultsPromptRevision = parts.tenantDefaultsPromptRevision ?? null;
  const tenantDefaultsDigest = parts.tenantDefaultsDigest ?? null;
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
    tenantDefaultsAiRevision,
    tenantDefaultsPromptRevision,
    tenantDefaultsDigest,
    connectorBindings,
    // PC-R04: a workflow pin carries its registry slug as well as revision and
    // digest. `slug` is normalized to null so an omitted slug is one identity.
    workflow: parts.workflow
      ? {
          slug: parts.workflow.slug ?? null,
          revision: parts.workflow.revision,
          digest: parts.workflow.digest,
        }
      : null,
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

/**
 * `POST /api/v2/profile-groups/:groupId/preview` — public, `x-api-key` auth.
 *
 * The group is addressed by PATH only: a `groupId` in the body is an
 * unrecognized key, so a client can never claim one group's selector while
 * resolving another group's grant. `submission` is the unchanged v1
 * `Submission`, which keeps v2 preview/submit from drifting from v1 submission
 * semantics.
 *
 * These two request DTOs live here rather than in `public-api.ts` because
 * `public-api.ts` already sits inside the module cycle
 * `profile-policy -> profile-callback -> public-api`; an extra
 * `public-api -> profile-groups` edge makes that cycle fatal at import time
 * (`ProfileRevisionSchema` would still be undefined when this module is
 * evaluated mid-cycle). They remain exported from the package barrel.
 */
export const ProfileGroupPreviewV2RequestSchema = ProfileGroupFunctionSelectorV2Schema.extend({
  submission: SubmissionSchema,
}).strict();
export type ProfileGroupPreviewV2Request = z.infer<
  typeof ProfileGroupPreviewV2RequestSchema
>;

/**
 * `POST /api/v2/profile-groups/:groupId/operations` — the fingerprint the
 * preview returned is REQUIRED here (plan §"DTO and route contract": a stale
 * fingerprint is 409 `PROFILE_CHANGED` before any durable write).
 *
 * The `Idempotency-Key` header is validated separately with the existing
 * `IdempotencyKeySchema`; it is deliberately not part of the body. The
 * response is the existing `SubmitAckSchema`, unchanged.
 */
export const ProfileGroupSubmitV2RequestSchema =
  ProfileGroupPreviewV2RequestSchema.extend({
    resolutionFingerprint: ResolutionFingerprintSchema,
  }).strict();
export type ProfileGroupSubmitV2Request = z.infer<
  typeof ProfileGroupSubmitV2RequestSchema
>;

/* ------------------------------------------------------------------ */
/* V2 problem codes                                                   */
/* ------------------------------------------------------------------ */

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