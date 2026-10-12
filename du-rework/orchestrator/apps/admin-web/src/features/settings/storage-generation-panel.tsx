import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner } from '@/components/ui/state-panel';
import {
  createAdminApiClient,
  type AdminApiResult,
  type AdminWebSession,
  type SecretCatalogCreateBody,
  type SecretCatalogEntryRead,
  type SecretCatalogRotateBody,
  type StorageGenerationActionRequest,
  type StorageGenerationRead,
  type StorageGenerationStageRequest,
  type StorageGenerationTestRequest,
  type StorageGenerationTestResult,
} from '@/lib/api';
import { safeStorageValue } from './safe-display';
import { exactStorageSecretReference, isManagedStorageCredential, storageSecretCatalogQuery } from './storage-secret-catalog';

type CredentialAction = 'keep' | 'replace' | 'clear';
type UnknownAction = { label: string; retry: () => void };

const DEFAULT_REASON = 'Update platform artifact storage generation';

function keyForRequest(): string { return crypto.randomUUID(); }

function problemText<T>(result: AdminApiResult<T>): string {
  return result.ok
    ? ''
    : `${result.problem.title ?? 'Request failed'}${result.status === 409 ? ' The storage generation changed; reload history and review the effective generation before retrying.' : ''}`;
}

function uncertain<T>(result: AdminApiResult<T>): boolean {
  return !result.ok && (result.status === 0 || result.status >= 500);
}

function platformAdmin(session: AdminWebSession | null): boolean {
  return session?.role === 'admin' && session.principal.kind === 'platform';
}

function actionRequest(expectedRevision: number, reason: string): StorageGenerationActionRequest {
  return { expectedRevision, idempotencyKey: keyForRequest(), reason: reason.trim() || DEFAULT_REASON };
}

function safeGenerationLabel(generation: StorageGenerationRead): string {
  return `Revision ${generation.revision} · ${generation.backend.toUpperCase()} · ${generation.state}`;
}

function TestRows({ result }: { result: StorageGenerationTestResult }) {
  return <div className='rounded border p-3 text-sm' role='status'>
    <div className='flex flex-wrap items-center gap-2'><strong>Generation test · {new Date(result.checkedAt).toLocaleString()}</strong><Badge variant={result.status === 'PASSED' ? 'success' : result.status === 'UNKNOWN' ? 'warning' : 'neutral'}>{result.status}</Badge></div>
    <dl className='mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5'>{(['write', 'read', 'checksum', 'crypto', 'delete'] as const).map((name) => <div key={name}><dt className='text-xs capitalize'>{name}</dt><dd>{result[name]}</dd></div>)}</dl>
    {result.code && <p className='mt-2 text-xs'>Safe diagnostic code: <code>{result.code}</code></p>}
  </div>;
}

