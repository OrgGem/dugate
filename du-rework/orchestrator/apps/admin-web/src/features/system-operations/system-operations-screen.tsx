import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Activity,
  AlertTriangle,
  Boxes,
  RefreshCw,
  Server,
  ShieldAlert,
  Timer,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner } from '@/components/ui/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ADMIN_AUTH_EXPIRED_EVENT, createAdminApiClient, type AdminHealthSnapshot, type AdminWebSession, type OperationWire, type WorkerInstanceList } from '@/lib/api';
import { parseOperationsPage } from '@/features/operations/state';
import { useTenant } from '@/lib/tenant-context';
import { parseOperationsMetrics, type OperationsMetricsSnapshot } from '@/features/overview/state';
import { parseWorkerInstanceList } from '@/features/overview/worker-instance-state';
import { canReadIncidentLedger, canReadPlatformSignals, deriveOperationSignals, effectiveTenantId, parseAdminHealthSnapshot, sampleAgeState } from './state';
import { ComposeOperationsPanel } from './compose-operations-panel';
import type { IncidentListPage, IncidentListQuery, QueueInventory, ServiceInventory } from '@du/contracts';

const AUTO_REFRESH_MS = 30_000;
const SOURCE_STALE_AFTER_MS = 60_000;
const OPERATIONS_PAGE_LIMIT = 100;

type Projection<T> =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; data: T; sampledAt: string; stale: boolean; refreshing: boolean; problem: string | null };

type SessionProjection =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; data: AdminWebSession };

interface DashboardState {
  selectionKey: string;
  session: SessionProjection;
  effectiveTenantId: string | null;
  metrics: Projection<OperationsMetricsSnapshot>;
  operations: Projection<OperationWire[]>;
  health: Projection<AdminHealthSnapshot>;
  workers: Projection<WorkerInstanceList>;
  services: Projection<ServiceInventory>;
  queues: Projection<QueueInventory>;
  incidents: Projection<IncidentListPage>;
}

function initialState(selectionKey: string): DashboardState {
  return {
    selectionKey,
    session: { kind: 'loading' },
    effectiveTenantId: null,
    metrics: { kind: 'loading' },
    operations: { kind: 'loading' },
    health: { kind: 'loading' },
    workers: { kind: 'loading' },
    services: { kind: 'loading' },
    queues: { kind: 'loading' },
    incidents: { kind: 'loading' },
  };
}

function beginRefresh<T>(source: Projection<T>): Projection<T> {
  return source.kind === 'ready' ? { ...source, refreshing: true } : { kind: 'loading' };
}

function failedRefresh<T>(source: Projection<T>, reason: string): Projection<T> {
  return source.kind === 'ready'
    ? { ...source, stale: true, refreshing: false, problem: reason }
    : { kind: 'error', reason };
}

function problemText(problem: { status: number; code?: string; title?: string }): string {
  const code = problem.code ? ` · ${problem.code}` : '';
  const title = problem.title && problem.title.length < 180 ? ` — ${problem.title}` : '';
  return `HTTP ${problem.status}${code}${title}`;
}

function operationLink(operationId: string): string {
  const params = new URLSearchParams({ operation: operationId });
  return `/operations?${params.toString()}`;
}

function ageLabel(sampledAt: string): string {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(sampledAt)) / 1000));
  if (!Number.isFinite(ageSeconds)) return `Sampled ${new Date(sampledAt).toLocaleString()}`;
  return ageSeconds < 60 ? `Sampled ${ageSeconds}s ago` : `Sampled ${Math.floor(ageSeconds / 60)}m ago`;
}

function freshnessVariant(state: 'fresh' | 'stale' | 'unknown'): 'success' | 'warning' | 'neutral' {
  if (state === 'fresh') return 'success';
  if (state === 'stale') return 'warning';
  return 'neutral';
}

function ProjectionStatus<T>({ source, now, staleAfterMs = SOURCE_STALE_AFTER_MS }: { source: Projection<T>; now: number; staleAfterMs?: number }) {
  if (source.kind === 'loading') return <Badge variant="neutral">Loading</Badge>;
  if (source.kind === 'unavailable') return <Badge variant="neutral">Unavailable</Badge>;
  if (source.kind === 'error') return <Badge variant="danger">Unavailable</Badge>;
  const stale = source.stale || sampleAgeState(source.sampledAt, now, staleAfterMs) === 'stale';
  return (
    <Badge variant={freshnessVariant(stale ? 'stale' : 'fresh')}>
      {source.refreshing ? 'Refreshing · last good sample' : stale ? 'Stale' : 'Fresh'}
    </Badge>
  );
}

function ProjectionMessage<T>({ source, noun }: { source: Projection<T>; noun: string }) {
  if (source.kind === 'unavailable') return <p className="text-sm text-[var(--text-sub)]">{source.reason}</p>;
  if (source.kind === 'error') return <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{noun} unavailable: {source.reason}</p>;
  if (source.kind === 'ready' && source.problem) {
    return <p role="status" className="text-xs text-[var(--badge-warning-text)]">Refresh failed ({source.problem}); showing the last successful sample from {new Date(source.sampledAt).toLocaleString()}.</p>;
  }
  return null;
}

function StatusValue({ value, stale = false }: { value: 'healthy' | 'degraded' | 'unknown'; stale?: boolean }) {
  if (stale) return <Badge variant="warning">Stale · last {value}</Badge>;
  if (value === 'healthy') return <Badge variant="success">Healthy</Badge>;
  if (value === 'degraded') return <Badge variant="danger">Degraded</Badge>;
  return <Badge variant="neutral">Unknown</Badge>;
}

