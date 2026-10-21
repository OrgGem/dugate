import { CallbackDeliveries } from './callback-deliveries';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReviewInput } from './review-input';
import { reviewModel, validateReview } from './review-schema';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeniedState, EmptyState, ErrorState, LoadingState, AlertBanner } from '@/components/ui/state-panel';
import { ReferenceInput, type ReferenceOptionPage } from '@/components/ui/reference-input';
import { useTenant } from '@/lib/tenant-context';
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
import { createAdminApiClient, type AdminApiProblem, type OperationDetail, type OperationWire, type OperationsPage } from '@/lib/api';
import type { AdminApiClient } from '@/lib/api/client';
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
const operationSortLabels: Record<string, string> = {
  'created_at:desc': 'Newest created',
  'created_at:asc': 'Oldest created',
  'updated_at:desc': 'Recently updated',
  'updated_at:asc': 'Least recently updated',
  'deadline_at:asc': 'Nearest deadline',
  'deadline_at:desc': 'Farthest deadline',
};
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

/**
 * PC-08 / D-02(c): the admin detail projection does not yet expose a group pin
 * or an admission-time access version. Render a "pinned resolution" block ONLY
 * when the server actually sends a `resolution` object — never fabricate one.
 */
const resolutionFromRaw = (raw: unknown): Record<string, unknown> | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = (raw as Record<string, unknown>).resolution;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
};

const safeRefText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;

