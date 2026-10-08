import { createHash } from 'node:crypto';
import {
  LegacyWorkflowSchemaPinSchema,
  LegacyWorkflowSchemaSchema,
  LegacyWorkflowSchemaValidationError,
  allocateLegacyWorkflowConnectorSlotMap,
  canonicalLegacyWorkflowPinBytes,
  parseLegacyWorkflowSchema,
  validateLegacyWorkflowEgressOrigins,
  validateLegacyWorkflowConnectorSlotMap,
  type LegacyWorkflowSchema,
  type LegacyWorkflowSchemaPin,
} from '@du/contracts';
import type { PoolClient } from 'pg';
import type { MetadataCrypto } from '../runtime/metadata-crypto';
import type { Db } from '../../db/db';

export type LegacyWorkflowSchemaCatalogErrorCode =
  | 'SCHEMA_INVALID'
  | 'SCHEMA_NOT_ACTIVE'
  | 'SCHEMA_REVISION_CONFLICT'
  | 'SCHEMA_CRYPTO_UNAVAILABLE';

export class LegacyWorkflowSchemaCatalogError extends Error {
  public readonly code: LegacyWorkflowSchemaCatalogErrorCode;

  public constructor(code: LegacyWorkflowSchemaCatalogErrorCode, message: string) {
    super(message);
    this.name = 'LegacyWorkflowSchemaCatalogError';
    this.code = code;
  }
}

export interface ResolveLegacyWorkflowSchemaQuery {
  readonly tenantId: string;
  readonly slug: string;
  readonly revision?: number;
}

export interface ProvisionLegacyWorkflowSchemaInput {
  readonly tenantId: string;
  readonly schema: unknown;
  /** Exact administrator-approved HTTPS origins for callback/download nodes. */
  readonly approvedEgressOrigins?: readonly string[];
  /** Compare-and-swap against the active revision; null asserts no active row. */
  readonly expectedRevision?: number | null;
}

interface CatalogRow {
  tenant_id: string;
  slug: string;
  revision: number;
  digest: string;
  schema_ref: unknown;
  status: 'active' | 'retired';
}

const CATALOG_SLOT = 'legacy_workflow_schemas.schema_ref' as const;
const TENANT_ID_MAX = 512;
const CATALOG_ROW_ID_MAX = 256;

function refId(slug: string, revision: number): string {
  const id = `${slug}:${revision}`;
  if (id.length > CATALOG_ROW_ID_MAX) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Workflow schema identity exceeds the supported limit');
  }
  return id;
}

function schemaDigest(
  schema: LegacyWorkflowSchema,
  connectorSlotMap: Record<string, string>,
  approvedEgressOrigins: readonly string[],
): string {
  return `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(schema, connectorSlotMap, approvedEgressOrigins)).digest('hex')}`;
}

interface StoredSchemaEnvelope {
  readonly schema: unknown;
  readonly connectorSlotMap: unknown;
  readonly approvedEgressOrigins: unknown;
}

function parseStoredEnvelope(value: unknown): StoredSchemaEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Stored workflow schema envelope is malformed');
  }
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).length !== 3 || !Object.hasOwn(envelope, 'schema')
      || !Object.hasOwn(envelope, 'connectorSlotMap') || !Object.hasOwn(envelope, 'approvedEgressOrigins')) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Stored workflow schema envelope is malformed');
  }
  return {
    schema: envelope.schema,
    connectorSlotMap: envelope.connectorSlotMap,
    approvedEgressOrigins: envelope.approvedEgressOrigins,
  };
}

function validateIdentity(tenantId: string, slug: string): void {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0 || tenantId.length > TENANT_ID_MAX) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Tenant identity is invalid');
  }
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Workflow schema slug is invalid');
  }
}

function requireCrypto(crypto: MetadataCrypto | undefined): MetadataCrypto {
  if (!crypto || typeof crypto.seal !== 'function' || typeof crypto.open !== 'function') {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_CRYPTO_UNAVAILABLE', 'Workflow schema encryption is not configured');
  }
  return crypto;
}

function parseStoredPin(row: CatalogRow, stored: unknown, requestedTenantId: string): LegacyWorkflowSchemaPin {
  let parsedSchema: LegacyWorkflowSchema;
  try {
    const envelope = parseStoredEnvelope(stored);
    parsedSchema = parseLegacyWorkflowSchema(envelope.schema);
    const connectorSlotMap = validateLegacyWorkflowConnectorSlotMap(parsedSchema, envelope.connectorSlotMap);
    const approvedEgressOrigins = validateLegacyWorkflowEgressOrigins(parsedSchema, envelope.approvedEgressOrigins);
    const digest = schemaDigest(parsedSchema, connectorSlotMap, approvedEgressOrigins);
    if (row.tenant_id !== requestedTenantId || row.slug !== parsedSchema.slug || digest !== row.digest) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Stored workflow schema integrity check failed');
    }
    const pin = LegacyWorkflowSchemaPinSchema.safeParse({
      tenantId: row.tenant_id,
      slug: row.slug,
      revision: Number(row.revision),
      digest,
      schema: parsedSchema,
      connectorSlotMap,
      approvedEgressOrigins,
    });
    if (!pin.success) throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Stored workflow schema pin is malformed');
    return pin.data;
  } catch (error) {
    if (error instanceof LegacyWorkflowSchemaCatalogError) throw error;
    if (error instanceof LegacyWorkflowSchemaValidationError) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Stored workflow schema failed validation');
    }
    throw error;
  }
}

