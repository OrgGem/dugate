import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { History, RefreshCw, RotateCcw, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/ui/dialog';
import { AlertBanner } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ADMIN_AUTH_EXPIRED_EVENT,
  createAdminApiClient,
  type AdminWebSession,
  type ComposeAction,
  type ComposeCatalog,
  type ComposeCatalogProject,
  type ComposeJob,
  type ComposeJobPage,
  type ComposeObservedService,
  type ComposePreview,
  type ComposePreviewRequest,
} from '@/lib/api';
import { canManageCompose } from './state';
import { ADMIN_AUTH_RESTORED_EVENT } from '@/app-shell/session-events';
import {
  composeActionBlockReason,
  composeFreshness,
  composeJobStateGuidance,
  composeJobStateLabel,
  composePreviewMatchesCurrent,
  composeProblemMessage,
  composeReleasesForAction,
  composeSafeErrorMessage,
  type ComposeFreshness,
} from './compose-state';

const JOBS_PAGE_SIZE = 25;

type Resource<T> = {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
};

interface JobsResource {
  projectId: string | null;
  data: ComposeJobPage | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
}

interface Draft {
  action: ComposeAction;
  releaseId: string;
  serviceId: string;
  reason: string;
}

interface PendingPreview {
  data: ComposePreview;
  idempotencyKey: string;
}

const EMPTY_DRAFT: Draft = { action: 'apply_release', releaseId: '', serviceId: '', reason: '' };

function initialResource<T>(): Resource<T> {
  return { data: null, loading: false, refreshing: false, stale: false, error: null };
}

function initialJobsResource(projectId: string | null): JobsResource {
  return { projectId, data: null, loading: false, refreshing: false, stale: false, error: null };
}

function timeLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown';
  return new Date(value).toLocaleString();
}

function ageLabel(value: string | null, now: number): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'sample time unknown';
  const ageSeconds = Math.floor((now - Date.parse(value)) / 1000);
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'sample time is invalid';
  if (ageSeconds < 60) return `sampled ${ageSeconds}s ago`;
  return `sampled ${Math.floor(ageSeconds / 60)}m ago`;
}

function freshnessVariant(state: ComposeFreshness): 'success' | 'warning' | 'danger' | 'neutral' {
  if (state === 'fresh') return 'success';
  if (state === 'stale') return 'warning';
  if (state === 'unavailable') return 'danger';
  return 'neutral';
}

function freshnessLabel(state: ComposeFreshness): string {
  if (state === 'fresh') return 'Fresh';
  if (state === 'stale') return 'Stale';
  if (state === 'unavailable') return 'Unavailable';
  return 'Unknown';
}

function availabilityMessage(code: string | null, availability: ComposeCatalog['availability']): string {
  return composeSafeErrorMessage(code) ?? `Compose host observation is ${availability.toLowerCase()}.`;
}

function actionLabel(action: ComposeAction): string {
  if (action === 'apply_release') return 'Apply approved release';
  if (action === 'rollback_release') return 'Roll back to approved release';
  return 'Restart allowlisted service';
}

function jobVariant(state: ComposeJob['state']): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (state === 'SUCCEEDED') return 'success';
  if (state === 'UNKNOWN' || state === 'FAILED') return 'danger';
  if (state === 'PARTIAL' || state === 'RECONCILED') return 'warning';
  if (state === 'RUNNING' || state === 'CLAIMED') return 'info';
  return 'neutral';
}

function problemFromResult(status: number, code?: string): string {
  return composeProblemMessage({ status, ...(code ? { code } : {}) });
}

function previewMatchesRequest(preview: ComposePreview, requested: ComposePreviewRequest): boolean {
  return preview.hostId === requested.hostId
    && preview.projectId === requested.projectId
    && preview.action === requested.action
    && preview.reason === requested.reason
    && (preview.action === 'restart_service'
      ? preview.serviceId === requested.serviceId && preview.releaseId === null
      : preview.releaseId === requested.releaseId && preview.serviceId === null);
}

function composeIdempotencyKey(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('A secure idempotency key is not available in this browser.');
  }
  return crypto.randomUUID();
}

export interface ComposeOperationsPanelProps {
  session: AdminWebSession | null;
  sessionProblem: string | null;
  refreshKey: number;
  onRefresh: () => void;
}