export function OperationsScreen() {
  const { tenantId: globalTenantId } = useTenant();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchString = searchParams.toString();
  const client = useMemo(() => createAdminApiClient(), []);
  const [cursor, setCursor] = useState<string | null>(() => searchParams.get('cursor'));
  const [limit, setLimit] = useState(() => ['20', '50', '100'].includes(searchParams.get('limit') ?? '') ? searchParams.get('limit')! : '20');
  const [role, setRole] = useState<string>('viewer');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkCancelFailures, setBulkCancelFailures] = useState<Array<{ operationId: string; problem: AdminApiProblem }>>([]);
  const [pendingControl, setPendingControl] = useState<{ operation: OperationWire; action: 'cancel' | 'retry' | 'delete'; tenantId: string | null } | null>(null);
  const [bulkCancelConfirmOpen, setBulkCancelConfirmOpen] = useState(false);
  const actionInFlight = useRef(false);
  const actionGeneration = useRef(0);
  const actionKeys = useRef(new Map<string, string>());
  const reviewActionKeys = useRef(new Map<string, string>());
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const activeTenant = useRef(globalTenantId ?? null);
  activeTenant.current = globalTenantId ?? null;
  const lastTenantScope = useRef(globalTenantId ?? null);
  useEffect(() => { void client.getSession().then(r => { if (r.ok) setRole(r.data.role); }); }, [client]);
  const [stateFilter, setStateFilter] = useState(() => searchParams.get('state') ?? 'ALL');
  const [sort, setSort] = useState(() => searchParams.get('sort') ?? 'created_at:desc');
  const [page, setPage] = useState<Loadable<ParsedOperationsPage>>({ kind: 'loading' });
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTenantId, setDetailTenantId] = useState<string | null>(globalTenantId ?? null);
  const detailIdentity = useRef<{ tenantId: string | null; operationId: string } | null>(null);
  const lastRouteOperation = useRef<string | null>(null);
  const [resumeInput, setResumeInput] = useState('{}');
  const [resumeWaitId, setResumeWaitId] = useState('');
  const pendingReview = useMemo(() => {
    const waits = detail?.raw.humanWaits;
    if (!Array.isArray(waits)) return null;
    return waits.find((wait): wait is { waitId: string; status: string; inputSchema: unknown; expiresAt?: string | null } => !!wait && typeof wait === 'object' && wait.waitId === resumeWaitId && wait.status === 'OPEN') ?? null;
  }, [detail, resumeWaitId]);
  const reviewErrors = pendingReview ? validateReview(reviewModel(pendingReview.inputSchema), resumeInput) : [];
  const [detailProblem, setDetailProblem] = useState<AdminApiProblem | null>(null);

  // OPU-OPS-2: wall-clock driving the elapsed cells. It only runs while at
  // least one non-terminal operation is on screen; terminal rows keep their
  // recorded createdAt/completedAt-based value and never start ticking.
  const [nowIso, setNowIso] = useState<string>(() => new Date().toISOString());
  const listHasLive = page.kind === 'ready' && page.data.items.some((op) => !terminalStates.includes(op.state));
  const currentDetail = detailTenantId === (globalTenantId ?? null) ? detail : null;
  const detailTasks = currentDetail?.tasks ?? [];
  const currentUnknownOutcome = currentDetail?.operation?.errorCode?.includes('UNKNOWN') || (currentDetail?.tasks ?? []).some(task => task.errorCode?.includes('UNKNOWN'));
  const detailHasLive = currentDetail?.operation != null && !terminalStates.includes(currentDetail.operation.state);
  useEffect(() => {
    if (!listHasLive && !detailHasLive) return;
    const timer = setInterval(() => setNowIso(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [listHasLive, detailHasLive]);

  // OPU-OPS-4: id substring (route-supported), time window (loaded page),
  // and multi-row selection for a bulk cancel run.
  const [idFilter, setIdFilter] = useState(() => searchParams.get('id') ?? '');
  const [businessFilter, setBusinessFilter] = useState(() => searchParams.get('business') ?? '');
  const [actionFilter, setActionFilter] = useState(() => searchParams.get('action') ?? '');
  const [apiKeyFilter, setApiKeyFilter] = useState(() => searchParams.get('apiKey') ?? '');
  const [profileFilter, setProfileFilter] = useState(() => searchParams.get('profile') ?? '');
  const [correlationFilter, setCorrelationFilter] = useState(() => searchParams.get('correlation') ?? '');
  const [providerFilter, setProviderFilter] = useState(() => searchParams.get('provider') ?? '');
  const [modelFilter, setModelFilter] = useState(() => searchParams.get('model') ?? '');
  const [usageFilter, setUsageFilter] = useState<'any' | 'has-recorded-usage' | 'no-recorded-usage'>(() => {
    const value = searchParams.get('usage');
    return value === 'has-recorded-usage' || value === 'no-recorded-usage' ? value : 'any';
  });
  const [reservationFilter, setReservationFilter] = useState<'any' | 'unknown'>(() => searchParams.get('reservation') === 'unknown' ? 'unknown' : 'any');
  const [attentionFilter, setAttentionFilter] = useState<'any' | 'waiting-input'>(() => searchParams.get('attention') === 'waiting-input' ? 'waiting-input' : 'any');
  const [fromDate, setFromDate] = useState(() => searchParams.get('from') ?? '');
  const [toDate, setToDate] = useState(() => searchParams.get('to') ?? '');
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const operationSearchFields = [
    { param: 'business', id: 'ops-business', label: 'Business', value: businessFilter, set: setBusinessFilter, placeholder: 'Business id' },
    { param: 'action', id: 'ops-action', label: 'Action', value: actionFilter, set: setActionFilter, placeholder: 'Action' },
    { param: 'apiKey', id: 'ops-api-key', label: 'API key', value: apiKeyFilter, set: setApiKeyFilter, placeholder: 'Key name or ID' },
    { param: 'profile', id: 'ops-profile', label: 'Profile', value: profileFilter, set: setProfileFilter, placeholder: 'Profile name or ID' },
    { param: 'correlation', id: 'ops-correlation', label: 'Correlation', value: correlationFilter, set: setCorrelationFilter, placeholder: 'Correlation id' },
    { param: 'provider', id: 'ops-provider', label: 'Provider', value: providerFilter, set: setProviderFilter, placeholder: 'Recorded provider' },
    { param: 'model', id: 'ops-model', label: 'Model', value: modelFilter, set: setModelFilter, placeholder: 'Recorded model' },
  ];
  const operationScopeKey = globalTenantId ?? 'platform-operations';
  const loadOperationIdSuggestions = useCallback(async (
    query: string,
    scopeKey: string,
    cursorValue: string | null,
  ): Promise<ReferenceOptionPage> => {
    if (cursorValue || scopeKey !== operationScopeKey || page.kind !== 'ready') return { items: [], nextCursor: null };
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const items = page.data.items
      .filter((operation) => !globalTenantId
        || operation.tenantId?.toLowerCase() === globalTenantId.toLowerCase())
      .map((operation) => ({
        value: operation.id,
        label: operation.id,
        description: `Current operations page · ${operation.state}`,
      }))
      .filter((option) => `${option.value} ${option.description ?? ''}`.toLocaleLowerCase().includes(normalizedQuery));
    return { items, nextCursor: null };
  }, [globalTenantId, operationScopeKey, page]);
  const operationSuggestionVersion = page.kind === 'ready'
    ? JSON.stringify([page.data.items.map((operation) => operation.id), page.data.nextCursor])
    : page.kind;
  const activeAdvancedFilterCount = [
    idFilter.trim(),
    ...operationSearchFields.map(({ value }) => value.trim()),
    fromDate,
    toDate,
    usageFilter === 'any' ? '' : usageFilter,
    reservationFilter === 'any' ? '' : reservationFilter,
    attentionFilter === 'any' ? '' : attentionFilter,
  ].filter(Boolean).length;
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    if (['id', 'business', 'action', 'apiKey', 'profile', 'correlation', 'provider', 'model', 'from', 'to', 'usage', 'reservation', 'attention'].some((key) => params.has(key))) {
      setAdvancedFiltersOpen(true);
    }
  }, [searchString]);
  const invalidSearchLabel = operationSearchFields.find(({ value }) => value.trim().length > 128 || /[\u0000-\u001f\u007f]/.test(value))?.label ?? null;
  const correlationId = currentDetail === null ? null : correlationFromRaw(currentDetail.raw);
  const resolutionRefs = currentDetail === null ? null : resolutionFromRaw(currentDetail.raw);
  const selectedPopulation = operationsPopulation({
    state: stateFilter,
    sort,
    tenantId: globalTenantId ?? null,
    id: idFilter,
    business: businessFilter,
    action: actionFilter,
    apiKey: apiKeyFilter,
    profile: profileFilter,
    correlation: correlationFilter,
    provider: providerFilter,
    model: modelFilter,
    usage: usageFilter,
    reservation: reservationFilter,
    attention: attentionFilter,
    fromDate,
    toDate,
    limit,
  });
  const mintedPopulation = useRef<string | null>(cursor === null ? null : selectedPopulation);
  const activePopulation = useRef(selectedPopulation);
  activePopulation.current = selectedPopulation;

  const updateSearch = useCallback((updates: Record<string, string | null>, replace = false) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace });
  }, [setSearchParams]);

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const nextId = params.get('id') ?? '';
    const nextFrom = params.get('from') ?? '';
    const nextTo = params.get('to') ?? '';
    const nextSort = ['created_at:asc', 'created_at:desc', 'updated_at:asc', 'updated_at:desc', 'deadline_at:asc', 'deadline_at:desc'].includes(params.get('sort') ?? '')
      ? params.get('sort')!
      : 'created_at:desc';
    const nextBusiness = params.get('business') ?? '';
    const nextAction = params.get('action') ?? '';
    const nextApiKey = params.get('apiKey') ?? '';
    const nextProfile = params.get('profile') ?? '';
    const nextCorrelation = params.get('correlation') ?? '';
    const nextProvider = params.get('provider') ?? '';
    const nextModel = params.get('model') ?? '';
    const requestedUsage = params.get('usage');
    const nextUsage = requestedUsage === 'has-recorded-usage' || requestedUsage === 'no-recorded-usage' ? requestedUsage : 'any';
    const nextReservation = params.get('reservation') === 'unknown' ? 'unknown' : 'any';
    const nextAttention = params.get('attention') === 'waiting-input' ? 'waiting-input' : 'any';
    const allowedStates = new Set(['ALL', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
    const requestedState = params.get('state') ?? 'ALL';
    const nextState = allowedStates.has(requestedState) ? requestedState : 'ALL';
    const nextLimit = params.get('limit');
    const normalizedLimit = nextLimit && ['20', '50', '100'].includes(nextLimit) ? nextLimit : '20';
    const nextCursor = params.get('cursor');
    setIdFilter(nextId);
    setBusinessFilter(nextBusiness);
    setActionFilter(nextAction);
    setApiKeyFilter(nextApiKey);
    setProfileFilter(nextProfile);
    setCorrelationFilter(nextCorrelation);
    setProviderFilter(nextProvider);
    setModelFilter(nextModel);
    setUsageFilter(nextUsage);
    setReservationFilter(nextReservation);
    setAttentionFilter(nextAttention);
    setFromDate(nextFrom);
    setToDate(nextTo);
    setStateFilter(nextState);
    setSort(nextSort);
    setLimit(normalizedLimit);
    setCursor(nextCursor);
    mintedPopulation.current = nextCursor === null ? null : operationsPopulation({
      state: nextState,
      sort: nextSort,
      tenantId: globalTenantId ?? null,
      id: nextId,
      business: nextBusiness,
      action: nextAction,
      apiKey: nextApiKey,
      profile: nextProfile,
      correlation: nextCorrelation,
      provider: nextProvider,
      model: nextModel,
      usage: nextUsage,
      reservation: nextReservation,
      attention: nextAttention,
      fromDate: nextFrom,
      toDate: nextTo,
      limit: normalizedLimit,
    });
  }, [searchString]);

  const load = useCallback(async (): Promise<void> => {
    // AWEB-20a: keep the last good page on a bad window rather than swapping
    // the table for the route's 422; the inline banner explains why. Checked
    // BEFORE any state reset so the pane never parks on loading.
    if (operationsWindowInvalid(fromDate, toDate) || invalidSearchLabel !== null) return;
    // A global tenant change has no input handler that can clear the cursor.
    // Drop it here before any request is sent, since effects run after this
    // load effect and a cursor from the previous population is not reusable.
    if (operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)) {
      mintedPopulation.current = null;
      ++listRequest.current;
      setPage({ kind: 'loading' });
      setCursor(null);
      updateSearch({ cursor: null }, true);
      return;
    }
    const seq = ++listRequest.current;
    setPage({ kind: 'loading' });
    // AWEB-20a: from/to are sent so the route filters rows in SQL. The old
    // client-side trim only hid rows already on this page.
    const result = await client.listOperations(buildOperationsQuery({
      limit,
      state: stateFilter,
      sort,
      tenantId: globalTenantId ?? null,
      id: idFilter,
      business: businessFilter,
      action: actionFilter,
      apiKey: apiKeyFilter,
      profile: profileFilter,
      correlation: correlationFilter,
      provider: providerFilter,
      model: modelFilter,
      usage: usageFilter,
      reservation: reservationFilter,
      attention: attentionFilter,
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
  }, [client, stateFilter, sort, globalTenantId, idFilter, businessFilter, actionFilter, apiKeyFilter, profileFilter, correlationFilter, providerFilter, modelFilter, usageFilter, reservationFilter, attentionFilter, cursor, limit, fromDate, toDate, selectedPopulation, updateSearch, invalidSearchLabel]);

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
      setCursor(null);
      updateSearch({ cursor: null }, true);
      return;
    }
    mintedPopulation.current = next === null ? null : selectedPopulation;
    setCursor(next);
    updateSearch({ cursor: next }, true);
  }, [cursor, selectedPopulation, updateSearch]);

  useEffect(() => {
    if (operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation)) {
      mintedPopulation.current = null;
      setCursor(null);
    }
  }, [cursor, selectedPopulation]);

  async function openDetail(operationId: string, updateRoute = true): Promise<void> {
    const tenantScope = globalTenantId ?? null;
    const previousIdentity = detailIdentity.current;
    if (previousIdentity?.tenantId !== tenantScope || previousIdentity.operationId !== operationId) {
      setResumeWaitId('');
      setResumeInput('{}');
    }
    detailIdentity.current = { tenantId: tenantScope, operationId };
    setDetailTenantId(tenantScope);
    if (updateRoute) {
      lastRouteOperation.current = operationId;
      updateSearch({ operation: operationId });
    }
    const seq = ++detailRequest.current;
    setDetail(null);
    setDetailLoading(true);
    setDetailProblem(null);
    try {
      const result = await client.getOperation(operationId);
      if (seq !== detailRequest.current || tenantScope !== activeTenant.current) return;
      if (!result.ok) {
        setDetailProblem(result.problem);
        return;
      }
      const parsed = parseOperationDetail(result.data);
      if (!parsed) setDetailProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable request detail.' });
      setDetail(parsed);
    } catch {
      if (seq === detailRequest.current && tenantScope === activeTenant.current) setDetailProblem({ status: 0, code: 'REQUEST_FAILED', title: 'Operation detail could not be loaded.' });
    } finally {
      if (seq === detailRequest.current && tenantScope === activeTenant.current) setDetailLoading(false);
    }
  }

  const routeOperationId = searchParams.get('operation');
  useEffect(() => {
    if (lastTenantScope.current !== (globalTenantId ?? null)) return;
    if (routeOperationId) {
      if (lastRouteOperation.current !== routeOperationId) {
        lastRouteOperation.current = routeOperationId;
        void openDetail(routeOperationId, false);
      }
    } else if (lastRouteOperation.current !== null) {
      lastRouteOperation.current = null;
      detailIdentity.current = null;
      ++detailRequest.current;
      setDetail(null);
      setDetailLoading(false);
      setDetailProblem(null);
      setResumeWaitId('');
      setResumeInput('{}');
    }
  }, [routeOperationId, globalTenantId]);

  useEffect(() => {
    const nextTenantScope = globalTenantId ?? null;
    if (lastTenantScope.current === nextTenantScope) return;
    lastTenantScope.current = nextTenantScope;
    ++detailRequest.current;
    detailIdentity.current = null;
    setDetail(null);
    setDetailLoading(false);
    setDetailProblem(null);
    setDetailTenantId(nextTenantScope);
    setResumeWaitId('');
    setResumeInput('{}');
    setPendingControl(null);
    setBulkCancelConfirmOpen(false);
    setSelected(new Set());
    // Invalidate responses from the previous tenant without allowing their
    // finally blocks to clear a newer tenant's pending action state.
    actionGeneration.current++;
    actionInFlight.current = false;
    setBusy(false);
    lastRouteOperation.current = null;
    updateSearch({ operation: null }, true);
  }, [globalTenantId, updateSearch]);

  async function resume(): Promise<void> {
    if (!detail?.operation || busy || actionInFlight.current || role === 'viewer') return;
    if (detail.operation.state !== 'WAITING_INPUT' || !pendingReview || reviewErrors.length) { setNotice(reviewErrors[0] ?? 'Select a pending review and refresh stale operation details.'); return; }
    if (pendingReview.expiresAt && Date.parse(pendingReview.expiresAt) <= Date.now()) { setNotice('This review has expired. Refresh operation details.'); return; }
    const rawOperation = detail.raw.operation && typeof detail.raw.operation === 'object' ? detail.raw.operation as Record<string, unknown> : detail.raw;
    const expectedStateVersion = rawOperation.stateVersion ?? detail.raw.stateVersion;
    if (typeof expectedStateVersion !== 'number') { setNotice('Current state revision unavailable. Refresh operation details before resuming.'); return; }
    let input: unknown;
    try { input = JSON.parse(resumeInput); } catch { setNotice('Resume input must be valid JSON.'); return; }
    setBusy(true);
    actionInFlight.current = true;
    const actionRequest = ++actionGeneration.current;
    const population = selectedPopulation;
    const selectedDetailRequest = detailRequest.current;
    const operationId = detail.operation.id;
    const tenantScope = globalTenantId ?? null;
    const actionScope = `${operationId}:${resumeWaitId}:${expectedStateVersion}`;
    const idempotencyKey = reviewActionKeys.current.get(actionScope) ?? crypto.randomUUID();
    reviewActionKeys.current.set(actionScope, idempotencyKey);
    let result: Awaited<ReturnType<AdminApiClient['postAction']>>;
    try {
      result = await client.postAction('operations.resume', { operationId, body: { waitId: resumeWaitId, input, expectedStateVersion } }, { idempotencyKey });
    } catch {
      if (actionRequest === actionGeneration.current) {
        actionInFlight.current = false;
        setBusy(false);
        if (tenantScope === activeTenant.current && detailRequest.current === selectedDetailRequest) setDetailProblem({ status: 0, code: 'REQUEST_FAILED', title: 'Resume outcome is unknown. Refresh before retrying.' });
      }
      return;
    }
    if (actionRequest !== actionGeneration.current) return;
    actionInFlight.current = false;
    setBusy(false);
    if (tenantScope !== activeTenant.current) return;
    if (activePopulation.current !== population || detailRequest.current !== selectedDetailRequest) return;
    if (!result.ok) { setDetailProblem(result.problem); return; }
    reviewActionKeys.current.delete(actionScope);
    setResumeWaitId('');
    setResumeInput('{}');
    setNotice('Resume accepted. The worker will continue from the waiting task.');
    const refresh = load();
    const refreshedDetailRequest = detailRequest.current;
    await refresh;
    if (activePopulation.current !== population || detailRequest.current !== refreshedDetailRequest) return;
    await openDetail(operationId);
  }

  function requestControl(op: OperationWire, action: 'cancel' | 'retry' | 'delete') {
    if (busy || actionInFlight.current || role === 'viewer' || (action === 'retry' && role !== 'admin')) return;
    setPendingControl({ operation: op, action, tenantId: globalTenantId ?? null });
  }

  async function control(op: OperationWire, action: 'cancel' | 'retry', tenantScope: string | null): Promise<void> {
    if (actionInFlight.current || busy || tenantScope !== (globalTenantId ?? null) || tenantScope !== activeTenant.current) return;
    actionInFlight.current = true;
    const actionRequest = ++actionGeneration.current;
    setBusy(true); setNotice(null); setDetailProblem(null);
    const scope = `${op.id}:${action}`;
    const key = actionKeys.current.get(scope) ?? crypto.randomUUID();
    actionKeys.current.set(scope, key);
    try {
      const session = await client.getSession();
      if (actionRequest !== actionGeneration.current || tenantScope !== activeTenant.current) return;
      if (!session.ok) { setDetailProblem(session.problem); setPendingControl(null); return; }
      const result = await client.operationAction(op.id, action, key);
      if (actionRequest !== actionGeneration.current || tenantScope !== activeTenant.current) return;
      setPendingControl(null);
      if (!result.ok) { setDetailProblem(result.problem); return; }
      actionKeys.current.delete(scope);
      // HONESTY-AUDIT-OPS: a missing retry id must not make the original detail
      // look like the new execution.
      const retryOperationId = typeof result.data.operationId === 'string' && result.data.operationId.length > 0
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
      if (tenantScope === activeTenant.current) await openDetail(retryOperationId ?? op.id);
    } catch {
      if (actionRequest === actionGeneration.current && tenantScope === activeTenant.current) {
        setPendingControl(null);
        setDetailProblem({ status: 0, code: 'REQUEST_FAILED', title: `${action === 'cancel' ? 'Stop' : 'Retry'} request outcome is unknown. Refresh before trying again.` });
      }
    } finally {
      if (actionRequest === actionGeneration.current) {
        actionInFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function deleteOperation(op: OperationWire, tenantScope: string | null): Promise<void> {
    if (actionInFlight.current || busy || tenantScope !== (globalTenantId ?? null) || tenantScope !== activeTenant.current || role === 'viewer' || !terminalStates.includes(op.state)) return;
    actionInFlight.current = true;
    const actionRequest = ++actionGeneration.current;
    const scope = `${op.id}:delete`;
    const key = actionKeys.current.get(scope) ?? crypto.randomUUID();
    actionKeys.current.set(scope, key);
    setBusy(true); setNotice(null); setDetailProblem(null);
    try {
      const session = await client.getSession();
      if (actionRequest !== actionGeneration.current || tenantScope !== activeTenant.current) return;
      if (!session.ok) { setPendingControl(null); setDetailProblem(session.problem); return; }
      const result = await client.deleteOperation(op.id, key);
      if (actionRequest !== actionGeneration.current || tenantScope !== activeTenant.current) return;
      setPendingControl(null);
      if (!result.ok) { setDetailProblem(result.problem); return; }
      actionKeys.current.delete(scope);
      detailIdentity.current = null;
      lastRouteOperation.current = null;
      setDetail(null);
      setNotice('Terminal operation hidden from the active list. Retained artifacts and audit records are unchanged.');
      updateSearch({ operation: null }, true);
      await load();
    } catch {
      if (actionRequest === actionGeneration.current && tenantScope === activeTenant.current) {
        setPendingControl(null);
        setDetailProblem({ status: 0, code: 'REQUEST_FAILED', title: 'Delete outcome is unknown. Refresh the operation before trying again.' });
      }
    } finally {
      if (actionRequest === actionGeneration.current) {
        actionInFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function cancelSelected(): Promise<void> {
    if (busy || actionInFlight.current || role === 'viewer') return;
    const tenantScope = globalTenantId ?? null;
    const actionRequest = ++actionGeneration.current;
    actionInFlight.current = true;
    setBusy(true);
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
      actionInFlight.current = false;
      if (actionRequest === actionGeneration.current) setBusy(false);
      return;
    }
    setNotice(null); setDetailProblem(null);
    setBulkCancelFailures([]);
    const succeeded = new Set<string>();
    const failures: Array<{ operationId: string; problem: AdminApiProblem }> = [];
    for (const id of targets) {
      if (actionRequest !== actionGeneration.current || tenantScope !== activeTenant.current) return;
      const scope = `${id}:cancel`;
      const key = actionKeys.current.get(scope) ?? crypto.randomUUID();
      actionKeys.current.set(scope, key);
      try {
        const result = await client.operationAction(id, 'cancel', key);
        if (actionRequest !== actionGeneration.current || tenantScope !== activeTenant.current) return;
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
    if (actionRequest !== actionGeneration.current || tenantScope !== activeTenant.current) return;
    setSelected((current) => new Set([...current].filter((id) => !succeeded.has(id))));
    setBulkCancelFailures(failures);
    setNotice(
      `Bulk cancel finished: ${succeeded.size} succeeded, ${failures.length} failed`
      + (skippedCount > 0 ? `, ${skippedCount} skipped (already finished or not listed on this page)` : '')
      + '.',
    );
    try {
      await load();
    } finally {
      if (actionRequest === actionGeneration.current) {
        actionInFlight.current = false;
        setBusy(false);
      }
    }
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
        <Badge variant="neutral">{operationSortLabels[sort] ?? 'Newest created'}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>List</CardTitle>
          <CardDescription>Searches and filters run on the server across your full authorized operation population.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="text-xs font-semibold text-[var(--text-main)]" htmlFor="ops-state">
              State
            </label>
            <select
              id="ops-state"
              className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm"
              value={stateFilter}
              onChange={(e) => { applyCursor(null); setStateFilter(e.target.value); updateSearch({ state: e.target.value, cursor: null }); }}
            >
              {['ALL', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-[var(--text-main)]" htmlFor="ops-sort">Sort</label>
            <select id="ops-sort" value={sort} onChange={e => { applyCursor(null); setSort(e.target.value); updateSearch({ sort: e.target.value, cursor: null }); }} className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm">
              {Object.entries(operationSortLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div><label htmlFor="ops-limit" className="text-xs font-semibold">Requests per page</label>
            <select id="ops-limit" value={limit} onChange={e => { applyCursor(null); setLimit(e.target.value); updateSearch({ limit: e.target.value, cursor: null }); }} className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm">
              {['20', '50', '100'].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          </div>
          <details open={advancedFiltersOpen} onToggle={(event) => setAdvancedFiltersOpen(event.currentTarget.open)} className="rounded-md border border-[var(--border-subtle)]">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="text-[var(--cf-blue)]">{advancedFiltersOpen ? '−' : '+'}</span>
              <span>Advanced filters</span>
              {activeAdvancedFilterCount > 0 ? <Badge variant="info">{activeAdvancedFilterCount} active</Badge> : <span className="text-xs font-normal text-[var(--text-sub)]">IDs, ownership, date, usage and attention</span>}
            </summary>
            <div className="grid grid-cols-1 gap-3 border-t border-[var(--border-subtle)] p-3 sm:grid-cols-2 xl:grid-cols-4">
              <div><label htmlFor="ops-id" className="text-xs font-semibold">Operation ID</label>
                <ReferenceInput id="ops-id" aria-label="Search by operation id" className="mt-1" value={idFilter}
                  onValueChange={(value) => { applyCursor(null); setIdFilter(value); updateSearch({ id: value, cursor: null }); }}
                  scopeKey={operationScopeKey} loadOptions={loadOperationIdSuggestions} sourceVersion={operationSuggestionVersion}
                  placeholder="id contains…" autoComplete="off" />
                <p className="mt-1 text-xs text-[var(--text-sub)]">Suggestions show only the loaded operations page. You can still enter any partial operation ID.</p>
              </div>
              {operationSearchFields.map(field => <div key={field.param}>
                <label htmlFor={field.id} className="text-xs font-semibold">{field.label}</label>
                <input id={field.id} aria-label={`Search by ${field.label.toLowerCase()}`} className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm" value={field.value}
                  placeholder={field.placeholder}
                  onChange={e => { applyCursor(null); field.set(e.target.value); updateSearch({ [field.param]: e.target.value, cursor: null }); }} />
              </div>)}
              <div><label htmlFor="ops-from" className="text-xs font-semibold">From</label>
                <input id="ops-from" aria-label="From date (UTC)" type="date" className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm" value={fromDate}
                  onChange={(e) => { applyCursor(null); setFromDate(e.target.value); updateSearch({ from: e.target.value, cursor: null }); }} />
              </div>
              <div><label htmlFor="ops-to" className="text-xs font-semibold">To</label>
                <input id="ops-to" aria-label="To date (UTC)" type="date" className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm" value={toDate}
                  onChange={(e) => { applyCursor(null); setToDate(e.target.value); updateSearch({ to: e.target.value, cursor: null }); }} />
              </div>
              <p className="self-end pb-2 text-xs text-[var(--text-sub)] sm:col-span-2 xl:col-span-4">From and To include the full selected UTC days.</p>
              <div>
                <label htmlFor="ops-usage" className="text-xs font-semibold">Usage records</label>
                <select id="ops-usage" value={usageFilter} onChange={e => { const value = e.target.value as typeof usageFilter; applyCursor(null); setUsageFilter(value); updateSearch({ usage: value === 'any' ? null : value, cursor: null }); }} className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm">
                  <option value="any">Any</option><option value="has-recorded-usage">Has recorded usage</option><option value="no-recorded-usage">No recorded usage</option>
                </select>
              </div>
              <div>
                <label htmlFor="ops-reservation" className="text-xs font-semibold">Budget reservation</label>
                <select id="ops-reservation" value={reservationFilter} onChange={e => { const value = e.target.value as typeof reservationFilter; applyCursor(null); setReservationFilter(value); updateSearch({ reservation: value === 'any' ? null : value, cursor: null }); }} className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm">
                  <option value="any">Any</option><option value="unknown">Reservation outcome UNKNOWN</option>
                </select>
              </div>
              <div>
                <label htmlFor="ops-attention" className="text-xs font-semibold">Attention</label>
                <select id="ops-attention" value={attentionFilter} onChange={e => { const value = e.target.value as typeof attentionFilter; applyCursor(null); setAttentionFilter(value); updateSearch({ attention: value === 'any' ? null : value, cursor: null }); }} className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm">
                  <option value="any">Any</option><option value="waiting-input">Waiting for human input</option>
                </select>
              </div>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => void load()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || selected.size === 0 || role === 'viewer'}
            onClick={() => setBulkCancelConfirmOpen(true)}
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
            Provider/model match recorded usage events. “No recorded usage” describes the ledger only; it does not mean a provider call is pending. UNKNOWN means a durable budget reservation has unknown outcome.
          </span>
          </div>
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
      {invalidSearchLabel !== null ? (
        <AlertBanner variant="warning" title={`Check the ${invalidSearchLabel.toLowerCase()} search`}>
          Search values can contain up to 128 characters and cannot include control characters. The current results stay visible until the value is corrected.
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
        <TableContainer maxHeight="65dvh" role="region" aria-label="Operations results">
          <Table aria-label="Operations" density="compact">
            <TableHeader sticky>
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
                <TableHead className="whitespace-nowrap">ID</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Business / action</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="whitespace-nowrap">Finished</TableHead>
                <TableHead className="whitespace-nowrap">Total elapsed</TableHead>
                <TableHead className="whitespace-nowrap">Actions</TableHead>
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
                      className="whitespace-nowrap text-[var(--cf-blue)] underline"
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
                  <TableCell className="min-w-36 text-xs" title={op.progress?.message ?? 'Progress not reported'}>
                    {op.progress ? <><span className="font-semibold">{op.progress.percent}%</span>{op.progress.message ? <span className="ml-1 text-[var(--text-sub)]">{op.progress.message}</span> : null}</> : <span className="text-[var(--text-sub)]">Not reported</span>}
                  </TableCell>
                  <TableCell className="max-w-64 text-xs" title={`${op.businessId ?? '—'} · ${op.action ?? '—'}`}>
                    <span className="block max-w-64 truncate">{op.businessId ?? '—'}</span>
                    <span className="block whitespace-nowrap text-[var(--text-sub)]">{op.action ?? '—'}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-[var(--text-sub)]">{formatTime(op.createdAt)}</TableCell>
                  <TableCell className="text-xs">{terminalStates.includes(op.state) ? formatTime(op.completedAt) : 'In progress'}</TableCell>
                  <TableCell className="text-xs">{formatDuration(elapsedMs(op, nowIso))}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex w-max flex-nowrap items-center gap-2">
                      <Button className="shrink-0" size="sm" variant="outline" onClick={() => void openDetail(op.id)}>Detail</Button>
                      <Button className="shrink-0" size="sm" variant="outline" disabled={busy || role === 'viewer' || terminalStates.includes(op.state) || op.state === 'CANCEL_REQUESTED'} onClick={() => requestControl(op, 'cancel')}>Stop</Button>
                      <Button className="shrink-0" size="sm" variant="outline" disabled={busy || role !== 'admin' || Boolean(op.errorCode?.includes('UNKNOWN')) || !['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(op.state)} onClick={() => requestControl(op, 'retry')}>Retry</Button>
                      {terminalStates.includes(op.state) && <Button className="shrink-0" size="sm" variant="outline" disabled={busy || role === 'viewer'} onClick={() => requestControl(op, 'delete')}>Delete</Button>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}

      {pane?.kind === 'ready' || pane?.kind === 'empty' ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <TablePagination
            ariaLabel="Operations list pagination"
            className="min-w-0 flex-1"
            hasPreviousPage={page.kind === 'ready' && Boolean(page.data.prevCursor)}
            hasNextPage={page.kind === 'ready' && Boolean(page.data.nextCursor)}
            onPreviousPage={page.kind === 'ready' ? () => applyCursor(page.data.prevCursor ?? null) : undefined}
            onNextPage={page.kind === 'ready' ? () => applyCursor(page.data.nextCursor ?? null) : undefined}
            pending={busy}
            status={page.kind === 'ready' ? `${page.data.items.length} shown · ${page.data.totalFromServer ? `${page.data.total} total` : 'total not reported by the server'}` : 'No operations page metadata available.'}
          />
          <Button className="shrink-0" disabled={busy || cursor === null} onClick={() => applyCursor(null)}>Newest</Button>
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

      {detailTenantId === (globalTenantId ?? null) && detailLoading && detail === null ? (
        <LoadingState title="Loading operation detail…" description="The selected operation is scoped to the current tenant." />
      ) : null}
      {detailTenantId === (globalTenantId ?? null) && detailProblem !== null ? (
        <AlertBanner variant="error" title={detailProblem.title ?? 'Failed to load the operation detail.'}>
          <div className="flex flex-wrap items-center gap-3">
            <span>{detailProblem.status} · {detailProblem.code ?? 'ERROR'}</span>
            {detailIdentity.current ? (
              <Button size="sm" variant="outline" disabled={detailLoading} onClick={() => void openDetail(detailIdentity.current!.operationId)}>
                {detailLoading ? 'Loading…' : 'Retry detail load'}
              </Button>
            ) : null}
          </div>
        </AlertBanner>
      ) : null}

      {detail !== null && detailTenantId === (globalTenantId ?? null) ? (
        <Card className="mt-4 border-[var(--border-subtle)] shadow-sm">
          {detail.operation?.state === 'WAITING_INPUT' && <CardContent className="space-y-3 pt-4">
            <h3 className="font-semibold">Human review required</h3>
            <p className="text-sm">Choose a pending review and complete the requested fields. The server checks the response and rejects stale operation revisions.</p>
            <label className="block text-sm">Pending review<select className="block border rounded p-2 w-full" value={resumeWaitId} disabled={busy} onChange={e => { setResumeWaitId(e.target.value); setResumeInput('{}'); setDetailProblem(null); }}><option value="">Choose a pending review</option>{(Array.isArray(detail.raw.humanWaits) ? detail.raw.humanWaits : []).filter((wait: { status?: string }) => wait.status === 'OPEN').map((wait: { waitId: string }) => <option key={wait.waitId} value={wait.waitId}>{wait.waitId}</option>)}</select></label>
            {pendingReview && <ReviewInput key={`${detail.operation.id}:${pendingReview.waitId}`} schema={pendingReview.inputSchema} value={resumeInput} onChange={setResumeInput} disabled={busy || role === 'viewer'} />}
            {pendingReview?.expiresAt && <p className="text-xs">Review expires: {formatTime(pendingReview.expiresAt)}</p>}
            <Button disabled={busy || role === 'viewer' || !pendingReview || reviewErrors.length > 0} onClick={() => void resume()}>Submit review and resume</Button>
          </CardContent>}
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
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {detail.operation && !terminalStates.includes(detail.operation.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || role === 'viewer' || detail.operation.state === 'CANCEL_REQUESTED'}
                    onClick={() => requestControl(detail.operation!, 'cancel')}
                  >
                    Stop
                  </Button>
                )}
                {detail.operation && ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(detail.operation.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || role !== 'admin' || currentUnknownOutcome === true}
                    onClick={() => requestControl(detail.operation!, 'retry')}
                  >
                    Retry
                  </Button>
                )}
                {detail.operation && terminalStates.includes(detail.operation.state) && (
                  <Button size="sm" variant="outline" disabled={busy || role === 'viewer'} onClick={() => requestControl(detail.operation!, 'delete')}>Delete</Button>
                )}
                {detail.operation?.state === 'SUCCEEDED' && <a className="shrink-0 whitespace-nowrap text-sm underline" href={`/admin/api/operations/${encodeURIComponent(detail.operation.id)}/download`}>Download result</a>}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => detail.operation && void openDetail(detail.operation.id)}>Refresh detail</Button>
                <Button size="sm" variant="ghost" onClick={() => { ++detailRequest.current; setDetail(null); setDetailLoading(false); detailIdentity.current = null; lastRouteOperation.current = null; setResumeWaitId(''); setResumeInput('{}'); updateSearch({ operation: null }, true); }}>
                  Close
                </Button>
              </div>
            </div>
            <CardDescription className="text-xs">
              ID: <span className="font-mono text-[var(--text-main)]">{detail.operation?.id}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            {currentUnknownOutcome && <p role="alert" className="mb-4">Provider outcome is unknown. Reconcile the original invocation before retrying; a new execution may duplicate provider charges or effects.</p>}
            {detail.operation && <CallbackDeliveries key={`${globalTenantId}:${detail.operation.id}`} client={client} operationId={detail.operation.id} canManage={role !== 'viewer'} />}

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

                      <dt className="text-[var(--text-sub)]">Progress</dt>
                      <dd>{detail.operation.progress ? `${detail.operation.progress.percent}%${detail.operation.progress.message ? ` · ${detail.operation.progress.message}` : ''}` : 'Not reported'}</dd>

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

                      {resolutionRefs ? (
                        <>
                          <dt className="text-[var(--text-sub)]">Pinned profile</dt>
                          <dd className="break-all font-mono">
                            {safeRefText(resolutionRefs['profileId']) ?? 'not reported'}
                            {typeof resolutionRefs['profileRevision'] === 'number' ? ` · revision ${resolutionRefs['profileRevision']}` : ''}
                          </dd>
                          {safeRefText(resolutionRefs['endpointSlug']) ? (
                            <>
                              <dt className="text-[var(--text-sub)]">Endpoint selector</dt>
                              <dd className="break-all font-mono">{safeRefText(resolutionRefs['endpointSlug'])}</dd>
                            </>
                          ) : null}
                          {safeRefText(resolutionRefs['resolutionFingerprint']) ? (
                            <>
                              <dt className="text-[var(--text-sub)]">Resolution fingerprint</dt>
                              <dd className="break-all font-mono">{safeRefText(resolutionRefs['resolutionFingerprint'])}</dd>
                            </>
                          ) : null}
                        </>
                      ) : null}
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
                            <TableHead className="text-xs">Admission</TableHead>
                            <TableHead className="text-xs">Spawned by</TableHead>
                            <TableHead className="text-xs">Awaited child join</TableHead>
                            <TableHead className="text-xs">Worker / lease</TableHead>
                            <TableHead className="text-xs">Due</TableHead>
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
                              <TableCell className="min-w-44 text-xs">
                                {task.admissionParkedReason
                                  ? <><Badge variant="warning">Parked · {task.admissionParkedReason}</Badge><span className="mt-1 block text-[var(--text-sub)]">{task.admissionParkedAt ? `Since ${formatTime(task.admissionParkedAt)}` : 'Park time unavailable'}</span></>
                                  : task.admissionParkedReason === null
                                    ? <span className="text-[var(--text-sub)]">Not parked</span>
                                    : <span className="text-[var(--text-sub)]">Unavailable</span>}
                              </TableCell>
                              <TableCell className="max-w-52 text-xs">
                                {task.spawnedBy ? <span className="block font-mono">Spawned by {task.spawnedBy.slice(0, 8)}</span> : <span className="block text-[var(--text-sub)]">Root task</span>}
                              </TableCell>
                              <TableCell className="max-w-48 text-xs">
                                {task.awaitedChildren?.length ? task.awaitedChildren.map((edge) => <span key={edge.taskId} className="block font-mono" title={edge.joinPolicy}>Awaits {edge.taskId.slice(0, 8)} · {edge.joinPolicy}</span>) : '—'}
                              </TableCell>
                              <TableCell className="max-w-48 text-xs">
                                <span className="block font-mono">{task.leasedBy ?? 'Unassigned'}</span>
                                <span className="block text-[var(--text-sub)]">{task.leaseExpiresAt ? `Lease until ${formatTime(task.leaseExpiresAt)}` : 'No active lease'}</span>
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-xs">{task.dueAt ? formatTime(task.dueAt) : 'Runnable now'}</TableCell>
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
                      Task creation-order snapshot
                    </h3>
                  </div>
                  <p className="text-xs text-[var(--text-sub)]">The horizontal order reflects task creation time only. Spawn ancestry and child join groups are shown in the task graph table.</p>
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
      <ConfirmDialog
        open={bulkCancelConfirmOpen}
        onOpenChange={(open) => { if (!open && !busy) setBulkCancelConfirmOpen(false); }}
        title="Cancel selected operations?"
        description={`This requests cancellation for the selected non-terminal operations (${selected.size} selected). Requests already finished or off this page will be skipped. Provider work that already completed cannot be undone.`}
        confirmText="Cancel selected"
        cancelText="Go back"
        variant="destructive"
        isLoading={busy}
        onConfirm={() => { setBulkCancelConfirmOpen(false); void cancelSelected(); }}
      />
      <ConfirmDialog
        open={pendingControl !== null}
        onOpenChange={(open) => { if (!open && !busy) setPendingControl(null); }}
        title={pendingControl?.action === 'retry' ? 'Retry this operation?' : pendingControl?.action === 'delete' ? 'Delete this terminal operation?' : 'Stop this operation?'}
        description={pendingControl?.action === 'retry'
          ? 'This submits one new operation with the original request and pinned revisions. Provider work may run again. Do not continue while any invocation outcome is unknown; backend admission limits still apply.'
          : pendingControl?.action === 'delete'
            ? 'This hides the terminal operation from the active list and records an audit event. Existing artifacts and audit history are retained. The server rejects non-terminal or out-of-scope operations.'
            : 'This requests cancellation. Work that already completed cannot be undone, and a running provider call may finish before the stop takes effect.'}
        confirmText={pendingControl?.action === 'retry' ? 'Start one retry' : pendingControl?.action === 'delete' ? 'Delete operation' : 'Stop operation'}
        cancelText="Go back"
        variant="destructive"
        isLoading={busy}
        onConfirm={() => {
          if (!pendingControl) return;
          if (pendingControl.action === 'delete') void deleteOperation(pendingControl.operation, pendingControl.tenantId);
          else void control(pendingControl.operation, pendingControl.action, pendingControl.tenantId);
        }}
      />
    </section>
  );
}
