/**
 * Profiles Tab Parity — wire contracts for the Profile policy surface
 * (T-PROF-01 / T-DOC-01; plan Phan 3 Nhom B, C, D, E of
 * C:/Users/Gem/.claude/plans/typed-discovering-wall.md).
 *
 * Two rules this file encodes, and which must not be relaxed downstream:
 *
 *   1. WRITE vs READ are different schemas. `fileUrlAuthConfig` is accepted on
 *      write and is NEVER returned on read — the read shape carries
 *      `fileUrlAuthConfigured` instead (T-PROF-04 / T-API-01). A read schema
 *      that could hold a plaintext secret would be a contract that leaks.
 *   2. The stored secret is `FileUrlAuthCipherSchema`, the legacy
 *      `iv_hex:tag_hex:ciphertext_hex` string (12-byte IV = 24 hex, 16-byte
 *      tag = 32 hex). NOT a JSON envelope — self-review correction #1. The
 *      regex rejects a JSON envelope at the contract boundary rather than
 *      letting it reach the cipher and fail there for the wrong reason.
 *
 * Legacy sources being ported (verified, not re-invented):
 *   - `app/api/internal/profile-endpoints/route.ts` — upsert field set,
 *     `VALID_PRIORITIES`, non-admin restricted to
 *     parameters/connectionsOverride on an enabled endpoint (403 otherwise).
 *   - `lib/endpoints/profile-resolver.ts` — `ConnectionStep`,
 *     `mergeParameters` locked-field 400 (even on an identical value).
 *   - `lib/file-url-downloader.ts` — `FileUrlAuthConfig` field names
 *     (snake_case on the header/query variants: `header_name`, `header_value`,
 *     `query_key`, `query_value`).
 *   - `app/api/internal/ext-overrides/route.ts` — key-4 prompt override
 *     `(connectionId, apiKeyId, endpointSlug, stepId)` with `stepId`
 *     defaulting to `_default`, and `isActive:false` meaning DELETE.
 */

import { RequestRedactionRulesSchema } from './request-redaction';
import { ProfileCallbackPolicySchema } from './profile-callback';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared identifiers
// ---------------------------------------------------------------------------

/**
 * Business id + version + profile name. This triple is what the BFF Profile
 * routes carry in their path (`/admin/api/profiles/:b/:v/:n`) and what every
 * `profile.*` dispatcher action takes in `params`.
 *
 * A profileName is an endpoint slug in legacy terms: either a compound sub-case
 * slug (`extract.invoice`) or a bare service slug (`extract`). Validation
 * against the manifest happens server-side (T-API-03 "slug tồn tại"); this is
 * only the shape.
 */
export const ProfileKeySchema = z.object({
  businessId: z.string().min(1),
  businessVersion: z.string().min(1),
  profileName: z.string().min(1),
});
export type ProfileKey = z.infer<typeof ProfileKeySchema>;

/** Revision of an append-only `profile_bindings` row; CAS baseline (R-12). */
export const ProfileRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(1_000_000_000);
export type ProfileRevision = z.infer<typeof ProfileRevisionSchema>;

// ---------------------------------------------------------------------------
// Parameters (legacy `ProfileEndpoint.parameters`)
// ---------------------------------------------------------------------------

/**
 * One editable parameter: the value plus whether an administrator has locked
 * it. `value` is `unknown` because the value's real schema lives in the
 * business manifest's action slots; the profile layer only carries it through.
 *
 * `isLocked` is optional here because legacy rows were written both ways
 * (`{value,isLocked}` and a bare value). The merge logic
 * (T-PROF-02) treats a missing `isLocked` as `false`, matching
 * `dbParams[key]?.isLocked ?? schema?.defaultLocked ?? false`.
 */
export const ProfileParameterValueSchema = z
  .object({
    value: z.unknown(),
    isLocked: z.boolean().optional(),
  })
  .strict();
export type ProfileParameterValue = z.infer<typeof ProfileParameterValueSchema>;

/**
 * CR06-06: parameter keys that would carry a credential into an admission
 * snapshot. `parameters` is a passthrough bag (`value: unknown`), so without
 * this the snapshot could carry plaintext secrets verbatim.
 *
 * Suffix-anchored on purpose: `maxTokens`, `passwordPolicy` and `tokenizer`
 * are NOT credentials and must stay usable. The family prefixes (anything
 * starting with `fileUrlAuth`) are prefix-matched because that whole family is
 * the credential shape.
 */
