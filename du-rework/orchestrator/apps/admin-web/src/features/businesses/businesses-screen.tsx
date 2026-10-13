import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner, DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { ConfirmDialog } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TablePagination,
  TableRow,
} from '@/components/ui/table';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type AdminWebSession,
  type BusinessPage,
  type BusinessVersions,
} from '@/lib/api';
import type { Loadable, PaneState } from '@/features/overview/state';
import { activationRevisionMatches, parseBusinessPage, parseBusinessVersions } from './state';
import { BusinessDetailCockpit } from './business-detail-cockpit';

type VersionAdminAction = 'activate' | 'deactivate' | 'pre-drain' | 'pre-drain/cancel';
interface PendingVersionAction {
  businessId: string;
  version: string;
  action: VersionAdminAction;
  expectedActivationRevision: number | null;
}

/** Business registry and version admission controls. */
export function BusinessesScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [page, setPage] = useState<Loadable<BusinessPage>>({ kind: 'loading' });
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [paging, setPaging] = useState(false);
  const [failedPageRequest, setFailedPageRequest] = useState<{ index: number; cursor?: string } | null>(null);
  const listRequestGeneration = useRef(0);
  const pageRequestInFlight = useRef(false);
  const [versions, setVersions] = useState<Loadable<BusinessVersions> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<AdminApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [pendingVersionAction, setPendingVersionAction] = useState<PendingVersionAction | null>(null);

  const canManageBusiness = session?.role === 'admin' && !session.localUser && session.principal.kind === 'platform';

  const load = useCallback(async (cursor?: string, preserveRows = false, requestedIndex = 0): Promise<number | null> => {
    const generation = ++listRequestGeneration.current;
    const isCurrent = (): boolean => generation === listRequestGeneration.current;
    const fail = (problem: AdminApiProblem): void => {
      if (!isCurrent()) return;
      setFailedPageRequest({ index: requestedIndex, ...(cursor === undefined ? {} : { cursor }) });
      setPage({ kind: 'failed', problem });
    };
    setPaging(true);
    if (!preserveRows) setPage({ kind: 'loading' });
    try {
      // Bootstrap the CSRF proof on this client first — the version actions ride it.
      const sessionResult = await client.getSession();
      if (!isCurrent()) return null;
      if (!sessionResult.ok) {
        setSession(null);
        fail(sessionResult.problem);
        return null;
      }
      setSession(sessionResult.data);
      const result = await client.listBusinesses({ limit: '20', ...(cursor ? { cursor } : {}) });
      if (!isCurrent()) return null;
      if (!result.ok) {
        fail(result.problem);
        return null;
      }
      const parsed = parseBusinessPage(result.data);
      if (parsed === null) {
        fail({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable business page.' });
        return null;
      }
      setPage({ kind: 'ready', data: parsed });
      setFailedPageRequest(null);
      setProblem(null);
      return generation;
    } catch {
      fail({ status: 0, code: 'NETWORK_ERROR', title: 'Failed to load the business registry.' });
      return null;
    } finally {
      if (isCurrent()) setPaging(false);
    }
  }, [client]);

  useEffect(() => {
    void load(undefined, false, 0);
  }, [load]);

  async function goToPage(nextIndex: number, cursor: string | undefined, preserveRows = true): Promise<void> {
    if (paging || busy || pageRequestInFlight.current || nextIndex < 0) return;
    pageRequestInFlight.current = true;
    try {
      const generation = await load(cursor, preserveRows, nextIndex);
      if (generation === null || generation !== listRequestGeneration.current) return;
      setPageIndex(nextIndex);
      if (nextIndex > pageIndex) setCursorHistory((history) => [...history.slice(0, nextIndex), cursor]);
    } finally {
      pageRequestInFlight.current = false;
    }
  }

  function goNext(): void {
    if (page.kind !== 'ready' || page.data.nextCursor === null || paging) return;
    const nextIndex = pageIndex + 1;
    const nextCursor = page.data.nextCursor;
    void goToPage(nextIndex, nextCursor);
  }

  function goPrevious(): void {
    if (paging || pageIndex === 0) return;
    void goToPage(pageIndex - 1, cursorHistory[pageIndex - 1]);
  }

  function retryFailedPage(): void {
    const retry = failedPageRequest ?? { index: pageIndex, cursor: cursorHistory[pageIndex] };
    void goToPage(retry.index, retry.cursor, false);
  }

  function refreshFirstPage(): void {
    setCursorHistory([undefined]);
    setPageIndex(0);
    setFailedPageRequest(null);
    void load(undefined, false, 0);
  }

  async function openVersions(businessId: string): Promise<void> {
    setNotice(null);
    setProblem(null);
    setVersions({ kind: 'loading' });
    const result = await client.getBusinessVersions(businessId);
    if (!result.ok) {
      setVersions({ kind: 'failed', problem: result.problem });
      return;
    }
    const parsed = parseBusinessVersions(result.data);
    setVersions(
      parsed === null
        ? { kind: 'failed', problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable versions payload.' } }
        : { kind: 'ready', data: parsed },
    );
  }

  async function executeVersionAction(): Promise<void> {
    const pending = pendingVersionAction;
    if (!pending || !canManageBusiness) return;
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      const refreshVersions = async (): Promise<BusinessVersions | null> => {
        const response = await client.getBusinessVersions(pending.businessId);
        if (!response.ok) {
          setProblem(response.problem);
          return null;
        }
        const parsed = parseBusinessVersions(response.data);
        if (!parsed) {
          setProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'Could not read the current business activation revision.' });
          return null;
        }
        setVersions({ kind: 'ready', data: parsed });
        return parsed;
      };

      let current = await refreshVersions();
      if (!current) return;
      const displayedRevision = pending.expectedActivationRevision;
      if (!activationRevisionMatches(displayedRevision, current.activationRevision)) {
        setProblem({
          status: 409,
          code: displayedRevision === null ? 'ACTIVATION_REVISION_UNAVAILABLE' : 'ACTIVATION_REVISION_CHANGED',
          title: displayedRevision === null
            ? 'The activation revision was unavailable when this confirmation opened. Review the refreshed registry and reopen the action.'
            : `Activation changed from revision ${displayedRevision} to ${current.activationRevision ?? 'unavailable'} after this confirmation opened. Review the refreshed registry and reopen the action.`,
        });
        return;
      }
      let expectedActivationRevision = displayedRevision;
      if (pending.action === 'activate') {
        const row = current.rows.find((candidate) => candidate.version === pending.version);
        if (!row) {
          setProblem({ status: 404, code: 'VERSION_NOT_FOUND', title: 'The selected version is no longer registered. The current registry has been reloaded.' });
          return;
        }
        if (row.status !== 'ENABLED') {
          const enabled = await client.businessVersionAction(pending.businessId, pending.version, 'enable', {
            expectedActivationRevision,
          });
          if (!enabled.ok) {
            setProblem(enabled.problem);
            return;
          }
          const enabledRevision = typeof enabled.data.activationRevision === 'number'
            && Number.isSafeInteger(enabled.data.activationRevision) && enabled.data.activationRevision > 0
            ? enabled.data.activationRevision
            : null;
          if (enabledRevision === null) {
            setProblem({ status: 502, code: 'ACTIVATION_REVISION_UNAVAILABLE', title: 'The version was enabled, but the server did not return its new activation revision. Review the refreshed registry before continuing.' });
            await refreshVersions();
            return;
          }
          current = await refreshVersions();
          if (!current) return;
          if (!activationRevisionMatches(enabledRevision, current.activationRevision)) {
            setProblem({
              status: 409,
              code: 'ACTIVATION_REVISION_CHANGED',
              title: `Activation changed from revision ${enabledRevision} after enabling the version. Review the refreshed registry and reopen the action.`,
            });
            return;
          }
          expectedActivationRevision = enabledRevision;
        }
        if (current.submissionsPaused === true && current.remainingOperations !== 0) {
          setProblem({ status: 409, code: 'PRE_DRAIN_NOT_COMPLETE', title: 'Pre-drain is still active. Refresh until remaining operations reaches zero before finalizing the version switch.' });
          return;
        }
      }
      const result = await client.businessVersionAction(pending.businessId, pending.version, pending.action, {
        expectedActivationRevision,
      });
      if (!result.ok) {
        if (result.status === 409) {
          await refreshVersions();
          setProblem({ ...result.problem, title: pending.action === 'activate' || pending.action === 'deactivate'
            ? 'Activation changed while this page was open. The registry has been refreshed; review the new active version and confirm again.'
            : 'Pre-drain state changed while this page was open. The registry has been refreshed; review the current state before trying again.' });
          return;
        }
        setProblem(result.problem);
        return;
      }
      const refreshed = await refreshVersions();
      await load(cursorHistory[pageIndex], true, pageIndex);
      if (pending.action === 'pre-drain') {
        const remaining = typeof result.data.remainingOperations === 'number' ? result.data.remainingOperations : refreshed?.remainingOperations;
        setNotice(`Submissions are paused for ${pending.version}. ${remaining === null || remaining === undefined ? 'Remaining operations are not reported.' : `${remaining} operation${remaining === 1 ? '' : 's'} remain before cutover.`}`);
      } else if (pending.action === 'pre-drain/cancel') {
        setNotice(`Pre-drain cancelled; submissions resumed on ${refreshed?.activeVersion ?? pending.version}.`);
      } else if (pending.action === 'activate') {
        setNotice(`Version ${pending.version} is now active for new submissions.`);
      } else {
        setNotice(`Version ${pending.version} is no longer active for new submissions.`);
      }
    } finally {
      setBusy(false);
      setPendingVersionAction(null);
    }
  }

  function queueVersionAction(
    action: VersionAdminAction,
    businessId: string,
    version: string,
    expectedActivationRevision: number | null,
  ): void {
    if (!canManageBusiness || busy) return;
    setPendingVersionAction({ action, businessId, version, expectedActivationRevision });
  }

  const pendingVersionActionTitle = pendingVersionAction === null
    ? ''
    : pendingVersionAction.action === 'activate'
      ? `Activate ${pendingVersionAction.version} for new submissions?`
      : pendingVersionAction.action === 'deactivate'
        ? `Deactivate ${pendingVersionAction.version}?`
        : pendingVersionAction.action === 'pre-drain'
          ? `Pause submissions for pre-drain?`
          : `Cancel pre-drain?`;
  const pendingVersionActionDescription = pendingVersionAction === null
    ? ''
    : pendingVersionAction.action === 'activate'
      ? 'This is a strict version switch. Unclaimed retry and child tasks will be parked for admission. Handlers already running on the old version may finish, while their operation can remain incomplete until a compatible version is active again. To let work finish first, start pre-drain on the current version, wait for the remaining operation count to reach zero, then activate this version.'
      : pendingVersionAction.action === 'deactivate'
        ? 'New submissions will no longer be admitted to this version. Unclaimed work may be parked, and in-flight operations can remain incomplete until a compatible version is active.'
        : pendingVersionAction.action === 'pre-drain'
          ? 'New submissions will pause while the active version drains. Existing operations can finish; refresh the remaining operation count and activate the target version only when it reaches zero.'
          : 'This resumes new submissions on the currently active version. The action proceeds only if the activation revision shown when you opened this confirmation is still current.';

  async function setBusinessEnabled(businessId: string, enabled: boolean, lifecycleRevision: number | null): Promise<void> {
    if (!canManageBusiness || lifecycleRevision === null) return;
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      const result = await client.setBusinessEnabled(businessId, { enabled, expectedLifecycleRevision: lifecycleRevision });
      if (!result.ok) {
        if (result.status === 409) {
          setProblem({ ...result.problem, title: 'Business lifecycle changed while this page was open. The registry has been reloaded.' });
          await load(cursorHistory[pageIndex], true, pageIndex);
          if (versions?.kind === 'ready' && versions.data.businessId === businessId) await openVersions(businessId);
          return;
        }
        setProblem(result.problem);
        return;
      }
      setNotice(`Business intake ${result.data.enabled ? 'enabled' : 'disabled'} (lifecycle revision ${result.data.lifecycleRevision}).`);
      await load(cursorHistory[pageIndex], true, pageIndex);
      if (versions?.kind === 'ready' && versions.data.businessId === businessId) await openVersions(businessId);
    } finally {
      setBusy(false);
    }
  }

  const pane: PaneState<BusinessPage> | null =
    page.kind === 'loading'
      ? { kind: 'loading' }
      : page.kind === 'failed'
        ? page.problem.status === 403
          ? { kind: 'denied', problem: page.problem }
          : { kind: 'error', problem: page.problem }
        : page.data.items.length === 0
          ? { kind: 'empty' }
          : { kind: 'ready', data: page.data };

  const readyPage = pane?.kind === 'ready' ? pane.data : null;

  return (
    <section aria-labelledby="businesses-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="businesses-title" className="text-lg font-semibold">
          Businesses
        </h1>
        <Badge variant="neutral">registry</Badge>
      </div>

      {problem !== null ? (
        <AlertBanner variant="error" title={problem.title ?? 'The registry rejected the request.'}>
          {problem.status} · {problem.code ?? 'ERROR'}
        </AlertBanner>
      ) : null}
      {notice !== null ? (
        <AlertBanner variant="success" title="Registry">
          {notice}
        </AlertBanner>
      ) : null}

      {pane?.kind === 'loading' ? <LoadingState title="Loading businesses…" /> : null}
      {pane?.kind === 'denied' ? (
        <DeniedState
          title="Access denied"
          description={pane.problem.title ?? 'The business registry is platform-scoped (admin session required).'}
        />
      ) : null}
      {pane?.kind === 'error' ? (
        <ErrorState
          title={pane.problem.title ?? 'Failed to load the registry.'}
          statusCode={pane.problem.status}
          error={pane.problem.code}
          onRetry={retryFailedPage}
        />
      ) : null}
      {pane?.kind === 'empty' ? (
        <EmptyState title="No businesses" description="The registry has no rows yet." actionText="Refresh" onAction={refreshFirstPage} />
      ) : null}
      {pane?.kind === 'ready' ? (
        <>
          <TableContainer maxHeight={440} aria-label="Loaded business page">
          <Table aria-label="Businesses" density="compact">
            <TableHeader sticky>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Default version for new submissions</TableHead>
                <TableHead>Business intake</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pane.data.items.map((row) => {
                return (
                  <TableRow key={row.businessId}>
                    <TableCell className="font-mono text-xs font-medium">{row.businessId}</TableCell>
                    <TableCell className="text-xs">
                      {row.activeVersion !== null ? (
                        <span className="font-mono text-xs font-semibold">{row.activeVersion}</span>
                      ) : (
                        <span className="text-[var(--text-sub)]">None</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.enabled === true ? 'success' : row.enabled === false ? 'neutral' : 'warning'} dot>
                        {row.enabled === true ? 'Enabled' : row.enabled === false ? 'Disabled' : 'Unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">{row.updatedAt ?? '—'}</TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-wrap gap-2">
                      {canManageBusiness ? (
                        <Button size="sm" variant={row.enabled === true ? 'outline' : 'primary'} disabled={busy || paging || row.enabled === null || row.lifecycleRevision === null} onClick={() => void setBusinessEnabled(row.businessId, row.enabled !== true, row.lifecycleRevision)}>
                          {row.enabled === true ? 'Disable business' : 'Enable business'}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => void openVersions(row.businessId)}>
                        Versions
                      </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </TableContainer>
        <TablePagination
          ariaLabel="Business registry pages"
          hasPreviousPage={pageIndex > 0}
          hasNextPage={readyPage !== null && readyPage.nextCursor !== null}
          onPreviousPage={goPrevious}
          onNextPage={goNext}
          pending={paging}
          status={`Page ${pageIndex + 1} · ${readyPage?.items.length ?? 0} businesses shown; ${readyPage?.total ?? 0} total reported`}
          className="justify-end"
        />
        </>
      ) : null}

      {versions?.kind === 'loading' ? <LoadingState title="Loading versions…" /> : null}
      {versions?.kind === 'failed' ? (
        <ErrorState
          title={versions.problem.title ?? 'Failed to load versions.'}
          statusCode={versions.problem.status}
          error={versions.problem.code}
        />
      ) : null}
      {versions?.kind === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle>Versions — {versions.data.businessId}</CardTitle>
            <CardDescription>
              Business intake: <strong>{versions.data.enabled === true ? 'Enabled' : versions.data.enabled === false ? 'Disabled' : 'Unknown'}</strong> · default version for new submissions: <span className="font-mono font-medium">{versions.data.activeVersion ?? 'None'}</span> · activation revision: <strong>{versions.data.activationRevision ?? 'Unavailable'}</strong>. Parked counts are unique nonterminal tasks; draining counts are unexpired old-version leases.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {versions.data.submissionsPaused === true ? <AlertBanner variant="warning" title={`Submissions paused for ${versions.data.preDrainVersion ?? versions.data.activeVersion ?? 'the active version'}`}>
              {versions.data.remainingOperations === null || versions.data.remainingOperations === undefined
                ? 'Remaining operations are not reported. Refresh the status before finalizing the version switch.'
                : `${versions.data.remainingOperations.toLocaleString()} operation${versions.data.remainingOperations === 1 ? '' : 's'} remain before cutover.`}
              <Button size="sm" variant="outline" className="ml-3" disabled={busy} onClick={() => void openVersions(versions.data.businessId)}>Refresh cutover status</Button>
            </AlertBanner> : null}
            {versions.data.rows.length === 0 ? (
              <p className="text-sm text-[var(--text-sub)]">No versions registered.</p>
            ) : (
              <TableContainer maxHeight={360} aria-label="Loaded business versions">
                <Table aria-label="Business versions" density="compact">
                  <TableHeader sticky>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>Version state</TableHead>
                      <TableHead>Default pointer</TableHead>
                      <TableHead>Admission</TableHead>
                      <TableHead>Parked tasks</TableHead>
                      <TableHead>Draining leases</TableHead>
                      <TableHead>Parked reasons</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.data.rows.map((row) => (
                      <TableRow key={row.version}>
                        <TableCell className="font-mono text-xs font-medium">{row.version}</TableCell>
                        <TableCell>
                          <Badge variant={row.status === 'ENABLED' ? 'success' : row.status === 'DRAINING' ? 'warning' : 'neutral'} dot>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{row.isActive ? 'Default' : 'Not default'}</TableCell>
                        <TableCell>
                          <Badge variant={row.admissionEligible === true ? 'success' : row.admissionEligible === false ? 'warning' : 'neutral'}>
                            {row.admissionEligible === true ? 'Eligible' : row.admissionReason ?? 'Unknown'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">{row.parkedTaskCount?.toLocaleString() ?? 'Unavailable'}</TableCell>
                        <TableCell className="text-xs tabular-nums" title="Unexpired RUNNING leases for versions other than the active version">
                          {row.drainingTaskCount?.toLocaleString() ?? 'Unavailable'}
                        </TableCell>
                        <TableCell className="max-w-64 text-xs">
                          {row.parkedReasons === null || row.parkedReasons === undefined
                            ? 'Unavailable'
                            : Object.keys(row.parkedReasons).length === 0
                              ? 'None'
                              : Object.entries(row.parkedReasons).sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason}: ${count.toLocaleString()}`).join(' · ')}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {canManageBusiness ? row.isActive ? <>
                              <Button size="sm" variant="outline" disabled={busy} onClick={() => queueVersionAction('deactivate', versions.data.businessId, row.version, versions.data.activationRevision ?? null)}>
                                Deactivate
                              </Button>
                              {versions.data.submissionsPaused === true
                                ? <Button size="sm" variant="outline" disabled={busy} onClick={() => queueVersionAction('pre-drain/cancel', versions.data.businessId, row.version, versions.data.activationRevision ?? null)}>Cancel pre-drain</Button>
                                : <Button size="sm" variant="outline" disabled={busy} onClick={() => queueVersionAction('pre-drain', versions.data.businessId, row.version, versions.data.activationRevision ?? null)}>Pre-drain</Button>}
                            </> : <Button size="sm" variant="primary" disabled={busy || (versions.data.submissionsPaused === true && versions.data.remainingOperations !== 0)} title={versions.data.submissionsPaused === true && versions.data.remainingOperations !== 0 ? 'Refresh after pre-drain reaches zero operations.' : undefined} onClick={() => queueVersionAction('activate', versions.data.businessId, row.version, versions.data.activationRevision ?? null)}>
                              Activate for submissions
                            </Button> : <span className="text-xs text-[var(--text-sub)]">Read only</span>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* BIZ-09: the detail cockpit. Mounted only once a business was opened,
          because every card is a real read keyed on that businessId. */}
      {versions?.kind === 'ready' && versions.data.businessId.length > 0 ? (
        <BusinessDetailCockpit key={versions.data.businessId} businessId={versions.data.businessId} />
      ) : null}

      <ConfirmDialog
        open={pendingVersionAction !== null}
        onOpenChange={(open) => { if (!open && !busy) setPendingVersionAction(null); }}
        title={pendingVersionActionTitle}
        description={pendingVersionActionDescription}
        confirmText={pendingVersionAction?.action === 'activate' ? 'Activate version' : pendingVersionAction?.action === 'pre-drain' ? 'Pause submissions' : pendingVersionAction?.action === 'pre-drain/cancel' ? 'Resume submissions' : 'Deactivate version'}
        variant={pendingVersionAction?.action === 'deactivate' ? 'destructive' : 'primary'}
        isLoading={busy}
        onConfirm={() => void executeVersionAction()}
        onCancel={() => setPendingVersionAction(null)}
      />
    </section>
  );
}
