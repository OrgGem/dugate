import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TablePagination, TableRow } from '@/components/ui/table';
import { TabsList, TabsPanel, TabsRoot, TabsTab } from '@/components/ui/tabs';
import { createAdminApiClient, type AdminWebSession, type ApiKeyRow, type ConnectorManagementRevision } from '@/lib/api';
import { loadActiveKeys } from '@/lib/api/active-keys';
import { useTenant } from '@/lib/tenant-context';
import { MigrationReadiness } from './migration-readiness';
import { ConfigurationRevisions, type EffectiveConfiguration, type RevisionCommand } from './configuration-revisions';
import { PlatformRetentionPanel, TenantAiSettingsPanel } from './global-tenant-settings';
import { StorageGenerationPanel } from './storage-generation-panel';
import { parseConnectorList } from '@/features/connectors/state';
import { SETTINGS_GROUPS, settingsRowsByGroup, settingsWriteReason } from './state';
import { CORE_ENDPOINT_GROUPS, isCoreEndpointSlug } from './endpoints';
import { isLegacyConnectionId, settingsResponseMatchesScope, settingsScopeKey, type SettingsScope } from './scope';
import { EFFECTIVE_STORAGE_FIELDS, safeStorageValue } from './safe-display';

type PromptRow = { connectionId: string; apiKeyId: string; endpointSlug: string; stepId: string; promptOverride: string | null; updatedAt: string };
type ConnectionPin = { slot: string; connectionId: string; revision: number };
type EditorDraft = {
  connectionId: string;
  prompt: string;
  expectedUpdatedAt: string | null;
  promptIncluded: boolean;
  bindingChanges: Record<string, { connectorId: string; revision: number }>;
};

const EMPTY_EDITOR_DRAFT: EditorDraft = {
  connectionId: '',
  prompt: '',
  expectedUpdatedAt: null,
  promptIncluded: false,
  bindingChanges: {},
};
const DEFAULT_ENDPOINT = 'extract:invoice';

function connectionLabel(pin: ConnectionPin, connectors: ConnectorManagementRevision[]): string {
  const revision = connectors.find((item) => item.connectorId === pin.connectionId && item.revision === pin.revision);
  return `${pin.slot} · ${revision?.adapter ?? 'connector'} · revision ${pin.revision} · ${pin.connectionId}`;
}

function canUseConnector(connector: ConnectorManagementRevision, tenantId: string | null): boolean {
  return connector.state === 'ACTIVE' && (connector.tenantId == null || connector.tenantId === tenantId);
}

