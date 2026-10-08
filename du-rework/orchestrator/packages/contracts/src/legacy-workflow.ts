import { z } from 'zod';
import { CallbackApprovedOriginSchema } from './profile-callback';

/**
 * Bounded wire contracts for the legacy Workflow Builder document format.
 * Node-specific execution remains in document-core; this module only freezes
 * the serialized schema and the immutable admission pin carried to workers.
 */

export const LEGACY_WORKFLOW_MAX_BYTES = 512 * 1024;
export const LEGACY_WORKFLOW_MAX_NODES = 128;
export const LEGACY_WORKFLOW_MAX_BRANCHES = 32;
export const LEGACY_WORKFLOW_MAX_FILES = 64;
export const LEGACY_WORKFLOW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const SafeKeySchema = z.string().min(1).max(128).refine(
  (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
  'Unsafe property name',
);

const LegacyInputPropertySchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'string[]', 'object']),
  label: z.string().max(256).optional(),
  required: z.boolean().optional(),
  widget: z.string().max(128).optional(),
  description: z.string().max(2048).optional(),
  default: z.unknown().optional(),
}).passthrough();

export const LegacyWorkflowNodeSchema: z.ZodType<LegacyWorkflowNode> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('connector'),
    description: z.string().max(2048).optional(), connector: z.string().min(1).max(128),
    promptOverrideKey: SafeKeySchema.optional(), inputs: z.record(SafeKeySchema, z.unknown()).optional(),
    outputPath: z.string().max(512).optional(),
    overrideConnector: z.object({
      prompt: z.string().max(64 * 1024).optional(), staticFormFields: z.string().max(64 * 1024).optional(),
      extraHeaders: z.string().max(16 * 1024).optional(), responseContentPath: z.string().max(512).optional(),
      timeoutSec: z.number().int().min(1).max(3600).optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('parallel'),
    description: z.string().max(2048).optional(), branches: z.array(z.array(z.lazy(() => LegacyWorkflowNodeSchema))).min(1).max(LEGACY_WORKFLOW_MAX_BRANCHES),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('join'),
    description: z.string().max(2048).optional(), combine: z.enum(['concat', 'first', 'merge']).optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('file_parse'),
    description: z.string().max(2048).optional(), source: z.unknown(), parser: z.enum(['auto', 'excel', 'word', 'pdf']).optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('file_url_download'),
    description: z.string().max(2048).optional(), urls: z.unknown(),
    auth: z.object({
      type: z.enum(['none', 'bearer', 'header', 'query']), token: z.string().max(8192).optional(),
      header_name: z.string().max(128).optional(), header_value: z.string().max(8192).optional(),
      query_key: z.string().max(128).optional(), query_value: z.string().max(8192).optional(),
    }).passthrough().optional(), allowedExtensions: z.string().max(1024).optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('callback'),
    description: z.string().max(2048).optional(), url: z.unknown(), payload: z.unknown().optional(),
    method: z.enum(['POST', 'GET']).optional(),
    auth: z.object({
      type: z.enum(['none', 'bearer', 'header', 'query']), token: z.string().max(8192).optional(),
      header_name: z.string().max(128).optional(), header_value: z.string().max(8192).optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('archive_compress'),
    description: z.string().max(2048).optional(), source: z.unknown(), name: z.string().max(255).optional(),
    level: z.number().int().min(0).max(9).optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('archive_extract'),
    description: z.string().max(2048).optional(), source: z.unknown(), destName: z.string().max(255).optional(),
    maxTotalBytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    maxEntries: z.number().int().min(1).max(1000).optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('human'),
    description: z.string().max(2048).optional(), message: z.string().min(1).max(4096),
    resumeInputs: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).max(LEGACY_WORKFLOW_MAX_NODES).optional(),
    nextStep: z.number().int().min(0).max(LEGACY_WORKFLOW_MAX_NODES).optional(),
  }).passthrough(),
  z.object({
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), type: z.literal('input'),
    description: z.string().max(2048).optional(), key: SafeKeySchema,
  }).passthrough(),
]) as z.ZodType<LegacyWorkflowNode>);

