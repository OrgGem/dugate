export type SchemaDraftCheck = { ok: true; schema: Record<string, unknown> } | { ok: false; message: string };
export type SchemaDiffLine = { kind: 'same' | 'removed' | 'added'; text: string };
export type ConnectorReference = { nodeId: string; connector: string; path: Array<string | number> };
export type WorkflowStaticFormField = { name: string; value: string | number | boolean };
export type WorkflowExtraHeader = { name: string; value: string };
export type WorkflowOverrideRows = { ok: true; rows: Array<WorkflowStaticFormField | WorkflowExtraHeader> } | { ok: false; message: string };

const STATIC_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SECRET_FIELD_NAME = /(?:^|[^a-z0-9])(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)(?:$|[^a-z0-9])/i;
const SECRET_FIELD_VALUE = /^(?:bearer\s+|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,})/i;
const SECRET_HEADER_NAME = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer',
  'expect', 'forwarded', 'via', 'origin', 'referer', 'content-type', 'idempotency-key',
  'api-key', 'x-api-key', 'x-goog-api-key', 'x-auth-token', 'x-tenant-id',
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

function isPlainRow(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Parse the stored legacy JSON-array representation without coercing imported values. */
export function parseWorkflowOverrideRows(
  field: 'staticFormFields' | 'extraHeaders',
  raw: unknown,
): WorkflowOverrideRows {
  if (raw === undefined) return { ok: true, rows: [] };
  const maxBytes = field === 'staticFormFields' ? 64 * 1024 : 16 * 1024;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxBytes) {
    return { ok: false, message: `${field} must be a bounded JSON array.` };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { return { ok: false, message: `${field} must be valid JSON.` }; }
  if (!Array.isArray(parsed) || parsed.length > (field === 'staticFormFields' ? 32 : 16)) {
    return { ok: false, message: `${field} exceeds its row limit.` };
  }
  const seen = new Set<string>();
  const rows: Array<WorkflowStaticFormField | WorkflowExtraHeader> = [];
  for (const candidate of parsed) {
    if (!isPlainRow(candidate) || Object.keys(candidate).length !== 2
      || typeof candidate.name !== 'string' || typeof candidate.value !== 'string') {
      // Legacy workflow form/header values are serialized text. Numbers and
      // booleans remain accepted for older imported static-form schemas.
      if (field !== 'staticFormFields' || !isPlainRow(candidate) || Object.keys(candidate).length !== 2
        || typeof candidate.name !== 'string' || !['string', 'number', 'boolean'].includes(typeof candidate.value)) {
        return { ok: false, message: `${field} rows must contain only a name and a supported static value.` };
      }
    }
    const name = candidate.name as string;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return { ok: false, message: `${field} names must be unique.` };
    seen.add(lower);
    if (field === 'staticFormFields') {
      const value = candidate.value as string | number | boolean;
      const text = String(value);
      if (!STATIC_FIELD_NAME.test(name) || SECRET_FIELD_NAME.test(name) || text.length > 512
        || /[\u0000-\u001f\u007f]/.test(text) || SECRET_FIELD_VALUE.test(text)) {
        return { ok: false, message: 'Static workflow fields must use safe names and bounded non-secret values.' };
      }
      rows.push({ name, value });
      continue;
    }
    const value = candidate.value as string;
    const lowerName = name.toLowerCase();
    if (!HEADER_NAME.test(name) || SECRET_HEADER_NAME.has(lowerName) || lowerName.startsWith('x-forwarded-')
      || lowerName.startsWith('proxy-') || lowerName.startsWith('x-auth-') || lowerName.startsWith('x-provider-')
      || value.length > 256 || !/^[\x20-\x7e]*$/.test(value)) {
      return { ok: false, message: 'Extra headers must use safe non-secret names and bounded printable values.' };
    }
    rows.push({ name, value });
  }
  return { ok: true, rows };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkWorkflowSchemaDraft(raw: string, expectedSlug: string): SchemaDraftCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'Enter valid JSON before validating or publishing the revision.' };
  }
  if (!isRecord(parsed)) return { ok: false, message: 'A workflow schema must be a JSON object.' };
  if (parsed.slug !== expectedSlug) return { ok: false, message: `The workflow slug is pinned to "${expectedSlug}" for this revision.` };
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return { ok: false, message: 'Add at least one workflow node.' };
  if (!Array.isArray(parsed.flow)) return { ok: false, message: 'The workflow flow must be a JSON array.' };
  for (const reference of connectorReferences(parsed)) {
    const node = connectorNodeAtPath(parsed, reference.path.slice(0, -1));
    if (!node || !isRecord(node.overrideConnector)) continue;
    for (const field of ['staticFormFields', 'extraHeaders'] as const) {
      if (!Object.hasOwn(node.overrideConnector, field)) continue;
      const result = parseWorkflowOverrideRows(field, node.overrideConnector[field]);
      if (!result.ok) return { ok: false, message: `Node "${reference.nodeId}": ${result.message}` };
    }
  }
  return { ok: true, schema: parsed };
}