export function SettingsScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const { tenantId } = useTenant();
  const [view, setView] = useState<Record<string, unknown> | null>(null);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const requestId = useRef(0);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorManagementRevision[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(true);
  const [connectorProblem, setConnectorProblem] = useState<string | null>(null);
  const [editorDraft, setEditorDraftState] = useState<EditorDraft>(EMPTY_EDITOR_DRAFT);
  const editorDrafts = useRef<Record<string, EditorDraft>>({});
  const [role, setRole] = useState<AdminWebSession['role'] | null>(null);
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [roleProblem, setRoleProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [baseLoading, setBaseLoading] = useState(false);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const mutationLock = useRef(false);
  const [apiKeyId, setApiKeyId] = useState('');
  const [endpointSlug, setEndpointSlug] = useState(DEFAULT_ENDPOINT);

  const tenantRef = useRef(tenantId);
  tenantRef.current = tenantId;
  const activeScope: SettingsScope = { tenantId: tenantId ?? null, apiKeyId, endpointSlug };
  const activeScopeKey = settingsScopeKey(activeScope);
  const activeScopeKeyRef = useRef(activeScopeKey);
  activeScopeKeyRef.current = activeScopeKey;
  const loading = baseLoading || scopeLoading;

  const loadSettings = async (target: SettingsScope, scoped = false, revision?: number) => {
    const sequence = ++requestId.current;
    setLoadedScopeKey(null);
    setBaseLoading(!scoped);
    setScopeLoading(scoped);
    setError(null);
    try {
      const result = await client.getSettings({
        ...(target.tenantId ? { tenantId: target.tenantId } : {}),
        ...(scoped ? { apiKeyId: target.apiKeyId, endpointSlug: target.endpointSlug } : {}),
        ...(revision === undefined ? {} : { revision: String(revision) }),
      });
      if (sequence !== requestId.current || tenantRef.current !== target.tenantId) return;
      if (!result.ok) {
        setError(result.problem.title ?? 'Settings unavailable');
        if (scoped) setLoadedScopeKey(null);
        return;
      }
      if (!settingsResponseMatchesScope(result.data, target)) {
        setError('The settings response did not match the selected organization, key and endpoint. Reload this scope before editing.');
        if (scoped) setLoadedScopeKey(null);
        return;
      }
      setView(result.data);
      setLoadedScopeKey(scoped ? settingsScopeKey(target) : null);
    } catch {
      if (sequence === requestId.current && tenantRef.current === target.tenantId) {
        setError('Settings could not be reached');
        if (scoped) setLoadedScopeKey(null);
      }
    } finally {
      if (sequence === requestId.current) {
        setBaseLoading(false);
        setScopeLoading(false);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    setConnectors([]);
    setConnectorsLoading(true);
    setConnectorProblem(null);
    void client.listConnectors().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setConnectorProblem('Connector revision catalog unavailable. Open Connectors to inspect permissions and configuration.');
        return;
      }
      const parsed = parseConnectorList(result.data);
      if (parsed) setConnectors(parsed.items);
      else setConnectorProblem('Connector revision catalog could not be read.');
    }).catch(() => {
      if (!cancelled) setConnectorProblem('Connector revision catalog could not be reached.');
    }).finally(() => {
      if (!cancelled) setConnectorsLoading(false);
    });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    setRole(null);
    setSession(null);
    setRoleProblem(null);
    void client.getSession().then((result) => {
      if (cancelled) return;
      if (result.ok) { setSession(result.data); setRole(result.data.role); }
      else { setSession(null); setRoleProblem('Session permissions could not be confirmed. Settings changes are disabled.'); }
    }).catch(() => {
      if (!cancelled) { setSession(null); setRoleProblem('Session permissions could not be confirmed. Settings changes are disabled.'); }
    });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    requestId.current++;
    setView(null);
    setLoadedScopeKey(null);
    setBaseLoading(false);
    setScopeLoading(false);
    setApiKeyId('');
    setEndpointSlug(DEFAULT_ENDPOINT);
    setEditorDraftState(EMPTY_EDITOR_DRAFT);
    setKeys([]);
    setKeysLoading(false);
    setKeyProblem(null);
    setError(null);
    setNotice(null);
    const target: SettingsScope = { tenantId: tenantId ?? null, apiKeyId: '', endpointSlug: '' };
    void loadSettings(target);
    if (tenantId) {
      setKeysLoading(true);
      void loadActiveKeys(client, tenantId, () => cancelled).then((rows) => {
        if (!cancelled && tenantRef.current === tenantId) setKeys(rows);
      }).catch((cause: unknown) => {
        if (!cancelled && tenantRef.current === tenantId) setKeyProblem(cause instanceof Error ? cause.message : 'API keys could not be loaded.');
      }).finally(() => {
        if (!cancelled) setKeysLoading(false);
      });
    }
    return () => {
      cancelled = true;
      requestId.current++;
    };
  }, [client, tenantId]);

  const switchScope = (nextApiKeyId: string, nextEndpointSlug: string) => {
    const nextScope: SettingsScope = { tenantId: tenantId ?? null, apiKeyId: nextApiKeyId, endpointSlug: nextEndpointSlug };
    const nextKey = settingsScopeKey(nextScope);
    if (nextKey === activeScopeKey) return;
    editorDrafts.current[activeScopeKey] = editorDraft;
    const restoredDraft = editorDrafts.current[nextKey] ?? EMPTY_EDITOR_DRAFT;
    requestId.current++;
    setLoadedScopeKey(null);
    setBaseLoading(false);
    setScopeLoading(false);
    setView((current) => current ? { ...current, promptOverrides: [], availableConnections: [], configuration: undefined } : null);
    setError(null);
    setNotice(editorDraft.promptIncluded || editorDraft.prompt.length > 0 || Object.keys(editorDraft.bindingChanges).length > 0
      ? 'Your unsaved editor changes are kept in this browser for the previous key and endpoint.'
      : null);
    setApiKeyId(nextApiKeyId);
    setEndpointSlug(nextEndpointSlug);
    setEditorDraftState(restoredDraft);
  };

  const updateEditorDraft = (change: (draft: EditorDraft) => EditorDraft) => {
    const next = change(editorDraft);
    editorDrafts.current[activeScopeKey] = next;
    setEditorDraftState(next);
  };

  const scopeReady = Boolean(tenantId && apiKeyId && isCoreEndpointSlug(endpointSlug) && loadedScopeKey === activeScopeKey);
  const configuration = scopeReady ? view?.configuration as EffectiveConfiguration | undefined : undefined;
  const storage = view?.storage as Record<string, unknown> | undefined;
  const caps = view?.capabilities as Record<string, boolean> | undefined;
  const rows = scopeReady ? (view?.promptOverrides ?? []) as PromptRow[] : [];
  const pins = scopeReady ? (view?.availableConnections ?? []) as ConnectionPin[] : [];
  const canEdit = role === 'admin' && caps?.configurationEditable === true && scopeReady;
  const canEditPrompt = canEdit && caps?.promptOverridesEditable === true;
  const connectorChoices = connectors.filter((connector) => canUseConnector(connector, tenantId));
  const editorHasChanges = editorDraft.promptIncluded || Object.keys(editorDraft.bindingChanges).length > 0;
  const editorHasLocalContent = editorHasChanges || editorDraft.prompt.length > 0;

  const beginMutation = (target: SettingsScope): { sequence: number; key: string } | null => {
    const key = settingsScopeKey(target);
    if (mutationLock.current) return null;
    if (!scopeReady || activeScopeKeyRef.current !== key || !canEdit) {
      setError('Reload the selected scope and confirm administrator permission before changing settings.');
      return null;
    }
    mutationLock.current = true;
    setMutating(true);
    setError(null);
    setNotice(null);
    return { sequence: ++requestId.current, key };
  };

  const isCurrentMutation = (started: { sequence: number; key: string }): boolean =>
    started.sequence === requestId.current && activeScopeKeyRef.current === started.key;

  const finishMutation = () => {
    mutationLock.current = false;
    setMutating(false);
  };

  const save = async () => {
    if (!tenantId || !configuration || !scopeReady || !canEdit || !editorHasChanges) return;
    if (!isCoreEndpointSlug(endpointSlug)) {
      setError('Choose one of the supported core document endpoints before creating a draft.');
      return;
    }
    if (editorDraft.promptIncluded && !isLegacyConnectionId(editorDraft.connectionId)) {
      setError('This prompt target needs a legacy connection UUID mapping. No draft was created.');
      return;
    }
    const target: SettingsScope = { tenantId, apiKeyId, endpointSlug };
    const started = beginMutation(target);
    if (!started) return;
    try {
      const changes = {
        ...(editorDraft.promptIncluded ? { prompts: [{ connectionId: editorDraft.connectionId, stepId: '_default', promptOverride: editorDraft.prompt || null }] } : {}),
        ...(Object.keys(editorDraft.bindingChanges).length ? { connectorBindings: { ...configuration.profile?.connectorBindings, ...editorDraft.bindingChanges } } : {}),
      };
      const result = await client.postAction('settings.revision.create', {
        tenantId,
        apiKeyId,
        endpointSlug,
        expectedActiveRevision: configuration.activeRevision,
        expectedProfileRevision: configuration.profile?.revision,
        changes,
      }, { idempotencyKey: crypto.randomUUID() });
      if (!isCurrentMutation(started)) return;
      if (!result.ok) {
        setError(`${result.problem.title ?? 'Draft creation failed'}${result.status === 409 ? ' The profile or settings revision changed. Reload and inspect the current scope before retrying.' : ''}`);
        return;
      }
      setNotice('Draft created. Review its diff, validate it, then apply if the dependencies are still current. Runtime configuration has not changed.');
      editorDrafts.current[started.key] = EMPTY_EDITOR_DRAFT;
      setEditorDraftState(EMPTY_EDITOR_DRAFT);
      await loadSettings(target, true, typeof result.data.revision === 'number' ? result.data.revision : undefined);
    } catch {
      if (isCurrentMutation(started)) setError('Draft response unavailable. The request may have been recorded; reload this scope before retrying.');
    } finally {
      finishMutation();
    }
  };

  const revisionCommand = async (command: RevisionCommand, revision: number) => {
    if (!tenantId || !configuration || !scopeReady || !canEdit) return;
    const target: SettingsScope = { tenantId, apiKeyId, endpointSlug };
    const started = beginMutation(target);
    if (!started) return;
    try {
      const result = await client.postAction(`settings.revision.${command}`, {
        tenantId,
        apiKeyId,
        endpointSlug,
        revision,
        ...(command === 'validate' ? {} : { expectedActiveRevision: configuration.activeRevision }),
      }, { idempotencyKey: crypto.randomUUID() });
      if (!isCurrentMutation(started)) return;
      if (!result.ok) {
        setError(`${result.problem.title ?? 'Configuration action failed'}${result.status === 409 ? ' Reload the scope and inspect the new revision before retrying.' : ''}`);
        return;
      }
      setNotice(command === 'validate'
        ? 'Validation finished. Review the dependency checks below; no provider request was sent.'
        : `${command === 'rollback' ? 'Prior configuration restored as a new revision' : 'Configuration applied'}. Only new submissions use these values.`);
      await loadSettings(target, true, typeof result.data.revision === 'number' ? result.data.revision : revision);
    } catch {
      if (isCurrentMutation(started)) setError('Configuration response unavailable. Reload this scope to check its revision before retrying.');
    } finally {
      finishMutation();
    }
  };

  const selectedKey = keys.find((key) => key.id === apiKeyId);
  const profile = configuration?.profile;

  return <section className='flex flex-col gap-5 min-w-0' aria-labelledby='settings-title'>
    <h1 id='settings-title' className='text-lg font-semibold'>Settings &amp; Deployment</h1>
    {error && <AlertBanner variant='error' title='Settings request failed'>{error}</AlertBanner>}
    {notice && <AlertBanner variant='info' title='Configuration status'>{notice}</AlertBanner>}

    <TabsRoot defaultValue='overview' className='min-w-0'>
      <TabsList aria-label='Settings workspaces'>
        <TabsTab value='overview'>Overview</TabsTab>
        <TabsTab value='scoped-configuration'>Scoped configuration</TabsTab>
        <TabsTab value='ai-prompts'>AI &amp; prompts</TabsTab>
        <TabsTab value='storage-retention'>Storage &amp; retention</TabsTab>
        <TabsTab value='migration-reference'>Migration &amp; reference</TabsTab>
      </TabsList>

      <TabsPanel value='overview' keepMounted className='space-y-4'>

    <Card>
      <CardHeader>
        <CardTitle>Effective deployment</CardTitle>
        <CardDescription>Read-only values reported by the running orchestrator. Storage generation changes are staged, tested and activated through the controls below.</CardDescription>
      </CardHeader>
      <CardContent>
        {storage ? <dl className='grid grid-cols-1 gap-2 text-sm sm:grid-cols-2'>
          {EFFECTIVE_STORAGE_FIELDS.map((key) => <div key={key} className='min-w-0'>
            <dt className='font-medium'>{key}</dt>
            <dd className='break-all'>{safeStorageValue(key, storage[key])}</dd>
          </div>)}
        </dl> : <div className='space-y-2'>
          <p role={loading ? 'status' : undefined}>{loading ? 'Loading effective configuration…' : 'Effective configuration unavailable. Refresh to retry.'}</p>
          {!loading && <Button type='button' variant='outline' onClick={() => void loadSettings({ tenantId: tenantId ?? null, apiKeyId: '', endpointSlug: '' })}>Reload effective deployment</Button>}
        </div>}
        {caps && <div className='mt-3 flex flex-wrap gap-2'>{Object.entries(caps).map(([key, value]) => <Badge key={key} variant={value ? 'info' : 'warning'}>
          {({ metadataEncryptionConfigured: 'Metadata encryption', connectorManagementConfigured: 'Connector management', credentialManagementConfigured: 'Credential management', promptOverridesEditable: 'Prompt editing', configurationEditable: 'Configuration revision editing' } as Record<string, string>)[key] ?? key}: {value ? 'configured' : 'not configured'}
        </Badge>)}</div>}
        <p className='mt-3 text-sm'>Configured capability does not prove provider health. Test the selected connection in <Link to='/connectors' className='underline'>Connectors</Link>. Storage and retention show their effective and tested revisions in the Storage &amp; retention tab.</p>
      </CardContent>
    </Card>

      </TabsPanel>

      <TabsPanel value='scoped-configuration' keepMounted className='space-y-4'>

    <Card>
      <CardHeader>
        <CardTitle>Scoped configuration editor</CardTitle>
        <CardDescription>Choose a tenant API key and one supported core endpoint. Prompt overrides target the pinned connection fallback `_default`; exact-step overrides stay read-only. Connector changes select an existing revision. Everything first becomes an immutable draft.</CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        {!tenantId && <p role='status'>Select an organization before loading or editing configuration.</p>}
        <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
          <label htmlFor='settings-api-key' className='block text-sm'>API key
            <select id='settings-api-key' className='mt-1 block w-full min-w-0 rounded border p-2' value={apiKeyId} disabled={!tenantId || keysLoading || loading || mutating} onChange={(event) => switchScope(event.target.value, endpointSlug)}>
              <option value=''>{keysLoading ? 'Loading active API keys…' : 'Choose an active API key'}</option>
              {keys.map((key) => <option key={key.id} value={key.id}>{key.name ?? key.prefix} · {key.maskedHint}</option>)}
            </select>
          </label>
          <label htmlFor='settings-endpoint' className='block text-sm'>Core endpoint
            <select id='settings-endpoint' className='mt-1 block w-full min-w-0 rounded border p-2' value={endpointSlug} disabled={loading || mutating} onChange={(event) => switchScope(apiKeyId, event.target.value)}>
              {Object.entries(CORE_ENDPOINT_GROUPS).map(([action, variants]) => <optgroup key={action} label={action}>
                {variants.map((variant) => {
                  const slug = `${action}:${variant}`;
                  return <option key={slug} value={slug}>{slug}</option>;
                })}
              </optgroup>)}
            </select>
          </label>
        </div>
        <p className='text-xs'>The selector lists all supported core endpoints. Workflow prompts use workflow/profile revisions and are not accepted by this editor.</p>
        {keyProblem && <AlertBanner variant='error' title='API keys unavailable'>{keyProblem}</AlertBanner>}
        {!tenantId && <p className='text-sm'>A tenant scope is required for key-specific settings.</p>}
        {tenantId && keys.length === 0 && !keysLoading && !keyProblem && <p className='text-sm'>No active API keys are available for this organization.</p>}
        {role === null
          ? <p className='text-sm' role='status'>{roleProblem ?? 'Checking session permissions… Configuration mutations remain disabled until authorization is confirmed.'}</p>
          : <p className='text-sm'>Session role: <strong>{role}</strong>. {role === 'admin' ? 'Administrator permission is required for draft, validation, apply and restore actions.' : 'This role can inspect settings; configuration mutations require an administrator.'}</p>}
        {roleProblem && role !== null && <p className='text-sm text-red-700'>{roleProblem}</p>}
        {selectedKey && tenantId && <div className='rounded border p-3 text-sm' aria-live='polite'>
          <h3 className='font-semibold'>Selected effective scope</h3>
          <p className='break-all'>{selectedKey.name ?? selectedKey.prefix} · {selectedKey.maskedHint} · {endpointSlug}</p>
          {scopeReady && profile
            ? <><p className='break-all'>Effective profile {profile.profileId} · revision {profile.revision} · {profile.activeKeyCount} active key(s)</p>
              <p className='text-xs'>This is the active profile resolved for the selected endpoint. Connector changes may require a dedicated endpoint profile assigned to one active key.</p>
              <Link to='/profiles?businessId=document-core' className='underline'>Inspect effective profile and business bindings</Link>
            </>
            : <p role={scopeLoading ? 'status' : undefined}>{scopeLoading ? 'Loading the effective profile and pinned connector revisions…' : 'Load this scope to inspect its effective profile and pinned connector revisions.'}</p>}
        </div>}
        <div className='flex flex-wrap items-center gap-2'>
          <Button disabled={loading || mutating || !tenantId || !apiKeyId || !isCoreEndpointSlug(endpointSlug)} onClick={() => void loadSettings(activeScope, true)}>Load current configuration</Button>
          {scopeLoading && <span role='status' className='text-sm'>Loading the selected key and endpoint…</span>}
        </div>

        {scopeReady && !profile && <p role='status' className='text-sm'>No enabled document-core profile resolves for this key and endpoint. Review the key’s <Link to='/profiles?businessId=document-core' className='underline'>profile mapping</Link> before creating a configuration revision.</p>}
        {scopeReady && profile && <section className='space-y-3' aria-labelledby='prompt-overrides-title'>
          <div>
            <h3 id='prompt-overrides-title' className='font-semibold'>Prompt overrides</h3>
            <p className='text-xs'>The editor writes only `_default` fallback rows through the immutable settings revision workflow. Code-provided prompts and exact-step rows can take precedence.</p>
          </div>
          {rows.length === 0 && <p className='text-sm'>No prompt overrides are recorded for this API key and endpoint.</p>}
          {rows.length > 0 && <ul className='space-y-2'>
            {rows.map((row) => {
              const pin = pins.find((candidate) => candidate.connectionId === row.connectionId);
              const target = pin ? connectionLabel(pin, connectors) : `Unmapped connection ${row.connectionId}`;
              const label = `${target} · ${row.stepId}`;
              const editable = row.stepId === '_default' && isLegacyConnectionId(row.connectionId);
              return <li key={`${row.connectionId}:${row.stepId}`} className='flex flex-wrap items-center justify-between gap-2 rounded border p-2'>
                <span className='min-w-0 break-all text-sm'>{label}{row.stepId !== '_default' ? ' · exact step (read-only)' : ''}</span>
                <Button type='button' variant='outline' disabled={!editable || loading || mutating || !canEditPrompt} title={editable ? (canEditPrompt ? 'Edit this connection fallback prompt' : 'Prompt editing requires an administrator and configured metadata encryption') : 'Exact-step overrides and unmapped connection IDs are read-only here'} aria-label={`Edit ${label} prompt`} onClick={() => updateEditorDraft((current) => ({ ...current, connectionId: row.connectionId, prompt: row.promptOverride ?? '', expectedUpdatedAt: row.updatedAt, promptIncluded: true }))}>Edit fallback</Button>
              </li>;
            })}
          </ul>}
          <label htmlFor='settings-prompt-target' className='block text-sm'>Pinned connection for `_default` prompt
            <select id='settings-prompt-target' className='mt-1 block w-full min-w-0 rounded border p-2' value={editorDraft.connectionId} disabled={loading || mutating || !canEditPrompt} onChange={(event) => updateEditorDraft((current) => ({ ...current, connectionId: event.target.value, prompt: '', expectedUpdatedAt: null, promptIncluded: false }))}>
              <option value=''>Choose a pinned connection</option>
              {pins.map((pin) => <option key={pin.slot} value={pin.connectionId} disabled={!isLegacyConnectionId(pin.connectionId)}>{connectionLabel(pin, connectors)}{isLegacyConnectionId(pin.connectionId) ? '' : ' · legacy UUID mapping required'}</option>)}
            </select>
          </label>
          {editorDraft.connectionId && !isLegacyConnectionId(editorDraft.connectionId) && <p className='text-sm'>This scoped prompt editor accepts only legacy connection targets with a UUID mapping. Manage tenant-wide five-slot prompts above; inspect managed Connector revisions in <Link to='/connectors' className='underline'>Connectors</Link>.</p>}
          {editorDraft.connectionId && isLegacyConnectionId(editorDraft.connectionId) && <p className='text-xs'>Target: {(() => {
            const selectedPin = pins.find((pin) => pin.connectionId === editorDraft.connectionId);
            return selectedPin ? connectionLabel(selectedPin, connectors) : `Unmapped connection ${editorDraft.connectionId}`;
          })()} · timestamp {editorDraft.expectedUpdatedAt ?? 'new override'}</p>}
          <label htmlFor='settings-prompt' className='block text-sm'>Fallback prompt
            <textarea id='settings-prompt' className='mt-1 block min-h-32 w-full rounded border p-2' maxLength={32768} disabled={loading || mutating || !canEditPrompt || !isLegacyConnectionId(editorDraft.connectionId)} value={editorDraft.prompt} onChange={(event) => updateEditorDraft((current) => ({ ...current, prompt: event.target.value, promptIncluded: true }))} />
          </label>
          <label className='flex items-start gap-2 text-sm'><input type='checkbox' className='mt-1' checked={editorDraft.promptIncluded} disabled={loading || mutating || !canEditPrompt || !isLegacyConnectionId(editorDraft.connectionId)} onChange={(event) => updateEditorDraft((current) => ({ ...current, promptIncluded: event.target.checked }))} />Include this prompt change in the next configuration draft. An empty value clears the fallback.</label>
          {profile && <fieldset className='space-y-3 rounded border p-3'>
            <legend className='px-1 text-sm font-semibold'>Connector revision pins</legend>
            <p className='text-xs'>The active profile has {profile.activeKeyCount} active key(s). Pin edits require exactly one active key and an exact endpoint profile; validation checks both. Credential values are never edited here.</p>
            {connectorProblem && <AlertBanner variant='error' title='Connector catalog unavailable'>{connectorProblem}</AlertBanner>}
            {connectorsLoading && <p role='status' className='text-sm'>Loading active connector revisions…</p>}
            {Object.entries(profile.connectorBindings).map(([slot, pin]) => <div key={slot} className='space-y-1'>
              <label htmlFor={`settings-connector-${encodeURIComponent(slot)}`} className='block text-sm'>{slot}
                <select id={`settings-connector-${encodeURIComponent(slot)}`} className='mt-1 block w-full min-w-0 rounded border p-2' value={JSON.stringify(editorDraft.bindingChanges[slot] ?? pin)} disabled={loading || mutating || !canEdit || !caps?.connectorManagementConfigured || profile.activeKeyCount !== 1 || connectorsLoading} onChange={(event) => {
                  const parsed = JSON.parse(event.target.value) as { connectorId: string; revision: number };
                  updateEditorDraft((current) => {
                    const changes = { ...current.bindingChanges };
                    if (parsed.connectorId === pin.connectorId && parsed.revision === pin.revision) delete changes[slot];
                    else changes[slot] = parsed;
                    return { ...current, bindingChanges: changes };
                  });
                }}>
                  <option value={JSON.stringify(pin)}>{connectionLabel({ slot, connectionId: pin.connectorId, revision: pin.revision }, connectors)} (current)</option>
                  {connectorChoices.filter((connector) => connector.connectorId !== pin.connectorId || connector.revision !== pin.revision).map((connector) => {
                    const value = { connectorId: connector.connectorId, revision: connector.revision };
                    return <option key={`${connector.connectorId}:${connector.revision}`} value={JSON.stringify(value)}>{connector.connectorId} · revision {connector.revision} · {connector.adapter}</option>;
                  })}
                </select>
              </label>
              <Link className='text-xs underline' to={`/connectors?connectorId=${encodeURIComponent(pin.connectorId)}&revision=${pin.revision}`}>Inspect current connector revision</Link>
            </div>)}
            {!caps?.connectorManagementConfigured && <p className='text-sm'>Connector revision selection is unavailable until connector management is configured.</p>}
            {!connectorsLoading && !connectorProblem && connectorChoices.length === 0 && <p className='text-sm'>No active global or selected-tenant connector revisions are available.</p>}
            {profile.activeKeyCount !== 1 && <p className='text-sm'>Connector pin edits are disabled because this profile is shared. Use <Link to='/profiles?businessId=document-core' className='underline'>Profiles</Link> to make a dedicated endpoint profile first.</p>}
            {profile.activeKeyCount === 1 && <p className='text-xs'>If this profile is action-wide rather than endpoint-specific, validation blocks pin changes. Manage the exact endpoint binding in <Link to='/profiles?businessId=document-core' className='underline'>Profiles</Link>.</p>}
          </fieldset>}
          {editorHasLocalContent && <p role='status' className='text-sm'>Unsubmitted editor content is held in memory for this organization, key and endpoint. It is not a server draft until you create one.</p>}
          <Button type='button' disabled={loading || mutating || !canEdit || !editorHasChanges || (editorDraft.promptIncluded && !isLegacyConnectionId(editorDraft.connectionId)) || (Object.keys(editorDraft.bindingChanges).length > 0 && (!caps?.connectorManagementConfigured || profile?.activeKeyCount !== 1))} onClick={() => void save()}>{mutating ? 'Creating draft…' : 'Create configuration draft'}</Button>
          {!canEdit && <p className='text-sm'>Draft creation is read-only until an administrator session, metadata encryption and the current tenant/key/endpoint scope are confirmed.</p>}
        </section>}

        {!scopeReady && tenantId && apiKeyId && <p role={scopeLoading ? 'status' : undefined} className='text-sm'>{scopeLoading ? 'Loading this scope…' : 'Load current configuration to see the effective profile, prompt targets and revision history for this key and endpoint.'}</p>}
      </CardContent>
    </Card>

    {configuration && <ConfigurationRevisions configuration={configuration} scopeLabel={`${selectedKey?.name ?? selectedKey?.prefix ?? apiKeyId} · ${endpointSlug}`} busy={loading || mutating} canEdit={canEdit} onSelect={(revision) => void loadSettings(activeScope, true, revision)} onCommand={(command, revision) => void revisionCommand(command, revision)} />}
      </TabsPanel>

      <TabsPanel value='ai-prompts' keepMounted className='space-y-4'>
        <TenantAiSettingsPanel tenantId={tenantId ?? null} session={session} apiKeyId={apiKeyId} endpointSlug={endpointSlug} configuration={configuration} />
      </TabsPanel>

      <TabsPanel value='storage-retention' keepMounted className='space-y-4'>
        <PlatformRetentionPanel session={session} />
        <StorageGenerationPanel session={session} tenantId={tenantId ?? null} />
      </TabsPanel>

      <TabsPanel value='migration-reference' keepMounted className='space-y-4'>
        <MigrationReadiness tenantId={tenantId} />
        {SETTINGS_GROUPS.map((group) => <SettingsCatalogCard key={group.id} group={group} />)}
      </TabsPanel>
    </TabsRoot>
  </section>;
}

