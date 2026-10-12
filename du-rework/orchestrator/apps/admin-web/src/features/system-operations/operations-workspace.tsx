import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Boxes, RefreshCw, Server, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { createAdminApiClient, type AdminWebSession } from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import type {
  DurableJobState,
  ExecuteReplicaRollout,
  MaintenanceJob,
  MaintenanceKind,
  MaintenancePreview,
  MaintenancePreviewRequest,
  ExecuteReplicaRollback,
  QueueAction,
  QueueActionJob,
  QueueActionPreview,
  QueueActionPreviewRequest,
  QueueInventory,
  ReplicaRolloutJob,
  ReplicaRollbackPreview,
  ReplicaRolloutPreview,
  ReplicaRolloutPreviewRequest,
  ServiceInventory,
} from '@du/contracts';

export type OperationsSection = 'services' | 'workers-queues' | 'deployments' | 'maintenance';

type AsyncState<T extends { sampledAt: string; source: string[]; freshness: string }> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: T; stale: boolean; problem?: string };

const MAINTENANCE_KINDS: MaintenanceKind[] = [
  'cache_cleanup', 'retention_cleanup', 'orphan_reconcile', 'stalled_lease_recovery', 'failed_delivery_recovery', 'backup', 'restore',
];
const QUEUE_ACTIONS: QueueAction[] = ['pause', 'drain', 'resume', 'retry'];

function messageFor(result: { status: number; problem: { code?: string; title?: string } }): string {
  const title = result.problem.title && result.problem.title.length < 180 ? ` · ${result.problem.title}` : '';
  return `HTTP ${result.status}${result.problem.code ? ` · ${result.problem.code}` : ''}${title}`;
}

function isTerminal(state: DurableJobState): boolean {
  return ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(state);
}

function statusVariant(state: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (['HEALTHY', 'READY', 'LIVE', 'SUCCEEDED', 'APPLIED', 'PASSED', 'FRESH'].includes(state)) return 'success';
  if (['DEGRADED', 'DRAINING', 'PARTIAL', 'SKIPPED', 'STALE', 'PAUSED'].includes(state)) return 'warning';
  if (['UNAVAILABLE', 'OFFLINE', 'FAILED', 'UNKNOWN'].includes(state)) return 'danger';
  return 'neutral';
}

function formatTime(value: string | null): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown';
}

function numberOrUnknown(value: number | null): string {
  return value === null ? 'Unknown' : value.toLocaleString();
}

function makeIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `orv14-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isPlatformAdmin(session: AdminWebSession | null): boolean {
  return session?.role === 'admin' && session.principal.kind === 'platform' && session.scope?.kind === 'platform';
}

function effectiveTenant(session: AdminWebSession | null, selectedTenantId: string | null): string | undefined {
  if (session?.scope?.kind === 'tenant') return session.scope.tenantId;
  return selectedTenantId ?? undefined;
}

function freshnessLabel<T extends { sampledAt: string; source: string[]; freshness: string }>(state: AsyncState<T>): string {
  if (state.kind === 'loading') return 'Loading';
  if (state.kind === 'error') return 'Unavailable';
  return `${state.data.freshness} · ${state.data.source.join(', ') || 'source unavailable'} · sampled ${formatTime(state.data.sampledAt)}${state.stale ? ' · last good sample' : ''}`;
}

function selectedScope(session: AdminWebSession | null, tenantId: string | undefined) {
  if (session?.scope?.kind === 'tenant') return { kind: 'tenant' as const, tenantId: session.scope.tenantId };
  if (tenantId) return { kind: 'tenant' as const, tenantId };
  return { kind: 'platform' as const };
}

function scopeName(scope: { kind: string; tenantId?: string; businessId?: string; businessVersion?: string }): string {
  if (scope.kind === 'platform') return 'Platform';
  if (scope.kind === 'tenant') return `Tenant ${scope.tenantId}`;
  return `Business ${scope.businessId}@${scope.businessVersion}`;
}

function queueKey(queue: { queueName: string; businessId: string; businessVersion: string }): string {
  return `${queue.businessId}@${queue.businessVersion}:${queue.queueName}`;
}

export function OperationsWorkspace({ section, session }: { section: OperationsSection; session: AdminWebSession | null }) {
  const { tenantId: selectedTenantId } = useTenant();
  const [params, setParams] = useSearchParams();
  const client = useMemo(() => createAdminApiClient(), []);
  const tenantId = effectiveTenant(session, selectedTenantId);
  const scopeKey = `${session?.role ?? 'none'}:${session?.plane ?? 'none'}:${session?.localUser ? 'local-user' : 'admin-session'}:${session?.displayName ?? ''}:${session?.principal.kind ?? 'none'}:${session?.principal.tenantId ?? ''}:${tenantId ?? 'platform'}`;
  const sequence = useRef(0);
  const [services, setServices] = useState<AsyncState<ServiceInventory>>({ kind: 'loading' });
  const [queues, setQueues] = useState<AsyncState<QueueInventory>>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const currentSequence = ++sequence.current;
    const currentScope = scopeKey;
    const isCurrent = () => sequence.current === currentSequence && currentScope === scopeKey;
    if (!session?.scope) {
      setServices({ kind: 'error', message: 'The current Admin session scope is unavailable.' });
      setQueues({ kind: 'error', message: 'The current Admin session scope is unavailable.' });
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    setServices((prior) => prior.kind === 'ready' ? prior : { kind: 'loading' });
    setQueues((prior) => prior.kind === 'ready' ? prior : { kind: 'loading' });
    const query = tenantId ? { tenantId } : undefined;
    const [serviceResult, queueResult] = await Promise.allSettled([
      client.getServiceInventory(query),
      client.getQueueInventory(query),
    ]);
    if (!isCurrent()) return;
    if (serviceResult.status === 'rejected') setServices((prior) => prior.kind === 'ready' ? { ...prior, stale: true, problem: 'Service inventory refresh failed.' } : { kind: 'error', message: 'Service inventory refresh failed.' });
    else {
      const result = serviceResult.value;
      if (result.ok) setServices({ kind: 'ready', data: result.data, stale: result.data.freshness !== 'FRESH' });
      else {
        const problem = messageFor(result);
        setServices((prior) => prior.kind === 'ready' ? { ...prior, stale: true, problem } : { kind: 'error', message: problem });
      }
    }

    if (queueResult.status === 'rejected') setQueues((prior) => prior.kind === 'ready' ? { ...prior, stale: true, problem: 'Queue inventory refresh failed.' } : { kind: 'error', message: 'Queue inventory refresh failed.' });
    else {
      const result = queueResult.value;
      if (result.ok) setQueues({ kind: 'ready', data: result.data, stale: result.data.freshness !== 'FRESH' });
      else {
        const problem = messageFor(result);
        setQueues((prior) => prior.kind === 'ready' ? { ...prior, stale: true, problem } : { kind: 'error', message: problem });
      }
    }
    setRefreshing(false);
  }, [client, scopeKey, tenantId, session]);

  useLayoutEffect(() => {
    setServices({ kind: 'loading' }); setQueues({ kind: 'loading' });
    void load();
    return () => { sequence.current += 1; };
  }, [load]);

  if (!session) return <LoadingState title="Checking Admin session" description="Protected operations inventory is not read until the current session scope is known." />;
  if (!session.scope) return <ErrorState title="Operations scope unavailable" description="Sign in with an authorized tenant or platform scope to read these operational projections." />;

  return <section className="flex min-w-0 flex-col gap-5" aria-labelledby="operations-workspace-title">
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 id="operations-workspace-title" className="text-xl font-semibold">{sectionTitle(section)}</h1><Badge variant="neutral">{session.scope.kind === 'tenant' ? `Tenant ${session.scope.tenantId}` : tenantId ? `Tenant filter ${tenantId}` : 'Platform scope'}</Badge></div><p className="mt-1 max-w-3xl text-sm text-[var(--text-sub)]">Readings include the host source and sample freshness. Unknown or stale values remain visible as unknown; actions require a current server preview.</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" leftIcon={<RefreshCw className="size-3.5" />} isLoading={refreshing} onClick={() => void load()}>Refresh inventory</Button><Link className="rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--cf-blue)] underline" to="/system-operations">Operations cockpit</Link></div>
    </header>

    <OperationsNavigation active={section} />
    {!isPlatformAdmin(session) ? <AlertBanner variant="info" title="Read-only operations access">Operational maintenance, queue control and deployments are available to platform Admins only. This session can inspect only the scope authorized by its server session.</AlertBanner> : null}
    {services.kind === 'ready' && services.problem ? <AlertBanner variant="warning" title="Service inventory refresh failed">{services.problem} The last successful sample is still shown with its original freshness.</AlertBanner> : null}
    {queues.kind === 'ready' && queues.problem ? <AlertBanner variant="warning" title="Queue inventory refresh failed">{queues.problem} The last successful sample is still shown with its original freshness.</AlertBanner> : null}

    {section === 'services' ? <ServicesView state={services} params={params} setParams={setParams} /> : null}
    {section === 'workers-queues' ? <QueuesView key={scopeKey} state={queues} session={session} client={client} params={params} setParams={setParams} onRefresh={() => void load()} /> : null}
    {section === 'deployments' ? <DeploymentsView key={scopeKey} state={services} session={session} tenantId={tenantId} client={client} params={params} setParams={setParams} onRefresh={() => void load()} /> : null}
    {section === 'maintenance' ? <MaintenanceView key={scopeKey} session={session} tenantId={tenantId} client={client} params={params} setParams={setParams} /> : null}
  </section>;
}

function sectionTitle(section: OperationsSection): string {
  return section === 'workers-queues' ? 'Workers & Queues' : section === 'services' ? 'Services' : section === 'deployments' ? 'Deployments' : 'Maintenance';
}

function OperationsNavigation({ active }: { active: OperationsSection }) {
  const items: Array<[OperationsSection, string]> = [['services', 'Services'], ['workers-queues', 'Workers & Queues'], ['deployments', 'Deployments'], ['maintenance', 'Maintenance']];
  return <nav aria-label="Operations workspace" className="flex flex-wrap gap-2">{items.map(([key, label]) => <Link key={key} aria-current={key === active ? 'page' : undefined} to={`/system-operations/${key}`} className={`rounded-md border px-3 py-2 text-sm underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${key === active ? 'border-[var(--cf-blue)] bg-[var(--cf-blue-light)] font-semibold text-[var(--text-main)]' : 'border-[var(--border-subtle)] text-[var(--cf-blue)] underline'}`}>{label}</Link>)}</nav>;
}

function StateCard<T extends { sampledAt: string; source: string[]; freshness: string }>({ state, title, empty, children }: { state: AsyncState<T>; title: string; empty?: string; children: (data: T) => ReactNode }) {
  if (state.kind === 'loading') return <LoadingState title={`Loading ${title.toLowerCase()}`} description="Waiting for the source-backed Admin projection." />;
  if (state.kind === 'error') return <ErrorState title={`${title} unavailable`} description={state.message} />;
  if ('services' in state.data && Array.isArray(state.data.services) && state.data.services.length === 0) return <EmptyState title={`No ${title.toLowerCase()} returned`} description={empty ?? 'The source returned no rows. This sample does not establish that unreported resources exist or are healthy.'} />;
  return <div className="space-y-4">{state.stale ? <AlertBanner variant="warning" title="Showing a stale or partial sample">Last source sample: {formatTime(state.data.sampledAt)}. Current state remains unknown until refreshed.</AlertBanner> : null}{children(state.data)}</div>;
}

function SampleCaption<T extends { sampledAt: string; source: string[]; freshness: string }>({ state }: { state: AsyncState<T> }) {
  return <p className="text-xs text-[var(--text-sub)]" role="status">{freshnessLabel(state)}</p>;
}

function ServicesView({ state, params, setParams }: { state: AsyncState<ServiceInventory>; params: URLSearchParams; setParams: ReturnType<typeof useSearchParams>[1] }) {
  const query = params.get('search')?.trim().toLowerCase() ?? '';
  const serviceFilter = params.get('service');
  const replicaFilter = params.get('replica');
  return <StateCard state={state} title="Services" empty="No service rows were returned by this source sample.">{(inventory) => {
    const services = inventory.services.filter((service) => (!serviceFilter || service.serviceId === serviceFilter || service.kind === serviceFilter) && (!replicaFilter || service.replicas.some((item) => item.replicaId === replicaFilter)) && (!query || service.serviceId.toLowerCase().includes(query) || service.kind.includes(query) || service.dependencies.some((item) => item.dependencyId.toLowerCase().includes(query)) || service.replicas.some((item) => item.replicaId.toLowerCase().includes(query))));
    return <>
      <div className="flex flex-wrap items-center justify-between gap-2"><SampleCaption state={state} /><label className="text-sm">Search this inventory<input aria-label="Search services, dependencies and replicas" type="search" value={params.get('search') ?? ''} onChange={(event) => { const next = new URLSearchParams(params); next.delete('search'); if (event.target.value) next.set('search', event.target.value); void setParams(next); }} placeholder="Service, dependency, replica" className="ml-2 min-h-10 w-56 max-w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label></div>
      {serviceFilter || replicaFilter ? <div className="flex flex-wrap items-center gap-2 text-sm"><span>{replicaFilter ? <>Replica detail: <code>{replicaFilter}</code></> : <>Service detail: <code>{serviceFilter}</code></>}</span><Button size="sm" variant="outline" onClick={() => { const next = new URLSearchParams(params); next.delete('service'); next.delete('replica'); void setParams(next); }}>Show all services</Button></div> : null}
      {services.length === 0 ? <EmptyState title="No matching service rows" description="The query is applied to the returned inventory sample. Clear the search to see all sampled rows." /> : <div className="grid min-w-0 gap-4 xl:grid-cols-2">{services.map((service) => {
        const serviceHref = `/system-operations/services?service=${encodeURIComponent(service.serviceId)}`;
        return <Card key={service.serviceId} className="min-w-0">
          <CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><Server className="size-4 text-[var(--cf-blue)]" />{service.serviceId}<Badge variant="neutral">{service.kind}</Badge></CardTitle><CardDescription>Replicas and dependencies returned by the host inventory; absent replicas are not inferred.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><div className="flex flex-wrap items-center gap-2"><Badge variant={statusVariant(inventory.freshness)}>{inventory.freshness}</Badge><span className="text-xs text-[var(--text-sub)]">{inventory.source.join(', ')} · {formatTime(inventory.sampledAt)}</span></div>
            <div><h3 className="mb-2 text-sm font-semibold">Dependencies</h3>{service.dependencies.length ? <ul className="grid gap-2 sm:grid-cols-2">{service.dependencies.map((dep) => <li key={dep.dependencyId} className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="break-all text-sm">{dep.dependencyId}</strong><Badge variant={statusVariant(dep.state)}>{dep.state}</Badge></div><p className="mt-1 break-words text-xs text-[var(--text-sub)]">{dep.kind}{dep.detailCode ? ` · ${dep.detailCode}` : ''} · observed {formatTime(dep.observedAt)}</p></li>)}</ul> : <p className="text-sm text-[var(--text-sub)]">No dependency rows returned.</p>}</div>
            <div><h3 className="mb-2 text-sm font-semibold">Replicas ({service.replicas.length})</h3>{service.replicas.length ? <div className="grid gap-2">{service.replicas.map((replica) => <details key={replica.replicaId} open={params.get('replica') === replica.replicaId || params.get('service') === service.serviceId} className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3"><summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2"><span className="break-all font-mono text-sm">{replica.replicaId}</span><Badge variant={statusVariant(replica.state)}>{replica.state}</Badge></summary><dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2"><Metric label="Role" value={replica.role} /><Metric label="Business" value={replica.businessId ? `${replica.businessId}@${replica.businessVersion ?? 'unknown'}` : 'Platform'} /><Metric label="Desired revision" value={replica.desiredRevision ?? 'Unknown'} /><Metric label="Observed revision" value={replica.observedRevision ?? 'Unknown'} /><Metric label="Active work" value={numberOrUnknown(replica.activeWork)} /><Metric label="Control" value={replica.controlState ? `${replica.controlState} · rev ${replica.controlRevision ?? 'unknown'}` : 'Unknown'} /><Metric label="Last seen" value={formatTime(replica.lastSeenAt)} /></dl><Link className="mt-3 inline-flex text-sm text-[var(--cf-blue)] underline" to={`/system-operations/deployments?service=${encodeURIComponent(service.kind)}`}>Review deployment controls for {service.kind}</Link></details>)}</div> : <p className="text-sm text-[var(--text-sub)]">No replica rows returned; the source has not reported whether replicas exist.</p>}</div>
            <Link className="text-sm text-[var(--cf-blue)] underline" to={serviceHref}>Open this service detail</Link>
          </CardContent>
        </Card>;
      })}</div>}
    </>;
  }}</StateCard>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b border-[var(--border-subtle)] py-1"><dt className="text-xs text-[var(--text-sub)]">{label}</dt><dd className="break-words text-sm">{value}</dd></div>;
}

function QueuesView({ state, session, client, params, setParams, onRefresh }: { state: AsyncState<QueueInventory>; session: AdminWebSession; client: ReturnType<typeof createAdminApiClient>; params: URLSearchParams; setParams: ReturnType<typeof useSearchParams>[1]; onRefresh: () => void }) {
  const search = params.get('search')?.trim().toLowerCase() ?? '';
  const onlyQueue = params.get('queue');
  const queues = state.kind === 'ready' ? state.data.queues.filter((queue) => (!search || `${queue.queueName} ${queue.businessId} ${queue.businessVersion}`.toLowerCase().includes(search)) && (!onlyQueue || queue.queueName === onlyQueue)) : [];
  const [action, setAction] = useState<QueueAction>('pause');
  const [deliveryId, setDeliveryId] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<QueueActionPreview | null>(null);
  const [job, setJob] = useState<QueueActionJob | null>(null);
  const [jobRefreshProblem, setJobRefreshProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [selectedQueueKey, setSelectedQueueKey] = useState('');
  const writable = isPlatformAdmin(session);

  useEffect(() => { if (!selectedQueueKey && queues.length) setSelectedQueueKey(queueKey(queues[0]!)); }, [selectedQueueKey, queues]);
  useEffect(() => {
    if (!job || isTerminal(job.state)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void client.getQueueActionJob(job.jobId).then((result) => {
        if (!active) return;
        if (result.ok) { setJob(result.data); setJobRefreshProblem(null); }
        else setJobRefreshProblem(messageFor(result));
      }).catch(() => { if (active) setJobRefreshProblem('Queue action job status could not be refreshed. The displayed outcome is the last successful sample.'); });
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, job]);

  async function previewAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const requestAction = formData.get('action');
    const queueKeyFromForm = event.currentTarget.dataset.queueKey;
    const queue = state.kind === 'ready' ? state.data.queues.find((item) => queueKey(item) === queueKeyFromForm) : undefined;
    if (!queue) { setProblem('Select a queue from the current inventory before previewing an action.'); return; }
    if (typeof requestAction !== 'string' || !QUEUE_ACTIONS.includes(requestAction as QueueAction)) { setProblem('Choose a supported queue action.'); return; }
    const actionForQueue = requestAction as QueueAction;
    if (!writable) { setProblem('Queue control requires a platform Admin session.'); return; }
    if (reason.trim().length < 3) { setProblem('A reason with at least three characters is required.'); return; }
    if (actionForQueue === 'retry' && !deliveryId.trim()) { setProblem('Retry requires one exact delivery ID from an actual failed delivery record.'); return; }
    setBusy(true); setProblem(null); setPreview(null); setJob(null); setJobRefreshProblem(null);
    try {
      const body: QueueActionPreviewRequest = { queueName: queue.queueName, action: actionForQueue, scope: { kind: 'business', businessId: queue.businessId, businessVersion: queue.businessVersion }, ...(actionForQueue === 'retry' ? { deliveryId: deliveryId.trim() } : {}), reason: reason.trim() };
      setSelectedQueueKey(queueKey(queue)); setAction(actionForQueue);
      const result = await client.previewQueueAction(body);
      if (!result.ok) setProblem(messageFor(result)); else setPreview(result.data);
    } catch { setProblem('Queue action preview request failed. No queue state was changed.'); }
    finally { setBusy(false); }
  }

  async function confirmAction() {
    if (!preview || !writable) return;
    setBusy(true); setProblem(null);
    try {
      const result = await client.executeQueueAction({ previewId: preview.previewId, expectedRevision: preview.controlRevision, idempotencyKey: makeIdempotencyKey(), reason: reason.trim() });
      if (!result.ok) setProblem(messageFor(result)); else { setJob(result.data); setJobRefreshProblem(null); setPreview(null); onRefresh(); }
    } catch { setProblem('Queue action request failed. Check durable outcomes before retrying with a new preview.'); }
    finally { setBusy(false); }
  }

  return <StateCard state={state} title="Workers and queues" empty="No queues were returned by this source sample.">{(inventory) => <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><SampleCaption state={state} /><label className="text-sm">Search queues<input aria-label="Search queue inventory" type="search" value={params.get('search') ?? ''} onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) next.set('search', event.target.value); else next.delete('search'); void setParams(next); }} placeholder="Queue, business or version" className="ml-2 min-h-10 w-56 max-w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label></div>
    {onlyQueue ? <div className="flex items-center gap-2 text-sm"><span>Deep link filter: <code>{onlyQueue}</code></span><Button size="sm" variant="outline" onClick={() => { const next = new URLSearchParams(params); next.delete('queue'); void setParams(next); }}>Show all queues</Button></div> : null}
    {queues.length === 0 ? <EmptyState title="No matching queues" description="No queue in the current host sample matches this filter. It is not evidence that other queue systems are healthy." /> : <div className="grid min-w-0 gap-4 xl:grid-cols-2">{queues.map((queue) => { const key = queueKey(queue); const queueAction = selectedQueueKey === key ? action : 'pause'; return <Card key={key} className="min-w-0"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><Boxes className="size-4 text-[var(--cf-blue)]" />{queue.queueName}<Badge variant={statusVariant(queue.admission.state)}>{queue.admission.state}</Badge></CardTitle><CardDescription>{queue.businessId}@{queue.businessVersion} · sampled {formatTime(inventory.sampledAt)}</CardDescription></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2"><Metric label="Waiting / delayed" value={`${numberOrUnknown(queue.counts.waiting)} / ${numberOrUnknown(queue.counts.delayed)}`} /><Metric label="Active / failed" value={`${numberOrUnknown(queue.counts.active)} / ${numberOrUnknown(queue.counts.failed)}`} /><Metric label="Oldest runnable age" value={queue.oldestRunnableAgeMs === null ? 'Unknown' : `${Math.floor(queue.oldestRunnableAgeMs / 1000).toLocaleString()}s`} /><Metric label="Active leases" value={queue.admission.activeLeases.toLocaleString()} /></div>
      <div className="flex flex-wrap gap-2 text-xs"><Badge variant="neutral">worker compatible {queue.workerCompatibility.compatibleOnline}</Badge><Badge variant="neutral">draining {queue.workerCompatibility.compatibleDraining}</Badge><Badge variant={queue.workerCompatibility.incompatible ? 'warning' : 'neutral'}>incompatible {queue.workerCompatibility.incompatible}</Badge><Badge variant="neutral">offline {queue.workerCompatibility.offline}</Badge></div>
      <p className="text-xs text-[var(--text-sub)]">Admission revision {queue.admission.revision} · ACK {queue.admission.observedAcks}/{queue.admission.expectedAcks} · workers {queue.admission.freshHeartbeats}</p>
      <details open={selectedQueueKey === key && params.get('queue') === queue.queueName} className="rounded-md border border-[var(--border-subtle)] p-3"><summary className="cursor-pointer font-semibold">Preview queue action</summary>
        <form className="mt-3 space-y-3" data-queue-key={key} onSubmit={(event) => void previewAction(event)}>
          <label className="block text-sm">Action<select name="action" value={queueAction} onChange={(event) => { setSelectedQueueKey(key); setAction(event.target.value as QueueAction); setPreview(null); setProblem(null); }} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3">{QUEUE_ACTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          {queueAction === 'retry' ? <label className="block text-sm">Exact failed delivery ID<input required value={deliveryId} maxLength={256} onChange={(event) => setDeliveryId(event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /><span className="text-xs text-[var(--text-sub)]">One delivery only. The host verifies that it belongs to this queue and is eligible.</span></label> : null}
          <label className="block text-sm">Reason<textarea required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" rows={2} /></label>
          <Button size="sm" type="submit" isLoading={busy} disabled={!writable}>Preview {queueAction}</Button>
        </form>
        {preview && preview.queueName === queue.queueName && preview.scope.kind === 'business' && preview.scope.businessId === queue.businessId && preview.scope.businessVersion === queue.businessVersion ? <div className="mt-4 space-y-3 rounded-md border border-[var(--border-subtle)] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{preview.action} preview · {scopeName(preview.scope)}</strong><Badge variant="warning">Expires {formatTime(preview.expiresAt)}</Badge></div><dl className="grid gap-2 text-sm sm:grid-cols-2"><Metric label="Control revision" value={String(preview.controlRevision)} /><Metric label="Active leases" value={String(preview.activeLeases)} /><Metric label="Fresh workers" value={String(preview.freshWorkers)} /><Metric label="Expected / observed ACKs" value={`${preview.expectedAcks}/${preview.observedAcks}`} /><Metric label="Eligible deliveries" value={String(preview.eligibleDeliveries)} /><Metric label="Skipped / unknown" value={`${preview.skippedDeliveries}/${preview.unknownDeliveries}`} /></dl>{preview.warnings.length ? <AlertBanner variant="warning" title="Host preview warnings">{preview.warnings.join(', ')}</AlertBanner> : null}<Button size="sm" variant="destructive" isLoading={busy} disabled={!writable || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void confirmAction()}>Confirm {preview.action}</Button></div> : null}
        {problem ? <p className="mt-3 text-sm text-[var(--badge-danger-text)]" role="alert">{problem}</p> : null}
      </details>
    </CardContent></Card>;})}</div>}
    {job ? <>{jobRefreshProblem ? <AlertBanner variant="warning" title="Queue job status is stale">{jobRefreshProblem}</AlertBanner> : null}<QueueActionResult job={job} /></> : null}
  </div>}</StateCard>;
}

function QueueActionResult({ job }: { job: QueueActionJob }) {
  return <Card aria-live="polite"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2">Queue action job <code>{job.jobId}</code><Badge variant={statusVariant(job.state)}>{job.state}</Badge></CardTitle><CardDescription>{job.action} · {job.queueName} · updated {formatTime(job.updatedAt)}</CardDescription></CardHeader><CardContent className="space-y-3"><p className="text-sm">Durable outcome: {job.eligibleDeliveries} eligible · {job.skippedDeliveries} skipped · {job.unknownDeliveries} unknown. ACKs {job.observedAcks}/{job.expectedAcks}; active leases {job.activeLeases}; fresh workers {job.freshWorkers}.</p>{job.lastErrorCode ? <AlertBanner variant="warning" title="Host reported an outcome code">{job.lastErrorCode}</AlertBanner> : null}{job.state === 'PARTIAL' && job.action === 'drain' ? <AlertBanner variant="warning" title="Queue remains draining">A timed-out drain stays in DRAINING. Review active work, then issue an explicit previewed resume when appropriate.</AlertBanner> : null}</CardContent></Card>;
}

function DeploymentsView({ state, session, tenantId, client, params, setParams, onRefresh }: { state: AsyncState<ServiceInventory>; session: AdminWebSession; tenantId?: string; client: ReturnType<typeof createAdminApiClient>; params: URLSearchParams; setParams: ReturnType<typeof useSearchParams>[1]; onRefresh: () => void }) {
  const services = state.kind === 'ready' ? state.data.services : [];
  const deploymentFilter = params.get('deployment');
  const replicaFilter = params.get('replica');
  const visibleServices = services.filter((item) => (!deploymentFilter || item.serviceId === deploymentFilter || item.kind === deploymentFilter || item.replicas.some((replica) => replica.replicaId === deploymentFilter)) && (!replicaFilter || item.replicas.some((replica) => replica.replicaId === replicaFilter)));
  const [service, setService] = useState<'orchestrator' | 'connector' | 'worker'>('worker');
  const [revision, setRevision] = useState('');
  const [strategy, setStrategy] = useState<'two_slot' | 'per_replica'>('two_slot');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ReplicaRolloutPreview | null>(null);
  const [job, setJob] = useState<ReplicaRolloutJob | null>(null);
  const [jobRefreshProblem, setJobRefreshProblem] = useState<string | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<ReplicaRollbackPreview | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const writable = isPlatformAdmin(session);

  useEffect(() => { const fromUrl = params.get('service'); if (fromUrl === 'orchestrator' || fromUrl === 'connector' || fromUrl === 'worker') setService(fromUrl); }, [params]);
  useEffect(() => {
    if (!job || isTerminal(job.state)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void client.getReplicaRolloutJob(job.jobId).then((result) => {
        if (!active) return;
        if (result.ok) { setJob(result.data); setJobRefreshProblem(null); }
        else setJobRefreshProblem(messageFor(result));
      }).catch(() => { if (active) setJobRefreshProblem('Rollout job status could not be refreshed. The displayed outcome is the last successful sample.'); });
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, job]);

  const serviceInventory = services.find((item) => item.kind === service);
  const defaultRevision = serviceInventory?.replicas.find((item) => item.desiredRevision)?.desiredRevision ?? '';
  useEffect(() => { if (!revision && defaultRevision) setRevision(defaultRevision); }, [defaultRevision, revision]);

  async function previewRollout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writable) { setProblem('Deployment controls require a platform Admin session.'); return; }
    if (revision.trim().length < 1 || reason.trim().length < 3) { setProblem('Choose a target revision and enter a reason.'); return; }
    setBusy(true); setProblem(null); setPreview(null); setRollbackPreview(null); setJob(null); setJobRefreshProblem(null);
    try {
      const request: ReplicaRolloutPreviewRequest = { service, desiredRevision: revision.trim(), scope: selectedScope(session, tenantId), strategy, reason: reason.trim() };
      const result = await client.previewReplicaRollout(request);
      if (!result.ok) setProblem(messageFor(result)); else setPreview(result.data);
    } catch { setProblem('Deployment preview request failed. No replica was changed.'); }
    finally { setBusy(false); }
  }

  async function executeRollout() {
    if (!preview || !writable) return;
    setBusy(true); setProblem(null);
    try {
      const request: ExecuteReplicaRollout = { previewId: preview.previewId, expectedVersion: preview.expectedVersion, idempotencyKey: makeIdempotencyKey(), reason: reason.trim() };
      const result = await client.executeReplicaRollout(request);
      if (!result.ok) setProblem(messageFor(result)); else { setJob(result.data); setJobRefreshProblem(null); setPreview(null); const next = new URLSearchParams(params); next.set('job', result.data.jobId); void setParams(next); onRefresh(); }
    } catch { setProblem('Rollout request failed. Inspect the durable job state before submitting again.'); }
    finally { setBusy(false); }
  }

  async function previewRollback() {
    if (!job || !writable) { setProblem('Rollback requires a platform Admin session and a loaded rollout job.'); return; }
    if (rollbackReason.trim().length < 3) { setProblem('Enter a rollback reason with at least three characters.'); return; }
    setBusy(true); setProblem(null); setRollbackPreview(null);
    try {
      const result = await client.previewReplicaRollback(job.jobId, { reason: rollbackReason.trim() });
      if (!result.ok) setProblem(messageFor(result)); else setRollbackPreview(result.data);
    } catch { setProblem('Rollback preview failed; no ingress target changed.'); }
    finally { setBusy(false); }
  }

  async function executeRollback() {
    if (!job || !rollbackPreview || !writable) return;
    setBusy(true); setProblem(null);
    try {
      const request: ExecuteReplicaRollback = {
        previewId: rollbackPreview.previewId,
        expectedVersion: rollbackPreview.expectedVersion,
        idempotencyKey: makeIdempotencyKey(),
        reason: rollbackReason.trim(),
      };
      const result = await client.executeReplicaRollback(job.jobId, request);
      if (!result.ok) setProblem(messageFor(result)); else {
        setJob(result.data); setJobRefreshProblem(null); setRollbackPreview(null);
        const next = new URLSearchParams(params); next.set('job', result.data.jobId); void setParams(next);
        onRefresh();
      }
    } catch { setProblem('Rollback request failed. Inspect the durable job state before submitting again.'); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    const jobId = params.get('job');
    if (!jobId || job?.jobId === jobId) return;
    let active = true;
    void client.getReplicaRolloutJob(jobId).then((result) => { if (active && result.ok) setJob(result.data); else if (active && !result.ok) setProblem(messageFor(result)); }).catch(() => { if (active) setProblem('Deployment job could not be read.'); });
    return () => { active = false; };
  }, [client, job?.jobId, params]);

  return <div className="space-y-4"><SampleCaption state={state} />
    {state.kind === 'loading' ? <LoadingState title="Loading service revisions" description="A rollout preview needs the current host service inventory." /> : null}
    {state.kind === 'error' ? <ErrorState title="Deployment inventory unavailable" description={state.message} /> : null}
    {state.kind === 'ready' && !serviceInventory ? <EmptyState title={`No ${service} inventory returned`} description="The host has not reported replicas or revisions for this service." /> : null}
    <Card><CardHeader><CardTitle>Preview a replica rollout</CardTitle><CardDescription>The preview pins a revision and expected inventory version. Execution creates a durable per-replica job with observed state and rollback status.</CardDescription></CardHeader><CardContent><form onSubmit={(event) => void previewRollout(event)} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="text-sm">Service<select value={service} onChange={(event) => { setService(event.target.value as typeof service); setRevision(''); setPreview(null); const next = new URLSearchParams(params); next.set('service', event.target.value); void setParams(next); }} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3"><option value="orchestrator">Orchestrator</option><option value="connector">Connector</option><option value="worker">Worker</option></select></label>
      <label className="text-sm">Desired revision<input required value={revision} maxLength={256} onChange={(event) => setRevision(event.target.value)} placeholder={defaultRevision || 'enter a real image or revision reference'} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /><span className="text-xs text-[var(--text-sub)]">Current desired revision: {defaultRevision || 'Unknown'}.</span></label>
      <label className="text-sm">Strategy<select value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3"><option value="two_slot">Two slot</option><option value="per_replica">Per replica</option></select></label>
      <label className="text-sm sm:col-span-2 xl:col-span-1">Reason<textarea required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" rows={2} /></label>
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-4"><Button type="submit" isLoading={busy} disabled={!writable || state.kind !== 'ready'}>Preview rollout</Button>{state.kind === 'ready' ? <span className="text-xs text-[var(--text-sub)]">{state.data.freshness} · {state.data.source.join(', ')} · sampled {formatTime(state.data.sampledAt)}</span> : null}</div>
    </form>
    {preview ? <div className="mt-4 space-y-3 rounded-md border border-[var(--border-subtle)] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong>Rollout preview · {preview.service} → {preview.desiredRevision}</strong><Badge variant="warning">Expires {formatTime(preview.expiresAt)}</Badge></div><p className="text-sm">{preview.currentReplicas} current replicas · minimum ready {preview.minimumReadyReplicas} · ingress switch {preview.requiresIngressSwitch ? 'required' : 'not required'} · scope {scopeName(preview.scope)}</p>{preview.warnings.length ? <AlertBanner variant="warning" title="Host preview warnings">{preview.warnings.join(', ')}</AlertBanner> : null}<Button size="sm" variant="destructive" isLoading={busy} disabled={!writable || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void executeRollout()}>Execute rollout</Button></div> : null}
    {problem ? <p role="alert" className="mt-3 text-sm text-[var(--badge-danger-text)]">{problem}</p> : null}
    </CardContent></Card>
    {job ? <>{jobRefreshProblem ? <AlertBanner variant="warning" title="Rollout job status is stale">{jobRefreshProblem}</AlertBanner> : null}<ReplicaRolloutResult job={job} rollbackReason={rollbackReason} setRollbackReason={setRollbackReason} preview={rollbackPreview?.jobId === job.jobId ? rollbackPreview : null} busy={busy} writable={writable} problem={problem} onPreview={() => void previewRollback()} onExecute={() => void executeRollback()} /></> : null}
    {state.kind === 'ready' ? <Card><CardHeader><CardTitle>Current per-replica state</CardTitle><CardDescription>{deploymentFilter || replicaFilter ? `Filtered to the linked object · ` : ''}{state.data.freshness} · sampled {formatTime(state.data.sampledAt)} · desired and observed revisions remain separate values.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">{visibleServices.map((item) => <div key={item.serviceId} className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3"><h3 className="font-semibold">{item.serviceId}</h3><ul className="mt-2 space-y-2">{item.replicas.filter((replica) => !replicaFilter || replica.replicaId === replicaFilter).map((replica) => <li key={replica.replicaId} className="break-words border-t border-[var(--border-subtle)] pt-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><code>{replica.replicaId}</code><Badge variant={statusVariant(replica.state)}>{replica.state}</Badge></div><p className="text-xs text-[var(--text-sub)]">Desired {replica.desiredRevision ?? 'Unknown'} · Observed {replica.observedRevision ?? 'Unknown'} · active work {numberOrUnknown(replica.activeWork)}</p></li>)}</ul></div>)}{visibleServices.length === 0 ? <EmptyState title="Linked deployment object not in current sample" description="The host inventory has not returned a matching deployment or replica. This does not imply that the deployment is absent or healthy." /> : null}</CardContent></Card> : null}
  </div>;
}

function ReplicaRolloutResult({ job, rollbackReason, setRollbackReason, preview, busy, writable, problem, onPreview, onExecute }: { job: ReplicaRolloutJob; rollbackReason: string; setRollbackReason: (reason: string) => void; preview: ReplicaRollbackPreview | null; busy: boolean; writable: boolean; problem: string | null; onPreview: () => void; onExecute: () => void }) {
  return <Card aria-live="polite"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2">Rollout job <code>{job.jobId}</code><Badge variant={statusVariant(job.state)}>{job.state}</Badge></CardTitle><CardDescription>{job.service} → {job.desiredRevision} · updated {formatTime(job.updatedAt)} · rollback {job.rollbackState}</CardDescription></CardHeader><CardContent className="space-y-3"><div className="grid gap-2 sm:grid-cols-2"><Metric label="Previous ingress" value={job.oldIngressTarget ?? 'Unknown'} /><Metric label="Active ingress" value={job.activeIngressTarget ?? 'Unknown'} /><Metric label="Last error code" value={job.lastErrorCode ?? 'None reported'} /></div><ul className="grid gap-2 md:grid-cols-2">{job.replicas.map((replica) => <li key={replica.replicaId} className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><code className="break-all">{replica.replicaId}</code><Badge variant={statusVariant(replica.state)}>{replica.state}</Badge></div><p className="mt-2 break-words text-xs text-[var(--text-sub)]">Desired {replica.desiredRevision} · Observed {replica.observedRevision ?? 'Unknown'} · slot {replica.slot ?? 'Unknown'} · active work {numberOrUnknown(replica.activeWork)}</p><p className="text-xs text-[var(--text-sub)]">Acknowledged {formatTime(replica.acknowledgedAt)}{replica.code ? ` · ${replica.code}` : ''}</p></li>)}</ul>
    <div className="rounded-md border border-[var(--border-subtle)] p-3"><h3 className="font-semibold">Preview operator rollback</h3><p className="text-xs text-[var(--text-sub)]">Rollback requires a fresh host preview, the current job version, an idempotency key, and a reason. Unknown ingress state remains ineligible.</p><label className="mt-2 block text-sm">Rollback reason<textarea minLength={3} maxLength={500} value={rollbackReason} onChange={(event) => setRollbackReason(event.target.value)} rows={2} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" /></label><Button size="sm" className="mt-2" variant="outline" isLoading={busy} disabled={!writable} onClick={onPreview}>Preview rollback</Button>
      {preview ? <div className="mt-3 space-y-2 rounded border border-[var(--border-subtle)] p-3"><p className="text-sm">Target ingress: <code>{preview.targetIngress ?? 'Unknown'}</code> · current version: {preview.expectedVersion.slice(0, 12)}</p><p className="text-xs">Previous {preview.oldIngressTarget ?? 'Unknown'} · active {preview.activeIngressTarget ?? 'Unknown'} · eligible {preview.eligible ? 'yes' : 'no'} · expires {formatTime(preview.expiresAt)}</p>{preview.warnings.length ? <AlertBanner variant="warning" title="Rollback preview warnings">{preview.warnings.join(', ')}</AlertBanner> : null}<Button size="sm" variant="destructive" isLoading={busy} disabled={!writable || !preview.eligible || Date.parse(preview.expiresAt) <= Date.now()} onClick={onExecute}>Confirm rollback</Button></div> : null}
      {problem ? <p role="alert" className="mt-2 text-sm text-[var(--badge-danger-text)]">{problem}</p> : null}</div>
    </CardContent></Card>;
}

function MaintenanceView({ session, tenantId, client, params, setParams }: { session: AdminWebSession; tenantId?: string; client: ReturnType<typeof createAdminApiClient>; params: URLSearchParams; setParams: ReturnType<typeof useSearchParams>[1] }) {
  const [kind, setKind] = useState<MaintenanceKind>('retention_cleanup');
  const [scopeKind, setScopeKind] = useState<'platform' | 'tenant' | 'business'>(session.scope?.kind === 'tenant' ? 'tenant' : 'platform');
  const [businessId, setBusinessId] = useState('');
  const [businessVersion, setBusinessVersion] = useState('');
  const [olderThan, setOlderThan] = useState('');
  const [backupId, setBackupId] = useState('');
  const [backupTarget, setBackupTarget] = useState('');
  const [targetGenerationId, setTargetGenerationId] = useState('');
  const [maxItems, setMaxItems] = useState('100');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [job, setJob] = useState<MaintenanceJob | null>(null);
  const [jobRefreshProblem, setJobRefreshProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const writable = isPlatformAdmin(session);
  const scope = scopeKind === 'platform' ? { kind: 'platform' as const }
    : scopeKind === 'tenant' ? (session.scope?.kind === 'tenant' ? { kind: 'tenant' as const, tenantId: session.scope.tenantId } : tenantId ? { kind: 'tenant' as const, tenantId } : null)
      : businessId.trim() && businessVersion.trim() ? { kind: 'business' as const, businessId: businessId.trim(), businessVersion: businessVersion.trim() } : null;

  useEffect(() => {
    if (!job || isTerminal(job.state)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void client.getMaintenanceJob(job.jobId).then((result) => {
        if (!active) return;
        if (result.ok) { setJob(result.data); setJobRefreshProblem(null); }
        else setJobRefreshProblem(messageFor(result));
      }).catch(() => { if (active) setJobRefreshProblem('Maintenance job status could not be refreshed. The displayed outcomes are the last successful sample.'); });
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, job]);

  useEffect(() => {
    const jobId = params.get('job');
    if (!jobId || job?.jobId === jobId) return;
    let active = true;
    void client.getMaintenanceJob(jobId).then((result) => { if (active && result.ok) setJob(result.data); else if (active && !result.ok) setProblem(messageFor(result)); }).catch(() => { if (active) setProblem('Maintenance job could not be read.'); });
    return () => { active = false; };
  }, [client, job?.jobId, params]);

  async function previewMaintenance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writable) { setProblem('Maintenance jobs require a platform Admin session.'); return; }
    if (!scope) { setProblem('Choose a valid authorized scope.'); return; }
    if (reason.trim().length < 3) { setProblem('A reason with at least three characters is required.'); return; }
    const max = Number(maxItems);
    if (!Number.isSafeInteger(max) || max < 1 || max > 500) { setProblem('Maximum items must be between 1 and 500.'); return; }
    setBusy(true); setProblem(null); setPreview(null); setJob(null); setJobRefreshProblem(null);
    try {
      const filters: MaintenancePreviewRequest['filters'] = { maxItems: max };
      if (olderThan) { const date = new Date(olderThan); if (!Number.isFinite(date.getTime())) { setProblem('Choose a valid older-than timestamp.'); setBusy(false); return; } filters.olderThan = date.toISOString(); }
      if (kind === 'backup') { if (!backupTarget.trim()) { setProblem('Choose an approved named backup target.'); setBusy(false); return; } filters.backupTarget = backupTarget.trim(); }
      if (kind === 'restore') { if (!backupId.trim() || !targetGenerationId.trim()) { setProblem('Restore needs a named approved backup and a new isolated target generation.'); setBusy(false); return; } filters.backupId = backupId.trim(); filters.targetGenerationId = targetGenerationId.trim(); }
      const request: MaintenancePreviewRequest = { kind, scope, filters, reason: reason.trim() };
      const result = await client.previewMaintenance(request);
      if (!result.ok) setProblem(messageFor(result)); else setPreview(result.data);
    } catch { setProblem('Maintenance preview request failed. No maintenance job was created.'); }
    finally { setBusy(false); }
  }

  async function startJob() {
    if (!preview || !writable) return;
    setBusy(true); setProblem(null);
    try {
      const result = await client.startMaintenanceJob({ previewId: preview.previewId, expectedVersion: preview.expectedVersion, idempotencyKey: makeIdempotencyKey(), reason: reason.trim() });
      if (!result.ok) setProblem(messageFor(result)); else { setJob(result.data); setJobRefreshProblem(null); setPreview(null); const next = new URLSearchParams(params); next.set('job', result.data.jobId); void setParams(next); }
    } catch { setProblem('Maintenance job request failed. Check the durable job result before creating another preview.'); }
    finally { setBusy(false); }
  }

  return <div className="space-y-4"><Card><CardHeader><CardTitle className="flex items-center gap-2"><Wrench className="size-4 text-[var(--cf-blue)]" />Preview maintenance job</CardTitle><CardDescription>Cleanup, reconciliation, backup, and restore actions stay preview-first and produce durable per-item results. Restore is accepted only when the host verifies an approved bundle and a new isolated generation.</CardDescription></CardHeader><CardContent><form onSubmit={(event) => void previewMaintenance(event)} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="text-sm">Job type<select value={kind} onChange={(event) => { setKind(event.target.value as MaintenanceKind); setPreview(null); }} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3">{MAINTENANCE_KINDS.map((item) => <option value={item} key={item}>{item.replaceAll('_', ' ')}</option>)}</select></label>
      {kind === 'backup' ? <label className="text-sm">Approved backup target<input required value={backupTarget} onChange={(event) => setBackupTarget(event.target.value)} maxLength={256} placeholder="named target from host configuration" className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /><span className="text-xs text-[var(--text-sub)]">The host must validate this allowlisted target before creating a preview.</span></label> : null}
      <label className="text-sm">Scope<select value={scopeKind} disabled={session.scope?.kind === 'tenant'} onChange={(event) => setScopeKind(event.target.value as typeof scopeKind)} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3"><option value="platform" disabled={!writable}>Platform</option><option value="tenant">Tenant</option><option value="business">Business</option></select></label>
      {scopeKind === 'tenant' ? <label className="text-sm">Tenant<input readOnly value={session.scope?.kind === 'tenant' ? session.scope.tenantId : tenantId ?? ''} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3" /></label> : null}
      {scopeKind === 'business' ? <><label className="text-sm">Business ID<input required value={businessId} onChange={(event) => setBusinessId(event.target.value)} maxLength={256} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label><label className="text-sm">Business version<input required value={businessVersion} onChange={(event) => setBusinessVersion(event.target.value)} maxLength={256} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label></> : null}
      {kind === 'restore' ? <><label className="text-sm">Approved backup ID<input required value={backupId} onChange={(event) => setBackupId(event.target.value)} maxLength={256} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label><label className="text-sm">New isolated target generation<input required value={targetGenerationId} onChange={(event) => setTargetGenerationId(event.target.value)} maxLength={256} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label></> : null}
      <label className="text-sm">Older than (optional)<input type="datetime-local" value={olderThan} onChange={(event) => setOlderThan(event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label>
      <label className="text-sm">Maximum items<input type="number" min={1} max={500} value={maxItems} onChange={(event) => setMaxItems(event.target.value)} className="mt-1 min-h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3" /></label>
      <label className="text-sm sm:col-span-2">Reason<textarea required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" rows={2} /></label>
      <div className="flex flex-wrap items-end gap-2"><Button type="submit" isLoading={busy} disabled={!writable || !scope}>Preview targets</Button>{kind === 'restore' ? <span className="max-w-xs text-xs text-[var(--text-sub)]">The isolated destination is checked by the host before preview or execution.</span> : null}</div>
    </form>
    {problem ? <p role="alert" className="mt-3 text-sm text-[var(--badge-danger-text)]">{problem}</p> : null}
    {preview ? <div className="mt-4 space-y-3 rounded-md border border-[var(--border-subtle)] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{preview.kind.replaceAll('_', ' ')} preview · {scopeName(preview.scope)}</strong><Badge variant="warning">Expires {formatTime(preview.expiresAt)}</Badge></div><dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Candidates" value={String(preview.candidateCount)} /><Metric label="Eligible" value={String(preview.eligibleCount)} /><Metric label="Skipped / unknown" value={`${preview.skippedCount} / ${preview.unknownCount}`} /><Metric label="Estimated bytes" value={preview.estimatedBytes === null ? 'Unknown' : preview.estimatedBytes.toLocaleString()} /><Metric label="Retention revision" value={preview.retentionRevision === null ? 'Unknown' : String(preview.retentionRevision)} /><Metric label="Expected version" value={preview.expectedVersion.slice(0, 12)} /></dl><div className="max-h-72 overflow-auto rounded-md border border-[var(--border-subtle)]" role="region" aria-label="Maintenance preview targets" tabIndex={0}><table className="w-full min-w-[600px] text-left text-sm"><thead><tr className="border-b border-[var(--border-subtle)]"><th className="px-3 py-2">Target</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Eligibility</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Bytes</th></tr></thead><tbody>{preview.targets.map((target) => <tr key={target.itemId} className="border-b border-[var(--border-subtle)]"><td className="break-all px-3 py-2 font-mono text-xs">{target.itemId}</td><td className="px-3 py-2">{target.itemType}</td><td className="px-3 py-2"><Badge variant={statusVariant(target.eligibility)}>{target.eligibility}</Badge></td><td className="px-3 py-2">{target.reasonCode ?? '—'}</td><td className="px-3 py-2">{target.estimatedBytes === null ? 'Unknown' : target.estimatedBytes.toLocaleString()}</td></tr>)}</tbody></table></div><Button size="sm" variant="destructive" isLoading={busy} disabled={!writable || Date.parse(preview.expiresAt) <= Date.now() || preview.eligibleCount === 0} onClick={() => void startJob()}>Create durable {preview.kind.replaceAll('_', ' ')} job</Button></div> : null}
    </CardContent></Card>
        {job ? <>{jobRefreshProblem ? <AlertBanner variant="warning" title="Maintenance job status is stale">{jobRefreshProblem}</AlertBanner> : null}<MaintenanceJobResult job={job} /></> : null}
  </div>;
}

function MaintenanceJobResult({ job }: { job: MaintenanceJob }) {
  return <Card aria-live="polite"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2">Maintenance job <code>{job.jobId}</code><Badge variant={statusVariant(job.state)}>{job.state}</Badge></CardTitle><CardDescription>{job.kind.replaceAll('_', ' ')} · {scopeName(job.scope)} · updated {formatTime(job.updatedAt)}</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Completed / total" value={`${job.completedItems}/${job.totalItems}`} /><Metric label="Applied" value={String(job.appliedItems)} /><Metric label="Skipped / failed / unknown" value={`${job.skippedItems} / ${job.failedItems} / ${job.unknownItems}`} /><Metric label="Last error code" value={job.lastErrorCode ?? 'None reported'} /></div><div className="overflow-x-auto rounded-md border border-[var(--border-subtle)]" role="region" aria-label="Maintenance per-item outcomes" tabIndex={0}><table className="w-full min-w-[640px] text-left text-sm"><thead><tr className="border-b border-[var(--border-subtle)]"><th className="px-3 py-2">Item</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Outcome</th><th className="px-3 py-2">Evidence / code</th><th className="px-3 py-2">Updated</th></tr></thead><tbody>{job.items.map((item) => <tr key={item.itemId} className="border-b border-[var(--border-subtle)] align-top"><td className="break-all px-3 py-2 font-mono text-xs">{item.itemId}</td><td className="px-3 py-2">{item.itemType}</td><td className="px-3 py-2"><Badge variant={statusVariant(item.status)}>{item.status}</Badge></td><td className="max-w-80 break-words px-3 py-2 text-xs">{(item.code ?? Object.entries(item.evidence).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')) || 'No evidence returned'}</td><td className="px-3 py-2">{formatTime(item.updatedAt)}</td></tr>)}</tbody></table></div></CardContent></Card>;
}
