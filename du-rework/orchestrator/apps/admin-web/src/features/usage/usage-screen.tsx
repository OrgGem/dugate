import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { useTenant } from '@/lib/tenant-context';
import { createAdminApiClient, type UsageSummary } from '@/lib/api';
import type { Loadable, PaneState } from '@/features/overview/state';

/**
 * Usage (AWEB-06) — reads the real tenant-scoped summary through the BFF.
 * The route requires from/to; the UI defaults to the last 24h.
 */

/** OPU-G2: polling cadence; polling starts only after the operator opts in. */
const AUTO_REFRESH_MS = 10_000;

function formatDataAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * OPU-G2: the age of the data currently on screen, derived from when the last
 * successful load completed. Never loaded → Unavailable (never a zero or a
 * fake age). A failed refresh keeps the last good data and says so.
 */
function DataAgeLabel({ lastSuccessAt, stale }: { lastSuccessAt: number | null; stale: boolean }) {
  return (
    <span
      className="text-xs text-[var(--text-sub)]"
      data-portal-data-age="true"
      data-data-age-state={lastSuccessAt === null ? 'unavailable' : stale ? 'stale' : 'fresh'}
    >
      {lastSuccessAt === null
        ? 'Data age: Unavailable (no successful load yet)'
        : `Data age: ${formatDataAge(Date.now() - lastSuccessAt)}${
            stale ? ' · stale (last refresh failed; showing last good data)' : ''
          }`}
    </span>
  );
}

export function UsageScreen() {
  const { tenantId: globalTenantId, tenant } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const now = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 16));
  const [to, setTo] = useState(now.toISOString().slice(0, 16));
  const validWindow = from.length > 0 && to.length > 0 && Number.isFinite(Date.parse(from + 'Z')) && Number.isFinite(Date.parse(to + 'Z')) && Date.parse(from + 'Z') < Date.parse(to + 'Z');
  const [summary, setSummary] = useState<Loadable<UsageSummary> | null>(null);
  const tenantId = globalTenantId;
  const [sessionReady, setSessionReady] = useState(false);
  const validTenant = typeof tenantId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  // Stable box that lets `load` know synchronously whether a prior success
  // exists (the offline element-tree harnesses predate `useRef` support, so a
  // never-set state slot is used instead).
  const [lastSuccess] = useState<{ current: number | null }>({ current: null });

  useEffect(() => {
    let active = true;
    void client.getSession().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setSummary({ kind: 'failed', problem: result.problem });
        return;
      }
      setSessionReady(true);
    });
    return () => { active = false; };
  }, [client]);

  const load = useCallback(async (): Promise<void> => {
    if (!sessionReady || !validWindow || !validTenant || tenantId === null) return;
    // A refresh must not blank the screen: only the first load shows Loading.
    if (lastSuccess.current === null) setSummary({ kind: 'loading' });
    const result = await client.getUsage({ tenantId, from: new Date(from + 'Z').toISOString(), to: new Date(to + 'Z').toISOString() });
    if (!result.ok) {
      if (lastSuccess.current === null) {
        setSummary({ kind: 'failed', problem: result.problem });
      } else {
        // Keep the last good summary visible; mark the data stale.
        setStale(true);
      }
      return;
    }
    const stamp = Date.now();
    lastSuccess.current = stamp;
    setLastSuccessAt(stamp);
    setStale(false);
    setSummary({ kind: 'ready', data: result.data });
  }, [client, from, to, validWindow, tenantId, validTenant, sessionReady, lastSuccess]);

  useEffect(() => {
    void load();
  }, [load]);

  // OPU-G2: one interval, created only after opt-in; the cleanup covers both
  // toggle-off and unmount, so no interval can leak.
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      void load();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const pane: PaneState<UsageSummary> | null =
    summary === null
      ? null
      : summary.kind === 'loading'
        ? { kind: 'loading' }
        : summary.kind === 'failed'
          ? summary.problem.status === 403
            ? { kind: 'denied', problem: summary.problem }
            : { kind: 'error', problem: summary.problem }
          : Object.keys(summary.data).length === 0
            ? { kind: 'empty' }
            : { kind: 'ready', data: summary.data };

  return (
    <section aria-labelledby="usage-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="usage-title" className="text-lg font-semibold">
          Usage
        </h1>
        <Badge variant="neutral">tenant scoped</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Window</CardTitle>
          <CardDescription>Usage requires a tenant and time window. Tenant sessions use their own scope; platform sessions must select a tenant.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-sm">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-[var(--text-sub)]">Active Tenant</span>
              <div className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-sm">
                <span className="font-medium text-[var(--text-main)] truncate">
                  {tenant?.name || (tenantId ? `Tenant (${tenantId.slice(0, 8)}...)` : 'No Tenant Selected')}
                </span>
                {tenant && (
                  <Badge variant={tenant.state === 'ACTIVE' ? 'success' : 'neutral'} className="text-[10px] py-0 px-1.5 ml-auto">
                    {tenant.state}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-[var(--text-sub)]">Inherited from Global Tenant in Left Navigator.</p>
            </div>
          </div>
          <div className="w-full max-w-sm">
            <FormField id="usage-from" label="From (UTC)">
              <Input id="usage-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </FormField>
          </div>
          <div className="w-full max-w-sm">
            <FormField id="usage-to" label="To (UTC)">
              <Input id="usage-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </FormField>
          </div>
          <Button onClick={() => void load()} disabled={!sessionReady || !validWindow || !validTenant || !tenantId}>Load usage</Button>
          {sessionReady && !tenantId ? <p role="alert" className="w-full text-sm text-[var(--badge-danger-text)]">Select an active tenant in the left navigator to load usage.</p> : null}
          {!validWindow ? <p role="alert" className="w-full text-sm text-[var(--badge-danger-text)]">Choose a start time before the end time.</p> : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant={autoRefresh ? 'secondary' : 'ghost'}
          aria-pressed={autoRefresh}
          data-portal-auto-refresh-toggle="true"
          onClick={() => setAutoRefresh(!autoRefresh)}
        >
          Auto refresh: {autoRefresh ? 'On' : 'Off'}
        </Button>
        <DataAgeLabel lastSuccessAt={lastSuccessAt} stale={stale} />
      </div>

      {pane?.kind === 'loading' ? <LoadingState title="Loading usage…" /> : null}
      {pane?.kind === 'denied' ? (
        <DeniedState title="Access denied" description={pane.problem.title ?? 'Not authorized for this tenant scope.'} />
      ) : null}
      {pane?.kind === 'error' ? (
        <ErrorState
          title={pane.problem.title ?? 'Failed to load usage.'}
          statusCode={pane.problem.status}
          error={pane.problem.code}
          onRetry={() => void load()}
        />
      ) : null}
      {pane?.kind === 'empty' ? <EmptyState title="No usage rows" description="The window returned no usage data." /> : null}
      {pane?.kind === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
            <CardDescription>Platform projection, verbatim — no client-side aggregation.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">
              {JSON.stringify(pane.data, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