function SettingsCatalogCard({ group }: { group: (typeof SETTINGS_GROUPS)[number] }) {
  const rows = settingsRowsByGroup(group.id);
  const pageSize = 8;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const start = rows.length === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(rows.length, (page + 1) * pageSize);
  const visibleRows = rows.slice(page * pageSize, (page + 1) * pageSize);

  useEffect(() => {
    if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  return <Card>
    <CardHeader><CardTitle>{group.title}</CardTitle><CardDescription>{group.blurb}</CardDescription></CardHeader>
    <CardContent className='space-y-3'>
      <TableContainer maxHeight={320} aria-label={`${group.title} catalog`}>
        <Table aria-label={`${group.title} catalog`} density='compact'>
          <TableHeader sticky><TableRow><TableHead>Setting</TableHead><TableHead>Legacy key</TableHead><TableHead>Replacement and scope</TableHead><TableHead>Status and handling</TableHead></TableRow></TableHeader>
          <TableBody>{visibleRows.map((row) => <TableRow key={row.legacyKey}>
            <TableCell className='max-w-64 font-medium'>{row.label}</TableCell>
            <TableCell className='max-w-56 break-all font-mono text-xs'>{row.legacyKey}</TableCell>
            <TableCell className='min-w-48'><span className='block break-words'>{row.replacement}</span><span className='block text-xs text-[var(--text-sub)]'>{row.scope}</span></TableCell>
            <TableCell className='min-w-56 text-xs'>
              <span className='font-medium'>{row.disposition === 'retire' ? 'Retirement planned' : 'Port mapping'}</span>
              {row.disposition === 'retire' ? <span className='mt-1 block'>{settingsWriteReason(row)}</span> : row.secret ? <span className='mt-1 block'>Secret value is write-only; the owning form returns metadata and an opaque revision pin.</span> : null}
            </TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        hasPreviousPage={page > 0}
        hasNextPage={page + 1 < pageCount}
        onPreviousPage={() => setPage((current) => Math.max(0, current - 1))}
        onNextPage={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
        status={`Showing ${start}–${end} of ${rows.length} loaded settings. Page ${page + 1} of ${pageCount}.`}
        ariaLabel={`${group.title} pagination`}
      />
    </CardContent>
  </Card>;
}
