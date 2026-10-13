import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { usageCostState } from './cost-state';
import { CostAlertsPanel } from './cost-alerts-panel';
import { CostAdjustmentPanel } from './cost-adjustment-panel';
import { CostPolicyPanel } from './cost-policy-panel';
import {
  buildUsageEventQuery,
  buildUsageEventsCsv,
  costStatusLabel,
  defaultUsageFilters,
  formatUsageCost,
  parseAdminUsageEventPage,
  parseUsageSummary,
  usageFiltersFromSearch,
  usageFiltersToSearch,
  usageMeasurementLabel,
  usageRequestIsCurrent,
  validateUsageFilters,
  type AdminUsageEventPageView,
  type UsageFilters,
  type UsageSummaryView,
} from './state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTenant } from '@/lib/tenant-context';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession } from '@/lib/api';

const AUTO_REFRESH_MS = 10_000;
const PAGE_SIZES = ['25', '50', '100'] as const;

type SessionState = { kind: 'loading' } | { kind: 'ready'; data: AdminWebSession } | { kind: 'failed'; problem: AdminApiProblem };
type RemoteState<T> =
  | { kind: 'loading'; scope: string }
  | { kind: 'failed'; scope: string; problem: AdminApiProblem }
  | { kind: 'ready'; scope: string; data: T; lastSuccessAt: number; stale: boolean; refreshing: boolean };

interface UsageCache<T> {
  scope: string;
  data: T;
  lastSuccessAt: number;
}

function formatDataAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function DataAgeLabel({ lastSuccessAt, stale }: { lastSuccessAt: number | null; stale: boolean }) {
  return (
    <span
      className="text-xs text-[var(--text-sub)]"
      data-portal-data-age="true"
      data-data-age-state={lastSuccessAt === null ? 'unavailable' : stale ? 'stale' : 'fresh'}
    >
      {lastSuccessAt === null
        ? 'Data age: Unavailable (no successful load yet)'
        : `Data age: ${formatDataAge(Date.now() - lastSuccessAt)}${stale ? ' · stale (last refresh failed; showing last good data)' : ''}`}
    </span>
  );
}

function windowSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatMicrousd(value: number): string {
  return `${(value / 1_000_000).toFixed(6)} USD`;
}

function formatNullableMicrousd(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : formatMicrousd(value);
}