/**
 * Load a tenant-owned revision. Unknown slug/revision returns null; a retired
 * row is distinguishable so the HTTP adapter can report an inactive schema.
 * The schema JSON is never opened through a plaintext fallback.
 */
export async function resolveLegacyWorkflowSchema(
  db: Db,
  query: ResolveLegacyWorkflowSchemaQuery,
  metadataCrypto?: MetadataCrypto,
): Promise<LegacyWorkflowSchemaPin | null> {
  validateIdentity(query.tenantId, query.slug);
  if (query.revision !== undefined && (!Number.isSafeInteger(query.revision) || query.revision < 1)) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Workflow schema revision is invalid');
  }
  const selected = query.revision === undefined
    ? await db.query<CatalogRow>(
      `SELECT tenant_id, slug, revision, digest, schema_ref, status
       FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 AND status='active'`,
      [query.tenantId, query.slug],
    )
    : await db.query<CatalogRow>(
      `SELECT tenant_id, slug, revision, digest, schema_ref, status
       FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 AND revision=$3`,
      [query.tenantId, query.slug, query.revision],
    );
  if (!selected.rowCount) {
    if (query.revision !== undefined) return null;
    const retired = await db.query<{ revision: number }>(
      `SELECT revision FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 LIMIT 1`,
      [query.tenantId, query.slug],
    );
    if (retired.rowCount) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_NOT_ACTIVE', 'Workflow schema has no active revision');
    }
    return null;
  }
  const row = selected.rows[0]!;
  if (row.status !== 'active') {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_NOT_ACTIVE', 'Workflow schema revision is not active');
  }
  const crypto = requireCrypto(metadataCrypto);
  let opened: unknown;
  try {
    opened = await crypto.readStored(row.schema_ref, {
      tenantId: query.tenantId,
      slot: CATALOG_SLOT,
      refId: refId(row.slug, Number(row.revision)),
    }, false);
  } catch {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_CRYPTO_UNAVAILABLE', 'Workflow schema could not be decrypted');
  }
  return parseStoredPin(row, opened, query.tenantId);
}

/**
 * Add an immutable revision, sealing the full schema (including legacy inline
 * auth literals) before opening the transaction. No row stores plaintext.
 */
