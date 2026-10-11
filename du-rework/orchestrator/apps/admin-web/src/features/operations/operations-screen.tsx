import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeniedState, EmptyState, ErrorState, LoadingState, AlertBanner } from '@/components/ui/state-panel';
import { useTenant } from '@/lib/tenant-context';
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
import {
  buildOperationsQuery,
  elapsedMs,
  operationStateVariant,
  operationsCursorIsStale,
  operationsPopulation,
  operationsWindowInvalid,
  parseOperationDetail,
  parseOperationsPage,
  type ParsedOperationsPage,
} from './state';
import type { Loadable, PaneState } from '@/features/overview/state';

/** Request monitoring and audited controls through the same-origin BFF. */
const terminalStates = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const formatTime = (value: string | null | undefined): string => value ? new Date(value).toLocaleString() : 'Unknown';
const formatDuration = (ms: number | null): string => ms === null ? 'Unknown' : `${(ms / 1000).toFixed(1)} s`;

/** OPU-OPS-3: correlationId lives on the payload (operation node or flat). */
const correlationFromRaw = (raw: unknown): string | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const source = record.operation && typeof record.operation === 'object'
    ? record.operation as Record<string, unknown>
    : record;
  return typeof source.correlationId === 'string' && source.correlationId.length > 0 ? source.correlationId : null;
};

