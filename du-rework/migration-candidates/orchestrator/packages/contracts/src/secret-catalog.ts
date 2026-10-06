/**
 * SC-01 — Secret catalog contracts and the shared `ValueSource` tagged union.
 *
 * A secret catalog entry is a stable, tenant-scoped reference (immutable
 * `secretId`) with a display name, approved purpose/service permissions and a
 * provider that is either a managed value (write-only, encrypted before
 * persistence by the encryption owner) or a trusted Vault KV link.
 *
 * Security invariants encoded here:
 *  - `ValueSource` is an OBJECT tagged union only: `literal` or `secret_ref`.
 *    Ambiguous strings and implicit `vault://` parsing are rejected by
 *    `parseValueSourceStrict`.
 *  - No read schema carries a plaintext secret value. `valueConfigured` is the
 *    strongest readback a caller gets; a payload with a `value` key fails the
 *    read schemas (tested).
 *  - Vault links are locators (connection + mount + path + field + explicit
 *    version mode), never URLs or content hashes; path segments are bounded and
 *    traversal-free.
 *  - Service permissions are explicit; a listing does not grant resolution.
 *
 * Metadata persistence, repository and admin API (create/rotate/disable, CAS,
 * idempotency, audit, dependency index) are the SC-01 implementation slice on
 * top of this freeze; runtime resolution is SC-02 and never a public
 * resolve-to-plaintext API.
 */
import { z } from 'zod';

export const SECRET_CATALOG_VERSION = 1 as const;

/** Bounds. Literal values may be PEMs; readback is forbidden regardless. */
export const SECRET_LITERAL_MAX_CHARS = 64 * 1024;
export const SECRET_NAME_MAX_CHARS = 128;
export const SECRET_PATH_MAX_CHARS = 1024;
export const SECRET_USAGE_REFERENCES_MAX = 64;

/** Approved consumer slots. A purpose is required; a listing never resolves. */
export const SECRET_PURPOSES = [
  'connector.credential',
  'connector.provider_header',
  'profile.callback_header',
  'profile.callback_oauth2_client_secret',
  'oidc.client_secret',
  'source.auth',
  'generic',
] as const;
export const SecretPurposeSchema = z.enum(SECRET_PURPOSES);
export type SecretPurpose = z.infer<typeof SecretPurposeSchema>;

/** Which service may resolve an entry. Workers resolve via runtime, not directly. */
export const SECRET_SERVICES = ['orchestrator', 'connector'] as const;
export const SecretServiceSchema = z.enum(SECRET_SERVICES);
export type SecretService = z.infer<typeof SecretServiceSchema>;

export const SecretStateSchema = z.enum(['ACTIVE', 'DISABLED', 'REVOKED']);
export type SecretState = z.infer<typeof SecretStateSchema>;

/* ------------------------------------------------------------------ */
/* ValueSource tagged union                                            */
/* ------------------------------------------------------------------ */

/**
 * Write-only literal. Credential literals MUST be encrypted/secret-managed
 * before persistence even though the user chose Text; this schema only carries
 * the value from the write boundary to the writer. It never appears in a read
 * shape, HTML, API readback, logs, audit or test diagnostics.
 */
export const LiteralValueSourceSchema = z
  .object({
    kind: z.literal('literal'),
    value: z
      .string()
      .min(1)
      .max(SECRET_LITERAL_MAX_CHARS)
      .refine((value) => !value.includes('\u0000'), { message: 'literal must not contain NUL' }),
  })
  .strict();
export type LiteralValueSource = z.infer<typeof LiteralValueSourceSchema>;

export const SecretRefValueSourceSchema = z
  .object({
    kind: z.literal('secret_ref'),
    secretId: z.string().uuid(),
  })
  .strict();
export type SecretRefValueSource = z.infer<typeof SecretRefValueSourceSchema>;