function formatUtcTimestamp(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function moneyState(summary: UsageSummaryView) {
  return usageCostState({ totals: { costMicrousd: summary.totals.costMicrousd, costStatus: summary.totals.costStatus } });
}

function usageStatusVariant(status: string | null): 'success' | 'info' | 'warning' | 'neutral' {
  switch (status) {
    case 'measured': return 'success';
    case 'estimated': return 'warning';
    case 'pending': return 'warning';
    case 'unpriced': return 'warning';
    default: return 'neutral';
  }
}

function downloadCurrentPage(page: AdminUsageEventPageView, tenantId: string, filters: UsageFilters, pageIndex: number): void {
  if (page.events.length === 0) return;
  const blob = new Blob([buildUsageEventsCsv(page.events, tenantId)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeTenant = tenantId.replace(/[^A-Za-z0-9-]/g, '_');
  const from = filters.from.slice(0, 10);
  const to = filters.to.slice(0, 10);
  link.download = `usage-${safeTenant}-${from}-${to}-page-${pageIndex + 1}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function WindowPresets({ onChoose }: { onChoose: (durationMs: number) => void }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Quick time windows">
      <Button type="button" size="sm" variant="ghost" onClick={() => onChoose(24 * 60 * 60 * 1000)}>Last 24 hours</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => onChoose(7 * 24 * 60 * 60 * 1000)}>Last 7 days</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => onChoose(30 * 24 * 60 * 60 * 1000)}>Last 30 days</Button>
    </div>
  );
}

export function UsageScreen() {
  const { tenantId } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [sessionRetry, setSessionRetry] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UsageFilters>(() => usageFiltersFromSearch(windowSearch()));
  const [filters, setFilters] = useState<UsageFilters>(() => usageFiltersFromSearch(windowSearch()));
  const [cursorNavigation, setCursorNavigation] = useState<{ scope: string; cursors: Array<string | null>; index: number }>({ scope: '', cursors: [null], index: 0 });
  const [summaryState, setSummaryState] = useState<RemoteState<UsageSummaryView> | null>(null);
  const [eventState, setEventState] = useState<RemoteState<AdminUsageEventPageView> | null>(null);
  const [adjustmentScope, setAdjustmentScope] = useState<string | null>(null);
  // Stable mutable boxes keep request IDs/current scopes synchronous without
  // putting transport state into a shared API store. The screen’s offline
  // harness predates useRef, so useState supplies the same stable object.
  const [requestFence] = useState({ summaryGeneration: 0, eventsGeneration: 0, summaryScope: null as string | null, eventsScope: null as string | null, summaryToken: null as string | null, eventsToken: null as string | null });
  const [lastGood] = useState({ summary: null as UsageCache<UsageSummaryView> | null, events: null as UsageCache<AdminUsageEventPageView> | null });

  const validTenant = typeof tenantId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId);
  const appliedWindow = validateUsageFilters(filters);
  const summaryScope = session.kind === 'ready' && validTenant && appliedWindow.error === null && appliedWindow.from !== null && appliedWindow.to !== null
    ? JSON.stringify([tenantId, appliedWindow.from, appliedWindow.to])
    : null;
  const baseEventScope = session.kind === 'ready' && validTenant && appliedWindow.error === null
    ? JSON.stringify([tenantId, filters.from, filters.to, filters.provider, filters.model, filters.operationId, filters.limit])
    : null;
  const activeCursor = baseEventScope !== null && cursorNavigation.scope === baseEventScope
    ? cursorNavigation.cursors[cursorNavigation.index] ?? null
    : null;
  const eventQuery = validTenant ? buildUsageEventQuery(tenantId ?? '', filters, activeCursor) : null;
  const eventScope = baseEventScope !== null && eventQuery !== null ? JSON.stringify(eventQuery) : null;
  const summaryRequestToken = summaryScope === null ? null : JSON.stringify([summaryScope, refreshVersion]);
  const eventRequestToken = eventScope === null ? null : JSON.stringify([eventScope, refreshVersion]);
  // These are updated during render so a response that lands between the new
  // tenant render and the next effect cannot commit old tenant data.
  requestFence.summaryScope = summaryScope;
  requestFence.eventsScope = eventScope;
  requestFence.summaryToken = summaryRequestToken;
  requestFence.eventsToken = eventRequestToken;

  const currentSummary = summaryState !== null && summaryState.scope === summaryScope ? summaryState : null;
  const currentEvents = eventState !== null && eventState.scope === eventScope ? eventState : null;
  const hasDraftChanges = JSON.stringify(draft) !== JSON.stringify(filters);

  useEffect(() => {
    let active = true;
    setSession({ kind: 'loading' });
    void client.getSession().then((result) => {
      if (!active) return;
      setSession(result.ok ? { kind: 'ready', data: result.data } : { kind: 'failed', problem: result.problem });
    }).catch(() => {
      if (active) setSession({ kind: 'failed', problem: { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Admin session could not be reached.' } });
    });
    return () => { active = false; };
  }, [client, sessionRetry]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const restoreFromUrl = () => {
      const next = usageFiltersFromSearch(window.location.search);
      setDraft(next);
      setFilters(next);
      setFilterError(null);
      setCursorNavigation({ scope: '', cursors: [null], index: 0 });
    };
    window.addEventListener('popstate', restoreFromUrl);
    return () => window.removeEventListener('popstate', restoreFromUrl);
  }, []);

  useEffect(() => {
    const generation = ++requestFence.summaryGeneration;
    const requestToken = summaryRequestToken;
    if (summaryScope === null || appliedWindow.from === null || appliedWindow.to === null || tenantId === null) {
      setSummaryState(null);
      return undefined;
    }
    const cached = lastGood.summary?.scope === summaryScope ? lastGood.summary : null;
    setSummaryState(cached === null
      ? { kind: 'loading', scope: summaryScope }
      : { kind: 'ready', scope: summaryScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: false, refreshing: true });
    void client.getUsage({ tenantId, from: appliedWindow.from, to: appliedWindow.to }).then((result) => {
      if (generation !== requestFence.summaryGeneration || !usageRequestIsCurrent(summaryScope, requestToken, requestFence.summaryScope, requestFence.summaryToken)) return;
      if (!result.ok) {
        if (cached !== null) {
          setSummaryState({ kind: 'ready', scope: summaryScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: true, refreshing: false });
        } else {
          setSummaryState({ kind: 'failed', scope: summaryScope, problem: result.problem });
        }
        return;
      }
      const parsed = parseUsageSummary(result.data);
      if (parsed === null) {
        const problem = { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Usage summary could not be read safely.' };
        if (cached !== null) {
          setSummaryState({ kind: 'ready', scope: summaryScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: true, refreshing: false });
        } else {
          setSummaryState({ kind: 'failed', scope: summaryScope, problem });
        }
        return;
      }
      const stamp = Date.now();
      lastGood.summary = { scope: summaryScope, data: parsed, lastSuccessAt: stamp };
      setSummaryState({ kind: 'ready', scope: summaryScope, data: parsed, lastSuccessAt: stamp, stale: false, refreshing: false });
    }).catch(() => {
      if (generation !== requestFence.summaryGeneration || !usageRequestIsCurrent(summaryScope, requestToken, requestFence.summaryScope, requestFence.summaryToken)) return;
      if (cached !== null) {
        setSummaryState({ kind: 'ready', scope: summaryScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: true, refreshing: false });
      } else {
        setSummaryState({ kind: 'failed', scope: summaryScope, problem: { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Usage summary could not be reached.' } });
      }
    });
    return () => {
      if (requestFence.summaryGeneration === generation) requestFence.summaryGeneration += 1;
    };
  }, [client, summaryScope, summaryRequestToken, tenantId, appliedWindow.from, appliedWindow.to, refreshVersion]);

  useEffect(() => {
    const generation = ++requestFence.eventsGeneration;
    const requestToken = eventRequestToken;
    if (eventScope === null || eventQuery === null || tenantId === null) {
      setEventState(null);
      return undefined;
    }
    const cached = lastGood.events?.scope === eventScope ? lastGood.events : null;
    setEventState(cached === null
      ? { kind: 'loading', scope: eventScope }
      : { kind: 'ready', scope: eventScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: false, refreshing: true });
    void client.listUsageEvents(eventQuery).then((result) => {
      if (generation !== requestFence.eventsGeneration || !usageRequestIsCurrent(eventScope, requestToken, requestFence.eventsScope, requestFence.eventsToken)) return;
      if (!result.ok) {
        if (cached !== null) {
          setEventState({ kind: 'ready', scope: eventScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: true, refreshing: false });
        } else {
          setEventState({ kind: 'failed', scope: eventScope, problem: result.problem });
        }
        return;
      }
      const parsed = parseAdminUsageEventPage(result.data, tenantId);
      if (parsed === null) {
        const problem = { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Usage event page could not be read safely.' };
        if (cached !== null) {
          setEventState({ kind: 'ready', scope: eventScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: true, refreshing: false });
        } else {
          setEventState({ kind: 'failed', scope: eventScope, problem });
        }
        return;
      }
      const stamp = Date.now();
      lastGood.events = { scope: eventScope, data: parsed, lastSuccessAt: stamp };
      setEventState({ kind: 'ready', scope: eventScope, data: parsed, lastSuccessAt: stamp, stale: false, refreshing: false });
    }).catch(() => {
      if (generation !== requestFence.eventsGeneration || !usageRequestIsCurrent(eventScope, requestToken, requestFence.eventsScope, requestFence.eventsToken)) return;
      if (cached !== null) {
        setEventState({ kind: 'ready', scope: eventScope, data: cached.data, lastSuccessAt: cached.lastSuccessAt, stale: true, refreshing: false });
      } else {
        setEventState({ kind: 'failed', scope: eventScope, problem: { status: 0, code: 'UPSTREAM_UNAVAILABLE', title: 'Usage events could not be reached.' } });
      }
    });
    return () => {
      if (requestFence.eventsGeneration === generation) requestFence.eventsGeneration += 1;
    };
  }, [client, eventScope, eventRequestToken, tenantId, refreshVersion]);

  useEffect(() => {
    if (!autoRefresh || summaryScope === null || eventScope === null) return undefined;
    const timer = setInterval(() => setRefreshVersion((version) => version + 1), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, summaryScope, eventScope]);

  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  const applyFilters = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateUsageFilters(draft);
    if (result.error !== null) {
      setFilterError(result.error);
      return;
    }
    setFilterError(null);
    setFilters({ ...draft, provider: draft.provider.trim(), model: draft.model.trim(), operationId: draft.operationId.trim() });
    setCursorNavigation({ scope: '', cursors: [null], index: 0 });
    if (typeof window !== 'undefined') {
      const search = usageFiltersToSearch(draft, window.location.search);
      const nextUrl = `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`;
      window.history.pushState(window.history.state, '', nextUrl);
    }
  }, [draft]);

  const chooseWindow = useCallback((durationMs: number) => {
    const to = Math.floor(Date.now() / 60_000) * 60_000;
    const next: UsageFilters = {
      ...draft,
      from: new Date(to - durationMs).toISOString().slice(0, 16),
      to: new Date(to).toISOString().slice(0, 16),
    };
    setDraft(next);
    setFilterError(null);
  }, [draft]);

  const clearFilters = useCallback(() => {
    const defaults = defaultUsageFilters();
    setDraft(defaults);
    setFilters(defaults);
    setFilterError(null);
    setCursorNavigation({ scope: '', cursors: [null], index: 0 });
    if (typeof window !== 'undefined') {
      const search = usageFiltersToSearch(defaults, window.location.search);
      const nextUrl = `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`;
      window.history.pushState(window.history.state, '', nextUrl);
    }
  }, []);

  const goToNextPage = useCallback(() => {
    if (baseEventScope === null || currentEvents?.kind !== 'ready' || currentEvents.data.nextCursor === null) return;
    const nextCursor = currentEvents.data.nextCursor;
    setCursorNavigation((current) => {
      if (current.scope !== baseEventScope) return { scope: baseEventScope, cursors: [null, nextCursor], index: 1 };
      const cursors = current.cursors.slice(0, current.index + 1);
      cursors.push(nextCursor);
      return { scope: baseEventScope, cursors, index: current.index + 1 };
    });
  }, [baseEventScope, currentEvents]);

  const goToPreviousPage = useCallback(() => {
    if (baseEventScope === null) return;
    setCursorNavigation((current) => current.scope === baseEventScope && current.index > 0
      ? { ...current, index: current.index - 1 }
      : current);
  }, [baseEventScope]);

  const exportPage = useCallback(() => {
    if (tenantId === null || currentEvents?.kind !== 'ready') return;
    downloadCurrentPage(currentEvents.data, tenantId, filters, cursorNavigation.scope === baseEventScope ? cursorNavigation.index : 0);
  }, [tenantId, currentEvents, filters, cursorNavigation, baseEventScope]);

  const canLoad = session.kind === 'ready' && validTenant && appliedWindow.error === null;

  return (
    <section aria-labelledby="usage-title" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="usage-title" className="text-lg font-semibold">Usage &amp; Cost</h1>
        <Badge variant="neutral">tenant scoped</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scope and filters</CardTitle>
          <CardDescription>
            Summary totals cover the full tenant window. Provider, model and operation filters apply to the event ledger below. Window bounds are UTC; the ledger window uses the persisted received time.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {session.kind === 'loading' ? <p role="status" className="text-sm text-[var(--text-sub)]">Checking admin session…</p> : null}
          {session.kind === 'failed' ? (
            <ErrorState title={session.problem.title ?? 'Admin session unavailable.'} statusCode={session.problem.status} error={session.problem.code} onRetry={() => setSessionRetry((value) => value + 1)} />
          ) : null}
          {tenantId === null && session.kind === 'ready' ? <p role="status" className="text-sm text-[var(--text-sub)]">Select a tenant in the left navigator to read usage.</p> : null}
          {tenantId !== null && !validTenant ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">The selected tenant scope is invalid. Choose an available tenant.</p> : null}

          <form onSubmit={applyFilters} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <FormField id="usage-from" label="From (UTC)">
              <Input id="usage-from" type="datetime-local" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
            </FormField>
            <FormField id="usage-to" label="To (UTC, exclusive)">
              <Input id="usage-to" type="datetime-local" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
            </FormField>
            <FormField id="usage-provider" label="Provider (ledger)">
              <Input id="usage-provider" value={draft.provider} maxLength={128} autoComplete="off" onChange={(event) => setDraft({ ...draft, provider: event.target.value })} placeholder="Any provider" />
            </FormField>
            <FormField id="usage-model" label="Model (ledger)">
              <Input id="usage-model" value={draft.model} maxLength={128} autoComplete="off" onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Any model" />
            </FormField>
            <FormField id="usage-operation" label="Operation ID (ledger)">
              <Input id="usage-operation" value={draft.operationId} maxLength={36} autoComplete="off" onChange={(event) => setDraft({ ...draft, operationId: event.target.value })} placeholder="Any operation" />
            </FormField>
            <FormField id="usage-page-size" label="Rows per page">
              <NativeSelect id="usage-page-size" value={draft.limit} onChange={(event) => setDraft({ ...draft, limit: PAGE_SIZES.includes(event.target.value as (typeof PAGE_SIZES)[number]) ? event.target.value as UsageFilters['limit'] : '50' })}>
                {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} rows</option>)}
              </NativeSelect>
            </FormField>
            <div className="flex min-w-0 flex-col justify-end gap-2 sm:col-span-2 xl:col-span-2">
              <WindowPresets onChoose={chooseWindow} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!validTenant || session.kind !== 'ready'}>Apply filters</Button>
                <Button type="button" variant="outline" onClick={clearFilters}>Clear filters</Button>
                <Button type="button" variant="outline" onClick={refresh} disabled={!canLoad}>Refresh now</Button>
              </div>
            </div>
            {filterError ? <p role="alert" className="sm:col-span-2 xl:col-span-4 text-sm text-[var(--badge-danger-text)]">{filterError}</p> : null}
          </form>
          {hasDraftChanges ? <p role="status" className="text-xs text-[var(--text-sub)]">Unapplied filter edits are present. Results still show the last applied window and ledger filters.</p> : null}
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] pt-3">
            <Button
              size="sm"
              variant={autoRefresh ? 'secondary' : 'ghost'}
              aria-pressed={autoRefresh}
              data-portal-auto-refresh-toggle="true"
              onClick={() => setAutoRefresh((value) => !value)}
              disabled={!canLoad}
            >
              Auto refresh: {autoRefresh ? 'On' : 'Off'}
            </Button>
            <span className="text-xs text-[var(--text-sub)]">Refreshes the current tenant and applied filters every 10 seconds.</span>
          </div>
        </CardContent>
      </Card>

      {session.kind === 'ready' && tenantId === null ? <EmptyState title="Select a tenant" description="Usage data is scoped to one tenant. Choose an active tenant in the left navigator." /> : null}

      {canLoad && currentSummary?.kind === 'loading' ? <LoadingState title="Loading usage summary…" /> : null}
      {canLoad && currentSummary?.kind === 'failed' ? (
        currentSummary.problem.status === 403
          ? <DeniedState title="Access denied" description={currentSummary.problem.title ?? 'Not authorized for this tenant scope.'} />
          : <ErrorState title={currentSummary.problem.title ?? 'Usage summary failed to load.'} statusCode={currentSummary.problem.status} error={currentSummary.problem.code} onRetry={refresh} />
      ) : null}
      {canLoad && currentSummary?.kind === 'ready' ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle>Window totals</CardTitle>
                  <CardDescription>The server applies direct-root corrections and refunds before grouping current net cost; each original event’s units remain counted once. Unpriced or missing amounts are not treated as free usage.</CardDescription>
                </div>
                <DataAgeLabel lastSuccessAt={currentSummary.lastSuccessAt} stale={currentSummary.stale} />
              </div>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              {currentSummary.refreshing ? <p role="status" className="text-xs text-[var(--text-sub)]">Refreshing summary…</p> : null}
              {currentSummary.stale ? <p role="status" className="text-sm text-[var(--badge-warning-text)]">Showing the last successful summary for this same tenant and window; refresh failed.</p> : null}
              {currentSummary.data.totals.operations === 0 && currentSummary.data.rows.length === 0 ? <p role="status" className="text-sm text-[var(--text-sub)]">No usage was recorded in this tenant window.</p> : null}
              <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sub)] p-3">
                  <dt className="text-xs text-[var(--text-sub)]">Operations</dt>
                  <dd className="mt-1 text-lg font-semibold">{formatCount(currentSummary.data.totals.operations)}</dd>
                </div>
                <div className="min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sub)] p-3">
                  <dt className="text-xs text-[var(--text-sub)]">Tokens in / out</dt>
                  <dd className="mt-1 break-words font-mono text-sm font-semibold">{formatCount(currentSummary.data.totals.inputTokens)} / {formatCount(currentSummary.data.totals.outputTokens)}</dd>
                </div>
                <div className="min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sub)] p-3">
                  <dt className="text-xs text-[var(--text-sub)]">Pages</dt>
                  <dd className="mt-1 text-lg font-semibold">{formatCount(currentSummary.data.totals.pages)}</dd>
                </div>
                <div className="min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sub)] p-3">
                  <dt className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-sub)]">
                    Known accrued spend
                    <Badge variant={moneyState(currentSummary.data).incomplete ? 'warning' : 'info'}>{moneyState(currentSummary.data).label}</Badge>
                  </dt>
                  <dd className="mt-1 break-words text-lg font-semibold" data-cost-status={currentSummary.data.totals.costStatus ?? 'unknown'}>
                    {moneyState(currentSummary.data).knownCostUsd === null ? 'Unavailable' : `${moneyState(currentSummary.data).knownCostUsd!.toFixed(6)} USD`}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-[var(--text-sub)]">{moneyState(currentSummary.data).description} Cost status can be measured, estimated, pending, unpriced, or unavailable in older rows.</p>

              <div className="flex min-w-0 flex-col gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Provider and model breakdown</h2>
                  <p className="text-xs text-[var(--text-sub)]">Rows preserve the status reported by the summary service. Unit measurement and cost status are shown separately.</p>
                </div>
                {currentSummary.data.rows.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No provider/model breakdown is available for this window.</p> : (
                  <TableContainer maxHeight="65dvh" role="region" aria-label="Provider and model usage table" className="max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                      <Table aria-label="Usage by provider and model" density="compact" className="min-w-[680px]">
                        <TableHeader sticky>
                          <TableRow>
                            <TableHead>Provider / model</TableHead>
                            <TableHead>Operations</TableHead>
                            <TableHead>Tokens in / out</TableHead>
                            <TableHead>Pages</TableHead>
                            <TableHead>Unit measurement</TableHead>
                            <TableHead>Cost status / amount</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {currentSummary.data.rows.map((row) => (
                            <TableRow key={`${row.provider}/${row.model}`}>
                              <TableCell className="min-w-0">
                                <div className="flex min-w-0 flex-col gap-1">
                                  <span className="break-all font-medium">{row.provider}</span>
                                  <span className="break-all font-mono text-xs text-[var(--text-sub)]">{row.model}</span>
                                </div>
                              </TableCell>
                              <TableCell>{formatCount(row.operations)}</TableCell>
                              <TableCell className="font-mono text-xs">{formatCount(row.inputTokens)} / {formatCount(row.outputTokens)}</TableCell>
                              <TableCell>{formatCount(row.pages)}</TableCell>
                              <TableCell>{usageMeasurementLabel(row.measurement)}</TableCell>
                              <TableCell>
                                <div className="flex min-w-0 flex-col items-start gap-1">
                                  <Badge variant={usageStatusVariant(row.costStatus)}>{costStatusLabel(row.costStatus)}</Badge>
                                  <span className="break-words text-xs">{formatUsageCost(row.costMicrousd, row.costStatus)}</span>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                  </TableContainer>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      {canLoad && currentEvents?.kind === 'loading' ? <LoadingState title="Loading usage event ledger…" description="Reading one bounded page for the selected tenant and filters." /> : null}
      {canLoad && currentEvents?.kind === 'failed' ? (
        currentEvents.problem.status === 403
          ? <DeniedState title="Access denied" description={currentEvents.problem.title ?? 'Not authorized for this tenant scope.'} />
          : <ErrorState title={currentEvents.problem.title ?? 'Usage event ledger failed to load.'} statusCode={currentEvents.problem.status} error={currentEvents.problem.code} onRetry={refresh} />
      ) : null}
      {canLoad && currentEvents?.kind === 'ready' ? (
        <Card>
          <CardHeader>
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>Usage event ledger</CardTitle>
                <CardDescription>Received-time order, oldest first. Timestamps are UTC. The event’s computed initial charge stays immutable; current gross, refunds and net come from the server’s direct-root accounting projection. A missing amount or status is unavailable, and a reported zero is not an invoice. Operation links open the tenant-scoped operation record.</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <DataAgeLabel lastSuccessAt={currentEvents.lastSuccessAt} stale={currentEvents.stale} />
                <Button type="button" size="sm" variant="outline" onClick={exportPage} disabled={currentEvents.data.events.length === 0}>
                  Export this page CSV ({currentEvents.data.events.length})
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            {currentEvents.refreshing ? <p role="status" className="text-xs text-[var(--text-sub)]">Refreshing event page…</p> : null}
            {currentEvents.stale ? <p role="status" className="text-sm text-[var(--badge-warning-text)]">Showing the last successful event page for these same filters; refresh failed.</p> : null}
            {currentEvents.data.skippedInvalidEvents > 0 ? (
              <p role="status" className="rounded border border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)] p-3 text-sm text-[var(--badge-warning-text)]">
                {formatCount(currentEvents.data.skippedInvalidEvents)} stored row(s) could not be projected safely and are omitted from this page. The ledger response does not expose their raw payloads.
              </p>
            ) : null}
            {currentEvents.data.events.length === 0 ? (
              currentEvents.data.skippedInvalidEvents > 0
                ? <EmptyState title="No displayable events on this page" description="Some stored rows were skipped by the service because their usage record did not meet the safe projection contract." />
                : <EmptyState title="No usage events" description="No ledger rows match this tenant, window and applied ledger filters." />
            ) : (
              <TableContainer maxHeight="65dvh" role="region" aria-label="Usage event ledger table" className="max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                  <Table aria-label="Usage event ledger" density="compact" className="min-w-[760px]">
                    <TableHeader sticky>
                      <TableRow>
                        <TableHead>Event / received</TableHead>
                        <TableHead>Operation</TableHead>
                        <TableHead>Provider / model</TableHead>
                        <TableHead>Units</TableHead>
                        <TableHead>Original charge / current accounting</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {currentEvents.data.events.map((event) => (
                        <Fragment key={event.eventId}>
                          <TableRow>
                            <TableCell className="min-w-0">
                              <div className="flex min-w-0 flex-col gap-1">
                                <code className="max-w-44 break-all text-xs" title={event.eventId}>{event.eventId}</code>
                                <time className="text-xs text-[var(--text-sub)]" dateTime={event.receivedAt}>Received {formatUtcTimestamp(event.receivedAt)}</time>
                                <span className="text-[10px] text-[var(--text-muted)]">Occurred {formatUtcTimestamp(event.occurredAt)}</span>
                              </div>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <Link className="break-all text-[var(--cf-blue)] underline" to={`/operations?id=${encodeURIComponent(event.operationId)}`} aria-label={`Open operation ${event.operationId} in Operations`}>
                                {event.operationId}
                              </Link>
                              <div className="mt-1 break-all text-[10px] text-[var(--text-sub)]">Task {event.taskId}</div>
                              <div className="break-all text-[10px] text-[var(--text-sub)]">Invocation {event.invocationId}</div>
                            </TableCell>
                            <TableCell className="min-w-0">
                              <div className="flex min-w-0 flex-col gap-1">
                                <span className="break-all">{event.provider ?? 'Provider unavailable'}</span>
                                <span className="break-all font-mono text-xs text-[var(--text-sub)]">{event.model ?? 'Model unavailable'}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="whitespace-nowrap">In {formatCount(event.units.inputTokens)}</div>
                              <div className="whitespace-nowrap">Out {formatCount(event.units.outputTokens)}</div>
                              {event.units.pages !== undefined ? <div className="whitespace-nowrap">Pages {formatCount(event.units.pages)}</div> : null}
                              <div className="mt-1 text-xs text-[var(--text-sub)]">{event.measurement === 'estimated' ? 'Estimated units' : 'Measured units'}</div>
                            </TableCell>
                            <TableCell>
                              <div className="flex min-w-0 flex-col items-start gap-1">
                                <Badge variant={usageStatusVariant(event.costStatus)}>{costStatusLabel(event.costStatus)}</Badge>
                                <span className="break-words text-xs">Immutable initial charge: {formatUsageCost(event.costMicrousd, event.costStatus)}</span>
                                {event.financialAccounting ? (
                                  <div className="w-full max-w-sm rounded border bg-[var(--bg-card)] p-2 text-xs" aria-label="Server financial accounting projection">
                                    <p className="font-medium">Current server accounting · revision {event.financialAccounting.adjustmentRevision}</p>
                                    <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                                      <div><dt className="text-[var(--text-sub)]">Gross</dt><dd>{formatNullableMicrousd(event.financialAccounting.grossChargeMicrousd)}</dd></div>
                                      <div><dt className="text-[var(--text-sub)]">Refunded</dt><dd>{formatNullableMicrousd(event.financialAccounting.refundedMicrousd)}</dd></div>
                                      <div><dt className="text-[var(--text-sub)]">Current net</dt><dd className="font-semibold">{formatNullableMicrousd(event.financialAccounting.netChargeMicrousd)}</dd></div>
                                      <div><dt className="text-[var(--text-sub)]">Root event</dt><dd className="break-all">{event.financialAccounting.rootEventId}</dd></div>
                                    </dl>
                                    <p className="mt-1 text-[var(--text-sub)]">Authorized adjustments change accounting amounts only; original usage units are counted once.</p>
                                  </div>
                                ) : <p role="status" className="max-w-sm text-xs text-[var(--text-sub)]">Current financial accounting is unavailable for this response. No gross, refund or net amount is inferred.</p>}
                                {event.providerReportedCost ? (
                                  <div className="max-w-sm rounded border border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)] p-2 text-xs text-[var(--badge-warning-text)]">
                                    <p>Provider-reported amount (unverified): {formatMicrousd(event.providerReportedCost.costMicrousd)}</p>
                                    <p>{event.costMicrousd === null
                                      ? 'Difference unavailable because computed cost is unavailable.'
                                      : `Diagnostic difference: ${formatMicrousd(Math.abs(event.providerReportedCost.costMicrousd - event.costMicrousd))}.`}</p>
                                  </div>
                                ) : null}
                                <details className="mt-1 max-w-sm text-xs" data-provenance-state={event.costProvenance ? 'rich' : 'basic'}>
                                  <summary className="cursor-pointer font-medium text-[var(--cf-blue)]">
                                    {event.costProvenance ? 'Cost provenance' : 'BASIC legacy record'}
                                  </summary>
                                  {event.costProvenance ? (
                                    <dl className="mt-2 grid min-w-0 grid-cols-1 gap-2 text-[var(--text-sub)]">
                                      <div><dt className="font-medium text-[var(--text-main)]">Attempt and step</dt><dd className="break-all">{event.costProvenance.attempt} · {event.costProvenance.stepKey}</dd></div>
                                      <div><dt className="font-medium text-[var(--text-main)]">API key / profile</dt><dd className="break-all">{event.costProvenance.apiKeyId ?? 'No key attribution'} · {event.costProvenance.profileId ? `${event.costProvenance.profileId} r${event.costProvenance.profileRevision ?? '?'}` : 'No profile attribution'}</dd></div>
                                      <div><dt className="font-medium text-[var(--text-main)]">Business / action</dt><dd className="break-all">{event.costProvenance.businessId} · {event.costProvenance.businessVersion} · {event.costProvenance.action}</dd></div>
                                      <div><dt className="font-medium text-[var(--text-main)]">Connector</dt><dd className="break-all">{event.costProvenance.connectorId} r{event.costProvenance.connectorRevision} · {event.costProvenance.durationMs.toLocaleString()} ms</dd></div>
                                      <div><dt className="font-medium text-[var(--text-main)]">Reservation</dt><dd className="break-all">{event.costProvenance.reservationGroupId} · selected {formatUtcTimestamp(event.costProvenance.selectedAt)}</dd></div>
                                      <div><dt className="font-medium text-[var(--text-main)]">Trust and bounds</dt><dd>{event.costProvenance.confidence === 'upper-bound' ? `Verified upper bound · ${event.costProvenance.costBoundCapabilityId} · input ${event.costProvenance.inputUpperBoundTokens?.toLocaleString()} · output ${event.costProvenance.outputLimitTokens?.toLocaleString()}` : 'Best effort. No hard-cap availability is claimed.'}</dd></div>
                                      <div><dt className="font-medium text-[var(--text-main)]">Frozen prices</dt><dd>{event.costProvenance.priceSnapshot ? `${event.costProvenance.priceSnapshot.provider}/${event.costProvenance.priceSnapshot.modelId} · price r${event.costProvenance.priceRevision} · input ${event.costProvenance.priceSnapshot.inputMicrousdPerMillion.toLocaleString()} · output ${event.costProvenance.priceSnapshot.outputMicrousdPerMillion.toLocaleString()} micro-USD per million` : 'Price unavailable or pending; no price snapshot was pinned.'}</dd></div>
                                      <div><dt className="font-medium text-[var(--text-main)]">Budget pins</dt><dd className="break-all">{event.costProvenance.budgetPins.length ? event.costProvenance.budgetPins.map((pin) => `${pin.budgetId} r${pin.revision}`).join(', ') : 'No matching budget revision was selected.'}</dd></div>
                                    </dl>
                                  ) : <p className="mt-2 text-[var(--text-sub)]">This older event does not have persisted grant, attempt, connector, or price lineage. Missing values remain unavailable.</p>}
                                </details>
                                <Button type='button' size='sm' variant='outline' className='mt-1' onClick={() => setAdjustmentScope(adjustmentScope === `${tenantId}:${event.eventId}` ? null : `${tenantId}:${event.eventId}`)}>{adjustmentScope === `${tenantId}:${event.eventId}` ? 'Close adjustment details' : 'Cost adjustment history'}</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {adjustmentScope === `${tenantId}:${event.eventId}` && session.kind === 'ready' && <TableRow><TableCell colSpan={5}><CostAdjustmentPanel event={event} tenantId={tenantId!} session={session.data} onChanged={refresh} /></TableCell></TableRow>}
                        </Fragment>
                      ))}
                    </TableBody>
                  </Table>
              </TableContainer>
            )}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3">
              <span className="text-xs text-[var(--text-sub)]">Page {cursorNavigation.scope === baseEventScope ? cursorNavigation.index + 1 : 1} · up to {currentEvents.data.limit} rows · export contains this page only.</span>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={goToPreviousPage} disabled={cursorNavigation.scope !== baseEventScope || cursorNavigation.index === 0}>Previous page</Button>
                <Button type="button" size="sm" variant="outline" onClick={goToNextPage} disabled={!currentEvents.data.hasMore || currentEvents.data.nextCursor === null}>Next page</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {session.kind === 'ready' && tenantId !== null && validTenant && !session.data.localUser && session.data.role !== 'viewer' ? (
        <>
          <CostPolicyPanel tenantId={tenantId} session={session.data} />
          <CostAlertsPanel tenantId={tenantId} session={session.data} />
        </>
      ) : null}
    </section>
  );
}