export interface LegacyWorkflowNodeBase {
  readonly id: string;
  readonly type: LegacyWorkflowNodeType;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export type LegacyWorkflowNodeType =
  | 'connector' | 'parallel' | 'join' | 'file_parse' | 'file_url_download'
  | 'callback' | 'archive_compress' | 'archive_extract' | 'human' | 'input';

export type LegacyWorkflowNode = LegacyWorkflowNodeBase & {
  readonly type: LegacyWorkflowNodeType;
  readonly branches?: readonly (readonly LegacyWorkflowNode[])[];
};

export const LegacyWorkflowSchemaSchema = z.object({
  slug: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  name: z.string().min(1).max(256),
  version: z.number().int().positive().optional(),
  description: z.string().max(4096).optional(),
  input_schema: z.object({
    type: z.literal('object'),
    properties: z.record(SafeKeySchema, LegacyInputPropertySchema),
  }).passthrough().optional(),
  nodes: z.array(LegacyWorkflowNodeSchema).min(1).max(LEGACY_WORKFLOW_MAX_NODES),
  flow: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).min(1).max(LEGACY_WORKFLOW_MAX_NODES),
  output: z.object({
    from: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    extra_data_from: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  }).passthrough().optional(),
}).passthrough();
export type LegacyWorkflowSchema = z.infer<typeof LegacyWorkflowSchemaSchema>;

/**
 * Connector slots are assigned once when the first revision is provisioned.
 * Later revisions retain every prior assignment and allocate new names from
 * the first unused slot; adding a connector can never silently reroute an
 * existing profile binding.
 */
export const LEGACY_WORKFLOW_CONNECTOR_SLOTS = Array.from(
  { length: 32 },
  (_, index) => `legacy-connector-${String(index).padStart(2, '0')}`,
);
export const LegacyWorkflowConnectorSlotMapSchema = z.record(
  z.string().min(1).max(128).refine(
    (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
    'Unsafe connector name',
  ),
  z.enum(LEGACY_WORKFLOW_CONNECTOR_SLOTS as [string, ...string[]]),
).superRefine((mapping, context) => {
  const values = Object.values(mapping);
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Legacy connector slots must be unique' });
  }
});

export function legacyWorkflowConnectorNames(schema: LegacyWorkflowSchema): string[] {
  const names = new Set<string>();
  const visit = (nodes: readonly LegacyWorkflowNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'connector' && typeof node.connector === 'string') names.add(node.connector);
      if (node.type === 'parallel') for (const branch of node.branches ?? []) visit(branch);
    }
  };
  visit(schema.nodes);
  return [...names].sort((left, right) => left.localeCompare(right, 'en'));
}

export function validateLegacyWorkflowConnectorSlotMap(
  schema: LegacyWorkflowSchema,
  value: unknown,
): Record<string, string> {
  const parsed = LegacyWorkflowConnectorSlotMapSchema.safeParse(value);
  const connectorNames = legacyWorkflowConnectorNames(schema);
  if (!parsed.success) {
    throw new LegacyWorkflowSchemaValidationError('Workflow connector slot map is invalid or incomplete');
  }
  if (connectorNames.some((name) => parsed.data[name] === undefined)) {
    throw new LegacyWorkflowSchemaValidationError('Workflow connector slot map is invalid or incomplete');
  }
  return parsed.data;
}

export function allocateLegacyWorkflowConnectorSlotMap(
  schema: LegacyWorkflowSchema,
  priorValue?: unknown,
): Record<string, string> {
  const prior = priorValue === undefined ? undefined : LegacyWorkflowConnectorSlotMapSchema.safeParse(priorValue);
  if (prior !== undefined && !prior.success) throw new LegacyWorkflowSchemaValidationError('Prior workflow connector slot map is invalid');
  const mapping: Record<string, string> = prior?.success ? { ...prior.data } : {};
  const used = new Set(Object.values(mapping));
  for (const name of legacyWorkflowConnectorNames(schema)) {
    if (mapping[name] !== undefined) continue;
    const next = LEGACY_WORKFLOW_CONNECTOR_SLOTS.find((slot) => !used.has(slot));
    if (!next) throw new LegacyWorkflowSchemaValidationError('Workflow exceeds the 32 connector slot limit');
    mapping[name] = next;
    used.add(next);
  }
  return validateLegacyWorkflowConnectorSlotMap(schema, mapping);
}