export const ValueSourceSchema = z.discriminatedUnion('kind', [
  LiteralValueSourceSchema,
  SecretRefValueSourceSchema,
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

export type ValueSourceParseErrorCode = 'AMBIGUOUS_STRING' | 'INVALID_VALUE_SOURCE';

export class ValueSourceParseError extends Error {
  public readonly code: ValueSourceParseErrorCode;

  public constructor(code: ValueSourceParseErrorCode, message: string) {
    super(message);
    this.name = 'ValueSourceParseError';
    this.code = code;
  }
}

export function isValueSource(input: unknown): input is ValueSource {
  return ValueSourceSchema.safeParse(input).success;
}

/**
 * Strict parse: an ambiguous single string (including anything that looks like
 * `vault://…`) is an explicit error, never interpreted. Callers must decide
 * between `{kind:'literal'}` and `{kind:'secret_ref'}`.
 */
export function parseValueSourceStrict(input: unknown): ValueSource {
  if (typeof input === 'string') {
    throw new ValueSourceParseError(
      'AMBIGUOUS_STRING',
      'ValueSource must be tagged ({kind:"literal"|"secret_ref"}); implicit string/vault:// parsing is not allowed',
    );
  }
  const parsed = ValueSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValueSourceParseError('INVALID_VALUE_SOURCE', 'ValueSource failed schema validation');
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Readback shapes: safe metadata only, never a value                  */
/* ------------------------------------------------------------------ */

/**
 * The only literal readback a caller may ever see. A read payload that carries
 * a `value` key fails `.strict()`.
 */
export const LiteralValueSourceReadSchema = z
  .object({
    kind: z.literal('literal'),
    configured: z.literal(true),
  })
  .strict();
export type LiteralValueSourceRead = z.infer<typeof LiteralValueSourceReadSchema>;

/** Safe secret-reference metadata: name + Secret badge + state, no value. */
export const SecretRefReadMetadataSchema = z
  .object({
    kind: z.literal('secret_ref'),
    secretId: z.string().uuid(),
    name: z.string().min(1).max(SECRET_NAME_MAX_CHARS),
    state: SecretStateSchema,
    revision: z.number().int().min(1),
  })
  .strict();
export type SecretRefReadMetadata = z.infer<typeof SecretRefReadMetadataSchema>;

export const ValueSourceReadSchema = z.discriminatedUnion('kind', [
  LiteralValueSourceReadSchema,
  SecretRefReadMetadataSchema,
]);
export type ValueSourceRead = z.infer<typeof ValueSourceReadSchema>;

/** Documents the security decision enforced by the read schemas above. */
export const SECRET_VALUE_RESOLVE_API = 'none' as const;

/* ------------------------------------------------------------------ */
/* Providers                                                            */
/* ------------------------------------------------------------------ */

/** Value is managed (write-only) by the approved secret backend. */
export const ManagedValueProviderSchema = z.object({ kind: z.literal('managed_value') }).strict();
export type ManagedValueProvider = z.infer<typeof ManagedValueProviderSchema>;

const VAULT_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateVaultPath(path: string, ctx: z.RefinementCtx): void {
  if (
    path.length === 0 ||
    path.length > SECRET_PATH_MAX_CHARS ||
    path.startsWith('/') ||
    path.includes('://') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'vault path must be a relative logical path without scheme/control characters' });
    return;
  }
  const segments = path.split('/');
  if (segments.length > 16) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'vault path has too many segments' });
    return;
  }
  segments.forEach((segment, index) => {
    if (segment.length === 0 || segment === '.' || segment === '..' || !VAULT_SEGMENT_RE.test(segment)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['path', index], message: 'invalid vault path segment' });
    }
  });
}

/** Explicit version mode; `latest` never silently pins a stale version. */
export const VaultVersionModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('pinned'), version: z.number().int().min(1) }).strict(),
  z.object({ mode: z.literal('latest') }).strict(),
]);
export type VaultVersionMode = z.infer<typeof VaultVersionModeSchema>;

/** Trusted Vault KV link: a locator, never a URL or content hash. */
const VaultReferenceProviderObjectSchema = z
  .object({
    kind: z.literal('vault_reference'),
    /** Configured trusted Vault connection; capability-gated at runtime. */
    connectionId: z.string().min(1).max(128),
    mount: z.string().regex(VAULT_SEGMENT_RE, { message: 'mount must be a single vault segment' }),
    path: z.string(),
    field: z.string().regex(VAULT_SEGMENT_RE, { message: 'field must be a single vault segment' }),
    namespace: z.string().min(1).max(256).optional(),
    version: VaultVersionModeSchema,
  })
  .strict();

export const VaultReferenceProviderSchema = VaultReferenceProviderObjectSchema.superRefine(
  (provider, ctx) => {
    validateVaultPath(provider.path, ctx);
  },
);
export type VaultReferenceProvider = z.infer<typeof VaultReferenceProviderSchema>;

/** Managed value or Vault link; the vault branch validates its path locator. */
export const SecretProviderSchema = z.union([
  ManagedValueProviderSchema,
  VaultReferenceProviderSchema,
]);
export type SecretProvider = z.infer<typeof SecretProviderSchema>;

/* ------------------------------------------------------------------ */
/* Catalog entry + write/read DTOs                                     */
/* ------------------------------------------------------------------ */

