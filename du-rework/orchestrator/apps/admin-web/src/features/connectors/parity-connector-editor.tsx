import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  ConnectorRecipeSchema,
  ProviderTestRequestSchema,
  type ConnectorRecipe,
  type ConnectorParityRevision,
  type ProviderTestResult,
} from '@du/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { AlertBanner, LoadingState } from '@/components/ui/state-panel';
import {
  createAdminApiClient,
  type AdminApiProblem,
  type AdminWebSession,
  type ProfileListRow,
  type ProviderTestRequest,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant-context';
import { createImmutableAttempt, FileArtifactCache, markAttemptDispatched, retainAfterFailure, type ImmutableAttempt } from '@/features/submissions/immutable-attempt';

type ParityConnectorEditorProps = {
  savedAttempt: ImmutableAttempt<ProviderTestRequest> | null;
  onAttemptChange: (attempt: ImmutableAttempt<ProviderTestRequest> | null) => void;
};

type CredentialMode = 'keep' | 'replace' | 'clear' | 'vault-ref';
type ProviderRecipe = ConnectorRecipe;
type MappingField = ProviderRecipe['request']['fields'][number];
type SessionField = ProviderRecipe['session']['capture'][number];
type SelectedProfile = {
  key: string;
  profileId: string;
  businessId: string;
  businessVersion: string;
  profileName: string;
  revision: number;
  action: string;
  endpointSlug: string;
  inputParameters: Record<string, unknown>;
  actions: string[];
  connectorBindings: Record<string, { connectorId: string; revision: number }>;
  availableKeys: Array<{ id: string; label: string }>;
};

const EMPTY_RECIPE: ProviderRecipe = {
  adapter: 'json-http',
  method: 'POST',
  endpointUrl: 'https://api.example.invalid/v1/generate',
  auth: { kind: 'none' },
  headers: [],
  request: { promptField: 'prompt', modelField: 'model', inputField: 'input', fields: [] },
  response: { contentPath: 'content' },
  session: { capture: [], inject: [] },
  timeoutMs: 30_000,
  responseBytes: 262_144,
};

const SECRET_HEADER_NAMES = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key']);
const keyFor = () => globalThis.crypto?.randomUUID?.() ?? `connector-parity-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function profileRowKey(input: { businessId: string; businessVersion: string; profileName: string }): string {
  return JSON.stringify([input.businessId, input.businessVersion, input.profileName]);
}

function localProfileRowKey(input: { profileId: string; action: string; endpointSlug: string | null }): string {
  return JSON.stringify([input.profileId, input.action, input.endpointSlug]);
}

function unwrapParameters(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && Object.hasOwn(entry, 'value')) {
      result[key] = (entry as { value: unknown }).value;
    } else {
      result[key] = entry;
    }
  }
  return result;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function idempotencyKey(): string {
  return keyFor();
}

function errorText(problem: AdminApiProblem): string {
  return `${problem.status} · ${problem.code ?? 'ERROR'}${problem.title ? ` — ${problem.title}` : ''}`;
}

/**
 * CFGADM06/07: typed Connector recipe editing, credential lifecycle and a
 * real signed provider invocation. Advanced JSON round-trips the complete
 * strict recipe; ordinary changes use bounded controls and retain every
 * mapping/session/header row already present in the loaded revision.
 */
export function ParityConnectorEditor({ savedAttempt, onAttemptChange }: ParityConnectorEditorProps) {
  const client = useMemo(() => createAdminApiClient(), []);
  const { tenantId } = useTenant();
  const activeTenantId = useRef(tenantId);
  activeTenantId.current = tenantId;
  const [session, setSession] = useState<AdminWebSession | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profileRows, setProfileRows] = useState<ProfileListRow[]>([]);
  const [localProfiles, setLocalProfiles] = useState<Array<{
    profileId: string;
    tenantId: string;
    businessId: string;
    businessVersion: string;
    profileName: string;
    action: string;
    endpointSlug: string | null;
    revision: number;
    connectorBindings: Record<string, { connectorId: string; revision: number }>;
    parameters: Record<string, unknown>;
  }>>([]);
  const [profileKey, setProfileKey] = useState('');
  const [profileChoice, setProfileChoice] = useState<SelectedProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [apiKeyId, setApiKeyId] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [revisionText, setRevisionText] = useState('');
  const [expectedHeadRevision, setExpectedHeadRevision] = useState(0);
  const [expectedActiveRevision, setExpectedActiveRevision] = useState(0);
  const [loadedRevision, setLoadedRevision] = useState<ConnectorParityRevision | null>(null);
  const [recipe, setRecipe] = useState<ProviderRecipe>(EMPTY_RECIPE);
  const [advancedJson, setAdvancedJson] = useState(jsonText(EMPTY_RECIPE));
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('keep');
  const [credentialValue, setCredentialValue] = useState('');
  const [vaultReference, setVaultReference] = useState('');
  const [bindingSlot, setBindingSlot] = useState('');
  const [prompt, setPrompt] = useState('');
  const [parametersText, setParametersText] = useState('{}');
  const [model, setModel] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [testedPin, setTestedPin] = useState<{ connectorId: string; revision: number } | null>(null);
  const [testAttempt, setTestAttempt] = useState(savedAttempt);
  const [reconcileRequest, setReconcileRequest] = useState<ProviderTestRequest | null>(
    savedAttempt && savedAttempt.state !== 'ACCEPTED' ? savedAttempt.request as ProviderTestRequest : null,
  );
  const uploadedFiles = useRef(new FileArtifactCache<File>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function rememberProviderAttempt(attempt: ImmutableAttempt<ProviderTestRequest> | null): void {
    setTestAttempt(attempt);
    onAttemptChange(attempt);
    setReconcileRequest(attempt && attempt.state !== 'ACCEPTED' ? attempt.request as ProviderTestRequest : null);
  }

  const localUser = session?.localUser === true && session.role === 'operator';
  const platformAdmin = session?.role === 'admin' && session.principal.kind === 'platform';
  const mayRunProviderTest = platformAdmin || localUser;
  const mayManageRecipes = platformAdmin;
  const rowsLoading = !sessionReady || loadingRows;

  const loadProfileChoices = useCallback(async () => {
    if (!tenantId || !session) return;
    setLoadingRows(true);
    setLoadError(null);
    try {
      if (localUser) {
        const all: typeof localProfiles = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let pageNo = 0; pageNo < 100; pageNo += 1) {
          const response = await client.listAssignedProfileEndpoints({ limit: 100, ...(cursor ? { cursor } : {}) });
          if (!response.ok) throw new Error(errorText(response.problem));
          if (response.data.tenantId !== tenantId) throw new Error('Assigned Profile response crossed the selected tenant boundary.');
          all.push(...response.data.items.map((row) => ({
            profileId: row.profileId,
            tenantId: row.tenantId,
            businessId: row.businessId,
            businessVersion: row.businessVersion,
            profileName: row.profileName,
            action: row.action,
            endpointSlug: row.endpointSlug,
            revision: row.revision,
            connectorBindings: row.connectorBindings,
            parameters: unwrapParameters(row.parameters),
          })));
          const next = response.data.nextCursor;
          if (!next) break;
          if (seen.has(next) || next === cursor) throw new Error('Assigned Profile search returned a repeated cursor.');
          seen.add(next);
          cursor = next;
        }
        setLocalProfiles(all);
        setProfileRows([]);
      } else if (platformAdmin) {
        const all: ProfileListRow[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let pageNo = 0; pageNo < 100; pageNo += 1) {
          const response = await client.listProfiles({ tenantId, limit: '250', ...(cursor ? { cursor } : {}) });
          if (!response.ok) throw new Error(errorText(response.problem));
          all.push(...response.data.items);
          const next = response.data.nextCursor;
          if (!next) break;
          if (seen.has(next) || next === cursor) throw new Error('Profile catalog returned a repeated cursor.');
          seen.add(next);
          cursor = next;
        }
        setProfileRows(all.filter((row) => row.status === 'ACTIVE'));
        setLocalProfiles([]);
      }
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Profiles could not be loaded.');
      setProfileRows([]);
      setLocalProfiles([]);
    } finally {
      setLoadingRows(false);
    }
  }, [client, localUser, platformAdmin, session, tenantId]);

  useEffect(() => {
    let live = true;
    void client.getSession().then((response) => {
      if (!live) return;
      setSessionReady(true);
      setSession(response.ok ? response.data : null);
    });
    return () => { live = false; };
  }, [client]);

  useEffect(() => {
    if (!sessionReady || !tenantId || !mayRunProviderTest) {
      setProfileRows([]);
      setLocalProfiles([]);
      setProfileChoice(null);
      return;
    }
    void loadProfileChoices();
  }, [loadProfileChoices, mayRunProviderTest, sessionReady, tenantId]);

  const selectedProfileRow = useMemo(() => profileRows.find((row) => profileRowKey(row) === profileKey) ?? null, [profileKey, profileRows]);
  const selectedLocalProfiles = useMemo(() => localProfiles.filter((row) => localProfileRowKey(row) === profileKey), [localProfiles, profileKey]);

  useEffect(() => {
    let live = true;
    if (!tenantId || !profileKey || !session) {
      setProfileChoice(null);
      setApiKeyId('');
      return;
    }
    setProfileLoading(true);
    setProfileChoice(null);
    setApiKeyId('');
    void (async () => {
      try {
        if (localUser) {
          const endpointRows = selectedLocalProfiles;
          const profile = endpointRows[0];
          if (!profile || profile.tenantId !== tenantId) throw new Error('Select an assigned enabled Profile endpoint.');
          const keyResponse = await client.listAssignedProfileApiKeys(profile.profileId, { limit: 100 });
          if (!keyResponse.ok) throw new Error(errorText(keyResponse.problem));
          if (keyResponse.data.tenantId !== tenantId || keyResponse.data.profileId !== profile.profileId) throw new Error('Assigned key response crossed the Profile scope.');
          const allKeys = keyResponse.data.items.map((key) => ({ id: key.apiKeyId, label: `${key.name ?? 'Assigned API key'} · ${key.prefix}` }));
          const selected: SelectedProfile = {
            key: localProfileRowKey(profile),
            profileId: profile.profileId,
            businessId: profile.businessId,
            businessVersion: profile.businessVersion,
            profileName: profile.profileName,
            revision: profile.revision,
            action: profile.action,
            endpointSlug: profile.endpointSlug ?? profile.action,
            inputParameters: profile.parameters,
            actions: [profile.action],
            connectorBindings: profile.connectorBindings,
            availableKeys: allKeys,
          };
          if (live) {
            setProfileChoice(selected);
            const firstBinding = Object.entries(profile.connectorBindings)[0];
            setBindingSlot(firstBinding?.[0] ?? '');
            if (firstBinding) {
              setConnectorId(firstBinding[1].connectorId);
              setRevisionText(String(firstBinding[1].revision));
            } else {
              setConnectorId(''); setRevisionText('');
            }
            setParametersText(jsonText(profile.parameters));
            setPrompt('');
            setResult((current) => current?.state === 'UNKNOWN' ? current : null);
          }
        } else if (platformAdmin && selectedProfileRow) {
          const [detailResponse, keyResponse] = await Promise.all([
            client.getProfile(selectedProfileRow.businessId, selectedProfileRow.businessVersion, selectedProfileRow.profileName),
            client.listProfileApiKeys(selectedProfileRow.businessId, selectedProfileRow.businessVersion, selectedProfileRow.profileName),
          ]);
          if (!detailResponse.ok) throw new Error(errorText(detailResponse.problem));
          if (!keyResponse.ok) throw new Error(errorText(keyResponse.problem));
          if (keyResponse.data.items.length === 0 && !keyResponse.data.profileId) throw new Error('This Profile has no stored identity or active key assignment.');
          const detail = detailResponse.data;
          const profileId = keyResponse.data.profileId;
          const actions = [...new Set(detail.manifest.actions.map((item) => item.action ?? item.name).filter((value): value is string => Boolean(value)))];
          const selectedAction = actions[0] ?? selectedProfileRow.boundActions[0] ?? '';
          const selected: SelectedProfile = {
            key: profileRowKey(selectedProfileRow),
            profileId,
            businessId: selectedProfileRow.businessId,
            businessVersion: selectedProfileRow.businessVersion,
            profileName: selectedProfileRow.profileName,
            revision: detail.revision,
            action: selectedAction,
            endpointSlug: selectedAction,
            inputParameters: unwrapParameters(detail.policy.parameters),
            actions,
            connectorBindings: detail.connectorBindings,
            availableKeys: keyResponse.data.items.filter((key) => key.status === 'ACTIVE' && key.membershipState === 'ACTIVE').map((key) => ({ id: key.id, label: `${key.name ?? 'API key'} · ${key.prefix}` })),
          };
          if (live) {
            setProfileChoice(selected);
            setBindingSlot(Object.keys(detail.connectorBindings)[0] ?? '');
            setParametersText(jsonText(selected.inputParameters));
            setPrompt('');
            setResult((current) => current?.state === 'UNKNOWN' ? current : null);
          }
        }
      } catch (cause) {
        if (live) setLoadError(cause instanceof Error ? cause.message : 'Profile and key assignments could not be read.');
      } finally {
        if (live) setProfileLoading(false);
      }
    })();
    return () => { live = false; };
  }, [client, localUser, platformAdmin, profileKey, selectedLocalProfiles, selectedProfileRow, session, tenantId]);

  const parsedRecipe = ConnectorRecipeSchema.safeParse(recipe);
  const pendingCandidate = loadedRevision?.state === 'PENDING';
  const selectedAssignedBinding = localUser && profileChoice ? profileChoice.connectorBindings[bindingSlot] : undefined;
  const hasTestTarget = loadedRevision !== null || selectedAssignedBinding !== undefined;
  const testSucceededForCurrentRevision = result?.state === 'SUCCEEDED'
    && loadedRevision !== null
    && testedPin?.connectorId === loadedRevision.connectorId
    && testedPin.revision === loadedRevision.revision;

  function setRecipeValue(update: (current: ProviderRecipe) => ProviderRecipe): void {
    setRecipe((current) => {
      const next = update(current);
      setAdvancedJson(jsonText(next));
      setAdvancedError(null);
      return next;
    });
  }

  async function loadRevision(): Promise<void> {
    if (!tenantId || !connectorId.trim() || !/^\d+$/.test(revisionText)) {
      setError('Choose a tenant, Connector ID and exact revision number.');
      return;
    }
    setError(null); setNotice(null); setBusy(true);
    try {
      const response = await client.getConnectorParityRevision(connectorId.trim(), Number(revisionText), tenantId);
      if (!response.ok) { setError(errorText(response.problem)); return; }
      if (response.data.tenantId !== tenantId || response.data.connectorId !== connectorId.trim()) {
        setError('The Connector response did not match the selected tenant and ID.'); return;
      }
      setLoadedRevision(response.data);
      setRevisionText(String(response.data.revision));
      setExpectedHeadRevision(response.data.expectedHeadRevision);
      setRecipe(response.data.recipe);
      setAdvancedJson(jsonText(response.data.recipe));
      setCredentialMode('keep'); setCredentialValue(''); setVaultReference(''); setResult((current) => current?.state === 'UNKNOWN' ? current : null);
      setNotice(`Loaded ${response.data.connectorId}@${response.data.revision} (${response.data.state}).`);
    } finally { setBusy(false); }
  }

  async function saveDraft(): Promise<void> {
    if (!tenantId || !mayManageRecipes || !parsedRecipe.success) {
      setError(parsedRecipe.success ? 'Platform Admin access and a selected tenant are required.' : parsedRecipe.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    const id = connectorId.trim();
    if (!id) { setError('Connector ID is required.'); return; }
    let credentialChange: { action: 'keep' } | { action: 'replace'; secret: string } | { action: 'clear'; confirm: true } | { action: 'vault-ref'; reference: string };
    if (credentialMode === 'replace') {
      if (!credentialValue) { setError('Enter the replacement credential before saving.'); return; }
      credentialChange = { action: 'replace', secret: credentialValue };
    } else if (credentialMode === 'clear') credentialChange = { action: 'clear', confirm: true };
    else if (credentialMode === 'vault-ref') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(vaultReference.trim())) { setError('Enter the opaque Secret Catalog reference ID (UUID) approved for this tenant and Connector credential slot.'); return; }
      credentialChange = { action: 'vault-ref', reference: vaultReference.trim() };
    } else credentialChange = { action: 'keep' };

    setBusy(true); setError(null); setNotice(null); setResult((current) => current?.state === 'UNKNOWN' ? current : null);
    try {
      const response = await client.upsertConnectorDraft(id, {
        tenantId,
        expectedHeadRevision,
        recipe: parsedRecipe.data,
        credentialChange,
      }, idempotencyKey());
      if (!response.ok) { setError(errorText(response.problem)); return; }
      setLoadedRevision(response.data.revision);
      setRevisionText(String(response.data.revision.revision));
      setExpectedHeadRevision(response.data.expectedHeadRevision);
      setRecipe(response.data.revision.recipe);
      setAdvancedJson(jsonText(response.data.revision.recipe));
      setCredentialMode('keep'); setCredentialValue(''); setVaultReference('');
      setNotice(`${id}@${response.data.revision.revision} saved as PENDING${response.data.replayed ? ' (idempotent replay)' : ''}. Test it before activation.`);
    } finally { setBusy(false); }
  }

  async function createRollbackDraft(): Promise<void> {
    if (!tenantId || !mayManageRecipes || !loadedRevision) return;
    const sourceRevision = Number(revisionText);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) { setError('Select the exact source revision to clone.'); return; }
    setBusy(true); setError(null); setNotice(null); setResult((current) => current?.state === 'UNKNOWN' ? current : null);
    try {
      const response = await client.rollbackConnectorRevision(connectorId.trim(), tenantId, sourceRevision, expectedHeadRevision, idempotencyKey());
      if (!response.ok) { setError(errorText(response.problem)); return; }
      setLoadedRevision(response.data.revision);
      setRevisionText(String(response.data.revision.revision));
      setExpectedHeadRevision(response.data.expectedHeadRevision);
      setRecipe(response.data.revision.recipe);
      setAdvancedJson(jsonText(response.data.revision.recipe));
      setCredentialMode('keep'); setResult((current) => current?.state === 'UNKNOWN' ? current : null);
      setNotice(`Rollback created PENDING revision ${response.data.revision.revision}; test it and activate separately.`);
    } finally { setBusy(false); }
  }

  async function activateDraft(): Promise<void> {
    if (!tenantId || !mayManageRecipes || !loadedRevision || loadedRevision.state !== 'PENDING') return;
    if (!testSucceededForCurrentRevision) { setError('Run a successful actual provider test against this exact draft revision before activation.'); return; }
    if (!Number.isSafeInteger(expectedActiveRevision) || expectedActiveRevision < 0) { setError('Expected current ACTIVE revision must be a non-negative integer.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await client.activateConnectorRevision(connectorId.trim(), loadedRevision.revision, tenantId, expectedActiveRevision, idempotencyKey());
      if (!response.ok) { setError(errorText(response.problem)); return; }
      if (!response.data.activated) { setError(`Activation CAS lost. Current ACTIVE revision is ${response.data.currentRevision ?? 'unknown'}; refresh and review before retrying.`); return; }
      const reread = await client.getConnectorParityRevision(connectorId.trim(), loadedRevision.revision, tenantId);
      if (reread.ok) { setLoadedRevision(reread.data); setRecipe(reread.data.recipe); setAdvancedJson(jsonText(reread.data.recipe)); setExpectedHeadRevision(reread.data.expectedHeadRevision); }
      setNotice(`Revision ${loadedRevision.revision} activated. Profile bindings still require an explicit versioned publish.`);
    } finally { setBusy(false); }
  }

  async function runProviderTest(): Promise<void> {
    if (testAttempt) { setError('Resolve the saved Connector test request before starting another provider invocation. Use its exact source-check/retry action below.'); return; }
    const assignedPin = localUser && profileChoice ? profileChoice.connectorBindings[bindingSlot] : undefined;
    const targetConnectorId = loadedRevision?.connectorId ?? assignedPin?.connectorId ?? connectorId.trim();
    const targetRevision = loadedRevision?.revision ?? assignedPin?.revision ?? Number(revisionText);
    const targetState = loadedRevision?.state ?? (localUser && assignedPin ? 'ACTIVE' : null);
    if (!tenantId || !mayRunProviderTest || !profileChoice || !apiKeyId || !targetConnectorId || !Number.isSafeInteger(targetRevision) || targetRevision < 1 || !targetState) {
      setError('Select an assigned active Profile, API key and exact Connector revision first.'); return;
    }
    if (targetState === 'PENDING' && !platformAdmin) { setError('A PENDING candidate can only be tested by a platform Admin.'); return; }
    if (targetState === 'ACTIVE') {
      const bound = Object.values(profileChoice.connectorBindings).some((item) => item.connectorId === targetConnectorId && item.revision === targetRevision);
      if (!bound) { setError('This ACTIVE revision is not the exact Connector revision bound to the selected Profile.'); return; }
    }
    let parameters: unknown;
    try { parameters = JSON.parse(parametersText); } catch { setError('Test parameters must be valid JSON.'); return; }
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) { setError('Test parameters must be a JSON object.'); return; }
    if (!prompt.trim()) { setError('Enter a provider prompt.'); return; }

    setBusy(true); setError(null); setNotice(null); setResult(null);
    let attempt: ImmutableAttempt<ProviderTestRequest> | null = null;
    let dispatched = false;
    try {
      const artifactIds: string[] = [];
      if (selectedFiles.length > 4) { setError('A provider test accepts at most four tenant-owned files.'); return; }
      for (const file of selectedFiles) {
        if (activeTenantId.current !== tenantId) return;
        const cached = uploadedFiles.current.get(file, tenantId, apiKeyId);
        if (cached) {
          artifactIds.push(cached);
          continue;
        }
        const upload = await client.uploadWorkflowFile(tenantId, apiKeyId, file);
        if (!upload.ok) { if (activeTenantId.current === tenantId) setError(`File ${file.name}: ${errorText(upload.problem)}`); return; }
        if (upload.data.state !== 'READY') { if (activeTenantId.current === tenantId) setError(`File ${file.name} is ${upload.data.state}; only READY tenant-owned files can be tested.`); return; }
        uploadedFiles.current.set(file, tenantId, apiKeyId, upload.data.artifactId);
        if (activeTenantId.current !== tenantId) return;
        artifactIds.push(upload.data.artifactId);
      }
      const bindingSlotCandidate = pendingCandidate ? bindingSlot.trim() : undefined;
      const raw = {
        tenantId,
        apiKeyId,
        profileId: profileChoice.profileId,
        expectedProfileRevision: profileChoice.revision,
        businessId: profileChoice.businessId,
        businessVersion: profileChoice.businessVersion,
        action: profileChoice.action,
        endpointSlug: profileChoice.endpointSlug,
        connectorId: targetConnectorId,
        revision: targetRevision,
        ...(bindingSlotCandidate ? { bindingSlot: bindingSlotCandidate } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        prompt: prompt.trim(),
        parameters,
        artifactIds,
        timeoutMs,
        idempotencyKey: idempotencyKey(),
      };
      const validated = ProviderTestRequestSchema.safeParse(raw);
      if (!validated.success) { setError(validated.error.issues.map((issue) => issue.message).join('; ')); return; }
      attempt = createImmutableAttempt(tenantId, validated.data.idempotencyKey, validated.data);
      rememberProviderAttempt(attempt);
      const dispatchedAttempt = markAttemptDispatched(attempt);
      rememberProviderAttempt(dispatchedAttempt);
      dispatched = true;
      const response = await client.testConnectorRevision(dispatchedAttempt.request as unknown as ProviderTestRequest);
      if (!response.ok) {
        const retained = retainAfterFailure(dispatchedAttempt, response.status);
        rememberProviderAttempt(retained);
        if (activeTenantId.current === tenantId) setError(errorText(response.problem) + (retained ? ' The original request and key remain saved for exact reconciliation.' : ''));
        return;
      }
      if (activeTenantId.current !== tenantId) {
        if (response.data.state === 'UNKNOWN') rememberProviderAttempt(retainAfterFailure(dispatchedAttempt, 500));
        else rememberProviderAttempt(null);
        return;
      }
      setResult(response.data);
      setTestedPin({ connectorId: targetConnectorId, revision: targetRevision });
      if (response.data.state === 'UNKNOWN') rememberProviderAttempt(retainAfterFailure(dispatchedAttempt, 500));
      else rememberProviderAttempt(null);
      if (response.data.state === 'SUCCEEDED') setNotice(`Connector provider call succeeded with status ${response.data.statusCode ?? 'unreported'}; usage event ${response.data.usageEventId ?? 'unreported'}.`);
      else if (response.data.state === 'UNKNOWN') setError('Provider outcome is UNKNOWN. The original idempotency key is retained by the server; retrying this test will reconcile source evidence and will not send another provider request.');
      else setError(`Provider invocation failed${response.data.errorCode ? ` (${response.data.errorCode})` : ''}; no response body is displayed.`);
    } catch (cause) {
      if (dispatched && attempt) rememberProviderAttempt(retainAfterFailure(markAttemptDispatched(attempt), 0));
      if (activeTenantId.current === tenantId) setError(cause instanceof Error ? cause.message : 'The provider-test result is unknown. Use the saved request to reconcile it.');
    } finally { setBusy(false); }
  }

  async function reconcileProviderTest(): Promise<void> {
    if (!reconcileRequest || !testAttempt || testAttempt.tenantId !== tenantId) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      // Same request and idempotency key: the server checks Connector source
      // evidence and never creates a second provider invocation on this path.
      const response = await client.testConnectorRevision(testAttempt.request as unknown as ProviderTestRequest);
      if (!response.ok) {
        const retained = retainAfterFailure(testAttempt, response.status);
        rememberProviderAttempt(retained);
        if (activeTenantId.current === tenantId) setError(errorText(response.problem) + (retained ? ' The original request remains unresolved.' : ''));
        return;
      }
      if (activeTenantId.current !== tenantId) {
        if (response.data.state === 'UNKNOWN') rememberProviderAttempt(retainAfterFailure(testAttempt, 500));
        else rememberProviderAttempt(null);
        return;
      }
      setResult(response.data);
      if (response.data.state === 'UNKNOWN') {
        rememberProviderAttempt(retainAfterFailure(testAttempt, 500));
        setError('The Connector ledger still has no positive recoverable result. The run remains held and no provider retry was sent.');
      } else {
        rememberProviderAttempt(null);
        setNotice(response.data.state === 'SUCCEEDED'
          ? `Source evidence confirmed success; usage event ${response.data.usageEventId ?? 'unreported'}.`
          : `Source reconciliation completed as ${response.data.state}.`);
      }
    } catch (cause) {
      rememberProviderAttempt(retainAfterFailure(testAttempt, 0));
      if (activeTenantId.current === tenantId) setError(cause instanceof Error ? cause.message : 'The source-check result is unknown; the saved request remains available.');
    } finally { setBusy(false); }
  }

  function applyAdvancedJson(): void {
    try {
      const value: unknown = JSON.parse(advancedJson);
      const parsed = ConnectorRecipeSchema.safeParse(value);
      if (!parsed.success) { setAdvancedError(parsed.error.issues.map((issue) => issue.message).join('; ')); return; }
      setRecipe(parsed.data); setAdvancedJson(jsonText(parsed.data)); setAdvancedError(null); setNotice('Advanced recipe import validated; every supported recipe field and mapping is retained.');
    } catch {
      setAdvancedError('Advanced recipe must be valid JSON.');
    }
  }

  function downloadRecipe(): void {
    const blob = new Blob([jsonText(recipe)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${connectorId.trim() || 'connector'}-recipe.json`; link.click();
    URL.revokeObjectURL(url);
  }

  function updateHeader(index: number, patch: Partial<ProviderRecipe['headers'][number]>): void {
    setRecipeValue((current) => ({ ...current, headers: current.headers.map((item, position) => position === index ? { ...item, ...patch } : item) }));
  }
  function updateMapping(index: number, patch: Partial<MappingField>): void {
    setRecipeValue((current) => ({ ...current, request: { ...current.request, fields: current.request.fields.map((item, position) => position === index ? { ...item, ...patch } : item) } }));
  }
  function updateSession(kind: 'capture' | 'inject', index: number, patch: Partial<SessionField>): void {
    setRecipeValue((current) => ({ ...current, session: { ...current.session, [kind]: current.session[kind].map((item, position) => position === index ? { ...item, ...patch } : item) } }));
  }
  function setSelectedProfile(key: string): void {
    setProfileKey(key); setProfileChoice(null); setApiKeyId(''); setLoadError(null); setResult((current) => current?.state === 'UNKNOWN' ? current : null);
  }
  function onFilesChanged(event: ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.currentTarget.files ?? [])];
    setSelectedFiles(files.slice(0, 4));
  }

  if (!sessionReady) return <Card><CardContent className="p-4"><LoadingState title="Checking Connector parity access…" /></CardContent></Card>;

  return (
    <Card id="connector-parity-editor">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Connector recipe and lifecycle</CardTitle>
          <Badge variant={mayManageRecipes ? 'info' : mayRunProviderTest ? 'success' : 'neutral'}>{mayManageRecipes ? 'platform Admin' : mayRunProviderTest ? 'assigned USER test' : 'read-only'}</Badge>
          {loadedRevision ? <Badge variant={loadedRevision.state === 'ACTIVE' ? 'success' : 'warning'}>{loadedRevision.state} · rev {loadedRevision.revision}</Badge> : null}
        </div>
        <CardDescription>
          Create and edit a typed provider recipe, stage credentials without reading them back, invoke the exact Connector revision through the signed Connector runtime, then activate with compare-and-swap. A test never publishes a revision.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!tenantId ? <AlertBanner variant="warning" title="Choose a tenant">Select a tenant before reading or mutating tenant-owned Connector revisions.</AlertBanner> : null}
        {!mayManageRecipes && !mayRunProviderTest ? <AlertBanner variant="warning" title="Admin or assigned local USER access required">Recipe management is platform Admin only. A validated local USER can run tests only against the exact ACTIVE revision in an assigned Profile; all calls are checked again by the server.</AlertBanner> : null}
        {error ? <AlertBanner variant="error" title="Connector parity action failed">{error}</AlertBanner> : null}
        {notice ? <AlertBanner variant="success" title="Connector parity status">{notice}</AlertBanner> : null}
        {loadError ? <AlertBanner variant="error" title="Profile/key assignments unavailable">{loadError}</AlertBanner> : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <FormField id="parity-connector-id" label="Connector ID" description="Create with a new stable ID or load an existing chain.">
            <Input id="parity-connector-id" value={connectorId} onChange={(event) => setConnectorId(event.target.value)} maxLength={128} placeholder="provider-text" disabled={busy} />
          </FormField>
          <FormField id="parity-connector-revision" label="Exact revision" description="Load a persisted recipe revision by number.">
            <Input id="parity-connector-revision" inputMode="numeric" value={revisionText} onChange={(event) => setRevisionText(event.target.value)} placeholder="1" disabled={busy} />
          </FormField>
          <div className="flex items-end gap-2"><Button variant="outline" disabled={!tenantId || busy || !connectorId.trim() || !revisionText.trim()} onClick={() => void loadRevision()}>Load revision</Button><Button variant="outline" disabled={busy} onClick={downloadRecipe}>Export recipe</Button></div>
        </div>

        <section aria-labelledby="recipe-editor-title" className="flex flex-col gap-4 border-t border-[var(--border-subtle)] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 id="recipe-editor-title" className="font-semibold">Provider recipe</h3><p className="text-xs text-[var(--text-sub)]">Structured fields cover normal provider setup. Advanced JSON import/export retains all typed mappings and session rules.</p></div>
            <NativeSelect aria-label="Provider recipe preset" value={recipe.adapter} disabled={busy || !mayManageRecipes} onChange={(event) => {
              const adapter = event.currentTarget.value as ProviderRecipe['adapter'];
              setRecipeValue((current) => ({ ...current, adapter,
                endpointUrl: adapter === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent' : adapter === 'openai-compatible' ? 'https://api.example.invalid/v1/chat/completions' : current.endpointUrl,
                method: 'POST',
                request: { ...current.request, promptField: adapter === 'gemini' ? 'contents' : adapter === 'openai-compatible' ? 'messages' : current.request.promptField },
              }));
            }}><option value="json-http">JSON HTTP</option><option value="multipart-http">Multipart HTTP</option><option value="openai-compatible">OpenAI compatible</option><option value="gemini">Gemini</option></NativeSelect>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FormField id="recipe-endpoint" label="Provider endpoint URL" description="The Connector enforces its configured egress policy at invocation time."><Input id="recipe-endpoint" value={recipe.endpointUrl} onChange={(event) => setRecipeValue((current) => ({ ...current, endpointUrl: event.target.value }))} maxLength={2048} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="recipe-method" label="HTTP method"><NativeSelect id="recipe-method" value={recipe.method} disabled={busy || !mayManageRecipes} onChange={(event) => setRecipeValue((current) => ({ ...current, method: event.currentTarget.value as ProviderRecipe['method'] }))}><option value="POST">POST</option><option value="PUT">PUT</option></NativeSelect></FormField>
            <FormField id="recipe-timeout" label="Provider timeout (ms)"><Input id="recipe-timeout" type="number" min={100} max={60000} value={recipe.timeoutMs} onChange={(event) => setRecipeValue((current) => ({ ...current, timeoutMs: Number(event.target.value) }))} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="recipe-response-bytes" label="Response byte limit"><Input id="recipe-response-bytes" type="number" min={1024} max={2000000} value={recipe.responseBytes} onChange={(event) => setRecipeValue((current) => ({ ...current, responseBytes: Number(event.target.value) }))} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="recipe-prompt-field" label="Prompt field"><Input id="recipe-prompt-field" value={recipe.request.promptField} maxLength={128} onChange={(event) => setRecipeValue((current) => ({ ...current, request: { ...current.request, promptField: event.target.value } }))} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="recipe-model-field" label="Model field"><Input id="recipe-model-field" value={recipe.request.modelField ?? ''} maxLength={128} onChange={(event) => setRecipeValue((current) => ({ ...current, request: { ...current.request, modelField: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes} placeholder="model" /></FormField>
            <FormField id="recipe-input-field" label="Structured input field"><Input id="recipe-input-field" value={recipe.request.inputField ?? ''} maxLength={128} onChange={(event) => setRecipeValue((current) => ({ ...current, request: { ...current.request, inputField: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes} placeholder="input" /></FormField>
            <FormField id="recipe-file-field" label="Multipart file field"><Input id="recipe-file-field" value={recipe.request.fileField ?? ''} maxLength={128} onChange={(event) => setRecipeValue((current) => ({ ...current, request: { ...current.request, fileField: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes || recipe.adapter !== 'multipart-http'} placeholder={recipe.adapter === 'multipart-http' ? 'files' : 'select multipart preset'} /></FormField>
            <FormField id="recipe-filename-field" label="Multipart filename field"><Input id="recipe-filename-field" value={recipe.request.fileNameField ?? ''} maxLength={128} onChange={(event) => setRecipeValue((current) => ({ ...current, request: { ...current.request, fileNameField: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes || recipe.adapter !== 'multipart-http'} placeholder="fileName" /></FormField>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FormField id="recipe-auth-kind" label="Authentication method"><NativeSelect id="recipe-auth-kind" value={recipe.auth.kind} disabled={busy || !mayManageRecipes} onChange={(event) => {
              const kind = event.currentTarget.value as ProviderRecipe['auth']['kind'];
              setRecipeValue((current) => ({ ...current, auth: kind === 'none' ? { kind } : kind === 'api-key-header' ? { kind, headerName: 'x-api-key', secretSlot: 'api-key' } : kind === 'bearer' ? { kind, secretSlot: 'bearer-token' } : kind === 'basic' ? { kind, usernameSlot: 'username', passwordSlot: 'password' } : { kind, tokenUrl: 'https://auth.example.invalid/oauth/token', clientId: '', clientSecretSlot: 'client-secret', scopes: [] } }));
            }}><option value="none">No credential</option><option value="api-key-header">API key header</option><option value="bearer">Bearer token</option><option value="basic">Basic username/password</option><option value="oauth2-client-credentials">OAuth2 client credentials</option></NativeSelect></FormField>
            {recipe.auth.kind === 'api-key-header' ? <><FormField id="recipe-auth-header" label="Credential header name"><Input id="recipe-auth-header" value={recipe.auth.headerName} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'api-key-header' ? { ...current, auth: { ...current.auth, headerName: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField><FormField id="recipe-auth-slot" label="Secret slot label"><Input id="recipe-auth-slot" value={recipe.auth.secretSlot} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'api-key-header' ? { ...current, auth: { ...current.auth, secretSlot: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField></> : null}
            {recipe.auth.kind === 'bearer' ? <FormField id="recipe-bearer-slot" label="Bearer token slot label"><Input id="recipe-bearer-slot" value={recipe.auth.secretSlot} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'bearer' ? { ...current, auth: { ...current.auth, secretSlot: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField> : null}
            {recipe.auth.kind === 'basic' ? <><FormField id="recipe-basic-user-slot" label="Username slot label"><Input id="recipe-basic-user-slot" value={recipe.auth.usernameSlot} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'basic' ? { ...current, auth: { ...current.auth, usernameSlot: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField><FormField id="recipe-basic-password-slot" label="Password slot label"><Input id="recipe-basic-password-slot" value={recipe.auth.passwordSlot} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'basic' ? { ...current, auth: { ...current.auth, passwordSlot: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField></> : null}
            {recipe.auth.kind === 'oauth2-client-credentials' ? <><FormField id="recipe-oauth-token-url" label="OAuth token URL"><Input id="recipe-oauth-token-url" value={recipe.auth.tokenUrl} maxLength={2048} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'oauth2-client-credentials' ? { ...current, auth: { ...current.auth, tokenUrl: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField><FormField id="recipe-oauth-client-id" label="OAuth client ID"><Input id="recipe-oauth-client-id" value={recipe.auth.clientId} maxLength={256} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'oauth2-client-credentials' ? { ...current, auth: { ...current.auth, clientId: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField><FormField id="recipe-oauth-secret-slot" label="OAuth client secret slot"><Input id="recipe-oauth-secret-slot" value={recipe.auth.clientSecretSlot} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'oauth2-client-credentials' ? { ...current, auth: { ...current.auth, clientSecretSlot: event.target.value } } : current)} disabled={busy || !mayManageRecipes} /></FormField><FormField id="recipe-oauth-scopes" label="OAuth scopes (space separated)"><Input id="recipe-oauth-scopes" value={recipe.auth.scopes.join(' ')} onChange={(event) => setRecipeValue((current) => current.auth.kind === 'oauth2-client-credentials' ? { ...current, auth: { ...current.auth, scopes: event.target.value.split(/\s+/).filter(Boolean).slice(0, 32) } } : current)} disabled={busy || !mayManageRecipes} /></FormField></> : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">Request mappings</h4><Button size="sm" variant="outline" disabled={busy || !mayManageRecipes || recipe.request.fields.length >= 128} onClick={() => setRecipeValue((current) => ({ ...current, request: { ...current.request, fields: [...current.request.fields, { name: '', source: 'input' }] } }))}>Add mapping</Button></div>
            {recipe.request.fields.map((field, index) => <div key={`mapping-${index}`} className="grid grid-cols-1 gap-2 rounded border border-[var(--border-subtle)] p-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <FormField id={`mapping-name-${index}`} label="Request field"><Input id={`mapping-name-${index}`} value={field.name} onChange={(event) => updateMapping(index, { name: event.target.value })} disabled={busy || !mayManageRecipes} /></FormField>
              <FormField id={`mapping-source-${index}`} label="Value source"><NativeSelect id={`mapping-source-${index}`} value={field.source} disabled={busy || !mayManageRecipes} onChange={(event) => {
                const source = event.currentTarget.value as MappingField['source'];
                const next: Partial<MappingField> = { source };
                if (source === 'static') next.value = typeof field.value === 'string' ? field.value : '';
                else next.value = undefined;
                if (source === 'session') next.sessionPath = field.sessionPath ?? 'session.token';
                else next.sessionPath = undefined;
                updateMapping(index, next);
              }}><option value="prompt">Prompt</option><option value="input">Input parameter</option><option value="model">Model</option><option value="static">Static value</option><option value="session">Captured session</option></NativeSelect></FormField>
              {field.source === 'static' ? <FormField id={`mapping-value-${index}`} label="Static value"><Input id={`mapping-value-${index}`} value={String(field.value ?? '')} onChange={(event) => updateMapping(index, { value: event.target.value })} disabled={busy || !mayManageRecipes} /></FormField> : <FormField id={`mapping-source-name-${index}`} label={field.source === 'input' ? 'Input parameter name' : field.source === 'session' ? 'Session path' : 'Mapping note'}><Input id={`mapping-source-name-${index}`} value={field.source === 'session' ? (field.sessionPath ?? '') : field.source === 'input' ? field.name : ''} onChange={(event) => field.source === 'session' ? updateMapping(index, { sessionPath: event.target.value }) : field.source === 'input' ? updateMapping(index, { name: event.target.value }) : undefined} disabled={busy || !mayManageRecipes || field.source === 'prompt' || field.source === 'model'} /></FormField>}
              <div className="flex items-end"><Button size="sm" variant="destructive" disabled={busy || !mayManageRecipes} onClick={() => setRecipeValue((current) => ({ ...current, request: { ...current.request, fields: current.request.fields.filter((_, position) => position !== index) } }))}>Remove</Button></div>
            </div>)}
            {recipe.request.fields.length === 0 ? <p className="text-xs text-[var(--text-sub)]">No extra mapped fields. Add an input, static form field or session-derived field when the provider recipe needs one.</p> : null}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <FormField id="response-content-path" label="Mapped response content path"><Input id="response-content-path" value={recipe.response.contentPath} onChange={(event) => setRecipeValue((current) => ({ ...current, response: { ...current.response, contentPath: event.target.value } }))} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="response-model-path" label="Mapped model path"><Input id="response-model-path" value={recipe.response.modelPath ?? ''} onChange={(event) => setRecipeValue((current) => ({ ...current, response: { ...current.response, modelPath: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="response-input-tokens-path" label="Mapped input tokens"><Input id="response-input-tokens-path" value={recipe.response.inputTokensPath ?? ''} onChange={(event) => setRecipeValue((current) => ({ ...current, response: { ...current.response, inputTokensPath: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="response-output-tokens-path" label="Mapped output tokens"><Input id="response-output-tokens-path" value={recipe.response.outputTokensPath ?? ''} onChange={(event) => setRecipeValue((current) => ({ ...current, response: { ...current.response, outputTokensPath: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes} /></FormField>
            <FormField id="response-error-path" label="Mapped error path"><Input id="response-error-path" value={recipe.response.errorPath ?? ''} onChange={(event) => setRecipeValue((current) => ({ ...current, response: { ...current.response, errorPath: event.target.value || undefined } }))} disabled={busy || !mayManageRecipes} /></FormField>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">Static request headers</h4><Button size="sm" variant="outline" disabled={busy || !mayManageRecipes || recipe.headers.length >= 64} onClick={() => setRecipeValue((current) => ({ ...current, headers: [...current.headers, { name: '', value: '' }] }))}>Add header</Button></div>
            {recipe.headers.map((header, index) => <div key={`header-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr_auto]"><FormField id={`header-name-${index}`} label="Header name"><Input id={`header-name-${index}`} value={header.name} onChange={(event) => updateHeader(index, { name: event.target.value })} disabled={busy || !mayManageRecipes} /></FormField><FormField id={`header-value-${index}`} label="Non-secret header value"><Input id={`header-value-${index}`} value={header.value} onChange={(event) => updateHeader(index, { value: event.target.value })} disabled={busy || !mayManageRecipes || SECRET_HEADER_NAMES.has(header.name.toLowerCase())} /></FormField><div className="flex items-end"><Button size="sm" variant="destructive" disabled={busy || !mayManageRecipes} onClick={() => setRecipeValue((current) => ({ ...current, headers: current.headers.filter((_, position) => position !== index) }))}>Remove</Button></div></div>)}
            <p className="text-xs text-[var(--text-sub)]">Authorization, cookie and API-key headers are rejected by the schema and must use a write-only credential slot.</p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {(['capture', 'inject'] as const).map((kind) => <div key={kind} className="flex flex-col gap-2 rounded border border-[var(--border-subtle)] p-3">
              <div className="flex items-center justify-between gap-2"><h4 className="font-medium">Session {kind === 'capture' ? 'capture' : 'injection'}</h4><Button size="sm" variant="outline" disabled={busy || !mayManageRecipes || recipe.session[kind].length >= 32} onClick={() => setRecipeValue((current) => ({ ...current, session: { ...current.session, [kind]: [...current.session[kind], { name: '', path: '' }] } }))}>Add</Button></div>
              {recipe.session[kind].map((field, index) => <div key={`${kind}-${index}`} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]"><FormField id={`${kind}-name-${index}`} label="Session name"><Input id={`${kind}-name-${index}`} value={field.name} onChange={(event) => updateSession(kind, index, { name: event.target.value })} disabled={busy || !mayManageRecipes} /></FormField><FormField id={`${kind}-path-${index}`} label="Mapped response/input path"><Input id={`${kind}-path-${index}`} value={field.path} onChange={(event) => updateSession(kind, index, { path: event.target.value })} disabled={busy || !mayManageRecipes} /></FormField><div className="flex items-end"><Button size="sm" variant="destructive" disabled={busy || !mayManageRecipes} onClick={() => setRecipeValue((current) => ({ ...current, session: { ...current.session, [kind]: current.session[kind].filter((_, position) => position !== index) } }))}>Remove</Button></div></div>)}
            </div>)}
          </div>

          {parsedRecipe.success ? null : <AlertBanner variant="warning" title="Recipe needs correction">{parsedRecipe.error.issues.map((issue) => issue.message).join('; ')}</AlertBanner>}
          <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="rounded border border-[var(--border-subtle)] p-3">
            <summary className="cursor-pointer font-medium">Advanced JSON import/export</summary>
            <p className="mt-2 text-xs text-[var(--text-sub)]">The editor accepts the complete strict recipe schema. It preserves every supported advanced mapping and rejects unsupported keys visibly instead of dropping them.</p>
            <textarea aria-label="Advanced Connector recipe JSON" className="mt-3 min-h-64 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-subtle)] p-3 font-mono text-xs" value={advancedJson} onChange={(event) => setAdvancedJson(event.target.value)} disabled={busy || !mayManageRecipes} />
            {advancedError ? <AlertBanner variant="error" title="Advanced recipe not applied">{advancedError}</AlertBanner> : null}
            <div className="mt-2 flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || !mayManageRecipes} onClick={applyAdvancedJson}>Validate and apply JSON</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => setAdvancedJson(jsonText(recipe))}>Discard JSON edits</Button><Button variant="outline" size="sm" disabled={busy} onClick={downloadRecipe}>Export current recipe</Button></div>
          </details>
        </section>

        {mayManageRecipes ? <section aria-labelledby="credential-stage-title" className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4">
          <div><h3 id="credential-stage-title" className="font-semibold">Write-only credential lifecycle</h3><p className="text-xs text-[var(--text-sub)]">Keep, replace, clear or reference a managed Vault credential. Secret values are sent only on explicit Replace and are cleared from the form after save.</p></div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
            <FormField id="credential-change" label="Credential action"><NativeSelect id="credential-change" value={credentialMode} onChange={(event) => { setCredentialMode(event.currentTarget.value as CredentialMode); setCredentialValue(''); setVaultReference(''); }} disabled={busy}><option value="keep">Keep existing credential</option><option value="replace">Replace with new credential</option><option value="clear">Clear credential (explicit)</option><option value="vault-ref">Use approved Vault reference</option></NativeSelect></FormField>
            {credentialMode === 'replace' ? <FormField id="credential-replacement" label="New credential value" description="Write-only. It is not returned by revision reads and is cleared after the request."><Input id="credential-replacement" type="password" autoComplete="new-password" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} disabled={busy} maxLength={16_384} /></FormField> : null}
            {credentialMode === 'vault-ref' ? <FormField id="credential-vault-reference" label="Secret Catalog reference ID" description="Enter the opaque UUID for an active tenant-owned connector credential. The server verifies its Connector service permission and imports it into a new pinned Connector credential revision; Vault paths and values are never shown here."><Input id="credential-vault-reference" value={vaultReference} onChange={(event) => setVaultReference(event.target.value)} disabled={busy} maxLength={36} autoComplete="off" /></FormField> : null}
            {credentialMode === 'clear' ? <p className="self-end text-sm text-[var(--badge-warning-text)]">Saving explicitly removes this credential from the new revision.</p> : null}
          </div>
          <div className="flex flex-wrap gap-2"><Button disabled={busy || !tenantId || !mayManageRecipes || !parsedRecipe.success} isLoading={busy} onClick={() => void saveDraft()}>{loadedRevision ? 'Save new PENDING draft revision' : 'Create PENDING Connector revision'}</Button>
            {loadedRevision ? <Button variant="outline" disabled={busy || !mayManageRecipes} onClick={() => void createRollbackDraft()}>Create rollback draft from this revision</Button> : null}
          </div>
        </section> : null}

        <section aria-labelledby="provider-test-title" className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4">
          <div><h3 id="provider-test-title" className="font-semibold">Actual provider test</h3><p className="text-xs text-[var(--text-sub)]">The server performs normal key/Profile/action/locked-parameter/spend/artifact admission, signs a one-use exact-revision test grant, reserves budgets before transport, and reconciles UNKNOWN from Connector evidence without retrying the provider call.</p></div>
          {testAttempt ? <AlertBanner variant="warning" title="Saved Connector test needs resolution">
            The exact request and idempotency key remain saved for tenant <code>{testAttempt.tenantId}</code>, connector <code>{String(testAttempt.request.connectorId)}@{String(testAttempt.request.revision)}</code>. A tenant switch keeps this request with its original tenant. Check its source evidence before starting another provider test.
          </AlertBanner> : null}
          {rowsLoading || profileLoading ? <LoadingState title="Loading tenant Profile and key choices…" /> : null}
            {mayRunProviderTest ? <>
            {localUser ? <NativeSelect aria-label="Assigned Profile endpoint" value={profileKey} disabled={busy || loadingRows} onChange={(event) => setSelectedProfile(event.currentTarget.value)}><option value="">Select an assigned Profile endpoint</option>{localProfiles.map((row, index) => <option key={`${row.profileId}:${row.action}:${index}`} value={localProfileRowKey(row)}>{row.profileName} · {row.businessId}@{row.businessVersion} · {row.action}</option>)}</NativeSelect> : <NativeSelect aria-label="Tenant Profile" value={profileKey} disabled={busy || loadingRows} onChange={(event) => setSelectedProfile(event.currentTarget.value)}><option value="">Select an active Profile</option>{profileRows.map((row) => <option key={profileRowKey(row)} value={profileRowKey(row)}>{row.profileName} · {row.businessId}@{row.businessVersion}</option>)}</NativeSelect>}
            {profileChoice ? <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <FormField id="provider-test-key" label="Assigned active API key"><NativeSelect id="provider-test-key" value={apiKeyId} onChange={(event) => setApiKeyId(event.currentTarget.value)} disabled={busy}><option value="">Select an active key</option>{profileChoice.availableKeys.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</NativeSelect></FormField>
              {profileChoice.actions.length > 1 ? <FormField id="provider-test-action" label="Action"><NativeSelect id="provider-test-action" value={profileChoice.action} onChange={(event) => setProfileChoice({ ...profileChoice, action: event.currentTarget.value, endpointSlug: event.currentTarget.value })} disabled={busy}>{profileChoice.actions.map((action) => <option key={action} value={action}>{action}</option>)}</NativeSelect></FormField> : <FormField id="provider-test-action" label="Action"><Input id="provider-test-action" value={profileChoice.action} onChange={(event) => setProfileChoice({ ...profileChoice, action: event.target.value })} disabled={busy || localUser} /></FormField>}
              <FormField id="provider-test-endpoint" label="Endpoint slug"><Input id="provider-test-endpoint" value={profileChoice.endpointSlug} onChange={(event) => setProfileChoice({ ...profileChoice, endpointSlug: event.target.value })} disabled={busy || localUser} /></FormField>
              <FormField id="provider-test-binding-slot" label="Connector binding slot" description={pendingCandidate ? 'Required for a PENDING candidate; server verifies it against the exact action manifest.' : localUser ? 'Choose the exact ACTIVE pin from the assigned Profile.' : 'Filled from the selected Profile pin.'}>{localUser ? <NativeSelect id="provider-test-binding-slot" value={bindingSlot} onChange={(event) => { const slot = event.currentTarget.value; setBindingSlot(slot); const pin = profileChoice.connectorBindings[slot]; if (pin) { setConnectorId(pin.connectorId); setRevisionText(String(pin.revision)); } setResult(null); setTestedPin(null); }} disabled={busy}><option value="">Select assigned pin</option>{Object.entries(profileChoice.connectorBindings).map(([slot, pin]) => <option key={slot} value={slot}>{slot} · {pin.connectorId}@{pin.revision}</option>)}</NativeSelect> : <Input id="provider-test-binding-slot" value={bindingSlot} onChange={(event) => setBindingSlot(event.target.value)} disabled={busy || !pendingCandidate} maxLength={128} placeholder="for example: text" />}</FormField>
              <FormField id="provider-test-model" label="Model (optional)"><Input id="provider-test-model" value={model} onChange={(event) => setModel(event.target.value)} maxLength={256} disabled={busy} placeholder="use the admitted Profile model" /></FormField>
              <FormField id="provider-test-timeout" label="Test deadline (ms)"><Input id="provider-test-timeout" type="number" min={100} max={60000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} disabled={busy} /></FormField>
              <FormField id="provider-test-prompt" label="Prompt"><textarea id="provider-test-prompt" className="min-h-20 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] p-2 text-sm" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={busy} maxLength={32_000} /></FormField>
              <FormField id="provider-test-parameters" label="Admitted action parameters (JSON)" description="Values are checked against the selected action schema and locked Profile values before a provider call."><textarea id="provider-test-parameters" className="min-h-32 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-subtle)] p-2 font-mono text-xs" value={parametersText} onChange={(event) => setParametersText(event.target.value)} disabled={busy} /></FormField>
              <FormField id="provider-test-files" label="Tenant-owned test files (up to 4)" description="Files are uploaded as tenant artifacts under the selected API key before the bounded invocation."><input id="provider-test-files" type="file" multiple onChange={onFilesChanged} disabled={busy || !apiKeyId} className="block w-full text-sm" /></FormField>
            </div> : null}
            {selectedFiles.length > 0 ? <p className="text-xs text-[var(--text-sub)]">Selected: {selectedFiles.map((file) => file.name).join(', ')}. Files will be uploaded under the selected tenant/key and the server derives their metadata.</p> : null}
            <div className="flex flex-wrap gap-2"><Button disabled={busy || Boolean(testAttempt) || Boolean(reconcileRequest) || !tenantId || !profileChoice || !apiKeyId || !hasTestTarget || !prompt.trim()} isLoading={busy} onClick={() => void runProviderTest()}>Run actual provider test</Button>
              {reconcileRequest ? <Button variant="outline" disabled={busy} isLoading={busy} onClick={() => void reconcileProviderTest()}>Check saved Connector evidence</Button> : null}
              {mayManageRecipes && loadedRevision?.state === 'PENDING' ? <><FormField id="activate-expected-head" label="Expected ACTIVE revision CAS"><Input id="activate-expected-head" type="number" min={0} value={expectedActiveRevision} onChange={(event) => setExpectedActiveRevision(Number(event.target.value))} disabled={busy} /></FormField><Button variant="outline" disabled={busy || !testSucceededForCurrentRevision} onClick={() => void activateDraft()}>Activate tested draft</Button></> : null}
            </div>
            {result ? <div className="rounded border border-[var(--border-subtle)] p-3" role="status"><div className="flex flex-wrap items-center gap-2"><strong>Persisted provider test</strong><Badge variant={result.state === 'SUCCEEDED' ? 'success' : result.state === 'UNKNOWN' ? 'warning' : 'neutral'}>{result.state}</Badge></div><dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]"><dt>Status code</dt><dd>{result.statusCode ?? 'unreported'}</dd><dt>Latency</dt><dd>{result.latencyMs} ms</dd><dt>Input/output tokens</dt><dd>{result.inputTokens ?? 'unreported'} / {result.outputTokens ?? 'unreported'}</dd><dt>Usage event</dt><dd className="break-all">{result.usageEventId ?? 'not linked'}</dd><dt>Invocation ID</dt><dd className="break-all">{result.invocationId}</dd><dt>Provider response body</dt><dd>{result.contentSanitized === true && result.content !== null ? <><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-muted)] p-2">{result.content}</pre>{result.contentTruncated ? <span className="mt-1 block">The sanitized response was truncated.</span> : null}</> : 'Unavailable or redacted because the Connector did not provide a sanitized response.'}</dd></dl></div> : null}
          </> : <AlertBanner variant="info" title="Provider test is unavailable">Sign in as a platform Admin, or use an assigned local USER Profile for an exact ACTIVE Connector pin. Recipe writes remain platform Admin only.</AlertBanner>}
        </section>
      </CardContent>
    </Card>
  );
}
