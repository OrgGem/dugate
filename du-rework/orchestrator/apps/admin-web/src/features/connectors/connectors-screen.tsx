import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTenantUuid } from '@du/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ReferenceInput, type ReferenceOption, type ReferenceOptionPage } from '@/components/ui/reference-input';
import { AlertBanner, DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
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
import { TabsList, TabsPanel, TabsRoot, TabsTab } from '@/components/ui/tabs';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type AdminApiResult,
  type ConnectorCapabilities,
  type ConnectorListPage,
  type ConnectorRevisionRead,
  type PostActionResult,
  type TenantConnectorRecipeCatalogItem,
  type TenantConnectorRecipeCatalogPage,
} from '@/lib/api';
import { type Loadable, paneStateFrom } from '@/features/overview/state';
import { CurlImportPreview, CurlImportSummaryView } from './curl-import-preview';
import { summarizeCurlImport } from './curl-import';
import { ParityConnectorEditor } from './parity-connector-editor';
import {
  isCurrentTenantRequest,
  parseTypedConnectorRecipeCatalogPage,
  shouldShowTypedCatalogPageControls,
} from './typed-recipe-catalog';
import { useTenant } from '@/lib/tenant-context';
import type { ProviderTestRequest } from '@du/contracts';
import { TenantAttemptRegistry, type ImmutableAttempt } from '@/features/submissions/immutable-attempt';
import {
  buildConnectorUpsertParams,
  connectorActionGating,
  connectorActiveRevision,
  connectorIdSuggestions,
  connectorStateVariant,
  draftFromCurlImport,
  parseConnectorCapabilities,
  parseConnectorList,
  parseConnectorRevisionRead,
  parseConnectorTestResult,
  summarizeConnectorConfig,
  type ConnectorImportDraft,
} from './state';

type ListState = { kind: 'idle' } | Loadable<ConnectorListPage>;
type LookupState = { kind: 'idle' } | Loadable<ConnectorRevisionRead>;
type TypedCatalogState = { kind: 'idle' | 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; data: TenantConnectorRecipeCatalogPage };

const UNREADABLE_CAPABILITIES: AdminApiProblem = {
  status: 502,
  code: 'UNREADABLE_RESPONSE',
  title: 'Unreadable capability advertisement.',
};
const UNREADABLE_LIST: AdminApiProblem = {
  status: 502,
  code: 'UNREADABLE_RESPONSE',
  title: 'Unreadable connector list.',
};
const UNREADABLE_REVISION: AdminApiProblem = {
  status: 502,
  code: 'UNREADABLE_RESPONSE',
  title: 'Unreadable connector revision.',
};
const UNREADABLE_TEST: AdminApiProblem = {
  status: 502,
  code: 'UNREADABLE_RESPONSE',
  title: 'Unreadable connector test result.',
};

function errorText(problem: AdminApiProblem): string {
  return `${problem.status} · ${problem.code ?? 'ERROR'}${problem.title ? ` — ${problem.title}` : ''}`;
}

/**
 * Connectors (AWEB-05, CONNECTOR-WIRE-B) — management surface.
 *
 * Every write control is gated on the platform's OWN composition
 * advertisement (`/admin/api/connectors/capabilities`): `management` for
 * list/upsert/activate/disable/retire, `test` for the probe. An unreadable
 * advertisement gates everything off (fail-closed) instead of assuming the
 * backend exists; a 503/404 from the platform is rendered as the honest
 * "not composed on this deployment" state. Never a fake button.
 *
 * The revision read answers in two shapes: the real connector ledger when the
 * store is composed, and the platform's endpoint-only degraded projection when
 * it is not. The reader discriminates on the key set and the card labels which
 * one it is looking at.
 */
