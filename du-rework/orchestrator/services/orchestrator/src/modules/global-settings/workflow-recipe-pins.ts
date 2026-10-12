import { z } from 'zod';
import {
  canonicalLegacyWorkflowPinBytes,
  ConnectorWorkflowOverridesSchema,
  type LegacyWorkflowSchemaPin,
  type ConnectorWorkflowOverrides,
} from '@du/contracts';
import { createHash } from 'node:crypto';
import { HttpError } from '../../http/errors';
import type { MetadataCrypto } from '../runtime/metadata-crypto';

const RecipePinsSchema = z.object({
  workflowSchemaSlug: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  workflowSchemaRevision: z.number().int().positive(),
  workflowSchemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  connectorRecipePins: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    ConnectorWorkflowOverridesSchema,
  ).superRefine((pins, context) => {
    if (Object.keys(pins).length > 128) context.addIssue({ code: z.ZodIssueCode.custom, message: 'too many workflow recipe pins' });
  }),
}).strict();

export type ConnectorRecipePinsEnvelope = z.infer<typeof RecipePinsSchema>;

export interface ConnectorRecipePinsBinding {
  tenantId: string;
  operationId: string;
}

export function compileWorkflowSchemaPinDigest(
  pin: LegacyWorkflowSchemaPin,
  connectorRecipePins: Record<string, ConnectorWorkflowOverrides>,
): string {
  return `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(
    pin.schema,
    pin.connectorSlotMap ?? {},
    pin.approvedEgressOrigins ?? [],
    connectorRecipePins,
  )).digest('hex')}`;
}

function parseStored(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(503, 'SETTINGS_INTEGRITY_ERROR', 'stored workflow recipe pin is unreadable');
  }
}

/**
 * Seal the compiled recipe pins with an operation-specific AAD slot. The
 * envelope is persisted in operations.connector_recipe_pins; no recipe
 * values are stored as plaintext in the operation row.
 */
export async function sealConnectorRecipePins(
  crypto: MetadataCrypto | undefined,
  value: ConnectorRecipePinsEnvelope,
  binding: ConnectorRecipePinsBinding,
): Promise<string> {
  if (!crypto) throw new HttpError(503, 'METADATA_ENCRYPTION_REQUIRED', 'workflow recipe pins require metadata encryption');
  const parsed = RecipePinsSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'workflow recipe pin is invalid');
  const envelope = await crypto.seal(parsed.data, {
    tenantId: binding.tenantId,
    slot: 'operations.connector_recipe_pins_ref',
    refId: binding.operationId,
  });
  return JSON.stringify(envelope);
}

/**
 * Open only an operation-bound encrypted recipe pin. `null` is reserved for
 * pre-existing operations admitted before this feature; a non-null plaintext
 * value is an integrity failure, never a compatibility fallback.
 */
export async function openConnectorRecipePins(
  crypto: MetadataCrypto | undefined,
  raw: unknown,
  binding: ConnectorRecipePinsBinding,
): Promise<ConnectorRecipePinsEnvelope | null> {
  if (raw === null || raw === undefined) return null;
  if (!crypto) throw new HttpError(503, 'METADATA_ENCRYPTION_REQUIRED', 'workflow recipe pins cannot be opened without metadata encryption');
  const envelope = parseStored(raw);
  if (!crypto.isSealed(envelope)) throw new HttpError(503, 'SETTINGS_INTEGRITY_ERROR', 'stored workflow recipe pin is not encrypted');
  const opened = await crypto.readStored(envelope, {
    tenantId: binding.tenantId,
    slot: 'operations.connector_recipe_pins_ref',
    refId: binding.operationId,
  }, false);
  const parsed = RecipePinsSchema.safeParse(opened);
  if (!parsed.success) throw new HttpError(503, 'SETTINGS_INTEGRITY_ERROR', 'stored workflow recipe pin does not match its frozen schema');
  return parsed.data;
}

export type { ConnectorWorkflowOverrides };
