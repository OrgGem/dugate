import { z } from 'zod';
import {
  ProfileEndpointPolicyReadSchema,
  ProfileEndpointPolicySchema,
  ProfileRevisionSchema,
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
