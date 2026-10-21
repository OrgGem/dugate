import { z } from 'zod';
import { OperationViewSchema, SubmissionSchema } from './operations';
import {
  ProfileGroupFunctionSelectorV2Schema,
  ProfileGroupPreviewV2ResponseSchema,
  ResolutionFingerprintSchema,
} from './profile-groups';

export const ADMIN_WORKBENCH_CORE_ACTIONS = ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'] as const;
export const AdminWorkbenchCoreActionSchema = z.enum(ADMIN_WORKBENCH_CORE_ACTIONS);

const JsonObjectSchema = z.record(z.string().min(1).max(128), z.unknown()).superRefine((value, context) => {
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { /* rejected below */ }
  if (bytes > 32 * 1024) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Workbench parameters exceed 32 KiB' });
});

const SourceUrlSchema = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 's3:') && url.username === '' && url.password === '' && url.hash === '';
  } catch { return false; }
}, 'Source URL must be HTTPS or a tenant-authorized s3:// object reference');

export const AdminWorkbenchArtifactSchema = z.object({
  artifactId: z.string().uuid(),
  role: z.string().min(1).max(128),
}).strict();

export const AdminWorkbenchEndpointTestRequestSchema = z.object({
  tenantId: z.string().uuid(),
  apiKeyId: z.string().uuid(),
  businessId: z.literal('document-core'),
  businessVersion: z.string().min(1).max(128),
  action: AdminWorkbenchCoreActionSchema,
  profileName: z.string().min(1).max(120),
  expectedProfileRevision: z.number().int().positive(),
  /** Persisted selector from the exact saved Profile; null denotes an action-level Profile. */
  endpointSlug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).nullable().optional(),
  parameters: JsonObjectSchema,
  artifacts: z.array(AdminWorkbenchArtifactSchema).max(20).default([]),
  sourceUrl: SourceUrlSchema.optional(),
}).strict();
export type AdminWorkbenchEndpointTestRequest = z.infer<typeof AdminWorkbenchEndpointTestRequestSchema>;

export const AdminWorkbenchPromptWizardRequestSchema = z.object({
  tenantId: z.string().uuid(),
  apiKeyId: z.string().uuid(),
  businessVersion: z.string().min(1).max(128),
  profileName: z.string().min(1).max(120),
  expectedProfileRevision: z.number().int().positive(),
  currentPrompt: z.string().min(1).max(16_000),
  problem: z.string().max(4_000).default(''),
  endpointName: z.string().max(256).default(''),
  endpointSlug: z.string().max(128).default(''),
  connectorName: z.string().max(128).default(''),
  connectorSlug: z.string().max(128).default(''),
  stepId: z.string().max(128).default('_default'),
  wizardConnectorId: z.string().min(1).max(128),
  wizardConnectorRevision: z.number().int().positive(),
}).strict();
export type AdminWorkbenchPromptWizardRequest = z.infer<typeof AdminWorkbenchPromptWizardRequestSchema>;

export const AdminWorkbenchOperationAcceptedSchema = z.object({
  operationId: z.string().uuid(),
  operation: OperationViewSchema,
  replayed: z.boolean(),
}).strict();
export type AdminWorkbenchOperationAccepted = z.infer<typeof AdminWorkbenchOperationAcceptedSchema>;

/* ------------------------------------------------------------------ */
/* V2 profile-group workbench flow (PC-01)                             */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/internal/admin-workbench/v2/preview` — Admin-session/CSRF route
 * reusing the same resolver as the public v2 preview.
 *
 * `apiKeyId` is REQUIRED: the Admin must choose a specific current key, and the
 * server verifies that exact ACTIVE grant plus the local-user assignment. It
 * never selects "the first active grant"; an empty grant set disables submit
 * while leaving the config editor readable.
 *
 * `businessId` is a bounded string, not the v1 `z.literal('document-core')`,
 * because a v2 group function can target any registered business. The shell
 * still defaults to `document-core`.
 *
 * `endpointSlug: null` keeps the v1 meaning documented above: an action-level
 * profile (no persisted endpoint selector).
 */
export const AdminWorkbenchProfileSelectorV2Schema = ProfileGroupFunctionSelectorV2Schema.extend({
  tenantId: z.string().uuid(),
  apiKeyId: z.string().uuid(),
  endpointSlug: z.string().min(1).max(128).nullable().optional(),
}).strict();
export type AdminWorkbenchProfileSelectorV2 = z.infer<
  typeof AdminWorkbenchProfileSelectorV2Schema
>;

/** `POST /api/internal/admin-workbench/v2/preview` request. */
export const AdminWorkbenchProfilePreviewV2RequestSchema =
  AdminWorkbenchProfileSelectorV2Schema.extend({
    submission: SubmissionSchema,
  }).strict();
export type AdminWorkbenchProfilePreviewV2Request = z.infer<
  typeof AdminWorkbenchProfilePreviewV2RequestSchema
>;

/**
 * `POST /api/internal/admin-workbench/v2/submit` request — must carry the
 * fingerprint returned by the matching preview (plan: "The submit request must
 * carry the preview fingerprint"). `Idempotency-Key` stays a header.
 */
export const AdminWorkbenchProfileSubmitV2RequestSchema =
  AdminWorkbenchProfilePreviewV2RequestSchema.extend({
    resolutionFingerprint: ResolutionFingerprintSchema,
  }).strict();
export type AdminWorkbenchProfileSubmitV2Request = z.infer<
  typeof AdminWorkbenchProfileSubmitV2RequestSchema
>;

/** Preview response: the shared resolution preview plus the selected key echo. */
export const AdminWorkbenchProfilePreviewV2ResponseSchema = ProfileGroupPreviewV2ResponseSchema.extend({
  /** Echo of the explicitly selected key the preview resolved. */
  apiKeyId: z.string().uuid(),
}).strict();
export type AdminWorkbenchProfilePreviewV2Response = z.infer<
  typeof AdminWorkbenchProfilePreviewV2ResponseSchema
>;

/** Submit reuses the accepted-operation envelope unchanged (stale ⇒ 409 before this shape). */
export const AdminWorkbenchProfileSubmitV2ResponseSchema = AdminWorkbenchOperationAcceptedSchema;
