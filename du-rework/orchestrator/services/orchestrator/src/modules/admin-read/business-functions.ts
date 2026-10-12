import {
  BusinessManifestSchema,
  type ActionManifest,
  type ProfileGroupFunction,
} from '@du/contracts';
import { CORE_ENDPOINTS } from '../settings/endpoints';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';

interface BusinessFunctionRow extends Record<string, unknown> {
  business_id: string;
  business_version: string;
  manifest: unknown;
  digest: string;
  business_enabled: boolean;
}

const CORE_VARIANT_PROPERTIES: Readonly<Record<string, string>> = {
  ingest: 'mode',
  extract: 'type',
  analyze: 'task',
  transform: 'variant',
  generate: 'task',
  compare: 'mode',
};

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyRecord(value: unknown): Record<string, unknown> {
  if (!isJsonSchemaObject(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function narrowEndpointInputSchema(raw: unknown, property: string, variant: string): Record<string, unknown> {
  const schema = copyRecord(raw);
  const rawProperties = isJsonSchemaObject(schema.properties) ? schema.properties : {};
  const properties = copyRecord(rawProperties);
  const current = isJsonSchemaObject(properties[property]) ? copyRecord(properties[property]) : {};
  properties[property] = { ...current, enum: [variant] };
  schema.properties = properties;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : [];
  schema.required = [...new Set([...required, property])];
  return schema;
}

function manifestActionFunction(
  action: ActionManifest,
  input: {
    kind: 'endpoint' | 'workflow';
    functionId: string;
    manifestDigest: string;
    endpointSlug?: string;
    inputSchema?: Record<string, unknown>;
    available?: boolean;
    unavailableReason?: string;
  },
): ProfileGroupFunction {
  return {
    kind: input.kind,
    functionId: input.functionId,
    action: action.name,
    ...(input.endpointSlug ? { endpointSlug: input.endpointSlug } : {}),
    manifestDigest: input.manifestDigest,
    inputSchema: input.inputSchema ?? action.inputSchema,
    outputSchema: action.outputSchema,
    profileSchema: action.profileSchema,
    ...(action.uiSchema ? { uiSchema: action.uiSchema } : {}),
    available: input.available ?? true,
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    connectorSlots: action.connectorSlots,
  };
}

/**
 * Discover functions from the selected immutable registry version. For
 * Document Core, endpoint variants are narrowed from that version's declared
 * discriminator enums. Other actions, and every action on other businesses,
 * remain manifest-declared workflow functions with an exact action identity.
 */
export async function getBusinessFunctionCatalog(
  db: Pick<Db, 'query'>,
  businessId: string,
  businessVersion: string,
  options: { lockAvailability?: boolean } = {},
): Promise<{
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  businessEnabled: boolean;
  functions: ProfileGroupFunction[];
}> {
  // Keep availability serialization independent of the version join. This
  // explicit root-row lock is the lifecycle writer's lock target and remains
  // held by the caller's transaction through profile child materialization.
  // Locking the joined projection alone proved too subtle to verify at the
  // group save barrier, so select the catalog root directly first.
  if (options.lockAvailability) {
    const availability = await db.query<{ business_id: string; enabled: boolean }>(
      'SELECT business_id, enabled FROM business_catalog WHERE business_id=$1 FOR SHARE',
      [businessId],
    );
    if (!availability.rows[0]) {
      throw new HttpError(404, 'NOT_FOUND', `registered business ${businessId} was not found`);
    }
  }
  const result = await db.query<BusinessFunctionRow>(
    `SELECT v.business_id, v.version AS business_version, v.manifest, v.digest,
            c.enabled AS business_enabled
       FROM business_versions v
       JOIN business_catalog c ON c.business_id=v.business_id
       WHERE v.business_id=$1 AND v.version=$2`,
    [businessId, businessVersion],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', `registered business version ${businessId}@${businessVersion} was not found`);

  const parsedManifest = BusinessManifestSchema.safeParse(row.manifest);
  if (!parsedManifest.success
      || parsedManifest.data.businessId !== row.business_id
      || parsedManifest.data.version !== row.business_version) {
    throw new HttpError(500, 'INVALID_SCHEMA', 'registered business manifest does not match its catalog identity');
  }

  const functions: ProfileGroupFunction[] = [];
  for (const action of parsedManifest.data.actions) {
    if (row.business_id !== 'document-core') {
      functions.push(manifestActionFunction(action, {
        kind: 'workflow',
        functionId: action.name,
        manifestDigest: row.digest,
      }));
      continue;
    }

    const variantProperty = CORE_VARIANT_PROPERTIES[action.name];
    if (!variantProperty) {
      functions.push(manifestActionFunction(action, {
        kind: 'workflow',
        functionId: action.name,
        manifestDigest: row.digest,
      }));
      continue;
    }

    const inputSchema = action.inputSchema;
    const properties = isJsonSchemaObject(inputSchema.properties) ? inputSchema.properties : {};
    const discriminator = properties[variantProperty];
    const variants = isJsonSchemaObject(discriminator) && Array.isArray(discriminator.enum)
      ? discriminator.enum.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
    if (variants.length === 0) {
      throw new HttpError(409, 'STATE_CONFLICT', `registered Core action '${action.name}' has no string discriminator variants for ${variantProperty}`);
    }
    for (const variant of variants) {
      const endpointSlug = `${action.name}:${variant}`;
      const endpointAvailable = CORE_ENDPOINTS.has(endpointSlug);
      functions.push(manifestActionFunction(action, {
        kind: 'endpoint',
        functionId: endpointSlug,
        endpointSlug,
        manifestDigest: row.digest,
        inputSchema: narrowEndpointInputSchema(inputSchema, variantProperty, variant),
        available: endpointAvailable,
        ...(endpointAvailable ? {} : { unavailableReason: 'This registered Core variant is not currently admitted by the Document Core facade.' }),
      }));
    }
  }

  return {
    businessId: row.business_id,
    businessVersion: row.business_version,
    manifestDigest: row.digest,
    businessEnabled: row.business_enabled === true,
    functions,
  };
}

export async function requireEnabledBusinessFunctionCatalog(
  db: Pick<Db, 'query'>,
  businessId: string,
  businessVersion: string,
): Promise<Awaited<ReturnType<typeof getBusinessFunctionCatalog>>> {
  const catalog = await getBusinessFunctionCatalog(db, businessId, businessVersion);
  if (!catalog.businessEnabled) {
    throw new HttpError(409, 'STATE_CONFLICT', `business '${businessId}' is disabled and cannot be selected in a profile`);
  }
  return catalog;
}