export const SecretUsageReferenceSchema = z
  .object({
    kind: z.enum(['connector_credential', 'profile_callback', 'oidc_client', 'source_auth']),
    /** Stable consumer identity; rename of the secret never rebinds consumers. */
    refId: z.string().min(1).max(256),
    revision: z.number().int().min(1).optional(),
  })
  .strict();
export type SecretUsageReference = z.infer<typeof SecretUsageReferenceSchema>;

export const SecretRotationMetadataSchema = z
  .object({
    rotatedAt: z.string().datetime().nullable(),
    /** Provider capability; absent means rotation is manual. */
    intervalDays: z.number().int().min(1).max(3650).nullable(),
  })
  .strict();
export type SecretRotationMetadata = z.infer<typeof SecretRotationMetadataSchema>;

/**
 * The stored catalog record. It carries NO value: managed values live in the
 * encrypted secret backend, vault links live in Vault.
 */
const SecretCatalogEntryObjectSchema = z
  .object({
    catalogVersion: z.literal(SECRET_CATALOG_VERSION),
    secretId: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z
      .string()
      .min(1)
      .max(SECRET_NAME_MAX_CHARS)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, { message: 'name is a display label without control characters' }),
    purpose: SecretPurposeSchema,
    services: z.array(SecretServiceSchema).min(1).max(SECRET_SERVICES.length),
    provider: SecretProviderSchema,
    state: SecretStateSchema,
    revision: z.number().int().min(1),
    rotation: SecretRotationMetadataSchema.optional(),
  })
  .strict();

function refineUniqueServices(
  entry: { readonly services: readonly SecretService[] },
  ctx: z.RefinementCtx,
): void {
  if (new Set(entry.services).size !== entry.services.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['services'], message: 'duplicate service permission' });
  }
}

export const SecretCatalogEntrySchema = SecretCatalogEntryObjectSchema.superRefine(refineUniqueServices);
export type SecretCatalogEntry = z.infer<typeof SecretCatalogEntrySchema>;

/**
 * Read projection: the entry plus `valueConfigured` and usage references.
 * `.strict()` with no `value` member is the no-plaintext-readback fence.
 */
export const SecretCatalogEntryReadSchema = SecretCatalogEntryObjectSchema.extend({
  valueConfigured: z.boolean(),
  usageReferences: z.array(SecretUsageReferenceSchema).max(SECRET_USAGE_REFERENCES_MAX),
})
  .strict()
  .superRefine(refineUniqueServices);
export type SecretCatalogEntryRead = z.infer<typeof SecretCatalogEntryReadSchema>;

/**
 * Create/link payload. `managed_value` requires a literal at create time (the
 * writer encrypts it before persistence); `vault_reference` forbids a value.
 */
export const SecretCatalogCreateSchema = z
  .object({
    tenantId: z.string().uuid(),
    name: z
      .string()
      .min(1)
      .max(SECRET_NAME_MAX_CHARS)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, { message: 'name is a display label without control characters' }),
    purpose: SecretPurposeSchema,
    services: z.array(SecretServiceSchema).min(1).max(SECRET_SERVICES.length),
    provider: SecretProviderSchema,
    /** Required for managed_value; forbidden for vault_reference. */
    value: LiteralValueSourceSchema.optional(),
  })
  .strict()
  .superRefine((create, ctx) => {
    if (create.provider.kind === 'managed_value' && create.value === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'managed_value requires a write-only literal value' });
    }
    if (create.provider.kind === 'vault_reference' && create.value !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'vault_reference must not carry a value' });
    }
  });
export type SecretCatalogCreate = z.infer<typeof SecretCatalogCreateSchema>;

/** Rotation: CAS-guarded, write-only literal replacement. */
export const SecretCatalogRotateSchema = z
  .object({
    secretId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    value: LiteralValueSourceSchema,
  })
  .strict();
export type SecretCatalogRotate = z.infer<typeof SecretCatalogRotateSchema>;

/** Explicit clear is separate from "omitted means preserve". */
export const SecretCatalogDisableSchema = z
  .object({
    secretId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    reason: z.string().min(1).max(512),
  })
  .strict();
export type SecretCatalogDisable = z.infer<typeof SecretCatalogDisableSchema>;

/** Bounded list projection; listing never resolves a value. */
export const SecretCatalogListPageSchema = z
  .object({
    items: z.array(SecretCatalogEntryReadSchema).max(200),
    nextCursor: z.string().min(1).max(2048).nullable(),
  })
  .strict();
export type SecretCatalogListPage = z.infer<typeof SecretCatalogListPageSchema>;
