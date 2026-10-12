import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertTriangle, ArrowLeft, RefreshCw, Search, ShieldAlert, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/ui/dialog';
import { AlertBanner, DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { createAdminApiClient, type AdminWebSession } from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import { canReadIncidentLedger, isLocalUserSession } from './state';
import type {
  Incident,
  IncidentAcknowledgeRequest,
  IncidentAssignRequest,
  IncidentDetail,
  IncidentListPage,
  IncidentListQuery,
  IncidentResolveRequest,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
  MaintenanceSuppression,
  MaintenanceSuppressionCreate,
  MaintenanceSuppressionList,
} from '@du/contracts';

type AssignableIdentityPage = { items: Array<{ id: string; username: string; role: 'ADMIN' | 'USER'; tenantId: string; enabled: boolean }>; nextCursor?: string | null };
type AssignableIdentityUser = AssignableIdentityPage['items'][number];

type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: T; sampledAt: string; stale: boolean; problem?: string };

const STATUS_OPTIONS: Array<IncidentStatus | ''> = ['', 'open', 'acknowledged', 'resolved'];
const SEVERITY_OPTIONS: Array<IncidentSeverity | ''> = ['', 'critical', 'high', 'medium', 'low'];
const SOURCE_OPTIONS: Array<IncidentSource | ''> = ['', 'runtime', 'queue', 'connector', 'provider', 'delivery', 'deployment', 'maintenance'];

function problemMessage(result: { status: number; problem: { code?: string; title?: string } }): string {
  const title = result.problem.title && result.problem.title.length < 180 ? ` · ${result.problem.title}` : '';
  return `HTTP ${result.status}${result.problem.code ? ` · ${result.problem.code}` : ''}${title}`;
}

