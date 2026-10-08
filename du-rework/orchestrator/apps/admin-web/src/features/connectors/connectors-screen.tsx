import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, Modal } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AlertBanner, DeniedState, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { TenantSelect } from '@/components/ui/tenant-select';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type AdminApiResult,
  type ConnectorCapabilities,
  type ConnectorListPage,
  type ConnectorRevisionRead,
  type PostActionResult,
} from '@/lib/api';
import { type Loadable, paneStateFrom } from '@/features/overview/state';
import { CurlImportPreview, CurlImportSummaryView } from './curl-import-preview';
import { summarizeCurlImport } from './curl-import';
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
  const [capabilities, setCapabilities] = useState<Loadable<ConnectorCapabilities>>({ kind: 'loading' });
  const [list, setList] = useState<ListState>({ kind: 'idle' });
  const [connectorId, setConnectorId] = useState('');
  const [revision, setRevision] = useState('latest');
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState<ConnectorImportDraft | null>(null);
  const [draftConnectorId, setDraftConnectorId] = useState('');
  const [draftAdapter, setDraftAdapter] = useState('');
  const [draftCredentialRef, setDraftCredentialRef] = useState('');
  const [actionProblem, setActionProblem] = useState<AdminApiProblem | null>(null);
  const [sessionFailed, setSessionFailed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{
    kind: 'disable' | 'retire';
    connectorId: string;
    revision: number;
  } | null>(null);

  const refreshList = useCallback(async (): Promise<void> => {
    setList({ kind: 'loading' });
    const result = await client.listConnectors();
    if (!result.ok) {
      setList({ kind: 'failed', problem: result.problem });
      return;
    }
    const page = parseConnectorList(result.data);
    setList(page === null ? { kind: 'failed', problem: UNREADABLE_LIST } : { kind: 'ready', data: page });
  }, [client]);

  const load = useCallback(async (): Promise<void> => {
    setCapabilities({ kind: 'loading' });
    setList({ kind: 'idle' });
    setSessionFailed(false);
    // The client learns the server-issued CSRF proof from THIS read. Without it
    // the BFF rejects every mutation 403 CSRF_REJECTED, so the session read must
    // precede any write path (same bootstrap as the sibling admin screens).
    const sessionResult = await client.getSession();
    if (!sessionResult.ok) {
      setSessionFailed(true);
      setCapabilities({ kind: 'failed', problem: sessionResult.problem });
      return;
    }
    setIsAdmin(sessionResult.data.role === 'admin');
    const capsResult = await client.getConnectorCapabilities();
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
  }, [client, refreshList]);

  useEffect(() => {
    void load();
  }, [load]);

  const caps = capabilities.kind === 'ready' ? capabilities.data : null;
  const gating = connectorActionGating(caps);

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
  ): Promise<void> {
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
    );
  }

  async function testConnection(id: string): Promise<void> {
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
  const connectorSuggestions = connectorIdSuggestions(caps, listRows);

  return (
    <section aria-labelledby="connectors-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="connectors-title" className="text-lg font-semibold">
          Connectors
        </h1>
        <Badge variant={gating.upsert ? 'info' : 'neutral'}>{gating.upsert ? 'management' : 'read-only'}</Badge>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
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
          <strong>{String(caps.credentialWorkflow)}</strong> · test: <strong>{String(caps.test)}</strong>
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
              503 there), so only the lookup by id below is available and it returns the honest
              endpoint-only projection.
            </>
          )}
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

      {listState !== null ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Connectors</CardTitle>
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
                <TableContainer>
                  <Table aria-label="Connectors">
                    <TableHeader>
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
                      {listRows.map((row) => {
                        const head = connectorActiveRevision(listRows, row.connectorId);
                        const config = summarizeConnectorConfig(row.config);
                        return (
                          <TableRow key={`${row.connectorId}@${row.revision}`}>
                            <TableCell className="font-medium">
                              <code>{row.connectorId}</code>
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
                            <TableCell className="text-xs text-[var(--text-sub)]">
                              {config.keys.length === 0 ? '—' : config.keys.join(', ')}
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => {
                                  setConnectorId(row.connectorId);
                                  setRevision(String(row.revision));
                                  void fetchRevision(row.connectorId, String(row.revision));
                                }}
                              >
                                Load
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Revision lookup</CardTitle>
          <CardDescription>
            GET /admin/api/connectors/:id/revisions/:rev — the real ledger when management is
            composed, otherwise the platform's honest degraded projection. Never a synthesised
            revision.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-xs">
            <FormField id="connector-id" label="Connector ID">
              <Input
                id="connector-id"
                list="connector-id-suggestions"
                value={connectorId}
                onChange={(event) => setConnectorId(event.target.value)}
                placeholder="openai"
              />
              <datalist id="connector-id-suggestions">
                {connectorSuggestions.map((id) => <option key={id} value={id} />)}
              </datalist>
            </FormField>
          </div>
          <div className="w-full max-w-[10rem]">
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
                {[...new Set(listRows.filter((row) => row.connectorId === connectorId.trim()).map((row) => row.revision))].map((rev) => <option key={rev} value={String(rev)} />)}
              </datalist>
            </FormField>
          </div>
          <Button
            onClick={() => void fetchRevision(connectorId.trim(), revision.trim() || 'latest')}
            disabled={connectorId.trim().length === 0}
          >
            Load revision
          </Button>
        </CardContent>
      </Card>

      {importDraft === null ? null : (
        <ImportedDraftCard
          draft={importDraft}
          planOk={upsertPlan?.ok === true}
          missing={upsertPlan !== null && !upsertPlan.ok ? upsertPlan.missing : null}
          gating={gating}
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
                disabled={!gating.test || busy}
                title={
                  gating.test
                    ? 'Masked probe over the management surface.'
                    : gating.reason || 'The platform did not advertise the connector test capability (test:false).'
                }
                onClick={() => void testConnection(readConnectorId)}
              >
                Test connection
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!gating.activate || activeRevision === null || busy}
                title={
                  !gating.activate
                    ? gating.reason
                    : activeRevision === null
                      ? 'The ACTIVE head is not visible on this page; refresh the connector list before activating (CAS needs it).'
                      : `CAS on the current ACTIVE head (rev ${activeRevision}).`
                }
                onClick={() => void activateRevision(readConnectorId, readRevisionNumber)}
              >
                Activate
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!gating.disable || busy}
                title={gating.disable ? 'Disable this connector (reversible).' : gating.reason}
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
                disabled={!gating.retire || busy}
                title={
                  gating.retire
                    ? 'Retire this revision (reference-safe; pinned operations keep it).'
                    : gating.reason
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
              <Button
                size="sm"
                variant="outline"
                disabled
                title={
                  gating.rotate
                    ? 'Rotate is not wired in this UI slice — the write-only value path (connectors.rotate_credential) is a separate packet (Δ5).'
                    : gating.reason || 'Credential workflow is not composed on this deployment.'
                }
              >
                Rotate secret
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

      <Modal
        open={importOpen}
        onOpenChange={setImportOpen}
        title="Import connection from cURL"
        description="Parses the pasted command as text: nothing is executed and nothing is sent."
        maxWidth="max-w-2xl"
      >
        <CurlImportPreview
          onApply={(draft) => {
            setImportDraft(draftFromCurlImport(draft));
            setImportOpen(false);
          }}
          applyLabel="Accept draft"
        />
      </Modal>

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
  isPlatformAdmin,
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
      <dd>{activeRevision === null ? 'not visible on this page' : `rev ${activeRevision}`}</dd>
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
        {read.revision.tenantId === undefined
          ? '—'
          : isPlatformAdmin
            ? (
                <TenantSelect
                  id="connector-revision-tenant"
                  label={null}
                  ariaLabel="Revision tenant"
                  value={read.revision.tenantId}
                  onValueChange={() => undefined}
                  disabled
                />
              )
            : 'Tenant name unavailable'}
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
