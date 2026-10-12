import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CostAdjustmentCommand,
  CostAdjustmentEvidenceItem,
  CostAdjustmentHistoryPage,
} from '@du/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertBanner } from '@/components/ui/state-panel';
import { createAdminApiClient, type AdminWebSession } from '@/lib/api';
import { buildCostAdjustmentHistoryCsv, type AdminUsageEventView } from './state';
import { adjustmentHistoryMatchesScope, buildCostAdjustmentReview, canWriteCostAdjustments, classifyCostAdjustmentFailure } from './cost-adjustment-state';

type AdjustmentKind = 'correction' | 'refund';
type PendingWrite = { command: CostAdjustmentCommand; idempotencyKey: string };

function formatMicrousd(value: number | null): string {
  return value === null ? 'Unavailable' : `${(value / 1_000_000).toFixed(6)} USD`;
}

function formatUtc(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function blockerLabel(value: string): string {
  const labels: Record<string, string> = {
    ROOT_NOT_FOUND: 'Original event is unavailable.',
    TENANT_MISMATCH: 'Original event does not belong to the selected tenant.',
    UNPRICED_OR_UNTRUSTED: 'The original charge does not have trusted computed pricing.',
    SETTLEMENT_INCOMPLETE: 'Usage settlement is incomplete.',
    RESERVATION_UNKNOWN: 'The original reservation state is unknown.',
    ATTRIBUTION_INCOMPLETE: 'Original tenant, key, Profile, Connector or operation attribution is incomplete.',
    PRICE_PROVENANCE_INCOMPLETE: 'The original immutable price provenance is incomplete.',
    EVIDENCE_UNAVAILABLE: 'A usable same-tenant evidence artifact is unavailable.',
    EVIDENCE_NOT_READY: 'Evidence must be READY before an adjustment can be recorded.',
    EVIDENCE_PIN_INCOMPLETE: 'Evidence storage pins are incomplete.',
  };
  return labels[value] ?? `Adjustment unavailable (${value}).`;
}

function deduplicateEvidence(items: CostAdjustmentEvidenceItem[]): CostAdjustmentEvidenceItem[] {
  const byId = new Map<string, CostAdjustmentEvidenceItem>();
  for (const item of items) byId.set(item.artifactId, item);
  return [...byId.values()];
}

function deduplicateHistory(page: CostAdjustmentHistoryPage, current: CostAdjustmentHistoryPage | null, append: boolean): CostAdjustmentHistoryPage {
  if (!append || current === null) return page;
  const byId = new Map(current.items.map((item) => [item.adjustmentEventId, item]));
  for (const item of page.items) byId.set(item.adjustmentEventId, item);
  return { ...page, items: [...byId.values()] };
}

function eventAccountingMatchesHistory(event: AdminUsageEventView, page: CostAdjustmentHistoryPage): boolean {
  const accounting = event.financialAccounting;
  return accounting !== null
    && accounting.rootEventId === page.rootEventId
    && accounting.initialChargeMicrousd === page.initialChargeMicrousd
    && accounting.grossChargeMicrousd === page.grossChargeMicrousd
    && accounting.refundedMicrousd === page.refundedMicrousd
    && accounting.netChargeMicrousd === page.netChargeMicrousd
    && accounting.adjustmentRevision === page.adjustmentRevision
    && accounting.headAdjustmentEventId === page.headAdjustmentEventId;
}

export function CostAdjustmentPanel({
  event,
  tenantId,
  session,
  onChanged,
}: {
  event: AdminUsageEventView;
  tenantId: string;
  session: AdminWebSession;
  onChanged: () => void;
}) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [history, setHistory] = useState<CostAdjustmentHistoryPage | null>(null);
  const [historyExportPage, setHistoryExportPage] = useState<CostAdjustmentHistoryPage | null>(null);
  const [historyExportPageNumber, setHistoryExportPageNumber] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [ledgerSnapshotOutdated, setLedgerSnapshotOutdated] = useState(false);
  const [evidence, setEvidence] = useState<CostAdjustmentEvidenceItem[]>([]);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceSearch, setEvidenceSearch] = useState('');
  const [selectedEvidence, setSelectedEvidence] = useState<CostAdjustmentEvidenceItem | null>(null);
  const [kind, setKind] = useState<AdjustmentKind>('correction');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<CostAdjustmentCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const historyGeneration = useRef(0);
  const evidenceGeneration = useRef(0);
  const evidenceTenantRef = useRef(tenantId);
  const mayWrite = canWriteCostAdjustments(session);
  const rootEventId = event.financialAccounting?.rootEventId ?? event.eventId;

  const loadHistory = async (cursor: string | null = null, append = false): Promise<void> => {
    const generation = ++historyGeneration.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await client.getCostAdjustmentHistory({ tenantId, rootEventId, limit: 50, ...(cursor ? { cursor } : {}) });
      if (generation !== historyGeneration.current) return;
      if (!result.ok) {
        setHistoryError(`${result.problem.title ?? 'Adjustment history unavailable'}${result.status === 403 ? ' This account cannot read financial details for the selected tenant.' : ''}`);
        if (!append) { setHistory(null); setHistoryExportPage(null); }
        return;
      }
      if (!adjustmentHistoryMatchesScope(result.data, tenantId, rootEventId)) {
        setHistoryError('The adjustment response did not match the selected tenant and original event. It was not used.');
        if (!append) { setHistory(null); setHistoryExportPage(null); }
        return;
      }
      setHistory((current) => deduplicateHistory(result.data, current, append));
      setLedgerSnapshotOutdated(!eventAccountingMatchesHistory(event, result.data));
      setHistoryExportPage(result.data);
      setHistoryExportPageNumber((current) => append ? current + 1 : 1);
    } catch {
      if (generation === historyGeneration.current) {
        setHistoryError('Adjustment history could not be reached.');
        if (!append) { setHistory(null); setHistoryExportPage(null); }
      }
    } finally {
      if (generation === historyGeneration.current) setHistoryLoading(false);
    }
  };

  const loadEvidence = async (query: string, cursor: string | null = null, append = false, generation = evidenceGeneration.current): Promise<void> => {
    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const result = await client.listCostAdjustmentEvidence({ tenantId, q: query || undefined, limit: 50, ...(cursor ? { cursor } : {}) });
      if (generation !== evidenceGeneration.current) return;
      if (!result.ok) {
        setEvidenceError(`${result.problem.title ?? 'Evidence catalog unavailable'} The selector only accepts existing same-tenant READY artifacts.`);
        if (!append) { setEvidence([]); setEvidenceCursor(null); }
        return;
      }
      if (result.data.tenantId !== tenantId) {
        setEvidenceError('The evidence catalog returned another tenant; those rows were discarded.');
        if (!append) { setEvidence([]); setEvidenceCursor(null); }
        return;
      }
      setEvidence((current) => deduplicateEvidence(append ? [...current, ...result.data.items] : result.data.items));
      setEvidenceCursor(result.data.nextCursor);
    } catch {
      if (generation === evidenceGeneration.current) setEvidenceError('Evidence catalog could not be reached.');
    } finally {
      if (generation === evidenceGeneration.current) setEvidenceLoading(false);
    }
  };

  useEffect(() => {
    historyGeneration.current++;
    setHistory(null);
    setLedgerSnapshotOutdated(false);
    setHistoryExportPage(null);
    setHistoryExportPageNumber(1);
    setHistoryError(null);
    setError(null);
    setNotice(null);
    setReview(null);
    setPending(null);
    setAmountText('');
    setReason('');
    void loadHistory();
    return () => {
      historyGeneration.current++;
    };
    // A different root event always starts from a fresh server snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tenantId, event.eventId, rootEventId, event.financialAccounting?.adjustmentRevision]);

  useEffect(() => {
    if (evidenceTenantRef.current !== tenantId) {
      evidenceTenantRef.current = tenantId;
      setSelectedEvidence(null);
    }
    const generation = ++evidenceGeneration.current;
    setEvidence([]);
    setEvidenceCursor(null);
    setSelectedEvidence(null);
    setReview(null);
    setPending(null);
    const timer = window.setTimeout(() => { void loadEvidence(evidenceSearch.trim(), null, false, generation); }, evidenceSearch.trim() ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      if (evidenceGeneration.current === generation) evidenceGeneration.current++;
    };
    // Evidence search is server-side and resets its cursor-bound page on every query change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tenantId, event.eventId, evidenceSearch]);

  const selectEvidence = (artifactId: string): void => {
    setSelectedEvidence(evidence.find((item) => item.artifactId === artifactId) ?? null);
    setReview(null);
    setPending(null);
  };

  const selectedEvidenceIsCurrent = Boolean(selectedEvidence && selectedEvidence.artifactId === evidence.find((item) => item.artifactId === selectedEvidence.artifactId)?.artifactId);
  const unknownPending = Boolean(pending && error?.includes('acknowledgement is unknown'));
  const reviewCandidate = history && selectedEvidenceIsCurrent
    ? buildCostAdjustmentReview({
      tenantId,
      rootEventId,
      expectedAdjustmentRevision: history.adjustmentRevision,
      kind,
      amountText,
      reason,
      evidenceArtifactId: selectedEvidence!.artifactId,
    })
    : null;
  const canReview = Boolean(mayWrite && history?.eligible && selectedEvidenceIsCurrent && reviewCandidate && !busy);

  const prepareReview = (): void => {
    if (!history?.eligible || !selectedEvidenceIsCurrent || !reviewCandidate || !canReview) return;
    setReview(reviewCandidate);
    setPending(null);
    setError(null);
    setNotice(null);
  };

  const submit = async (exactPending?: PendingWrite): Promise<void> => {
    const write = exactPending ?? (review ? { command: review, idempotencyKey: crypto.randomUUID() } : null);
    if (!write || !mayWrite || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPending(write);
    try {
      const result = await client.createCostAdjustment(write.command, write.idempotencyKey);
      if (!result.ok) {
        const failure = classifyCostAdjustmentFailure(result.status, result.problem.code);
        if (failure === 'maintenance-hold') {
          setError('Financial adjustments are held while the backup or recovery safety gate is active. Your reviewed draft is preserved; retry after the maintenance hold clears.');
          setPending(null);
        } else if (failure === 'head-conflict') {
          setError('The adjustment head changed before confirmation. Your entered adjustment details are preserved; review them against the reloaded current head before confirming again.');
          setReview(null);
          setPending(null);
          void loadHistory();
        } else if (failure === 'idempotency-conflict') {
          setError('This request key is already bound to a different adjustment. Your entered draft is preserved; reload history and review it again before confirming with a fresh key.');
          setReview(null);
          setPending(null);
          void loadHistory();
        } else if (failure === 'unknown-acknowledgement') {
          setError('The server acknowledgement is unknown. Recheck this exact command with the same idempotency key before starting another adjustment.');
        } else if (result.status === 409) {
          setError('The request conflicted, but the server did not identify an adjustment-head change. Your draft is preserved; reload history and review it before retrying.');
          setPending(null);
        } else {
          setError(`${result.problem.title ?? 'Adjustment was not recorded'}${result.status === 403 ? ' Current platform Admin authorization is required.' : ''}`);
          setPending(null);
        }
        return;
      }
      if (result.data.rootEventId !== rootEventId || result.data.adjustmentRevision < write.command.expectedAdjustmentRevision) {
        setError('The adjustment result did not match the reviewed root or revision. Reload the authoritative history before continuing.');
        setPending(null);
        void loadHistory();
        return;
      }
      setPending(null);
      setReview(null);
      setSelectedEvidence(null);
      setAmountText('');
      setReason('');
      setNotice(result.data.outcome === 'NOOP'
        ? `No adjustment event was recorded. The server reports net ${formatMicrousd(result.data.netChargeMicrousd)} as of ${formatUtc(result.data.recordedAt)}.`
        : `${write.command.kind === 'correction' ? 'Correction' : 'Refund'} recorded at adjustment revision ${result.data.adjustmentRevision}. Server-calculated gross ${formatMicrousd(result.data.grossChargeMicrousd)}, refunded ${formatMicrousd(result.data.refundedMicrousd)}, and net ${formatMicrousd(result.data.netChargeMicrousd)}.`);
      await loadHistory();
      onChanged();
    } catch {
      setError('The server acknowledgement is unknown. Recheck this exact command with the same idempotency key before starting another adjustment.');
    } finally {
      setBusy(false);
    }
  };

  const currentGross = history?.grossChargeMicrousd ?? null;
  const evidenceOptions = deduplicateEvidence([
    ...evidence,
    ...(selectedEvidence && selectedEvidence.artifactId === evidence.find((item) => item.artifactId === selectedEvidence.artifactId)?.artifactId ? [selectedEvidence] : []),
  ]);

  const exportHistoryPage = (): void => {
    if (!historyExportPage || historyExportPage.items.length === 0) return;
    const blob = new Blob([buildCostAdjustmentHistoryCsv(historyExportPage)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeTenant = tenantId.replace(/[^A-Za-z0-9-]/g, '_');
    const safeRoot = rootEventId.replace(/[^A-Za-z0-9-]/g, '_');
    link.download = `cost-adjustments-${safeTenant}-${safeRoot}-page-${historyExportPageNumber}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <section className='space-y-4 rounded border bg-[var(--bg-subtle)] p-4' aria-label='Financial adjustment details'>
    <div className='flex flex-wrap items-start justify-between gap-3'>
      <div><h3 className='font-semibold'>Cost adjustment history</h3><p className='text-xs text-[var(--text-sub)]'>Adjustments attach directly to original event {rootEventId}. The server projects current gross, refunds and net; original cost, units and event time remain unchanged. Provider-reported amounts remain unverified diagnostics.</p></div>
      <div className='flex flex-wrap gap-2'>
        <Button type='button' size='sm' variant='outline' disabled={!historyExportPage || historyExportPage.items.length === 0} onClick={exportHistoryPage}>Export current history page CSV ({historyExportPage?.items.length ?? 0})</Button>
        <Button type='button' size='sm' variant='outline' disabled={historyLoading} onClick={() => void loadHistory()}>Reload history</Button>
      </div>
    </div>
    {historyError && <AlertBanner variant='error' title='Adjustment history unavailable'>{historyError}</AlertBanner>}
    {history && ledgerSnapshotOutdated && <AlertBanner variant='warning' title='Usage ledger snapshot is behind this history'>The history page is the current server accounting view. The Usage row came from a different or older accounting snapshot; refresh the Usage ledger before exporting its page.</AlertBanner>}
    {error && <AlertBanner variant='error' title='Adjustment status'>{error}</AlertBanner>}
    {notice && <AlertBanner variant='info' title='Adjustment recorded'>{notice}</AlertBanner>}
    {historyLoading && !history && <p role='status' className='text-sm'>Loading eligibility, current adjustment head and server-projected history…</p>}
    {history && <>
      {history.blockers.includes('EVIDENCE_PIN_INCOMPLETE') && <AlertBanner variant='warning' title='Historical evidence proof is incomplete'>One or more retained adjustments lack complete exact object proof. Their history remains visible and exportable, but the server blocks another adjustment until the chain has complete evidence proof. No proof is inferred from legacy metadata.</AlertBanner>}
      {history.originalAttribution && <div className='rounded border bg-[var(--bg-card)] p-3'>
        <h4 className='font-medium'>Original immutable attribution</h4>
        <dl className='mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4'>
          <div><dt className='font-medium'>Original operation</dt><dd className='break-all'>{history.originalAttribution.operationId}</dd></div>
          <div><dt className='font-medium'>Task / invocation / attempt</dt><dd className='break-all'>{history.originalAttribution.taskId} · {history.originalAttribution.invocationId} · {history.originalAttribution.attempt}</dd></div>
          <div><dt className='font-medium'>Business / action</dt><dd className='break-all'>{history.originalAttribution.businessId} v{history.originalAttribution.businessVersion} · {history.originalAttribution.action}</dd></div>
          <div><dt className='font-medium'>Connector / price</dt><dd className='break-all'>{history.originalAttribution.connectorId} r{history.originalAttribution.connectorRevision} · price r{history.originalAttribution.priceRevision} · {history.originalAttribution.priceSnapshotDigest}</dd></div>
          <div><dt className='font-medium'>Frozen provenance</dt><dd className='break-all'>{history.originalAttribution.provenanceDigest}</dd></div>
          <div><dt className='font-medium'>Original event time</dt><dd>{formatUtc(history.originalAttribution.occurredAt)} · {history.originalAttribution.costStatus} computed price</dd></div>
          <div><dt className='font-medium'>Original measured units</dt><dd>Input {history.originalAttribution.inputTokens.toLocaleString()} · cached {history.originalAttribution.cachedInputTokens.toLocaleString()} · output {history.originalAttribution.outputTokens.toLocaleString()} · pages {history.originalAttribution.pages.toLocaleString()} · {history.originalAttribution.durationMs.toLocaleString()} ms</dd></div>
          <div><dt className='font-medium'>Key / Profile</dt><dd className='break-all'>{history.originalAttribution.apiKeyId ?? 'No key attribution'} · {history.originalAttribution.profileId ? `${history.originalAttribution.profileId} r${history.originalAttribution.profileRevision ?? '?'}` : 'No Profile attribution'}</dd></div>
          <div className='sm:col-span-2'><dt className='font-medium'>Pinned quota windows</dt><dd className='break-all'>{history.originalAttribution.quotaWindowPins.length === 0 ? 'No quota window pins' : history.originalAttribution.quotaWindowPins.map((pin) => `${pin.budgetId} r${pin.budgetRevision} ${pin.period} ${formatUtc(pin.windowStart)}–${formatUtc(pin.windowEnd)}`).join(' · ')}</dd></div>
        </dl>
      </div>}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        <div className='rounded border bg-[var(--bg-card)] p-3'><p className='text-xs text-[var(--text-sub)]'>Initial computed charge</p><p className='font-semibold'>{formatMicrousd(history.initialChargeMicrousd)}</p></div>
        <div className='rounded border bg-[var(--bg-card)] p-3'><p className='text-xs text-[var(--text-sub)]'>Current gross</p><p className='font-semibold'>{formatMicrousd(history.grossChargeMicrousd)}</p></div>
        <div className='rounded border bg-[var(--bg-card)] p-3'><p className='text-xs text-[var(--text-sub)]'>Refunded</p><p className='font-semibold'>{formatMicrousd(history.refundedMicrousd)}</p></div>
        <div className='rounded border bg-[var(--bg-card)] p-3'><p className='text-xs text-[var(--text-sub)]'>Current net</p><p className='font-semibold'>{formatMicrousd(history.netChargeMicrousd)}</p></div>
      </div>
      <div className='flex flex-wrap items-center gap-2'><Badge variant={history.eligible ? 'success' : 'warning'}>{history.eligible ? 'Eligible for adjustment' : 'Read only · adjustment blocked'}</Badge><span className='text-xs'>Adjustment head r{history.adjustmentRevision} · original event time is retained; each administrative decision has a separate recorded time.</span></div>
      {!history.eligible && <ul className='list-disc space-y-1 pl-5 text-sm' aria-label='Adjustment eligibility blockers'>{history.blockers.map((blocker) => <li key={blocker}>{blockerLabel(blocker)}</li>)}</ul>}
      {history.eligible && <p className='text-xs'>The server rechecks the current adjustment revision and evidence at confirmation. A correction replaces gross charge; a refund adds a positive credit delta. The server computes net. Original usage units, trust classification, provenance and accounting time remain unchanged.</p>}
      {history.items.length > 0 ? <div className='space-y-2'>
        <h4 className='font-medium'>Recorded adjustments</h4>
        {history.items.map((item) => <article key={item.adjustmentEventId} className='space-y-2 rounded border bg-[var(--bg-card)] p-3'>
          <div className='flex flex-wrap items-center gap-2'><Badge variant='info'>{item.kind} · revision {item.adjustmentRevision}</Badge><Badge variant={item.evidenceObjectProofComplete ? 'success' : 'warning'}>{item.evidenceObjectProofComplete ? 'Exact object proof complete' : 'Historical proof incomplete'}</Badge><span className='break-all text-xs'>Event {item.adjustmentEventId}</span><span className='text-xs'>{item.authority}</span></div>
          <p className='text-sm'>{item.kind === 'correction' ? `Replacement gross charge ${formatMicrousd(item.targetChargeMicrousd)}` : `Refund credit ${formatMicrousd(item.refundMicrousd)}`} · gross {formatMicrousd(item.grossChargeMicrousd)} · refunded {formatMicrousd(item.refundedMicrousd)} · net {formatMicrousd(item.netChargeMicrousd)}</p>
          <p className='text-xs'>Effective for original event time {formatUtc(item.effectiveAt)} · recorded {formatUtc(item.recordedAt)} · evidence SHA-256 {item.evidenceSha256} · object version {item.evidenceObjectVersionId} · sidecar version {item.evidenceSidecarVersionId}</p>
          {!item.evidenceObjectProofComplete && <p role='status' className='text-xs text-[var(--badge-warning-text)]'>Exact encrypted object size or digest proof is missing from this historical row. The UI preserves the recorded metadata and does not upgrade its proof status.</p>}
          <p className='break-words text-xs'>Approved by {item.actorKind} · principal {item.actorPrincipalId} · reason: {item.reason}</p>
        </article>)}
        {history.nextCursor && <Button type='button' variant='outline' disabled={historyLoading} onClick={() => void loadHistory(history.nextCursor, true)}>Load more adjustment history</Button>}
      </div> : <p className='text-sm'>No correction or refund has been recorded for this original event.</p>}
      {!mayWrite && <p role='status' className='rounded border p-3 text-sm'>Financial adjustment history is read only. A current platform Admin must review and record changes.</p>}
      {mayWrite && history.eligible && <fieldset disabled={busy} className='space-y-3 rounded border bg-[var(--bg-card)] p-3'>
        <legend className='px-1 font-semibold'>Prepare an administrative adjustment</legend>
        <p className='text-xs'>Financial correction authority is an administrative accounting action. It does not verify a provider-reported amount or change the original usage provenance.</p>
        <div className='grid grid-cols-1 gap-3 md:grid-cols-3'>
          <label className='block text-sm'>Adjustment<select disabled={unknownPending} className='mt-1 block w-full rounded border p-2' value={kind} onChange={(event) => { setKind(event.target.value as AdjustmentKind); setReview(null); setPending(null); }}><option value='correction'>Correction · replace gross total</option><option value='refund'>Refund · credit delta</option></select></label>
          <label className='block text-sm md:col-span-2'>{kind === 'correction' ? 'Replacement gross charge' : 'Refund credit delta'} (integer micro-USD)<input disabled={unknownPending} className='mt-1 block w-full rounded border p-2' type='number' inputMode='numeric' min={kind === 'refund' ? 1 : 0} step={1} value={amountText} onChange={(event) => { setAmountText(event.target.value); setReview(null); setPending(null); }} /><span className='text-xs'>Current gross is {formatMicrousd(currentGross)}; current net is {formatMicrousd(history.netChargeMicrousd)}. Enter an exact integer amount. The server validates refund limits and computes resulting net.</span></label>
        </div>
        <label className='block text-sm'>Reason<input disabled={unknownPending} className='mt-1 block w-full rounded border p-2' maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); setReview(null); setPending(null); }} placeholder='Explain the accounting correction or refund' /></label>
        <div className='space-y-2 rounded border p-3'>
          <label className='block text-sm'>Search existing READY evidence for this tenant<input disabled={unknownPending} className='mt-1 block w-full rounded border p-2' type='search' maxLength={128} value={evidenceSearch} onChange={(event) => { setEvidenceSearch(event.target.value); setSelectedEvidence(null); setReview(null); setPending(null); }} placeholder='Search file name or artifact reference' /></label>
          {evidenceError && <p role='alert' className='text-sm text-red-700'>{evidenceError}</p>}
          <label className='block text-sm'>Evidence artifact<select disabled={unknownPending} className='mt-1 block w-full rounded border p-2' value={selectedEvidence?.artifactId ?? ''} onChange={(event) => selectEvidence(event.target.value)}><option value=''>{evidenceLoading ? 'Searching verified evidence metadata…' : 'Choose an existing READY artifact'}</option>{evidenceOptions.map((item) => <option key={item.artifactId} value={item.artifactId}>{item.fileName ?? 'Untitled artifact'} · {item.sizeBytes.toLocaleString()} bytes · {formatUtc(item.createdAt)}</option>)}</select><span className='text-xs'>Only server-confirmed READY, same-tenant artifacts with complete immutable storage pins appear. The service verifies the current pins again when you confirm.</span></label>
          {selectedEvidence && <p className='break-all text-xs'>Selected evidence: {selectedEvidence.fileName ?? 'Untitled'} · SHA-256 {selectedEvidence.sha256} · artifact ID {selectedEvidence.artifactId}</p>}
          <div className='flex flex-wrap items-center justify-between gap-2 text-xs'><span>{evidenceLoading ? 'Loading bounded evidence metadata…' : `${evidence.length} evidence item(s) loaded for this search.`}</span>{evidenceCursor && <Button type='button' size='sm' variant='outline' disabled={evidenceLoading || unknownPending} onClick={() => void loadEvidence(evidenceSearch.trim(), evidenceCursor, true, evidenceGeneration.current)}>Load more evidence</Button>}</div>
        </div>
        <div className='flex flex-wrap gap-2'><Button type='button' disabled={!canReview || Boolean(pending)} onClick={prepareReview}>Review adjustment</Button>{review && <Button type='button' variant='outline' disabled={busy || unknownPending} onClick={() => { setReview(null); setPending(null); }}>Edit draft</Button>}</div>
        {review && <div className='space-y-3 rounded border border-[var(--border-dark)] p-3' aria-label='Adjustment review'>
          <h4 className='font-semibold'>Review before confirmation</h4>
          <dl className='grid grid-cols-1 gap-2 text-sm sm:grid-cols-2'>
            <div><dt className='font-medium'>Original event</dt><dd className='break-all'>{review.rootEventId} · tenant {review.tenantId}</dd></div>
            <div><dt className='font-medium'>Expected adjustment head</dt><dd>Revision {review.expectedAdjustmentRevision}</dd></div>
            <div><dt className='font-medium'>Proposed action</dt><dd>{review.kind === 'correction' ? `Replace gross total with ${formatMicrousd(review.targetChargeMicrousd)}` : `Record refund credit of ${formatMicrousd(review.refundMicrousd)}`}</dd></div>
            <div><dt className='font-medium'>Evidence</dt><dd>{selectedEvidence?.fileName ?? 'Existing READY artifact'} · {selectedEvidence?.sha256}</dd></div>
            <div className='sm:col-span-2'><dt className='font-medium'>Reason</dt><dd className='break-words'>{review.reason}</dd></div>
          </dl>
          <p className='text-xs'>This review compares your proposed amount with the server’s current gross/refunded/net snapshot above. Net is calculated and refund limits are checked by the server at confirmation. Effective time remains the original usage event time; recorded time identifies this decision.</p>
          {pending && error?.includes('acknowledgement is unknown')
            ? <Button type='button' disabled={busy} onClick={() => void submit(pending)}>Recheck same adjustment request</Button>
            : <Button type='button' disabled={busy || !history.eligible || history.adjustmentRevision !== review.expectedAdjustmentRevision} onClick={() => void submit()}>{busy ? 'Confirming…' : 'Confirm adjustment'}</Button>}
        </div>}
      </fieldset>}
    </>}
  </section>;
}
