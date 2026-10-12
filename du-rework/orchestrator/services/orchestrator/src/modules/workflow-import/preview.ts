import { legacyWorkflowConnectorNames, type LegacyWorkflowNode, type LegacyWorkflowSchema } from '@du/contracts';
import { decodeLegacyWorkflowJson, decodeLegacyWorkflowXml, LegacyWorkflowDecodeError } from '../../compat/legacy-workflow-decoders';
import {
  WorkflowImportPreviewRequestSchema,
  WorkflowImportPreviewResponseSchema,
  workflowImportSourceDigest,
} from '@du/contracts';
import { HttpError } from '../../http/errors';

function egressRequirements(schema: LegacyWorkflowSchema) {
  const result: { nodeId: string; kind: 'callback' | 'file_url_download'; staticOrigins: string[]; dynamic: boolean }[] = [];
  const visit = (nodes: readonly LegacyWorkflowNode[]) => {
    for (const node of nodes) {
      if (node.type === 'callback' || node.type === 'file_url_download') {
        const raw = node.type === 'callback' ? node.url : node.urls;
        const values: string[] = [];
        const collect = (value: unknown): void => {
          if (typeof value === 'string') values.push(value);
          else if (Array.isArray(value)) for (const item of value) collect(item);
          else if (value !== null && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            if (Object.hasOwn(record, 'url')) collect(record.url);
          }
        };
        collect(raw);
        const origins = new Set<string>();
        let dynamic = values.length === 0;
        for (const value of values) {
          if (/^\$[A-Za-z_][A-Za-z0-9_]*(?:\..+)?$/.test(value)) { dynamic = true; continue; }
          let parsed: URL;
          try { parsed = new URL(value); } catch { throw new HttpError(422, 'INVALID_SCHEMA', `workflow egress node "${node.id}" contains an invalid URL`); }
          if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
            throw new HttpError(422, 'INVALID_SCHEMA', `workflow egress node "${node.id}" must use HTTPS without credentials or fragments`);
          }
          origins.add(parsed.origin);
        }
        result.push({ nodeId: node.id, kind: node.type, staticOrigins: [...origins].sort(), dynamic });
      }
      if (node.type === 'parallel') for (const branch of node.branches ?? []) visit(branch);
    }
  };
  visit(schema.nodes);
  return result;
}

export function previewWorkflowImport(input: unknown) {
  const parsed = WorkflowImportPreviewRequestSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'workflow import source is invalid or exceeds the 512 KiB bound');
  const { tenantId, format, source } = parsed.data;
  let schema: LegacyWorkflowSchema;
  try {
    schema = format === 'xml' ? decodeLegacyWorkflowXml(source) : decodeLegacyWorkflowJson(source);
  } catch (error) {
    const message = error instanceof LegacyWorkflowDecodeError ? error.message : 'workflow import validation failed';
    throw new HttpError(422, 'INVALID_SCHEMA', message);
  }
  const response = {
    tenantId,
    format,
    schema,
    connectorNames: legacyWorkflowConnectorNames(schema),
    egress: egressRequirements(schema),
    sourceDigest: workflowImportSourceDigest(source),
  };
  const checked = WorkflowImportPreviewResponseSchema.safeParse(response);
  if (!checked.success) throw new HttpError(422, 'INVALID_SCHEMA', 'workflow import preview failed its response contract');
  return checked.data;
}