export const LegacyWorkflowSchemaPinSchema = z.object({
  tenantId: z.string().min(1).max(512),
  slug: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  schema: LegacyWorkflowSchemaSchema,
  connectorSlotMap: LegacyWorkflowConnectorSlotMapSchema.optional(),
  approvedEgressOrigins: z.array(CallbackApprovedOriginSchema).max(16).optional(),
}).strict();
export type LegacyWorkflowSchemaPin = z.infer<typeof LegacyWorkflowSchemaPinSchema>;

export const LegacyWorkflowTaskInputSchema = z.object({
  variables: z.record(SafeKeySchema, z.unknown()).default({}),
  artifactIds: z.array(z.string().uuid()).max(LEGACY_WORKFLOW_MAX_FILES).default([]),
  fileNames: z.array(z.string().min(1).max(255)).max(LEGACY_WORKFLOW_MAX_FILES).default([]),
  artifacts: z.array(z.object({ artifactId: z.string().uuid(), role: z.string().min(1).max(128) }).strict())
    .max(LEGACY_WORKFLOW_MAX_FILES).default([]),
}).strict().superRefine((input, context) => {
  if (input.artifactIds.length !== input.fileNames.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['fileNames'], message: 'artifactIds and fileNames must have equal lengths' });
  }
  if (new Set(input.artifactIds).size !== input.artifactIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactIds'], message: 'artifactIds must be unique' });
  }
  if (input.artifacts.length > 0 && input.artifacts.some((artifact) => !input.artifactIds.includes(artifact.artifactId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts'], message: 'artifacts must reference an input artifactId' });
  }
});
export type LegacyWorkflowTaskInput = z.infer<typeof LegacyWorkflowTaskInputSchema>;

export const LegacyWorkflowTaskPayloadSchema = z.object({
  input: LegacyWorkflowTaskInputSchema,
  legacyWorkflowSchema: LegacyWorkflowSchemaPinSchema,
}).strict();
export type LegacyWorkflowTaskPayload = z.infer<typeof LegacyWorkflowTaskPayloadSchema>;

export const LegacyWorkflowResultSchema = z.object({
  schemaVersion: z.literal('legacy-workflow-result-v1'),
  outputFormat: z.string().max(64),
  content: z.string().max(LEGACY_WORKFLOW_MAX_OUTPUT_BYTES).nullable(),
  extractedData: z.unknown().nullable(),
  pipelineSteps: z.array(z.unknown()).max(LEGACY_WORKFLOW_MAX_NODES),
  usage: z.object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    pages: z.number().int().min(0).optional(),
    costUsd: z.number().min(0).optional(),
    model: z.string().max(128).optional(),
  }).passthrough(),
}).strict();
export type LegacyWorkflowResult = z.infer<typeof LegacyWorkflowResultSchema>;

export class LegacyWorkflowSchemaValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LegacyWorkflowSchemaValidationError';
  }
}

