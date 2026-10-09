import React from 'react';
import { useTenant } from '@/lib/tenant-context';
import { Badge } from '@/components/ui/badge';

export function GlobalTenantSelector(): React.JSX.Element {
  const { tenantId, tenant, tenants, loading, setTenantId } = useTenant();

  return (
    <div className="mx-3 mb-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-muted)] p-2.5">
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-sub)]">
          Active Tenant
        </span>
        {tenant ? (
          <Badge variant={tenant.state === 'ACTIVE' ? 'success' : 'neutral'} dot>
            {tenant.state}
          </Badge>
        ) : null}
      </div>

      {loading ? (
        <div className="text-xs text-[var(--text-sub)] py-1">Loading tenants…</div>
      ) : tenants.length === 0 ? (
        <div className="text-xs text-[var(--badge-danger-text)] py-1">No tenants available</div>
      ) : (
        <div className="flex flex-col gap-1">
          <select
            id="global-tenant-select"
            aria-label="Select active tenant"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1.5 text-xs font-medium text-[var(--text-main)] shadow-xs transition-colors focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            value={tenantId ?? ''}
            onChange={(e) => setTenantId(e.target.value || null)}
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {tenant ? (
            <span className="font-mono text-[10px] text-[var(--text-sub)] truncate block" title={tenant.id}>
              {tenant.id.slice(0, 18)}…
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