export function OperationsScreen() {
  const { tenantId: globalTenantId, tenant } = useTenant();
  const client = useMemo(() => createAdminApiClient(), []);
  const [cursor, setCursor] = useState<string | null>(null);
  const [limit, setLimit] = useState('20');
  const [role, setRole] = useState<string>('viewer');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkCancelFailures, setBulkCancelFailures] = useState<Array<{ operationId: string; problem: AdminApiProblem }>>([]);
  const actionKeys = useRef(new Map<string, string>());
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  useEffect(() => { void client.getSession().then(r => { if (r.ok) setRole(r.data.role); }); }, [client]);
  const [stateFilter, setStateFilter] = useState('ALL');
  const [page, setPage] = useState<Loadable<ParsedOperationsPage>>({ kind: 'loading' });
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [detailProblem, setDetailProblem] = useState<AdminApiProblem | null>(null);

  // OPU-OPS-2: wall-clock driving the elapsed cells. It only runs while at
  // least one non-terminal operation is on screen; terminal rows keep their
  // recorded createdAt/completedAt-based value and never start ticking.
  const [nowIso, setNowIso] = useState<string>(() => new Date().toISOString());
  const listHasLive = page.kind === 'ready' && page.data.items.some((op) => !terminalStates.includes(op.state));
  const detailHasLive = detail?.operation != null && !terminalStates.includes(detail.operation.state);
  useEffect(() => {
    if (!listHasLive && !detailHasLive) return;
    const timer = setInterval(() => setNowIso(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [listHasLive, detailHasLive]);

  // OPU-OPS-4: id substring (route-supported), time window (loaded page),
  // and multi-row selection for a bulk cancel run.
  const [idFilter, setIdFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const correlationId = detail === null ? null : correlationFromRaw(detail.raw);
  const detailTasks = detail?.tasks ?? [];
  const selectedPopulation = operationsPopulation({
    state: stateFilter,
    tenantId: globalTenantId ?? null,
    id: idFilter,
    fromDate,
    toDate,
    limit,
  });
  const mintedPopulation = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    // AWEB-20a: keep the last good page on a bad window rather than swapping
    // the table for the route's 422; the inline banner explains why. Checked
    // BEFORE any state reset so the pane never parks on loading.
    if (operationsWindowInvalid(fromDate, toDate)) return;
    // A global tenant change has no input handler that can clear the cursor.
    // Drop it here before any request is sent, since effects run after this
    // load effect and a cursor from the previous population is not reusable.
    if (operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)) {
      mintedPopulation.current = null;
      ++listRequest.current;
      ++detailRequest.current;
      setPage({ kind: 'loading' });
      setDetail(null);
      setDetailProblem(null);
      setCursor(null);
      return;
    }
    const seq = ++listRequest.current;
    ++detailRequest.current;
    setPage({ kind: 'loading' });
    setDetail(null);
    setDetailProblem(null);
    // AWEB-20a: from/to are sent so the route filters rows in SQL. The old
    // client-side trim only hid rows already on this page.
    const result = await client.listOperations(buildOperationsQuery({
      limit,
      state: stateFilter,
      tenantId: globalTenantId ?? null,
      id: idFilter,
      cursor,
      fromDate,
      toDate,
    }));
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
  }, [client, stateFilter, globalTenantId, idFilter, cursor, limit, fromDate, toDate, selectedPopulation]);

  useEffect(() => {
    void load();
  }, [load]);

  // AWEB-20: a cursor only addresses one population. Most controls reset it in
  // their own onChange, but tenant is set GLOBALLY and has no handler, so a
  // cursor minted for tenant A kept paging tenant B and silently skipped rows.
  // One fingerprint plus one setter make that impossible to forget again.
  const applyCursor = useCallback((next: string | null): void => {
    if (operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)) {
      mintedPopulation.current = null;
      ++listRequest.current;
      ++detailRequest.current;
      setCursor(null);
      return;
    }
    mintedPopulation.current = next === null ? null : selectedPopulation;
    setCursor(next);
  }, [cursor, selectedPopulation]);

  useEffect(() => {
    if (operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)) {
      mintedPopulation.current = null;
      setCursor(null);
    }
  }, [cursor, selectedPopulation]);

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
    // HONESTY-AUDIT-OPS: the retry notice must not end in a dangling colon,
    // and when the backend omits the new operation id the operator must know
    // that the detail below is still the ORIGINAL operation.
    const retryOperationId =
      typeof result.data.operationId === 'string' && result.data.operationId.length > 0
        ? result.data.operationId
        : null;
    setNotice(action === 'cancel'
      ? result.data.state === 'CANCELLED' ? 'Request stopped.' : `Request state: ${String(result.data.state ?? 'unknown')}`
      : result.data.replayed === true
        ? 'Retry already in progress.'
        : retryOperationId === null
          ? 'Retry created, but the backend returned no operation id for it.'
          : `Retry created: ${retryOperationId}`);
    await load();
    await openDetail(retryOperationId ?? op.id);
  }

  async function cancelSelected(): Promise<void> {
    const targets = [...selected].filter((id) => {
      if (page.kind !== 'ready') return false;
      const op = page.data.items.find((item) => item.id === id);
      return op !== undefined && !terminalStates.includes(op.state);
    });
    // HONESTY-AUDIT-OPS: ids that were selected but are not cancellable here
    // (already terminal, or selected on another page) are NOT attempted, and
    // the summary must say so — "2 succeeded, 0 failed" while five rows stay
    // selected would read as five silent failures.
    const skippedCount = [...selected].length - targets.length;
    if (targets.length === 0) {
      setNotice('None of the selected requests are running (non-terminal), so there is nothing to cancel.');
      return;
    }
    setBusy(true); setNotice(null); setDetailProblem(null);
    setBulkCancelFailures([]);
    const succeeded = new Set<string>();
    const failures: Array<{ operationId: string; problem: AdminApiProblem }> = [];
    for (const id of targets) {
      const scope = `${id}:cancel`;
      const key = actionKeys.current.get(scope) ?? crypto.randomUUID();
      actionKeys.current.set(scope, key);
      try {
        const result = await client.operationAction(id, 'cancel', key);
        if (!result.ok) {
          failures.push({ operationId: id, problem: result.problem });
          continue;
        }
        actionKeys.current.delete(scope);
        succeeded.add(id);
      } catch {
        failures.push({
          operationId: id,
          problem: { status: 0, code: 'REQUEST_FAILED', title: 'Cancel request did not complete.' },
        });
      }
    }
    setSelected((current) => new Set([...current].filter((id) => !succeeded.has(id))));
    setBulkCancelFailures(failures);
    setBusy(false);
    setNotice(
      `Bulk cancel finished: ${succeeded.size} succeeded, ${failures.length} failed`
      + (skippedCount > 0 ? `, ${skippedCount} skipped (already finished or not listed on this page)` : '')
      + '.',
    );
    await load();
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

  // AWEB-20a: the window is applied by the route, so the page is shown as
  // returned. The old in-window trim ran over the loaded page only, which hid
  // matching operations that were not on it and left `total` disagreeing with
  // the table.
  const visibleItems = pane !== null && pane.kind === 'ready' ? pane.data.items : [];
  const windowInvalid = operationsWindowInvalid(fromDate, toDate);

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
              onChange={(e) => { applyCursor(null); setStateFilter(e.target.value); }}
            >
              {['ALL', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          {tenant ? (
            <div className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs">
              <span className="text-[var(--text-sub)]">Tenant:</span>
              <span className="font-semibold text-[var(--text-main)]">{tenant.name}</span>
            </div>
          ) : null}
          <div><label htmlFor="ops-limit" className="text-xs">Requests per page</label>
            <select id="ops-limit" value={limit} onChange={e => { applyCursor(null); setLimit(e.target.value); }} className="ml-2 rounded border p-2">
              {['20', '50', '100'].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div><label htmlFor="ops-id" className="text-xs">Operation id</label>
            <input id="ops-id" aria-label="Search by operation id" className="ml-2 rounded border p-2" value={idFilter}
              placeholder="id contains…"
              onChange={(e) => { applyCursor(null); setIdFilter(e.target.value); }} />
          </div>
          <div><label htmlFor="ops-from" className="text-xs">From</label>
            <input id="ops-from" aria-label="From date (UTC)" type="date" className="ml-2 rounded border p-2" value={fromDate}
              onChange={(e) => { applyCursor(null); setFromDate(e.target.value); }} />
          </div>
          <div><label htmlFor="ops-to" className="text-xs">To</label>
            <input id="ops-to" aria-label="To date (UTC)" type="date" className="ml-2 rounded border p-2" value={toDate}
              onChange={(e) => { applyCursor(null); setToDate(e.target.value); }} />
          </div>
          <Button disabled={busy} onClick={() => void load()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || selected.size === 0 || role === 'viewer'}
            onClick={() => void cancelSelected()}
          >
            Cancel selected
          </Button>
          {selected.size > 0 && (
            <div className="flex items-center gap-1.5">
              <Badge variant="info">Selected: {selected.size}</Badge>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          )}
          <span className="text-xs text-[var(--text-sub)]">
            From/To are inclusive UTC days and are applied by the server, not by this page.
          </span>
        </CardContent>
      </Card>

      {/* AWEB-20a: answered locally. The route answers 422 for from after to,
          and swapping the table for an error box hides the page they still have. */}
      {windowInvalid ? (
        <AlertBanner variant="warning" title="Check the date window">
          The start day is after the end day. Pick a start day on or before the end day to reload.
          Until then the table keeps the last valid window.
        </AlertBanner>
      ) : null}

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
                <TableHead className="w-12 text-center">
                  <input
                    type="checkbox"
                    aria-label="Select all visible operations"
                    className="cursor-pointer rounded border-[var(--border-subtle)]"
                    checked={visibleItems.length > 0 && visibleItems.every((op) => selected.has(op.id))}
                    onChange={(e) => {
                      if (e.target.checked) {
                        const next = new Set(selected);
                        visibleItems.forEach((op) => next.add(op.id));
                        setSelected(next);
                      } else {
                        const next = new Set(selected);
                        visibleItems.forEach((op) => next.delete(op.id));
                        setSelected(next);
                      }
                    }}
                  />
                </TableHead>
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
              {visibleItems.map((op) => (
                <TableRow key={op.id}>
                  <TableCell className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`select ${op.id}`}
                      className="cursor-pointer rounded border-[var(--border-subtle)]"
                      checked={selected.has(op.id)}
                      onChange={(e) => {
                        e.stopPropagation();
                        const next = new Set(selected);
                        if (e.target.checked) next.add(op.id);
                        else next.delete(op.id);
                        setSelected(next);
                      }}
                    />
                  </TableCell>
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
                  <TableCell className="text-xs">{formatDuration(elapsedMs(op, nowIso))}</TableCell>
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
          <Button disabled={busy || page.kind !== 'ready' || !page.data.prevCursor} onClick={() => { if (page.kind === 'ready') applyCursor(page.data.prevCursor); }}>Previous</Button>
          <Button disabled={busy || page.kind !== 'ready' || !page.data.nextCursor} onClick={() => { if (page.kind === 'ready') applyCursor(page.data.nextCursor); }}>Next</Button>
          <Button disabled={busy || cursor === null} onClick={() => applyCursor(null)}>Newest</Button>
          {/* HONESTY-AUDIT-OPS: only claim a total the server actually sent. */}
          {page.kind === 'ready' ? (
            <span className="text-sm">
              {page.data.items.length} shown · {page.data.totalFromServer ? `${page.data.total} total` : 'total not reported by the server'}
            </span>
          ) : null}
        </div>
      ) : null}
      {notice ? <AlertBanner variant="info" title={notice}>Refresh or open the request detail to inspect its current state.</AlertBanner> : null}
      {bulkCancelFailures.length > 0 ? (
        <AlertBanner variant="error" title="Bulk cancel item failures">
          <ul className="list-disc pl-5">
            {bulkCancelFailures.map(({ operationId, problem }) => (
              <li key={operationId}>
                <code>{operationId}</code>: {problem.title ?? 'Cancel request failed'}
                {problem.code ? ` · ${problem.code}` : ''}
                {problem.status > 0 ? ` · HTTP ${problem.status}` : ''}
              </li>
            ))}
          </ul>
        </AlertBanner>
      ) : null}

      {detailProblem !== null ? (
        <AlertBanner variant="error" title={detailProblem.title ?? 'Failed to load the operation detail.'}>
          {detailProblem.status} · {detailProblem.code ?? 'ERROR'}
        </AlertBanner>
      ) : null}

      {detail !== null ? (
        <Card className="mt-4 border-[var(--border-subtle)] shadow-sm">
          <CardHeader className="border-b border-[var(--border-subtle)] pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-semibold">Operation Details</CardTitle>
                {detail.operation ? (
                  <Badge variant={operationStateVariant(detail.operation.state)} dot>
                    {detail.operation.state}
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {detail.operation && !terminalStates.includes(detail.operation.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || role === 'viewer' || detail.operation.state === 'CANCEL_REQUESTED'}
                    onClick={() => void control(detail.operation!, 'cancel')}
                  >
                    Stop
                  </Button>
                )}
                {detail.operation && ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(detail.operation.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || role !== 'admin'}
                    onClick={() => void control(detail.operation!, 'retry')}
                  >
                    Retry
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>
                  Close
                </Button>
              </div>
            </div>
            <CardDescription className="text-xs">
              ID: <span className="font-mono text-[var(--text-main)]">{detail.operation?.id}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* LEFT COLUMN: Record Meta, Timing, Tasks & Artifacts */}
              <div className="lg:col-span-5 flex flex-col gap-5">
                {/* General Info Card */}
                <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
                    Overview & Lifecycle
                  </h3>
                  {detail.operation ? (
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
                      <dt className="text-[var(--text-sub)]">Tenant</dt>
                      <dd className="font-mono truncate">{detail.operation.tenantId ?? '—'}</dd>
                      
                      <dt className="text-[var(--text-sub)]">Business</dt>
                      <dd className="font-medium">{detail.operation.businessId ?? '—'}</dd>

                      <dt className="text-[var(--text-sub)]">Action</dt>
                      <dd className="font-medium">{detail.operation.action ?? '—'}</dd>

                      <dt className="text-[var(--text-sub)]">Created</dt>
                      <dd>{formatTime(detail.operation.createdAt)}</dd>

                      <dt className="text-[var(--text-sub)]">Started</dt>
                      <dd>{formatTime(detail.operation.startedAt)}</dd>

                      <dt className="text-[var(--text-sub)]">Finished</dt>
                      <dd>{formatTime(detail.operation.completedAt)}</dd>

                      <dt className="text-[var(--text-sub)]">Total elapsed</dt>
                      <dd>{formatDuration(elapsedMs(detail.operation, nowIso))}</dd>

                      <dt className="text-[var(--text-sub)]">Execution</dt>
                      <dd>{formatDuration(elapsedMs(detail.operation, nowIso, true))}</dd>

                      {detail.operation.deadlineAt && (
                        <>
                          <dt className="text-[var(--text-sub)]">Deadline</dt>
                          <dd>{formatTime(detail.operation.deadlineAt)}</dd>
                        </>
                      )}

                      {detail.operation.errorCode && (
                        <>
                          <dt className="text-[var(--badge-danger-text)] font-semibold">Error code</dt>
                          <dd className="text-[var(--badge-danger-text)] font-mono">{detail.operation.errorCode}</dd>
                        </>
                      )}

                      {detail.operation.retryOf && (
                        <>
                          <dt className="text-[var(--text-sub)]">Retry of</dt>
                          <dd className="font-mono">{detail.operation.retryOf}</dd>
                        </>
                      )}
                    </dl>
                  ) : null}
                  <div
                    className="pt-2 border-t border-[var(--border-subtle)] text-xs flex flex-col gap-1"
                    aria-label="Operation correlation"
                  >
                    <span className="text-[var(--text-sub)] font-semibold">Correlation ID</span>
                    <code className="font-mono text-[11px] break-all bg-[var(--surface-base)] p-1.5 rounded border border-[var(--border-subtle)]">
                      {correlationId || 'Unavailable'}
                    </code>
                  </div>
                </div>

                {/* Execution Tasks */}
                {detail.tasks && detail.tasks.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
                      Execution Tasks ({detail.tasks.length})
                    </h3>
                    <TableContainer className="border border-[var(--border-subtle)] rounded-md">
                      <Table aria-label="Request tasks">
                        <TableHeader>
                          <TableRow className="bg-[var(--surface-muted)]">
                            <TableHead className="text-xs">Task</TableHead>
                            <TableHead className="text-xs">State</TableHead>
                            <TableHead className="text-xs">Attempt</TableHead>
                            <TableHead className="text-xs">Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.tasks.map((task) => (
                            <TableRow key={task.id}>
                              <TableCell className="text-xs font-mono">{task.taskKey || task.kind}</TableCell>
                              <TableCell className="text-xs">
                                <Badge
                                  variant={task.state === 'SUCCEEDED' ? 'success' : task.state === 'FAILED' ? 'danger' : 'neutral'}
                                  className="text-[10px] py-0 px-1.5"
                                >
                                  {task.state}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs">{task.attempt}/{task.maxAttempts}</TableCell>
                              <TableCell className="text-xs font-mono text-[var(--badge-danger-text)]">{task.errorCode ?? '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </div>
                ) : null}

                {/* Artifacts Table */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
                      Artifacts ({detail.artifacts.length})
                    </h3>
                  </div>
                  {detail.artifacts.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[var(--border-subtle)] p-4 text-center">
                      <p className="text-xs text-[var(--text-sub)]">No artifacts reported for this operation.</p>
                    </div>
                  ) : (
                    <TableContainer className="border border-[var(--border-subtle)] rounded-md">
                      <Table aria-label="Operation artifacts">
                        <TableHeader>
                          <TableRow className="bg-[var(--surface-muted)]">
                            <TableHead className="text-xs">Role</TableHead>
                            <TableHead className="text-xs">Status</TableHead>
                            <TableHead className="text-xs">Type</TableHead>
                            <TableHead className="text-xs text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.artifacts.map((artifact, index) => (
                            <TableRow key={`${artifact.role}:${index}`}>
                              <TableCell className="text-xs font-medium">{artifact.role}</TableCell>
                              <TableCell className="text-xs">
                                <Badge
                                  variant={artifact.status === 'READY' ? 'success' : 'neutral'}
                                  className="text-[10px] py-0 px-1.5"
                                >
                                  {artifact.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-[var(--text-sub)] truncate max-w-[100px]">
                                {artifact.contentType ?? '—'}
                              </TableCell>
                              <TableCell className="text-xs text-right">
                                {artifact.downloadUrl ? (
                                  <a
                                    className="font-medium text-[var(--cf-blue)] hover:underline inline-flex items-center gap-1"
                                    href={artifact.downloadUrl}
                                    download
                                  >
                                    Download
                                  </a>
                                ) : (
                                  <span className="text-[var(--text-sub)]">Unavailable</span>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </div>
              </div>

              {/* RIGHT COLUMN: Operations Timeline, Output Results & Request Input */}
              <div className="lg:col-span-7 flex flex-col gap-5 border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] pt-5 lg:pt-0 lg:pl-6">
                
                {/* 1. Operations Timeline */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
                      Operations Timeline
                    </h3>
                  </div>
                  <div
                    aria-label="Operations timeline"
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)] p-4 overflow-x-auto"
                  >
                    {detailTasks.length > 0 ? (
                      <div className="flex items-start gap-0 min-w-max py-1">
                        {detailTasks.map((task, idx) => {
                          const isSuccess = task.state === 'SUCCEEDED';
                          const isFailed = task.state === 'FAILED';
                          const isRunning = task.state === 'RUNNING';
                          const isLast = idx === detailTasks.length - 1;

                          return (
                            <div key={task.id || idx} className="flex items-start">
                              <div className="flex flex-col items-center text-center w-36 px-1">
                                {/* Circle Node Icon */}
                                <div
                                  className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold transition-all ${
                                    isSuccess
                                      ? 'border-emerald-500 bg-emerald-500/15 text-emerald-500'
                                      : isFailed
                                        ? 'border-rose-500 bg-rose-500/15 text-rose-500'
                                        : isRunning
                                          ? 'border-sky-500 bg-sky-500/15 text-sky-500 animate-pulse'
                                          : 'border-[var(--border-dark)] bg-[var(--surface-base)] text-[var(--text-sub)]'
                                  }`}
                                >
                                  {isSuccess ? '✓' : isFailed ? '✕' : idx + 1}
                                </div>

                                {/* Step Name & Badge */}
                                <div className="mt-2 flex flex-col items-center gap-1 w-full">
                                  <span
                                    className="font-mono text-xs font-semibold text-[var(--text-main)] truncate max-w-full"
                                    title={task.taskKey || task.kind || `Step ${idx + 1}`}
                                  >
                                    {task.taskKey || task.kind || `Step ${idx + 1}`}
                                  </span>
                                  <Badge
                                    variant={isSuccess ? 'success' : isFailed ? 'danger' : isRunning ? 'info' : 'neutral'}
                                    className="text-[10px] py-0 px-1.5"
                                  >
                                    {task.state}
                                  </Badge>
                                  <span className="text-[11px] text-[var(--text-sub)]">
                                    Attempt {task.attempt}/{task.maxAttempts}
                                  </span>
                                  {task.errorCode && (
                                    <span className="text-[10px] font-mono text-[var(--badge-danger-text)] truncate max-w-full">
                                      {task.errorCode}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Horizontal Connecting Line */}
                              {!isLast && (
                                <div className="flex items-center pt-3.5">
                                  <div
                                    className={`h-0.5 w-10 sm:w-14 transition-colors ${
                                      isSuccess
                                        ? 'bg-emerald-500'
                                        : isFailed
                                          ? 'bg-rose-500'
                                          : 'bg-[var(--border-dark)]'
                                    }`}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : detail.operation ? (
                      /* Fallback to operation lifecycle horizontal timeline */
                      <div className="flex items-start gap-0 min-w-max py-1">
                        {/* Step 1: Created */}
                        <div className="flex items-start">
                          <div className="flex flex-col items-center text-center w-36 px-1">
                            <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-emerald-500 bg-emerald-500/15 text-xs font-bold text-emerald-500">
                              ✓
                            </div>
                            <div className="mt-2 flex flex-col items-center gap-0.5">
                              <span className="text-xs font-semibold text-[var(--text-main)]">1. Received</span>
                              <Badge variant="success" className="text-[10px] py-0 px-1.5">CREATED</Badge>
                              <span className="text-[11px] text-[var(--text-sub)] mt-0.5">
                                {formatTime(detail.operation.createdAt)}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center pt-3.5">
                            <div className="h-0.5 w-10 sm:w-14 bg-emerald-500" />
                          </div>
                        </div>

                        {/* Step 2: Processing / Started */}
                        <div className="flex items-start">
                          <div className="flex flex-col items-center text-center w-36 px-1">
                            <div
                              className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold ${
                                detail.operation.startedAt
                                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-500'
                                  : 'border-sky-500 bg-sky-500/15 text-sky-500 animate-pulse'
                              }`}
                            >
                              {detail.operation.startedAt ? '✓' : '2'}
                            </div>
                            <div className="mt-2 flex flex-col items-center gap-0.5">
                              <span className="text-xs font-semibold text-[var(--text-main)]">2. Executing</span>
                              <Badge
                                variant={detail.operation.startedAt ? 'success' : 'info'}
                                className="text-[10px] py-0 px-1.5"
                              >
                                {detail.operation.startedAt ? 'RUNNING' : 'DISPATCHING'}
                              </Badge>
                              <span className="text-[11px] text-[var(--text-sub)] mt-0.5">
                                {detail.operation.startedAt ? formatTime(detail.operation.startedAt) : 'Awaiting dispatch'}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center pt-3.5">
                            <div
                              className={`h-0.5 w-10 sm:w-14 ${
                                detail.operation.completedAt
                                  ? detail.operation.state === 'SUCCEEDED'
                                    ? 'bg-emerald-500'
                                    : 'bg-rose-500'
                                  : 'bg-[var(--border-dark)]'
                              }`}
                            />
                          </div>
                        </div>

                        {/* Step 3: Finished */}
                        <div className="flex items-start">
                          <div className="flex flex-col items-center text-center w-36 px-1">
                            <div
                              className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold ${
                                detail.operation.state === 'SUCCEEDED'
                                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-500'
                                  : detail.operation.state === 'FAILED' || detail.operation.state === 'CANCELLED'
                                    ? 'border-rose-500 bg-rose-500/15 text-rose-500'
                                    : 'border-[var(--border-dark)] bg-[var(--surface-base)] text-[var(--text-sub)]'
                              }`}
                            >
                              {detail.operation.state === 'SUCCEEDED' ? '✓' : detail.operation.completedAt ? '✕' : '3'}
                            </div>
                            <div className="mt-2 flex flex-col items-center gap-0.5">
                              <span className="text-xs font-semibold text-[var(--text-main)]">3. Completed</span>
                              <Badge
                                variant={operationStateVariant(detail.operation.state)}
                                className="text-[10px] py-0 px-1.5"
                              >
                                {detail.operation.state}
                              </Badge>
                              <span className="text-[11px] text-[var(--text-sub)] mt-0.5">
                                {detail.operation.completedAt ? formatTime(detail.operation.completedAt) : 'Processing'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--text-sub)]">No progress information is available yet</p>
                    )}
                  </div>
                </div>

                {/* 2. Output Result */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
                      Output Result
                    </h3>
                  </div>
                  {detail.resultSummary !== null ? (
                    <pre
                      aria-label="Result summary"
                      className="max-h-72 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 text-xs font-mono leading-relaxed"
                    >
                      {detail.resultSummary}
                    </pre>
                  ) : (
                    <div className="rounded-lg border border-dashed border-[var(--border-subtle)] p-4 text-center">
                      <p className="text-xs text-[var(--text-sub)]">
                        {detail.operation?.state === 'SUCCEEDED'
                          ? 'Operation succeeded without output payload.'
                          : 'No output result generated yet.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* 3. Request Input */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">
                      Request Input
                    </h3>
                    {detail.requestInput && (
                      <Badge variant={detail.requestInput.status === 'REDACTED' ? 'warning' : 'neutral'} className="text-[10px]">
                        {detail.requestInput.status}
                      </Badge>
                    )}
                  </div>
                  {detail.requestInput ? (
                    <>
                      <p className="text-xs text-[var(--text-sub)]">
                        {detail.requestInput.status === 'REDACTED'
                          ? `Redacted on the server using ${detail.requestInput.ruleCount} profile rules.`
                          : detail.requestInput.status === 'HIDDEN'
                          ? 'Input is hidden because a safe display could not be produced.'
                          : 'No redaction rules configured for this request profile.'}
                      </p>
                      <pre
                        aria-label="Request input"
                        className="max-h-64 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 text-xs font-mono leading-relaxed"
                      >
                        {JSON.stringify(detail.requestInput.data, null, 2)}
                      </pre>
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-[var(--border-subtle)] p-4 text-center">
                      <p className="text-xs text-[var(--text-sub)]">No request input data recorded.</p>
                    </div>
                  )}
                </div>

              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
