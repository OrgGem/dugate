import {
  parseLegacyWorkflowSchema,
  type LegacyWorkflowSchema,
} from '@du/contracts';
import type { Db } from '../../db/db';
import type { MetadataCrypto } from '../runtime/metadata-crypto';
import {
  LegacyWorkflowSchemaCatalogError,
  provisionLegacyWorkflowSchema,
  resolveLegacyWorkflowSchema,
} from './workflow-schemas';

const WORKFLOW_SETTING_PREFIX = 'wb_schema:';
const LEGACY_TENANT_NAME = 'legacy-default';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKFLOW_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DYNAMIC_BINDING_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*/;
const MAX_APPROVED_ORIGINS = 16;

export interface LegacyWorkflowSchemaSettingIndex {
  readonly key: string;
  readonly updatedAt: Date;
}

export interface LegacyWorkflowSchemaSourceReader {
  listAppSettings(): Promise<readonly LegacyWorkflowSchemaSettingIndex[]>;
  readAppSettingValue(key: string): Promise<string | null>;
}

export interface WorkflowSchemaCandidate {
  readonly key: string;
  readonly slug: string;
  readonly updatedAt: Date;
}

export interface WorkflowSchemaLoser extends WorkflowSchemaCandidate {
  readonly reason: 'OLDER_UPDATED_AT' | 'TIED_UPDATED_AT_LOWER_KEY';
}

export interface LatestWorkflowSchemaCandidates {
  readonly winners: readonly WorkflowSchemaCandidate[];
  readonly losers: readonly WorkflowSchemaLoser[];
}

export type WorkflowSchemaSkipReason =
  | 'INVALID_SOURCE_SLUG'
  | 'INVALID_UPDATED_AT'
  | 'SETTING_VALUE_MISSING'
  | 'INVALID_SCHEMA'
  | 'KEY_SCHEMA_SLUG_MISMATCH'
  | 'DYNAMIC_EGRESS_URL'
  | 'INVALID_EGRESS_URL'
  | 'NON_HTTPS_EGRESS_URL'
  | 'EGRESS_URL_USERINFO'
  | 'EGRESS_WITHOUT_URL'
  | 'NO_DERIVED_EGRESS_ORIGIN'
  | 'TOO_MANY_EGRESS_ORIGINS'
  | 'ACTIVE_ROW_EXISTS'
  | 'SCHEMA_REVISION_CONFLICT';

export interface WorkflowSchemaSkip {
  readonly sourceKey: string;
  readonly slug: string;
  readonly reason: WorkflowSchemaSkipReason;
  readonly nodeId?: string;
}

export interface WorkflowSchemaWritten {
  readonly sourceKey: string;
  readonly slug: string;
  readonly revision: number;
  readonly status: 'active';
  readonly tenantId: string;
  readonly digest: string;
  readonly approvedEgressOrigins: readonly string[];
}

export interface WorkflowSchemaPlan {
  readonly sourceKey: string;
  readonly slug: string;
  readonly tenantId: string;
  readonly approvedEgressOrigins: readonly string[];
}

export interface WorkflowSchemaBackfillReport {
  readonly status: 'COMPLETED' | 'PREFLIGHT_COMPLETE' | 'PREFLIGHT_TENANT_PENDING';
  readonly tenantName: string;
  readonly tenantId: string | null;
  readonly tenantStatus: 'existing' | 'seeded' | 'pending';
  readonly written: readonly WorkflowSchemaWritten[];
  readonly planned: readonly WorkflowSchemaPlan[];
  readonly skipped: readonly WorkflowSchemaSkip[];
  readonly losers: readonly WorkflowSchemaLoser[];
}

export interface RunWorkflowSchemaBackfillOptions {
  readonly source: LegacyWorkflowSchemaSourceReader;
  readonly sink: Db;
  readonly metadataCrypto: MetadataCrypto;
  readonly apply: boolean;
}

export class WorkflowSchemaBackfillError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowSchemaBackfillError';
    this.code = code;
  }
}

function compareUtf8ByteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareCandidatePriority(left: WorkflowSchemaCandidate, right: WorkflowSchemaCandidate): number {
  const timeDifference = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (timeDifference !== 0) return timeDifference;
  return compareUtf8ByteOrder(right.key, left.key);
}

