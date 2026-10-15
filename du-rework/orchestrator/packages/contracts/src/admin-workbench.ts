import { z } from 'zod';
import { OperationViewSchema } from './operations';

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