export async function provisionLegacyWorkflowSchema(
  db: Db,
  input: ProvisionLegacyWorkflowSchemaInput,
  metadataCrypto?: MetadataCrypto,
): Promise<LegacyWorkflowSchemaPin> {
  const crypto = requireCrypto(metadataCrypto);
  let schema: LegacyWorkflowSchema;
  try {
    schema = parseLegacyWorkflowSchema(input.schema);
  } catch (error) {
    if (error instanceof LegacyWorkflowSchemaValidationError) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', error.message);
    }
    throw error;
  }
  validateIdentity(input.tenantId, schema.slug);
  if (input.expectedRevision !== undefined && input.expectedRevision !== null
      && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Expected workflow schema revision is invalid');
  }
  // Load the prior immutable assignment before the write transaction. Vault
  // calls remain outside the transaction; a revision race is detected under
  // the advisory lock and fails as a clean compare-and-swap conflict.
  const previous = await db.query<CatalogRow>(
    `SELECT tenant_id, slug, revision, digest, schema_ref, status
     FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 AND status='active'`,
    [input.tenantId, schema.slug],
  );
  const observedRevision = previous.rowCount ? Number(previous.rows[0]!.revision) : null;
  if (input.expectedRevision !== undefined && input.expectedRevision !== observedRevision) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_REVISION_CONFLICT', 'Workflow schema active revision changed');
  }
  let priorMap: Record<string, string> | undefined;
  let priorOrigins: string[] | undefined;
  if (previous.rowCount) {
    const active = previous.rows[0]!;
    let opened: unknown;
    try {
      opened = await crypto.readStored(active.schema_ref, {
        tenantId: input.tenantId,
        slot: CATALOG_SLOT,
        refId: refId(schema.slug, Number(active.revision)),
      }, false);
      const envelope = parseStoredEnvelope(opened);
      const priorSchema = parseLegacyWorkflowSchema(envelope.schema);
      const priorPin = validateLegacyWorkflowConnectorSlotMap(priorSchema, envelope.connectorSlotMap);
      const priorApprovedOrigins = validateLegacyWorkflowEgressOrigins(priorSchema, envelope.approvedEgressOrigins);
      const priorDigest = schemaDigest(priorSchema, priorPin, priorApprovedOrigins);
      if (priorSchema.slug !== schema.slug || priorDigest !== active.digest) {
        throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Active workflow schema integrity check failed');
      }
      priorMap = priorPin;
      priorOrigins = priorApprovedOrigins;
    } catch (error) {
      if (error instanceof LegacyWorkflowSchemaCatalogError) throw error;
      if (error instanceof LegacyWorkflowSchemaValidationError) {
        throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Active workflow schema metadata is invalid');
      }
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_CRYPTO_UNAVAILABLE', 'Active workflow schema could not be decrypted');
    }
  }
  let connectorSlotMap: Record<string, string>;
  try {
    connectorSlotMap = allocateLegacyWorkflowConnectorSlotMap(schema, priorMap);
  } catch (error) {
    if (error instanceof LegacyWorkflowSchemaValidationError) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', error.message);
    }
    throw error;
  }
  let approvedEgressOrigins: string[];
  try {
    approvedEgressOrigins = validateLegacyWorkflowEgressOrigins(
      schema,
      input.approvedEgressOrigins ?? priorOrigins ?? [],
    );
  } catch (error) {
    if (error instanceof LegacyWorkflowSchemaValidationError) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', error.message);
    }
    throw error;
  }
  const digest = schemaDigest(schema, connectorSlotMap, approvedEgressOrigins);
  const maximum = await db.query<{ revision: number | null }>(
    `SELECT max(revision)::int AS revision FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2`,
    [input.tenantId, schema.slug],
  );
  const observedMaximum = Number(maximum.rows[0]?.revision ?? 0);
  const revision = observedMaximum + 1;
  const sealed = await crypto.seal({ schema, connectorSlotMap, approvedEgressOrigins }, {
    tenantId: input.tenantId,
    slot: CATALOG_SLOT,
    refId: refId(schema.slug, revision),
  });

  return db.tx(async (client) => {
    await lockSchemaSlug(client, input.tenantId, schema.slug);
    const active = await client.query<{ revision: number }>(
      `SELECT revision FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 AND status='active' FOR UPDATE`,
      [input.tenantId, schema.slug],
    );
    const activeRevision = active.rowCount ? Number(active.rows[0]!.revision) : null;
    if (activeRevision !== observedRevision) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_REVISION_CONFLICT', 'Workflow schema active revision changed');
    }
    const max = await client.query<{ revision: number | null }>(
      `SELECT max(revision)::int AS revision FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2`,
      [input.tenantId, schema.slug],
    );
    if (Number(max.rows[0]?.revision ?? 0) !== observedMaximum) {
      throw new LegacyWorkflowSchemaCatalogError('SCHEMA_REVISION_CONFLICT', 'Workflow schema history changed');
    }
    await client.query(
      `UPDATE legacy_workflow_schemas SET status='retired'
       WHERE tenant_id=$1 AND slug=$2 AND status='active'`,
      [input.tenantId, schema.slug],
    );
    await client.query(
      `INSERT INTO legacy_workflow_schemas (tenant_id, slug, revision, digest, schema_ref, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'active')`,
      [input.tenantId, schema.slug, revision, digest, JSON.stringify(sealed)],
    );
    return LegacyWorkflowSchemaPinSchema.parse({
      tenantId: input.tenantId,
      slug: schema.slug,
      revision,
      digest,
      schema,
      connectorSlotMap,
      approvedEgressOrigins,
    });
  });
}

/** Retire the active revision while retaining its immutable ciphertext for audit. */
export async function retireLegacyWorkflowSchema(
  db: Db,
  input: { readonly tenantId: string; readonly slug: string; readonly expectedRevision: number },
): Promise<boolean> {
  validateIdentity(input.tenantId, input.slug);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new LegacyWorkflowSchemaCatalogError('SCHEMA_INVALID', 'Workflow schema revision is invalid');
  }
  return db.tx(async (client) => {
    await lockSchemaSlug(client, input.tenantId, input.slug);
    const updated = await client.query(
      `UPDATE legacy_workflow_schemas SET status='retired'
       WHERE tenant_id=$1 AND slug=$2 AND revision=$3 AND status='active'`,
      [input.tenantId, input.slug, input.expectedRevision],
    );
    return (updated.rowCount ?? 0) === 1;
  });
}

async function lockSchemaSlug(client: PoolClient, tenantId: string, slug: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, slug]);
}

export { LegacyWorkflowSchemaSchema };