export function selectLatestWorkflowSchemaCandidates(
  candidates: readonly WorkflowSchemaCandidate[],
): LatestWorkflowSchemaCandidates {
  const groups = new Map<string, WorkflowSchemaCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.slug) ?? [];
    group.push(candidate);
    groups.set(candidate.slug, group);
  }

  const winners: WorkflowSchemaCandidate[] = [];
  const losers: WorkflowSchemaLoser[] = [];
  const slugs = Array.from(groups.keys()).sort(compareUtf8ByteOrder);
  for (const slug of slugs) {
    const ordered = [...(groups.get(slug) ?? [])].sort(compareCandidatePriority);
    const winner = ordered[0];
    if (!winner) continue;
    winners.push(winner);
    for (const loser of ordered.slice(1)) {
      losers.push({
        ...loser,
        reason: loser.updatedAt.getTime() === winner.updatedAt.getTime()
          ? 'TIED_UPDATED_AT_LOWER_KEY'
          : 'OLDER_UPDATED_AT',
      });
    }
  }

  return { winners, losers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectConfiguredUrls(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectConfiguredUrls(entry, output);
    return;
  }
  if (isRecord(value) && Object.hasOwn(value, 'url')) {
    collectConfiguredUrls(value.url, output);
  }
}

interface EgressDerivation {
  readonly hasEgress: boolean;
  readonly origins: readonly string[];
  readonly skipReason?: WorkflowSchemaSkipReason;
  readonly nodeId?: string;
}

function deriveApprovedEgressOrigins(schema: LegacyWorkflowSchema): EgressDerivation {
  const origins = new Set<string>();
  let hasEgress = false;

  const visit = (nodes: readonly unknown[]): EgressDerivation | undefined => {
    for (const nodeValue of nodes) {
      if (!isRecord(nodeValue)) continue;
      const nodeType = nodeValue.type;
      const nodeId = typeof nodeValue.id === 'string' ? nodeValue.id : undefined;

      if (nodeType === 'parallel' && Array.isArray(nodeValue.branches)) {
        for (const branch of nodeValue.branches) {
          if (!Array.isArray(branch)) continue;
          const nested = visit(branch);
          if (nested?.skipReason) return nested;
        }
      }

      if (nodeType !== 'file_url_download' && nodeType !== 'callback') continue;
      hasEgress = true;
      const configuredValue = nodeType === 'callback' ? nodeValue.url : nodeValue.urls;
      const configuredUrls: string[] = [];
      collectConfiguredUrls(configuredValue, configuredUrls);
      if (configuredUrls.length === 0) {
        return { hasEgress: true, origins: [], skipReason: 'EGRESS_WITHOUT_URL', nodeId };
      }

      for (const configuredUrl of configuredUrls) {
        if (DYNAMIC_BINDING_PATTERN.test(configuredUrl)) {
          return { hasEgress: true, origins: [], skipReason: 'DYNAMIC_EGRESS_URL', nodeId };
        }

        let parsed: URL;
        try {
          parsed = new URL(configuredUrl);
        } catch {
          return { hasEgress: true, origins: [], skipReason: 'INVALID_EGRESS_URL', nodeId };
        }
        if (parsed.protocol !== 'https:') {
          return { hasEgress: true, origins: [], skipReason: 'NON_HTTPS_EGRESS_URL', nodeId };
        }
        if (parsed.username !== '' || parsed.password !== '') {
          return { hasEgress: true, origins: [], skipReason: 'EGRESS_URL_USERINFO', nodeId };
        }
        if (parsed.hash !== '') {
          return { hasEgress: true, origins: [], skipReason: 'INVALID_EGRESS_URL', nodeId };
        }
        origins.add(parsed.origin);
      }
    }
    return undefined;
  };

  const nestedSkip = visit(schema.nodes);
  if (nestedSkip?.skipReason) return nestedSkip;

  const approvedEgressOrigins = Array.from(origins).sort();
  if (approvedEgressOrigins.length > MAX_APPROVED_ORIGINS) {
    return { hasEgress, origins: [], skipReason: 'TOO_MANY_EGRESS_ORIGINS' };
  }
  if (hasEgress && approvedEgressOrigins.length === 0) {
    return { hasEgress, origins: [], skipReason: 'NO_DERIVED_EGRESS_ORIGIN' };
  }
  return { hasEgress, origins: approvedEgressOrigins };
}

