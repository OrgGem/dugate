import { z } from 'zod';
import { ProfileConnectionsOverrideSchema } from './profile-policy';

const SafeProfileParameterKeySchema = z.string().min(1).max(128).refine(
  (key) => !['__proto__', 'prototype', 'constructor'].includes(key),
  'reserved profile parameter names cannot be edited',
);

/** Narrow local USER command. Values are patched by key; lock state, endpoint
 * enablement, connector pins, credentials, priority and all other core policy
 * remain server-owned and cannot be represented by this DTO. */
export const ProfileSelfServiceEditRequestSchema = z.object({
  tenantId: z.string().uuid(),
  profileId: z.string().uuid(),
  businessId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/),
  businessVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/),
  profileName: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  expectedRevision: z.number().int().min(1).max(1_000_000_000),
  parameterValues: z.record(SafeProfileParameterKeySchema, z.unknown()).superRefine((parameters, context) => {
    if (Object.keys(parameters).length > 64) context.addIssue({ code: z.ZodIssueCode.custom, message: 'At most 64 Profile parameters may be edited at once' });
  }).optional(),
  connectionsOverride: ProfileConnectionsOverrideSchema.max(32).optional(),
}).strict().superRefine((input, context) => {
  if (input.parameterValues === undefined && input.connectionsOverride === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'parameterValues or connectionsOverride is required' });
  }
});
export type ProfileSelfServiceEditRequest = z.infer<typeof ProfileSelfServiceEditRequestSchema>;

export const ProfileSelfServiceEditResponseSchema = z.object({
  tenantId: z.string().uuid(),
  profileId: z.string().uuid(),
  revision: z.number().int().min(1),
  replayed: z.boolean().default(false),
}).strict();
export type ProfileSelfServiceEditResponse = z.infer<typeof ProfileSelfServiceEditResponseSchema>;

export const ProfileSelfServiceAssignedQuerySchema = z.object({
  query: z.string().max(128).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ProfileSelfServiceAssignedQuery = z.infer<typeof ProfileSelfServiceAssignedQuerySchema>;

export const ProfileSelfServiceAssignedEndpointSchema = z.object({
  profileId: z.string().uuid(),
  tenantId: z.string().uuid(),
  businessId: z.string().min(1).max(128),
  businessVersion: z.string().min(1).max(128),
  profileName: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
  endpointSlug: z.string().min(1).max(128).nullable(),
  revision: z.number().int().min(1).max(1_000_000_000),
  /** Exact immutable Connector pins; IDs/revisions only, never credentials. */
  connectorBindings: z.record(z.string().min(1).max(128), z.object({
    connectorId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
  }).strict()).superRefine((bindings, context) => {
    if (Object.keys(bindings).length > 32) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Profile has too many Connector bindings' });
  }),
  /** Active manifest input schema; no connector credentials or endpoint core policy. */
  inputSchema: z.record(z.string(), z.unknown()),
  /** Secret-shaped parameter names are removed server-side. */
  parameters: z.record(SafeProfileParameterKeySchema, z.object({
    value: z.unknown(),
    isLocked: z.boolean().optional(),
  }).strict()).superRefine((parameters, context) => {
    if (Object.keys(parameters).length > 64) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Profile has too many parameters for assigned editing' });
  }),
  connectionsOverride: ProfileConnectionsOverrideSchema.max(32),
}).strict();
export type ProfileSelfServiceAssignedEndpoint = z.infer<typeof ProfileSelfServiceAssignedEndpointSchema>;

export const ProfileSelfServiceAssignedPageSchema = z.object({
  tenantId: z.string().uuid(),
  items: z.array(ProfileSelfServiceAssignedEndpointSchema).max(100),
  nextCursor: z.string().max(2048).nullable(),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
}).strict();
export type ProfileSelfServiceAssignedPage = z.infer<typeof ProfileSelfServiceAssignedPageSchema>;

/** Exact active key membership available to this assigned local USER. This is
 * a paged address list only: no hash, raw credential, key mutation capability,
 * or tenant-wide key inventory is exposed. */
export const ProfileSelfServiceAssignedApiKeyQuerySchema = z.object({
  query: z.string().max(128).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ProfileSelfServiceAssignedApiKeyQuery = z.infer<typeof ProfileSelfServiceAssignedApiKeyQuerySchema>;

export const ProfileSelfServiceAssignedApiKeySchema = z.object({
  apiKeyId: z.string().uuid(),
  name: z.string().max(128).nullable(),
  prefix: z.string().max(32),
  status: z.literal('ACTIVE'),
}).strict();
export type ProfileSelfServiceAssignedApiKey = z.infer<typeof ProfileSelfServiceAssignedApiKeySchema>;

export const ProfileSelfServiceAssignedApiKeyPageSchema = z.object({
  tenantId: z.string().uuid(),
  profileId: z.string().uuid(),
  items: z.array(ProfileSelfServiceAssignedApiKeySchema).max(100),
  nextCursor: z.string().max(2048).nullable(),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
}).strict();
export type ProfileSelfServiceAssignedApiKeyPage = z.infer<typeof ProfileSelfServiceAssignedApiKeyPageSchema>;
