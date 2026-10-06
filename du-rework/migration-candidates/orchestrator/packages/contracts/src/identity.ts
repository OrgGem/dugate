import { z } from 'zod';

/**
 * IDENTITY-WIRE (task IDENTITY-BFF-ROUTES, packet BFF-SETTINGS-IDENTITY): the
 * platform-side identity DTOs for the Admin BFF.
 *
 * These shapes mirror what the already-approved browser adapter expects
 * (`apps/admin-web/src/features/identity/identity-api.ts`) so the UI and the
 * BFF speak ONE contract rather than two that drift.
 *
 * Invariants:
 *
 *  - NO CREDENTIAL EVER RIDES HERE. There is no password hash, no API key and
 *    no session token field on any schema below. `CreateIdentityUser` takes a
 *    password to forward ONCE to the identity provider and never returns it;
 *    the user view is `.strict()` so an upstream field we did not model is
 *    rejected here rather than republished to the browser.
 *  - TENANT IS NOT A CALLER FIELD. No read or write schema accepts a tenant
 *    id from the client: the BFF derives it from the trusted session, so a
 *    caller cannot widen its own scope by editing a body.
 *  - WRITES ARE CAS-GUARDED. `expectedVersion` is mandatory on update; a
 *    stale version is refused upstream with 409 rather than silently
 *    last-write-wins.
 */

export const IDENTITY_ROLE_VALUES = ['ADMIN', 'USER', 'VIEWER'] as const;
export const IdentityRoleSchema = z.enum(IDENTITY_ROLE_VALUES);
export type IdentityRole = z.infer<typeof IdentityRoleSchema>;

export const IDENTITY_AUTH_MODES = ['local', 'oidc', 'both', 'unmanaged'] as const;
export const IdentityAuthModeSchema = z.enum(IDENTITY_AUTH_MODES);
export type IdentityAuthMode = z.infer<typeof IdentityAuthModeSchema>;

/**
 * Safe OIDC metadata. The issuer/client id/URLs are non-secret identifiers;
 * the client SECRET is deliberately absent from this shape.
 */
export const IdentityOidcMetadataSchema = z
  .object({
    issuer: z.string().min(1),
    clientId: z.string().min(1),
    callbackUrl: z.string().min(1),
    scopes: z.array(z.string()),
  })
  .strict();
export type IdentityOidcMetadata = z.infer<typeof IdentityOidcMetadataSchema>;

/** One user as the platform reports it. Never carries credential material. */
export const IdentityUserSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    role: IdentityRoleSchema,
    enabled: z.boolean(),
    locked: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** CAS token for updates; a stale value is refused with 409. */
    version: z.number().int().min(0),
  })
  .strict();
export type IdentityUser = z.infer<typeof IdentityUserSchema>;

/** Server-advertised capability. `userWriter` false ⇒ the UI must disable writes. */
export const IdentityCapabilitiesSchema = z
  .object({ userWriter: z.boolean() })
  .strict();
export type IdentityCapabilities = z.infer<typeof IdentityCapabilitiesSchema>;

export const IdentityAuthSchema = z
  .object({
    mode: IdentityAuthModeSchema,
    localEnabled: z.boolean(),
    oidc: IdentityOidcMetadataSchema.nullable(),
  })
  .strict();
export type IdentityAuth = z.infer<typeof IdentityAuthSchema>;

/** `GET /admin/api/identity` → this snapshot. */
export const IdentitySnapshotSchema = z
  .object({
    users: z.array(IdentityUserSchema),
    capabilities: IdentityCapabilitiesSchema,
    auth: IdentityAuthSchema,
  })
  .strict();
export type IdentitySnapshot = z.infer<typeof IdentitySnapshotSchema>;

/**
 * `POST /admin/api/identity/users` params.
 *
 * `password` is write-only and forwarded once; it appears in no response DTO.
 * The BFF validates `role` against the closed enum and never lets a caller
 * mint an ADMIN for itself — the role policy is server-owned (IDENTITY-ROLE-
 * POLICY), so the BFF forwards the requested role and lets the policy decide.
 */
export const CreateIdentityUserParamsSchema = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().min(1),
    role: IdentityRoleSchema,
  })
  .strict();
export type CreateIdentityUserParams = z.infer<typeof CreateIdentityUserParamsSchema>;

/**
 * `PATCH /admin/api/identity/users/:id` params.
 * `expectedVersion` is REQUIRED — omitting it is a validation error, not a
 * permission to write blind.
 */
export const UpdateIdentityUserParamsSchema = z
  .object({
    role: IdentityRoleSchema,
    enabled: z.boolean(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export type UpdateIdentityUserParams = z.infer<typeof UpdateIdentityUserParamsSchema>;

/**
 * Envelope the BFF returns for identity mutations: the user plus an audit
 * line, so a caller can see what was recorded without a second round trip.
 */
export const IdentityMutationResponseSchema = z
  .object({
    user: IdentityUserSchema,
    audit: z.object({ action: z.string().min(1), recordedAt: z.string() }).strict(),
  })
  .strict();
export type IdentityMutationResponse = z.infer<typeof IdentityMutationResponseSchema>;

/** Code used when a CAS version does not match (mirrors the connector fence). */
export const IDENTITY_VERSION_CONFLICT_CODE = 'IDENTITY_VERSION_CONFLICT';