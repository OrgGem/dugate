import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { OperationsScreen } from '@/features/operations/operations-screen';
import { LoadingState } from '@/components/ui/state-panel';
import { useTenant } from '@/lib/tenant-context';
import { traceWorkspacePath } from '@/features/trace/state';
import { TraceScreen } from '@/features/trace/trace-screen';

function safeTenantQueryValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function OperationsWorkspaceView({ rawTenantId }: { rawTenantId: string | null }) {
  const { tenantId, tenants, loading: tenantsLoading, setTenantId } = useTenant();
  const [, setSearchParams] = useSearchParams();
  const requestedTenantId = safeTenantQueryValue(rawTenantId);
  const [tenantQueryError, setTenantQueryError] = useState<string | null>(
    rawTenantId !== null && requestedTenantId === null
      ? 'The tenant ID in this link is invalid. Select an available tenant from the left navigation.'
      : null,
  );
  const resolvedTenantQuery = useRef<string | null>(null);
  const clearTenantQuery = useCallback(() => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('tenantId');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (rawTenantId === null) {
      resolvedTenantQuery.current = null;
      setTenantQueryError(null);
      return;
    }
    if (requestedTenantId === null) {
      resolvedTenantQuery.current = rawTenantId;
      setTenantQueryError('The tenant ID in this link is invalid. Select an available tenant from the left navigation.');
      return;
    }
    if (tenantsLoading) return;
    if (resolvedTenantQuery.current === requestedTenantId) {
      if (tenantId === requestedTenantId) clearTenantQuery();
      return;
    }
    resolvedTenantQuery.current = requestedTenantId;
    if (!tenants.some((item) => item.id === requestedTenantId)) {
      setTenantQueryError('The tenant in this link is not available to this session. Select an available tenant from the left navigation.');
      return;
    }
    setTenantQueryError(null);
    if (tenantId !== requestedTenantId) setTenantId(requestedTenantId);
    else clearTenantQuery();
  }, [rawTenantId, requestedTenantId, tenantId, tenants, tenantsLoading, setTenantId, clearTenantQuery]);

  if (tenantQueryError !== null) return <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-[var(--badge-warning-text)]">
    <span>{tenantQueryError}</span>
    <button type="button" className="font-medium underline underline-offset-2" onClick={clearTenantQuery}>Clear tenant from this link</button>
  </div>;
  if (rawTenantId !== null && (tenantsLoading || requestedTenantId !== tenantId)) {
    return <LoadingState title="Resolving tenant scope…" description="Operation reads wait until the tenant link is validated." />;
  }
  return <OperationsScreen />;
}

/** Route entry for `admin/trace`; lookup and timeline logic live in the feature. */
export function TraceRoute() {
  const [searchParams] = useSearchParams();
  const operationsActive = searchParams.get('view') === 'operations';
  const search = searchParams.toString();

  return <section className="flex min-w-0 flex-col gap-5">
    <nav aria-label="Trace workspace views" className="flex min-w-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] pb-2">
      {(['trace', 'operations'] as const).map((view) => {
        const active = view === 'operations' ? operationsActive : !operationsActive;
        const label = view === 'operations' ? 'Operations' : 'Trace';
        return <Link
          key={view}
          to={traceWorkspacePath(search, view)}
          aria-current={active ? 'page' : undefined}
          className={`shrink-0 rounded-md px-3 py-2 text-sm no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${active ? 'bg-[var(--cf-blue-light)] font-semibold text-[var(--cf-blue)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}
        >{label}</Link>;
      })}
    </nav>
    {operationsActive
      ? <OperationsWorkspaceView rawTenantId={searchParams.get('tenantId')} />
      : <TraceScreen />}
  </section>;
}