export const SECRET_PARAMETER_KEY_PATTERNS: readonly RegExp[] = [
  /^fileurlauth/i,
  /token$/i,
  /password$/i,
  /passwd$/i,
  /secret$/i,
  /(^|[-_])api[-_]?key$/i,
  /authorization$/i,
  /credential$/i,
];

export function isSecretParameterKey(key: string): boolean {
  return SECRET_PARAMETER_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * The offending keys, so a caller can name them instead of guessing. Never
 * returns values: only key names leave this function.
 */
export function findSecretParameterKeys(parameters: unknown): string[] {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return [];
  return Object.keys(parameters as Record<string, unknown>)
    .filter((key) => isSecretParameterKey(key))
    .sort();
}

/**
 * `{ "<paramKey>": { value, isLocked } }`.
 *
 * The WRITE path (admin-authored profile revisions) deliberately carries values
 * verbatim — see the ADMIN-TRUSTED PIN contract. Credential keys are refused at
 * the SNAPSHOT instead (ProfileSnapshotParametersSchema), which is the boundary
 * where the value leaves the process.
 */
export const ProfileParametersSchema = z.record(
  z.string().min(1),
  ProfileParameterValueSchema,
);
export type ProfileParameters = z.infer<typeof ProfileParametersSchema>;

/**
 * CR06-06: `parameters` as they enter the ADMISSION SNAPSHOT. Same record, but
 * credential keys are refused, because this is what leaves the process.
 */
export const ProfileSnapshotParametersSchema = z
  .record(z.string().min(1), ProfileParameterValueSchema)
  .superRefine((parameters, ctx) => {
    for (const key of findSecretParameterKeys(parameters)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'parameter keys must not carry credentials; use the profile credential configuration instead',
      });
    }
  });

// ---------------------------------------------------------------------------
// Priority + extensions
// ---------------------------------------------------------------------------

/** Legacy `VALID_PRIORITIES` (`profile-endpoints/route.ts`). Same three, same spelling. */
export const ProfileJobPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type ProfileJobPriority = z.infer<typeof ProfileJobPrioritySchema>;

/** Legacy default when the column is absent or the value was unrecognized. */
export const PROFILE_JOB_PRIORITY_DEFAULT = 'MEDIUM';

/**
 * BullMQ `priority` the profile priority maps to at enqueue time (T-SUB-03).
 * Exposed here so the UI's priority select and the dispatcher cannot drift.
 *
 * BullMQ priority is INVERTED: a LOWER number runs FIRST. Legacy
 * `lib/pipelines/submit.ts:26-32` pins HIGH=1, MEDIUM=10, LOW=20, so the
 * mapping below is the exact legacy table — not a "weight" where bigger wins.
 */
export const PROFILE_JOB_PRIORITY_WEIGHTS: Record<ProfileJobPriority, number> =
  { LOW: 20, MEDIUM: 10, HIGH: 1 };

/**
 * Legacy `allowedFileExtensions`: a CSV string, stored trimmed as a whole.
 *
 * NOT a string[] and NOT a validated MIME list — correction #3: legacy only
 * `trim()`s on write and split/trim/drop-empty on read, with no MIME
 * whitelist, no case folding and no de-duplication. Validation beyond that
 * would be new behavior, not parity. Use `parseAllowedFileExtensions` at the
 * point of enforcement (T-SUB-03), never at the contract boundary.
 */
export const ProfileAllowedFileExtensionsSchema = z.string();

export const PROFILE_ALLOWED_FILE_EXTENSIONS_DEFAULT = '';

/**
 * Split the stored CSV into the extensions actually enforced at upload /
 * file-URL download / test-endpoint time. Order preserved; empty entries
 * dropped; case and duplicates preserved exactly as legacy did.
 */