interface TenantResolution {
  readonly tenantId: string | null;
  readonly tenantStatus: 'existing' | 'seeded' | 'pending';
}

async function resolveTenantIdsByName(sink: Db): Promise<unknown[]> {
  const result = await sink.query<{ id: string }>(
    'SELECT id FROM tenants WHERE name = $1',
    [LEGACY_TENANT_NAME],
  );
  return result.rows.map((row) => row.id);
}

async function seedTenantByName(sink: Db): Promise<void> {
  await sink.tx(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['legacy-tenant-name', LEGACY_TENANT_NAME],
    );
    const current = await client.query<{ id: string }>(
      'SELECT id FROM tenants WHERE name = $1',
      [LEGACY_TENANT_NAME],
    );
    if (current.rows.length > 1) {
      throw new WorkflowSchemaBackfillError('DUPLICATE_TENANT_NAME', 'tenant name resolves to multiple rows');
    }
    if (current.rows.length === 0) {
      await client.query('INSERT INTO tenants (name) VALUES ($1)', [LEGACY_TENANT_NAME]);
    }
  });
}

async function resolveTenant(sink: Db, apply: boolean): Promise<TenantResolution> {
  let tenantIds = await resolveTenantIdsByName(sink);
  if (tenantIds.length > 1) {
    throw new WorkflowSchemaBackfillError('DUPLICATE_TENANT_NAME', 'tenant name resolves to multiple rows');
  }
  if (tenantIds.length === 0 && !apply) {
    return { tenantId: null, tenantStatus: 'pending' };
  }

  let tenantStatus: TenantResolution['tenantStatus'] = 'existing';
  if (tenantIds.length === 0) {
    await seedTenantByName(sink);
    tenantStatus = 'seeded';
    tenantIds = await resolveTenantIdsByName(sink);
    if (tenantIds.length > 1) {
      throw new WorkflowSchemaBackfillError('DUPLICATE_TENANT_NAME', 'tenant name resolved to multiple rows after seed');
    }
  }

  if (tenantIds.length !== 1 || typeof tenantIds[0] !== 'string' || !UUID_PATTERN.test(tenantIds[0])) {
    throw new WorkflowSchemaBackfillError('TENANT_UUID_UNRESOLVED', 'tenant name did not resolve to exactly one UUID');
  }
  return { tenantId: tenantIds[0].toLowerCase(), tenantStatus };
}

