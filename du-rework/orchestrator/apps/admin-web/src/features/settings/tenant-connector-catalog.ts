import type { TenantActiveConnectorCatalogPage, TenantActiveConnectorCatalogQuery } from '@du/contracts';
import type { AdminWebSession } from '../../lib/api';

export type TenantActiveConnectorClientQuery = Omit<TenantActiveConnectorCatalogQuery, 'tenantId'> & { tenantId?: string };

/** Platform Admins must choose the tenant explicitly; tenant operators are
 * pinned by the BFF and must never widen their own session with a tenant ID. */
export function tenantActiveConnectorQuery(
  session: AdminWebSession | null,
  tenantId: string | null,
  q: string,
  cursor: string | null,
): TenantActiveConnectorClientQuery | null {
  if (!session || session.role !== 'admin' || !tenantId) return null;
  if (session.principal.kind === 'platform') {
    return { tenantId, ...(q.trim() ? { q: q.trim() } : {}), ...(cursor ? { cursor } : {}), limit: 100 };
  }
  if (session.principal.kind === 'tenant_operator' && session.principal.tenantId === tenantId) {
    return { ...(q.trim() ? { q: q.trim() } : {}), ...(cursor ? { cursor } : {}), limit: 100 };
  }
  return null;
}

export function tenantActiveConnectorPageMatches(page: TenantActiveConnectorCatalogPage, tenantId: string): boolean {
  return page.tenantId === tenantId && page.items.every((item) => item.tenantId === tenantId);
}