/** Validate graph structure and reject dangerous property paths without executing schema code. */
export function parseLegacyWorkflowSchema(value: unknown): LegacyWorkflowSchema {
  preflightSchemaJson(value);
  preflightNodeGraph(value as Record<string, unknown>);
  const parsed = LegacyWorkflowSchemaSchema.safeParse(value);
  if (!parsed.success) {
    throw new LegacyWorkflowSchemaValidationError('Workflow schema failed structural validation');
  }
  const schema = parsed.data;
  const allIds = new Set<string>();
  const nodeLists: { nodes: readonly LegacyWorkflowNode[]; depth: number }[] = [{ nodes: schema.nodes, depth: 0 }];
  let nodeCount = 0;
  while (nodeLists.length > 0) {
    const current = nodeLists.pop()!;
    if (current.depth > 8) throw new LegacyWorkflowSchemaValidationError('Workflow nesting exceeds the maximum depth');
    for (const node of current.nodes) {
      nodeCount += 1;
      if (nodeCount > LEGACY_WORKFLOW_MAX_NODES) throw new LegacyWorkflowSchemaValidationError('Workflow exceeds the maximum node count');
      if (allIds.has(node.id)) throw new LegacyWorkflowSchemaValidationError('Workflow node ids must be unique');
      allIds.add(node.id);
      if (node.type === 'parallel') {
        for (const branch of node.branches ?? []) nodeLists.push({ nodes: branch, depth: current.depth + 1 });
      }
    }
  }
  const topIds = new Set(schema.nodes.map((node) => node.id));
  for (const id of schema.flow) {
    if (!topIds.has(id)) throw new LegacyWorkflowSchemaValidationError('Workflow flow references an unknown top-level node');
  }
  if (new Set(schema.flow).size !== schema.flow.length) {
    throw new LegacyWorkflowSchemaValidationError('Workflow flow cannot repeat a node id');
  }
  if (schema.output?.from && !allIds.has(schema.output.from)) {
    throw new LegacyWorkflowSchemaValidationError('Workflow output references an unknown node');
  }
  if (schema.output?.extra_data_from && !allIds.has(schema.output.extra_data_from)) {
    throw new LegacyWorkflowSchemaValidationError('Workflow extracted-data output references an unknown node');
  }
  rejectUnsafePaths(schema);
  return schema;
}

function rejectUnsafePaths(value: unknown, depth = 0): void {
  if (depth > 32) throw new LegacyWorkflowSchemaValidationError('Workflow schema value exceeds maximum nesting');
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new LegacyWorkflowSchemaValidationError('Workflow schema array exceeds maximum size');
    for (const item of value) rejectUnsafePaths(item, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new LegacyWorkflowSchemaValidationError('Workflow schema contains an unsafe property path');
    }
    if (key.length > 512) throw new LegacyWorkflowSchemaValidationError('Workflow schema property name exceeds maximum size');
    rejectUnsafePaths(child, depth + 1);
  }
}

export function canonicalLegacyWorkflowSchemaBytes(schema: LegacyWorkflowSchema): Buffer {
  return canonicalLegacyWorkflowJsonBytes(schema);
}

export function canonicalLegacyWorkflowPinBytes(
  schema: LegacyWorkflowSchema,
  connectorSlotMap: Record<string, string>,
  approvedEgressOrigins: readonly string[] = [],
): Buffer {
  return canonicalLegacyWorkflowJsonBytes({ schema, connectorSlotMap, approvedEgressOrigins: [...approvedEgressOrigins].sort() });
}

/** Validate immutable exact-origin policy for every legacy outbound node. */
export function validateLegacyWorkflowEgressOrigins(
  schema: LegacyWorkflowSchema,
  value: unknown,
): string[] {
  const parsed = z.array(CallbackApprovedOriginSchema).max(16).safeParse(value ?? []);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new LegacyWorkflowSchemaValidationError('Workflow approved egress origins are invalid');
  }
  const approved = new Set(parsed.data);
  const egressNodes: LegacyWorkflowNode[] = [];
  const visit = (nodes: readonly LegacyWorkflowNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'file_url_download' || node.type === 'callback') egressNodes.push(node);
      if (node.type === 'parallel') for (const branch of node.branches ?? []) visit(branch);
    }
  };
  visit(schema.nodes);
  for (const node of egressNodes) {
    const raw = node.type === 'callback' ? node.url : node.urls;
    const urls = collectConfiguredUrls(raw);
    const dynamic = urls.some((url) => /^\$[A-Za-z_][A-Za-z0-9_]*(?:\..+)?$/.test(url));
    const auth = (node as Record<string, unknown>).auth;
    const credentialBearing = isRecord(auth) && typeof auth.type === 'string' && auth.type !== 'none';
    if ((dynamic || credentialBearing) && approved.size === 0) {
      throw new LegacyWorkflowSchemaValidationError('Dynamic or credential-bearing workflow egress requires administrator-approved origins');
    }
    for (const configured of urls) {
      if (/^\$[A-Za-z_][A-Za-z0-9_]*(?:\..+)?$/.test(configured)) continue;
      let url: URL;
      try { url = new URL(configured); } catch {
        throw new LegacyWorkflowSchemaValidationError('Workflow egress URL must be HTTPS and administrator-approved');
      }
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' || !approved.has(url.origin)) {
        throw new LegacyWorkflowSchemaValidationError('Workflow egress URL must be HTTPS and administrator-approved');
      }
    }
    if (urls.length === 0 && approved.size === 0) {
      throw new LegacyWorkflowSchemaValidationError('Workflow dynamic egress requires administrator-approved origins');
    }
  }
  return [...parsed.data].sort();
}

