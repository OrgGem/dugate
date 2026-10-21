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
    /**
     * Wave3-F4: the tenant's ACTIVE workflow revision for this action, when the
     * caller supplied a tenant. Workflow revisions live in the tenant-scoped
     * `legacy_workflow_schemas` registry, so the catalog can only pin one when
     * it is told which tenant to resolve for. Never fabricated: absent when the
     * tenant is unknown or the action has no active revision.
     */
    workflowRevision?: number;
  },
): ProfileGroupFunction {
  return {
    kind: input.kind,
    functionId: input.functionId,
    action: action.name,
    ...(input.endpointSlug ? { endpointSlug: input.endpointSlug } : {}),
    // The v2 contract forbids `workflowRevision` on an endpoint selector.
    ...(input.kind === 'workflow' && input.workflowRevision !== undefined
      ? { workflowRevision: input.workflowRevision }
      : {}),
    manifestDigest: input.manifestDigest,
    inputSchema: input.inputSchema ?? action.inputSchema,
    outputSchema: action.outputSchema,
    profileSchema: action.profileSchema,
    ...(action.uiSchema ? { uiSchema: action.uiSchema } : {}),
    available: input.available ?? true,
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    connectorSlots: action.connectorSlots,
    ...(action.parameterResolution?.fields ? { parameterResolution: action.parameterResolution.fields } : {}),
  };
}

/**
 * Wave3-F4: resolve the tenant's ACTIVE revision for each workflow slug.
 *
 * `legacy_workflow_schemas` is keyed by `(tenant_id, slug)` with a partial
 * unique index on `status='active'`, so at most one revision per slug comes
 * back. A slug with no active revision is simply absent from the map — the
 * catalog must not invent a pin the workflow engine could not resolve.
 */
async function activeWorkflowRevisions(
  db: Pick<Db, 'query'>,
  tenantId: string,
  slugs: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(slugs.filter((slug) => slug.length > 0))];
  if (unique.length === 0) return new Map();
  const result = await db.query<{ slug: string; revision: number | string }>(
    `SELECT slug, revision FROM legacy_workflow_schemas
      WHERE tenant_id=$1 AND slug = ANY($2::text[]) AND status='active'`,
    [tenantId, unique],
  );
  const revisions = new Map<string, number>();
  for (const row of result.rows) {
    const revision = Number(row.revision);
    if (Number.isSafeInteger(revision) && revision > 0) revisions.set(String(row.slug), revision);
  }
  return revisions;
}

/**
 * Discover functions from the selected immutable registry version. For
 * Document Core, endpoint variants are narrowed from that version's declared
 * discriminator enums. Other actions, and every action on other businesses,
 * remain manifest-declared workflow functions with an exact action identity.
 *
 * `options.tenantId` (Wave3-F4) additionally pins each workflow function to that
 * tenant's current ACTIVE revision, which is what the group editor needs to
 * build a contract-valid `workflowRevision`. Without a tenant the descriptors
 * carry no revision (the caller must preserve an existing pin; it must not
 * guess one).
 */
export async function getBusinessFunctionCatalog(
  db: Pick<Db, 'query'>,
  businessId: string,
  businessVersion: string,
  options: { lockAvailability?: boolean; tenantId?: string } = {},
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
  // Wave3-F4: resolve the tenant's active workflow revisions ONCE, only for the
  // actions this manifest maps as workflow functions (endpoint variants on
  // document-core are never workflows and must not carry a revision).
  const workflowActionNames = parsedManifest.data.actions
    .filter((action) => row.business_id !== 'document-core' || !CORE_VARIANT_PROPERTIES[action.name])
    .map((action) => action.name);
  const workflowRevisions = options.tenantId
    ? await activeWorkflowRevisions(db, options.tenantId, workflowActionNames)
    : new Map<string, number>();
  const workflowPin = (name: string): { workflowRevision?: number } => {
    const revision = workflowRevisions.get(name);
    return revision === undefined ? {} : { workflowRevision: revision };
  };

  for (const action of parsedManifest.data.actions) {
    if (row.business_id !== 'document-core') {
      functions.push(manifestActionFunction(action, {
        kind: 'workflow',
        functionId: action.name,
        manifestDigest: row.digest,
        ...workflowPin(action.name),
      }));
      continue;
    }

    const variantProperty = CORE_VARIANT_PROPERTIES[action.name];
    if (!variantProperty) {
      functions.push(manifestActionFunction(action, {
        kind: 'workflow',
        functionId: action.name,
        manifestDigest: row.digest,
        ...workflowPin(action.name),
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
