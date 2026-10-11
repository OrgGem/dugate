import type { Db } from '../../db/db';
import type { MetadataCrypto } from '../runtime/metadata-crypto';

export interface WorkflowCatalogRow {
  tenantId: string;
  slug: string;
  revision: number;
  digest: string;
  status: 'active' | 'retired';
  createdAt: string;
  businessId?: string | null;
  businessVersion?: string | null;
  name?: string;
  description?: string;
  nodesCount?: number;
  stages?: string[];
  schema?: unknown;
  connectorSlotMap?: Record<string, string>;
  approvedEgressOrigins?: string[];
}

export interface WorkflowListFilter {
  businessId?: string;
  businessVersion?: string;
}

export async function listAdminWorkflows(
  db: Db,
  tenantId: string | null,
  metadataCrypto?: MetadataCrypto,
  filter: WorkflowListFilter = {},
): Promise<WorkflowCatalogRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (tenantId !== null) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (filter.businessId !== undefined) {
    params.push(filter.businessId);
    clauses.push(`business_id = $${params.length}`);
  }
  if (filter.businessVersion !== undefined) {
    params.push(filter.businessVersion);
    clauses.push(`business_version = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const res = await db.query<{
    tenant_id: string;
    business_id: string | null;
    business_version: string | null;
    slug: string;
    revision: number;
    digest: string;
    status: 'active' | 'retired';
    created_at: Date | string;
    schema_ref: unknown;
  }>(
    `SELECT tenant_id, business_id, business_version, slug, revision, digest, status, created_at, schema_ref
       FROM legacy_workflow_schemas
       ${where}
       ORDER BY slug ASC, revision DESC`,
    params,
  );

  const items: WorkflowCatalogRow[] = [];
  for (const row of res.rows) {
    const item: WorkflowCatalogRow = {
      tenantId: row.tenant_id,
      slug: row.slug,
      revision: Number(row.revision),
      digest: row.digest,
      status: row.status,
      createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
      ...(typeof row.business_id === 'string' ? { businessId: row.business_id } : {}),
      ...(typeof row.business_version === 'string' ? { businessVersion: row.business_version } : {}),
      name: row.slug,
    };

    if (metadataCrypto) {
      try {
        const opened = await metadataCrypto.readStored(
          row.schema_ref,
          {
            tenantId: row.tenant_id,
            slot: 'legacy_workflow_schemas.schema_ref',
            refId: `${row.slug}:${row.revision}`,
          },
          false,
        );
        if (opened && typeof opened === 'object') {
          const envelope = opened as Record<string, unknown>;
          const rawSchema = envelope.schema as Record<string, unknown> | undefined;
          if (rawSchema) {
            item.name = typeof rawSchema.name === 'string' ? rawSchema.name : row.slug;
            item.description = typeof rawSchema.description === 'string' ? rawSchema.description : undefined;
            if (Array.isArray(rawSchema.nodes)) {
              item.nodesCount = rawSchema.nodes.length;
              item.stages = rawSchema.nodes.map((n: Record<string, unknown>) => String(n.id || n.name || n.type));
            }
            item.schema = rawSchema;
          }
          if (envelope.connectorSlotMap && typeof envelope.connectorSlotMap === 'object') {
            item.connectorSlotMap = envelope.connectorSlotMap as Record<string, string>;
          }
          if (Array.isArray(envelope.approvedEgressOrigins)) {
            item.approvedEgressOrigins = envelope.approvedEgressOrigins as string[];
          }
        }
      } catch {
        // Fallback: If ciphertext cannot be opened, catalog row summary is still returned
        item.name = row.slug;
      }
    }

    items.push(item);
  }

  return items;
}

export async function getAdminWorkflowDetail(
  db: Db,
  tenantId: string,
  slug: string,
  metadataCrypto?: MetadataCrypto,
): Promise<{ active: WorkflowCatalogRow | null; revisions: WorkflowCatalogRow[] }> {
  const rows = await listAdminWorkflows(db, tenantId, metadataCrypto);
  const matching = rows.filter((r) => r.slug === slug);
  const active = matching.find((r) => r.status === 'active') ?? null;
  return { active, revisions: matching };
}
