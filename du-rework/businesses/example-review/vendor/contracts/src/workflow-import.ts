import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  LEGACY_WORKFLOW_MAX_BYTES,
  LegacyWorkflowSchemaSchema,
} from './legacy-workflow';

export const WorkflowImportPreviewRequestSchema = z.object({
  tenantId: z.string().uuid(),
  format: z.enum(['json', 'xml']),
  source: z.string().min(1).max(LEGACY_WORKFLOW_MAX_BYTES),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(value.source, 'utf8') > LEGACY_WORKFLOW_MAX_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'Workflow source exceeds the 512 KiB import limit' });
  }
});
export type WorkflowImportPreviewRequest = z.infer<typeof WorkflowImportPreviewRequestSchema>;

export const WorkflowImportEgressRequirementSchema = z.object({
  nodeId: z.string().min(1).max(64),
  kind: z.enum(['callback', 'file_url_download']),
  staticOrigins: z.array(z.string().url()).max(16),
  dynamic: z.boolean(),
}).strict();

export const WorkflowImportPreviewResponseSchema = z.object({
  tenantId: z.string().uuid(),
  format: z.enum(['json', 'xml']),
  schema: LegacyWorkflowSchemaSchema,
  connectorNames: z.array(z.string().min(1).max(128)).max(32),
  egress: z.array(WorkflowImportEgressRequirementSchema).max(128),
  sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type WorkflowImportPreviewResponse = z.infer<typeof WorkflowImportPreviewResponseSchema>;

export function workflowImportSourceDigest(source: string): string {
  return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}
