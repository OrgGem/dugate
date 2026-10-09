import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Activity,
  Cpu,
  FileText,
  Coins,
  Search,
  User,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DeniedState,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/ui/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AppShellStatusBadge } from '@/components/ui/app-shell-primitives';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type AdminHealthSnapshot,
  type AdminWebSession,
  type BusinessRow,
  type OperationWire,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import { OperationsMonitorDashboard } from './operations-monitor-dashboard';
import {
  paneStateFrom,
  parseAuditPage,
  severityVariant,
  type AuditListPage,
  type Loadable,
} from './state';

type TimeRangeKey = '24h' | '7d' | '30d';

const TIME_RANGES: Record<TimeRangeKey, { label: string; ms: number }> = {
  '24h': { label: '24h', ms: 24 * 3600 * 1000 },
  '7d': { label: '7d', ms: 7 * 24 * 3600 * 1000 },
  '30d': { label: '30d', ms: 30 * 24 * 3600 * 1000 },
};

interface UsageRollupTotals {
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
}

interface UsageRollupRow {
  provider: string;
  model: string;
  operations: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  measurement: string;
}

interface UsageRollup {
  rows: UsageRollupRow[];
  totals: UsageRollupTotals;
}

/** The tile's state: `scope-required` is a platform/unscoped session, not a failure. */
type UsageTileState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: UsageRollup }
  | { kind: 'failed'; problem: AdminApiProblem }
  | { kind: 'scope-required' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-negative safe integer, or null — a count is never coerced from anything else. */
function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Runtime validation of the usage summary (unknown → typed or null). Strict on
 * purpose: one unreadable row or total makes the WHOLE payload unreadable, so
 * the tile shows an error pane instead of a partially fabricated rollup.
 */
export function parseUsageRollup(value: unknown): UsageRollup | null {
  if (!isRecord(value)) return null;
  const totalsRaw = value['totals'];
  if (!isRecord(totalsRaw)) return null;
  const operations = readCount(totalsRaw['operations']);
  const inputTokens = readCount(totalsRaw['inputTokens']);
  const outputTokens = readCount(totalsRaw['outputTokens']);
  const pages = readCount(totalsRaw['pages']);
  const costMicrousd = readCount(totalsRaw['costMicrousd']);
  if (
    operations === null ||
    inputTokens === null ||
    outputTokens === null ||
    pages === null ||
    costMicrousd === null
  ) {
    return null;
  }

  const rowsRaw = value['rows'];
  if (!Array.isArray(rowsRaw)) return null;
  const rows: UsageRollupRow[] = [];
  for (const raw of rowsRaw) {
    if (!isRecord(raw)) return null;
    const provider = readText(raw['provider']);
    const model = readText(raw['model']);
    const rowOperations = readCount(raw['operations']);
    const rowInput = readCount(raw['inputTokens']);
    const rowOutput = readCount(raw['outputTokens']);
    const rowCost = readCount(raw['costMicrousd']);
    if (
      provider === null ||
      model === null ||
      rowOperations === null ||
      rowInput === null ||
      rowOutput === null ||
      rowCost === null
    ) {
      return null;
    }
    rows.push({
      provider,
      model,
      operations: rowOperations,
      inputTokens: rowInput,
      outputTokens: rowOutput,
      costMicrousd: rowCost,
      measurement: readText(raw['measurement']) ?? 'unknown',
    });
  }

  return {
    rows,
    totals: { operations, inputTokens, outputTokens, pages, costMicrousd },
  };
}

/** Micro-USD integer → USD string; the integer is the source of truth, never a float sum. */
function formatMicroUsd(value: number): string {
  return `${(value / 1_000_000).toFixed(6)} USD`;
}

function formatWindow(window: { from: string; to: string }): string {
  return `${window.from} → ${window.to}`;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (Number.isNaN(diffMs)) return dateString;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${Math.max(0, diffSec)}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getProviderColor(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('openai')) return 'bg-emerald-500';
  if (p.includes('anthropic') || p.includes('claude')) return 'bg-indigo-500';
  if (p.includes('google') || p.includes('gemini')) return 'bg-amber-500';
  if (p.includes('deepseek')) return 'bg-cyan-500';
  if (p.includes('local') || p.includes('ollama')) return 'bg-purple-500';
  return 'bg-blue-500';
}

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

export function OverviewScreen() {
  const { tenantId: globalTenantId, tenant } = useTenant();
  const [session, setSession] = useState<Loadable<AdminWebSession>>({ kind: 'loading' });
  const [audit, setAudit] = useState<Loadable<AuditListPage>>({ kind: 'loading' });
  const [usage, setUsage] = useState<UsageTileState>({ kind: 'loading' });
  const [operations, setOperations] = useState<OperationWire[]>([]);
  const [businesses, setBusinesses] = useState<BusinessRow[]>([]);
  const [health, setHealth] = useState<AdminHealthSnapshot | null>(null);
  const [hasOperationsApi, setHasOperationsApi] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [lastSuccess] = useState<{ current: number | null }>({ current: null });
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('24h');

  const window = useMemo(() => {
    const now = Date.now();
    return {
      from: new Date(now - TIME_RANGES[timeRange].ms).toISOString(),
      to: new Date(now).toISOString(),
    };
  }, [timeRange]);

  const load = useCallback(async (): Promise<void> => {
    const client = createAdminApiClient();
    const hasLastGood = lastSuccess.current !== null;
    if (!hasLastGood) setUsage({ kind: 'loading' });
    let cycleFailed = false;

    const sessionResult = await client.getSession();
    if (!sessionResult.ok) {
      cycleFailed = true;
      if (!hasLastGood) {
        setSession({ kind: 'failed', problem: sessionResult.problem });
        setAudit({ kind: 'loading' });
        setUsage({ kind: 'failed', problem: sessionResult.problem });
      }
    } else {
      setSession({ kind: 'ready', data: sessionResult.data });

      const scope = sessionResult.data.scope;
      const effectiveTenantId = scope?.kind === 'tenant' ? scope.tenantId : (globalTenantId ?? null);

      if (effectiveTenantId === null) {
        setUsage({ kind: 'scope-required' });
      } else {
        const usageResult = await client.getUsage({
          tenantId: effectiveTenantId,
          from: window.from,
          to: window.to,
        });
        if (!usageResult.ok) {
          cycleFailed = true;
          if (!hasLastGood) setUsage({ kind: 'failed', problem: usageResult.problem });
        } else {
          const rollup = parseUsageRollup(usageResult.data);
          if (rollup === null) {
            cycleFailed = true;
            if (!hasLastGood) {
              setUsage({
                kind: 'failed',
                problem: {
                  status: 502,
                  code: 'UNREADABLE_RESPONSE',
                  title: 'The admin API returned an unreadable usage summary.',
                },
              });
            }
          } else {
            setUsage({ kind: 'ready', data: rollup });
          }
        }
      }

      const auditQuery: Record<string, string> = { limit: '50' };
      if (effectiveTenantId) {
        auditQuery.tenantId = effectiveTenantId;
      }
      const auditResult = await client.listAudit(auditQuery);
      if (!auditResult.ok) {
        cycleFailed = true;
        if (!hasLastGood) setAudit({ kind: 'failed', problem: auditResult.problem });
      } else {
        const page = parseAuditPage(auditResult.data);
        if (page === null) {
          cycleFailed = true;
          if (!hasLastGood) {
            setAudit({
              kind: 'failed',
              problem: {
                status: 502,
                code: 'UNREADABLE_RESPONSE',
                title: 'The admin API returned an unreadable audit page.',
              },
            });
          }
        } else {
          setAudit({ kind: 'ready', data: page });
        }
      }

      if (typeof client.listOperations === 'function') {
        setHasOperationsApi(true);
        try {
          const opsResult = await client.listOperations({ limit: '100', sort: 'created_at:desc' });
          if (opsResult.ok) {
            setOperations(opsResult.data.items);
          }
        } catch {
          // ignore offline/unmounted client error
        }
      }
      if (typeof client.listBusinesses === 'function') {
        try {
          const bizResult = await client.listBusinesses();
          if (bizResult.ok) {
            setBusinesses(bizResult.data.items);
          }
        } catch {
          // ignore offline/unmounted client error
        }
      }
      if (typeof client.getHealth === 'function') {
        try {
          const healthResult = await client.getHealth();
          if (healthResult.ok) {
            setHealth(healthResult.data);
          }
        } catch {
          // ignore offline/unmounted client error
        }
      }
    }

    if (cycleFailed) {
      if (lastSuccess.current !== null) setStale(true);
      return;
    }
    const stamp = Date.now();
    lastSuccess.current = stamp;
    setLastSuccessAt(stamp);
    setStale(false);
  }, [window, lastSuccess, globalTenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      void load();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const effectiveTenantId =
    session.kind === 'ready' && session.data.scope?.kind === 'tenant'
      ? session.data.scope.tenantId
      : (globalTenantId ?? null);

  return (
    <section aria-labelledby="overview-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="overview-title" className="text-lg font-semibold">
          Overview
        </h1>
        <Badge variant="neutral">read-only</Badge>
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
        <span className="text-xs text-[var(--text-sub)]">
          Tenant data served by the Orchestrator BFF; scoped to active global tenant.
        </span>
        <nav aria-label="Orchestrator Portal sections" className="ml-auto flex items-center gap-3 text-sm">
          <Link className="text-[var(--cf-blue)] underline" to="/operations">
            Operations
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/businesses">
            Businesses
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/usage">
            Usage
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/profiles">
            Profiles
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/api-keys">
            API keys
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/connectors">
            Connectors
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/security">
            Security
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/identity">
            Identity
          </Link>
          <Link className="text-[var(--cf-blue)] underline" to="/settings">
            Settings
          </Link>
        </nav>
      </div>

      <SessionCard
        loadable={session}
        activeTenantId={effectiveTenantId}
        activeTenantName={tenant?.name}
      />

      {hasOperationsApi ? (
        <>
          <OperationsMonitorDashboard
            operations={operations}
            businesses={businesses}
            health={health}
            onRefresh={() => void load()}
          />
          <div className="grid gap-4 lg:grid-cols-2 min-w-0">
            <UsageRollupTile
              state={usage}
              window={window}
              timeRange={timeRange}
              onTimeRangeChange={setTimeRange}
              onRetry={() => void load()}
              effectiveTenantId={effectiveTenantId}
              tenantName={tenant?.name}
            />
            <AuditCard
              loadable={audit}
              onRetry={() => void load()}
              effectiveTenantId={effectiveTenantId}
              tenantName={tenant?.name}
            />
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2 min-w-0">
            <UsageRollupTile
              state={usage}
              window={window}
              timeRange={timeRange}
              onTimeRangeChange={setTimeRange}
              onRetry={() => void load()}
              effectiveTenantId={effectiveTenantId}
              tenantName={tenant?.name}
            />
            <AuditCard
              loadable={audit}
              onRetry={() => void load()}
              effectiveTenantId={effectiveTenantId}
              tenantName={tenant?.name}
            />
          </div>
          <UnavailableTile
            title="Operations"
            description="The operations list/actions are not exposed through this read-only BFF slice yet; nothing is synthesised here."
          />
        </>
      )}
    </section>
  );
}

function SessionCard({
  loadable,
  activeTenantId,
  activeTenantName,
}: {
  loadable: Loadable<AdminWebSession>;
  activeTenantId?: string | null;
  activeTenantName?: string | null;
}) {
  const state = paneStateFrom(loadable);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Session</CardTitle>
        <CardDescription>Live from /admin/api/session (no-store).</CardDescription>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' ? (
          <LoadingState title="Loading session…" description="Resolving the server-side session." />
        ) : null}
        {state.kind === 'error' || state.kind === 'denied' ? (
          <ProblemPane problem={state.problem} />
        ) : null}
        {state.kind === 'ready' ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm min-w-0">
            <dt className="text-[var(--text-sub)]">Principal</dt>
            <dd className="min-w-0 break-words">
              <code>{state.data.displayName}</code> ({state.data.principal.kind})
            </dd>
            <dt className="text-[var(--text-sub)]">Role</dt>
            <dd>
              <AppShellStatusBadge
                label={state.data.role}
                variant={
                  state.data.role === 'admin'
                    ? 'success'
                    : state.data.role === 'operator'
                      ? 'info'
                      : 'neutral'
                }
              />
              <span className="ml-2 text-[var(--text-sub)]">plane: {state.data.plane}</span>
            </dd>
            <dt className="text-[var(--text-sub)]">Tenant scope</dt>
            <dd className="min-w-0 break-words">
              {state.data.scope === null ? (
                <span className="text-[var(--text-sub)]">none — this session has no admin principal</span>
              ) : state.data.scope.kind === 'platform' ? (
                <span>
                  platform{' '}
                  {activeTenantId ? (
                    <span className="text-[var(--text-sub)]">
                      (active: <code>{activeTenantName || activeTenantId}</code>)
                    </span>
                  ) : (
                    '(may narrow per request)'
                  )}
                </span>
              ) : (
                <code>{state.data.scope.tenantId}</code>
              )}
            </dd>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AuditCard({
  loadable,
  onRetry,
  effectiveTenantId,
  tenantName,
}: {
  loadable: Loadable<AuditListPage>;
  onRetry: () => void;
  effectiveTenantId?: string | null;
  tenantName?: string | null;
}) {
  const state = paneStateFrom(loadable, (page) => page.items.length === 0);
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const items = state.kind === 'ready' ? state.data.items : [];

  const errorCount = useMemo(
    () => items.filter((i) => ['error', 'critical'].includes(i.severity.toLowerCase())).length,
    [items],
  );
  const warnCount = useMemo(
    () => items.filter((i) => i.severity.toLowerCase() === 'warning').length,
    [items],
  );
  const infoCount = useMemo(
    () => items.filter((i) => i.severity.toLowerCase() === 'info').length,
    [items],
  );

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filterSeverity !== 'all') {
        const sev = item.severity.toLowerCase();
        if (filterSeverity === 'error' && sev !== 'error' && sev !== 'critical') return false;
        if (filterSeverity === 'warning' && sev !== 'warning') return false;
        if (filterSeverity === 'info' && sev !== 'info') return false;
      }
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        const matches =
          item.kind.toLowerCase().includes(q) ||
          item.actor.toLowerCase().includes(q) ||
          item.message.toLowerCase().includes(q) ||
          item.resourceId.toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [items, filterSeverity, searchQuery]);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle>Audit ledger</CardTitle>
            {state.kind === 'ready' ? (
              <Badge variant="neutral" className="text-xs">
                {items.length} event(s)
              </Badge>
            ) : null}
            {effectiveTenantId ? (
              <Badge variant="neutral" className="text-xs">
                Scope: {tenantName ? `${tenantName}` : effectiveTenantId}
              </Badge>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onRetry}>
            Refresh
          </Button>
        </div>
        <CardDescription>
          Newest administrative and security events for this session's tenant scope (tenant fenced).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 flex-1">
        {state.kind === 'loading' ? (
          <LoadingState title="Loading audit events…" description="Reading the tenant-scoped ledger." />
        ) : null}
        {state.kind === 'denied' ? (
          <DeniedState
            title="Access denied"
            description={
              state.problem.title ?? 'This session is not authorized for the requested tenant scope.'
            }
          />
        ) : null}
        {state.kind === 'error' ? <ProblemPane problem={state.problem} onRetry={onRetry} /> : null}
        {state.kind === 'empty' ? (
          <EmptyState
            title="No audit events"
            description="No events match this session's tenant scope yet. New administrative activity will appear here."
            actionText="Refresh"
            onAction={onRetry}
          />
        ) : null}
        {state.kind === 'ready' && state.data.items.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 pb-1">
              <div className="flex items-center gap-1 text-xs">
                <Button
                  size="sm"
                  variant={filterSeverity === 'all' ? 'secondary' : 'ghost'}
                  className="h-6.5 text-xs px-2"
                  onClick={() => setFilterSeverity('all')}
                >
                  All ({items.length})
                </Button>
                <Button
                  size="sm"
                  variant={filterSeverity === 'error' ? 'secondary' : 'ghost'}
                  className={`h-6.5 text-xs px-2 ${errorCount > 0 ? 'text-red-500 font-semibold' : ''}`}
                  onClick={() => setFilterSeverity('error')}
                >
                  Errors ({errorCount})
                </Button>
                <Button
                  size="sm"
                  variant={filterSeverity === 'warning' ? 'secondary' : 'ghost'}
                  className={`h-6.5 text-xs px-2 ${warnCount > 0 ? 'text-amber-500 font-semibold' : ''}`}
                  onClick={() => setFilterSeverity('warning')}
                >
                  Warnings ({warnCount})
                </Button>
                <Button
                  size="sm"
                  variant={filterSeverity === 'info' ? 'secondary' : 'ghost'}
                  className="h-6.5 text-xs px-2"
                  onClick={() => setFilterSeverity('info')}
                >
                  Info ({infoCount})
                </Button>
              </div>
              <div className="relative min-w-[180px] max-w-xs flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-sub)]" />
                <input
                  type="text"
                  placeholder="Filter actor, kind, message..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-7 w-full rounded-md border border-[var(--border-sub)] bg-[var(--surface-sub)] pl-8 pr-2 text-xs text-[var(--text-main)] shadow-xs focus:outline-none focus:ring-1 focus:ring-[var(--cf-blue)]"
                />
              </div>
            </div>

            <TableContainer className="max-h-[340px] overflow-y-auto">
              <Table aria-label="Audit events">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Message & Resource</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell
                        className="whitespace-nowrap text-xs text-[var(--text-sub)]"
                        title={formatWhen(event.occurredAt)}
                      >
                        {formatRelativeTime(event.occurredAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={severityVariant(event.severity)} dot>
                          {event.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs font-medium text-[var(--text-main)]">
                        {event.kind}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex items-center gap-1 text-[var(--text-sub)]">
                          <User className="h-3 w-3" />
                          <span>{event.actor || 'system'}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[var(--text-main)]">{event.message}</span>
                          {event.resourceId ? (
                            <span className="text-[10px] text-[var(--text-sub)] font-mono">
                              id: {event.resourceId}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-6 text-xs text-[var(--text-sub)]">
                        No audit events match the selected filters.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </TableContainer>

            <p className="text-[11px] text-[var(--text-sub)] mt-auto pt-1">
              Showing {filteredItems.length} of {state.data.total} event(s) in scope · page limit{' '}
              {state.data.limit}
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Error pane with the sign-in affordance rebound for a 401. */
function ProblemPane({ problem, onRetry }: { problem: AdminApiProblem; onRetry?: () => void }) {
  if (problem.status === 403) {
    return (
      <DeniedState
        title="Access denied"
        description={problem.title ?? 'This session is not authorized for the Overview read path.'}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ErrorState
        title={problem.title ?? 'The admin API rejected the request.'}
        statusCode={problem.status > 0 ? problem.status : undefined}
        error={problem.code ?? 'transport error'}
        onRetry={onRetry}
      />
      {problem.status === 401 ? <SignInLink /> : null}
    </div>
  );
}

function SignInLink() {
  return (
    <p className="text-sm">
      <a className="underline text-[var(--cf-blue)]" href="/admin/login">
        Sign in again
      </a>
    </p>
  );
}

function UsageRollupTile({
  state,
  window,
  timeRange,
  onTimeRangeChange,
  onRetry,
  effectiveTenantId,
  tenantName,
}: {
  state: UsageTileState;
  window: { from: string; to: string };
  timeRange: TimeRangeKey;
  onTimeRangeChange: (range: TimeRangeKey) => void;
  onRetry: () => void;
  effectiveTenantId?: string | null;
  tenantName?: string | null;
}) {
  const isEmpty =
    state.kind === 'ready' &&
    state.data.rows.length === 0 &&
    state.data.totals.operations === 0 &&
    state.data.totals.inputTokens === 0 &&
    state.data.totals.outputTokens === 0;

  const providers = useMemo(() => {
    if (state.kind !== 'ready') return [];
    const map = new Map<string, number>();
    for (const r of state.data.rows) {
      map.set(r.provider, (map.get(r.provider) ?? 0) + r.operations);
    }
    const total = state.data.totals.operations || 1;
    return Array.from(map.entries()).map(([provider, ops]) => ({
      provider,
      ops,
      pct: Math.round((ops / total) * 100),
    }));
  }, [state]);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle>Usage rollup</CardTitle>
            {state.kind === 'ready' ? (
              <Badge variant="success" dot>
                live
              </Badge>
            ) : state.kind === 'failed' ? (
              <Badge variant="warning" dot>
                unavailable
              </Badge>
            ) : (
              <Badge variant="neutral" dot>
                tenant scoped
              </Badge>
            )}
            {effectiveTenantId ? (
              <Badge variant="neutral" className="text-xs">
                Tenant: {tenantName ? `${tenantName}` : effectiveTenantId}
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-1 rounded-md border border-[var(--border-sub)] p-0.5">
            {(['24h', '7d', '30d'] as const).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={timeRange === r ? 'secondary' : 'ghost'}
                className={`h-6 px-2 text-xs ${timeRange === r ? 'font-semibold' : 'text-[var(--text-sub)]'}`}
                onClick={() => onTimeRangeChange(r)}
              >
                {TIME_RANGES[r].label}
              </Button>
            ))}
          </div>
        </div>
        <CardDescription>
          Per-tenant usage read from GET /admin/api/usage — platform projection for the selected window.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5 flex-1">
        {state.kind === 'loading' ? (
          <LoadingState title="Loading usage…" description="Reading the tenant-scoped usage summary." />
        ) : null}
        {state.kind === 'scope-required' ? (
          <p className="text-sm text-[var(--text-sub)]">
            Usage is tenant scoped. Please select a tenant from the top-left navigator or visit the{' '}
            <Link className="text-[var(--cf-blue)] underline" to="/usage">
              Usage
            </Link>{' '}
            screen.
          </p>
        ) : null}
        {state.kind === 'failed' ? <ProblemPane problem={state.problem} onRetry={onRetry} /> : null}
        {isEmpty ? (
          <EmptyState
            title="No usage in this window"
            description={`No ledger events were recorded for this tenant in the last ${TIME_RANGES[timeRange].label}.`}
            actionText="Refresh"
            onAction={onRetry}
          />
        ) : null}
        {state.kind === 'ready' && !isEmpty ? (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <div className="flex flex-col p-2.5 rounded-lg border border-[var(--border-sub)] bg-[var(--surface-sub)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--text-sub)] mb-0.5">
                  <span className="text-[11px] font-medium">Operations</span>
                  <Activity className="h-3.5 w-3.5 text-blue-500" />
                </div>
                <div className="text-lg font-bold text-[var(--text-main)]">
                  {state.data.totals.operations.toLocaleString()}
                </div>
                <span className="text-[10px] text-[var(--text-muted)] mt-0.5">Calls in window</span>
              </div>

              <div className="flex flex-col p-2.5 rounded-lg border border-[var(--border-sub)] bg-[var(--surface-sub)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--text-sub)] mb-0.5">
                  <span className="text-[11px] font-medium">Tokens</span>
                  <Cpu className="h-3.5 w-3.5 text-purple-500" />
                </div>
                <div className="text-lg font-bold text-[var(--text-main)]">
                  {((state.data.totals.inputTokens + state.data.totals.outputTokens) / 1000).toFixed(1)}k
                </div>
                <span className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  In: {(state.data.totals.inputTokens / 1000).toFixed(1)}k · Out:{' '}
                  {(state.data.totals.outputTokens / 1000).toFixed(1)}k
                </span>
              </div>

              <div className="flex flex-col p-2.5 rounded-lg border border-[var(--border-sub)] bg-[var(--surface-sub)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--text-sub)] mb-0.5">
                  <span className="text-[11px] font-medium">Pages</span>
                  <FileText className="h-3.5 w-3.5 text-amber-500" />
                </div>
                <div className="text-lg font-bold text-[var(--text-main)]">
                  {state.data.totals.pages.toLocaleString()}
                </div>
                <span className="text-[10px] text-[var(--text-muted)] mt-0.5">Parsed pages</span>
              </div>

              <div className="flex flex-col p-2.5 rounded-lg border border-[var(--border-sub)] bg-[var(--surface-sub)] shadow-xs">
                <div className="flex items-center justify-between text-[var(--text-sub)] mb-0.5">
                  <span className="text-[11px] font-medium">Est. Spend</span>
                  <Coins className="h-3.5 w-3.5 text-emerald-500" />
                </div>
                <div className="text-lg font-bold text-[var(--text-main)]">
                  ${(state.data.totals.costMicrousd / 1_000_000).toFixed(4)}
                </div>
                <span className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  {state.data.totals.costMicrousd.toLocaleString()} µUSD
                </span>
              </div>
            </div>

            {providers.length > 0 ? (
              <div className="flex flex-col gap-1.5 p-2.5 rounded-lg border border-[var(--border-sub)] bg-[var(--surface-sub)]">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[var(--text-main)]">Provider Distribution</span>
                  <span className="text-[var(--text-sub)] text-[11px]">
                    {providers.length} provider(s) active
                  </span>
                </div>
                <div className="h-2 w-full flex rounded-full overflow-hidden bg-[var(--surface-border)] gap-0.5">
                  {providers.map((p) => (
                    <div
                      key={p.provider}
                      className={`${getProviderColor(p.provider)} transition-all duration-300`}
                      style={{ width: `${Math.max(p.pct, 4)}%` }}
                      title={`${p.provider}: ${p.ops} ops (${p.pct}%)`}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-0.5 text-[11px] text-[var(--text-sub)]">
                  {providers.map((p) => (
                    <div key={p.provider} className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${getProviderColor(p.provider)}`} />
                      <span className="font-medium text-[var(--text-main)]">{p.provider}</span>
                      <span>({p.ops} ops · {p.pct}%)</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <TableContainer className="max-h-[260px] overflow-y-auto">
              <Table aria-label="Usage by provider and model">
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Ops</TableHead>
                    <TableHead>Tokens In / Out</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.data.rows.map((row) => {
                    const sharePct =
                      state.data.totals.operations > 0
                        ? ((row.operations / state.data.totals.operations) * 100).toFixed(1)
                        : '0.0';
                    return (
                      <TableRow key={`${row.provider}/${row.model}`}>
                        <TableCell>
                          <Badge variant="neutral" className="text-xs font-semibold">
                            {row.provider}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs font-medium">{row.model}</TableCell>
                        <TableCell className="text-xs font-semibold">{row.operations.toLocaleString()}</TableCell>
                        <TableCell className="text-xs text-[var(--text-sub)] font-mono">
                          {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs font-mono font-medium text-emerald-600 dark:text-emerald-400">
                          {formatMicroUsd(row.costMicrousd)}
                        </TableCell>
                        <TableCell className="text-xs text-[var(--text-sub)]">{sharePct}%</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>

            <p className="text-[11px] text-[var(--text-sub)] mt-auto pt-1">
              Window: {formatWindow(window)} · Platform projection verbatim
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UnavailableTile({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge variant="warning" dot>
            requires backend
          </Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-[var(--text-sub)]">
          Nothing is shown here until the backing read endpoint exists — no placeholder data.
        </p>
      </CardContent>
    </Card>
  );
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
