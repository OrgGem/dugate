import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner } from '@/components/ui/state-panel';
import {
  createAdminApiClient,
  type AdminApiResult,
  type AdminWebSession,
  type GlobalSettingsPublishRequest,
  type GlobalSettingsRollbackRequest,
  type PlatformRetentionDraftRequest,
  type PlatformRetentionRead,
  type TenantAiDraftRequest,
  type TenantAiTestRequest,
  type TenantGlobalSettingsRead,
  type TenantPromptDraftRequest,
} from '@/lib/api';
import type { TenantActiveConnectorCatalogItem, TenantAiDefaults, TenantPromptDefaults } from '@du/contracts';
import { PROMPT_PRESETS, promptIssues, type PromptLocale } from './prompt-presets';
import type { EffectiveConfiguration } from './configuration-revisions';
import { tenantActiveConnectorPageMatches, tenantActiveConnectorQuery } from './tenant-connector-catalog';

type Mutation<T> = { label: string; run: () => Promise<AdminApiResult<T>> };
type UnknownAction = { label: string; retry: () => void };
type AiTestParameter = { name: string; kind: 'string' | 'number' | 'boolean'; value: string };

const DEFAULT_TEST_PROMPT = 'Reply with exactly: DUGATE AI connectivity test passed.';
const DEFAULT_AI: TenantAiDefaults = { provider: 'gemini', model: 'gemini-1.5-flash', connectorId: null, connectorRevision: null };
const DEFAULT_RETENTION = { cacheTtlHours: 168, outputRetentionDays: 30, cleanupIntervalSeconds: 3600 };
const DEFAULT_PROMPTS: TenantPromptDefaults = PROMPT_PRESETS.en;

function completePrompts(value: Partial<Record<keyof TenantPromptDefaults, string | null>> | null | undefined): TenantPromptDefaults {
  return {
    image: value?.image ?? DEFAULT_PROMPTS.image,
    pdf: value?.pdf ?? DEFAULT_PROMPTS.pdf,
    docx: value?.docx ?? DEFAULT_PROMPTS.docx,
    compare: value?.compare ?? DEFAULT_PROMPTS.compare,
    generate: value?.generate ?? DEFAULT_PROMPTS.generate,
  };
}

function keyForRequest(): string {
  return crypto.randomUUID();
}

function problemText<T>(result: AdminApiResult<T>): string {
  return result.ok ? '' : `${result.problem.title ?? 'Request failed'}${result.status === 409 ? ' The active revision changed; reload and inspect the current values before retrying.' : ''}`;
}

function isUncertain<T>(result: AdminApiResult<T>): boolean {
  return !result.ok && (result.status === 0 || result.status >= 500);
}

function canManageTenant(session: AdminWebSession | null, tenantId: string | null): boolean {
  return Boolean(session?.role === 'admin' && tenantId
    && (session.principal.kind === 'platform' || (session.principal.kind === 'tenant_operator' && session.principal.tenantId === tenantId)));
}

function connectorName(connector: TenantActiveConnectorCatalogItem): string {
  return `${connector.connectorId} · ${connector.provider} · ${connector.model ?? 'model not set'} · revision ${connector.revision}`;
}

