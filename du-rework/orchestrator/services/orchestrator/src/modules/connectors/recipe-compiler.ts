import { createHash } from 'node:crypto';
import {
  ConnectorRecipePinsSchema,
  ConnectorRecipeSchema,
  ConnectorWorkflowOverridesSchema,
  type ConnectorRecipe,
  type ConnectorWorkflowOverrides,
} from '@du/contracts';
import { HttpError } from '../../http/errors';

export interface RecipeOverrideValue { name: string; value: string | number | boolean }
export interface ConnectorRecipeCompileInput {
  tenantId: string;
  revisionTenantId: string;
  connectorId: string;
  connectorRevision: number;
  recipe: ConnectorRecipe;
  staticFormFields?: readonly RecipeOverrideValue[];
  extraHeaders?: readonly { name: string; value: string }[];
}

export interface ConnectorRecipeNodeInput extends ConnectorRecipeCompileInput { nodeId: string }

const SECRET_NAME = /(?:^|[^a-z0-9])(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)(?:$|[^a-z0-9])/i;
const SECRET_VALUE = /(?:bearer\s+|password\s*[:=]|passwd\s*[:=]|secret\s*[:=]|token\s*[:=]|api[_-]?key\s*[:=]|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})/i;
const SAFE_NODE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Canonical JSON prevents a property-order change from changing a recipe pin. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function safeText(value: string, max: number, label: string): string {
  if (value.length > max || /[\r\n\u0000-\u001f\u007f]/.test(value) || SECRET_VALUE.test(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${label} is outside the safe recipe value bounds`);
  }
  return value;
}

function formText(value: string | number | boolean, name: string): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new HttpError(422, 'INVALID_SCHEMA', `static field ${name} is invalid`);
  const text = typeof value === 'string' ? value : String(value);
  return safeText(text, 4096, `static field ${name}`);
}

function validateTenant(input: ConnectorRecipeCompileInput): void {
  if (!input.tenantId || input.tenantId !== input.revisionTenantId) {
    throw new HttpError(404, 'NOT_FOUND', 'tenant-authorized Connector recipe revision was not found');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(input.connectorId)
      || !Number.isSafeInteger(input.connectorRevision) || input.connectorRevision < 1) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'Connector recipe revision pin is invalid');
  }
}

/**
 * Compile legacy workflow override values onto names already declared by an
 * immutable, tenant-owned Connector recipe. The output carries no endpoint,
 * credential, or secret-bearing header. Its recipe digest and revision are
 * later signed by the Connector grant path.
 */
export function compileConnectorRecipeOverrides(input: ConnectorRecipeCompileInput): ConnectorWorkflowOverrides {
  validateTenant(input);
  const parsed = ConnectorRecipeSchema.safeParse(input.recipe);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'stored Connector recipe is outside the typed recipe contract');
  const recipe = parsed.data;

  const staticAllowed = new Set(recipe.request.fields.filter((field) => field.source === 'static').map((field) => field.name));
  const staticSeen = new Set<string>();
  const staticFormFields = (input.staticFormFields ?? []).map((field) => {
    if (!staticAllowed.has(field.name) || staticSeen.has(field.name)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'static workflow field is not declared by the pinned Connector recipe');
    }
    if (SECRET_NAME.test(field.name)) throw new HttpError(422, 'INVALID_SCHEMA', 'credential-like static field names require a credential slot');
    staticSeen.add(field.name);
    return { name: field.name, value: formText(field.value, field.name) };
  });
  if (staticFormFields.length > 32) throw new HttpError(422, 'INVALID_SCHEMA', 'too many static workflow fields');

  const declaredHeaders = new Map(recipe.headers.map((header) => [header.name.toLowerCase(), header.name]));
  const headerSeen = new Set<string>();
  const extraHeaders = (input.extraHeaders ?? []).map((header) => {
    const lower = header.name.toLowerCase();
    if (!declaredHeaders.has(lower) || headerSeen.has(lower)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'workflow header is not declared by the pinned Connector recipe');
    }
    if (SECRET_NAME.test(header.name) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'credential or protected header names require a credential slot');
    }
    headerSeen.add(lower);
    return { name: declaredHeaders.get(lower)!, value: safeText(header.value, 512, `header ${header.name}`) };
  });
  if (extraHeaders.length > 16) throw new HttpError(422, 'INVALID_SCHEMA', 'too many workflow headers');

  const recipeDigest = createHash('sha256').update(canonical(recipe), 'utf8').digest('hex');
  const output = ConnectorWorkflowOverridesSchema.safeParse({
    connectorId: input.connectorId,
    connectorRevision: input.connectorRevision,
    recipeDigest,
    staticFormFields,
    extraHeaders,
  });
  if (!output.success) throw new HttpError(422, 'INVALID_SCHEMA', 'compiled Connector workflow recipe did not satisfy the Connector grant contract');
  return output.data;
}

/** Compile the already-resolved effective profile's connector nodes by ID. */
export function compileConnectorRecipePins(input: { tenantId: string; nodes: readonly ConnectorRecipeNodeInput[] }): Record<string, ConnectorWorkflowOverrides> {
  if (!Array.isArray(input.nodes) || input.nodes.length > 128) throw new HttpError(422, 'INVALID_SCHEMA', 'connector recipe pin set is invalid');
  const result: Record<string, ConnectorWorkflowOverrides> = Object.create(null) as Record<string, ConnectorWorkflowOverrides>;
  for (const node of input.nodes) {
    if (!SAFE_NODE_ID.test(node.nodeId) || Object.prototype.hasOwnProperty.call(result, node.nodeId)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'connector recipe pin node IDs must be unique and bounded');
    }
    if (node.tenantId !== input.tenantId) throw new HttpError(404, 'NOT_FOUND', 'tenant-authorized Connector recipe revision was not found');
    result[node.nodeId] = compileConnectorRecipeOverrides(node);
  }
  const parsed = ConnectorRecipePinsSchema.safeParse(result);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'compiled Connector recipe pins are invalid');
  return parsed.data;
}