export function StorageGenerationPanel({ session, tenantId }: { session: AdminWebSession | null; tenantId: string | null }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [current, setCurrent] = useState<StorageGenerationRead | null>(null);
  const [generations, setGenerations] = useState<StorageGenerationRead[]>([]);
  const [secrets, setSecrets] = useState<SecretCatalogEntryRead[]>([]);
  const [selectedSecretRecord, setSelectedSecretRecord] = useState<SecretCatalogEntryRead | null>(null);
  const [rotationSecretRecord, setRotationSecretRecord] = useState<SecretCatalogEntryRead | null>(null);
  const [secretCursor, setSecretCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<UnknownAction | null>(null);
  const [testUnknown, setTestUnknown] = useState<{ generationId: string; request: StorageGenerationTestRequest } | null>(null);
  const [testResult, setTestResult] = useState<StorageGenerationTestResult | null>(null);
  const [backend, setBackend] = useState<'postgres' | 's3'>('s3');
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [urlTtlSeconds, setUrlTtlSeconds] = useState(3600);
  const [credentialAction, setCredentialAction] = useState<CredentialAction>('replace');
  const [clearForPostgres, setClearForPostgres] = useState(true);
  const [credentialRef, setCredentialRef] = useState('');
  const [secretSelection, setSecretSelection] = useState('new');
  const [secretSearch, setSecretSearch] = useState('');
  const [secretName, setSecretName] = useState('Artifact storage credential');
  const [secretValue, setSecretValue] = useState('');
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [activationTarget, setActivationTarget] = useState<StorageGenerationRead | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<StorageGenerationRead | null>(null);
  const generation = useRef(0);
  const secretRequestGeneration = useRef(0);
  const previousSecretTenant = useRef(tenantId);
  const isPlatformAdmin = platformAdmin(session);

  const load = async (): Promise<void> => {
    const requestGeneration = ++generation.current;
    if (!isPlatformAdmin) { setCurrent(null); setGenerations([]); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const [activeResponse, historyResponse] = await Promise.all([client.getStorageGeneration(), client.listStorageGenerations()]);
      if (requestGeneration !== generation.current) return;
      if (!activeResponse.ok) { setCurrent(null); setGenerations([]); setError(problemText(activeResponse)); return; }
      if (!historyResponse.ok) { setCurrent(null); setGenerations([]); setError(problemText(historyResponse)); return; }
      const active = activeResponse.data;
      const history = historyResponse.data;
      if (active.state !== 'ACTIVE' || !Array.isArray(history) || !history.some((item) => item.generationId === active.generationId && item.state === 'ACTIVE')) {
        setCurrent(null); setGenerations([]); setError('Storage history did not contain the same active generation as the current read. No stage, test or activation action is available until history is consistent.'); return;
      }
      setCurrent(active);
      setGenerations(history.slice().sort((left, right) => right.revision - left.revision));
      if (backend === 's3' && !bucket && !endpoint && !region) {
        setBackend(active.backend === 's3' ? 's3' : 's3');
        setEndpoint(active.backend === 's3' ? active.endpoint : '');
        setBucket(active.backend === 's3' ? active.bucket : '');
        setRegion(active.backend === 's3' ? active.region : '');
        setForcePathStyle(active.backend === 's3' ? active.forcePathStyle : false);
        setUrlTtlSeconds(active.urlTtlSeconds ?? 3600);
        setCredentialRef(active.credentialVersionRef ?? '');
        setCredentialAction(active.backend === 's3' ? 'keep' : 'replace');
      }
    } catch {
      if (requestGeneration === generation.current) { setCurrent(null); setGenerations([]); setError('Storage generation service could not be reached.'); }
    } finally { if (requestGeneration === generation.current) setLoading(false); }
  };

  useEffect(() => {
    setCurrent(null); setGenerations([]); setSecrets([]); setUnknown(null); setTestUnknown(null); setTestResult(null); setError(null); setNotice(null);
    if (isPlatformAdmin) void load();
    else setLoading(false);
    return () => { generation.current++; };
    // Session is checked before platform-only storage history is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, isPlatformAdmin]);

  const requestSecretPage = async (query: string, cursor: string | null, append: boolean, tenant: string, requestGeneration: number): Promise<void> => {
    try {
      const result = await client.listSecrets(storageSecretCatalogQuery(tenant, query, cursor));
      if (requestGeneration !== secretRequestGeneration.current) return;
      if (!result.ok) {
        setError(`${result.problem.title ?? 'Secret catalog unavailable'} Storage credential metadata is unavailable; no secret value was read.`);
        if (!append) { setSecrets([]); setSecretCursor(null); }
        return;
      }
      const rows = result.data.items;
      if (!Array.isArray(rows) || rows.some((row) => row.tenantId !== tenant || row.purpose !== 'storage.credential'
        || row.state !== 'ACTIVE' || !row.services.includes('orchestrator'))) {
        setError('Secret catalog returned a different tenant, purpose, state or service scope; those rows were not used.');
        if (!append) { setSecrets([]); setSecretCursor(null); }
        return;
      }
      const page = rows.filter((row) => isManagedStorageCredential(row, tenant));
      setSecrets((existing) => {
        const byReference = new Map((append ? existing : []).map((item) => [exactStorageSecretReference(item), item]));
        for (const item of page) byReference.set(exactStorageSecretReference(item), item);
        return [...byReference.values()];
      });
      setSecretCursor(result.data.nextCursor);
    } catch {
      if (requestGeneration === secretRequestGeneration.current) setError('Storage credential metadata could not be reached.');
    } finally {
      if (requestGeneration === secretRequestGeneration.current) setSecretsLoading(false);
    }
  };

  useEffect(() => {
    const requestGeneration = ++secretRequestGeneration.current;
    setSecrets([]);
    setSecretCursor(null);
    if (previousSecretTenant.current !== tenantId) {
      previousSecretTenant.current = tenantId;
      setSelectedSecretRecord(null);
      setRotationSecretRecord(null);
      setCredentialRef('');
      setSecretSelection('new');
    }
    if (!isPlatformAdmin || !tenantId) { setSecretsLoading(false); return () => { secretRequestGeneration.current++; }; }
    setSecretsLoading(true);
    const timer = window.setTimeout(() => {
      void requestSecretPage(secretSearch.trim(), null, false, tenantId, requestGeneration);
    }, secretSearch.trim() ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      if (secretRequestGeneration.current === requestGeneration) secretRequestGeneration.current++;
    };
    // Search uses the server's bounded, cursor-bound query; tenant changes cancel any old request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, isPlatformAdmin, tenantId, secretSearch]);

  const candidates = tenantId
    ? [...secrets,
      ...(selectedSecretRecord && selectedSecretRecord.tenantId === tenantId ? [selectedSecretRecord] : []),
      ...(rotationSecretRecord && rotationSecretRecord.tenantId === tenantId ? [rotationSecretRecord] : [])]
      .filter((item, index, all) => isManagedStorageCredential(item, tenantId) && all.findIndex((candidate) => exactStorageSecretReference(candidate) === exactStorageSecretReference(item)) === index)
    : [];
  const visibleCandidates = candidates;
  const selectedSecret = candidates.find((item) => exactStorageSecretReference(item) === credentialRef);
  const canKeep = current?.backend === 's3' && Boolean(current.credentialVersionRef && current.credentialOwnerTenantId);
  const canWrite = Boolean(isPlatformAdmin && current && !busy && !unknown);
  const s3FormValid = backend !== 's3' || Boolean(endpoint.trim() && bucket.trim() && region.trim() && Number.isInteger(urlTtlSeconds) && urlTtlSeconds > 0 && urlTtlSeconds <= 86400
    && ((credentialAction === 'keep' && canKeep && current?.credentialVersionRef && current.credentialOwnerTenantId)
      || (credentialAction === 'replace' && credentialRef && selectedSecret)
      || credentialAction === 'clear' && false));
  const draftCredentialRef = backend === 'postgres' ? null : credentialAction === 'keep' ? current?.credentialVersionRef ?? null : selectedSecret ? exactStorageSecretReference(selectedSecret) : null;
  const storageDiff = current ? [
    ['Backend', current.backend, backend],
    ['Endpoint', current.backend === 's3' ? safeStorageValue('endpoint', current.endpoint) : 'Server-owned PostgreSQL', backend === 's3' ? safeStorageValue('endpoint', endpoint.trim()) : 'Server-owned PostgreSQL'],
    ['Bucket', current.bucket || 'None', backend === 's3' ? bucket.trim() || 'Required' : 'None'],
    ['Region', current.region || 'None', backend === 's3' ? region.trim() || 'Required' : 'None'],
    ['Managed credential version', current.credentialVersionRef ?? 'None', draftCredentialRef ?? 'None'],
    ['Presigned URL TTL', current.urlTtlSeconds === null ? 'Not configured' : `${current.urlTtlSeconds}s`, backend === 's3' ? `${urlTtlSeconds}s` : 'Not applicable'],
    ['Path-style addressing', current.forcePathStyle ? 'Enabled' : 'Disabled', backend === 's3' ? forcePathStyle ? 'Enabled' : 'Disabled' : 'Not applicable'],
  ].filter(([, before, after]) => before !== after) : [];

  const withMutation = async <T,>(label: string, request: () => Promise<AdminApiResult<T>>, onSuccess: (data: T) => void, retrying = false): Promise<void> => {
    if (!isPlatformAdmin || !current || busy || (unknown && !retrying)) return;
    setBusy(true); setError(null); setNotice(null); setUnknown(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(problemText(response));
        if (uncertain(response)) setUnknown({ label, retry: () => { void withMutation(label, request, onSuccess, true); } });
        else if (response.status === 409) void load();
        return;
      }
      onSuccess(response.data);
    } catch {
      setError(`${label} acknowledgement was unavailable. Recheck the same idempotent request before starting another change.`);
      setUnknown({ label, retry: () => { void withMutation(label, request, onSuccess, true); } });
    } finally { setBusy(false); }
  };

  const stage = (): void => {
    if (!current || !reason.trim() || !s3FormValid || (backend === 'postgres' && !clearForPostgres)) return;
    const base = { expectedRevision: current.controlRevision, idempotencyKey: keyForRequest(), reason: reason.trim() };
    let body: StorageGenerationStageRequest;
    if (backend === 'postgres') body = { ...base, backend: 'postgres' };
    else {
      const pinnedReference = credentialAction === 'keep' ? current.credentialVersionRef : selectedSecret ? exactStorageSecretReference(selectedSecret) : null;
      const pinnedOwner = credentialAction === 'keep' ? current.credentialOwnerTenantId : selectedSecret?.tenantId ?? null;
      if (!pinnedReference || !pinnedOwner) return;
      body = {
        ...base,
        backend: 's3',
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        region: region.trim(),
        forcePathStyle,
        credentialVersionRef: pinnedReference,
        credentialOwnerTenantId: pinnedOwner,
        urlTtlSeconds,
      };
    }
    void withMutation('Storage generation stage', () => client.stageStorageGeneration(body), (data) => {
      if (data.state !== 'STAGED' || data.controlRevision !== current.controlRevision || (body.backend === 's3' && (data.credentialVersionRef !== body.credentialVersionRef || data.credentialOwnerTenantId !== body.credentialOwnerTenantId))) {
        setError('The staged storage response did not match the submitted backend and exact credential pin. Reload history before continuing.'); void load(); return;
      }
      setNotice(`Storage generation revision ${data.revision} is staged. Run its actual write/read/checksum/crypto/delete test before activation.`);
      setTestUnknown(null); void load();
    });
  };

  const runTest = (target: StorageGenerationRead, prior?: StorageGenerationTestRequest): void => {
    if (!target || target.state !== 'STAGED') return;
    const body = prior ?? { idempotencyKey: keyForRequest(), reason: reason.trim() || `Test storage generation ${target.revision}` };
    void withMutation('Storage generation test', () => client.testStorageGeneration(target.generationId, body), (result) => {
      if (result.generationId !== target.generationId) { setError('The storage test response did not match the selected generation.'); return; }
      setTestResult(result);
      if (result.status === 'UNKNOWN') setTestUnknown({ generationId: target.generationId, request: body });
      else setTestUnknown(null);
      setNotice(result.status === 'PASSED'
        ? `Generation ${target.revision} passed write, read, checksum, cryptographic round-trip and delete checks.`
        : result.status === 'UNKNOWN'
          ? 'The storage test outcome is unknown. Recheck with the same request key; do not activate this generation.'
          : `Generation ${target.revision} failed its storage test${result.code ? ` (${result.code})` : ''}. It remains staged and inactive.`);
      void load();
    });
  };

  const activate = (target: StorageGenerationRead): void => {
    if (!current || target.state !== 'STAGED' || target.lastTest?.status !== 'PASSED') return;
    const body = actionRequest(current.controlRevision, reason.trim() || `Activate storage generation ${target.revision}`);
    void withMutation('Storage generation activation', () => client.activateStorageGeneration(target.generationId, body), (result) => {
      if (result.active.generationId !== target.generationId || result.active.state !== 'ACTIVE') { setError('Activation response did not identify the requested active generation. Reload current state.'); void load(); return; }
      setNotice(`Storage generation ${result.active.revision} is active. ${result.previous ? `Prior generation ${result.previous.revision} remains pinned and retained.` : ''}`);
      setActivationTarget(null); setRollbackTarget(null); void load();
    });
  };

  const rollback = (target: StorageGenerationRead): void => {
    if (!current || target.state !== 'RETIRED' || target.lastTest?.status !== 'PASSED') return;
    const body = actionRequest(current.controlRevision, reason.trim() || `Restore storage generation ${target.revision}`);
    void withMutation('Storage generation rollback', () => client.rollbackStorageGeneration(target.generationId, body), (result) => {
      if (result.active.generationId !== target.generationId || result.active.state !== 'ACTIVE') { setError('Rollback response did not identify the requested active generation. Reload current state.'); void load(); return; }
      setNotice(`Storage generation ${result.active.revision} restored as active. The previous generation remains retained for review.`);
      setRollbackTarget(null); void load();
    });
  };

  const saveReplacementSecret = (reuseKey?: string): void => {
    if (!isPlatformAdmin || !tenantId || !secretValue || !secretName.trim() || busy || unknown) return;
    const requestId = reuseKey ?? keyForRequest();
    const selected = candidates.find((item) => item.secretId === secretSelection);
    const request = selected
      ? () => client.rotateSecret(selected.secretId, { expectedRevision: selected.revision, value: { kind: 'literal', value: secretValue } } satisfies SecretCatalogRotateBody, requestId)
      : () => client.createSecret({
          tenantId,
          name: secretName.trim(),
          purpose: 'storage.credential',
          services: ['orchestrator'],
          provider: { kind: 'managed_value' },
          value: { kind: 'literal', value: secretValue },
        } satisfies SecretCatalogCreateBody, requestId);
    void withMutation('Write-only storage credential update', request, (entry) => {
      if (!isManagedStorageCredential(entry, tenantId)) { setError('The credential write response did not match the selected tenant, purpose, provider or active revision.'); return; }
      setSecrets((items) => [...items.filter((item) => item.secretId !== entry.secretId), entry]);
      setSelectedSecretRecord(entry);
      setRotationSecretRecord(entry);
      setCredentialRef(exactStorageSecretReference(entry)); setCredentialAction('replace');
      setSecretValue(''); setNotice(`Saved secret metadata for ${entry.name}, tenant ${entry.tenantId}, revision ${entry.revision}. The value is write-only and is not shown again.`);
    });
  };

  const history = generations;
  const staged = history.filter((item) => item.state === 'STAGED');

  return <Card>
    <CardHeader><CardTitle>Artifact storage generation</CardTitle><CardDescription>Stage immutable PostgreSQL or S3 settings, test the exact generation, then activate it. Existing artifact references keep their original generation and credential revision. PostgreSQL connection details are server-owned; this form never accepts a database URL. Presigned URL lifetime is separate from cache and output retention below.</CardDescription></CardHeader>
    <CardContent className='space-y-4'>
      {error && <AlertBanner variant='error' title='Storage generation request failed'>{error}</AlertBanner>}
      {notice && <AlertBanner variant='info' title='Storage generation status'>{notice}</AlertBanner>}
      {!isPlatformAdmin && <AlertBanner variant='warning' title='Platform Admin access required'>Storage generations are available to platform Admin sessions only. The server verifies the role and CSRF proof on every command.</AlertBanner>}
      {unknown && <AlertBanner variant='warning' title={`${unknown.label} status is unknown`}><div className='space-y-2'><p>The request may have been recorded. Recheck its exact idempotency key before starting another change.</p><Button type='button' variant='outline' disabled={busy} onClick={unknown.retry}>Recheck saved result</Button></div></AlertBanner>}
      {loading && <p role='status'>Loading active storage generation and retained history…</p>}
      {current && <>
        <section className='rounded border p-3' aria-labelledby='storage-current-heading'>
          <h3 id='storage-current-heading' className='font-semibold'>Current effective generation</h3>
          <div className='mt-2 flex flex-wrap items-center gap-2'><Badge variant='success'>ACTIVE · revision {current.revision}</Badge><span>Control revision {current.controlRevision} · {current.backend.toUpperCase()}</span></div>
          {current.backend === 's3' ? <dl className='mt-2 grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2'>
            <div className='min-w-0'><dt className='font-medium'>Endpoint</dt><dd className='break-all'>{safeStorageValue('endpoint', current.endpoint)}</dd></div>
            <div><dt className='font-medium'>Bucket / region</dt><dd className='break-all'>{current.bucket} · {current.region}</dd></div>
            <div><dt className='font-medium'>Path-style addressing</dt><dd>{current.forcePathStyle ? 'Enabled' : 'Disabled'}</dd></div>
            <div><dt className='font-medium'>Presigned URL TTL</dt><dd>{current.urlTtlSeconds ?? 'Not configured'} seconds</dd></div>
            <div className='min-w-0 sm:col-span-2'><dt className='font-medium'>Pinned managed credential</dt><dd className='break-all'>{current.credentialVersionRef ? `${current.credentialVersionRef} · purpose storage.credential · owner tenant ${current.credentialOwnerTenantId}` : 'Not configured'}</dd></div>
          </dl> : <p className='mt-2 text-sm'>Database connection is server-owned. No endpoint or database credential is exposed here.</p>}
          {current.lastTest && <div className='mt-3'><TestRows result={current.lastTest} /></div>}
        </section>

        <fieldset disabled={!canWrite} className='space-y-4 rounded border p-3'>
          <legend className='px-1 font-semibold'>Stage a storage generation</legend>
          <div className='grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2'>
            <label className='block text-sm'>Artifact storage backend<select className='mt-1 block w-full min-w-0 rounded border p-2' value={backend} onChange={(event) => { setBackend(event.target.value as 'postgres' | 's3'); setTestResult(null); }}><option value='postgres'>PostgreSQL (server-owned connection)</option><option value='s3'>S3-compatible object storage</option></select></label>
            {backend === 's3' && <>
              <label className='block min-w-0 text-sm'>S3 endpoint<input className='mt-1 block w-full min-w-0 rounded border p-2' type='url' inputMode='url' autoComplete='url' maxLength={2048} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder='https://objects.example.net' /></label>
              <label className='block min-w-0 text-sm'>Bucket<input className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={255} value={bucket} onChange={(event) => setBucket(event.target.value)} /></label>
              <label className='block min-w-0 text-sm'>Region<input className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={128} value={region} onChange={(event) => setRegion(event.target.value)} /></label>
              <label className='block min-w-0 text-sm'>Presigned URL TTL (seconds)<input className='mt-1 block w-full min-w-0 rounded border p-2' type='number' min={1} max={86400} step={1} value={urlTtlSeconds} onChange={(event) => setUrlTtlSeconds(Number(event.target.value))} /><span className='text-xs'>Controls signed link lifetime only. Cache TTL and output retention use Platform retention policy.</span></label>
              <label className='flex items-start gap-2 text-sm md:col-span-2'><input type='checkbox' className='mt-1' checked={forcePathStyle} onChange={(event) => setForcePathStyle(event.target.checked)} />Use path-style bucket addressing for this endpoint.</label>
              <fieldset className='space-y-3 rounded border p-3 md:col-span-2'><legend className='px-1 text-sm font-semibold'>Credential version action</legend>
                <div className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                  <label className='flex items-start gap-2 text-sm'><input type='radio' name='storage-credential-action' className='mt-1' value='keep' checked={credentialAction === 'keep'} disabled={!canKeep} onChange={() => setCredentialAction('keep')} /><span>Keep exact current pin{canKeep ? ` (${current.credentialVersionRef})` : ' (unavailable)'}</span></label>
                  <label className='flex items-start gap-2 text-sm'><input type='radio' name='storage-credential-action' className='mt-1' value='replace' checked={credentialAction === 'replace'} onChange={() => setCredentialAction('replace')} /><span>Replace with an exact managed secret revision</span></label>
                  <label className='flex items-start gap-2 text-sm'><input type='radio' name='storage-credential-action' className='mt-1' value='clear' checked={credentialAction === 'clear'} disabled={backend === 's3'} onChange={() => setCredentialAction('clear')} /><span>Clear only when staging PostgreSQL</span></label>
                </div>
                {credentialAction === 'keep' && canKeep && <p className='break-all text-xs'>Keeps {current.credentialVersionRef} owned by tenant {current.credentialOwnerTenantId}; the previous storage generation retains its existing reference.</p>}
                {credentialAction === 'replace' && <div className='space-y-3'>
                  <label className='block text-sm'>Search eligible credential metadata on the server<input type='search' className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={128} value={secretSearch} onChange={(event) => { setSecretSearch(event.target.value); setSelectedSecretRecord(null); setRotationSecretRecord(null); setCredentialRef(''); setSecretSelection('new'); }} placeholder='Name or credential reference' /></label>
                  <label className='block text-sm'>Active managed storage credential<select className='mt-1 block w-full min-w-0 rounded border p-2' value={credentialRef} onChange={(event) => { setCredentialRef(event.target.value); const chosen = candidates.find((item) => exactStorageSecretReference(item) === event.target.value); setSelectedSecretRecord(chosen ?? null); setSecretSelection(chosen?.secretId ?? 'new'); setRotationSecretRecord(chosen ?? null); }}><option value=''>{secretsLoading ? 'Loading exact tenant secret revisions…' : 'Choose a credential revision'}</option>{visibleCandidates.map((item) => <option key={exactStorageSecretReference(item)} value={exactStorageSecretReference(item)}>{item.name} · tenant {item.tenantId} · revision {item.revision}</option>)}</select><span className='text-xs'>The server searches active managed credentials by tenant, `storage.credential` purpose and `orchestrator` service. Only metadata is returned; the selected generation keeps the exact `secretId@revision` pin.</span></label>
                  <div className='flex flex-wrap items-center justify-between gap-2 text-xs'>
                    <span>{secretsLoading ? 'Loading a bounded Secret Catalog page…' : `${secrets.length} metadata row(s) loaded for this search.`}</span>
                    {secretCursor && <Button type='button' variant='outline' disabled={secretsLoading || busy || Boolean(unknown)} onClick={() => { if (tenantId) { setSecretsLoading(true); void requestSecretPage(secretSearch.trim(), secretCursor, true, tenantId, secretRequestGeneration.current); } }}>Load next credential page</Button>}
                  </div>
                  <details className='rounded border p-3'><summary className='cursor-pointer text-sm font-medium'>Write a replacement credential once</summary>
                    <div className='mt-3 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2'>
                      <label className='block text-sm'>Save as<select className='mt-1 block w-full min-w-0 rounded border p-2' value={secretSelection} onChange={(event) => { setSecretSelection(event.target.value); setRotationSecretRecord(candidates.find((item) => item.secretId === event.target.value) ?? null); }}><option value='new'>Create a new managed credential</option>{visibleCandidates.map((item) => <option key={item.secretId} value={item.secretId}>Rotate {item.name} · revision {item.revision}</option>)}</select></label>
                      {secretSelection === 'new' && <label className='block text-sm'>Credential label<input className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={128} value={secretName} onChange={(event) => setSecretName(event.target.value)} /></label>}
                      <label className='block text-sm md:col-span-2'>Replacement credential<input className='mt-1 block w-full min-w-0 rounded border p-2' type='password' autoComplete='new-password' value={secretValue} maxLength={16384} onChange={(event) => setSecretValue(event.target.value)} /><span className='text-xs'>Write-only input. It is sent once over the authenticated Admin API and cleared from this form after a confirmed save. Readback contains metadata only.</span></label>
                      <Button type='button' className='md:col-span-2' disabled={!isPlatformAdmin || !tenantId || !secretValue || !secretName.trim() || busy || Boolean(unknown)} onClick={() => saveReplacementSecret()}>{busy ? 'Saving credential…' : secretSelection === 'new' ? 'Create managed credential revision' : 'Rotate selected managed credential'}</Button>
                    </div>
                  </details>
                  {credentialRef && selectedSecret && <p className='break-all text-xs'>Exact selected pin: {selectedSecret.name} · {exactStorageSecretReference(selectedSecret)} · tenant {selectedSecret.tenantId} · purpose {selectedSecret.purpose} · revision {selectedSecret.revision}.</p>}
                  {!tenantId && <p role='status' className='text-sm'>Select an organization to list or create owner-scoped storage credentials.</p>}
                  {!secretsLoading && tenantId && candidates.length === 0 && <p role='status' className='text-sm'>No eligible credential matched this server-side search. Create a managed credential above or broaden the search.</p>}
                </div>}
                {credentialAction === 'clear' && <p className='text-sm'>The next generation will contain no S3 credential. Existing retired S3 generations retain their exact credential reference for old objects and rollback.</p>}
              </fieldset>
            </>}
          </div>
          <label className='block text-sm'>Change reason<input className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          {backend === 'postgres' && <fieldset className='rounded border p-3'><legend className='px-1 text-sm font-semibold'>Credential version action</legend><label className='flex items-start gap-2 text-sm'><input type='checkbox' className='mt-1' checked={clearForPostgres} onChange={(event) => setClearForPostgres(event.target.checked)} />Clear the S3 credential pin from this new PostgreSQL generation.</label><p className='mt-1 text-xs'>The retired S3 generation keeps its exact reference for existing objects and rollback. This does not disable or delete a Secret Catalog entry.</p></fieldset>}
          {backend === 'postgres' && <p className='text-sm'>PostgreSQL stage requests contain only the backend, expected generation revision, idempotency key and reason. Database connection fields and credentials remain server-owned.</p>}
          {!s3FormValid && backend === 's3' && <p role='alert' className='text-sm text-red-700'>S3 requires an endpoint, bucket, region, valid presign TTL, and either the current exact credential pin or an active tenant-owned managed credential revision.</p>}
          {storageDiff.length > 0 && <details className='rounded border p-3'><summary className='cursor-pointer text-sm font-medium'>Review storage diff before staging ({storageDiff.length} fields)</summary><dl className='mt-2 grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-[minmax(8rem,max-content)_minmax(0,1fr)_minmax(0,1fr)]'>{storageDiff.map(([name, before, after]) => <div key={name} className='contents'><dt className='font-medium'>{name}</dt><dd className='min-w-0 break-all rounded bg-muted p-2'>{before}</dd><dd className='min-w-0 break-all rounded bg-muted p-2'>{after}</dd></div>)}</dl></details>}
          <p className='text-xs'>Unsaved stage values stay in this page until the immutable generation is staged. Staging does not change the active runtime.</p>
          <Button type='button' disabled={!canWrite || !reason.trim() || !s3FormValid || (backend === 'postgres' && !clearForPostgres)} onClick={stage}>{busy ? 'Saving…' : `Stage ${backend.toUpperCase()} generation`}</Button>
        </fieldset>

        {staged.length > 0 && <section className='space-y-3 border-t pt-4' aria-labelledby='storage-staged-heading'><h3 id='storage-staged-heading' className='font-semibold'>Staged generations</h3>{staged.map((item) => <article key={item.generationId} className='space-y-3 rounded border p-3'>
          <div className='flex flex-wrap items-center gap-2'><Badge variant={item.lastTest?.status === 'PASSED' ? 'success' : item.lastTest?.status === 'UNKNOWN' ? 'warning' : 'neutral'}>{safeGenerationLabel(item)}</Badge><span className='break-all text-xs'>{item.generationId}</span></div>
          <p className='break-all text-sm'>{item.backend === 's3' ? `${safeStorageValue('endpoint', item.endpoint)} · ${item.bucket} · ${item.region} · credential ${item.credentialVersionRef} · owner ${item.credentialOwnerTenantId} · presign ${item.urlTtlSeconds}s` : 'PostgreSQL · trusted server-owned connection'}</p>
          {(item.lastTest ?? (testResult?.generationId === item.generationId ? testResult : null)) && <TestRows result={item.lastTest ?? testResult!} />}
          {testUnknown?.generationId === item.generationId && <AlertBanner variant='warning' title='Storage test acknowledgement is unknown'><p>Resolve this exact test using the same request key. No activation is available until a passing receipt is confirmed.</p><Button type='button' variant='outline' disabled={busy} onClick={() => runTest(item, testUnknown.request)}>Recheck exact test result</Button></AlertBanner>}
          <div className='flex flex-wrap gap-2'><Button type='button' disabled={!canWrite || item.state !== 'STAGED'} onClick={() => runTest(item)}>{item.lastTest?.status === 'PASSED' ? 'Run storage test again' : 'Test exact generation'}</Button><Button type='button' disabled={!canWrite || item.state !== 'STAGED' || item.lastTest?.status !== 'PASSED'} onClick={() => setActivationTarget(item)}>Review activation</Button></div>
        </article>)}</section>}

        {activationTarget && <div role='group' aria-labelledby='storage-activation-confirm' className='rounded border p-3'><h3 id='storage-activation-confirm' className='font-semibold'>Confirm storage generation activation</h3><p className='break-all text-sm'>Activate tested generation {activationTarget.revision} ({activationTarget.backend}) after its passing write/read/checksum/crypto/delete receipt? The prior generation remains retained for old object references.</p><div className='mt-2 flex flex-wrap gap-2'><Button type='button' disabled={!canWrite || activationTarget.lastTest?.status !== 'PASSED'} onClick={() => activate(activationTarget)}>Activate generation</Button><Button type='button' variant='outline' disabled={busy} onClick={() => setActivationTarget(null)}>Cancel</Button></div></div>}

        <section className='space-y-3 border-t pt-4' aria-labelledby='storage-history-heading'><h3 id='storage-history-heading' className='font-semibold'>Current and retained generations</h3>
          {history.length === 0 && <p className='text-sm'>No retained generation rows were returned.</p>}
          <div className='space-y-2'>{history.map((item) => <article key={item.generationId} className='min-w-0 rounded border p-3'>
            <div className='flex flex-wrap items-center gap-2'><strong>Generation {item.revision}</strong><Badge variant={item.state === 'ACTIVE' ? 'success' : item.state === 'STAGED' ? 'warning' : item.state === 'FAILED' ? 'neutral' : 'info'}>{item.state}</Badge><span className='text-sm'>{item.backend.toUpperCase()}</span></div>
            <p className='mt-1 break-all text-xs'>{item.backend === 's3' ? `${safeStorageValue('endpoint', item.endpoint)} · ${item.bucket} · ${item.region}` : 'server-owned PostgreSQL backend'} · generation {item.generationId}</p>
            {item.backend === 's3' && <p className='break-all text-xs'>Pinned credential revision: {item.credentialVersionRef ?? 'none'} · purpose storage.credential · owner tenant {item.credentialOwnerTenantId ?? 'none'} · {item.secretPresent ? 'managed secret present' : 'no secret pin'}.</p>}
            {item.state === 'RETIRED' && item.lastTest && <p className='text-xs'>Retained test status: {item.lastTest.status}{item.activatedAt ? ` · was active at ${new Date(item.activatedAt).toLocaleString()}` : ''}</p>}
            {item.state === 'RETIRED' && <Button type='button' variant='outline' className='mt-2' disabled={!canWrite || item.lastTest?.status !== 'PASSED'} onClick={() => setRollbackTarget(item)}>Review rollback to this retained generation</Button>}
          </article>)}</div>
        </section>
        {rollbackTarget && <div role='group' aria-labelledby='storage-rollback-confirm' className='rounded border p-3'><h3 id='storage-rollback-confirm' className='font-semibold'>Confirm storage generation rollback</h3><p className='break-all text-sm'>Restore retained generation {rollbackTarget.revision} ({rollbackTarget.backend}) using its exact existing credential and object-generation pins? New writes will use this generation; old object references keep their own pins.</p><div className='mt-2 flex flex-wrap gap-2'><Button type='button' disabled={!canWrite || rollbackTarget.lastTest?.status !== 'PASSED'} onClick={() => rollback(rollbackTarget)}>Restore retained generation</Button><Button type='button' variant='outline' disabled={busy} onClick={() => setRollbackTarget(null)}>Cancel</Button></div></div>}
      </>}
      <Button type='button' variant='outline' disabled={!isPlatformAdmin || loading || busy || Boolean(unknown)} onClick={() => void load()}>Reload storage generation history</Button>
    </CardContent>
  </Card>;
}