function collectConfiguredUrls(value: unknown): string[] {
  const urls: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      urls.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (Object.hasOwn(record, 'url')) visit(record.url);
  };
  visit(value);
  return urls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalLegacyWorkflowJsonBytes(value: unknown): Buffer {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value === null || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sort((value as Record<string, unknown>)[key]);
    }
    return result;
  };
  return Buffer.from(JSON.stringify(sort(value)), 'utf8');
}

function preflightNodeGraph(schema: Record<string, unknown>): void {
  const pending: { nodes: unknown; depth: number }[] = [{ nodes: schema.nodes, depth: 0 }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!Array.isArray(current.nodes)) continue;
    if (current.depth > 8) throw new LegacyWorkflowSchemaValidationError('Workflow nesting exceeds the maximum depth');
    for (const rawNode of current.nodes) {
      nodeCount += 1;
      if (nodeCount > LEGACY_WORKFLOW_MAX_NODES) throw new LegacyWorkflowSchemaValidationError('Workflow exceeds the maximum node count');
      if (typeof rawNode !== 'object' || rawNode === null || Array.isArray(rawNode)) continue;
      const node = rawNode as Record<string, unknown>;
      if (node.type !== 'parallel') continue;
      if (!Array.isArray(node.branches)) continue;
      if (node.branches.length > LEGACY_WORKFLOW_MAX_BRANCHES) {
        throw new LegacyWorkflowSchemaValidationError('Workflow parallel node exceeds the branch limit');
      }
      for (const branch of node.branches) pending.push({ nodes: branch, depth: current.depth + 1 });
    }
  }
}

function preflightSchemaJson(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LegacyWorkflowSchemaValidationError('Workflow schema must be an object');
  }
  const stack: { value: object; depth: number }[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > 32) throw new LegacyWorkflowSchemaValidationError('Workflow schema value exceeds maximum nesting');
    if (seen.has(current.value)) throw new LegacyWorkflowSchemaValidationError('Workflow schema cannot contain cycles or shared object references');
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > 10_000) throw new LegacyWorkflowSchemaValidationError('Workflow schema array exceeds maximum size');
      for (const item of current.value) {
        if (typeof item === 'object' && item !== null) stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new LegacyWorkflowSchemaValidationError('Workflow schema must contain plain JSON objects only');
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current.value))) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new LegacyWorkflowSchemaValidationError('Workflow schema contains an unsafe property path');
      }
      if (key.length > 512 || !('value' in descriptor)) {
        throw new LegacyWorkflowSchemaValidationError('Workflow schema contains an invalid property');
      }
      const child = descriptor.value as unknown;
      if (typeof child === 'object' && child !== null) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new LegacyWorkflowSchemaValidationError('Workflow schema is not serializable JSON');
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > LEGACY_WORKFLOW_MAX_BYTES) {
    throw new LegacyWorkflowSchemaValidationError('Workflow schema exceeds the maximum serialized size');
  }
}