function emptyReport(
  status: WorkflowSchemaBackfillReport['status'],
  tenantId: string | null,
  tenantStatus: TenantResolution['tenantStatus'],
): WorkflowSchemaBackfillReport {
  return {
    status,
    tenantName: LEGACY_TENANT_NAME,
    tenantId,
    tenantStatus,
    written: [],
    planned: [],
    skipped: [],
    losers: [],
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runWorkflowSchemaBackfill(
  options: RunWorkflowSchemaBackfillOptions,
): Promise<WorkflowSchemaBackfillReport> {
  const tenant = await resolveTenant(options.sink, options.apply);
  if (tenant.tenantStatus === 'pending' || tenant.tenantId === null) {
    return emptyReport('PREFLIGHT_TENANT_PENDING', null, 'pending');
  }

  const skipped: WorkflowSchemaSkip[] = [];
  const planned: WorkflowSchemaPlan[] = [];
  const written: WorkflowSchemaWritten[] = [];
  const indexRows = await options.source.listAppSettings();
  const candidates: WorkflowSchemaCandidate[] = [];

  for (const indexRow of indexRows) {
    if (!indexRow.key.startsWith(WORKFLOW_SETTING_PREFIX)) continue;
    const slug = indexRow.key.slice(WORKFLOW_SETTING_PREFIX.length);
    if (!WORKFLOW_SLUG_PATTERN.test(slug)) {
      skipped.push({ sourceKey: indexRow.key, slug, reason: 'INVALID_SOURCE_SLUG' });
      continue;
    }
    if (!(indexRow.updatedAt instanceof Date) || !Number.isFinite(indexRow.updatedAt.getTime())) {
      skipped.push({ sourceKey: indexRow.key, slug, reason: 'INVALID_UPDATED_AT' });
      continue;
    }
    candidates.push({ key: indexRow.key, slug, updatedAt: indexRow.updatedAt });
  }

  const selected = selectLatestWorkflowSchemaCandidates(candidates);
  const losers = [...selected.losers];

  for (const candidate of selected.winners) {
    const sourceValue = await options.source.readAppSettingValue(candidate.key);
    if (sourceValue === null) {
      skipped.push({ sourceKey: candidate.key, slug: candidate.slug, reason: 'SETTING_VALUE_MISSING' });
      continue;
    }

    let schema: LegacyWorkflowSchema;
    try {
      schema = parseLegacyWorkflowSchema(JSON.parse(sourceValue) as unknown);
    } catch {
      skipped.push({ sourceKey: candidate.key, slug: candidate.slug, reason: 'INVALID_SCHEMA' });
      continue;
    }
    if (schema.slug !== candidate.slug) {
      skipped.push({ sourceKey: candidate.key, slug: candidate.slug, reason: 'KEY_SCHEMA_SLUG_MISMATCH' });
      continue;
    }

    const egress = deriveApprovedEgressOrigins(schema);
    if (egress.skipReason) {
      skipped.push({
        sourceKey: candidate.key,
        slug: candidate.slug,
        reason: egress.skipReason,
        ...(egress.nodeId ? { nodeId: egress.nodeId } : {}),
      });
      continue;
    }

    const active = await options.sink.query<{ revision: number }>(
      'SELECT revision FROM legacy_workflow_schemas WHERE tenant_id = $1 AND slug = $2 AND status = \'active\'',
      [tenant.tenantId, schema.slug],
    );
    if (active.rows.length > 0) {
      skipped.push({ sourceKey: candidate.key, slug: candidate.slug, reason: 'ACTIVE_ROW_EXISTS' });
      continue;
    }

    const approvedEgressOrigins = [...egress.origins];
    if (!options.apply) {
      planned.push({
        sourceKey: candidate.key,
        slug: candidate.slug,
        tenantId: tenant.tenantId,
        approvedEgressOrigins,
      });
      continue;
    }

    let pin;
    try {
      pin = await provisionLegacyWorkflowSchema(
        options.sink,
        {
          tenantId: tenant.tenantId,
          schema,
          approvedEgressOrigins,
          expectedRevision: null,
        },
        options.metadataCrypto,
      );
    } catch (error) {
      if (error instanceof LegacyWorkflowSchemaCatalogError && error.code === 'SCHEMA_REVISION_CONFLICT') {
        skipped.push({ sourceKey: candidate.key, slug: candidate.slug, reason: 'SCHEMA_REVISION_CONFLICT' });
        continue;
      }
      throw error;
    }

    const resolved = await resolveLegacyWorkflowSchema(
      options.sink,
      { tenantId: tenant.tenantId, slug: schema.slug },
      options.metadataCrypto,
    );
    const resolvedOrigins = resolved?.approvedEgressOrigins;
    if (
      resolved === null
      || resolvedOrigins === undefined
      || resolved.revision !== pin.revision
      || resolved.tenantId !== pin.tenantId
      || resolved.slug !== pin.slug
      || resolved.digest !== pin.digest
      || !sameJson(resolved.schema, pin.schema)
      || !sameJson(resolved.connectorSlotMap, pin.connectorSlotMap)
      || !sameJson(resolved.approvedEgressOrigins, pin.approvedEgressOrigins)
    ) {
      throw new WorkflowSchemaBackfillError('ROUND_TRIP_MISMATCH', 'catalog writer output failed catalog reader verification');
    }

    written.push({
      sourceKey: candidate.key,
      slug: resolved.slug,
      revision: resolved.revision,
      status: 'active',
      tenantId: resolved.tenantId,
      digest: resolved.digest,
      approvedEgressOrigins: [...resolvedOrigins],
    });
  }

  return {
    status: options.apply ? 'COMPLETED' : 'PREFLIGHT_COMPLETE',
    tenantName: LEGACY_TENANT_NAME,
    tenantId: tenant.tenantId,
    tenantStatus: tenant.tenantStatus,
    written,
    planned,
    skipped,
    losers,
  };
}