function activeRevision<T extends { revision: number }>(history: T[], revision: number | null): T | null {
  return revision === null ? null : history.find((item) => item.revision === revision) ?? null;
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Array<{ name: string; before: string; after: string }> {
  return Object.keys(after).flatMap((name) => {
    const left = JSON.stringify(before[name] ?? null);
    const right = JSON.stringify(after[name] ?? null);
    return left === right ? [] : [{ name, before: before[name] === undefined ? 'Not set' : String(before[name]), after: after[name] === undefined ? 'Not set' : String(after[name]) }];
  });
}

function RevisionHistory<T extends { revision: number; state: string; createdAt: string; actor: string; digest: string }>({ items, active, onRollback, disabled }: {
  items: T[];
  active: number | null;
  onRollback: (revision: number) => void;
  disabled: boolean;
}) {
  return <div className='space-y-2'>
    <h3 className='font-semibold'>Revision history</h3>
    {items.length === 0 ? <p className='text-sm'>No saved revisions yet.</p> : <ul className='space-y-2'>
      {items.map((item) => <li key={item.revision} className='flex min-w-0 flex-col gap-2 rounded border p-3 sm:flex-row sm:items-center sm:justify-between'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'><strong>Revision {item.revision}</strong><Badge variant={item.revision === active ? 'success' : item.state === 'DRAFT' ? 'warning' : 'neutral'}>{item.revision === active ? 'CURRENT' : item.state}</Badge></div>
          <p className='break-all text-xs'>Created {new Date(item.createdAt).toLocaleString()} · {item.actor} · {item.digest}</p>
        </div>
        {(item.state === 'PUBLISHED' || item.state === 'SUPERSEDED') && item.revision !== active
          ? <Button type='button' variant='outline' disabled={disabled} onClick={() => onRollback(item.revision)}>Review rollback</Button>
          : null}
      </li>)}
    </ul>}
  </div>;
}

export function TenantAiSettingsPanel({
  tenantId,
  session,
  apiKeyId,
  endpointSlug,
  configuration,
}: {
  tenantId: string | null;
  session: AdminWebSession | null;
  apiKeyId: string;
  endpointSlug: string;
  configuration: EffectiveConfiguration | undefined;
}) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [read, setRead] = useState<TenantGlobalSettingsRead | null>(null);
  const [connectors, setConnectors] = useState<TenantActiveConnectorCatalogItem[]>([]);
  const [connectorsScope, setConnectorsScope] = useState<string | null>(null);
  const [connectorCursor, setConnectorCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [connectorLoading, setConnectorLoading] = useState(false);
  const [connectorIssue, setConnectorIssue] = useState<string | null>(null);
  const [connectorSearch, setConnectorSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<UnknownAction | null>(null);
  const [aiDraft, setAiDraft] = useState<TenantAiDefaults>(DEFAULT_AI);
  const [aiDirty, setAiDirty] = useState(false);
  const [promptDraft, setPromptDraft] = useState<TenantPromptDefaults>(DEFAULT_PROMPTS);
  const [promptDirty, setPromptDirty] = useState(false);
  const [reason, setReason] = useState('Update tenant AI and prompt defaults');
  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  const [testParameters, setTestParameters] = useState<AiTestParameter[]>([]);
  const [testFiles, setTestFiles] = useState<File[]>([]);
  const [testResult, setTestResult] = useState<{ revision: number; ok: boolean; testedAt: string; errorCode: string | null } | null>(null);
  const [testUnknown, setTestUnknown] = useState<{ body: TenantAiTestRequest; label: string } | null>(null);
  const [rollbackChoice, setRollbackChoice] = useState<{ stream: 'ai' | 'prompts'; revision: number } | null>(null);
  const requestGeneration = useRef(0);
  const connectorRequestGeneration = useRef(0);
  const connectorScope = JSON.stringify([tenantId, aiDraft.provider, connectorSearch.trim()]);

  const requestConnectorPage = async (query: string, cursor: string | null, append: boolean, tenant: string, generation: number): Promise<void> => {
    const request = tenantActiveConnectorQuery(session, tenant, query, cursor);
    if (!request) {
      setConnectorIssue('A current Admin session scoped to this tenant is required for the active Connector catalog.');
      setConnectorLoading(false);
      return;
    }
    try {
      const result = await client.listTenantActiveConnectorRevisions(request);
      if (generation !== connectorRequestGeneration.current) return;
      if (!result.ok) {
        setConnectorIssue(`${result.problem.title ?? 'Connector catalog unavailable'} No platform-wide catalog fallback was used.`);
        if (!append) { setConnectors([]); setConnectorCursor(null); setConnectorsScope(null); }
        return;
      }
      if (!tenantActiveConnectorPageMatches(result.data, tenant)) {
        setConnectorIssue('Tenant Connector catalog returned a different tenant. Those revisions were discarded.');
        if (!append) { setConnectors([]); setConnectorCursor(null); setConnectorsScope(null); }
        return;
      }
      const currentScope = JSON.stringify([tenant, aiDraft.provider, query]);
      setConnectors((existing) => {
        const byRevision = new Map((append ? existing : []).map((item) => [`${item.connectorId}@${item.revision}`, item]));
        for (const item of result.data.items) byRevision.set(`${item.connectorId}@${item.revision}`, item);
        return [...byRevision.values()];
      });
      setConnectorsScope(currentScope);
      setConnectorCursor(result.data.nextCursor);
      setConnectorIssue(null);
    } catch {
      if (generation === connectorRequestGeneration.current) setConnectorIssue('Tenant Connector catalog could not be reached.');
    } finally {
      if (generation === connectorRequestGeneration.current) setConnectorLoading(false);
    }
  };

  const load = async (resetForms = false): Promise<void> => {
    const generation = ++requestGeneration.current;
    if (!tenantId) { setRead(null); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const response = await client.getGlobalSettings(tenantId);
      if (generation !== requestGeneration.current) return;
      if (!response.ok) { setRead(null); setError(problemText(response)); return; }
      if (response.data.tenantId !== tenantId) { setRead(null); setError('The settings response did not match the selected organization.'); return; }
      setRead(response.data);
      if (resetForms || !aiDirty) {
        const base = response.data.ai.draft?.settings
          ?? activeRevision(response.data.ai.history, response.data.ai.activeRevision)?.settings
          ?? DEFAULT_AI;
        setAiDraft(base); setAiDirty(false);
      }
      if (resetForms || !promptDirty) {
        const base = response.data.prompts.draft?.settings
          ?? activeRevision(response.data.prompts.history, response.data.prompts.activeRevision)?.settings
          ?? response.data.effective.prompts;
        setPromptDraft(completePrompts(base)); setPromptDirty(false);
      }
    } catch {
      if (generation === requestGeneration.current) { setRead(null); setError('Tenant settings could not be reached.'); }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    setRead(null); setConnectors([]); setConnectorsScope(null); setConnectorCursor(null); setAiDraft(DEFAULT_AI); setAiDirty(false); setPromptDraft(DEFAULT_PROMPTS); setPromptDirty(false);
    setConnectorSearch('');
    setTestFiles([]); setTestParameters([]); setTestResult(null); setTestUnknown(null); setUnknown(null); setError(null); setNotice(null);
    void load(true);
    return () => { requestGeneration.current++; };
    // tenant changes intentionally discard a scoped editor buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, client]);

  useEffect(() => {
    const generation = ++connectorRequestGeneration.current;
    setConnectors([]); setConnectorsScope(null); setConnectorCursor(null); setConnectorIssue(null);
    const allowedPrincipal = Boolean(session && tenantId && (session.principal.kind === 'platform'
      || (session.principal.kind === 'tenant_operator' && session.principal.tenantId === tenantId)));
    if (!tenantId || session?.role !== 'admin' || !allowedPrincipal) {
      setConnectorLoading(false);
      if (tenantId && session?.principal.kind === 'tenant_operator' && session.principal.tenantId !== tenantId) {
        setConnectorIssue('The selected organization is outside the current tenant operator scope.');
      } else if (tenantId && session && session.role !== 'admin') {
        setConnectorIssue('An Admin session is required to read active tenant Connector revisions.');
      }
      return () => { if (connectorRequestGeneration.current === generation) connectorRequestGeneration.current++; };
    }
    setConnectorLoading(true);
    const timer = window.setTimeout(() => { void requestConnectorPage(connectorSearch.trim(), null, false, tenantId, generation); }, connectorSearch.trim() ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      if (connectorRequestGeneration.current === generation) connectorRequestGeneration.current++;
    };
    // Tenant, provider, and text filters all invalidate the prior cursor and response scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tenantId, session?.principal.kind, session?.principal.tenantId, session?.role, aiDraft.provider, connectorSearch]);

  const authorized = canManageTenant(session, tenantId);
  // Tag each response with its tenant so the previous tenant's revision data
  // cannot flash or be submitted during the render before an effect runs.
  const scopedRead = read?.tenantId === tenantId ? read : null;
  const tenantConnectors = connectorsScope === connectorScope ? connectors : [];
  const canWrite = Boolean(authorized && scopedRead?.capability.editable && !busy && !unknown);
  const canTest = Boolean(authorized && scopedRead?.capability.testable && !busy && !unknown && !testUnknown);
  const matchingConnectors = tenantConnectors.filter((item) => item.adapter === aiDraft.provider);
  const visibleConnectors = matchingConnectors;
  const selectedConnector = matchingConnectors.find((item) => item.connectorId === aiDraft.connectorId && item.revision === aiDraft.connectorRevision);
  const savedAiDraft = scopedRead?.ai.draft?.settings ?? null;
  const savedDraftConnector = savedAiDraft
    ? matchingConnectors.find((item) => item.connectorId === savedAiDraft.connectorId && item.revision === savedAiDraft.connectorRevision)
    : null;
  const savedDraftMatchesLocal = Boolean(savedAiDraft && !aiDirty
    && savedAiDraft.provider === aiDraft.provider
    && savedAiDraft.model === aiDraft.model
    && savedAiDraft.connectorId === aiDraft.connectorId
    && savedAiDraft.connectorRevision === aiDraft.connectorRevision);
  const connectorOptions = visibleConnectors;
  const activeAi = activeRevision(scopedRead?.ai.history ?? [], scopedRead?.ai.activeRevision ?? null);
  const activePrompts = activeRevision(scopedRead?.prompts.history ?? [], scopedRead?.prompts.activeRevision ?? null);
  const aiDiff = changedFields((activeAi?.settings ?? DEFAULT_AI) as unknown as Record<string, unknown>, aiDraft as unknown as Record<string, unknown>);
  const promptDiff = changedFields((activePrompts?.settings ?? DEFAULT_PROMPTS) as unknown as Record<string, unknown>, promptDraft as unknown as Record<string, unknown>);
  const promptValidation = promptIssues(promptDraft);
  const testEnabled = canTest && Boolean(tenantId && apiKeyId && endpointSlug && configuration?.profile?.profileId && configuration.profile.revision > 0 && savedDraftConnector && savedDraftMatchesLocal && testPrompt.trim());

  const mutate = async <T,>(request: Mutation<T>, onSuccess: (value: T) => void, retrying = false): Promise<void> => {
    if (!authorized || !scopedRead?.capability.editable || busy || (unknown && !retrying)) return;
    setBusy(true); setError(null); setNotice(null); setUnknown(null);
    try {
      const response = await request.run();
      if (!response.ok) {
        setError(problemText(response));
        if (isUncertain(response)) setUnknown({ label: request.label, retry: () => { void mutate(request, onSuccess, true); } });
        return;
      }
      setUnknown(null); onSuccess(response.data);
    } catch {
      setError(`${request.label} response was unavailable. Check the saved revision before starting a new request.`);
      setUnknown({ label: request.label, retry: () => { void mutate(request, onSuccess, true); } });
    } finally { setBusy(false); }
  };

  const createAiDraft = (reuseKey?: string): void => {
    if (!tenantId || !scopedRead || !selectedConnector || !reason.trim()) return;
    const body: TenantAiDraftRequest = {
      expectedActiveRevision: scopedRead.ai.activeRevision,
      sourceRevision: scopedRead.ai.draft?.revision ?? scopedRead.ai.activeRevision,
      settings: aiDraft,
      idempotencyKey: reuseKey ?? keyForRequest(),
      reason: reason.trim(),
    };
    void mutate({ label: 'AI draft save', run: () => client.createTenantAiDraft(tenantId, body) }, () => {
      setNotice('AI draft saved. Test this exact draft through the Connector before publishing it.'); setAiDirty(false); void load(false);
    });
  };

  const createPromptDraft = (reuseKey?: string): void => {
    if (!tenantId || !scopedRead || promptValidation.length > 0 || !reason.trim()) return;
    const body: TenantPromptDraftRequest = {
      expectedActiveRevision: scopedRead.prompts.activeRevision,
      sourceRevision: scopedRead.prompts.draft?.revision ?? scopedRead.prompts.activeRevision,
      settings: promptDraft,
      idempotencyKey: reuseKey ?? keyForRequest(),
      reason: reason.trim(),
    };
    void mutate({ label: 'Prompt draft save', run: () => client.createTenantPromptDraft(tenantId, body) }, () => {
      setNotice('Prompt draft saved. Review the exact placeholder checks and diff before publishing.'); setPromptDirty(false); void load(false);
    });
  };

  const publish = (stream: 'ai' | 'prompts', reuseKey?: string): void => {
    if (!tenantId || !scopedRead) return;
    const draft = stream === 'ai' ? scopedRead.ai.draft : scopedRead.prompts.draft;
    if (!draft || (stream === 'ai' && draft.state !== 'TESTED') || (stream === 'prompts' && promptIssues(draft.settings as TenantPromptDefaults).length > 0)) return;
    const body: GlobalSettingsPublishRequest = {
      draftRevision: draft.revision,
      expectedActiveRevision: stream === 'ai' ? scopedRead.ai.activeRevision : scopedRead.prompts.activeRevision,
      idempotencyKey: reuseKey ?? keyForRequest(),
      reason: reason.trim() || `Publish tenant ${stream} defaults`,
    };
    const request = stream === 'ai'
      ? { label: 'AI publish', run: () => client.publishTenantAiRevision(tenantId, body) }
      : { label: 'Prompt publish', run: () => client.publishTenantPromptRevision(tenantId, body) };
    void mutate(request, () => { setNotice(`${stream === 'ai' ? 'AI' : 'Prompt'} revision ${draft.revision} published for new requests.`); setRollbackChoice(null); void load(false); });
  };

  const rollback = (stream: 'ai' | 'prompts', targetRevision: number, reuseKey?: string): void => {
    if (!tenantId || !scopedRead) return;
    const body: GlobalSettingsRollbackRequest = {
      targetRevision,
      expectedActiveRevision: stream === 'ai' ? scopedRead.ai.activeRevision : scopedRead.prompts.activeRevision,
      idempotencyKey: reuseKey ?? keyForRequest(),
      reason: reason.trim() || `Rollback tenant ${stream} defaults`,
    };
    const request = stream === 'ai'
      ? { label: 'AI rollback', run: () => client.rollbackTenantAiRevision(tenantId, body) }
      : { label: 'Prompt rollback', run: () => client.rollbackTenantPromptRevision(tenantId, body) };
    void mutate(request, () => { setNotice(`${stream === 'ai' ? 'AI' : 'Prompt'} settings restored from revision ${targetRevision} as a new active revision.`); setRollbackChoice(null); void load(false); });
  };

  const runAiTest = async (existingBody?: TenantAiTestRequest): Promise<void> => {
    if (!tenantId || !scopedRead || !configuration?.profile || !apiKeyId || !endpointSlug || !savedDraftConnector || !savedDraftMatchesLocal || !scopedRead.ai.draft || aiDirty) return;
    let body: TenantAiTestRequest | undefined = existingBody;
    if (!body) {
      const parameters: Record<string, unknown> = {};
      const parameterName = /^[A-Za-z0-9_.:-]{1,128}$/;
      const sensitiveParameter = /(?:^|[^a-z0-9])(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|source[_-]?url|endpoint[_-]?url)(?:$|[^a-z0-9])/i;
      for (const entry of testParameters) {
        if (!parameterName.test(entry.name) || sensitiveParameter.test(entry.name) || Object.hasOwn(parameters, entry.name)) {
          setError('Test parameter names must be unique, valid identifiers and cannot contain credential, authorization or URL values.'); return;
        }
        if (entry.kind === 'number') {
          const number = Number(entry.value);
          if (!entry.value.trim() || !Number.isFinite(number)) { setError(`Parameter ${entry.name} needs a valid finite number.`); return; }
          parameters[entry.name] = number;
        } else if (entry.kind === 'boolean') {
          if (entry.value !== 'true' && entry.value !== 'false') { setError(`Parameter ${entry.name} needs a true or false value.`); return; }
          parameters[entry.name] = entry.value === 'true';
        } else {
          if (entry.value.length > 8192) { setError(`Parameter ${entry.name} exceeds the supported size.`); return; }
          parameters[entry.name] = entry.value;
        }
      }
      if (JSON.stringify(parameters).length > 32_768) { setError('Provider test parameters exceed 32 KiB.'); return; }
      setBusy(true); setError(null); setTestResult(null); setNotice(null);
      try {
        const version = await client.getBusinessVersions('document-core');
        if (!version.ok || version.data.businessId !== 'document-core' || !version.data.activeVersion) {
          setError(version.ok ? 'The active document-core version could not be confirmed.' : problemText(version)); return;
        }
        const artifactIds: string[] = [];
        for (const file of testFiles) {
          const uploaded = await client.uploadWorkflowFile(tenantId, apiKeyId, file);
          if (!uploaded.ok) { setError(`${uploaded.problem.title ?? 'Test file upload failed'} No provider request was started.`); return; }
          if (uploaded.data.state !== 'READY') { setError('The uploaded test artifact is not ready. No provider request was started.'); return; }
          artifactIds.push(uploaded.data.artifactId);
        }
        body = {
          revision: scopedRead.ai.draft.revision,
          apiKeyId,
          profileId: configuration.profile.profileId,
          expectedProfileRevision: configuration.profile.revision,
          businessId: 'document-core',
          businessVersion: version.data.activeVersion,
          action: endpointSlug.split(':', 1)[0] ?? endpointSlug,
          endpointSlug,
          prompt: testPrompt.trim(),
          parameters,
          artifactIds,
          timeoutMs: 30_000,
          idempotencyKey: keyForRequest(),
        };
        setTestUnknown(null);
      } catch {
        setError('The test setup could not be confirmed. No provider request was started.'); return;
      } finally { setBusy(false); }
    }
    setBusy(true); setError(null); setTestResult(null); setNotice(null);
    try {
      const response = await client.testTenantAiRevision(tenantId, body);
      if (!response.ok) {
        setError(problemText(response));
        if (isUncertain(response)) setTestUnknown({ body, label: 'AI provider test' });
        return;
      }
      if (response.data.tenantId !== tenantId || response.data.revision !== body.revision) {
        setError('The test response did not match the selected tenant and AI revision.'); setTestUnknown({ body, label: 'AI provider test' }); return;
      }
      setTestResult(response.data);
      setTestUnknown(response.data.errorCode === 'PROVIDER_TEST_UNKNOWN' ? { body, label: 'AI provider test evidence lookup' } : null);
      setNotice(response.data.ok ? 'The selected Connector returned a durable provider response and usage receipt. The tested draft can now be published.' : `The upstream provider test did not pass${response.data.errorCode ? ` (${response.data.errorCode})` : ''}. The draft remains unpublished.`);
      if (response.data.ok) void load(false);
    } catch {
      setError('The provider-test acknowledgement was unavailable. Recheck evidence using the same idempotency key before starting another test.');
      setTestUnknown({ body, label: 'AI provider test evidence lookup' });
    } finally { setBusy(false); }
  };

  return <Card>
    <CardHeader><CardTitle>Tenant AI defaults</CardTitle><CardDescription>Choose a supported provider, model and exact active Connector revision. Provider base URL and write-only credentials live in that Connector revision; this page never reads a secret value. Tests use the selected tenant API key, effective Profile revision and real provider response.</CardDescription></CardHeader>
    <CardContent className='space-y-5'>
      {error && <AlertBanner variant='error' title='Tenant settings unavailable'>{error}</AlertBanner>}
      {notice && <AlertBanner variant='info' title='Tenant configuration status'>{notice}</AlertBanner>}
      {!tenantId && <p role='status'>Select an organization to read tenant defaults.</p>}
      {unknown && <AlertBanner variant='warning' title={`${unknown.label} status is unknown`}><div className='space-y-2'><p>The request may have been recorded. Recheck the exact same idempotency key before creating another revision.</p><Button type='button' variant='outline' disabled={busy} onClick={unknown.retry}>Recheck saved result</Button></div></AlertBanner>}
      {loading && <p role='status'>Loading tenant defaults and revision history…</p>}
      {scopedRead && <>
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
          <div className='rounded border p-3'><p className='text-sm font-medium'>AI effective revision</p><p>{scopedRead.ai.activeRevision ?? 'No published revision'} · provider {scopedRead.effective.ai.provider ?? 'not configured'} · model {scopedRead.effective.ai.model ?? 'not configured'}</p><p className='break-all text-xs'>Runtime snapshot: AI r{scopedRead.effective.aiRevision ?? 'default'} / prompts r{scopedRead.effective.promptRevision ?? 'default'} · {scopedRead.effective.settingsDigest}</p></div>
          <div className='rounded border p-3'><p className='text-sm font-medium'>Provider connection</p><p>{selectedConnector ? connectorName(selectedConnector) : 'Choose an active tenant Connector revision'}</p><p className='break-all text-xs'>{selectedConnector ? `${selectedConnector.credentialConfigured ? 'Managed credential configured' : 'No managed credential reported'} · updated ${new Date(selectedConnector.updatedAt).toLocaleString()} · credential material is never returned.` : 'The protected catalog shows only safe metadata for active revisions in this tenant.'}</p>{session?.role === 'admin' && session.principal.kind === 'platform' && <Link to='/connectors' className='text-sm underline'>Manage provider endpoint and credential</Link>}</div>
        </div>
        {connectorIssue && <AlertBanner variant='warning' title='Tenant Connector picker unavailable'>{connectorIssue}</AlertBanner>}
        <fieldset disabled={busy || Boolean(unknown)} className='space-y-3 rounded border p-3'>
          <legend className='px-1 text-sm font-semibold'>Draft AI defaults</legend>
          <div className='grid grid-cols-1 gap-3 md:grid-cols-3'>
            <label className='block text-sm'>Provider<select className='mt-1 block w-full min-w-0 rounded border p-2' value={aiDraft.provider} onChange={(event) => { const provider = event.target.value as TenantAiDefaults['provider']; setAiDraft((current) => ({ ...current, provider, connectorId: null, connectorRevision: null })); setAiDirty(true); setTestResult(null); }}><option value='gemini'>Google Gemini</option><option value='openai-compatible'>OpenAI compatible</option></select></label>
            <label className='block text-sm'>Model<input className='mt-1 block w-full min-w-0 rounded border p-2' value={aiDraft.model} maxLength={128} onChange={(event) => { setAiDraft((current) => ({ ...current, model: event.target.value })); setAiDirty(true); setTestResult(null); }} placeholder={aiDraft.provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini'} /></label>
            <div className='min-w-0 text-sm'><label htmlFor='tenant-ai-connector-search'>Search active tenant Connector revisions on the server</label><input id='tenant-ai-connector-search' type='search' className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={128} value={connectorSearch} onChange={(event) => { setConnectorSearch(event.target.value); setAiDraft((current) => ({ ...current, connectorId: null, connectorRevision: null })); setAiDirty(true); setTestResult(null); }} placeholder='Connector name, provider or model' /><label className='mt-2 block'>Active tenant Connector revision<select className='mt-1 block w-full min-w-0 rounded border p-2' value={aiDraft.connectorId && aiDraft.connectorRevision !== null ? `${aiDraft.connectorId}@${aiDraft.connectorRevision}` : ''} onChange={(event) => { const selected = matchingConnectors.find((item) => `${item.connectorId}@${item.revision}` === event.target.value); setAiDraft((current) => ({ ...current, connectorId: selected?.connectorId ?? null, connectorRevision: selected?.revision ?? null })); setAiDirty(true); setTestResult(null); }}>
              <option value=''>{connectorLoading ? 'Loading available connections…' : 'Choose a connection'}</option>
              {aiDraft.connectorId && aiDraft.connectorRevision !== null && !selectedConnector && <option value={`${aiDraft.connectorId}@${aiDraft.connectorRevision}`} disabled>Saved exact pin is outside this page; search or load the matching active revision</option>}
              {connectorOptions.map((item) => <option key={`${item.connectorId}@${item.revision}`} value={`${item.connectorId}@${item.revision}`}>{connectorName(item)} · {item.credentialConfigured ? 'credential configured' : 'no credential'}</option>)}
            </select></label><div className='mt-1 flex flex-wrap items-center justify-between gap-2 text-xs'><span>{connectorLoading ? 'Loading a protected tenant page…' : `${matchingConnectors.length} compatible revision(s) loaded in this page; ${tenantConnectors.length} active tenant revision(s) loaded.`}</span>{connectorCursor && <Button type='button' variant='outline' disabled={connectorLoading || busy || Boolean(unknown)} onClick={() => { if (tenantId) { setConnectorLoading(true); void requestConnectorPage(connectorSearch.trim(), connectorCursor, true, tenantId, connectorRequestGeneration.current); } }}>Load next Connector page</Button>}</div></div>
          </div>
          <p className='text-xs'>Only active revisions owned by the selected tenant are listed. Provider/model/base URL/credentials are pinned for new requests; old operations keep their snapshot.</p>
          {matchingConnectors.length === 0 && connectorCursor === null && !connectorLoading && !connectorIssue && <p role='status' className='text-sm'>No active {aiDraft.provider} connection matched this server search for the selected tenant. {session?.role === 'admin' && session.principal.kind === 'platform' ? <>Create or activate one in <Link to='/connectors' className='underline'>Connectors</Link>.</> : 'Ask a platform Admin to configure and activate a compatible tenant Connector revision.'}</p>}
          <label className='block text-sm'>Change reason<input className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <div className='flex flex-wrap gap-2'><Button type='button' disabled={!canWrite || !aiDirty || !aiDraft.model.trim() || !selectedConnector || !reason.trim()} onClick={() => createAiDraft()}>{busy ? 'Saving…' : 'Save AI draft'}</Button><Button type='button' variant='outline' disabled={busy || !aiDirty} onClick={() => { setAiDraft(scopedRead.ai.draft?.settings ?? activeAi?.settings ?? DEFAULT_AI); setAiDirty(false); }}>Discard local AI edits</Button></div>
          {aiDirty && <p role='status' className='text-sm'>Unsaved AI changes are held only in this page until a draft is saved.</p>}
          {aiDiff.length > 0 && <details><summary className='cursor-pointer text-sm font-medium'>Review AI diff against current revision ({aiDiff.length} fields)</summary><dl className='mt-2 grid grid-cols-1 gap-2 text-sm md:grid-cols-[max-content_1fr_1fr]'>{aiDiff.map((change) => <div key={change.name} className='contents'><dt className='font-medium'>{change.name}</dt><dd className='break-all rounded bg-muted p-2'>{change.before}</dd><dd className='break-all rounded bg-muted p-2'>{change.after}</dd></div>)}</dl></details>}
        </fieldset>

        <section className='space-y-3 rounded border p-3' aria-labelledby='tenant-ai-test-heading'>
          <div><h3 id='tenant-ai-test-heading' className='font-semibold'>Test an AI draft</h3><p className='text-xs'>This calls the upstream provider through the exact Connector revision with normal tenant, API-key, Profile and budget checks. Success requires a durable provider response and usage receipt. UNKNOWN is resolved with the same request key.</p></div>
      <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
            <p className='break-all text-sm md:col-span-2'>Test target: {apiKeyId ? 'the active API key selected below' : 'no API key selected'} · {endpointSlug || 'no endpoint selected'} · effective Profile {configuration?.profile ? `revision ${configuration.profile.revision}` : 'unavailable'}.</p>
            <p className='md:col-span-2 text-xs'>The test uses the active API key and endpoint selected in the scoped configuration editor below; change them there before testing.</p>
            <label className='block text-sm md:col-span-2'>Provider test prompt<textarea className='mt-1 block min-h-24 w-full rounded border p-2' value={testPrompt} maxLength={32_000} onChange={(event) => setTestPrompt(event.target.value)} disabled={busy || Boolean(testUnknown)} /></label>
            <label className='block text-sm md:col-span-2'>Test files (up to four)<input className='mt-1 block w-full min-w-0 rounded border p-2' type='file' multiple disabled={busy || Boolean(testUnknown)} onChange={(event) => { const files = Array.from(event.target.files ?? []).slice(0, 4); setTestFiles(files); setError(files.length < (event.target.files?.length ?? 0) ? 'The test accepts up to four files.' : null); }} /><span className='mt-1 block text-xs'>Files are uploaded through the tenant artifact route under the selected key; artifact IDs are never typed or pasted.</span></label>
            <fieldset disabled={busy || Boolean(testUnknown)} className='space-y-2 rounded border p-3 md:col-span-2'><legend className='px-1 text-sm font-medium'>Typed test parameters</legend>
              <p className='text-xs'>Optional action parameters are entered as simple values; credential, authorization and arbitrary URL fields are rejected. The provider test still uses the selected Profile and request admission checks.</p>
              {testParameters.map((parameter, index) => <div key={`parameter-${index}`} className='grid min-w-0 grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(8rem,1fr)_8rem_minmax(8rem,2fr)_auto]'>
                <label className='block min-w-0 text-xs'>Name<input className='mt-1 block w-full min-w-0 rounded border p-2 text-sm' maxLength={128} value={parameter.name} onChange={(event) => setTestParameters((rows) => rows.map((row, position) => position === index ? { ...row, name: event.target.value } : row))} /></label>
                <label className='block text-xs'>Type<select className='mt-1 block w-full rounded border p-2 text-sm' value={parameter.kind} onChange={(event) => setTestParameters((rows) => rows.map((row, position) => position === index ? { ...row, kind: event.target.value as AiTestParameter['kind'], value: event.target.value === 'boolean' ? 'false' : '' } : row))}><option value='string'>Text</option><option value='number'>Number</option><option value='boolean'>Boolean</option></select></label>
                <label className='block min-w-0 text-xs'>Value{parameter.kind === 'boolean' ? <select className='mt-1 block w-full min-w-0 rounded border p-2 text-sm' value={parameter.value} onChange={(event) => setTestParameters((rows) => rows.map((row, position) => position === index ? { ...row, value: event.target.value } : row))}><option value='true'>True</option><option value='false'>False</option></select> : <input className='mt-1 block w-full min-w-0 rounded border p-2 text-sm' type={parameter.kind === 'number' ? 'number' : 'text'} value={parameter.value} maxLength={8192} onChange={(event) => setTestParameters((rows) => rows.map((row, position) => position === index ? { ...row, value: event.target.value } : row))} />}</label>
                <Button type='button' variant='outline' aria-label={`Remove test parameter ${index + 1}`} onClick={() => setTestParameters((rows) => rows.filter((_, position) => position !== index))}>Remove</Button>
              </div>)}
              <Button type='button' variant='outline' disabled={testParameters.length >= 16} onClick={() => setTestParameters((rows) => [...rows, { name: '', kind: 'string', value: '' }])}>Add parameter</Button>
            </fieldset>
          </div>
          {testResult && <div role='status' className='rounded border p-3'><div className='flex flex-wrap items-center gap-2'><strong>Provider test revision {testResult.revision}</strong><Badge variant={testResult.ok ? 'success' : testResult.errorCode === 'PROVIDER_TEST_UNKNOWN' ? 'warning' : 'neutral'}>{testResult.ok ? 'UPSTREAM RESPONSE RECEIVED' : testResult.errorCode === 'PROVIDER_TEST_UNKNOWN' ? 'UNKNOWN' : 'FAILED'}</Badge></div><p className='text-sm'>Tested {new Date(testResult.testedAt).toLocaleString()} · {testResult.errorCode ?? (testResult.ok ? 'durable provider response and usage receipt' : 'provider test failed')}</p></div>}
          {aiDirty && <p role='status' className='text-sm'>Save the changed AI values as a new draft before testing. The provider test always targets the exact saved revision, never unsaved local edits.</p>}
          {testUnknown && <AlertBanner variant='warning' title='Provider test acknowledgement is unknown'><p>Recheck the saved result using this same idempotency key. The form stays locked until that evidence resolves.</p><Button type='button' variant='outline' disabled={busy} onClick={() => void runAiTest(testUnknown.body)}>Check saved provider evidence</Button></AlertBanner>}
          <Button type='button' disabled={!testEnabled || !scopedRead.ai.draft || scopedRead.ai.draft.state === 'PUBLISHED' || scopedRead.ai.draft.state === 'SUPERSEDED'} onClick={() => void runAiTest()}>{busy ? 'Calling provider…' : `Run actual provider test for revision ${scopedRead.ai.draft?.revision ?? '—'}`}</Button>
          {scopedRead.ai.draft && <div className='flex flex-wrap items-center gap-2'><Badge variant={scopedRead.ai.draft.state === 'TESTED' ? 'success' : 'warning'}>Draft {scopedRead.ai.draft.revision} · {scopedRead.ai.draft.state}</Badge><Button type='button' disabled={!canWrite || scopedRead.ai.draft.state !== 'TESTED'} onClick={() => publish('ai')}>Publish tested AI revision</Button></div>}
        </section>

        <RevisionHistory items={scopedRead.ai.history} active={scopedRead.ai.activeRevision} disabled={!canWrite} onRollback={(revision) => setRollbackChoice({ stream: 'ai', revision })} />
        {rollbackChoice?.stream === 'ai' && <div role='group' className='rounded border p-3'><p>Restore AI revision {rollbackChoice.revision} as a new active revision? The current Connector revision must still be available.</p><div className='flex flex-wrap gap-2'><Button type='button' disabled={!canWrite} onClick={() => rollback('ai', rollbackChoice.revision)}>Confirm AI rollback</Button><Button type='button' variant='outline' disabled={busy} onClick={() => setRollbackChoice(null)}>Cancel</Button></div></div>}

        <PromptSettingsEditor
          read={scopedRead}
          value={promptDraft}
          dirty={promptDirty}
          busy={busy || Boolean(unknown)}
          canWrite={canWrite}
          issues={promptValidation}
          diff={promptDiff}
          onChange={(key, value) => { setPromptDraft((current) => ({ ...current, [key]: value })); setPromptDirty(true); }}
          onPreset={(locale) => { setPromptDraft(PROMPT_PRESETS[locale]); setPromptDirty(true); }}
          onSave={() => createPromptDraft()}
          onDiscard={() => { setPromptDraft(completePrompts(scopedRead.prompts.draft?.settings ?? activePrompts?.settings ?? scopedRead.effective.prompts)); setPromptDirty(false); }}
          onPublish={() => publish('prompts')}
          onRollback={(revision) => setRollbackChoice({ stream: 'prompts', revision })}
        />
        {rollbackChoice?.stream === 'prompts' && <div role='group' className='rounded border p-3'><p>Restore prompt revision {rollbackChoice.revision} as a new active revision? The prior revision remains available in history.</p><div className='flex flex-wrap gap-2'><Button type='button' disabled={!canWrite} onClick={() => rollback('prompts', rollbackChoice.revision)}>Confirm prompt rollback</Button><Button type='button' variant='outline' disabled={busy} onClick={() => setRollbackChoice(null)}>Cancel</Button></div></div>}
        <p className='text-xs'>Current runtime snapshot is shown above. Publishing changes defaults resolved for new requests; existing operations retain the prompt and AI revisions pinned at admission.</p>
      </>}
      <div className='flex flex-wrap items-center gap-2'><Button type='button' variant='outline' disabled={!tenantId || loading || busy || Boolean(unknown)} onClick={() => void load(true)}>Reload tenant defaults</Button>{scopedRead && <Badge variant={scopedRead.capability.editable ? 'success' : 'warning'}>{scopedRead.capability.editable ? 'Metadata encryption ready' : scopedRead.capability.reasonCode ?? 'Read only'}</Badge>}</div>
    </CardContent>
  </Card>;
}

function PromptSettingsEditor({ read, value, dirty, busy, canWrite, issues, diff, onChange, onPreset, onSave, onDiscard, onPublish, onRollback }: {
  read: TenantGlobalSettingsRead;
  value: TenantPromptDefaults;
  dirty: boolean;
  busy: boolean;
  canWrite: boolean;
  issues: string[];
  diff: Array<{ name: string; before: string; after: string }>;
  onChange: (key: keyof TenantPromptDefaults, value: string) => void;
  onPreset: (locale: PromptLocale) => void;
  onSave: () => void;
  onDiscard: () => void;
  onPublish: () => void;
  onRollback: (revision: number) => void;
}) {
  const draft = read.prompts.draft;
  const active = activeRevision(read.prompts.history, read.prompts.activeRevision);
  return <section className='space-y-4 border-t pt-4' aria-labelledby='tenant-prompt-defaults-heading'>
    <div className='flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between'><div><h2 id='tenant-prompt-defaults-heading' className='text-lg font-semibold'>Prompt defaults</h2><p className='text-sm'>Five separate tenant defaults. Presets change this unsaved form only. Explicit Profile and Code overrides keep their documented precedence.</p></div>
      <label className='block text-sm'>Apply preset to draft<select className='mt-1 block w-full min-w-0 rounded border p-2 sm:w-52' defaultValue='' disabled={busy} onChange={(event) => { if (event.target.value === 'en' || event.target.value === 'vi') onPreset(event.target.value); event.currentTarget.value = ''; }}><option value=''>Choose English or Vietnamese</option><option value='en'>English</option><option value='vi'>Tiếng Việt</option></select></label>
    </div>
    <p className='text-xs'>Required placeholders: compare uses <code>{'{file1}'}</code> and <code>{'{file2}'}</code>; generate uses <code>{'{user_prompt}'}</code> and <code>{'{input_content}'}</code>. Image, PDF and DOCX slots have no required template variables.</p>
    <div className='grid grid-cols-1 gap-3 xl:grid-cols-2'>
      {(['image', 'pdf', 'docx', 'compare', 'generate'] as const).map((key) => <label key={key} className='block min-w-0 text-sm font-medium'>{({ image: 'Image processing', pdf: 'PDF conversion', docx: 'DOCX conversion', compare: 'Document comparison', generate: 'Document generation' })[key]}<textarea className='mt-1 block min-h-40 w-full min-w-0 rounded border p-2 font-mono text-xs leading-5' maxLength={32_768} value={value[key]} onChange={(event) => onChange(key, event.target.value)} disabled={busy || !canWrite} /></label>)}
    </div>
    {issues.length > 0 && <AlertBanner variant='error' title='Prompt draft needs correction'><ul className='list-disc pl-5'>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></AlertBanner>}
    {diff.length > 0 && <details><summary className='cursor-pointer text-sm font-medium'>Review prompt diff against active revision ({diff.length} slots)</summary><div className='mt-2 space-y-3'>{diff.map((item) => <div key={item.name} className='grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2'><h3 className='font-medium lg:col-span-2'>{item.name}</h3><pre className='max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs'>{item.before}</pre><pre className='max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs'>{item.after}</pre></div>)}</div></details>}
    <div className='flex flex-wrap gap-2'><Button type='button' disabled={!canWrite || !dirty || issues.length > 0} onClick={onSave}>Save prompt draft</Button><Button type='button' variant='outline' disabled={busy || !dirty} onClick={onDiscard}>Discard local prompt edits</Button><Button type='button' disabled={!canWrite || !draft || issues.length > 0 || draft.state === 'PUBLISHED' || draft.state === 'SUPERSEDED'} onClick={onPublish}>Publish prompt draft</Button></div>
    {dirty && <p role='status' className='text-sm'>Unsaved prompt changes are held only in this page until saved as a revision.</p>}
    <RevisionHistory items={read.prompts.history} active={read.prompts.activeRevision} disabled={!canWrite} onRollback={onRollback} />
    <p className='text-xs'>Prompt revisions validate the exact required placeholders at save and publish. There is no provider call in this prompt stream; provider tests run separately in the AI section.</p>
    <p className='text-xs'>Active prompt revision: {active?.revision ?? 'defaults only'} · current API-key scoped prompt overrides are managed below.</p>
  </section>;
}

export function PlatformRetentionPanel({ session }: { session: AdminWebSession | null }) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [read, setRead] = useState<PlatformRetentionRead | null>(null);
  const [draft, setDraft] = useState(DEFAULT_RETENTION);
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState('Update platform retention policy');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<UnknownAction | null>(null);
  const [rollback, setRollback] = useState<number | null>(null);
  const requestGeneration = useRef(0);
  const platformAdmin = session?.role === 'admin' && session.principal.kind === 'platform';

  const load = async (): Promise<void> => {
    const generation = ++requestGeneration.current;
    setLoading(true); setError(null);
    try {
      const response = await client.getPlatformRetention();
      if (generation !== requestGeneration.current) return;
      if (!response.ok) { setRead(null); setError(problemText(response)); return; }
      setRead(response.data);
      if (!dirty) setDraft(response.data.draft?.settings ?? response.data.effective);
    } catch { if (generation === requestGeneration.current) { setRead(null); setError('Platform retention settings could not be reached.'); } }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  };
  useEffect(() => {
    setRead(null); setDirty(false); setUnknown(null);
    if (platformAdmin) void load();
    else { setLoading(false); setError(null); }
    return () => { requestGeneration.current++; };
    // Session authorization is checked before requesting platform-only data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, platformAdmin]);

  const perform = async <T,>(label: string, request: () => Promise<AdminApiResult<T>>, onSuccess: (data: T) => void, retrying = false): Promise<void> => {
    if (!platformAdmin || !read || busy || (unknown && !retrying)) return;
    setBusy(true); setError(null); setNotice(null); setUnknown(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(problemText(response));
        if (isUncertain(response)) setUnknown({ label, retry: () => { void perform(label, request, onSuccess, true); } });
        return;
      }
      onSuccess(response.data);
    } catch { setError(`${label} response is unavailable. Recheck the same request before making another change.`); setUnknown({ label, retry: () => { void perform(label, request, onSuccess, true); } }); }
    finally { setBusy(false); }
  };

  const saveDraft = (): void => {
    if (!read || !reason.trim()) return;
    const body: PlatformRetentionDraftRequest = { expectedActiveRevision: read.activeRevision, sourceRevision: read.draft?.revision ?? read.activeRevision, settings: draft, idempotencyKey: keyForRequest(), reason: reason.trim() };
    void perform('Retention draft save', () => client.createRetentionDraft(body), () => { setNotice('Retention draft saved. Review the exact values before publishing.'); setDirty(false); void load(); });
  };
  const publishDraft = (): void => {
    if (!read?.draft) return;
    const body: GlobalSettingsPublishRequest = { draftRevision: read.draft.revision, expectedActiveRevision: read.activeRevision, idempotencyKey: keyForRequest(), reason: reason.trim() || 'Publish platform retention policy' };
    void perform('Retention publish', () => client.publishRetentionRevision(body), () => { setNotice(`Retention revision ${body.draftRevision} published.`); void load(); });
  };
  const restore = (targetRevision: number): void => {
    if (!read) return;
    const body: GlobalSettingsRollbackRequest = { targetRevision, expectedActiveRevision: read.activeRevision, idempotencyKey: keyForRequest(), reason: reason.trim() || `Restore retention revision ${targetRevision}` };
    void perform('Retention rollback', () => client.rollbackRetentionRevision(body), () => { setNotice(`Retention revision ${targetRevision} restored as a new active revision.`); setRollback(null); void load(); });
  };

  const retentionValid = Number.isInteger(draft.cacheTtlHours) && draft.cacheTtlHours >= 0 && draft.cacheTtlHours <= 87600
    && Number.isInteger(draft.outputRetentionDays) && draft.outputRetentionDays >= 0 && draft.outputRetentionDays <= 3650
    && Number.isInteger(draft.cleanupIntervalSeconds) && draft.cleanupIntervalSeconds >= 0 && draft.cleanupIntervalSeconds <= 31536000;

  return <Card>
    <CardHeader><CardTitle>Platform retention policy</CardTitle><CardDescription>Changes are revisioned and platform-scoped. Cache eligibility, output retention and cleanup schedule are separate values. Presigned upload URL lifetime remains a storage-generation setting.</CardDescription></CardHeader>
    <CardContent className='space-y-4'>
      {error && <AlertBanner variant='error' title='Retention request failed'>{error}</AlertBanner>}{notice && <AlertBanner variant='info' title='Retention status'>{notice}</AlertBanner>}
      {!platformAdmin && <AlertBanner variant='warning' title='Platform Admin access required'>Retention policy is visible only to a platform Admin. The server verifies role and CSRF on every command.</AlertBanner>}
      {unknown && <AlertBanner variant='warning' title={`${unknown.label} status is unknown`}><div className='space-y-2'><p>Recheck the same idempotent request before submitting a new revision.</p><Button type='button' variant='outline' disabled={busy} onClick={unknown.retry}>Recheck saved result</Button></div></AlertBanner>}
      {loading && <p role='status'>Loading platform retention…</p>}
      {read && <>
        <div className='rounded border p-3 text-sm'>Effective revision {read.activeRevision} · cache TTL {read.effective.cacheTtlHours} hours · output retention {read.effective.outputRetentionDays} days · cleanup every {read.effective.cleanupIntervalSeconds} seconds.</div>
        <fieldset disabled={!platformAdmin || busy || Boolean(unknown)} className='grid grid-cols-1 gap-3 rounded border p-3 md:grid-cols-3'>
          <legend className='px-1 text-sm font-semibold'>Retention draft</legend>
          <label className='block text-sm'>Cache TTL (hours)<input className='mt-1 block w-full min-w-0 rounded border p-2' type='number' min={0} max={87600} value={draft.cacheTtlHours} onChange={(event) => { setDraft((current) => ({ ...current, cacheTtlHours: Number(event.target.value) })); setDirty(true); }} /></label>
          <label className='block text-sm'>Output retention (days)<input className='mt-1 block w-full min-w-0 rounded border p-2' type='number' min={0} max={3650} value={draft.outputRetentionDays} onChange={(event) => { setDraft((current) => ({ ...current, outputRetentionDays: Number(event.target.value) })); setDirty(true); }} /></label>
          <label className='block text-sm'>Cleanup interval (seconds)<input className='mt-1 block w-full min-w-0 rounded border p-2' type='number' min={0} max={31536000} value={draft.cleanupIntervalSeconds} onChange={(event) => { setDraft((current) => ({ ...current, cleanupIntervalSeconds: Number(event.target.value) })); setDirty(true); }} /></label>
          <label className='block text-sm md:col-span-3'>Change reason<input className='mt-1 block w-full min-w-0 rounded border p-2' maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <div className='flex flex-wrap gap-2 md:col-span-3'><Button type='button' disabled={!platformAdmin || !dirty || !retentionValid || busy || Boolean(unknown) || !reason.trim()} onClick={saveDraft}>Save retention draft</Button><Button type='button' disabled={!platformAdmin || !read.draft || busy || Boolean(unknown)} onClick={publishDraft}>Publish retention draft</Button><Button type='button' variant='outline' disabled={!dirty || busy} onClick={() => { setDraft(read.draft?.settings ?? read.effective); setDirty(false); }}>Discard local edits</Button></div>
          {!retentionValid && <p className='text-sm text-red-700 md:col-span-3' role='alert'>Values must be whole numbers within the displayed minimum and maximum.</p>}
        </fieldset>
        {read.draft && <div className='rounded border p-3 text-sm'><Badge variant='warning'>DRAFT · revision {read.draft.revision}</Badge><p className='mt-2'>Cache {read.draft.settings.cacheTtlHours}h · outputs {read.draft.settings.outputRetentionDays}d · cleanup {read.draft.settings.cleanupIntervalSeconds}s</p><p className='text-xs'>Published revision remains {read.activeRevision} until the draft is published.</p></div>}
        <RevisionHistory items={read.history.map((item) => ({ ...item, actor: item.actor }))} active={read.activeRevision} disabled={!platformAdmin || busy || Boolean(unknown)} onRollback={setRollback} />
        {rollback !== null && <div role='group' className='rounded border p-3'><p>Restore retention revision {rollback} as a new active revision?</p><div className='flex flex-wrap gap-2'><Button type='button' disabled={!platformAdmin || busy || Boolean(unknown)} onClick={() => restore(rollback)}>Confirm retention rollback</Button><Button type='button' variant='outline' disabled={busy} onClick={() => setRollback(null)}>Cancel</Button></div></div>}
      </>}
      <Button type='button' variant='outline' disabled={!platformAdmin || loading || busy || Boolean(unknown)} onClick={() => void load()}>Reload retention</Button>
    </CardContent>
  </Card>;
}