export function parseAllowedFileExtensions(csv: string): string[] {
  return csv
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// ---------------------------------------------------------------------------
// connectionsOverride (legacy `ConnectionStep[]`)
// ---------------------------------------------------------------------------

/**
 * One hop of the connector chain (legacy `ConnectionStep`,
 * `profile-resolver.ts:10-15`). Optional fields are optional because the
 * legacy form omitted them rather than sending null.
 */
export const ConnectionStepSchema = z
  .object({
    slug: z.string().min(1),
    stepId: z.string().min(1).optional(),
    captureSession: z.string().nullable().optional(),
    injectSession: z.string().nullable().optional(),
  })
  .strict();
export type ConnectionStep = z.infer<typeof ConnectionStepSchema>;

/**
 * The override chain. Legacy also accepted a bare `string[]` of slugs and
 * normalized it to `{slug}`; that normalization happens once on write, so the
 * wire and the stored value are always `ConnectionStep[]`. A writer sending a
 * bare string[] is a schema error, not something to silently fix.
 */
export const ProfileConnectionsOverrideSchema = z.array(ConnectionStepSchema);
export type ProfileConnectionsOverride = z.infer<
  typeof ProfileConnectionsOverrideSchema
>;

// ---------------------------------------------------------------------------
// fileUrlAuthConfig — write only, encrypted at rest
// ---------------------------------------------------------------------------

/**
 * Legacy `FileUrlAuthConfig` (`lib/file-url-downloader.ts`), field names kept
 * verbatim including the snake_case header/query keys — the downloader reads
 * `header_name` off this object, so "cleaning" them to camelCase would break
 * the very consumer this ports.
 */
export const FileUrlAuthConfigSchema = z
  .object({
    type: z.enum(['none', 'bearer', 'header', 'query']),
    token: z.string().optional(),
    header_name: z.string().optional(),
    header_value: z.string().optional(),
    query_key: z.string().optional(),
    query_value: z.string().optional(),
  })
  .strict();
export type FileUrlAuthConfig = z.infer<typeof FileUrlAuthConfigSchema>;

/**
 * The AES-256-GCM storage form written by T-PROF-04, byte-compatible with
 * legacy `lib/crypto.ts`:
 *   - `iv`      : 12 random bytes as hex  -> 24 chars
 *   - `tag`     : 16-byte GCM auth tag hex -> 32 chars
 *   - `ciphertext`: any even length >= 2    -> >= 1 byte plaintext
 *
 * The three parts are hex so `split(':').length === 3` is a reliable
 * discriminator: a JSON envelope never parses as three hex parts, and legacy
 * plaintext JSON falls back to the plain-JSON read path instead of being
 * mistaken for ciphertext.
 */
export const FILE_URL_AUTH_CIPHER_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:([0-9a-f]{2})+$/;
export const FileUrlAuthCipherSchema = z
  .string()
  .regex(
    FILE_URL_AUTH_CIPHER_RE,
    'cipher must be iv_hex(24):tag_hex(32):ciphertext_hex — not a JSON envelope',
  );
export type FileUrlAuthCipher = z.infer<typeof FileUrlAuthCipherSchema>;

// ---------------------------------------------------------------------------
// ProfileEndpointPolicy — WRITE vs READ
// ---------------------------------------------------------------------------

/**
 * T-PROF-01 `ProfileEndpointPolicySchema` — the WRITE shape, i.e. the `policy`
 * object inside a `profile.upsert` `params`. Every field optional: legacy
 * treated an absent field as "leave unchanged" in the admin path, and the BFF
 * forwards `body.policy` through unvalidated today, so rejecting partial
 * policies would strand the Save button.
 *
 * `.strict()`: an unrecognized policy key is a typo or a stale client, and
 * failing closed with 422 INVALID_SCHEMA beats writing a field nobody reads.
 */
export const ProfileEndpointPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    parameters: ProfileParametersSchema.optional(),
    jobPriority: ProfileJobPrioritySchema.optional(),
    allowedFileExtensions: ProfileAllowedFileExtensionsSchema.optional(),
    /** Plaintext in; encrypted server-side before storage (T-PROF-04). */
    fileUrlAuthConfig: FileUrlAuthConfigSchema.optional(),
    connectionsOverride: ProfileConnectionsOverrideSchema.optional(),
    requestRedaction: RequestRedactionRulesSchema.optional(),
    /**
     * CB-02: the endpoint's callback delivery policy (frozen CB-01 shape).
     * Absent = leave unchanged on publish; explicit null clears it. The
     * admission writer pins the effective policy onto
     * `operations.callback_policy` (migration 0035/0036).
     */
    callbackPolicy: ProfileCallbackPolicySchema.nullable().optional(),
  })
  .strict();