function healthValue(value: boolean | null): 'healthy' | 'degraded' | 'unknown' {
  return value === true ? 'healthy' : value === false ? 'degraded' : 'unknown';
}

function healthProjectionStale(source: Projection<AdminHealthSnapshot>, now: number): boolean {
  return source.kind === 'ready' && (source.stale || sampleAgeState(source.sampledAt, now) === 'stale');
}

export function SystemOperationsScreen() {
  const { tenantId: selectedTenantId } = useTenant();
  const { section } = useParams();
  const selectionKey = selectedTenantId ?? 'all-tenants';
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;
  const sequence = useRef(0);
  const client = useMemo(() => createAdminApiClient(), []);
  const [snapshot, setSnapshot] = useState<DashboardState>(() => initialState(selectionKey));
  const snapshotRef = useRef(snapshot);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [composeRefreshKey, setComposeRefreshKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const commit = useCallback((next: DashboardState) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setComposeRefreshKey((current) => current + 1);
    const key = selectionKey;
    const requestSequence = ++sequence.current;
    const isCurrent = () => sequence.current === requestSequence && selectionRef.current === key;
    const prior = snapshotRef.current.selectionKey === key ? snapshotRef.current : initialState(key);
    commit({
      ...prior,
      session: prior.session.kind === 'ready' ? prior.session : { kind: 'loading' },
      metrics: beginRefresh(prior.metrics),
      operations: beginRefresh(prior.operations),
      health: beginRefresh(prior.health),
      workers: beginRefresh(prior.workers),
      services: beginRefresh(prior.services),
      queues: beginRefresh(prior.queues),
      incidents: beginRefresh(prior.incidents),
    });

    let sessionResult;
    try {
      sessionResult = await client.getSession();
    } catch {
      if (!isCurrent()) return;
      const current = snapshotRef.current;
      commit({ ...current, session: { kind: 'error', reason: 'The current admin session could not be read.' } });
      return;
    }
    if (!isCurrent()) return;
    if (!sessionResult.ok) {
      const current = snapshotRef.current;
      const reason = problemText(sessionResult.problem);
      commit({
        ...current,
        session: { kind: 'error', reason },
        metrics: failedRefresh(current.metrics, reason),
        operations: failedRefresh(current.operations, reason),
        health: failedRefresh(current.health, reason),
        workers: failedRefresh(current.workers, reason),
        services: failedRefresh(current.services, reason),
        queues: failedRefresh(current.queues, reason),
        incidents: failedRefresh(current.incidents, reason),
      });
      return;
    }

    const session = sessionResult.data;
    const tenantId = effectiveTenantId(session, selectedTenantId);
    const canReadPlatform = canReadPlatformSignals(session);
    const current = snapshotRef.current;
    const priorPrincipal = current.session.kind === 'ready'
      ? `${current.session.data.principal.kind}:${current.session.data.principal.tenantId ?? ''}`
      : null;
    const nextPrincipal = `${session.principal.kind}:${session.principal.tenantId ?? ''}`;
    const principalChanged = priorPrincipal !== null && priorPrincipal !== nextPrincipal;
    const sessionSnapshot = principalChanged ? initialState(key) : current;
    commit({
      ...sessionSnapshot,
      session: { kind: 'ready', data: session },
      effectiveTenantId: tenantId,
      metrics: canReadPlatform ? beginRefresh(sessionSnapshot.metrics) : { kind: 'unavailable', reason: 'Operation metrics require an authenticated platform or tenant scope.' },
      operations: canReadPlatform ? beginRefresh(sessionSnapshot.operations) : { kind: 'unavailable', reason: 'Operations are unavailable for this session scope.' },
      health: canReadPlatform ? beginRefresh(sessionSnapshot.health) : { kind: 'unavailable', reason: 'Platform health is restricted to platform administrators.' },
      workers: canReadPlatform ? beginRefresh(sessionSnapshot.workers) : { kind: 'unavailable', reason: 'Worker inventory is platform-scoped and is hidden from tenant sessions.' },
      services: canReadPlatform ? beginRefresh(sessionSnapshot.services) : { kind: 'unavailable', reason: 'Detailed service inventory is restricted to platform administrators.' },
      queues: canReadPlatform ? beginRefresh(sessionSnapshot.queues) : { kind: 'unavailable', reason: 'Queue admission inventory is restricted to platform administrators.' },
      incidents: canReadIncidentLedger(session) && (session.scope?.kind === 'tenant' || tenantId !== null)
        ? beginRefresh(sessionSnapshot.incidents)
        : { kind: 'unavailable', reason: canReadIncidentLedger(session) ? 'Choose one tenant to read its incident signals.' : 'This local identity has no incident-wide read grant.' },
    });

    if (!canReadPlatform) {
      // Tenant-scoped operation projections are supported by the existing BFF. Health and worker inventory are platform-only.
      if (session.scope?.kind === 'tenant') {
        await Promise.all([
          readMetrics(tenantId),
          readOperations(tenantId),
          ...(canReadIncidentLedger(session) ? [readIncidents(tenantId)] : []),
        ]);
      }
      return;
    }
    await Promise.all([
      readMetrics(tenantId),
      readOperations(tenantId),
      readHealth(),
      readWorkers(),
      readServiceInventory(tenantId),
      readQueueInventory(tenantId),
      ...(canReadIncidentLedger(session) && tenantId !== null ? [readIncidents(tenantId)] : []),
    ]);

    async function readMetrics(scopedTenantId: string | null): Promise<void> {
      if (typeof client.getOperationsMetrics !== 'function') {
        if (isCurrent()) updateSource('metrics', { kind: 'unavailable', reason: 'This Admin API client does not expose the server operations metrics projection.' });
        return;
      }
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      try {
        const result = await client.getOperationsMetrics({ from, to, ...(scopedTenantId ? { tenant: scopedTenantId } : {}) });
        if (!isCurrent()) return;
        if (!result.ok) {
          updateSource('metrics', failedRefresh(snapshotRef.current.metrics, problemText(result.problem)));
          return;
        }
        const parsed = parseOperationsMetrics(result.data, { from, to, tenantId: scopedTenantId });
        if (!parsed) {
          updateSource('metrics', failedRefresh(snapshotRef.current.metrics, 'The operations metrics response did not match the selected tenant and time window.'));
          return;
        }
        updateSource('metrics', { kind: 'ready', data: parsed, sampledAt: parsed.sampledAt, stale: parsed.stale, refreshing: false, problem: null });
      } catch {
        if (isCurrent()) updateSource('metrics', failedRefresh(snapshotRef.current.metrics, 'The operations metrics request failed.'));
      }
    }

    async function readOperations(scopedTenantId: string | null): Promise<void> {
      try {
        const result = await client.listOperations({
          limit: String(OPERATIONS_PAGE_LIMIT),
          sort: 'created_at:desc',
          ...(scopedTenantId ? { tenant: scopedTenantId } : {}),
        });
        if (!isCurrent()) return;
        if (!result.ok) {
          updateSource('operations', failedRefresh(snapshotRef.current.operations, problemText(result.problem)));
          return;
        }
        const parsed = parseOperationsPage(result.data);
        if (!parsed) {
          updateSource('operations', failedRefresh(snapshotRef.current.operations, 'The operations page could not be validated.'));
          return;
        }
        updateSource('operations', { kind: 'ready', data: parsed.items, sampledAt: new Date().toISOString(), stale: false, refreshing: false, problem: null });
      } catch {
        if (isCurrent()) updateSource('operations', failedRefresh(snapshotRef.current.operations, 'The operations list request failed.'));
      }
    }

    async function readHealth(): Promise<void> {
      try {
        const result = await client.getHealth();
        if (!isCurrent()) return;
        if (!result.ok) {
          updateSource('health', failedRefresh(snapshotRef.current.health, problemText(result.problem)));
          return;
        }
        const parsed = parseAdminHealthSnapshot(result.data);
        if (!parsed) {
          updateSource('health', failedRefresh(snapshotRef.current.health, 'The health snapshot could not be validated.'));
          return;
        }
        updateSource('health', { kind: 'ready', data: parsed, sampledAt: parsed.sampledAt, stale: false, refreshing: false, problem: null });
      } catch {
        if (isCurrent()) updateSource('health', failedRefresh(snapshotRef.current.health, 'The health request failed.'));
      }
    }

    async function readWorkers(): Promise<void> {
      try {
        const result = await client.listWorkerInstances({ limit: '500' });
        if (!isCurrent()) return;
        if (!result.ok) {
          updateSource('workers', failedRefresh(snapshotRef.current.workers, problemText(result.problem)));
          return;
        }
        const parsed = parseWorkerInstanceList(result.data);
        if (!parsed) {
          updateSource('workers', failedRefresh(snapshotRef.current.workers, 'The worker inventory response could not be validated.'));
          return;
        }
        updateSource('workers', { kind: 'ready', data: parsed, sampledAt: parsed.sampledAt, stale: false, refreshing: false, problem: null });
      } catch {
        if (isCurrent()) updateSource('workers', failedRefresh(snapshotRef.current.workers, 'The worker inventory request failed.'));
      }
    }

    async function readServiceInventory(scopedTenantId: string | null): Promise<void> {
      try {
        const result = await client.getServiceInventory(scopedTenantId ? { tenantId: scopedTenantId } : undefined);
        if (!isCurrent()) return;
        if (!result.ok) {
          updateSource('services', failedRefresh(snapshotRef.current.services, problemText(result.problem)));
          return;
        }
        updateSource('services', { kind: 'ready', data: result.data, sampledAt: result.data.sampledAt, stale: result.data.freshness !== 'FRESH', refreshing: false, problem: null });
      } catch {
        if (isCurrent()) updateSource('services', failedRefresh(snapshotRef.current.services, 'The service inventory request failed.'));
      }
    }

    async function readQueueInventory(scopedTenantId: string | null): Promise<void> {
      try {
        const result = await client.getQueueInventory(scopedTenantId ? { tenantId: scopedTenantId } : undefined);
        if (!isCurrent()) return;
        if (!result.ok) {
          updateSource('queues', failedRefresh(snapshotRef.current.queues, problemText(result.problem)));
          return;
        }
        updateSource('queues', { kind: 'ready', data: result.data, sampledAt: result.data.sampledAt, stale: result.data.freshness !== 'FRESH', refreshing: false, problem: null });
      } catch {
        if (isCurrent()) updateSource('queues', failedRefresh(snapshotRef.current.queues, 'The queue inventory request failed.'));
      }
    }

    async function readIncidents(scopedTenantId: string | null): Promise<void> {
      if (!scopedTenantId) {
        updateSource('incidents', { kind: 'unavailable', reason: 'Choose one tenant to read its incident signals.' });
        return;
      }
      try {
        const query: IncidentListQuery = { tenantId: scopedTenantId, status: 'open', limit: 20 };
        const result = await client.listIncidents(query);
        if (!isCurrent()) return;
        if (!result.ok) {
          updateSource('incidents', failedRefresh(snapshotRef.current.incidents, problemText(result.problem)));
          return;
        }
        if (result.data.tenantId !== scopedTenantId || result.data.connectorSignals?.tenantId !== scopedTenantId) {
          updateSource('incidents', failedRefresh(snapshotRef.current.incidents, 'The incident response did not match the selected tenant.'));
          return;
        }
        updateSource('incidents', { kind: 'ready', data: result.data, sampledAt: result.data.sampledAt, stale: false, refreshing: false, problem: null });
      } catch {
        if (isCurrent()) updateSource('incidents', failedRefresh(snapshotRef.current.incidents, 'The incident ledger request failed.'));
      }
    }

    function updateSource<K extends keyof Pick<DashboardState, 'metrics' | 'operations' | 'health' | 'workers' | 'services' | 'queues' | 'incidents'>>(keyName: K, value: DashboardState[K]): void {
      if (!isCurrent()) return;
      commit({ ...snapshotRef.current, [keyName]: value });
    }
  }, [client, commit, selectionKey, selectedTenantId]);

  useEffect(() => {
    void load();
    return () => { sequence.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const stopRefreshOnExpiredSession = () => setAutoRefresh(false);
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, stopRefreshOnExpiredSession);
    return () => window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, stopRefreshOnExpiredSession);
  }, []);

  useEffect(() => {
    if (!section) return;
    document.getElementById(section)?.scrollIntoView({ block: 'start' });
  }, [section]);

  const visible = snapshot.selectionKey === selectionKey ? snapshot : initialState(selectionKey);
  const healthStale = healthProjectionStale(visible.health, now);
  const operations = visible.operations.kind === 'ready' ? visible.operations.data : [];
  const signals = useMemo(() => deriveOperationSignals(operations, now), [operations, now]);
  const currentHealth = visible.health.kind === 'ready' ? visible.health.data : null;
  const currentWorkers = visible.workers.kind === 'ready' ? visible.workers.data : null;
  const currentServices = visible.services.kind === 'ready' ? visible.services.data : null;
  const currentQueues = visible.queues.kind === 'ready' ? visible.queues.data : null;
  const currentIncidents = visible.incidents.kind === 'ready' ? visible.incidents.data : null;
  const platformSession = visible.session.kind === 'ready' && canReadPlatformSignals(visible.session.data);
  const incidentLedgerVisible = visible.session.kind === 'ready' && canReadIncidentLedger(visible.session.data);
  const tenantCaption = visible.session.kind === 'ready'
    ? visible.session.data.scope?.kind === 'tenant'
      ? `Tenant scope: ${visible.session.data.scope.tenantId}`
      : visible.effectiveTenantId
        ? `Tenant filter: ${visible.effectiveTenantId}`
        : 'Platform scope'
    : 'Resolving admin scope…';
  const issueCount = (currentHealth?.status === 'degraded' ? 1 : 0)
    + (currentHealth?.queueIntegrity?.state === 'SUSPECT' ? 1 : 0)
    + (currentWorkers?.items.filter((worker) => worker.health !== 'HEALTHY').length ?? 0)
    + signals.unknown.length + signals.overdueInput.length
    + (currentIncidents?.items.length ?? 0)
    + (currentQueues?.queues.filter((queue) => queue.admission.state !== 'OPEN' || queue.workerCompatibility.compatibleOnline === 0).length ?? 0);

  return (
    <section aria-labelledby="system-operations-title" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 id="system-operations-title" className="text-lg font-semibold">System operations</h1>
            <Badge variant="neutral">sampled operations cockpit</Badge>
            <Badge variant={issueCount > 0 ? 'warning' : 'neutral'}>{issueCount > 0 ? `${issueCount} sampled signals need review` : 'Signal status depends on source availability'}</Badge>
          </div>
          <p className="mt-1 text-sm text-[var(--text-sub)]">{tenantCaption}. Samples come from the current Admin projections; missing sources stay unknown.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={autoRefresh ? 'secondary' : 'outline'} aria-pressed={autoRefresh} onClick={() => setAutoRefresh((value) => !value)}>
            {autoRefresh ? 'Auto refresh: On' : 'Auto refresh: Paused'}
          </Button>
          <Button size="sm" variant="outline" leftIcon={<RefreshCw className="size-3.5" />} onClick={() => void load()}>
            Refresh now
          </Button>
        </div>
      </div>

      {visible.session.kind === 'error' ? <AlertBanner variant="error" title="Admin scope unavailable">{visible.session.reason}. No system projections were requested.</AlertBanner> : null}
      {visible.health.kind === 'ready' && visible.health.problem ? <ProjectionMessage source={visible.health} noun="Platform health" /> : null}
      {visible.metrics.kind === 'ready' && visible.metrics.problem ? <ProjectionMessage source={visible.metrics} noun="Operation metrics" /> : null}
      {visible.operations.kind === 'ready' && visible.operations.problem ? <ProjectionMessage source={visible.operations} noun="Operations sample" /> : null}
      {visible.workers.kind === 'ready' && visible.workers.problem ? <ProjectionMessage source={visible.workers} noun="Worker inventory" /> : null}
      {visible.services.kind === 'ready' && visible.services.problem ? <ProjectionMessage source={visible.services} noun="Service inventory" /> : null}
      {visible.queues.kind === 'ready' && visible.queues.problem ? <ProjectionMessage source={visible.queues} noun="Queue inventory" /> : null}
      {visible.incidents.kind === 'ready' && visible.incidents.problem ? <ProjectionMessage source={visible.incidents} noun="Incident ledger" /> : null}

      <nav aria-label="System operations sections" className="flex flex-wrap gap-2 text-sm">
        {[
          ['Services', 'services'],
          ['Workers & Queues', 'workers-queues'],
          ...(incidentLedgerVisible ? [['Incidents & triage', 'incidents'] as [string, string]] : []),
          ['Deployments', 'deployments'],
          ['Maintenance', 'maintenance'],
        ].map(([label, id]) => <Link key={id} className="rounded border border-[var(--border-subtle)] px-3 py-2 text-[var(--cf-blue)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" to={`/system-operations/${id}`}>{label}</Link>)}
      </nav>

      <section id="services" aria-labelledby="services-title" className="scroll-mt-24">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle id="services-title" className="flex items-center gap-2"><Server className="size-4 text-[var(--cf-blue)]" />Services and dependencies</CardTitle>
                <CardDescription>Platform health is one sampled process/dependency check. It does not prove provider authentication, deployment readiness, or every replica's state.</CardDescription>
              </div>
              <ProjectionStatus source={visible.health} now={now} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ProjectionMessage source={visible.health} noun="Platform health" />
            {currentHealth ? (
              <>
                {healthStale ? <AlertBanner variant="warning" title="Health sample is stale">The last successful platform health response was {new Date(currentHealth.sampledAt).toLocaleString()}. Current dependency state is unknown until a refresh succeeds.</AlertBanner> : null}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <ServiceSignal label="Orchestrator health endpoint" value={currentHealth.status === 'ok' ? 'healthy' : currentHealth.status === 'degraded' ? 'degraded' : 'unknown'} stale={healthStale} detail={`Reported ${new Date(currentHealth.sampledAt).toLocaleString()}`} />
                  <ServiceSignal label="PostgreSQL" value={healthValue(currentHealth.db)} stale={healthStale} detail="Admin health probe" />
                  <ServiceSignal label="Redis" value={healthValue(currentHealth.redis)} stale={healthStale} detail="Admin health probe" />
                  <ServiceSignal label="Queue integrity sweep" value={currentHealth.queueIntegrity?.state === 'OK' ? 'healthy' : currentHealth.queueIntegrity?.state === 'SUSPECT' ? 'degraded' : 'unknown'} stale={healthStale} detail={currentHealth.queueIntegrity?.lastSweepAt ? `Last sweep ${new Date(currentHealth.queueIntegrity.lastSweepAt).toLocaleString()}` : 'Sweep time unavailable'} />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Gauge label="Active leases" value={healthStale ? null : currentHealth.activeLeases} detail="Platform-wide live gauge" />
                  <Gauge label="Stalled queue tasks" value={healthStale ? null : currentHealth.queueIntegrity?.stalled ?? null} detail="Latest integrity sweep" />
                  <Gauge label="Outbox backlog" value={healthStale ? null : currentHealth.outboxBacklog} detail="Unavailable when the health contract omits it" />
                </div>
              </>
            ) : visible.health.kind === 'loading' ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading platform health…</p> : null}
            <div className="flex flex-wrap gap-2 text-sm">
              <Link className="text-[var(--cf-blue)] underline" to="/connectors">Connector configuration and revisions</Link>
              <Link className="text-[var(--cf-blue)] underline" to="/businesses">Business registry</Link>
              <Link className="text-[var(--cf-blue)] underline" to="/settings">Settings and configuration</Link>
            </div>
            {!platformSession && visible.session.kind === 'ready' ? <p className="text-xs text-[var(--text-sub)]">Tenant sessions cannot read aggregate platform dependency health. Tenant operations remain filtered to the credential scope.</p> : null}
          </CardContent>
        </Card>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Service inventory and replicas</CardTitle>
            <CardDescription>Host-returned per-service dependency and replica observations. Desired and observed revisions remain distinct; a missing source row is not treated as healthy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProjectionMessage source={visible.services} noun="Service inventory" />
            {currentServices ? <>
              <p className="text-xs text-[var(--text-sub)]">{currentServices.freshness} · {currentServices.source.join(', ')} · sampled {new Date(currentServices.sampledAt).toLocaleString()}</p>
              {currentServices.services.length === 0 ? <p className="rounded-md border border-dashed border-[var(--border-subtle)] p-3 text-sm text-[var(--text-sub)]">No service rows were returned. The source has not reported whether services or replicas exist.</p> : null}
              <div className="grid min-w-0 gap-3 xl:grid-cols-3">{currentServices.services.map((service) => <article key={service.serviceId} className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-all font-semibold">{service.serviceId}</h3><Badge variant="neutral">{service.kind}</Badge></div>
                <p className="mt-2 text-xs text-[var(--text-sub)]">{service.replicas.length} replica rows · {service.dependencies.filter((dependency) => dependency.state === 'HEALTHY').length}/{service.dependencies.length} dependencies report healthy</p>
                {service.replicas.slice(0, 3).map((replica) => <p key={replica.replicaId} className="mt-2 break-words border-t border-[var(--border-subtle)] pt-2 text-xs"><Badge variant={replica.state === 'READY' || replica.state === 'LIVE' ? 'success' : replica.state === 'UNKNOWN' ? 'neutral' : 'warning'}>{replica.state}</Badge> <code>{replica.replicaId}</code><br />Desired {replica.desiredRevision ?? 'Unknown'} · Observed {replica.observedRevision ?? 'Unknown'} · active work {replica.activeWork === null ? 'Unknown' : replica.activeWork}</p>)}
                <Link className="mt-3 inline-flex text-sm text-[var(--cf-blue)] underline" to={`/system-operations/services?service=${encodeURIComponent(service.serviceId)}`}>Open service and dependency detail</Link>
              </article>)}</div>
              {currentServices.services.length > 3 ? <Link className="text-sm text-[var(--cf-blue)] underline" to="/system-operations/services">Open all service inventory</Link> : null}
            </> : null}
          </CardContent>
        </Card>
      </section>

      <section id="workers-queues" aria-labelledby="workers-title" className="scroll-mt-24">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle id="workers-title" className="flex items-center gap-2"><Boxes className="size-4 text-[var(--cf-blue)]" />Workers and queue integrity</CardTitle>
                <CardDescription>Worker rows are persisted heartbeat instances only. The separate queue inventory reports counts, runnable wait age, worker compatibility and admission state from its own host sample.</CardDescription>
              </div>
              <ProjectionStatus source={visible.workers} now={now} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ProjectionMessage source={visible.workers} noun="Worker inventory" />
            {visible.workers.kind === 'unavailable' ? <p className="text-xs text-[var(--text-sub)]">{visible.workers.reason}</p> : null}
            {visible.workers.kind === 'loading' ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading recorded worker heartbeats…</p> : null}
            {currentWorkers ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="info">{currentWorkers.truncated ? `At least ${currentWorkers.items.length} recorded instances` : `${currentWorkers.items.length} recorded instances`}</Badge>
                  <span className="text-xs text-[var(--text-sub)]">{ageLabel(currentWorkers.sampledAt)}. A business with no heartbeat is not represented as an offline replica.</span>
                </div>
                {currentWorkers.items.length === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--border-subtle)] p-4 text-sm text-[var(--text-sub)]">No worker heartbeat records were returned. This inventory cannot establish whether unreported deployments exist.</div>
                ) : (
                  <TableContainer className="rounded-md border border-[var(--border-subtle)]">
                    <Table>
                      <TableHeader><TableRow><TableHead>Worker instance</TableHead><TableHead>Business / version</TableHead><TableHead>Health</TableHead><TableHead className="text-right">Active leases</TableHead><TableHead className="text-right">Capacity</TableHead><TableHead>Last heartbeat</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {currentWorkers.items.map((worker) => (
                          <TableRow key={`${worker.businessId}:${worker.instanceId}`}>
                            <TableCell className="font-mono text-xs">{worker.instanceId}</TableCell>
                            <TableCell className="font-mono text-xs">{worker.businessId}@{worker.businessVersion}</TableCell>
                            <TableCell><Badge variant={worker.health === 'HEALTHY' ? 'success' : worker.health === 'DEGRADED' ? 'warning' : 'danger'}>{worker.health} · {worker.state}</Badge></TableCell>
                            <TableCell className="text-right tabular-nums">{worker.activeLeases.toLocaleString()}</TableCell>
                            <TableCell className="text-right tabular-nums">{worker.capacity.toLocaleString()}</TableCell>
                            <TableCell><time dateTime={worker.lastSeenAt} title={worker.lastSeenAt}>{new Date(worker.lastSeenAt).toLocaleString()}</time></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
                {currentWorkers.truncated ? <p className="text-xs text-[var(--text-sub)]">The API capped this inventory at 500 rows. Some instances may not appear in this sample.</p> : null}
              </>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Gauge label="Queue integrity" value={currentHealth?.queueIntegrity?.state ?? null} detail={healthStale ? 'Health sample stale' : 'Periodic consistency sweep'} />
              <Gauge label="Orphans in last sweep" value={healthStale ? null : currentHealth?.queueIntegrity?.orphansLast ?? null} detail="No value means unavailable" />
              <Gauge label="Outbox delivery backlog" value={healthStale ? null : currentHealth?.outboxBacklog ?? null} detail="Not a business queue-size metric" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Link className="text-sm text-[var(--cf-blue)] underline" to="/businesses">Review business versions and assignments</Link>
              <Link className="text-sm text-[var(--cf-blue)] underline" to="/operations">Review operation backlog</Link>
            </div>
          </CardContent>
        </Card>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Queue load and admission</CardTitle>
            <CardDescription>Queue counts, oldest runnable age, worker compatibility, and admission state come from the host inventory sample.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProjectionMessage source={visible.queues} noun="Queue inventory" />
            {currentQueues ? <>
              <p className="text-xs text-[var(--text-sub)]">{currentQueues.freshness} · {currentQueues.source.join(', ')} · sampled {new Date(currentQueues.sampledAt).toLocaleString()}</p>
              {currentQueues.queues.length === 0 ? <p className="rounded-md border border-dashed border-[var(--border-subtle)] p-3 text-sm text-[var(--text-sub)]">No queue rows were returned. This does not establish that other queues are healthy or empty.</p> : null}
              <ul className="grid min-w-0 gap-3 xl:grid-cols-2">{currentQueues.queues.slice(0, 10).map((queue) => <li key={`${queue.businessId}@${queue.businessVersion}:${queue.queueName}`} className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><strong className="break-all">{queue.queueName}</strong><Badge variant={queue.admission.state === 'OPEN' ? 'success' : 'warning'}>{queue.admission.state}</Badge></div>
                <p className="mt-1 break-all text-xs text-[var(--text-sub)]">{queue.businessId}@{queue.businessVersion}</p>
                <p className="mt-2 text-sm">Waiting {queue.counts.waiting ?? 'Unknown'} · delayed {queue.counts.delayed ?? 'Unknown'} · active {queue.counts.active ?? 'Unknown'} · failed {queue.counts.failed ?? 'Unknown'}</p>
                <p className="text-xs text-[var(--text-sub)]">Oldest runnable age {queue.oldestRunnableAgeMs === null ? 'Unknown' : `${Math.floor(queue.oldestRunnableAgeMs / 1000).toLocaleString()}s`} · compatible online workers {queue.workerCompatibility.compatibleOnline} · leases {queue.admission.activeLeases}</p>
                <Link className="mt-2 inline-flex text-sm text-[var(--cf-blue)] underline" to={`/system-operations/workers-queues?queue=${encodeURIComponent(queue.queueName)}`}>Investigate this queue</Link>
              </li>)}</ul>
              {currentQueues.queues.length > 10 ? <Link className="text-sm text-[var(--cf-blue)] underline" to="/system-operations/workers-queues">Open all queues</Link> : null}
            </> : null}
          </CardContent>
        </Card>
      </section>

      <section id="incidents" aria-labelledby="incidents-title" className="scroll-mt-24">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle id="incidents-title" className="flex items-center gap-2"><ShieldAlert className="size-4 text-[var(--cf-blue)]" />Incidents and triage signals</CardTitle>
                <CardDescription>Live sampled triage stays distinct from persisted source-bound incidents and their lifecycle history.</CardDescription>
              </div>
              <Badge variant={issueCount > 0 ? 'warning' : 'neutral'}>{issueCount > 0 ? `${issueCount} observed signals` : 'No observed signals'}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProjectionMessage source={visible.metrics} noun="Operation metrics" />
            <ProjectionMessage source={visible.operations} noun="Recent operation sample" />
            <ProjectionMessage source={visible.incidents} noun="Incident ledger" />
            {visible.operations.kind === 'ready' ? (
              <>
                <p className="text-xs text-[var(--text-sub)]">Exception and HITL counts below describe the latest {OPERATIONS_PAGE_LIMIT} operation rows returned, not the full history. Current sample was retrieved {new Date(visible.operations.sampledAt).toLocaleString()}.</p>
                {signals.unknown.length === 0 && signals.waitingInput.length === 0 && currentHealth?.status !== 'degraded' && (currentWorkers?.items.every((worker) => worker.health === 'HEALTHY') ?? false) ? (
                  <div className="rounded-md border border-dashed border-[var(--border-subtle)] p-4 text-sm text-[var(--text-sub)]">No issues appeared in the loaded projections. This sample does not establish that every source is healthy.</div>
                ) : null}
                {signals.unknown.length > 0 ? <SignalGroup title="Unknown outcomes in latest sample" icon={<AlertTriangle className="size-4" />} items={signals.unknown} variant="danger" /> : null}
                {signals.overdueInput.length > 0 ? <SignalGroup title="Waiting input past deadline in latest sample" icon={<Timer className="size-4" />} items={signals.overdueInput} variant="warning" /> : null}
                {signals.waitingInput.length > signals.overdueInput.length ? <SignalGroup title="Human review waiting in latest sample" icon={<Activity className="size-4" />} items={signals.waitingInput.filter((item) => !signals.overdueInput.some((overdue) => overdue.id === item.id))} variant="info" /> : null}
                {signals.unknown.length === 0 && signals.waitingInput.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No UNKNOWN or waiting-input operation appeared in this page sample. Older operations were not queried.</p> : null}
              </>
            ) : null}
            {visible.health.kind === 'ready' && currentHealth?.status === 'degraded' ? <SignalRow title="Platform health reported degraded" detail={`Sampled ${new Date(currentHealth.sampledAt).toLocaleString()}${healthStale ? ' · stale' : ''}`} to="#services" /> : null}
            {visible.health.kind === 'ready' && currentHealth?.queueIntegrity?.state === 'SUSPECT' ? <SignalRow title="Queue integrity is SUSPECT" detail="Inspect the latest sweep and operation state before taking action." to="#workers-queues" /> : null}
            {currentIncidents?.items.map((incident) => <div key={incident.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-md border border-[var(--border-subtle)] p-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge variant={incident.severity === 'critical' || incident.severity === 'high' ? 'danger' : incident.severity === 'medium' ? 'warning' : 'info'}>{incident.severity}</Badge><Badge variant="warning">{incident.status}</Badge><strong className="break-words text-sm">{incident.summary}</strong></div><p className="mt-1 break-all text-xs text-[var(--text-sub)]">{incident.source} · {incident.sourceRef} · last seen {new Date(incident.lastSeenAt).toLocaleString()}</p></div><Link className="shrink-0 text-sm text-[var(--cf-blue)] underline" to={`/system-operations/incidents?incident=${encodeURIComponent(incident.id)}`}>Open incident</Link></div>)}
            {currentIncidents && currentIncidents.items.length === 0 ? <p className="rounded-md border border-dashed border-[var(--border-subtle)] p-3 text-sm text-[var(--text-sub)]">No open source-bound incidents matched the current tenant sample. Source availability is reported separately below.</p> : null}
            {currentIncidents?.connectorSignals ? <div className="rounded-md border border-[var(--border-subtle)] p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><strong>Connector ledger</strong><Badge variant={currentIncidents.connectorSignals.status === 'fresh' ? 'success' : currentIncidents.connectorSignals.status === 'stale' ? 'warning' : 'neutral'}>{currentIncidents.connectorSignals.status}</Badge></div><p className="mt-1 text-xs text-[var(--text-sub)]">{currentIncidents.connectorSignals.sampledAt ? `Sampled ${new Date(currentIncidents.connectorSignals.sampledAt).toLocaleString()}` : 'No source sample'} · UNKNOWN {currentIncidents.connectorSignals.invocationCounts?.UNKNOWN ?? 'Unknown'} · pending usage outbox {currentIncidents.connectorSignals.pendingOutbox ?? 'Unknown'}{currentIncidents.connectorSignals.oldestPendingLagMs === null ? '' : ` · oldest pending ${Math.floor(currentIncidents.connectorSignals.oldestPendingLagMs / 1000)}s`}</p></div> : null}
            {currentIncidents && currentIncidents.hasMore ? <Link className="text-sm text-[var(--cf-blue)] underline" to="/system-operations/incidents">Review all open incidents</Link> : null}
            {currentWorkers?.items.filter((worker) => worker.health !== 'HEALTHY').map((worker) => <SignalRow key={`${worker.businessId}:${worker.instanceId}`} title={`Worker ${worker.instanceId} is ${worker.health.toLowerCase()}`} detail={`${worker.businessId}@${worker.businessVersion} · last seen ${new Date(worker.lastSeenAt).toLocaleString()}`} to="/businesses" />)}
            <div className="flex flex-wrap gap-3 border-t border-[var(--border-subtle)] pt-3 text-sm">
              <Link className="text-[var(--cf-blue)] underline" to="/operations">Open Operations</Link>
              {incidentLedgerVisible ? <Link className="text-[var(--cf-blue)] underline" to="/system-operations/incidents">Open incident ledger</Link> : null}
              <Link className="text-[var(--cf-blue)] underline" to="/connectors">Review Connector configuration</Link>
              <Link className="text-[var(--cf-blue)] underline" to="/audit">Review audit events</Link>
            </div>
          </CardContent>
        </Card>
      </section>

      <ComposeOperationsPanel
        session={visible.session.kind === 'ready' ? visible.session.data : null}
        sessionProblem={visible.session.kind === 'error' ? visible.session.reason : null}
        refreshKey={composeRefreshKey}
        onRefresh={() => void load()}
      />
    </section>
  );

}

function ServiceSignal({ label, value, stale, detail }: { label: string; value: 'healthy' | 'degraded' | 'unknown'; stale: boolean; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-3">
      <span className="text-xs font-semibold text-[var(--text-sub)]">{label}</span>
      <StatusValue value={value} stale={stale} />
      <span className="text-xs text-[var(--text-sub)]">{detail}</span>
    </div>
  );
}

function Gauge({ label, value, detail }: { label: string; value: number | string | null | undefined; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3">
      <span className="text-xs text-[var(--text-sub)]">{label}</span>
      <strong className="break-words text-lg tabular-nums">{value === null || value === undefined ? 'Unknown' : typeof value === 'number' ? value.toLocaleString() : value}</strong>
      <span className="text-xs text-[var(--text-sub)]">{detail}</span>
    </div>
  );
}

function SignalGroup({ title, icon, items, variant }: { title: string; icon: React.ReactNode; items: OperationWire[]; variant: 'danger' | 'warning' | 'info' }) {
  return (
    <div className="rounded-md border border-[var(--border-subtle)] p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">{icon}{title} <Badge variant={variant}>{items.length} in sample</Badge></h3>
      <ul className="space-y-2">
        {items.slice(0, 8).map((item) => (
          <li key={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0"><span className="font-mono">{item.id}</span>{item.errorCode ? <span className="ml-2 text-xs text-[var(--text-sub)]">{item.errorCode}</span> : null}{item.deadlineAt ? <span className="ml-2 text-xs text-[var(--text-sub)]">deadline {new Date(item.deadlineAt).toLocaleString()}</span> : null}</span>
            <Link className="shrink-0 text-[var(--cf-blue)] underline" to={operationLink(item.id)}>Open operation</Link>
          </li>
        ))}
      </ul>
      {items.length > 8 ? <p className="mt-2 text-xs text-[var(--text-sub)]">Showing 8 of {items.length} matches in the latest page.</p> : null}
    </div>
  );
}

function SignalRow({ title, detail, to }: { title: string; detail: string; to: string }) {
  return <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-[var(--border-subtle)] px-3 py-2"><div><strong className="text-sm">{title}</strong><p className="text-xs text-[var(--text-sub)]">{detail}</p></div><Link className="text-sm text-[var(--cf-blue)] underline" to={to}>Investigate</Link></div>;
}
