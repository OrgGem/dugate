import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeniedState, EmptyState, ErrorState, LoadingState, AlertBanner } from '@/components/ui/state-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { createAdminApiClient, type AdminApiProblem, type OperationDetail, type OperationWire, type OperationsPage } from '@/lib/api';
import { elapsedMs, operationStateVariant, parseOperationDetail, parseOperationsPage } from './state';
import type { Loadable, PaneState } from '@/features/overview/state';

/** Request monitoring and audited controls through the same-origin BFF. */
const terminalStates = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : 'Unknown';
const formatDuration = (ms: number | null): string => ms === null ? 'Unknown' : `${(ms / 1000).toFixed(1)} s`;

export function OperationsScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const [cursor, setCursor] = useState<string | null>(null);
  const [limit, setLimit] = useState('20');
  const [role, setRole] = useState<string>('viewer');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  useEffect(() => { void client.getSession().then(r => { if (r.ok) setRole(r.data.role); }); }, [client]);
  const [stateFilter, setStateFilter] = useState('ALL');
  const [page, setPage] = useState<Loadable<OperationsPage>>({ kind: 'loading' });
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [detailProblem, setDetailProblem] = useState<AdminApiProblem | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++listRequest.current;
    ++detailRequest.current;
    setPage({ kind: 'loading' });
    setDetail(null);
    setDetailProblem(null);
    const result = await client.listOperations({ limit, state: stateFilter, sort: 'created_at:desc', ...(cursor ? { cursor } : {}) });
    if (seq !== listRequest.current) return;
    if (!result.ok) {
      setPage({ kind: 'failed', problem: result.problem });
      return;
    }
    const parsed = parseOperationsPage(result.data);
    setPage(
      parsed === null
        ? { kind: 'failed', problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable operations page.' } }
        : { kind: 'ready', data: parsed },
    );
  }, [client, stateFilter, cursor, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(operationId: string): Promise<void> {
    const seq = ++detailRequest.current;
    setDetail(null);
    setDetailProblem(null);
    const result = await client.getOperation(operationId);
    if (seq !== detailRequest.current) return;
    if (!result.ok) {
      setDetailProblem(result.problem);
      return;
    }
    if (seq !== detailRequest.current) return;
    const parsed = parseOperationDetail(result.data);
    if (!parsed) setDetailProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable request detail.' });
    setDetail(parsed);
  }

  async function control(op: OperationWire, action: 'cancel' | 'retry'): Promise<void> {
    if (busy || !window.confirm(action === 'cancel'
      ? 'Stop this request? Work already completed cannot be undone.'
      : 'Retry this request as a new operation? External provider calls may run again.')) return;
    setBusy(true); setNotice(null); setDetailProblem(null);
    const session = await client.getSession();
    if (!session.ok) { setDetailProblem(session.problem); setBusy(false); return; }
    const scope = `${op.id}:${action}`;
    const key = actionKeys.current.get(scope) ?? crypto.randomUUID();
    actionKeys.current.set(scope, key);
    const result = await client.operationAction(op.id, action, key);
    setBusy(false);
    if (!result.ok) { setDetailProblem(result.problem); return; }
    actionKeys.current.delete(scope);
    setNotice(action === 'cancel'
      ? result.data.state === 'CANCELLED' ? 'Request stopped.' : `Request state: ${String(result.data.state ?? 'unknown')}`
      : `${result.data.replayed === true ? 'Retry already in progress' : 'Retry created'}: ${String(result.data.operationId ?? '')}`);
    await load();
    await openDetail(typeof result.data.operationId === 'string' ? result.data.operationId : op.id);
  }

  const pane: PaneState<OperationsPage> | null =
    page.kind === 'loading'
      ? { kind: 'loading' }
      : page.kind === 'failed'
        ? page.problem.status === 403
          ? { kind: 'denied', problem: page.problem }
          : { kind: 'error', problem: page.problem }
        : page.data.items.length === 0
          ? { kind: 'empty' }
          : { kind: 'ready', data: page.data };

  return (
    <section aria-labelledby="operations-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="operations-title" className="text-lg font-semibold">
          Operations
        </h1>
        <Badge variant="neutral">Newest first</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>List</CardTitle>
          <CardDescription>Requests in your authorized scope, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-[12rem]">
            <label className="text-xs font-semibold text-[var(--text-main)]" htmlFor="ops-state">
              State
            </label>
            <select
              id="ops-state"
              className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm"
              value={stateFilter}
              onChange={(e) => { setCursor(null); setStateFilter(e.target.value); }}
            >
              {['ALL', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div><label htmlFor="ops-limit" className="text-xs">Requests per page</label>
            <select id="ops-limit" value={limit} onChange={e => { setCursor(null); setLimit(e.target.value); }} className="ml-2 rounded border p-2">
              {['20', '50', '100'].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <Button disabled={busy} onClick={() => void load()}>
            Refresh
          </Button>
        </CardContent>
      </Card>

      {pane?.kind === 'loading' ? <LoadingState title="Loading operations…" /> : null}
      {pane?.kind === 'denied' ? (
        <DeniedState title="Access denied" description={pane.problem.title ?? 'Not authorized for this tenant scope.'} />
      ) : null}
      {pane?.kind === 'error' ? (
        <ErrorState
          title={pane.problem.title ?? 'Failed to load operations.'}
          statusCode={pane.problem.status}
          error={pane.problem.code}
          onRetry={() => void load()}
        />
      ) : null}
      {pane?.kind === 'empty' ? (
        <EmptyState title="No operations" description="No operations match this filter in the session's scope." actionText="Refresh" onAction={() => void load()} />
      ) : null}
      {pane?.kind === 'ready' ? (
        <TableContainer>
          <Table aria-label="Operations">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Business / action</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>Total elapsed</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pane.data.items.map((op) => (
                <TableRow key={op.id}>
                  <TableCell className="font-mono text-xs">
                    <button
                      type="button"
                      className="text-[var(--cf-blue)] underline"
                      onClick={() => void openDetail(op.id)}
                    >
                      {op.id.slice(0, 8)}…
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={operationStateVariant(op.state)} dot>
                      {op.state}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {op.businessId ?? '—'} · {op.action ?? '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">{formatTime(op.createdAt)}</TableCell>
                  <TableCell className="text-xs">{terminalStates.includes(op.state) ? formatTime(op.completedAt) : 'In progress'}</TableCell>
                  <TableCell className="text-xs">{formatDuration(elapsedMs(op, new Date().toISOString()))}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => void openDetail(op.id)}>Detail</Button>
                      <Button size="sm" variant="outline" disabled={busy || role === 'viewer' || terminalStates.includes(op.state) || op.state === 'CANCEL_REQUESTED'} onClick={() => void control(op, 'cancel')}>Stop</Button>
                      <Button size="sm" variant="outline" disabled={busy || role !== 'admin' || !['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(op.state)} onClick={() => void control(op, 'retry')}>Retry</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}

      {pane?.kind === 'ready' || pane?.kind === 'empty' ? (
        <div className="flex flex-wrap items-center gap-3" aria-label="Request pagination">
          <Button disabled={busy || page.kind !== 'ready' || !page.data.prevCursor} onClick={() => { if (page.kind === 'ready') setCursor(page.data.prevCursor); }}>Previous</Button>
          <Button disabled={busy || page.kind !== 'ready' || !page.data.nextCursor} onClick={() => { if (page.kind === 'ready') setCursor(page.data.nextCursor); }}>Next</Button>
          <Button disabled={busy || cursor === null} onClick={() => setCursor(null)}>Newest</Button>
          {page.kind === 'ready' ? <span className="text-sm">{page.data.items.length} shown · {page.data.total} total</span> : null}
        </div>
      ) : null}
      {notice ? <AlertBanner variant="info" title={notice}>Refresh or open the request detail to inspect its current state.</AlertBanner> : null}

      {detailProblem !== null ? (
        <AlertBanner variant="error" title={detailProblem.title ?? 'Failed to load the operation detail.'}>
          {detailProblem.status} · {detailProblem.code ?? 'ERROR'}
        </AlertBanner>
      ) : null}

      {detail !== null ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Detail</CardTitle>
              {detail.operation ? (
                <Badge variant={operationStateVariant(detail.operation.state)} dot>
                  {detail.operation.state}
                </Badge>
              ) : null}
            </div>
            <CardDescription>Request input, lifecycle timing, errors and results.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {detail.operation ? (
              <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm min-w-0">
                <dt className="text-[var(--text-sub)]">ID</dt>
                <dd className="break-all font-mono text-xs">{detail.operation.id}</dd>
                <dt>Created</dt><dd>{formatTime(detail.operation.createdAt)}</dd>
                <dt>Started</dt><dd>{formatTime(detail.operation.startedAt)}</dd>
                <dt>Finished</dt><dd>{formatTime(detail.operation.completedAt)}</dd>
                <dt>Total elapsed (including queue/waits)</dt><dd>{formatDuration(elapsedMs(detail.operation, detail.serverNow ?? new Date().toISOString()))}</dd>
                <dt>Execution elapsed (including waits)</dt><dd>{formatDuration(elapsedMs(detail.operation, detail.serverNow ?? new Date().toISOString(), true))}</dd>
                <dt>Deadline</dt><dd>{formatTime(detail.operation.deadlineAt)}</dd>
                <dt>Error code</dt><dd>{detail.operation.errorCode ?? '\u2014'}</dd>
                <dt>Retry of</dt><dd>{detail.operation.retryOf ?? '\u2014'}</dd>
                <dt className="text-[var(--text-sub)]">Tenant</dt>
                <dd className="break-all font-mono text-xs">{detail.operation.tenantId ?? '—'}</dd>
                <dt className="text-[var(--text-sub)]">Business / action</dt>
                <dd>
                  {detail.operation.businessId ?? '—'} · {detail.operation.action ?? '—'}
                </dd>
              </dl>
            ) : null}

            <p className="text-xs text-[var(--text-sub)]">Elapsed time includes waiting and retries within this operation. File retention does not change its finish time. Historical unrecorded times are shown as Unknown.</p>
            {detail.tasks && detail.tasks.length > 0 ? (
              <TableContainer><Table aria-label="Request tasks">
                <TableHeader><TableRow><TableHead>Task</TableHead><TableHead>State</TableHead><TableHead>Attempt / maximum</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
                <TableBody>{detail.tasks.map(task => <TableRow key={task.id}>
                  <TableCell>{task.taskKey || task.kind}</TableCell><TableCell>{task.state}</TableCell>
                  <TableCell>{task.attempt} / {task.maxAttempts}</TableCell><TableCell>{task.errorCode ?? '\u2014'}</TableCell>
                </TableRow>)}</TableBody>
              </Table></TableContainer>
            ) : null}
            <div>
              <strong className="text-sm">Artifacts</strong>
              {detail.artifacts.length === 0 ? (
                <p className="text-xs text-[var(--text-sub)]">No artifacts reported for this operation.</p>
              ) : (
                <TableContainer className="mt-2">
                  <Table aria-label="Operation artifacts">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Role</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Content type</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.artifacts.map((artifact, index) => (
                        <TableRow key={`${artifact.role}:${index}`}>
                          <TableCell className="text-xs">{artifact.role}</TableCell>
                          <TableCell className="text-xs">{artifact.status}</TableCell>
                          <TableCell className="text-xs text-[var(--text-sub)]">{artifact.contentType ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </div>

            {detail.requestInput ? (
              <div className="space-y-2">
                <strong className="text-sm">Request input</strong>
                <p className="text-xs text-[var(--text-sub)]">
                  {detail.requestInput.status === 'REDACTED' ? `Redacted on the server using ${detail.requestInput.ruleCount} profile rules.`
                    : detail.requestInput.status === 'HIDDEN' ? 'Input is hidden because a safe display could not be produced.'
                    : 'No redaction rules are configured for this request profile.'}
                </p>
                <pre aria-label="Request input" className="max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">
                  {JSON.stringify(detail.requestInput.data, null, 2)}
                </pre>
              </div>
            ) : null}

            {detail.resultSummary !== null ? (
              <pre className="max-h-48 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] p-3 text-xs">
                {detail.resultSummary}
              </pre>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