export type ProfileEndpointPolicy = z.infer<typeof ProfileEndpointPolicySchema>;

/**
 * The READ shape of the same policy. Field-for-field the write schema MINUS
 * `fileUrlAuthConfig`, PLUS `fileUrlAuthConfigured`.
 *
 * The boolean is the whole difference: the UI needs to render "auth configured
 * (type=bearer)" without ever being able to read the token back. Decrypting
 * for a read would defeat the encryption-at-rest property for a display
 * convenience.
 */
export const ProfileEndpointPolicyReadSchema = z
  .object({
    enabled: z.boolean(),
    parameters: ProfileParametersSchema,
    jobPriority: ProfileJobPrioritySchema,
    allowedFileExtensions: ProfileAllowedFileExtensionsSchema,
    /** True when a cipher (or a legacy plaintext JSON config) is stored. */
    fileUrlAuthConfigured: z.boolean(),
    connectionsOverride: ProfileConnectionsOverrideSchema,
    requestRedaction: RequestRedactionRulesSchema.optional(),
    /** CB-02: stored callback policy metadata; never a secret value. */
    callbackPolicy: ProfileCallbackPolicySchema.nullable().optional(),
    /** WT-04: invalid stored pin; read-only, raw malformed content is never exposed. */
    callbackPolicyInvalid: z.literal(true).optional(),
  })
  .strict();
export type ProfileEndpointPolicyRead = z.infer<
  typeof ProfileEndpointPolicyReadSchema
>;

/**
 * The `policy` half of a saved revision on the read path — enough for the form
 * to repopulate, never enough to recover a secret.
 *
 * `id`/`profileId` is the profile identity that keys `profile_active_revisions`;
 * it is what publish/rollback address by way of `profileName` in the action
 * params.
 */