export function connectorReferences(schema: unknown): ConnectorReference[] {
  if (!isRecord(schema) || !Array.isArray(schema.nodes)) return [];
  const references: ConnectorReference[] = [];
  const visit = (nodes: unknown[], path: Array<string | number>) => {
    nodes.forEach((raw, index) => {
      if (!isRecord(raw)) return;
      const nodePath = [...path, index];
      if (raw.type === 'connector' && typeof raw.connector === 'string') {
        references.push({
          nodeId: typeof raw.id === 'string' ? raw.id : `node-${index + 1}`,
          connector: raw.connector,
          path: [...nodePath, 'connector'],
        });
      }
      if (Array.isArray(raw.branches)) {
        raw.branches.forEach((branch, branchIndex) => {
          if (Array.isArray(branch)) visit(branch, [...nodePath, 'branches', branchIndex]);
        });
      }
    });
  };
  visit(schema.nodes, ['nodes']);
  return references;
}

export function updateConnectorReference(schema: unknown, path: Array<string | number>, connector: string): unknown {
  if (path.length < 2 || path.some((part) => part === '__proto__' || part === 'prototype' || part === 'constructor')) {
    throw new Error('Invalid workflow connector path.');
  }
  const update = (value: unknown, depth: number): unknown => {
    if (depth === path.length) return connector;
    const part = path[depth];
    if (Array.isArray(value) && typeof part === 'number' && part >= 0 && part < value.length) {
      const copy = value.slice();
      copy[part] = update(value[part], depth + 1);
      return copy;
    }
    if (isRecord(value) && typeof part === 'string' && Object.hasOwn(value, part)) {
      return { ...value, [part]: update(value[part], depth + 1) };
    }
    throw new Error('Workflow connector path no longer exists.');
  };
  return update(schema, 0);
}

export function connectorNodeAtPath(schema: unknown, path: Array<string | number>): Record<string, unknown> | null {
  let value: unknown = schema;
  for (const part of path) {
    if (Array.isArray(value) && typeof part === 'number' && part >= 0 && part < value.length) value = value[part];
    else if (isRecord(value) && typeof part === 'string' && Object.hasOwn(value, part)) value = value[part];
    else return null;
  }
  return isRecord(value) && value.type === 'connector' ? value : null;
}

/** Update one safe, non-secret connector-node override through the guided
 * editor while keeping unknown legacy nodes/fields intact. `undefined`
 * removes the property, allowing the backend/Connector recipe to supply its
 * immutable default. */
export function updateConnectorNodeOverride(
  schema: unknown,
  nodePath: Array<string | number>,
  field: 'prompt' | 'timeoutSec' | 'responseContentPath' | 'staticFormFields' | 'extraHeaders',
  value: string | number | undefined,
): unknown {
  if (nodePath.length < 2 || nodePath.some(part => part === '__proto__' || part === 'prototype' || part === 'constructor')) {
    throw new Error('Invalid workflow node path.');
  }
  const node = connectorNodeAtPath(schema, nodePath);
  if (!node) throw new Error('Workflow connector node no longer exists.');
  const prior = isRecord(node.overrideConnector) ? node.overrideConnector : {};
  const overrideConnector = { ...prior };
  if (value === undefined || value === '') delete overrideConnector[field];
  else overrideConnector[field] = value;
  const nextNode = { ...node };
  if (Object.keys(overrideConnector).length === 0) delete nextNode.overrideConnector;
  else nextNode.overrideConnector = overrideConnector;

  const replace = (current: unknown, depth: number): unknown => {
    if (depth === nodePath.length) return nextNode;
    const part = nodePath[depth];
    if (Array.isArray(current) && typeof part === 'number' && part >= 0 && part < current.length) {
      const copy = current.slice();
      copy[part] = replace(current[part], depth + 1);
      return copy;
    }
    if (isRecord(current) && typeof part === 'string' && Object.hasOwn(current, part)) {
      return { ...current, [part]: replace(current[part], depth + 1) };
    }
    throw new Error('Workflow connector node path no longer exists.');
  };
  return replace(schema, 0);
}

export function workflowSchemaDiff(before: string, after: string): SchemaDiffLine[] {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;
  if (prefix === oldLines.length && prefix === newLines.length) return [{ kind: 'same', text: 'No schema changes.' }];
  const lines: SchemaDiffLine[] = [];
  for (const line of oldLines.slice(Math.max(0, prefix - 3), prefix)) lines.push({ kind: 'same', text: line });
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  for (const line of removed.slice(0, 200)) lines.push({ kind: 'removed', text: line });
  for (const line of added.slice(0, 200)) lines.push({ kind: 'added', text: line });
  if (removed.length > 200 || added.length > 200) lines.push({ kind: 'same', text: 'Diff shortened after 200 changed lines.' });
  for (const line of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + Math.min(3, suffix))) lines.push({ kind: 'same', text: line });
  return lines;
}