export function ConnectorsScreen() {
  // ONE client per screen: the CSRF token from the BFF session is held by this
  // client and must ride every mutation below.
  const client = useMemo(() => createAdminApiClient(), []);
  const { tenantId } = useTenant();
  const activeTenantId = useRef(tenantId);
  activeTenantId.current = tenantId;
  const parityAttempts = useRef(new TenantAttemptRegistry<ImmutableAttempt<ProviderTestRequest>>());
  const [parityAttemptVersion, setParityAttemptVersion] = useState(0);
  const savedParityAttempt = useMemo(
    () => tenantId ? parityAttempts.current.get(tenantId) : null,
    [parityAttemptVersion, tenantId],
  );
  const rememberParityAttempt = useCallback((scope: string, attempt: ImmutableAttempt<ProviderTestRequest> | null) => {
    if (parityAttempts.current.set(scope, attempt)) setParityAttemptVersion((version) => version + 1);
  }, []);
  const [capabilities, setCapabilities] = useState<Loadable<ConnectorCapabilities>>({ kind: 'loading' });
  const [list, setList] = useState<ListState>({ kind: 'idle' });
  const [typedCatalog, setTypedCatalog] = useState<TypedCatalogState>({ kind: 'idle' });
  const [typedCatalogQuery, setTypedCatalogQuery] = useState('');
  const [typedCatalogCursors, setTypedCatalogCursors] = useState<Array<string | null>>([null]);
  const [typedCatalogPageIndex, setTypedCatalogPageIndex] = useState(0);
  const [typedCatalogOpenRequest, setTypedCatalogOpenRequest] = useState<{
    requestId: number;
    tenantId: string;
    connectorId: string;
    revision: number;
  } | null>(null);
  const [connectorId, setConnectorId] = useState(() => new URLSearchParams(window.location.search).get('connectorId') ?? '');
  const [revision, setRevision] = useState(() => new URLSearchParams(window.location.search).get('revision') ?? 'latest');
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
  const [activeTab, setActiveTab] = useState<'catalog' | 'inspector' | 'recipe' | 'curl-import'>('catalog');
  const [catalogPage, setCatalogPage] = useState(0);
  const [selectedCatalogKey, setSelectedCatalogKey] = useState<string | null>(null);
  const [selectedTypedCatalogKey, setSelectedTypedCatalogKey] = useState<string | null>(null);
  const [importDraft, setImportDraft] = useState<ConnectorImportDraft | null>(null);
  const [draftConnectorId, setDraftConnectorId] = useState('');
  const [draftAdapter, setDraftAdapter] = useState('');
  const [draftCredentialRef, setDraftCredentialRef] = useState('');
  const [actionProblem, setActionProblem] = useState<AdminApiProblem | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const notifyEditorBusy = useCallback((scope: string, value: boolean): void => {
    const currentTenantId = activeTenantId.current;
    if (!isTenantUuid(scope) || !isTenantUuid(currentTenantId) || scope.toLowerCase() !== currentTenantId.toLowerCase()) return;
    setEditorBusy(value);
  }, []);
  const busyRef = useRef(false);
  const loadGeneration = useRef(0);
  const typedCatalogGeneration = useRef(0);
  const typedCatalogQueryRef = useRef(typedCatalogQuery);
  typedCatalogQueryRef.current = typedCatalogQuery;
  const typedCatalogOpenSequence = useRef(0);
  const [confirmTarget, setConfirmTarget] = useState<{
    kind: 'disable' | 'retire';
    connectorId: string;
    revision: number;
  } | null>(null);

  const refreshList = useCallback(async (): Promise<void> => {
    setCatalogPage(0);
    setList({ kind: 'loading' });
    const result = await client.listConnectors();
    if (!result.ok) {
      setList({ kind: 'failed', problem: result.problem });
      return;
    }
    const page = parseConnectorList(result.data);
    setList(page === null ? { kind: 'failed', problem: UNREADABLE_LIST } : { kind: 'ready', data: page });
  }, [client]);

  const refreshTypedRecipeCatalog = useCallback(async (cursor: string | null = null): Promise<void> => {
    const requestedTenantId = tenantId;
    if (!isCurrentTenantRequest(activeTenantId.current, requestedTenantId, loadGeneration.current, loadGeneration.current)) return;
    if (!isTenantUuid(requestedTenantId)) {
      setTypedCatalog({ kind: 'idle' });
      return;
    }
    const generation = ++typedCatalogGeneration.current;
    setTypedCatalog({ kind: 'loading' });
    const result = await client.listTenantConnectorRecipeCatalog({
      tenantId: requestedTenantId,
      limit: 50,
      ...(typedCatalogQueryRef.current.trim() ? { q: typedCatalogQueryRef.current.trim() } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (!isCurrentTenantRequest(activeTenantId.current, requestedTenantId, generation, typedCatalogGeneration.current)) return;
    if (!result.ok) {
      setTypedCatalog({ kind: 'failed', message: errorText(result.problem) });
      return;
    }
    const page = parseTypedConnectorRecipeCatalogPage(result.data, requestedTenantId);
    setTypedCatalog(page === null
      ? { kind: 'failed', message: 'Typed recipe catalog returned an unreadable response or crossed the selected tenant boundary.' }
      : { kind: 'ready', data: page });
  }, [client, tenantId]);

  const onRecipeCatalogChange = useCallback((): void => {
    if (!isCurrentTenantRequest(activeTenantId.current, tenantId, loadGeneration.current, loadGeneration.current)) return;
    setTypedCatalogCursors([null]);
    setTypedCatalogPageIndex(0);
    void refreshTypedRecipeCatalog(null);
  }, [refreshTypedRecipeCatalog, tenantId]);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setCapabilities({ kind: 'loading' });
    setList({ kind: 'idle' });
    setTypedCatalog({ kind: 'idle' });
    typedCatalogGeneration.current += 1;
    setSessionFailed(false);
    setIsAdmin(false);
    // The client learns the server-issued CSRF proof from THIS read. Without it
    // the BFF rejects every mutation 403 CSRF_REJECTED, so the session read must
    // precede any write path (same bootstrap as the sibling admin screens).
    const sessionResult = await client.getSession();
    if (generation !== loadGeneration.current) return;
    if (!sessionResult.ok) {
      setSessionFailed(true);
      setCapabilities({ kind: 'failed', problem: sessionResult.problem });
      return;
    }
    setIsAdmin(sessionResult.data.role === 'admin' && sessionResult.data.principal.kind === 'platform');
    const capsResult = await client.getConnectorCapabilities();
    if (generation !== loadGeneration.current) return;
    if (!capsResult.ok) {
      setCapabilities({ kind: 'failed', problem: capsResult.problem });
      return;
    }
    const caps = parseConnectorCapabilities(capsResult.data);
    if (caps === null) {
      setCapabilities({ kind: 'failed', problem: UNREADABLE_CAPABILITIES });
      return;
    }
    setCapabilities({ kind: 'ready', data: caps });
    if (!caps.management) return;
    await refreshList();
    if (!isCurrentTenantRequest(activeTenantId.current, tenantId, generation, loadGeneration.current)) return;
    if (isTenantUuid(tenantId)) {
      setTypedCatalogCursors([null]);
      setTypedCatalogPageIndex(0);
      await refreshTypedRecipeCatalog();
    }
  }, [client, refreshList, refreshTypedRecipeCatalog, tenantId]);

  useEffect(() => {
    setTypedCatalog({ kind: 'idle' });
    setTypedCatalogCursors([null]);
    setTypedCatalogPageIndex(0);
    setTypedCatalogOpenRequest(null);
    setSelectedTypedCatalogKey(null);
    setEditorBusy(false);
  }, [tenantId]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const caps = capabilities.kind === 'ready' ? capabilities.data : null;
  const gating = connectorActionGating(caps);
  const validTenantSelected = isTenantUuid(tenantId);
  const screenGating = {
    ...gating,
    upsert: gating.upsert && validTenantSelected,
    activate: gating.activate && validTenantSelected,
    disable: gating.disable && validTenantSelected,
    retire: gating.retire && validTenantSelected,
    test: gating.test && validTenantSelected,
    reason: validTenantSelected ? gating.reason : 'Select a valid tenant before changing or testing connectors.',
  };

  const fetchRevision = useCallback(
    async (id: string, rev: string): Promise<void> => {
      setLookup({ kind: 'loading' });
      const result = await client.getConnectorRevision(id, rev);
      if (!result.ok) {
        setLookup({ kind: 'failed', problem: result.problem });
        return;
      }
      const parsed = parseConnectorRevisionRead(result.data);
      setLookup(parsed === null ? { kind: 'failed', problem: UNREADABLE_REVISION } : { kind: 'ready', data: parsed });
    },
    [client],
  );

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get('connectorId');
    if (id) {
      setActiveTab('inspector');
      void fetchRevision(id, query.get('revision') ?? 'latest');
    }
  }, [fetchRevision]);

  /** Reload whatever is on screen after a mutation, so the UI shows new truth. */
  async function refreshAfterMutation(): Promise<void> {
    if (caps?.management === true) await refreshList();
    if (lookup.kind === 'ready') {
      await fetchRevision(connectorId.trim(), revision.trim() || 'latest');
    }
  }

  async function runAction(
    work: () => Promise<AdminApiResult<PostActionResult>>,
    notice: string,
    required: 'upsert' | 'activate' | 'disable' | 'retire',
  ): Promise<void> {
    if (!validTenantSelected) {
      setActionProblem({ status: 409, code: 'TENANT_REQUIRED', title: 'Select a valid tenant before changing connectors.' });
      return;
    }
    if (!screenGating[required]) {
      setActionProblem({ status: 503, code: 'CONNECTOR_CAPABILITY_UNAVAILABLE', title: screenGating.reason || 'The required connector capability is unavailable.' });
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setActionProblem(null);
    setActionNotice(null);
    setBusy(true);
    try {
      const result = await work();
      if (!result.ok) {
        setActionProblem(result.problem);
        return;
      }
      setActionNotice(notice);
      await refreshAfterMutation();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmConnectorAction(): Promise<void> {
    const target = confirmTarget;
    if (target === null) return;
    const work =
      target.kind === 'disable'
        ? () => client.disableConnector(target.connectorId, crypto.randomUUID())
        : () =>
            client.retireConnector(
              { connectorId: target.connectorId, revision: target.revision },
              crypto.randomUUID(),
            );
    await runAction(
      work,
      target.kind === 'disable'
        ? `Disable requested for ${target.connectorId}.`
        : `Retire requested for ${target.connectorId}@${target.revision}.`,
      target.kind,
    );
    setConfirmTarget(null);
  }

  async function activateRevision(id: string, rev: number): Promise<void> {
    const expected = list.kind === 'ready' ? connectorActiveRevision(list.data.items, id) : null;
    if (expected === null) return;
    await runAction(
      () =>
        client.activateConnector(
          { connectorId: id, revision: rev, expectedCurrentRevision: expected },
          crypto.randomUUID(),
        ),
      `Activate requested for ${id}@${rev}.`,
      'activate',
    );
  }

  async function testConnection(id: string): Promise<void> {
    if (!validTenantSelected) {
      setActionProblem({ status: 409, code: 'TENANT_REQUIRED', title: 'Select a valid tenant before testing a connector.' });
      return;
    }
    if (!screenGating.test) {
      setActionProblem({ status: 503, code: 'CONNECTOR_CAPABILITY_UNAVAILABLE', title: screenGating.reason || 'Connector testing is unavailable.' });
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setActionProblem(null);
    setActionNotice(null);
    setBusy(true);
    try {
      const result = await client.testConnector(id, crypto.randomUUID());
      if (!result.ok) {
        setActionProblem(result.problem);
        return;
      }
      const probe = parseConnectorTestResult(result.data);
      if (probe === null) {
        setActionProblem(UNREADABLE_TEST);
        return;
      }
      setActionNotice(
        probe.ok
          ? `Connector ${id}: masked probe ok.`
          : `Connector ${id}: masked probe failed${probe.errorCode === undefined ? '' : ` (${probe.errorCode})`}.`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const upsertPlan = importDraft === null ? null : buildConnectorUpsertParams(importDraft, {
    connectorId: draftConnectorId,
    adapter: draftAdapter,
    credentialRef: draftCredentialRef,
  });

  async function saveDraft(): Promise<void> {
    if (upsertPlan === null || !upsertPlan.ok) return;
    const params = upsertPlan.params;
    await runAction(
      () => client.upsertConnector(params, crypto.randomUUID()),
      `Connector ${params.connectorId} saved (mode create, credential slot ${params.credentialRef}).`,
      'upsert',
    );
  }

  const state = lookup.kind === 'idle' ? null : paneStateFrom(lookup);
  const unavailable = lookup.kind === 'failed' && lookup.problem.status === 404;
  const capsFailed = capabilities.kind === 'failed' ? capabilities.problem : null;
  const listState = list.kind === 'idle' ? null : paneStateFrom(list);
  // Hoisted so JSX callbacks read plain consts (no narrowing inside closures).
  const listRows = listState !== null && listState.kind === 'ready' ? listState.data.items : [];
  const listSkipped = listState !== null && listState.kind === 'ready' ? listState.data.skipped : 0;
  const read = state !== null && state.kind === 'ready' ? state.data : null;
  const readConnectorId = read === null ? '' : read.revision.connectorId;
  const readRevisionNumber = read === null ? 0 : read.revision.revision;
  const activeRevision = read === null ? null : connectorActiveRevision(listRows, readConnectorId);
  const scopedConnectorRows = useMemo(() => listRows.filter((row) => row.tenantId == null
    || (isTenantUuid(tenantId) && row.tenantId.toLowerCase() === tenantId.toLowerCase())), [listRows, tenantId]);
  const typedCatalogRows = useMemo(() => typedCatalog.kind === 'ready'
    && isTenantUuid(tenantId)
    && typedCatalog.data.tenantId === tenantId.toLowerCase()
    ? typedCatalog.data.items
    : [], [tenantId, typedCatalog]);
  const connectorSuggestionOptions = useMemo(() => {
    const options = new Map<string, ReferenceOption>();
    const typedById = new Map<string, Array<{ revision: number; state: string }>>();
    for (const row of typedCatalogRows) {
      const revisions = typedById.get(row.connectorId) ?? [];
      revisions.push({ revision: row.revision, state: row.state });
      typedById.set(row.connectorId, revisions);
    }
    for (const [id, revisions] of typedById) {
      const source = revisions.map(({ revision, state }) => `${state} revision ${revision}`).join(', ');
      options.set(id, { value: id, label: id, description: `Typed tenant recipe · ${source} · current catalog page` });
    }
    if (caps?.management === true) {
      for (const id of connectorIdSuggestions(caps, scopedConnectorRows)) {
        if (!options.has(id)) options.set(id, { value: id, label: id, description: 'Persisted Connector ID · current management list' });
      }
    }
    if (caps !== null && !caps.management) {
      for (const id of caps.knownConnectorIds) {
        if (!options.has(id)) options.set(id, { value: id, label: id, description: 'Configured Connector ID · persisted revision availability is unverified' });
      }
    }
    return [...options.values()];
  }, [caps, scopedConnectorRows, typedCatalogRows]);
  const selectedTypedRecipeRevision = typedCatalogRows.find((row) => row.connectorId === connectorId.trim()
    && String(row.revision) === revision.trim()) ?? null;
  const selectedConnectorRevisions = [...new Set([
    ...scopedConnectorRows.filter((row) => row.connectorId === connectorId.trim()).map((row) => row.revision),
    ...typedCatalogRows.filter((row) => row.connectorId === connectorId.trim()).map((row) => row.revision),
  ])];
  const loadConnectorIdSuggestions = useCallback(async (
    query: string,
    scopeKey: string,
    cursor: string | null,
  ): Promise<ReferenceOptionPage> => {
    if (cursor || !isTenantUuid(tenantId) || !isTenantUuid(scopeKey)
      || tenantId.toLowerCase() !== scopeKey.toLowerCase()) return { items: [], nextCursor: null };
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const items = connectorSuggestionOptions.filter((option) =>
      `${option.value} ${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(normalizedQuery));
    return { items, nextCursor: null };
  }, [connectorSuggestionOptions, tenantId]);
  const catalogPageSize = 10;
  const catalogPageCount = Math.max(1, Math.ceil(listRows.length / catalogPageSize));
  const visibleListRows = listRows.slice(catalogPage * catalogPageSize, (catalogPage + 1) * catalogPageSize);
  const catalogRangeStart = listRows.length === 0 ? 0 : catalogPage * catalogPageSize + 1;
  const catalogRangeEnd = Math.min(listRows.length, (catalogPage + 1) * catalogPageSize);

  useEffect(() => {
    if (catalogPage >= catalogPageCount) setCatalogPage(Math.max(0, catalogPageCount - 1));
  }, [catalogPage, catalogPageCount]);

  function inspectCatalogRevision(id: string, rev: number): void {
    if (busyRef.current) return;
    setSelectedCatalogKey(`${id}@${rev}`);
    setConnectorId(id);
    setRevision(String(rev));
    setActiveTab('inspector');
    void fetchRevision(id, String(rev));
  }

  function openTypedRecipe(row: TenantConnectorRecipeCatalogItem): void {
    if (busyRef.current || editorBusy || !isTenantUuid(tenantId)) return;
    setSelectedTypedCatalogKey(`${row.connectorId}@${row.revision}`);
    setTypedCatalogOpenRequest({
      requestId: ++typedCatalogOpenSequence.current,
      tenantId: tenantId.toLowerCase(),
      connectorId: row.connectorId,
      revision: row.revision,
    });
    setActiveTab('recipe');
  }

  function searchTypedRecipeCatalog(): void {
    setTypedCatalogCursors([null]);
    setTypedCatalogPageIndex(0);
    void refreshTypedRecipeCatalog(null);
  }

  function goToTypedCatalogPage(direction: 'previous' | 'next'): void {
    if (typedCatalog.kind !== 'ready') return;
    if (direction === 'next') {
      const nextCursor = typedCatalog.data.nextCursor;
      if (!nextCursor) return;
      const nextIndex = typedCatalogPageIndex + 1;
      setTypedCatalogCursors((cursors) => [...cursors.slice(0, nextIndex), nextCursor]);
      setTypedCatalogPageIndex(nextIndex);
      void refreshTypedRecipeCatalog(nextCursor);
      return;
    }
    if (typedCatalogPageIndex < 1) return;
    const previousIndex = typedCatalogPageIndex - 1;
    const previousCursor = typedCatalogCursors[previousIndex] ?? null;
    setTypedCatalogPageIndex(previousIndex);
    void refreshTypedRecipeCatalog(previousCursor);
  }

  return (
    <section aria-labelledby="connectors-title" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="connectors-title" className="text-lg font-semibold">
          Connectors
        </h1>
        <Badge variant={gating.upsert ? 'info' : 'neutral'}>{gating.upsert ? 'management' : 'read-only'}</Badge>
        <Button variant="outline" size="sm" onClick={() => setActiveTab('curl-import')}>
          Import cURL
        </Button>
      </div>

      {capabilities.kind === 'loading' ? (
        <AlertBanner variant="info" title="Reading composition capabilities">
          GET /admin/api/connectors/capabilities — every write control stays disabled until the
          platform says which capabilities it composed.
        </AlertBanner>
      ) : null}

      {capsFailed !== null ? (
        <AlertBanner
          variant="warning"
          title={sessionFailed ? 'Admin session unavailable' : 'Capability advertisement unavailable'}
        >
          {capsFailed.status} · {capsFailed.code ?? 'ERROR'} —{' '}
          {sessionFailed
            ? 'connector management needs the signed-in admin session (writes ride the BFF with the server-issued CSRF proof), so every write stays disabled.'
            : 'this build cannot prove which connector capabilities exist, so writes stay disabled (fail-closed).'}{' '}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Retry
          </Button>
        </AlertBanner>
      ) : null}

      {caps !== null ? (
        <AlertBanner variant={caps.management ? 'success' : 'info'} title="Composition capabilities">
          management: <strong>{String(caps.management)}</strong> · credentialWorkflow:{' '}
          <strong>{String(caps.credentialWorkflow)}</strong> · typedCredentialStorage:{' '}
          <strong>{String(caps.typedCredentialStorage === true)}</strong> · secretCatalogImport:{' '}
          <strong>{String(caps.secretCatalogImport === true)}</strong> · test: <strong>{String(caps.test)}</strong>
          {caps.management ? (
            <>
              {' '}
              — reads ride GET /admin/api/connectors; writes ride POST /admin/api/actions
              (connector.upsert | activate | disable | retire | test).
            </>
          ) : (
            <>
              {' '}
              — no connector management store is composed on this deployment (the platform answers
              503 there), so only the revision inspector is available and it returns the honest
              endpoint-only projection.
            </>
          )}
        </AlertBanner>
      ) : null}

      {!validTenantSelected ? (
        <AlertBanner variant="warning" title="Choose a valid tenant">
          Connector writes and tests require a valid current tenant. Revision inspection and recipe export remain available.
        </AlertBanner>
      ) : null}

      {caps?.management === false ? (
        <AlertBanner variant="warning" title="Full connector management unavailable">
          Set DU_CONNECTOR_BASE_URLS and SERVICE_IDENTITY_SECRET to enable connector management. Known connector IDs
          remain available for revision lookup.
        </AlertBanner>
      ) : null}

      {actionProblem !== null ? (
        <AlertBanner variant="error" title={actionProblem.title ?? 'The connector action failed.'}>
          {actionProblem.status} · {actionProblem.code ?? 'ERROR'}
          {actionProblem.status === 401 ? (
            <>
              {' '}
              <a className="underline" href="/admin/login">
                Sign in again
              </a>
            </>
          ) : null}
        </AlertBanner>
      ) : null}

      {actionNotice !== null ? (
        <AlertBanner variant="success" title="Action accepted">
          {actionNotice}
        </AlertBanner>
      ) : null}

      <TabsRoot value={activeTab} onValueChange={(value) => { if (value) setActiveTab(value as typeof activeTab); }} className="min-w-0">
        <TabsList aria-label="Connector workspaces">
          <TabsTab value="catalog">Catalog</TabsTab>
          <TabsTab value="inspector">Revision inspector</TabsTab>
          <TabsTab value="recipe">Recipe &amp; provider test</TabsTab>
          <TabsTab value="curl-import">cURL import</TabsTab>
        </TabsList>

        <TabsPanel value="catalog" keepMounted className="space-y-4">

      {listState !== null ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Legacy Connector ledger</CardTitle>
              <Button size="sm" variant="outline" onClick={() => void refreshList()} disabled={busy}>
                Refresh
              </Button>
            </div>
            <CardDescription>
              GET /admin/api/connectors — the real ledger, redacted by the connector. Config is shown
              as keys only; no header value and no credential material rides this screen.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {listState.kind === 'loading' ? <LoadingState title="Loading connectors…" /> : null}
            {listState.kind === 'denied' ? (
              <DeniedState title="Access denied" description={listState.problem.title ?? 'Not authorized.'} />
            ) : null}
            {listState.kind === 'error' ? (
              <ErrorState
                title={listState.problem.title ?? 'Failed to load connectors.'}
                statusCode={listState.problem.status}
                error={listState.problem.code}
                onRetry={() => void refreshList()}
              />
            ) : null}
            {listState.kind === 'empty' ? (
              <EmptyState
                title="No connectors"
                description="The composed connector service returned no revisions for this deployment."
                actionText="Refresh"
                onAction={() => void refreshList()}
              />
            ) : null}
            {listState.kind === 'ready' ? (
              <>
                {listSkipped > 0 ? (
                  <AlertBanner variant="warning" title="Some rows were not readable">
                    {listSkipped} row(s) failed the strict platform DTO and are not shown — they are
                    counted here rather than repaired into looking valid.
                  </AlertBanner>
                ) : null}
                <TableContainer maxHeight={360} aria-label="Connector catalog revisions">
                  <Table aria-label="Connectors" density="compact">
                    <TableHeader sticky>
                      <TableRow>
                        <TableHead>Connector</TableHead>
                        <TableHead>Revision</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Adapter</TableHead>
                        <TableHead>Active head</TableHead>
                        <TableHead>Config keys</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleListRows.map((row) => {
                        const head = connectorActiveRevision(listRows, row.connectorId);
                        const config = summarizeConnectorConfig(row.config);
                        const rowKey = `${row.connectorId}@${row.revision}`;
                        return (
                          <TableRow
                            key={rowKey}
                            data-state={selectedCatalogKey === rowKey ? 'selected' : undefined}
                            aria-disabled={busy}
                            onClick={() => {
                              if (!busyRef.current) inspectCatalogRevision(row.connectorId, row.revision);
                            }}
                            title={`Inspect ${row.connectorId} revision ${row.revision}`}
                          >
                            <TableCell className="font-medium">
                              <Button
                                type="button"
                                variant="link"
                                className="h-auto min-w-0 justify-start p-0 text-left font-medium"
                                aria-label={`Inspect ${row.connectorId} revision ${row.revision}`}
                                disabled={busy}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  inspectCatalogRevision(row.connectorId, row.revision);
                                }}
                              >
                                <code className="break-all">{row.connectorId}</code>
                              </Button>
                            </TableCell>
                            <TableCell>{row.revision}</TableCell>
                            <TableCell>
                              <Badge variant={connectorStateVariant(row.state)} dot>
                                {row.state}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs">
                              <code>{row.adapter}</code>
                            </TableCell>
                            <TableCell className="text-xs">
                              {head === null ? '—' : `rev ${head}`}
                            </TableCell>
                            <TableCell className="max-w-64 break-all text-xs text-[var(--text-sub)]">
                              {config.keys.length === 0 ? '—' : config.keys.join(', ')}
                            </TableCell>
                            <TableCell className="text-xs text-[var(--text-sub)]">Select row to inspect</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  hasPreviousPage={catalogPage > 0}
                  hasNextPage={catalogPage + 1 < catalogPageCount}
                  onPreviousPage={() => setCatalogPage((page) => Math.max(0, page - 1))}
                  onNextPage={() => setCatalogPage((page) => Math.min(catalogPageCount - 1, page + 1))}
                  status={`Showing ${catalogRangeStart}–${catalogRangeEnd} of ${listRows.length} readable loaded revisions; ${listSkipped} unreadable row(s) omitted. Page ${catalogPage + 1} of ${catalogPageCount}.`}
                  ariaLabel="Connector catalog pagination"
                />
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Typed recipe inventory</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => searchTypedRecipeCatalog()}
              disabled={!validTenantSelected || typedCatalog.kind === 'loading'}
            >
              Refresh
            </Button>
          </div>
          <CardDescription>
            Tenant-owned typed recipe revisions across their persisted lifecycle states. The list contains safe metadata only; Open reads the exact revision into the recipe editor.
          </CardDescription>
          <div className="flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end">
            <FormField id="typed-recipe-catalog-search" label="Find a typed recipe" description="Search connector ID, adapter, or authentication kind.">
              <Input
                id="typed-recipe-catalog-search"
                value={typedCatalogQuery}
                onChange={(event) => setTypedCatalogQuery(event.target.value)}
                maxLength={128}
                disabled={!validTenantSelected || typedCatalog.kind === 'loading'}
                onKeyDown={(event) => { if (event.key === 'Enter') searchTypedRecipeCatalog(); }}
              />
            </FormField>
            <Button
              variant="outline"
              onClick={() => searchTypedRecipeCatalog()}
              disabled={!validTenantSelected || typedCatalog.kind === 'loading'}
            >
              Search
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!validTenantSelected ? <AlertBanner variant="warning" title="Tenant scope required">Select a valid tenant to read typed recipes.</AlertBanner> : null}
          {caps?.management === false ? <AlertBanner variant="info" title="Typed recipe catalog unavailable">Connector recipe management is not composed on this deployment.</AlertBanner> : null}
          {typedCatalog.kind === 'idle' && validTenantSelected && caps?.management === true ? (
            <Button variant="outline" onClick={() => void refreshTypedRecipeCatalog()}>
              Load typed recipe catalog
            </Button>
          ) : null}
          {typedCatalog.kind === 'loading' ? <LoadingState title="Loading typed recipe metadata…" /> : null}
          {typedCatalog.kind === 'failed' ? (
            <AlertBanner variant="error" title="Typed recipe catalog could not be read">
              {typedCatalog.message} Refresh the page after the Connector catalog endpoint is available.
            </AlertBanner>
          ) : null}
          {typedCatalog.kind === 'ready' && typedCatalog.data.items.length === 0 && typedCatalog.data.nextCursor === null && typedCatalogPageIndex === 0 ? (
            <EmptyState
              title="No typed recipe revisions"
              description={typedCatalogQuery.trim() ? 'No typed recipes match this search.' : 'This tenant has no persisted typed Connector recipes.'}
              actionText="Refresh"
              onAction={() => searchTypedRecipeCatalog()}
            />
          ) : null}
          {typedCatalog.kind === 'ready' && shouldShowTypedCatalogPageControls(typedCatalog.data, typedCatalogPageIndex) ? (
            <>
              {typedCatalog.data.items.length === 0 ? (
                <AlertBanner
                  variant="info"
                  title={typedCatalog.data.nextCursor !== null ? 'No matches on this bounded page' : 'No further matches'}
                >
                  {typedCatalog.data.nextCursor !== null
                    ? 'Continue to check the remaining typed recipe metadata pages.'
                    : 'Return to the previous page to review the last matching typed recipe metadata.'}
                </AlertBanner>
              ) : null}
              {typedCatalog.data.items.length > 0 ? <TableContainer maxHeight={360} aria-label="Typed Connector recipe inventory">
                <Table aria-label="Typed recipes" density="compact">
                  <TableHeader sticky>
                    <TableRow>
                      <TableHead>Connector</TableHead>
                      <TableHead>Revision</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Adapter</TableHead>
                      <TableHead>Auth</TableHead>
                      <TableHead>Credential</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {typedCatalog.data.items.map((row) => {
                      const rowKey = `${row.connectorId}@${row.revision}`;
                      return (
                        <TableRow key={rowKey} data-state={selectedTypedCatalogKey === rowKey ? 'selected' : undefined}>
                          <TableCell className="font-medium"><code className="break-all">{row.connectorId}</code></TableCell>
                          <TableCell>{row.revision}</TableCell>
                          <TableCell><Badge variant={connectorStateVariant(row.state)} dot>{row.state}</Badge></TableCell>
                          <TableCell className="text-xs"><code>{row.adapter}</code></TableCell>
                          <TableCell className="text-xs"><code>{row.authKind}</code></TableCell>
                          <TableCell className="text-xs">{row.credentialConfigured ? 'Configured' : 'None'}</TableCell>
                          <TableCell>
                            <Button type="button" size="sm" variant="outline" disabled={busy || editorBusy} onClick={() => openTypedRecipe(row)}>
                              Open
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer> : null}
              <TablePagination
                hasPreviousPage={typedCatalogPageIndex > 0}
                hasNextPage={typedCatalog.data.nextCursor !== null}
                onPreviousPage={() => goToTypedCatalogPage('previous')}
                onNextPage={() => goToTypedCatalogPage('next')}
                status={`Page ${typedCatalogPageIndex + 1}; ${typedCatalog.data.items.length} typed recipe revision(s).`}
                ariaLabel="Typed recipe catalog pagination"
              />
            </>
          ) : null}
        </CardContent>
      </Card>

        </TabsPanel>

        <TabsPanel value="inspector" keepMounted className="space-y-4">

      <Card>
        <CardHeader>
          <CardTitle>Revision lookup</CardTitle>
          <CardDescription>
            Legacy revisions use GET /admin/api/connectors/:id/revisions/:rev. Exact typed tenant
            recipe rows from the currently loaded catalog page have a separate Open Recipe action.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,1fr)_minmax(9rem,0.4fr)_auto]">
          <div className="min-w-0 max-w-xl flex flex-col gap-2">
            <FormField id="connector-id" label="Connector ID" description="Choose a listed ID or enter an ID directly. Only persisted revisions for this exact ID are suggested below.">
              <ReferenceInput
                id="connector-id"
                value={connectorId}
                onValueChange={setConnectorId}
                scopeKey={validTenantSelected ? tenantId : null}
                loadOptions={loadConnectorIdSuggestions}
                sourceVersion={JSON.stringify(connectorSuggestionOptions)}
                placeholder="vendor-extract"
                autoComplete="off"
              />
            </FormField>
          </div>
          <div className="min-w-0 max-w-[10rem]">
            <FormField id="connector-revision" label="Revision">
              <Input
                id="connector-revision"
                list="connector-revision-suggestions"
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                placeholder="latest"
              />
              <datalist id="connector-revision-suggestions">
                <option value="latest" />
                {selectedConnectorRevisions.map((rev) => <option key={rev} value={String(rev)} />)}
              </datalist>
            </FormField>
          </div>
          <Button
            className="md:mt-6"
            onClick={() => void fetchRevision(connectorId.trim(), revision.trim() || 'latest')}
            disabled={connectorId.trim().length === 0}
          >
            Load legacy revision
          </Button>
          {selectedTypedRecipeRevision ? <Button variant="outline" disabled={busy || editorBusy} onClick={() => openTypedRecipe(selectedTypedRecipeRevision)}>Open Recipe {selectedTypedRecipeRevision.state} rev {selectedTypedRecipeRevision.revision}</Button> : null}
        </CardContent>
      </Card>

      {state === null ? (
        <EmptyState
          title="Nothing loaded yet"
          description={
            caps?.management === true
              ? 'Pick a revision from the list above, or enter a connector id to read its revision state.'
              : 'Enter a connector id above to read its revision state from the platform API.'
          }
        />
      ) : null}

      {state?.kind === 'loading' ? <LoadingState title="Loading connector revision…" /> : null}

      {state?.kind === 'denied' ? (
        <DeniedState title="Access denied" description={state.problem.title ?? 'Not authorized.'} />
      ) : null}

      {state !== null && state.kind === 'error' && unavailable ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Connector unavailable</CardTitle>
              <Badge variant="warning" dot>
                requires backend
              </Badge>
            </div>
            <CardDescription>
              The platform answered 404: this connector is not configured on this deployment
              (<code>connectorBaseUrls</code> / credential workflow composition are missing — F3,
              PAR-03/14). Nothing is synthesised here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void fetchRevision(connectorId.trim(), revision.trim() || 'latest')}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {state !== null && state.kind === 'error' && !unavailable ? (
        <ErrorState
          title={state.problem.title ?? 'Failed to load connector revision.'}
          statusCode={state.problem.status}
          error={state.problem.code}
          onRetry={() => void fetchRevision(connectorId.trim(), revision.trim() || 'latest')}
        />
      ) : null}

      {read !== null ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{read.revision.connectorId}</CardTitle>
              <Badge variant={connectorStateVariant(read.revision.state)} dot>
                {read.revision.state}
              </Badge>
              <Badge variant="neutral">revision {read.revision.revision}</Badge>
              <Badge variant={read.kind === 'management' ? 'info' : 'warning'}>
                {read.kind === 'management' ? 'platform ledger' : 'degraded projection'}
              </Badge>
            </div>
            <CardDescription>
              {read.kind === 'management'
                ? 'Read from the connector ledger and re-validated against the platform DTO; header values arrive [REDACTED] and config is rendered as keys only.'
                : 'No connector management store is composed, so the platform reports the configured endpoint only — adapter/capabilities are placeholders, not connector truth.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {read.kind === 'management' ? (
              <ManageRevisionFacts read={read} activeRevision={activeRevision} isPlatformAdmin={isAdmin} />
            ) : (
              <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm min-w-0">
                <dt className="text-[var(--text-sub)]">Endpoint</dt>
                <dd className="min-w-0 break-words">
                  <code>
                    {read.revision.endpoint.kind}:{read.revision.endpoint.maskedHost || '—'}
                  </code>
                </dd>
                <dt className="text-[var(--text-sub)]">Capabilities</dt>
                <dd>
                  {read.revision.capabilities.length === 0
                    ? 'none reported'
                    : read.revision.capabilities.join(', ')}
                </dd>
                <dt className="text-[var(--text-sub)]">Secret slots</dt>
                <dd>
                  {read.revision.secretSlots.length === 0
                    ? 'none reported'
                    : `${read.revision.secretSlots.length} slot(s)`}
                </dd>
                <dt className="text-[var(--text-sub)]">Updated</dt>
                <dd className="text-xs">{read.revision.updatedAt}</dd>
              </dl>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!screenGating.test || busy}
                title={
                  screenGating.test
                    ? 'Masked probe over the management surface.'
                    : screenGating.reason || 'The platform did not advertise the connector test capability (test:false).'
                }
                onClick={() => void testConnection(readConnectorId)}
              >
                Test connection
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!screenGating.activate || activeRevision === null || busy}
                title={
                  !screenGating.activate
                    ? screenGating.reason
                    : activeRevision === null
                      ? 'The ACTIVE head is not visible in the loaded catalog; refresh the connector list before activating (CAS needs it).'
                      : `CAS on the current ACTIVE head (rev ${activeRevision}).`
                }
                onClick={() => void activateRevision(readConnectorId, readRevisionNumber)}
              >
                Activate
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!screenGating.disable || busy}
                title={screenGating.disable ? 'Disable this connector (reversible).' : screenGating.reason}
                onClick={() =>
                  setConfirmTarget({
                    kind: 'disable',
                    connectorId: readConnectorId,
                    revision: readRevisionNumber,
                  })
                }
              >
                Disable
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={!screenGating.retire || busy}
                title={
                  screenGating.retire
                    ? 'Retire this revision (reference-safe; pinned operations keep it).'
                    : screenGating.reason
                }
                onClick={() =>
                  setConfirmTarget({
                    kind: 'retire',
                    connectorId: readConnectorId,
                    revision: readRevisionNumber,
                  })
                }
              >
                Retire revision
              </Button>
            </div>
            <span className="text-xs text-[var(--text-sub)]">
              Writes ride <code>/admin/api/actions</code> with CSRF + Idempotency-Key; each mutation
              is audited server-side and a lost activate CAS answers 409 STATE_CONFLICT (refresh,
              then retry).
            </span>
          </CardContent>
        </Card>
      ) : null}

        </TabsPanel>

        <TabsPanel value="recipe" keepMounted className="space-y-4">
          <ParityConnectorEditor
            key={tenantId ?? 'no-tenant'}
            savedAttempt={savedParityAttempt}
            onAttemptChange={(attempt) => { if (tenantId) rememberParityAttempt(tenantId, attempt); }}
            capabilities={caps}
            catalogSelection={typedCatalogOpenRequest}
            onRecipeCatalogChange={onRecipeCatalogChange}
            onEditorBusyChange={notifyEditorBusy}
          />
        </TabsPanel>

        <TabsPanel value="curl-import" keepMounted className="space-y-4">
          <CurlImportPreview
            onApply={(draft) => setImportDraft(draftFromCurlImport(draft))}
            applyLabel="Accept draft"
          />
          {importDraft === null ? null : (
            <ImportedDraftCard
              draft={importDraft}
              planOk={upsertPlan?.ok === true}
              missing={upsertPlan !== null && !upsertPlan.ok ? upsertPlan.missing : null}
              gating={screenGating}
              busy={busy}
              target={{ connectorId: draftConnectorId, adapter: draftAdapter, credentialRef: draftCredentialRef }}
              onTargetChange={(patch) => {
                if (patch.connectorId !== undefined) setDraftConnectorId(patch.connectorId);
                if (patch.adapter !== undefined) setDraftAdapter(patch.adapter);
                if (patch.credentialRef !== undefined) setDraftCredentialRef(patch.credentialRef);
              }}
              onNameChange={(name) => setImportDraft({ ...importDraft, name })}
              onSave={() => void saveDraft()}
              onTest={() => void testConnection(draftConnectorId.trim())}
              onDiscard={() => {
                setImportDraft(null);
                setActionNotice(null);
                setActionProblem(null);
              }}
            />
          )}
        </TabsPanel>
      </TabsRoot>

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={confirmTarget?.kind === 'retire' ? 'Retire connector revision' : 'Disable connector'}
        description={
          confirmTarget?.kind === 'retire'
            ? `Retire ${confirmTarget?.connectorId}@${confirmTarget?.revision}? Retiring is reference-safe: operations already pinned to this revision keep it, but new bindings must move on.`
            : `Disable ${confirmTarget?.connectorId}? Existing pins stay, no new traffic is routed to it until it is activated again.`
        }
        confirmText={confirmTarget?.kind === 'retire' ? 'Retire' : 'Disable'}
        variant={confirmTarget?.kind === 'retire' ? 'destructive' : 'primary'}
        isLoading={busy}
        onConfirm={() => void confirmConnectorAction()}
      />
    </section>
  );
}

/** Management-revision facts: labels/keys only, never a value or a secret. */
function ManageRevisionFacts({
  read,
  activeRevision,
  isPlatformAdmin: _isPlatformAdmin,
}: {
  read: Extract<ConnectorRevisionRead, { kind: 'management' }>;
  activeRevision: number | null;
  isPlatformAdmin: boolean;
}) {
  const config = summarizeConnectorConfig(read.revision.config);
  const sourceKeys =
    read.revision.credentialSource === undefined ? [] : Object.keys(read.revision.credentialSource).sort();
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm min-w-0">
      <dt className="text-[var(--text-sub)]">Adapter</dt>
      <dd className="min-w-0 break-words">
        <code>{read.revision.adapter}</code>
      </dd>
      <dt className="text-[var(--text-sub)]">Active head</dt>
      <dd>{activeRevision === null ? 'not visible in the loaded catalog' : `rev ${activeRevision}`}</dd>
      <dt className="text-[var(--text-sub)]">Config keys</dt>
      <dd className="min-w-0 break-words">{config.keys.length === 0 ? 'none reported' : config.keys.join(', ')}</dd>
      <dt className="text-[var(--text-sub)]">Header names</dt>
      <dd className="min-w-0 break-words">
        {config.headerNames.length === 0 ? 'none reported' : config.headerNames.join(', ')}
        {config.redactedHeaderNames.length === 0
          ? null
          : ` · masked: ${config.redactedHeaderNames.join(', ')}`}
      </dd>
      <dt className="text-[var(--text-sub)]">Credential slot</dt>
      <dd className="min-w-0 break-words">
        <code>{read.revision.credentialRef ?? 'not reported'}</code>
      </dd>
      <dt className="text-[var(--text-sub)]">Credential source keys</dt>
      <dd className="min-w-0 break-words">
        {sourceKeys.length === 0 ? 'not reported' : sourceKeys.join(', ')}
      </dd>
      <dt className="text-[var(--text-sub)]">Tenant</dt>
      <dd className="min-w-0 break-words text-xs">
        {read.revision.tenantId ? (
          <code>{read.revision.tenantId}</code>
        ) : (
          '—'
        )}
      </dd>
      <dt className="text-[var(--text-sub)]">Account</dt>
      <dd className="min-w-0 break-words text-xs"><code>{read.revision.accountId ?? '—'}</code></dd>
    </dl>
  );
}

/**
 * Accepted cURL draft (P730-UI-INTEGRATE phase 1, wired by CONNECTOR-WIRE-B).
 *
 * The draft itself never leaves the page: it is mapped to a `connector.upsert`
 * (mode create) payload by `buildConnectorUpsertParams`, which drops every
 * secret VALUE and every file path — those are structural only, and the
 * write-only value path is `connectors.rotate_credential`. Save is enabled
 * only when the deployment advertises `management` and every required
 * coordinate is present; otherwise the missing field is named, not guessed.
 */
function ImportedDraftCard({
  draft,
  planOk,
  missing,
  gating,
  busy,
  target,
  onTargetChange,
  onNameChange,
  onSave,
  onTest,
  onDiscard,
}: {
  draft: ConnectorImportDraft;
  planOk: boolean;
  missing: 'connectorId' | 'adapter' | 'credentialRef' | null;
  gating: ReturnType<typeof connectorActionGating>;
  busy: boolean;
  target: { connectorId: string; adapter: string; credentialRef: string };
  onTargetChange: (patch: Partial<{ connectorId: string; adapter: string; credentialRef: string }>) => void;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onTest: () => void;
  onDiscard: () => void;
}) {
  const saveDisabled = !gating.upsert || !planOk || busy;
  const saveTitle = !gating.upsert
    ? gating.reason
    : !planOk
      ? `Missing ${missing ?? 'draft coordinate'} — the platform would answer 422.`
      : 'connector.upsert (mode create) — the secret value is NOT part of this payload.';

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Imported cURL draft</CardTitle>
          <Badge variant={gating.upsert ? 'info' : 'warning'} dot>
            {gating.upsert ? 'save wired' : 'in-memory: requires backend'}
          </Badge>
        </div>
        <CardDescription>
          {gating.upsert
            ? 'Save writes the non-secret configuration through connector.upsert; the secret stays in memory and is never sent by this payload.'
            : 'This deployment does not advertise connector management, so the draft stays local and nothing can be written from here — nothing is faked.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <div className="w-full max-w-[12rem]">
            <FormField id="import-draft-name" label="Draft name" description="Local label only; never sent anywhere.">
              <Input
                id="import-draft-name"
                value={draft.name}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="vendor extract"
              />
            </FormField>
          </div>
          <div className="w-full max-w-[12rem]">
            <FormField
              id="import-draft-connector-id"
              label="Connector ID"
              description="Slug the platform registers (required)."
            >
              <Input
                id="import-draft-connector-id"
                value={target.connectorId}
                onChange={(event) => onTargetChange({ connectorId: event.target.value })}
                placeholder="vendor-extract"
                disabled={!gating.upsert || busy}
              />
            </FormField>
          </div>
          <div className="w-full max-w-[12rem]">
            <FormField id="import-draft-adapter" label="Adapter" description="Adapter key (required).">
              <Input
                id="import-draft-adapter"
                value={target.adapter}
                onChange={(event) => onTargetChange({ adapter: event.target.value })}
                placeholder="http-json"
                disabled={!gating.upsert || busy}
              />
            </FormField>
          </div>
          <div className="w-full max-w-[12rem]">
            <FormField
              id="import-draft-credential-ref"
              label="Credential slot"
              description="Label only (required); the value is written by rotate."
            >
              <Input
                id="import-draft-credential-ref"
                value={target.credentialRef}
                onChange={(event) => onTargetChange({ credentialRef: event.target.value })}
                placeholder="vault://du/vendor-extract"
                disabled={!gating.upsert || busy}
              />
            </FormField>
          </div>
        </div>

        <CurlImportSummaryView summary={summarizeCurlImport(draft)} draft={draft} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={saveDisabled}
            title={saveTitle}
            isLoading={busy}
            onClick={onSave}
          >
            Save connection
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!gating.test || target.connectorId.trim().length === 0 || busy}
            title={
              gating.test
                ? 'Masked probe over the management surface (connector.test).'
                : gating.reason || 'The platform did not advertise the connector test capability (test:false).'
            }
            onClick={onTest}
          >
            Test connection
          </Button>
          <Button size="sm" variant="secondary" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
          {missing === null ? null : (
            <span className="text-xs text-[var(--text-sub)] basis-full">
              Save stays disabled until <code>{missing}</code> is filled in — the payload is not sent
              incomplete.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