export const ProfileRevisionReadSchema = z
  .object({
    profileId: z.string().uuid(),
    profileName: z.string().min(1),
    businessId: z.string().min(1),
    businessVersion: z.string().min(1),
    /** True revision from the active pointer (T-API-01; no more `revision: 0`). */
    revision: ProfileRevisionSchema,
    /** Revision the append-only store holds; >= `revision`. */
    latestRevision: ProfileRevisionSchema,
    policy: ProfileEndpointPolicyReadSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ProfileRevisionRead = z.infer<typeof ProfileRevisionReadSchema>;

// ---------------------------------------------------------------------------
// Profile detail read — T-API-01 (fix ACUI-M02 `revision: 0`)
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/admin/profiles/{businessId}/{businessVersion}/{profileName}`
 * response.
 *
 * `businessId`/`businessVersion`/`profileName`/`revision`/`currentValues`/
 * `manifest`/`capabilities` keep the field names the existing HTML shell
 * fetcher already reads (`ProfileManifestWireRow` in
 * `src/app/admin/profile-section-data.ts`), so a real backend does not force a
 * second client edit. The only semantic change is that `revision` and
 * `currentValues` are real instead of `0`/`{}`.
 *
 * `capabilities` mirrors the manifest's connector capability options.
 */
export const ProfileDetailReadSchema = z
  .object({
    businessId: z.string().min(1),
    businessVersion: z.string().min(1),
    profileName: z.string().min(1),
    /** Active revision from `profile_active_revisions` (T-DB-02), never a placeholder. */
    revision: ProfileRevisionSchema,
    /** Flat `{"paramKey": "<value>"}` view of `policy.parameters` for the form grid. */
    currentValues: z.record(z.string(), z.string()),
    policy: ProfileEndpointPolicyReadSchema,
    /** Manifest actions with their slot/lock metadata; server-derived, not client-editable. */
    manifest: z.object({
      actions: z.array(z.record(z.string(), z.unknown())),
    }),
    capabilities: z.array(z.record(z.string(), z.unknown())),
    /**
     * T-API-01 closure (Δ7-A): the write identity of the API key this profile
     * belongs to — the detail read REVEALS it so the client can address the
     * `profile.*` commands (`apiKey.apiKeyId`), whose frozen `ProfileKey`
     * (business, version, name) cannot select a row on its own. A stored hash
     * is never exposed; only the opaque row id. Absent on the `/new`
     * blank-editor shape (no stored profile yet).
     */
    apiKeyId: z.string().uuid().optional(),
  })
  .strict();
export type ProfileDetailRead = z.infer<typeof ProfileDetailReadSchema>;

// ---------------------------------------------------------------------------
// Prompt override — key-4, legacy `ExternalApiOverride` (PAR-13, T-PROM-01)
// ---------------------------------------------------------------------------

/**
 * The composite key `(connectionId, apiKeyId, endpointSlug, stepId)`.
 * `stepId` defaults to `_default`, which is the "any step" bucket legacy
 * queried first before falling back to a per-step override.
 *
 * `connectionId` is a uuid: legacy's text ids are mapped once at import time
 * (correction #2 — no mixed text/uuid column).
 */
export const PromptOverrideKeySchema = z
  .object({
    connectionId: z.string().uuid(),
    apiKeyId: z.string().uuid(),
    endpointSlug: z.string().min(1),
    stepId: z.string().min(1).default('_default'),
  })
  .strict();
export type PromptOverrideKey = z.infer<typeof PromptOverrideKeySchema>;

/**
 * `prompt-override.upsert` params = key + content.
 *
 * `isActive` carries legacy's toggle. `false` means DELETE, not "park a disabled
 * row" — the repository must delete, because a stored row always means active.
 * Omitted means active.
 */
export const PromptOverrideUpsertParamsSchema = PromptOverrideKeySchema.extend({
  promptOverride: z.string().nullable(),
  isActive: z.boolean().default(true),
}).strict();
export type PromptOverrideUpsertParams = z.infer<
  typeof PromptOverrideUpsertParamsSchema
>;

/** `prompt-override.delete` params — the key alone. */
export const PromptOverrideDeleteParamsSchema = PromptOverrideKeySchema;
export type PromptOverrideDeleteParams = z.infer<
  typeof PromptOverrideDeleteParamsSchema
>;

/** Effective prompt resolution order (PAR-13 / R-06). Highest wins. */
export const PROMPT_OVERRIDE_PRECEDENCE = [
  'code',
  'profile',
  'connector',
] as const;
export type PromptOverridePrecedence = (typeof PROMPT_OVERRIDE_PRECEDENCE)[number];

/** Read shape: the override rows for one api key, with no secrets. */
export const PromptOverrideReadSchema = PromptOverrideKeySchema.extend({
  promptOverride: z.string().nullable(),
  isActive: z.boolean(),
  updatedAt: z.string().datetime(),
}).strict();
export type PromptOverrideRead = z.infer<typeof PromptOverrideReadSchema>;

// ---------------------------------------------------------------------------
// Scoped-user assignment — `user_profile_assignments` (T-AUTH-01, GATED)
// ---------------------------------------------------------------------------

/**
 * `assignment.grant` / `assignment.revoke` params. Assigns a local user to an
 * api KEY (legacy `requireProfileAccess(apiKeyId)` gates on key, not on a
 * profile id — see `lib/auth-guard.ts`).
 *
 * GATE: these actions exist in the contract from phase 1 so the wire is frozen,
 * but `T-AUTH-03` / `VFY-LOCAL` forbids the routes from reading the assignment
 * table to grant access until the local-auth receipt lands. Before that the
 * routes answer 503 with an explicit reason; they must never fall back to the
 * platform token (R-14 / ACUI-M07).
 */
export const UserProfileAssignmentParamsSchema = z
  .object({
    userId: z.string().uuid(),
    apiKeyId: z.string().uuid(),
  })
  .strict();
export type UserProfileAssignmentParams = z.infer<
  typeof UserProfileAssignmentParamsSchema
>;

/** Read shape for the assignment list; no secrets. */
export const UserProfileAssignmentReadSchema = z
  .object({
    userId: z.string().uuid(),
    apiKeyId: z.string().uuid(),
    grantedAt: z.string().datetime(),
  })
  .strict();
export type UserProfileAssignmentRead = z.infer<
  typeof UserProfileAssignmentReadSchema
>;

// ---------------------------------------------------------------------------
// Dispatcher action params (T-API-02) — exactly what the BFF forwards
// ---------------------------------------------------------------------------

/**
 * `profile.upsert` params. Mirrors `src/app/admin/bff/profiles.ts`, which
 * builds `{businessId, businessVersion, profileName, expectedRevision?, policy}`
 * and POSTs `{action, params}` to `/api/v1/admin/actions`.
 *
 * `expectedRevision` is optional: legacy treated a save with no prior view as a
 * blind upsert, so requiring it would break first-save. When supplied it is the
 * CAS baseline and a stale value is 409 (R-12 / T-API-03).
 *
 * Role split (NOT expressible in this schema — the dispatcher owns it):
 * admin = full-field; scoped-user = `parameters` + `connectionsOverride` only,
 * and only on an enabled endpoint, else 403.
 */
export const ProfileUpsertParamsSchema = ProfileKeySchema.extend({
  expectedRevision: ProfileRevisionSchema.optional(),
  policy: ProfileEndpointPolicySchema,
}).strict();
export type ProfileUpsertParams = z.infer<typeof ProfileUpsertParamsSchema>;

/**
 * `profile.publish` params. `expectedRevision` is REQUIRED — publish is a CAS
 * move ("the revision I saw becomes the active revision"), which is the whole
 * contract of the pointer in T-DB-02. The BFF already rejects a publish
 * without one (422), and this schema mirrors that.
 */
export const ProfilePublishParamsSchema = ProfileKeySchema.extend({
  expectedRevision: ProfileRevisionSchema,
}).strict();
export type ProfilePublishParams = z.infer<typeof ProfilePublishParamsSchema>;

/**
 * `profile.rollback` params. `targetRevision` is required (the revision to
 * point at); `expectedRevision` stays optional so a rollback can be issued
 * from a stale view when the operator explicitly does not care to CAS. Rolling
 * back MOVES THE POINTER — it never deletes or edits `profile_bindings` rows
 * (R-03).
 */
export const ProfileRollbackParamsSchema = ProfileKeySchema.extend({
  targetRevision: ProfileRevisionSchema,
  expectedRevision: ProfileRevisionSchema.optional(),
}).strict();
export type ProfileRollbackParams = z.infer<
  typeof ProfileRollbackParamsSchema
>;

/**
 * The discriminator the dispatcher switches on for the Profile slice. Kept as a
 * const so an action string typo fails at compile time rather than at runtime
 * with ACTION_NOT_FOUND.
 *
 * Note `profile.test-endpoint` is deliberately absent: T-UI-06's test route is
 * a plain HTTP passthrough (`POST /api/v1/admin/profile-test-endpoint`), not a
 * dispatcher action.
 */
export const PROFILE_DISPATCHER_ACTIONS = [
  'profile.upsert',
  'profile.publish',
  'profile.rollback',
  'prompt-override.upsert',
  'prompt-override.delete',
  'assignment.grant',
  'assignment.revoke',
] as const;
export type ProfileDispatcherAction = (typeof PROFILE_DISPATCHER_ACTIONS)[number];

/**
 * Server-side problem codes the Profile slice emits. `problem()` accepts any
 * string, but naming them here keeps the UI's error branches in one place.
 */
export const PROFILE_PROBLEM_CODES = {
  /** Client sent a locked parameter — 400, even when the value is identical (legacy mergeParameters). */
  PROFILE_LOCKED_FIELD: 'PROFILE_LOCKED_FIELD',
  /** Client sent a parameter the manifest does not know — 400. */
  PROFILE_UNKNOWN_FIELD: 'PROFILE_UNKNOWN_FIELD',
  /** Endpoint disabled, or scoped-user outside the assignment — 403. */
  PROFILE_FORBIDDEN: 'PROFILE_FORBIDDEN',
  /** No profile for this (key, business, version, action) — 404. */
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  /** `expectedRevision` no longer matches the active revision — 409. */
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  /** Endpoint slug is not in the manifest — 422. */
  PROFILE_SLUG_UNKNOWN: 'PROFILE_SLUG_UNKNOWN',
  /** File extension outside `allowedFileExtensions` — 422 (T-SUB-03). */
  PROFILE_EXTENSION_DENIED: 'PROFILE_EXTENSION_DENIED',
} as const;
export type ProfileProblemCode =
  (typeof PROFILE_PROBLEM_CODES)[keyof typeof PROFILE_PROBLEM_CODES];

/* --------------------------------------------------------------------------- */
/* T-SUB-02 admission-time snapshot DTO                                        */
/* --------------------------------------------------------------------------- */

/**
 * The credential reference the snapshot carries INSTEAD of the secret.
 *
 * `(tenantId, profileId, profileRevision)` names exactly ONE immutable row of
 * `profile_bindings`, and therefore exactly one `file_url_auth_cipher` cell.
 * Acquisition resolves this ref against the authenticated operation and
 * decrypts AT the fetch — the snapshot and the claim carry the pointer, never
 * the plaintext (PLAN04-01).
 */
export const ProfileCredentialRefSchema = z
  .object({
    /**
     * MEDIUM-2 (Part 2 Q1 (3)): defense-in-depth hardening — `uuid` instead
     * of a bare non-empty string. Every `tenant_id` column in the platform is
     * `uuid NOT NULL` (e.g. `0001_platform_v1.sql`, `0004_profile_bindings.sql`,
     * `0026_profile_policy.sql`), and this ref is written from the operation's
     * own `tenant_id`, so any value that is NOT a uuid is already an invalid
     * admission record. Rejecting it at the DTO is non-breaking for valid data.
     */
    tenantId: z.string().uuid(),
    /**
     * Deliberately NOT `.uuid()` (CR06-08). A profile is addressed by a
     * human-readable slug in legacy data — `default`, `custom-profile` — and
     * also by a uuid in newer rows, so this ref must accept both or a stored
     * snapshot written by an older writer would fail to parse. Tightening it
     * to uuid would break 100% of legacy profile ids with no security gain.
     *
     * Contrast with `tenantId` directly above: `tenants.id` is `uuid NOT NULL`
     * in every migration and is written from the operation's own `tenant_id`,
     * so a non-uuid tenant can only be a corrupt record and is rejected.
     */
    profileId: z.string().min(1),
    profileRevision: z.number().int().min(1),
  })
  .strict();
export type ProfileCredentialRef = z.infer<typeof ProfileCredentialRefSchema>;

/**
 * T-SUB-02 / PLAN04-01 — what `operations.profile_policy_snapshot` stores.
 *
 * This is a DELIBERATELY SEPARATE schema from both `ProfileEndpointPolicySchema`
(write, carries plaintext `fileUrlAuthConfig`) and
`ProfileEndpointPolicyReadSchema` (read, carries `fileUrlAuthConfigured`). It is
 * the admission-time record, and the difference is load-bearing:
 *
 *   - `fileUrlAuthConfig` is GONE. The snapshot records only whether auth was
 *     configured plus the immutable ref to the encrypted revision. A plaintext
 *     token/header/query has no representation here at all, so serializing the
 *     resolved policy into this column cannot leak one.
 *   - `credentialRef` is present so the acquisition path can resolve the
 *     ciphertext without the worker ever holding a raw credential.
 *   - `.strict()` at both levels. The previous claim-side policy schema used
 *     `.passthrough()`, which is why a raw secret survived into the claim even
 *     after the snapshot was written: an unrecognized key rode straight
 *     through. Unknown keys are now a fail-closed 422 at the boundary.
 */
export const ProfilePolicySnapshotSchema = z
  .object({
    enabled: z.boolean(),
    // CR06-06: snapshot-specific parameters schema — credential keys refused.
    parameters: ProfileSnapshotParametersSchema,
    jobPriority: ProfileJobPrioritySchema,
    /** CSV string, exactly as stored — parse with `parseAllowedFileExtensions`. */
    allowedFileExtensions: ProfileAllowedFileExtensionsSchema,
    connectionsOverride: ProfileConnectionsOverrideSchema,
    /**
     * Whether the PINNED revision has file-url auth configured. Booleans only —
     * this is the UI's whole need, and a boolean cannot carry a secret.
     */
    fileUrlAuthConfigured: z.boolean(),
    /**
     * Immutable pointer to the pinned revision's encrypted credential. Present
     * whether or not auth is configured, so the ref is always the same shape
     * and a consumer never has to infer one from the other.
     */
    credentialRef: ProfileCredentialRefSchema,
  })
  .strict();
export type ProfilePolicySnapshot = z.infer<typeof ProfilePolicySnapshotSchema>;