function severityVariant(severity: IncidentSeverity): 'danger' | 'warning' | 'info' | 'neutral' {
  if (severity === 'critical' || severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  return 'info';
}

function statusVariant(status: IncidentStatus): 'danger' | 'warning' | 'success' {
  if (status === 'open') return 'danger';
  if (status === 'acknowledged') return 'warning';
  return 'success';
}

function formatTime(value: string): string {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toLocaleString() : 'Time unavailable';
}

function selectionScope(session: AdminWebSession | null, selectedTenantId: string | null): string {
  if (!session) return 'session-loading';
  const principal = `${session.role}:${session.plane}:${session.localUser ? 'local-user' : 'admin-session'}:${session.displayName}`;
  if (session.scope?.kind === 'tenant') return `${principal}:tenant:${session.scope.tenantId}`;
  return `${principal}:platform:${selectedTenantId ?? 'all'}`;
}

function canAct(session: AdminWebSession | null): boolean {
  return !isLocalUserSession(session) && (session?.role === 'admin'
    || (session?.role === 'operator' && session.principal.kind === 'tenant_operator' && session.scope?.kind === 'tenant'));
}

function operationHref(id: string): string {
  return `/operations?${new URLSearchParams({ operation: id }).toString()}`;
}

export function IncidentsConsole({ session }: { session: AdminWebSession | null }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { tenantId: selectedTenantId } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const scopeKey = selectionScope(session, selectedTenantId);
  const [page, setPage] = useState<Load<IncidentListPage>>({ kind: 'loading' });
  const [detail, setDetail] = useState<Load<IncidentDetail> | null>(null);
  const [suppressionState, setSuppressionState] = useState<Load<MaintenanceSuppressionList>>({ kind: 'loading' });
  const [identities, setIdentities] = useState<Load<AssignableIdentityPage>>({ kind: 'loading' });
  const [searchDraft, setSearchDraft] = useState(searchParams.get('search') ?? '');
  const [ownerDraft, setOwnerDraft] = useState('');
  const [ownerSearch, setOwnerSearch] = useState('');
  const [resolveEvidenceId, setResolveEvidenceId] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [ackReason, setAckReason] = useState('');
  const [resolveReason, setResolveReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [suppressionOpen, setSuppressionOpen] = useState(false);
  const [suppressionScope, setSuppressionScope] = useState<'platform' | 'tenant' | 'service' | 'queue' | 'connector' | 'operation'>(() => session?.role === 'admin' ? 'platform' : 'tenant');
  const [suppressionRef, setSuppressionRef] = useState('');
  const [suppressionReason, setSuppressionReason] = useState('');
  const [suppressionMinutes, setSuppressionMinutes] = useState('60');
  const [suppressionBusy, setSuppressionBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pageSequence = useRef(0);
  const detailSequence = useRef(0);
  const suppressionSequence = useRef(0);
  const identitySequence = useRef(0);
  const detailScopeRef = useRef(scopeKey);
  detailScopeRef.current = scopeKey;
  const incidentId = searchParams.get('incident');
  const status = searchParams.get('status') ?? '';
  const severity = searchParams.get('severity') ?? '';
  const source = searchParams.get('source') ?? '';
  const cursor = searchParams.get('cursor') ?? '';
  const queryText = searchParams.get('search') ?? '';
  const tenantId = session?.scope?.kind === 'tenant'
    ? session.scope.tenantId
    : (selectedTenantId ?? undefined);

  const loadPage = useCallback(async () => {
    const sequence = ++pageSequence.current;
    const requestScope = scopeKey;
    if (!canReadIncidentLedger(session)) { setPage({ kind: 'error', message: 'This session has no incident read grant.' }); return; }
    setPage({ kind: 'loading' });
    const query: Record<string, string> = { limit: '50' };
    if (tenantId) query.tenantId = tenantId;
    if (status) query.status = status;
    if (severity) query.severity = severity;
    if (source) query.source = source;
    if (queryText) query.search = queryText;
    if (cursor) query.cursor = cursor;
    try {
      const result = await client.listIncidents(query as unknown as IncidentListQuery);
      if (sequence !== pageSequence.current || detailScopeRef.current !== requestScope) return;
      if (!result.ok) setPage({ kind: 'error', message: problemMessage(result) });
      else setPage({ kind: 'ready', data: result.data, sampledAt: result.data.sampledAt, stale: false });
    } catch {
      if (sequence === pageSequence.current && detailScopeRef.current === requestScope) setPage({ kind: 'error', message: 'The incident list request failed.' });
    }
  }, [client, scopeKey, tenantId, status, severity, source, queryText, cursor, session]);

  const loadSuppressions = useCallback(async () => {
    const sequence = ++suppressionSequence.current;
    const requestScope = scopeKey;
    setSuppressionState({ kind: 'loading' });
    if (!canReadIncidentLedger(session)) { setSuppressionState({ kind: 'error', message: 'This session has no incident read grant.' }); return; }
    try {
      const result = await client.listMaintenanceSuppressions();
      if (sequence !== suppressionSequence.current || detailScopeRef.current !== requestScope) return;
      setSuppressionState(result.ok ? { kind: 'ready', data: result.data, sampledAt: result.data.sampledAt, stale: false } : { kind: 'error', message: problemMessage(result) });
    } catch {
      if (sequence === suppressionSequence.current && detailScopeRef.current === requestScope) setSuppressionState({ kind: 'error', message: 'Maintenance suppression read failed.' });
    }
  }, [client, scopeKey, session]);

  useLayoutEffect(() => {
    setSearchDraft(queryText);
    void loadPage();
  }, [loadPage, queryText]);

  useLayoutEffect(() => {
    void loadSuppressions();
    return () => { suppressionSequence.current += 1; };
  }, [loadSuppressions, scopeKey]);

  useLayoutEffect(() => {
    if (!incidentId) { setDetail(null); setOwnerDraft(''); setResolveEvidenceId(''); return; }
    if (!canReadIncidentLedger(session)) { setDetail({ kind: 'error', message: 'This session has no incident read grant.' }); return; }
    const sequence = ++detailSequence.current;
    const requestScope = scopeKey;
    setDetail({ kind: 'loading' });
    setMessage(null);
    void client.getIncident(incidentId).then((result) => {
      if (sequence !== detailSequence.current || detailScopeRef.current !== requestScope) return;
      if (!result.ok) setDetail({ kind: 'error', message: problemMessage(result) });
      else {
        setDetail({ kind: 'ready', data: result.data, sampledAt: result.data.sampledAt, stale: false });
        setResolveEvidenceId((current) => current || result.data.history.find((event) => event.kind === 'source_recovered' || event.kind === 'reconciliation_confirmed')?.id || '');
      }
    }).catch(() => {
      if (sequence === detailSequence.current && detailScopeRef.current === requestScope) setDetail({ kind: 'error', message: 'The incident detail request failed.' });
    });
    return () => { detailSequence.current += 1; };
  }, [client, incidentId, scopeKey, session]);

  useLayoutEffect(() => {
    const sequence = ++identitySequence.current;
    const requestScope = scopeKey;
    setIdentities({ kind: 'loading' });
    const stillCurrent = () => sequence === identitySequence.current && detailScopeRef.current === requestScope;
    if (!incidentId || !canReadIncidentLedger(session)) { setIdentities({ kind: 'error', message: 'Open an incident with an authorized read scope to choose an owner.' }); return; }
    const current = detail?.kind === 'ready' ? detail.data.incident : null;
    if (current?.tenantId === null) {
      const query = { ...(ownerSearch ? { query: ownerSearch } : {}), limit: '100' };
      void client.searchAssignablePlatformIdentityUsers(query).then((result) => {
        if (!stillCurrent()) return;
        setIdentities(result.ok ? { kind: 'ready', data: result.data, sampledAt: new Date().toISOString(), stale: false } : { kind: 'error', message: problemMessage(result) });
      }).catch(() => { if (stillCurrent()) setIdentities({ kind: 'error', message: 'Platform identity owner lookup failed.' }); });
      return () => { identitySequence.current += 1; };
    }
    const identityTenant = current?.tenantId ?? tenantId;
    if (!identityTenant) { setIdentities({ kind: 'error', message: 'Choose a tenant scope to load assignable owners.' }); return; }
    const query = { tenantId: identityTenant, ...(ownerSearch ? { query: ownerSearch } : {}), limit: '100' };
    void client.searchAssignableIdentityUsers(query).then((result) => {
      if (!stillCurrent()) return;
      setIdentities(result.ok ? { kind: 'ready', data: result.data, sampledAt: new Date().toISOString(), stale: false } : { kind: 'error', message: problemMessage(result) });
    }).catch(() => { if (stillCurrent()) setIdentities({ kind: 'error', message: 'Identity owner lookup failed.' }); });
    return () => { identitySequence.current += 1; };
  }, [client, detail, incidentId, tenantId, ownerSearch, session]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedDetail = detail?.kind === 'ready' ? detail.data : null;
  const writable = canAct(session);
  const ownerChoices = identities.kind === 'ready' ? identities.data.items.filter((user) => user.enabled) : [];
  const availableRecoveryEvidence = selectedDetail?.history.filter((event) =>
    (event.kind === 'source_recovered' || event.kind === 'reconciliation_confirmed') && event.sourceState === selectedDetail.incident.sourceState,
  ) ?? [];

  if (!session || !session.scope) {
    return <LoadingState title="Checking Admin session" description="Incident history stays hidden until the current session scope is known." />;
  }
  if (!canReadIncidentLedger(session)) {
    return <DeniedState title="Incident access unavailable" description="Local users do not have an assigned-resource incident grant. Ask a tenant operator or platform Admin to review this incident." />;
  }

  const updateSearch = (next: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams);
    next(params);
    setSearchParams(params);
  };

  async function runAction(action: 'assign' | 'acknowledge' | 'resolve'): Promise<void> {
    if (!selectedDetail || !writable || actionBusy) return;
    setActionBusy(true); setMessage(null);
    const current = selectedDetail.incident;
    const expectedVersion = current.stateVersion;
    const body = action === 'assign'
      ? { ownerId: ownerDraft, expectedVersion, ...(assignReason.trim() ? { reason: assignReason.trim() } : {}) }
      : action === 'acknowledge'
        ? { expectedVersion, ...(ackReason.trim() ? { reason: ackReason.trim() } : {}) }
        : { expectedVersion, reason: resolveReason.trim(), evidenceEventId: resolveEvidenceId };
    try {
      const result = action === 'assign'
        ? await client.assignIncident(current.id, body as IncidentAssignRequest)
        : action === 'acknowledge'
          ? await client.acknowledgeIncident(current.id, body as IncidentAcknowledgeRequest)
          : await client.resolveIncident(current.id, body as IncidentResolveRequest);
      if (!result.ok) {
        setMessage({ kind: result.status === 409 ? 'warning' : 'error', text: problemMessage(result) });
        if (result.status === 409) {
          const latest = await client.getIncident(current.id);
          if (latest.ok) setDetail({ kind: 'ready', data: latest.data, sampledAt: latest.data.sampledAt, stale: false });
        }
      } else {
        const latest = await client.getIncident(current.id);
        if (latest.ok) setDetail({ kind: 'ready', data: latest.data, sampledAt: latest.data.sampledAt, stale: false });
        else setDetail({ kind: 'error', message: `Incident action succeeded, but refreshing history failed: ${problemMessage(latest)}` });
        setMessage({ kind: 'success', text: action === 'acknowledge' ? 'Incident acknowledged. It remains open until source recovery evidence is confirmed.' : action === 'resolve' ? 'Incident resolved with recorded source evidence.' : 'Incident owner updated.' });
        await loadPage();
      }
    } catch { setMessage({ kind: 'error', text: 'The incident action request failed. Current server state is unchanged until confirmed.' }); }
    finally { setActionBusy(false); }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    updateSearch((params) => { params.delete('cursor'); params.set('search', searchDraft.trim()); if (!searchDraft.trim()) params.delete('search'); });
  }

  async function createSuppression(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (suppressionBusy || !writable) return;
    const duration = Number(suppressionMinutes);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1440) { setMessage({ kind: 'error', text: 'Choose a suppression duration between 1 minute and 24 hours.' }); return; }
    if (suppressionScope === 'tenant' && !(session?.scope?.kind === 'tenant' ? session.scope.tenantId : selectedTenantId)) { setMessage({ kind: 'error', text: 'Choose a tenant before creating a tenant-scoped suppression.' }); return; }
    if ((suppressionScope !== 'platform' && suppressionScope !== 'tenant') && !suppressionRef.trim()) { setMessage({ kind: 'error', text: 'Enter the exact service, queue, connector or operation reference.' }); return; }
    if (session?.role !== 'admin' && suppressionScope !== 'tenant') { setMessage({ kind: 'error', text: 'Tenant operators can suppress only their own tenant scope.' }); return; }
    if (!suppressionReason.trim()) { setMessage({ kind: 'error', text: 'A suppression reason is required.' }); return; }
    const start = new Date().toISOString(); const end = new Date(Date.now() + duration * 60_000).toISOString();
    const scope = suppressionScope === 'platform' ? { kind: 'platform' as const }
      : suppressionScope === 'tenant' ? { kind: 'tenant' as const, ref: session?.scope?.kind === 'tenant' ? session.scope.tenantId : selectedTenantId ?? '' }
      : { kind: suppressionScope, ref: suppressionRef.trim() };
    setSuppressionBusy(true); setMessage(null);
    try {
      const result = await client.createMaintenanceSuppression({ scope, startsAt: start, expiresAt: end, reason: suppressionReason.trim() } as MaintenanceSuppressionCreate);
      if (!result.ok) setMessage({ kind: result.status === 409 ? 'warning' : 'error', text: problemMessage(result) });
      else {
        setMessage({ kind: 'success', text: `Suppression recorded until ${formatTime(result.data.expiresAt)}. Incident history remains visible.` });
        setSuppressionOpen(false); setSuppressionReason(''); setSuppressionRef(''); await loadSuppressions();
      }
    } catch { setMessage({ kind: 'error', text: 'The maintenance suppression request failed.' }); }
    finally { setSuppressionBusy(false); }
  }

  const activeSuppressions = suppressionState.kind === 'ready'
    ? suppressionState.data.items.filter((item) => item.active && Date.parse(item.expiresAt) > now)
    : [];

  return (
    <section className="flex min-w-0 flex-col gap-5" aria-labelledby="incidents-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h1 id="incidents-title" className="text-xl font-semibold">Incidents</h1><Badge variant="neutral">source-bound lifecycle</Badge></div>
          <p className="mt-1 max-w-3xl text-sm text-[var(--text-sub)]">Incidents retain their source, scope, first and last seen times, affected resources, owner, history, and evidence. Acknowledge records ownership of response; it never resolves an incident.</p>
        </div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" leftIcon={<RefreshCw className="size-3.5" />} onClick={() => { void loadPage(); if (incidentId) void client.getIncident(incidentId).then((value) => { if (value.ok) setDetail({ kind: 'ready', data: value.data, sampledAt: value.data.sampledAt, stale: false }); }); void loadSuppressions(); }}>Refresh</Button>{writable ? <Button size="sm" variant="outline" onClick={() => setSuppressionOpen(true)}>Maintenance suppression</Button> : null}</div>
      </header>

      {message ? <AlertBanner variant={message.kind === 'success' ? 'success' : message.kind === 'warning' ? 'warning' : 'error'} title={message.kind === 'success' ? 'Saved' : message.kind === 'warning' ? 'State changed' : 'Action not completed'}>{message.text}</AlertBanner> : null}
      {page.kind === 'ready' && page.stale ? <AlertBanner variant="warning" title="Showing a stale sample">Last successful incident sample: {formatTime(page.sampledAt)}.</AlertBanner> : null}
      {page.kind === 'ready' && page.data.connectorSignals ? <ConnectorSignalBanner snapshot={page.data.connectorSignals} /> : null}

      {incidentId ? (
        <IncidentDetailCard
          detail={detail}
          canAct={writable}
          identities={identities}
          ownerChoices={ownerChoices}
          ownerSearch={ownerSearch}
          onOwnerSearch={setOwnerSearch}
          ownerDraft={ownerDraft}
          onOwnerDraft={setOwnerDraft}
          assignReason={assignReason}
          onAssignReason={setAssignReason}
          ackReason={ackReason}
          onAckReason={setAckReason}
          resolveReason={resolveReason}
          onResolveReason={setResolveReason}
          resolveEvidenceId={resolveEvidenceId}
          onResolveEvidence={setResolveEvidenceId}
          recoveryEvidence={availableRecoveryEvidence}
          actionBusy={actionBusy}
          onAction={(action) => void runAction(action)}
          onClose={() => updateSearch((params) => params.delete('incident'))}
          onRefresh={() => { void client.getIncident(incidentId).then((value) => { if (value.ok) setDetail({ kind: 'ready', data: value.data, sampledAt: value.data.sampledAt, stale: false }); }); }}
        />
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="size-4 text-[var(--cf-blue)]" />Incident ledger</CardTitle>
            <CardDescription>{page.kind === 'ready' ? `${page.data.items.length} rows · sample ${formatTime(page.data.sampledAt)} · ${page.data.tenantId ? `tenant ${page.data.tenantId}` : 'platform view'}` : 'Search and filter the server side incident ledger.'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={submitSearch} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(12rem,1fr)_repeat(3,minmax(8rem,auto))_auto]">
              <label className="sr-only" htmlFor="incident-search">Search incidents</label>
              <div className="relative min-w-0"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-[var(--text-sub)]" /><input id="incident-search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search summary, source or owner" className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] py-2 pl-9 pr-3 text-sm" /></div>
              <label className="sr-only" htmlFor="incident-status">Status</label><select id="incident-status" value={status} onChange={(event) => updateSearch((params) => { params.delete('cursor'); event.target.value ? params.set('status', event.target.value) : params.delete('status'); })} className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-2 text-sm"><option value="">All status</option>{STATUS_OPTIONS.filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <label className="sr-only" htmlFor="incident-severity">Severity</label><select id="incident-severity" value={severity} onChange={(event) => updateSearch((params) => { params.delete('cursor'); event.target.value ? params.set('severity', event.target.value) : params.delete('severity'); })} className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-2 text-sm"><option value="">All severity</option>{SEVERITY_OPTIONS.filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <label className="sr-only" htmlFor="incident-source">Source</label><select id="incident-source" value={source} onChange={(event) => updateSearch((params) => { params.delete('cursor'); event.target.value ? params.set('source', event.target.value) : params.delete('source'); })} className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-2 text-sm"><option value="">All sources</option>{SOURCE_OPTIONS.filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}</select>
              <Button type="submit" size="sm" className="w-full sm:w-auto">Search</Button>
            </form>
            {page.kind === 'loading' ? <LoadingState title="Loading incidents" description="Reading the incident page for the current server-authorized scope." /> : null}
            {page.kind === 'error' ? <ErrorState title="Incident ledger unavailable" description={page.message} onRetry={() => void loadPage()} /> : null}
            {page.kind === 'ready' && page.data.items.length === 0 ? <EmptyState title="No incidents match these filters" description="A zero-row page means no ledger rows matched this server query. It does not mean every source is healthy." /> : null}
            {page.kind === 'ready' && page.data.items.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-[var(--border-subtle)]" role="region" aria-label="Incident results" tabIndex={0}>
                <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                  <thead><tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)]"><th className="px-3 py-2">Severity / state</th><th className="px-3 py-2">Incident</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Owner</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Resource</th></tr></thead>
                  <tbody>
                    {page.data.items.map((incident) => <IncidentRow key={incident.id} incident={incident} selected={incidentId === incident.id} onOpen={() => updateSearch((params) => params.set('incident', incident.id))} />)}
                  </tbody>
                </table>
              </div>
            ) : null}
            {page.kind === 'ready' ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="text-xs text-[var(--text-sub)]">Server search · keyset cursor · 50 rows per page</span><Button size="sm" variant="outline" disabled={!cursor} onClick={() => updateSearch((params) => params.delete('cursor'))}>First page</Button><Button size="sm" variant="outline" disabled={!page.data.nextCursor} onClick={() => updateSearch((params) => params.set('cursor', page.data.nextCursor!))}>Next page</Button></div> : null}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="size-4 text-[var(--badge-warning-text)]" />Maintenance suppression</CardTitle><CardDescription>Suppression hides notification noise for a bounded scope and time. It never deletes or resolves incident history.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2"><Badge variant={suppressionState.kind === 'ready' ? 'success' : 'neutral'}>{suppressionState.kind === 'ready' ? `${activeSuppressions.length} active` : suppressionState.kind}</Badge><span className="text-xs text-[var(--text-sub)]">{suppressionState.kind === 'ready' ? `Sampled ${formatTime(suppressionState.sampledAt)}` : suppressionState.kind === 'error' ? suppressionState.message : 'Loading suppression records'}</span></div>
            {activeSuppressions.length === 0 && suppressionState.kind === 'ready' ? <p className="text-sm text-[var(--text-sub)]">No active suppression applies in this scope.</p> : null}
            <ul className="space-y-2">{activeSuppressions.map((suppression) => <li key={suppression.id} className="rounded-md border border-[var(--border-subtle)] p-3"><div className="flex flex-wrap items-start justify-between gap-2"><strong className="text-sm">{scopeLabel(suppression)}</strong><Badge variant="warning">Until {formatTime(suppression.expiresAt)}</Badge></div><p className="mt-1 break-words text-sm">{suppression.reason}</p><p className="mt-1 text-xs text-[var(--text-sub)]">Created by {suppression.createdBy} · {formatTime(suppression.createdAt)}</p></li>)}</ul>
            <p className="border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-sub)]">Expired suppressions remain in the audit record. They do not mark their source healthy.</p>
          </CardContent>
        </Card>
      </div>

      <Modal open={suppressionOpen} onOpenChange={setSuppressionOpen} title="Create maintenance suppression" description="Choose a narrow scope and a short expiry. The system retains every incident and source observation.">
        <form className="space-y-4" onSubmit={(event) => void createSuppression(event)}>
          <label className="block space-y-1 text-sm font-medium">Scope<select value={suppressionScope} onChange={(event) => setSuppressionScope(event.target.value as typeof suppressionScope)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2"><option value="platform" disabled={session?.role !== 'admin'}>Platform</option><option value="tenant">Tenant</option><option value="service">Service</option><option value="queue">Queue</option><option value="connector">Connector</option><option value="operation">Operation</option></select></label>
          {suppressionScope === 'tenant' ? <label className="block space-y-1 text-sm font-medium">Tenant<input readOnly value={session?.scope?.kind === 'tenant' ? session.scope.tenantId : selectedTenantId ?? ''} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2" /></label> : null}
          {suppressionScope !== 'platform' && suppressionScope !== 'tenant' ? <label className="block space-y-1 text-sm font-medium">Exact {suppressionScope} reference<input required maxLength={128} value={suppressionRef} onChange={(event) => setSuppressionRef(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" /></label> : null}
          <label className="block space-y-1 text-sm font-medium">Reason<textarea required minLength={3} maxLength={500} value={suppressionReason} onChange={(event) => setSuppressionReason(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" rows={3} /></label>
          <label className="block space-y-1 text-sm font-medium">Duration (minutes)<input type="number" min={1} max={1440} value={suppressionMinutes} onChange={(event) => setSuppressionMinutes(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" /><span className="text-xs font-normal text-[var(--text-sub)]">Maximum 24 hours; it begins now and expires automatically.</span></label>
          <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => setSuppressionOpen(false)}>Cancel</Button><Button type="submit" isLoading={suppressionBusy} disabled={!writable}>Record suppression</Button></div>
        </form>
      </Modal>
    </section>
  );
}

function ConnectorSignalBanner({ snapshot }: { snapshot: NonNullable<IncidentListPage['connectorSignals']> }) {
  const title = snapshot.status === 'fresh' ? 'Actual Connector ledger sample'
    : snapshot.status === 'stale' ? 'Connector ledger sample is stale'
      : snapshot.status === 'not-selected' ? 'Connector signals need a tenant scope'
        : 'Connector ledger unavailable';
  const variant = snapshot.status === 'fresh' ? 'info' : snapshot.status === 'not-selected' ? 'info' : 'warning';
  const description = snapshot.status === 'not-selected'
    ? 'Select one tenant to read its authenticated Connector invocation and usage-outbox snapshot. The platform view does not fan out across tenants.'
    : snapshot.status === 'unavailable'
      ? 'No current Connector sample was returned. Existing incident history remains visible; unavailable source data is not treated as healthy or recovered.'
      : snapshot.status === 'stale'
        ? `The last returned Connector sample is stale${snapshot.sampledAt ? ` (sampled ${formatTime(snapshot.sampledAt)})` : ''}. Its counters are historical and have not been used to recover incidents.`
        : `Tenant-bound persisted invocation and usage-outbox rows sampled ${formatTime(snapshot.sampledAt ?? '')}. Counts cover the bounded 30-day query window.`;
  return <AlertBanner variant={variant} title={title}>
    <span>{description}</span>
    {snapshot.invocationCounts ? <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span>UNKNOWN invocations {snapshot.invocationCounts.UNKNOWN.toLocaleString()}</span>
      <span>FAILED invocations {snapshot.invocationCounts.FAILED.toLocaleString()}</span>
      <span>Pending usage outbox {snapshot.pendingOutbox?.toLocaleString() ?? 'unknown'}</span>
      <span>Failed delivery attempts {snapshot.failedDeliveryAttempts?.toLocaleString() ?? 'unknown'}</span>
      {snapshot.oldestPendingLagMs !== null ? <span>Oldest pending lag {Math.round(snapshot.oldestPendingLagMs / 1000).toLocaleString()} seconds</span> : null}
    </span> : null}
  </AlertBanner>;
}

function IncidentRow({ incident, selected, onOpen }: { incident: Incident; selected: boolean; onOpen: () => void }) {
  const primary = incident.affectedResources[0];
  return <tr className={`border-b border-[var(--border-subtle)] align-top ${selected ? 'bg-[var(--cf-blue-light)]' : ''}`}>
    <td className="whitespace-nowrap px-3 py-3"><div className="flex flex-col items-start gap-1"><Badge variant={severityVariant(incident.severity)}>{incident.severity}</Badge><Badge variant={statusVariant(incident.status)}>{incident.status}</Badge>{incident.suppressed ? <Badge variant="warning">Suppressed · history retained</Badge> : null}</div></td>
    <td className="min-w-[18rem] px-3 py-3"><button onClick={onOpen} className="text-left font-medium text-[var(--cf-blue)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">{incident.summary}</button><p className="mt-1 text-xs text-[var(--text-sub)]">First {formatTime(incident.firstSeenAt)} · {incident.occurrenceCount.toLocaleString()} observations · v{incident.stateVersion}</p><p className="text-xs text-[var(--text-sub)]">Source state {incident.sourceState} · threshold {incident.thresholdRevision}</p></td>
    <td className="px-3 py-3"><span className="font-medium">{incident.source}</span><p className="break-all font-mono text-xs text-[var(--text-sub)]">{incident.sourceRef} · {incident.signalCode}</p></td>
    <td className="px-3 py-3">{incident.ownerId ? <span className="break-all font-mono text-xs">{incident.ownerId}</span> : <span className="text-[var(--text-sub)]">Unassigned</span>}</td>
    <td className="whitespace-nowrap px-3 py-3"><time dateTime={incident.lastSeenAt}>{formatTime(incident.lastSeenAt)}</time><p className="text-xs text-[var(--text-sub)]">Sampled {formatTime(incident.lastSampledAt)}</p></td>
    <td className="px-3 py-3">{primary ? resourceHref(primary.kind, primary.ref) ? <Link className="text-[var(--cf-blue)] underline" to={resourceHref(primary.kind, primary.ref)!}>{primary.label}</Link> : <span>{primary.label}</span> : <span className="text-[var(--text-sub)]">No affected resource reference</span>}</td>
  </tr>;
}

function IncidentDetailCard(props: {
  detail: Load<IncidentDetail> | null;
  canAct: boolean;
  identities: Load<AssignableIdentityPage>;
  ownerChoices: AssignableIdentityUser[];
  ownerSearch: string;
  onOwnerSearch: (value: string) => void;
  ownerDraft: string;
  onOwnerDraft: (value: string) => void;
  assignReason: string;
  onAssignReason: (value: string) => void;
  ackReason: string;
  onAckReason: (value: string) => void;
  resolveReason: string;
  onResolveReason: (value: string) => void;
  resolveEvidenceId: string;
  onResolveEvidence: (value: string) => void;
  recoveryEvidence: IncidentDetail['history'];
  actionBusy: boolean;
  onAction: (action: 'assign' | 'acknowledge' | 'resolve') => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const detail = props.detail;
  if (!detail) return null;
  return <section aria-label="Incident detail" className="scroll-mt-4" aria-live="polite">
    {detail.kind === 'loading' ? <LoadingState title="Loading incident detail" description="Fetching the current source state and immutable history." /> : null}
    {detail.kind === 'error' ? <ErrorState title="Incident detail unavailable" description={detail.message} onRetry={props.onRefresh} /> : null}
    {detail.kind === 'ready' ? <Card className="border-[var(--cf-blue)]">
      <CardHeader><div className="flex flex-wrap items-start justify-between gap-2"><div><CardTitle className="break-words">{detail.data.incident.summary}</CardTitle><CardDescription>Incident {detail.data.incident.id} · source evidence is retained in the history below.</CardDescription></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" leftIcon={<RefreshCw className="size-3.5" />} onClick={props.onRefresh}>Refresh detail</Button><Button size="sm" variant="outline" leftIcon={<ArrowLeft className="size-3.5" />} onClick={props.onClose}>Back to results</Button></div></div></CardHeader>
      <CardContent className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.9fr)]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap gap-2"><Badge variant={severityVariant(detail.data.incident.severity)}>{detail.data.incident.severity}</Badge><Badge variant={statusVariant(detail.data.incident.status)}>{detail.data.incident.status}</Badge><Badge variant="neutral">source {detail.data.incident.sourceState}</Badge>{detail.data.incident.suppressed ? <Badge variant="warning">Suppressed · retained</Badge> : null}</div>
          <dl className="grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2"><DetailValue label="Source" value={`${detail.data.incident.source} · ${detail.data.incident.sourceRef}`} /><DetailValue label="Signal code" value={detail.data.incident.signalCode} /><DetailValue label="Scope" value={detail.data.incident.tenantId ?? 'Platform'} /><DetailValue label="Threshold revision" value={detail.data.incident.thresholdRevision} /><DetailValue label="First seen" value={formatTime(detail.data.incident.firstSeenAt)} /><DetailValue label="Last seen" value={formatTime(detail.data.incident.lastSeenAt)} /><DetailValue label="Last sampled" value={formatTime(detail.data.incident.lastSampledAt)} /><DetailValue label="Observed occurrences" value={detail.data.incident.occurrenceCount.toLocaleString()} /><DetailValue label="Owner ID" value={detail.data.incident.ownerId ?? 'Unassigned'} /><DetailValue label="State version" value={String(detail.data.incident.stateVersion)} /></dl>
          <div><h3 className="mb-2 text-sm font-semibold">Affected resources</h3>{detail.data.incident.affectedResources.length ? <ul className="flex flex-wrap gap-2">{detail.data.incident.affectedResources.map((resource) => { const href = resourceHref(resource.kind, resource.ref); return <li key={`${resource.kind}:${resource.ref}`} className="max-w-full rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm"><span className="text-xs uppercase text-[var(--text-sub)]">{resource.kind}</span><div className="break-all">{href ? <Link className="text-[var(--cf-blue)] underline" to={href}>{resource.label} · {resource.ref}</Link> : <span>{resource.label} · {resource.ref} <span className="text-xs text-[var(--text-sub)]">(source evidence)</span></span>}</div></li>; })}</ul> : <p className="text-sm text-[var(--text-sub)]">The source supplied no affected resource references.</p>}</div>
          {detail.data.incident.counters ? <details className="rounded-md border border-[var(--border-subtle)] p-3"><summary className="cursor-pointer text-sm font-semibold">Measured source counters</summary><dl className="mt-2 grid grid-cols-[1fr_auto] gap-2 text-sm">{Object.entries(detail.data.incident.counters).map(([key, value]) => <div className="contents" key={key}><dt className="text-[var(--text-sub)]">{key}</dt><dd className="tabular-nums">{value.toLocaleString()}</dd></div>)}</dl></details> : null}
        </div>
        <div className="min-w-0 space-y-4">
          {props.canAct ? <div className="space-y-3 rounded-md border border-[var(--border-subtle)] p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><UserRound className="size-4" />Operator actions</h3>
            <label className="block space-y-1 text-sm font-medium">Find enabled identity<input type="search" value={props.ownerSearch} maxLength={120} onChange={(event) => props.onOwnerSearch(event.target.value)} placeholder="Search username" className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" /></label>
            <label className="block space-y-1 text-sm font-medium">Assign to enabled identity<select value={props.ownerDraft} onChange={(event) => props.onOwnerDraft(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2"><option value="">Choose an owner</option>{props.ownerChoices.map((user) => <option key={user.id} value={user.id}>{user.username} · {user.role}{detail.data.incident.tenantId === null ? ` · ${user.tenantId}` : ''}</option>)}</select><span className="text-xs font-normal text-[var(--text-sub)]">{props.identities.kind === 'ready' ? `${props.ownerChoices.length} enabled assignable identities in the authorized incident scope.` : props.identities.kind === 'error' ? props.identities.message : 'Loading the authorized identity directory…'}</span></label>
            <label className="block space-y-1 text-sm font-medium">Assignment note<input value={props.assignReason} maxLength={500} onChange={(event) => props.onAssignReason(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" /></label>
            <Button size="sm" variant="outline" disabled={!props.ownerDraft || props.actionBusy || detail.data.incident.status === 'resolved' || props.identities.kind !== 'ready'} onClick={() => props.onAction('assign')}>Assign owner</Button>
            {detail.data.incident.status === 'open' ? <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3"><label className="block space-y-1 text-sm font-medium">Acknowledgement note<input value={props.ackReason} maxLength={500} onChange={(event) => props.onAckReason(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" /></label><Button size="sm" disabled={props.actionBusy} onClick={() => props.onAction('acknowledge')}>Acknowledge incident</Button><p className="text-xs text-[var(--text-sub)]">Acknowledgement records a responder and keeps the incident open.</p></div> : null}
            {detail.data.incident.status !== 'resolved' ? <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3"><label className="block space-y-1 text-sm font-medium">Verified recovery evidence<select value={props.resolveEvidenceId} onChange={(event) => props.onResolveEvidence(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2"><option value="">Select source recovery evidence</option>{props.recoveryEvidence.map((event) => <option key={event.id} value={event.id}>{event.kind === 'source_recovered' ? 'Source recovered' : 'Reconciliation confirmed'} · {formatTime(event.occurredAt)} · {event.evidenceRef ?? event.id}</option>)}</select></label><label className="block space-y-1 text-sm font-medium">Resolution note<textarea value={props.resolveReason} maxLength={500} minLength={3} onChange={(event) => props.onResolveReason(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2" rows={2} /></label><Button size="sm" variant="destructive" disabled={props.actionBusy || !props.resolveEvidenceId || props.recoveryEvidence.length === 0 || props.resolveReason.trim().length < 3 || detail.data.incident.sourceState === 'active'} onClick={() => props.onAction('resolve')}>Resolve with evidence</Button><p className="text-xs text-[var(--text-sub)]">The source must report recovery or a reconciliation record. A note alone cannot close the incident.</p></div> : <p className="rounded-md border border-[var(--border-subtle)] p-3 text-sm">Resolved {detail.data.incident.resolvedAt ? formatTime(detail.data.incident.resolvedAt) : 'with recorded source evidence'}.</p>}
          </div> : <AlertBanner variant="info" title="Read-only incident access">This session can inspect the tenant incident history. Incident changes require an operator or platform Admin role.</AlertBanner>}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Incident history</h3>
            <ol className="relative space-y-3 border-l border-[var(--border-subtle)] pl-4">{detail.data.history.map((event) => <li key={event.id} className="relative rounded-md border border-[var(--border-subtle)] p-3"><span aria-hidden="true" className="absolute -left-[1.35rem] top-4 size-2 rounded-full bg-[var(--cf-blue)]" /><div className="flex flex-wrap items-center justify-between gap-2"><Badge variant="neutral">{event.kind.replaceAll('_', ' ')}</Badge><time className="text-xs text-[var(--text-sub)]" dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time></div><p className="mt-2 break-words text-sm">{event.summary}</p><p className="mt-1 text-xs text-[var(--text-sub)]">By {event.actor}{event.evidenceRef ? ` · evidence ${event.evidenceRef}` : ''}</p></li>)}</ol>
            {detail.data.history.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No history events were returned.</p> : null}
          </div>
        </div>
      </CardContent>
    </Card> : null}
  </section>;
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b border-[var(--border-subtle)] py-1"><dt className="text-xs text-[var(--text-sub)]">{label}</dt><dd className="break-words text-sm">{value}</dd></div>;
}

function resourceHref(kind: Incident['affectedResources'][number]['kind'], ref: string): string | null {
  const params = new URLSearchParams();
  if (kind === 'operation') return operationHref(ref);
  if (kind === 'queue') { params.set('queue', ref); return `/system-operations/workers-queues?${params.toString()}`; }
  if (kind === 'service' || kind === 'replica') { params.set(kind, ref); return `/system-operations/services?${params.toString()}`; }
  if (kind === 'connector') { params.set('connectorId', ref); return `/connectors?${params.toString()}`; }
  if (kind === 'invocation' || kind === 'delivery') return null;
  if (kind === 'deployment') { params.set('deployment', ref); return `/system-operations/deployments?${params.toString()}`; }
  if (kind === 'maintenance-job') { params.set('job', ref); return `/system-operations/maintenance?${params.toString()}`; }
  return '/system-operations';
}

function scopeLabel(suppression: MaintenanceSuppression): string {
  return suppression.scope.kind === 'platform' ? 'Platform' : `${suppression.scope.kind} · ${suppression.scope.ref}`;
}