export function ComposeOperationsPanel({ session, sessionProblem, refreshKey, onRefresh }: ComposeOperationsPanelProps) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [sessionOverride, setSessionOverride] = useState<AdminWebSession | null>(null);
  const activeSession = sessionOverride ?? session;
  const canAccess = canManageCompose(activeSession);
  const [authExpired, setAuthExpired] = useState(false);
  const authExpiredRef = useRef(false);
  const [catalog, setCatalog] = useState<Resource<ComposeCatalog>>(() => initialResource());
  const [jobs, setJobs] = useState<JobsResource>(() => initialJobsResource(null));
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [draftByProject, setDraftByProject] = useState<Record<string, Draft>>({});
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const [formMessage, setFormMessage] = useState<{ kind: 'info' | 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDetail, setJobDetail] = useState<Resource<ComposeJob>>(() => initialResource());
  const [now, setNow] = useState(() => Date.now());
  const catalogSequence = useRef(0);
  const jobsSequence = useRef(0);
  const detailSequence = useRef(0);
  const previousProvidedSessionKey = useRef<string | null>(null);

  const providedSessionKey = session
    ? `${session.role}:${session.principal.kind}:${session.principal.tenantId ?? ''}:${session.scope?.kind ?? 'none'}:${session.scope?.kind === 'tenant' ? session.scope.tenantId : ''}`
    : null;
  const hasCatalog = catalog.data !== null;
  const catalogHostId = catalog.data?.hostId ?? null;
  const catalogProjectCount = catalog.data?.projects.length ?? 0;

  useEffect(() => {
    const handleAuthExpired = () => {
      authExpiredRef.current = true;
      catalogSequence.current += 1;
      jobsSequence.current += 1;
      detailSequence.current += 1;
      setAuthExpired(true);
      setCatalog((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: 'Admin session expired.' }));
      setJobs((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: 'Admin session expired.' }));
      setJobDetail((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: 'Admin session expired.' }));
      setPreview(null);
      setSelectedJobId(null);
      setOperationMessage('Your Admin session expired. Host data is hidden and all Compose actions are blocked; the non-secret request draft is preserved.');
    };
    const handleAuthRestored = () => {
      authExpiredRef.current = false;
      setAuthExpired(false);
      setOperationMessage('Admin session verified. Refreshing host catalog and job history before actions resume.');
      onRefresh();
    };
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, handleAuthExpired);
    window.addEventListener(ADMIN_AUTH_RESTORED_EVENT, handleAuthRestored);
    return () => {
      window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, handleAuthExpired);
      window.removeEventListener(ADMIN_AUTH_RESTORED_EVENT, handleAuthRestored);
    };
  }, [onRefresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (previousProvidedSessionKey.current === providedSessionKey) return;
    previousProvidedSessionKey.current = providedSessionKey;
    setSessionOverride(null);
    if (session && !canManageCompose(session)) {
      catalogSequence.current += 1;
      jobsSequence.current += 1;
      detailSequence.current += 1;
      setCatalog(initialResource());
      setJobs(initialJobsResource(null));
      setPreview(null);
      setSelectedJobId(null);
    }
  }, [providedSessionKey, session]);

  const refreshCatalog = useCallback(async () => {
    if (!canAccess || authExpiredRef.current) return;
    const sequence = ++catalogSequence.current;
    setCatalog((current) => ({
      ...current,
      loading: current.data === null,
      refreshing: current.data !== null,
      error: null,
    }));
    try {
      const result = await client.getComposeCatalog();
      if (catalogSequence.current !== sequence) return;
      if (result.status === 401) {
        authExpiredRef.current = true;
        setAuthExpired(true);
        setPreview(null);
        return;
      }
      if (!result.ok) {
        const message = problemFromResult(result.status, result.problem.code);
        setCatalog((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: message }));
        return;
      }
      setCatalog({ data: result.data, loading: false, refreshing: false, stale: false, error: null });
      setSelectedProjectId((current) => result.data.projects.some((project) => project.projectId === current)
        ? current
        : result.data.projects[0]?.projectId ?? null);
    } catch {
      if (catalogSequence.current !== sequence) return;
      setCatalog((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: 'The Compose catalog request could not be reached.' }));
    }
  }, [canAccess, client]);

  useEffect(() => {
    if (!canAccess || authExpired) return undefined;
    void refreshCatalog();
    return () => { catalogSequence.current += 1; };
  }, [canAccess, authExpired, refreshKey, refreshCatalog]);

  useEffect(() => {
    if (!canAccess || authExpired || !hasCatalog) return undefined;
    if (catalogProjectCount > 0 && selectedProjectId === null) return undefined;
    const sequence = ++jobsSequence.current;
    const projectId = selectedProjectId;
    const hostId = catalogHostId;
    const query = { limit: JOBS_PAGE_SIZE, ...(hostId ? { hostId } : {}), ...(projectId ? { projectId } : {}) };
    setJobs((current) => ({
      ...current,
      projectId,
      loading: current.data === null || current.projectId !== projectId,
      refreshing: current.data !== null && current.projectId === projectId,
      error: null,
      ...(current.projectId !== projectId ? { data: null, stale: false } : {}),
    }));
    void client.listComposeJobs(query).then((result) => {
      if (jobsSequence.current !== sequence) return;
      if (result.status === 401) {
        authExpiredRef.current = true;
        setAuthExpired(true);
        setPreview(null);
        return;
      }
      if (!result.ok) {
        const message = problemFromResult(result.status, result.problem.code);
        setJobs((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: message }));
        return;
      }
      setJobs({ projectId, data: result.data, loading: false, refreshing: false, stale: false, error: null });
    }).catch(() => {
      if (jobsSequence.current === sequence) {
        setJobs((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: 'The Compose job history request could not be reached.' }));
      }
    });
    return () => { jobsSequence.current += 1; };
  }, [canAccess, authExpired, catalogHostId, catalogProjectCount, client, hasCatalog, refreshKey, selectedProjectId]);

  useEffect(() => {
    if (!canAccess || authExpired || !selectedJobId) return undefined;
    const sequence = ++detailSequence.current;
    setJobDetail((current) => ({ ...current, loading: current.data === null, refreshing: current.data !== null, error: null }));
    void client.getComposeJob(selectedJobId).then((result) => {
      if (detailSequence.current !== sequence) return;
      if (result.status === 401) {
        authExpiredRef.current = true;
        setAuthExpired(true);
        setPreview(null);
        setSelectedJobId(null);
        return;
      }
      if (!result.ok) {
        setJobDetail((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: problemFromResult(result.status, result.problem.code) }));
        return;
      }
      if (result.data.jobId !== selectedJobId) {
        setJobDetail({ data: null, loading: false, refreshing: false, stale: false, error: 'The job detail did not match the selected history row.' });
        return;
      }
      setJobDetail({ data: result.data, loading: false, refreshing: false, stale: false, error: null });
    }).catch(() => {
      if (detailSequence.current === sequence) {
        setJobDetail((current) => ({ ...current, loading: false, refreshing: false, stale: current.data !== null, error: 'The Compose job detail request could not be reached.' }));
      }
    });
    return () => { detailSequence.current += 1; };
  }, [canAccess, authExpired, client, selectedJobId]);

  const project = catalog.data?.projects.find((candidate) => candidate.projectId === selectedProjectId) ?? null;
  const releaseChoices = project ? composeReleasesForAction(project, draft.action) : [];
  const restartableServices = project?.services.filter((service) => service.restartAllowed) ?? [];
  const actionBlockReason = catalog.data && project
    ? composeActionBlockReason(catalog.data, project, now)
    : catalog.data?.configured ? 'Select an available Compose project.' : availabilityMessage(catalog.data?.lastErrorCode ?? null, catalog.data?.availability ?? 'UNAVAILABLE');
  const releaseTargetReady = draft.action === 'restart_service' || releaseChoices.some((release) => release.releaseId === draft.releaseId);
  const serviceTargetReady = draft.action !== 'restart_service' || restartableServices.some((service) => service.serviceId === draft.serviceId);
  const reasonReady = draft.reason.trim().length >= 3 && draft.reason.trim().length <= 500;
  const previewReady = canAccess && !authExpired && !catalog.loading && !catalog.stale && actionBlockReason === null
    && releaseTargetReady && serviceTargetReady && reasonReady && !previewing && !submitting;
  const currentPreview = preview?.data && catalog.data && project
    ? composePreviewMatchesCurrent(preview.data, catalog.data, project, now)
    : false;

  const updateDraft = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setPreview(null);
    setFormMessage(null);
  };

  const chooseProject = (projectId: string) => {
    if (projectId === selectedProjectId) return;
    if (selectedProjectId) setDraftByProject((current) => ({ ...current, [selectedProjectId]: draft }));
    const nextDraft = draftByProject[projectId] ?? EMPTY_DRAFT;
    setDraft(nextDraft);
    setSelectedProjectId(projectId);
    setPreview(null);
    setSelectedJobId(null);
    setFormMessage(null);
  };

  const requestPreview = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!previewReady || !catalog.data || !project || !catalog.data.hostId) return;
    const request: ComposePreviewRequest = {
      hostId: catalog.data.hostId,
      projectId: project.projectId,
      action: draft.action,
      reason: draft.reason.trim(),
      ...(draft.action === 'restart_service' ? { serviceId: draft.serviceId } : { releaseId: draft.releaseId }),
    };
    setPreviewing(true);
    setFormMessage(null);
    try {
      const result = await client.createComposePreview(request);
      if (result.status === 401) {
        authExpiredRef.current = true;
        setAuthExpired(true);
        setOperationMessage('Your Admin session expired. The request draft is preserved; no preview can be submitted until you sign in again.');
        return;
      }
      if (!result.ok) {
        const message = problemFromResult(result.status, result.problem.code);
        setFormMessage({ kind: result.status === 409 ? 'warning' : 'error', text: message });
        if (result.status === 409) onRefresh();
        return;
      }
      if (!previewMatchesRequest(result.data, request)) {
        setFormMessage({ kind: 'error', text: 'The server preview did not match the selected host, project, action, target and reason. No job was submitted.' });
        onRefresh();
        return;
      }
      let key: string;
      try {
        key = composeIdempotencyKey();
      } catch (error) {
        setFormMessage({ kind: 'error', text: error instanceof Error ? error.message : 'A secure idempotency key could not be created.' });
        return;
      }
      setPreview({ data: result.data, idempotencyKey: key });
    } catch {
      setFormMessage({ kind: 'error', text: 'The preview request failed. Refresh the host state before trying again.' });
    } finally {
      setPreviewing(false);
    }
  };

  const submitPreview = async () => {
    if (submitLock.current || !preview || !currentPreview || !canAccess || authExpired) return;
    submitLock.current = true;
    setSubmitting(true);
    setFormMessage(null);
    try {
      const result = await client.submitComposeJob({
        previewId: preview.data.previewId,
        expectedTargetRevision: preview.data.expectedTargetRevision,
      }, preview.idempotencyKey);
      if (result.status === 401) {
        authExpiredRef.current = true;
        setAuthExpired(true);
        setPreview(null);
        setOperationMessage('Your Admin session expired. The non-secret request draft is preserved and no further actions are available.');
        return;
      }
      if (!result.ok) {
        const message = problemFromResult(result.status, result.problem.code);
        setFormMessage({ kind: result.status === 409 ? 'warning' : 'error', text: message });
        if (result.status === 409) {
          setPreview(null);
          onRefresh();
        } else if (result.status === 0) {
          setOperationMessage('The submit response was not received. The same idempotency key is retained for this preview; check job history before any retry.');
          onRefresh();
        }
        return;
      }
      if (result.data.job.previewId !== preview.data.previewId
          || result.data.job.projectId !== preview.data.projectId
          || result.data.job.hostId !== preview.data.hostId) {
        setPreview(null);
        setFormMessage({ kind: 'error', text: 'The returned job did not match this preview. Refresh job history and inspect the server record before continuing.' });
        onRefresh();
        return;
      }
      const replayNote = result.data.replayed ? ' Existing idempotent submission returned.' : '';
      setOperationMessage(`Job ${result.data.job.jobId} was accepted in ${result.data.job.state.toLowerCase()} state.${replayNote}`);
      setPreview(null);
      setSelectedJobId(result.data.job.jobId);
      onRefresh();
    } catch {
      setOperationMessage('The submit response was not received. The same idempotency key is retained for this preview; check job history before any retry.');
      onRefresh();
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const loadMoreJobs = async () => {
    const page = jobs.data;
    const hostId = catalog.data?.hostId;
    if (!page?.hasMore || !page.nextCursor || !canAccess || authExpired || !hostId) return;
    const sequence = ++jobsSequence.current;
    setJobs((current) => ({ ...current, loading: true, refreshing: false, error: null }));
    try {
      const result = await client.listComposeJobs({
        hostId,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        limit: JOBS_PAGE_SIZE,
        cursor: page.nextCursor,
      });
      if (jobsSequence.current !== sequence) return;
      if (result.status === 401) {
        authExpiredRef.current = true;
        setAuthExpired(true);
        setPreview(null);
        return;
      }
      if (!result.ok) {
        setJobs((current) => ({ ...current, loading: false, error: problemFromResult(result.status, result.problem.code) }));
        return;
      }
      setJobs((current) => {
        if (current.projectId !== selectedProjectId || current.data === null) return current;
        const seen = new Set(current.data.items.map((job) => job.jobId));
        return {
          ...current,
          loading: false,
          refreshing: false,
          stale: false,
          error: null,
          data: { ...result.data, items: [...current.data.items, ...result.data.items.filter((job) => !seen.has(job.jobId))] },
        };
      });
    } catch {
      if (jobsSequence.current === sequence) setJobs((current) => ({ ...current, loading: false, error: 'More Compose history could not be reached.' }));
    }
  };

  const checkSession = async () => {
    const result = await client.getSession({ recoverAuth: true });
    if (result.status === 401) {
      setAuthExpired(true);
      authExpiredRef.current = true;
      return;
    }
    if (!result.ok) {
      setOperationMessage('The current Admin session could not be verified. Your non-secret draft remains saved in this page.');
      return;
    }
    setSessionOverride(result.data);
    authExpiredRef.current = false;
    setAuthExpired(false);
    if (!canManageCompose(result.data)) {
      setOperationMessage('The refreshed session does not have platform-admin scope for Compose operations.');
      setCatalog(initialResource());
      setJobs(initialJobsResource(null));
      setPreview(null);
    } else {
      setOperationMessage(null);
      onRefresh();
    }
  };

  const closeJobDetail = (open: boolean) => {
    if (!open) setSelectedJobId(null);
  };

  const selectedDetail = jobDetail.data;
  const currentFreshness = project
    ? composeFreshness(project.availability, project.sampledAt, project.receivedAt, now)
    : catalog.data
      ? composeFreshness(catalog.data.availability, catalog.data.receivedAt, catalog.data.receivedAt, now)
      : 'unknown';

  return (
    <>
      <section id="deployments" aria-labelledby="compose-deployments-title" className="scroll-mt-24">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle id="compose-deployments-title" className="flex items-center gap-2"><Server className="size-4 text-[var(--cf-blue)]" />Compose deployments</CardTitle>
                <CardDescription>Approved host releases and genuine Docker observations from the deployment-owned runner. This is a single-server Compose adapter, not a two-replica or zero-downtime rollout guarantee.</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={freshnessVariant(currentFreshness)}>{freshnessLabel(currentFreshness)}</Badge>
                <Button size="sm" variant="outline" leftIcon={<RefreshCw className="size-3.5" />} onClick={onRefresh} disabled={!canAccess || authExpired || catalog.loading}>
                  Refresh host state
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {authExpired ? (
              <AlertBanner variant="warning" title="Admin session expired">
                Protected Compose data is hidden and mutations are blocked. The non-secret request draft is preserved. <a href="/admin/login" className="font-medium underline">Sign in again</a>, then verify the session here.
                <div className="mt-3"><Button size="sm" variant="outline" onClick={() => void checkSession()}>Verify signed-in session</Button></div>
              </AlertBanner>
            ) : session === null && !sessionOverride ? (
              <AlertBanner variant={sessionProblem ? 'error' : 'info'} title={sessionProblem ? 'Admin session unavailable' : 'Resolving Admin scope'}>
                {sessionProblem ?? 'Compose host data will remain unloaded until the server confirms the current Admin session.'}
              </AlertBanner>
            ) : !canAccess ? (
              <AlertBanner variant="warning" title="Platform administrator access required">
                Compose host data is available only to a session with admin role, platform principal, and platform scope. This view makes no host or job request for tenant operators, viewers, or unscoped sessions.
              </AlertBanner>
            ) : (
              <>
                {operationMessage ? <AlertBanner variant="info" title="Compose operation status">{operationMessage}</AlertBanner> : null}
                {catalog.error ? <AlertBanner variant={catalog.data ? 'warning' : 'error'} title={catalog.data ? 'Catalog refresh failed' : 'Compose catalog unavailable'}>{catalog.error}{catalog.data ? ` The last successful catalog received ${timeLabel(catalog.data.receivedAt)} is retained as stale; actions are disabled until a fresh sample arrives.` : ''}</AlertBanner> : null}
                {catalog.loading && !catalog.data ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading approved host catalog and actual observations…</p> : null}
                {catalog.data ? (
                  <>
                    {!catalog.data.configured ? <AlertBanner variant="warning" title="Host runner is not configured">{availabilityMessage(catalog.data.lastErrorCode, catalog.data.availability)} Deployment-owned setup is required before this screen can observe or change Compose services.</AlertBanner> : null}
                    {catalog.data.configured && (catalog.data.availability !== 'FRESH' || currentFreshness !== 'fresh') ? <AlertBanner variant="warning" title="Host observation is not current">{availabilityMessage(catalog.data.lastErrorCode, catalog.data.availability)} Actions are disabled until the runner provides a current catalog and observation.</AlertBanner> : null}
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Fact label="Host" value={catalog.data.hostId ?? 'Not configured'} />
                      <Fact label="Catalog manifest SHA-256" value={catalog.data.manifestDigest ?? 'Unknown'} mono />
                      <Fact label="Catalog received" value={timeLabel(catalog.data.receivedAt)} />
                      <Fact label="Selected project sample" value={ageLabel(project?.sampledAt ?? null, now)} />
                    </div>
                    {catalog.data.projects.length > 1 ? (
                      <label className="flex min-w-0 flex-col gap-1 text-sm font-medium" htmlFor="compose-project-select">
                        Compose project
                        <select id="compose-project-select" value={selectedProjectId ?? ''} onChange={(event) => chooseProject(event.currentTarget.value)} className="min-h-10 max-w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                          {catalog.data.projects.map((item) => <option key={item.projectId} value={item.projectId}>{item.displayName} · {item.projectId}</option>)}
                        </select>
                      </label>
                    ) : null}
                    {catalog.data.configured && catalog.data.projects.length === 0 ? <div className="rounded border border-dashed border-[var(--border-subtle)] p-4 text-sm text-[var(--text-sub)]">The configured host has not reported an approved Compose project. No project or service state is invented.</div> : null}
                    {catalog.data.projects.length > 0 && project ? (
                      <>
                        {project.lastErrorCode ? <p role="status" className="text-xs text-[var(--text-sub)]">Project observation note: {composeSafeErrorMessage(project.lastErrorCode) ?? 'The host reported a safe observation issue.'}</p> : null}
                        {project.activeJob ? (
                          <AlertBanner variant={project.activeJob.state === 'UNKNOWN' ? 'error' : 'warning'} title={project.activeJob.state === 'UNKNOWN' ? 'Unknown execution holds this project' : 'Compose job holds this project'}>
                            Job <code>{project.activeJob.jobId}</code> is {project.activeJob.state.toLowerCase()}. {project.activeJob.state === 'UNKNOWN' ? 'Do not submit another action. Ask the deployment operator to reconcile host state using the deployment runbook; this page offers no blind retry or shell command.' : 'Wait for the durable job to finish and refresh before requesting another action.'}
                          </AlertBanner>
                        ) : null}
                        <ProjectObservation catalog={catalog.data} project={project} now={now} />
                      </>
                    ) : null}
                    <ActionForm
                      catalog={catalog.data}
                      project={project}
                      draft={draft}
                      freshness={currentFreshness}
                      actionBlockReason={actionBlockReason}
                      releaseChoices={releaseChoices}
                      restartableServices={restartableServices}
                      reasonReady={reasonReady}
                      previewing={previewing}
                      canAccess={canAccess && !authExpired && !catalog.loading && !catalog.refreshing && !catalog.stale}
                      formMessage={formMessage}
                      onDraftChange={updateDraft}
                      onPreview={(event) => void requestPreview(event)}
                    />
                    <JobHistory
                      resource={jobs}
                      selectedProjectId={selectedProjectId}
                      onOpenJob={(jobId) => { setJobDetail(initialResource()); setSelectedJobId(jobId); }}
                      onLoadMore={() => void loadMoreJobs()}
                    />
                  </>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </section>

      <section id="maintenance" aria-labelledby="compose-maintenance-title" className="scroll-mt-24">
        <Card>
          <CardHeader>
            <CardTitle id="compose-maintenance-title" className="flex items-center gap-2"><RotateCcw className="size-4 text-[var(--cf-blue)]" />Bounded host maintenance</CardTitle>
            <CardDescription>The adapter permits only approved application-service restart in this maintenance panel. It has no cleanup, database, storage, recovery, or arbitrary command controls.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <AlertBanner variant="info" title="Native settings restore and deployment rollback are different">
              Use <Link className="font-medium underline" to="/settings">Settings</Link> for its supported native revision workflow. Compose rollback applies an approved immutable deployment release; it does not restore every legacy global setting. Full 17-setting runtime parity and safe two-replica rollout remain open.
            </AlertBanner>
            <p className="text-sm text-[var(--text-sub)]">Service restart is available above only for allowlisted application services when the host observation is fresh. Each preview calls out possible interruption. Database, Redis, object storage, Vault, and active work are excluded.</p>
            <div className="flex flex-wrap gap-3 text-sm"><Link className="text-[var(--cf-blue)] underline" to="/operations">Open operation triage</Link><Link className="text-[var(--cf-blue)] underline" to="/audit">Open audit trail</Link></div>
          </CardContent>
        </Card>
      </section>

      <Modal
        open={preview !== null && !authExpired}
        onOpenChange={(open) => { if (!open && !submitting) setPreview(null); }}
        title="Review Compose action"
        description="This durable request will be sent to the configured host runner. Confirm only after checking target, impact, revision and expiry."
        maxWidth="max-w-2xl"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setPreview(null)} disabled={submitting}>Cancel</Button>
            <Button onClick={() => void submitPreview()} isLoading={submitting} disabled={!currentPreview || submitting || !canAccess || authExpired}>
              {operationMessage?.startsWith('The submit response was not received') ? 'Check same idempotent submission' : 'Confirm and queue job'}
            </Button>
          </>
        )}
      >
        {preview ? <PreviewReview preview={preview.data} now={now} current={currentPreview} submitting={submitting} /> : null}
      </Modal>

      <Modal
        open={selectedJobId !== null && !authExpired}
        onOpenChange={closeJobDetail}
        title="Compose job detail"
        description="Safe job outcome and observations only. Host commands, paths, environment values and raw output are never shown."
        maxWidth="max-w-3xl"
      >
        {jobDetail.loading && !selectedDetail ? <p role="status">Loading job detail…</p> : null}
        {jobDetail.error ? <AlertBanner variant="error" title="Job detail unavailable">{jobDetail.error}</AlertBanner> : null}
        {selectedDetail ? <JobDetail job={selectedDetail} stale={jobDetail.stale} /> : null}
      </Modal>
    </>
  );
}

function ActionForm({
  catalog,
  project,
  draft,
  freshness,
  actionBlockReason,
  releaseChoices,
  restartableServices,
  reasonReady,
  previewing,
  canAccess,
  formMessage,
  onDraftChange,
  onPreview,
}: {
  catalog: ComposeCatalog;
  project: ComposeCatalogProject | null;
  draft: Draft;
  freshness: ComposeFreshness;
  actionBlockReason: string | null;
  releaseChoices: ComposeCatalogProject['releases'];
  restartableServices: ComposeCatalogProject['services'];
  reasonReady: boolean;
  previewing: boolean;
  canAccess: boolean;
  formMessage: { kind: 'info' | 'success' | 'warning' | 'error'; text: string } | null;
  onDraftChange: (patch: Partial<Draft>) => void;
  onPreview: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const actionTargetReady = draft.action === 'restart_service'
    ? restartableServices.some((service) => service.serviceId === draft.serviceId)
    : releaseChoices.some((release) => release.releaseId === draft.releaseId);
  const canPreview = canAccess && project !== null && actionBlockReason === null && freshness === 'fresh' && actionTargetReady && reasonReady && !previewing;
  const selectedRelease = releaseChoices.find((release) => release.releaseId === draft.releaseId) ?? null;
  return (
    <form onSubmit={onPreview} className="space-y-3 rounded-lg border border-[var(--border-subtle)] p-4">
      <div>
        <h3 className="text-sm font-semibold">Preview an allowlisted action</h3>
        <p className="mt-1 text-xs text-[var(--text-sub)]">The target comes only from the host manifest catalog. Reason is recorded in the durable job and audit trail.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium" htmlFor="compose-action">
          Action
          <select id="compose-action" value={draft.action} onChange={(event) => onDraftChange({ action: event.currentTarget.value as ComposeAction, releaseId: '', serviceId: '' })} className="min-h-10 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            <option value="apply_release">Apply approved release</option>
            <option value="rollback_release">Roll back to approved release</option>
            <option value="restart_service">Restart allowlisted service</option>
          </select>
        </label>
        {draft.action === 'restart_service' ? (
          <label className="flex min-w-0 flex-col gap-1 text-sm font-medium" htmlFor="compose-service">
            Application service
            <select id="compose-service" value={draft.serviceId} onChange={(event) => onDraftChange({ serviceId: event.currentTarget.value })} required className="min-h-10 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
              <option value="">Select an allowlisted service</option>
              {restartableServices.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.displayName} · {service.serviceId}</option>)}
            </select>
            {restartableServices.length === 0 ? <span className="text-xs text-[var(--text-sub)]">The host manifest reports no restartable application service.</span> : null}
          </label>
        ) : (
          <label className="flex min-w-0 flex-col gap-1 text-sm font-medium" htmlFor="compose-release">
            Approved release
            <select id="compose-release" value={draft.releaseId} onChange={(event) => onDraftChange({ releaseId: event.currentTarget.value })} required className="min-h-10 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
              <option value="">Select an approved release</option>
              {releaseChoices.map((release) => <option key={release.releaseId} value={release.releaseId}>{release.displayName} · {release.releaseId}</option>)}
            </select>
            {draft.action === 'rollback_release' && releaseChoices.length === 0 ? <span className="text-xs text-[var(--text-sub)]">No release is approved as a rollback from the current desired release.</span> : null}
          </label>
        )}
      </div>
      {selectedRelease ? (
        <div className="grid gap-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 sm:grid-cols-2">
          <Fact label="Release digest" value={selectedRelease.releaseDigest} mono />
          <Fact label="Migration compatibility" value={selectedRelease.migrationCompatibility === 'acknowledged' ? 'Acknowledged in approved manifest' : 'Not acknowledged in approved manifest'} />
          <Fact label="Target services" value={selectedRelease.targetServices.join(', ')} />
          <Fact label="Approved images" value={selectedRelease.images.map((image) => `${image.serviceId}: ${image.imageDigest}`).join(' · ') || 'No image digests reported'} mono />
        </div>
      ) : null}
      <label className="flex flex-col gap-1 text-sm font-medium" htmlFor="compose-reason">
        Operator reason
        <textarea id="compose-reason" value={draft.reason} maxLength={500} minLength={3} required rows={3} onChange={(event) => onDraftChange({ reason: event.currentTarget.value })} className="w-full resize-y rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" aria-describedby="compose-reason-help" />
        <span id="compose-reason-help" className="text-xs text-[var(--text-sub)]">3–500 characters. {draft.reason.trim().length}/500. This reason is retained with the job.</span>
      </label>
      {actionBlockReason ? <p role="status" className="text-xs text-[var(--badge-warning-text)]">Actions disabled: {actionBlockReason}</p> : freshness !== 'fresh' ? <p role="status" className="text-xs text-[var(--badge-warning-text)]">Actions disabled until the Compose sample is fresh.</p> : null}
      {!catalog.configured ? <p className="text-xs text-[var(--text-sub)]">Host setup is unavailable; the form remains read-only.</p> : null}
      {formMessage ? <AlertBanner variant={formMessage.kind === 'error' ? 'error' : formMessage.kind === 'warning' ? 'warning' : formMessage.kind === 'success' ? 'success' : 'info'} title="Action request">{formMessage.text}</AlertBanner> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" isLoading={previewing} disabled={!canPreview}>Preview action</Button>
        {project ? <span className="text-xs text-[var(--text-sub)]">Expected desired revision: {project.targetRevision}. A host-state or revision conflict requires a new preview.</span> : null}
      </div>
    </form>
  );
}

function ProjectObservation({ catalog, project, now }: { catalog: ComposeCatalog; project: ComposeCatalogProject; now: number }) {
  const desiredRelease = project.releases.find((release) => release.releaseId === project.desiredReleaseId) ?? null;
  const observedByService = new Map<string, ComposeCatalogProject['observedServices']>();
  for (const observation of project.observedServices) {
    observedByService.set(observation.serviceId, [...(observedByService.get(observation.serviceId) ?? []), observation]);
  }
  const releaseImages = new Map((desiredRelease?.images ?? []).map((image) => [image.serviceId, image.imageDigest]));
  const freshness = composeFreshness(project.availability, project.sampledAt, project.receivedAt, now);
  const services = project.services;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Fact label="Desired release" value={project.desiredReleaseId ?? 'No desired release'} />
        <Fact label="Desired target revision" value={String(project.targetRevision)} />
        <Fact label="Manifest revision" value={project.catalogRevision ?? 'Unknown'} mono />
        <Fact label="Observation" value={`${freshnessLabel(freshness)} · ${timeLabel(project.sampledAt)}`} />
      </div>
      <p className="text-xs text-[var(--text-sub)]">Observed rows are actual container observations. A missing row, image digest, release ID, or health value remains unknown; no replicas are inferred from a service count.</p>
      <TableContainer className="rounded-md border border-[var(--border-subtle)]">
        <Table>
          <TableHeader><TableRow><TableHead>Service / container</TableHead><TableHead>Desired release / image</TableHead><TableHead>Observed release / image</TableHead><TableHead>Process state</TableHead><TableHead>Health</TableHead><TableHead>Started</TableHead></TableRow></TableHeader>
          <TableBody>
            {services.flatMap((service) => {
              const observations = observedByService.get(service.serviceId) ?? [];
              const rows = observations.length > 0 ? observations : [null];
              return rows.map((observation, index) => {
                const desiredImage = releaseImages.get(service.serviceId) ?? null;
                const releaseMatches = observation?.observedReleaseId && project.desiredReleaseId
                  ? observation.observedReleaseId === project.desiredReleaseId
                  : null;
                return (
                  <TableRow key={`${service.serviceId}:${observation?.containerId ?? `missing-${index}`}`}>
                    <TableCell><strong>{service.displayName}</strong><div className="font-mono text-xs text-[var(--text-sub)]">{service.serviceId}{observation?.containerId ? ` · ${observation.containerId}` : ' · no container observation'}</div></TableCell>
                    <TableCell><span>{project.desiredReleaseId ?? 'No desired release'}</span><div className="max-w-56 break-all font-mono text-xs text-[var(--text-sub)]">{desiredImage ?? 'Desired image unknown'}</div></TableCell>
                    <TableCell>
                      {observation ? <>
                        <span>{observation.observedReleaseId ?? 'Release ID unknown'} {releaseMatches === true ? <Badge variant="success">Matches</Badge> : releaseMatches === false ? <Badge variant="warning">Differs</Badge> : null}</span>
                        <div className="max-w-56 break-all font-mono text-xs text-[var(--text-sub)]">{observation.imageDigest ?? observation.imageId ?? 'Image unknown'}</div>
                      </> : <span className="text-[var(--text-sub)]">Unknown — no host row returned</span>}
                    </TableCell>
                    <TableCell>{observation ? observation.state : 'Unknown'}</TableCell>
                    <TableCell>{observation?.health ?? 'Unknown'}</TableCell>
                    <TableCell>{timeLabel(observation?.startedAt ?? null)}</TableCell>
                  </TableRow>
                );
              });
            })}
            {services.length === 0 ? <TableRow><TableCell colSpan={6}>No approved services were reported for this project.</TableCell></TableRow> : null}
          </TableBody>
        </Table>
      </TableContainer>
      <div className="flex flex-wrap gap-3 text-xs text-[var(--text-sub)]">
        <span>Host {catalog.hostId ?? 'unknown'} · project {project.projectId}</span>
        <span>Sample received {timeLabel(project.receivedAt)}</span>
        <span>Observed digest <code className="break-all">{project.observedDigest ?? 'unknown'}</code></span>
      </div>
    </div>
  );
}

function JobHistory({ resource, selectedProjectId, onOpenJob, onLoadMore }: {
  resource: JobsResource;
  selectedProjectId: string | null;
  onOpenJob: (jobId: string) => void;
  onLoadMore: () => void;
}) {
  return (
    <section aria-labelledby="compose-job-history-title" className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="compose-job-history-title" className="flex items-center gap-2 text-sm font-semibold"><History className="size-4 text-[var(--cf-blue)]" />Compose job history</h3>
          <p className="text-xs text-[var(--text-sub)]">Bounded host/project page. Job status and observed service state are distinct from command acceptance.</p>
        </div>
        <Badge variant={resource.stale ? 'warning' : resource.error ? 'danger' : 'neutral'}>{resource.loading ? 'Loading' : resource.stale ? 'Stale sample' : resource.error ? 'Unavailable' : `${resource.data?.items.length ?? 0} jobs`}</Badge>
      </div>
      {resource.error ? <AlertBanner variant={resource.data ? 'warning' : 'error'} title="Job history unavailable">{resource.error}{resource.data ? ' The last successful page is retained.' : ''}</AlertBanner> : null}
      {!resource.data && resource.loading ? <p role="status" className="text-sm text-[var(--text-sub)]">Loading durable Compose job history…</p> : null}
      {resource.data && resource.data.items.length === 0 ? <p className="rounded border border-dashed border-[var(--border-subtle)] p-4 text-sm text-[var(--text-sub)]">No Compose jobs were returned for {selectedProjectId ? 'this project' : 'the configured host'}.</p> : null}
      {resource.data && resource.data.items.length > 0 ? (
        <TableContainer className="rounded-md border border-[var(--border-subtle)]">
          <Table>
            <TableHeader><TableRow><TableHead>Action / target</TableHead><TableHead>State</TableHead><TableHead>Created</TableHead><TableHead>Actor</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
            <TableBody>
              {resource.data.items.map((job) => (
                <TableRow key={job.jobId}>
                  <TableCell><strong>{actionLabel(job.action)}</strong><div className="font-mono text-xs text-[var(--text-sub)]">{job.releaseId ?? job.serviceId ?? job.projectId} · {job.jobId}</div></TableCell>
                  <TableCell><Badge variant={jobVariant(job.state)}>{composeJobStateLabel(job.state)}</Badge>{job.state === 'UNKNOWN' ? <p className="mt-1 max-w-56 text-xs text-[var(--badge-danger-text)]">Do not resubmit; host reconciliation is required.</p> : null}</TableCell>
                  <TableCell><time dateTime={job.createdAt}>{timeLabel(job.createdAt)}</time></TableCell>
                  <TableCell>{job.actorLabel}</TableCell>
                  <TableCell><Button size="sm" variant="outline" onClick={() => onOpenJob(job.jobId)}>Open</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}
      {resource.data?.hasMore ? <Button size="sm" variant="outline" onClick={onLoadMore} isLoading={resource.loading}>Load more history</Button> : null}
    </section>
  );
}

function PreviewReview({ preview, now, current, submitting }: { preview: ComposePreview; now: number; current: boolean; submitting: boolean }) {
  const secondsLeft = Math.max(0, Math.ceil((Date.parse(preview.expiresAt) - now) / 1000));
  const affected = preview.impact.affectedServices.length ? preview.impact.affectedServices.join(', ') : 'No affected service list returned';
  return (
    <div className="space-y-4">
      {!current ? <AlertBanner variant="error" title="Preview is expired or no longer current">Refresh the host catalog and request a new preview. The submit action is disabled.</AlertBanner> : null}
      <AlertBanner variant={preview.impact.downtime === 'likely' ? 'error' : 'warning'} title={preview.impact.downtime === 'likely' ? 'Service interruption is likely' : 'Service interruption is possible'}>
        This single-server Compose action may restart target containers. The adapter does not guarantee zero downtime, two-replica availability, or preservation of active work.
      </AlertBanner>
      <div className="grid gap-3 sm:grid-cols-2">
        <Fact label="Action" value={actionLabel(preview.action)} />
        <Fact label="Target" value={preview.releaseId ?? preview.serviceId ?? 'Unknown'} />
        <Fact label="Host / project" value={`${preview.hostId} / ${preview.projectId}`} />
        <Fact label="Expected desired revision" value={String(preview.expectedTargetRevision)} />
        <Fact label="Preview expiry" value={`${timeLabel(preview.expiresAt)} · ${secondsLeft}s remaining`} />
        <Fact label="Target release digest" value={preview.targetReleaseDigest ?? 'Not applicable'} mono />
        <Fact label="Target allowlisted services" value={preview.targetServices.join(', ') || 'No service list returned'} />
      </div>
      <div className="space-y-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 text-sm">
        <p><strong>Affected allowlisted services:</strong> {affected}</p>
        <p><strong>Stateful services excluded:</strong> {preview.impact.statefulServicesExcluded ? 'Yes' : 'No — review before proceeding'}</p>
        <p><strong>Operator reason:</strong> {preview.reason}</p>
        <p><strong>Observed digest:</strong> <code className="break-all text-xs">{preview.observedDigest}</code></p>
        <p><strong>Manifest digest:</strong> <code className="break-all text-xs">{preview.manifestDigest}</code></p>
      </div>
      {preview.warnings.length > 0 ? <div className="space-y-1"><p className="text-sm font-semibold">Preview warnings</p><ul className="list-disc space-y-1 pl-5 text-sm">{preview.warnings.map((warning) => <li key={warning}>{warning === 'POSSIBLE_SERVICE_INTERRUPTION' ? 'Service interruption may occur.' : 'Release compatibility was acknowledged in the approved manifest.'}</li>)}</ul></div> : null}
      {!submitting ? <p className="text-xs text-[var(--text-sub)]">Confirm sends one idempotent job request with the preview ID and expected target revision. CAS conflicts invalidate this preview.</p> : <p role="status" className="text-xs text-[var(--text-sub)]">Submitting with the same idempotency key until the server returns a durable job result…</p>}
    </div>
  );
}

function JobDetail({ job, stale }: { job: ComposeJob; stale: boolean }) {
  const observationByService = new Map<string, ComposeObservedService>();
  for (const item of job.observedAfter ?? []) observationByService.set(item.serviceId, item);
  const guidance = composeJobStateGuidance(job.state);
  return (
    <div className="space-y-4">
      {stale ? <AlertBanner variant="warning" title="Showing last successful detail">The last detail refresh failed; check the state again before acting.</AlertBanner> : null}
      {guidance ? <AlertBanner variant={job.state === 'UNKNOWN' ? 'error' : 'warning'} title={composeJobStateLabel(job.state)}>{guidance}</AlertBanner> : null}
      <div className="flex flex-wrap items-center gap-2"><Badge variant={jobVariant(job.state)}>{composeJobStateLabel(job.state)}</Badge><code className="break-all text-xs">{job.jobId}</code></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Fact label="Action" value={actionLabel(job.action)} />
        <Fact label="Target" value={job.releaseId ?? job.serviceId ?? 'Unknown'} />
        <Fact label="Host / project" value={`${job.hostId} / ${job.projectId}`} />
        <Fact label="Actor" value={job.actorLabel} />
        <Fact label="Created" value={timeLabel(job.createdAt)} />
        <Fact label="Started / completed" value={`${timeLabel(job.startedAt)} / ${timeLabel(job.completedAt)}`} />
        <Fact label="Desired revision" value={`${job.expectedTargetRevision} → ${job.targetRevision}`} />
        <Fact label="Durable state version" value={String(job.stateVersion)} />
        <Fact label="Observed before digest" value={job.observedBeforeDigest} mono />
        <Fact label="Observed after digest" value={job.observedAfterDigest ?? 'Unknown'} mono />
        <Fact label="Uncertainty reason" value={job.uncertainReason ?? 'None reported'} />
      </div>
      <div className="rounded border border-[var(--border-subtle)] p-3">
        <h3 className="text-sm font-semibold">Per-service outcome</h3>
        {job.perServiceOutcomes.length > 0 ? (
          <ul className="mt-2 divide-y divide-[var(--border-subtle)]">
            {job.perServiceOutcomes.map((outcome) => {
              const after = observationByService.get(outcome.serviceId);
              return <li key={outcome.serviceId} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"><span><code>{outcome.serviceId}</code>{outcome.errorCode ? <span className="ml-2 text-xs text-[var(--text-sub)]">{composeSafeErrorMessage(outcome.errorCode)}</span> : null}{after ? <span className="ml-2 text-xs text-[var(--text-sub)]">observed {after.state} · {after.health ?? 'health unknown'}</span> : null}</span><Badge variant={outcome.status === 'SUCCEEDED' ? 'success' : outcome.status === 'UNKNOWN' ? 'danger' : outcome.status === 'FAILED' ? 'danger' : 'neutral'}>{outcome.status}</Badge></li>;
            })}
          </ul>
        ) : <p className="mt-2 text-sm text-[var(--text-sub)]">No per-service outcome has been reported yet.</p>}
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">Safe observed service state</summary>
        <div className="mt-2 space-y-3">
          <ObservationList title="Before" items={job.observedBefore} />
          {job.observedAfter ? <ObservationList title="After" items={job.observedAfter} /> : <p className="text-sm text-[var(--text-sub)]">No after-state was confirmed.</p>}
        </div>
      </details>
      <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 text-sm"><strong>Recorded reason</strong><p className="mt-1 whitespace-pre-wrap break-words">{job.reason}</p></div>
    </div>
  );
}

function ObservationList({ title, items }: { title: string; items: ComposeJob['observedBefore'] }) {
  return <div className="rounded border border-[var(--border-subtle)] p-3"><h4 className="text-xs font-semibold">{title} observations</h4>{items.length ? <ul className="mt-2 space-y-1">{items.map((item) => <li key={`${item.serviceId}:${item.containerId ?? ''}`} className="break-words text-xs"><code>{item.serviceId}</code> · {item.state} · {item.health ?? 'health unknown'} · {item.imageDigest ?? item.imageId ?? 'image unknown'} · release {item.observedReleaseId ?? 'unknown'}</li>)}</ul> : <p className="mt-1 text-xs text-[var(--text-sub)]">No service observations recorded.</p>}</div>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0 rounded border border-[var(--border-subtle)] p-3"><span className="block text-xs text-[var(--text-sub)]">{label}</span><span className={`mt-1 block break-words text-sm ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{value}</span></div>;
}
