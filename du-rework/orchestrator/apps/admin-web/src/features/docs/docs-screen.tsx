import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { AlertBanner, EmptyState, LoadingState } from '@/components/ui/state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/select';
import { createAdminApiClient, type AdminApiProblem, type AdminWebSession, type ProfileApiKeyRow, type ProfileListRow, type ProfileSelfServiceAssignedPage, type OperationDetail, type AdminWorkbenchEndpointTestRequest, type AdminWorkbenchPromptWizardRequest } from '@/lib/api';
import { parseProfileDetail, parseProfileListPage } from '@/features/profiles/state';
import { useTenant } from '@/lib/tenant-context';
import { acceptAttempt, createImmutableAttempt, markAttemptDispatched, retainAfterFailure, type ImmutableAttempt } from '@/features/submissions/immutable-attempt';

const ACTIONS = ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'] as const;
type WorkbenchAction = typeof ACTIONS[number];
type SessionState = { kind: 'loading' } | { kind: 'ready'; session: AdminWebSession } | { kind: 'failed'; problem: AdminApiProblem };
type WorkbenchProfile = {
  key: string;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  profileName: string;
  revision: number;
  actions: string[];
  status: string;
  assigned?: ProfileSelfServiceAssignedPage['items'][number];
  listed?: ProfileListRow;
};
type WorkbenchKey = { id: string; label: string; status: string };
type SelectionData = {
  profile: WorkbenchProfile;
  connectorBindings: Record<string, { connectorId: string; revision: number }>;
  keys: WorkbenchKey[];
  promptCandidate: string;
  inputSchemas: Record<string, Record<string, unknown>>;
  parameters: Record<string, { value?: unknown; isLocked?: boolean }>;
};
type OperationState = { id: string; kind: 'test' | 'wizard'; detail: OperationDetail | null; checking: boolean; pollNote: string | null };
type TestAttempt = ImmutableAttempt<AdminWorkbenchEndpointTestRequest>;
type WizardAttempt = ImmutableAttempt<AdminWorkbenchPromptWizardRequest>;
type ConfirmAction = 'test' | 'wizard' | null;
type DraftSwitchTarget = { kind: 'profile'; key: string } | { kind: 'action'; action: WorkbenchAction | '' };
type ProfileWorkbenchHandoff = {
  handoffId: string;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  profileName: string;
  expectedRevision: number;
};

const ENDPOINTS = [
  ['Session', '/session', 'GET'],
  ['Profiles', '/profiles', 'GET'],
  ['Profile Test Endpoint', '/admin-workbench/test-endpoint', 'POST'],
  ['Prompt Wizard', '/admin-workbench/prompt-wizard', 'POST'],
  ['Operation detail and result', '/operations/:id', 'GET'],
  ['Assigned Profile edits', '/profiles/:id/self-service', 'PATCH'],
  ['Workflow import preview', '/workflow-import/preview', 'POST'],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function parseProfileWorkbenchHandoff(value: unknown): ProfileWorkbenchHandoff | null {
  const item = recordValue(recordValue(value)['profileWorkbenchHandoff']);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof item['handoffId'] !== 'string' || !uuid.test(item['handoffId'])
      || typeof item['tenantId'] !== 'string' || !uuid.test(item['tenantId'])
      || typeof item['businessId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item['businessId'])
      || typeof item['businessVersion'] !== 'string' || item['businessVersion'].length < 1 || item['businessVersion'].length > 128
      || typeof item['profileName'] !== 'string' || item['profileName'].length < 1 || item['profileName'].length > 255
      || typeof item['expectedRevision'] !== 'number' || !Number.isSafeInteger(item['expectedRevision']) || item['expectedRevision'] < 1) return null;
  return {
    handoffId: item['handoffId'],
    tenantId: item['tenantId'],
    businessId: item['businessId'],
    businessVersion: item['businessVersion'],
    profileName: item['profileName'],
    expectedRevision: item['expectedRevision'],
  };
}
function terminal(state: string | undefined): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes((state ?? '').toUpperCase());
}
function actionDiscriminator(action: WorkbenchAction): string {
  return action === 'ingest' || action === 'compare' ? 'mode'
    : action === 'extract' ? 'type'
      : action === 'transform' ? 'action' : 'task';
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('Parameters must be a JSON object.');
  return value;
}
function parseJsonObjectOrEmpty(text: string): Record<string, unknown> {
  try { return parseJsonObject(text); } catch { return {}; }
}
function promptFromParameters(parameters: Record<string, { value?: unknown }> | undefined): string {
  if (!parameters) return '';
  const found = Object.entries(parameters).find(([key, entry]) => /prompt|instruction|system.?text/i.test(key) && typeof entry.value === 'string');
  return found?.[1].value as string | undefined ?? '';
}
function secretLikeField(name: string): boolean {
  return /pass(word)?|secret|token|api.?key|credential|authorization|private.?key/i.test(name);
}
function safeSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(schema) || depth > 6) return {};
  const output: Record<string, unknown> = {};
  for (const key of ['type', 'title', 'description', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'additionalProperties']) {
    const value = schema[key];
    if (typeof value === 'string') output[key] = value.slice(0, key === 'pattern' ? 256 : key === 'description' ? 1024 : key === 'title' ? 128 : 4096);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
    else if (Array.isArray(value) && key === 'type') output[key] = value.filter((item) => typeof item === 'string').slice(0, 4);
  }
  if (Array.isArray(schema.enum)) output.enum = schema.enum.filter((item) => item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean').slice(0, 100);
  if (isRecord(schema.items)) output.items = safeSchema(schema.items, depth + 1);
  if (isRecord(schema.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(schema.properties).slice(0, 128)) {
      if (!secretLikeField(name)) properties[name] = safeSchema(property, depth + 1);
    }
    output.properties = properties;
    if (Array.isArray(schema.required)) output.required = schema.required.filter((name): name is string => typeof name === 'string' && Object.hasOwn(properties, name)).slice(0, 128);
  }
  return output;
}
function actionInputSchemas(rawDetail: unknown, actions: readonly string[]): Record<string, Record<string, unknown>> {
  const manifest = isRecord(rawDetail) ? recordValue(rawDetail['manifest']) : {};
  const rows = Array.isArray(manifest['actions']) ? manifest['actions'] : [];
  const result: Record<string, Record<string, unknown>> = {};
  for (const value of rows) {
    if (!isRecord(value)) continue;
    const action = typeof value['name'] === 'string' ? value['name'] : typeof value['action'] === 'string' ? value['action'] : '';
    if (actions.includes(action)) result[action] = safeSchema(value['inputSchema']);
  }
  return result;
}
function parameterSchemaKey(profile: WorkbenchProfile, key: string): string {
  if (profile.assigned?.endpointSlug && profile.assigned.action === 'transform' && key === 'action') return 'variant';
  if (!profile.assigned?.endpointSlug) return key;
  return key.replace(/_+([a-zA-Z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}
function initialParameters(selection: SelectionData, action: string): Record<string, unknown> {
  const schema = selection.inputSchemas[action];
  const properties = schema && isRecord(schema['properties']) ? schema['properties'] : {};
  const values: Record<string, unknown> = {};
  for (const [schemaKey, rawDefinition] of Object.entries(properties)) {
    if (secretLikeField(schemaKey)) continue;
    const parameterKey = Object.keys(selection.parameters).find((key) => parameterSchemaKey(selection.profile, key) === schemaKey) ?? schemaKey;
    const stored = selection.parameters[parameterKey];
    if (stored?.isLocked === true) continue;
    if (stored && Object.hasOwn(stored, 'value')) values[schemaKey] = stored.value;
    else if (isRecord(rawDefinition) && Object.hasOwn(rawDefinition, 'default')) values[schemaKey] = rawDefinition['default'];
  }
  return values;
}
function promptParameterKey(selection: SelectionData, action: string): string | null {
  const properties = selection.inputSchemas[action] && isRecord(selection.inputSchemas[action]?.['properties'])
    ? selection.inputSchemas[action]!['properties'] as Record<string, unknown>
    : {};
  const stored = Object.entries(selection.parameters).find(([key, entry]) =>
    !entry.isLocked && !secretLikeField(key) && /prompt|instruction|system.?text/i.test(key)
      && Object.hasOwn(properties, parameterSchemaKey(selection.profile, key)));
  if (stored) return parameterSchemaKey(selection.profile, stored[0]);
  return Object.keys(properties).find((key) => !secretLikeField(key) && /prompt|instruction|system.?text/i.test(key)) ?? null;
}
function promptDiff(before: string, after: string): { prefix: string; removed: string; added: string; suffix: string } {
  const left = [...before];
  const right = [...after];
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft -= 1; endRight -= 1; }
  return {
    prefix: left.slice(0, start).join(''),
    removed: left.slice(start, endLeft).join(''),
    added: right.slice(start, endRight).join(''),
    suffix: left.slice(endLeft).join(''),
  };
}
function extractPromptProposal(detail: OperationDetail): string | null {
  let root: unknown = detail.raw['result'];
  if (root === undefined && detail.resultSummary) {
    try { root = JSON.parse(detail.resultSummary) as unknown; } catch { return null; }
  }
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length > 0 && visited < 250) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) { queue.push(...value.slice(0, 100)); continue; }
    if (!isRecord(value) || seen.has(value)) continue;
    seen.add(value);
    for (const key of ['revisedPrompt', 'revised_prompt', 'prompt', 'outputText', 'text']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim().length > 0 && candidate.length <= 16_000) return candidate;
    }
    for (const child of Object.values(value)) if (isRecord(child) || Array.isArray(child)) queue.push(child);
  }
  return null;
}
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{[^{}]{1,256}\}\}/g)].map((match) => match[0]).sort();
}
function safeDownloadHref(value: string | null): string | null {
  if (!value || typeof window === 'undefined') return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/admin/api/operations/') ? url.pathname + url.search : null;
  } catch { return null; }
}
function keyLabel(row: ProfileApiKeyRow): string {
  return `${row.name ?? 'Unnamed key'} · ${row.prefix} · ${row.id}`;
}

export function DocsScreen() {
  const client = useMemo(() => createAdminApiClient(), []);
  const location = useLocation();
  const navigate = useNavigate();
  const profileHandoff = useMemo(() => parseProfileWorkbenchHandoff(location.state), [location.state]);
  const consumedProfileHandoff = useRef('');
  const { tenantId: globalTenantId } = useTenant();
  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<WorkbenchProfile[]>([]);
  const [profileCursor, setProfileCursor] = useState<string | null>(null);
  const [profileTotal, setProfileTotal] = useState(0);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<AdminApiProblem | null>(null);
  const [profileQuery, setProfileQuery] = useState('');
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [selectedProfileValue, setSelectedProfileValue] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [keyQuery, setKeyQuery] = useState('');
  const [keyCursor, setKeyCursor] = useState<string | null>(null);
  const [keyTotal, setKeyTotal] = useState(0);
  const [keysLoading, setKeysLoading] = useState(false);
  const [selection, setSelection] = useState<SelectionData | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionRefresh, setSelectionRefresh] = useState(0);
  const [selectionError, setSelectionError] = useState<AdminApiProblem | null>(null);
  const [action, setAction] = useState<WorkbenchAction | ''>('');
  const [parametersText, setParametersText] = useState('{}');
  const [parameterDraftBase, setParameterDraftBase] = useState('{}');
  const [parameterFieldDrafts, setParameterFieldDrafts] = useState<Record<string, string>>({});
  const [parameterFieldErrors, setParameterFieldErrors] = useState<Record<string, string>>({});
  const [parametersError, setParametersError] = useState<string | null>(null);
  const [lockedOmittedNotice, setLockedOmittedNotice] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedArtifacts, setUploadedArtifacts] = useState<AdminWorkbenchEndpointTestRequest['artifacts']>([]);
  const [uploading, setUploading] = useState(false);
  const [testProblem, setTestProblem] = useState<AdminApiProblem | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDraftBase, setPromptDraftBase] = useState('');
  const [wizardProblem, setWizardProblem] = useState<AdminApiProblem | null>(null);
  const [problemText, setProblemText] = useState('');
  const [proposalDraft, setProposalDraft] = useState('');
  const [proposalBasePrompt, setProposalBasePrompt] = useState('');
  const [proposalAccepted, setProposalAccepted] = useState(false);
  const [proposalHandoffId, setProposalHandoffId] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [switchTarget, setSwitchTarget] = useState<DraftSwitchTarget | null>(null);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [wizardBusy, setWizardBusy] = useState(false);
  const [testAttempt, setTestAttempt] = useState<TestAttempt | null>(null);
  const [wizardAttempt, setWizardAttempt] = useState<WizardAttempt | null>(null);
  const [pollingNotice, setPollingNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const testAttempts = useRef(new Map<string, TestAttempt>());
  const wizardAttempts = useRef(new Map<string, WizardAttempt>());
  const testInFlight = useRef(new Set<string>());
  const wizardInFlight = useRef(new Set<string>());
  const uploadInFlight = useRef(new Set<string>());
  const catalogGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const operationGeneration = useRef(0);
  const activeTenantId = useRef<string | null>(null);

  function rememberTestAttempt(scope: string, attempt: TestAttempt | null): void {
    if (attempt) testAttempts.current.set(scope, attempt);
    else testAttempts.current.delete(scope);
    if (scope === activeTenantId.current) setTestAttempt(attempt);
  }

  function rememberWizardAttempt(scope: string, attempt: WizardAttempt | null): void {
    if (attempt) wizardAttempts.current.set(scope, attempt);
    else wizardAttempts.current.delete(scope);
    if (scope === activeTenantId.current) setWizardAttempt(attempt);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await client.getSession();
        if (!active) return;
        setSessionState(result.ok ? { kind: 'ready', session: result.data } : { kind: 'failed', problem: result.problem });
      } catch {
        if (active) setSessionState({ kind: 'failed', problem: { status: 0, code: 'NETWORK_ERROR', title: 'The admin session could not be read.' } });
      }
    })();
    return () => { active = false; };
  }, [client]);

  const session = sessionState.kind === 'ready' ? sessionState.session : null;
  const tenantId = session?.localUser
    ? session.principal.tenantId
    : session?.principal.kind === 'tenant_operator' ? session.principal.tenantId : globalTenantId;
  activeTenantId.current = tenantId;
  const canUseWorkbench = session !== null && (session.role === 'admin' || session.role === 'operator') && tenantId !== null;
  const selectedProfileKey = selectedProfileValue;
  const selectedProfileRevision = profiles.find((item) => item.key === selectedProfileKey)?.revision;
  const selectedActionAllowed = selection !== null && action !== '' && selection.profile.actions.includes(action);
  const selectedKeyAllowed = selection !== null && selection.keys.some((key) => key.id === selectedKey && key.status === 'ACTIVE');
  const wizardBinding = selection?.connectorBindings.reasoning;
  const wizardAvailable = wizardBinding?.connectorId === 'ext-prompt-wizard' && Number.isSafeInteger(wizardBinding.revision) && wizardBinding.revision > 0;
  const promptDirty = promptDraft !== promptDraftBase;
  const parametersDirty = parametersText !== parameterDraftBase;
  const hasLocalDraft = promptDirty || parametersDirty || sourceUrl.trim() !== '' || files.length > 0 || uploadedArtifacts.length > 0;
  const placeholderSafe = promptDraft.trim() !== '' && proposalDraft.trim() !== '' && JSON.stringify(placeholders(promptDraft)) === JSON.stringify(placeholders(proposalDraft));

  const resetForTenant = () => {
    operationGeneration.current += 1;
    setProfiles([]);
    setProfileCursor(null);
    setProfileTotal(0);
    setSelection(null);
    setSelectedKey('');
    setKeyQuery('');
    setKeyCursor(null);
    setKeyTotal(0);
    setKeysLoading(false);
    setSelectedProfileValue('');
    setAction('');
    setParametersText('{}');
    setParameterDraftBase('{}');
    setParameterFieldDrafts({});
    setParameterFieldErrors({});
    setParametersError(null);
    setLockedOmittedNotice(null);
    setSourceUrl('');
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploadedArtifacts([]);
    setUploading(Boolean(tenantId && uploadInFlight.current.has(tenantId)));
    setOperation(null);
    setTestProblem(null);
    setWizardProblem(null);
    setPollingNotice(null);
    setProposalDraft('');
    setProposalBasePrompt('');
    setProposalAccepted(false);
    setProposalHandoffId('');
    setPromptDraft('');
    setPromptDraftBase('');
    setProfileQuery('');
    setTestBusy(Boolean(tenantId && testInFlight.current.has(tenantId)));
    setWizardBusy(Boolean(tenantId && wizardInFlight.current.has(tenantId)));
    setConfirmAction(null);
    setTestAttempt(tenantId ? testAttempts.current.get(tenantId) ?? null : null);
    setWizardAttempt(tenantId ? wizardAttempts.current.get(tenantId) ?? null : null);
  };

  async function loadProfiles(cursor?: string): Promise<void> {
    if (!canUseWorkbench || !tenantId || !session) return;
    const generation = ++catalogGeneration.current;
    setProfilesLoading(true);
    setProfilesError(null);
    if (!cursor) {
      setProfiles([]);
      setProfileCursor(null);
      setProfileTotal(0);
    }
    try {
      if (session.localUser) {
        const result = await client.listAssignedProfileEndpoints({ query: profileQuery.trim() || undefined, cursor, limit: 100 });
        if (generation !== catalogGeneration.current) return;
        if (!result.ok) { setProfilesError(result.problem); return; }
        if (result.data.tenantId !== tenantId) { setProfilesError({ status: 502, code: 'SCOPE_MISMATCH', title: 'Assigned Profiles did not match the active session tenant.' }); return; }
        const mapped = result.data.items.filter((item) => item.businessId === 'document-core' && ACTIONS.includes(item.action as WorkbenchAction)).map((item): WorkbenchProfile => ({
          key: item.profileId,
          tenantId: item.tenantId,
          businessId: item.businessId,
          businessVersion: item.businessVersion,
          profileName: item.profileName,
          revision: item.revision,
          actions: [item.action],
          status: 'ACTIVE',
          assigned: item,
        }));
        setProfiles((current) => cursor ? [...current, ...mapped] : mapped);
        setProfileCursor(result.data.nextCursor);
        setProfileTotal(result.data.total);
      } else {
        const result = await client.listProfiles({ tenantId, businessId: 'document-core', limit: '100', ...(cursor ? { cursor } : {}) });
        if (generation !== catalogGeneration.current) return;
        if (!result.ok) { setProfilesError(result.problem); return; }
        const page = parseProfileListPage(result.data, tenantId, 'document-core');
        if (!page) { setProfilesError({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'The Profile catalog response did not match the selected tenant.' }); return; }
        const mapped = page.items.filter((item) => item.status === 'ACTIVE').map((item): WorkbenchProfile => ({
          key: JSON.stringify([item.tenantId, item.businessId, item.businessVersion, item.profileName]),
          tenantId: item.tenantId,
          businessId: item.businessId,
          businessVersion: item.businessVersion,
          profileName: item.profileName,
          revision: item.revision,
          actions: item.boundActions.filter((entry) => ACTIONS.includes(entry as WorkbenchAction)),
          status: item.status,
          listed: item,
        }));
        setProfiles((current) => cursor ? [...current, ...mapped] : mapped);
        setProfileCursor(page.nextCursor);
        setProfileTotal(page.total);
      }
    } catch {
      if (generation === catalogGeneration.current) setProfilesError({ status: 0, code: 'NETWORK_ERROR', title: 'The Profile catalog could not be loaded.' });
    } finally {
      if (generation === catalogGeneration.current) setProfilesLoading(false);
    }
  }

  const catalogScopeKey = session ? `${session.localUser ? 'local' : session.role}:${tenantId ?? ''}` : '';
  const priorCatalogScope = useRef('');
  useEffect(() => {
    if (sessionState.kind !== 'ready') return;
    catalogGeneration.current += 1;
    if (priorCatalogScope.current !== catalogScopeKey) {
      selectionGeneration.current += 1;
      resetForTenant();
      priorCatalogScope.current = catalogScopeKey;
    }
    if (!canUseWorkbench || !tenantId) {
      setProfilesLoading(false);
      return;
    }
    void loadProfiles();
    // Catalog state resets on the authorization scope; normal pagination/search is explicit below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sessionState.kind, session?.localUser, session?.role, tenantId, profileRefresh]);

  useEffect(() => {
    const handoff = profileHandoff;
    if (!handoff || sessionState.kind !== 'ready' || !session || !canUseWorkbench || !tenantId
        || session.localUser || consumedProfileHandoff.current === handoff.handoffId) return;
    consumedProfileHandoff.current = handoff.handoffId;
    // Invalidate a catalog request already in flight. The exact detail read
    // below is the only path that may install this selection.
    catalogGeneration.current += 1;
    let active = true;
    const clearHandoffState = () => {
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
    };
    void (async () => {
      if (handoff.tenantId !== tenantId) {
        setSelectionError({ status: 403, code: 'TENANT_SCOPE_MISMATCH', title: 'The Profile handoff belongs to a different tenant. Select that tenant and open the Profile again.' });
        clearHandoffState();
        return;
      }
      setSelectionLoading(true);
      setSelectionError(null);
      const result = await client.getProfile(handoff.businessId, handoff.businessVersion, handoff.profileName);
      if (!active) return;
      if (!result.ok) {
        setSelectionError(result.problem);
        clearHandoffState();
        setSelectionLoading(false);
        return;
      }
      const detail = parseProfileDetail(result.data);
      if (!detail || detail.businessId !== handoff.businessId || detail.businessVersion !== handoff.businessVersion
          || detail.profileName !== handoff.profileName || detail.revision !== handoff.expectedRevision) {
        setSelectionError({ status: 409, code: 'PROFILE_CHANGED', title: `The saved Profile revision changed from ${handoff.expectedRevision}. Refresh Profiles and open the current revision before testing.` });
        clearHandoffState();
        setSelectionLoading(false);
        return;
      }
      if (!detail.policy.enabled) {
        setSelectionError({ status: 409, code: 'PROFILE_NOT_ACTIVE', title: 'This Profile is no longer active in the selected tenant.' });
        clearHandoffState();
        setSelectionLoading(false);
        return;
      }
      const actions = detail.manifest.actions
        .map((entry) => entry.name ?? entry.action ?? '')
        .filter((entry): entry is WorkbenchAction => ACTIONS.includes(entry as WorkbenchAction));
      const profile: WorkbenchProfile = {
        key: JSON.stringify([tenantId, detail.businessId, detail.businessVersion, detail.profileName]),
        tenantId,
        businessId: detail.businessId,
        businessVersion: detail.businessVersion,
        profileName: detail.profileName,
        revision: detail.revision,
        actions,
        status: 'ACTIVE',
      };
      setProfiles((current) => [profile, ...current.filter((item) => item.key !== profile.key)]);
      setSelectedProfileValue(profile.key);
      setProfileQuery('');
      clearHandoffState();
    })().catch(() => {
      if (!active) return;
      setSelectionError({ status: 0, code: 'NETWORK_ERROR', title: 'The saved Profile could not be rechecked for the Test Workbench.' });
      setSelectionLoading(false);
      clearHandoffState();
    });
    return () => { active = false; };
  }, [client, canUseWorkbench, location.pathname, location.search, navigate, profileHandoff, session, sessionState.kind, tenantId]);

  function installSelection(data: SelectionData): void {
    setSelection(data);
    const initialAction = data.profile.actions.length === 1 ? data.profile.actions[0] as WorkbenchAction : '';
    setAction(initialAction);
    const initial = initialAction ? initialParameters(data, initialAction) : {};
    const serialized = JSON.stringify(initial, null, 2);
    setParametersText(serialized);
    setParameterDraftBase(serialized);
    setParameterFieldDrafts({});
    setParameterFieldErrors({});
    setParametersError(null);
    setLockedOmittedNotice(null);
  }

  useEffect(() => {
    let active = true;
    const generation = ++selectionGeneration.current;
    operationGeneration.current += 1;
    setSelection(null);
    setSelectedKey('');
    setAction('');
    setSelectionError(null);
    setKeyQuery('');
    setKeyCursor(null);
    setKeyTotal(0);
    setKeysLoading(false);
    setParametersText('{}');
    setParameterDraftBase('{}');
    setParameterFieldDrafts({});
    setParameterFieldErrors({});
    setParametersError(null);
    setLockedOmittedNotice(null);
    setUploadedArtifacts([]);
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setPromptDraft('');
    setPromptDraftBase('');
    setProblemText('');
    setProposalDraft('');
    setProposalBasePrompt('');
    setProposalAccepted(false);
    setProposalHandoffId('');
    setOperation(null);
    if (!selectedProfileKey || !session || !tenantId) return () => { active = false; };
    const row = profiles.find((item) => item.key === selectedProfileKey);
    if (!row) { setSelectionLoading(false); setKeysLoading(false); return () => { active = false; }; }
    setSelectionLoading(true);
    void (async () => {
      try {
        if (session.localUser && row.assigned) {
          setKeysLoading(true);
          const result = await client.listAssignedProfileApiKeys(row.assigned.profileId, { limit: 100 });
          if (!active || generation !== selectionGeneration.current) return;
          if (!result.ok) { setSelectionError(result.problem); return; }
          if (result.data.profileId !== row.assigned.profileId || result.data.tenantId !== tenantId) { setSelectionError({ status: 502, code: 'SCOPE_MISMATCH', title: 'Assigned API keys did not match the selected Profile and tenant.' }); return; }
          const keys = result.data.items.map((key) => ({ id: key.apiKeyId, label: `${key.name ?? 'Unnamed key'} · ${key.prefix} · ${key.apiKeyId}`, status: key.status }));
          installSelection({
            profile: row,
            connectorBindings: row.assigned.connectorBindings,
            keys,
            promptCandidate: promptFromParameters(row.assigned.parameters),
            inputSchemas: { [row.assigned.action]: safeSchema(row.assigned.inputSchema) },
            parameters: row.assigned.parameters,
          });
          setKeyCursor(result.data.nextCursor);
          setKeyTotal(result.data.total);
          if (keys.length === 1) setSelectedKey(keys[0]!.id);
          return;
        }
        const [detailResult, keysResult] = await Promise.all([
          client.getProfile(row.businessId, row.businessVersion, row.profileName),
          client.listProfileApiKeys(row.businessId, row.businessVersion, row.profileName),
        ]);
        if (!active || generation !== selectionGeneration.current) return;
        if (!detailResult.ok) { setSelectionError(detailResult.problem); return; }
        const detail = parseProfileDetail(detailResult.data);
        if (!detail || detail.businessId !== row.businessId || detail.businessVersion !== row.businessVersion || detail.profileName !== row.profileName || detail.revision !== row.revision) {
          setSelectionError({ status: 409, code: 'PROFILE_CHANGED', title: 'Profile changed since catalog load. Reload the catalog before running it.' }); return;
        }
        if (!keysResult.ok) { setSelectionError(keysResult.problem); return; }
        const keys = keysResult.data.items.filter((key) => key.status === 'ACTIVE' && key.membershipState === 'ACTIVE').map((key) => ({ id: key.id, label: keyLabel(key), status: key.status }));
        const params = detail.policy.parameters;
        installSelection({
          profile: row,
          connectorBindings: detail.connectorBindings,
          keys,
          promptCandidate: promptFromParameters(params),
          inputSchemas: actionInputSchemas(detailResult.data, row.actions),
          parameters: params,
        });
        if (keys.length === 1) setSelectedKey(keys[0]!.id);
      } catch {
        if (active && generation === selectionGeneration.current) setSelectionError({ status: 0, code: 'NETWORK_ERROR', title: 'The selected Profile could not be loaded.' });
      } finally {
        if (active && generation === selectionGeneration.current) { setSelectionLoading(false); setKeysLoading(false); }
      }
    })();
    return () => { active = false; };
  }, [client, selectedProfileKey, selectedProfileRevision, selectionRefresh, session, tenantId]);

  useEffect(() => {
    if (!selection) return;
    setPromptDraft(selection.promptCandidate);
    setPromptDraftBase(selection.promptCandidate);
    setProposalBasePrompt(selection.promptCandidate);
    setProposalAccepted(false);
  }, [selection]);

  function applyActionChange(nextAction: WorkbenchAction | ''): void {
    setAction(nextAction);
    const initial = selection && nextAction ? initialParameters(selection, nextAction) : {};
    const serialized = JSON.stringify(initial, null, 2);
    setParametersText(serialized);
    setParameterDraftBase(serialized);
    setParameterFieldDrafts({});
    setParameterFieldErrors({});
    setParametersError(null);
    setLockedOmittedNotice(null);
  }

  function requestActionChange(nextAction: WorkbenchAction | ''): void {
    if (nextAction === action) return;
    if (parametersDirty) {
      setSwitchTarget({ kind: 'action', action: nextAction });
      setSwitchConfirmOpen(true);
      return;
    }
    applyActionChange(nextAction);
  }

  function updateParameter(key: string, value: unknown): void {
    const current = parseJsonObjectOrEmpty(parametersText);
    const next = { ...current, [key]: value };
    const serialized = JSON.stringify(next, null, 2);
    setParametersText(serialized);
    setParameterFieldDrafts((drafts) => { const copy = { ...drafts }; delete copy[key]; return copy; });
    setParameterFieldErrors((errors) => { const copy = { ...errors }; delete copy[key]; return copy; });
    setParametersError(null);
    setLockedOmittedNotice(null);
  }

  function acceptProposal(): void {
    if (!selection || !placeholderSafe || !proposalDraft.trim()) return;
    const key = promptParameterKey(selection, action || 'generate');
    if (session?.localUser && !key) {
      setWizardProblem({ status: 422, code: 'INVALID_SCHEMA', title: 'This assigned endpoint has no editable prompt parameter. The proposal cannot be applied to this Profile.' });
      return;
    }
    setPromptDraft(proposalDraft);
    setProposalAccepted(true);
    setProposalHandoffId(crypto.randomUUID());
    setWizardProblem(null);
    if (key) {
      try {
        parseJsonObject(parametersText);
        updateParameter(key, proposalDraft);
      } catch {
        setParametersError('The prompt proposal was accepted locally, but the advanced JSON draft is invalid. Fix that draft before running the Test Endpoint.');
      }
    }
  }

  async function chooseProfile(nextKey: string): Promise<void> {
    if (nextKey === selectedProfileValue) return;
    if (hasLocalDraft) {
      setSwitchTarget({ kind: 'profile', key: nextKey });
      setSwitchConfirmOpen(true);
      return;
    }
    setSelectedKey('');
    setSelection(null);
    setSelectedProfileKey(nextKey);
  }

  function commitDraftSwitch(): void {
    const target = switchTarget;
    setSwitchConfirmOpen(false);
    setSwitchTarget(null);
    if (!target) return;
    if (target.kind === 'profile') {
      setSelectedKey('');
      setSelectedProfileKey(target.key);
      return;
    }
    applyActionChange(target.action);
  }

  // Selected identity is separated from loaded detail so a slow read cannot show the previous Profile as current.
  function setSelectedProfileKey(key: string): void {
    setSelectedProfileValue(key);
  }
  async function loadMoreProfiles(): Promise<void> {
    if (!profileCursor || profilesLoading) return;
    await loadProfiles(profileCursor);
  }

  async function searchAssignedKeys(cursor?: string): Promise<void> {
    const assigned = selection?.profile.assigned;
    if (!session?.localUser || !assigned || !tenantId) return;
    setKeysLoading(true);
    setSelectionError(null);
    try {
      const result = await client.listAssignedProfileApiKeys(assigned.profileId, { query: keyQuery.trim() || undefined, cursor, limit: 100 });
      if (!result.ok) { setSelectionError(result.problem); return; }
      if (result.data.profileId !== assigned.profileId || result.data.tenantId !== tenantId) {
        setSelectionError({ status: 502, code: 'SCOPE_MISMATCH', title: 'Assigned API keys did not match the selected Profile and tenant.' });
        return;
      }
      const mapped = result.data.items.map((key) => ({ id: key.apiKeyId, label: `${key.name ?? 'Unnamed key'} · ${key.prefix} · ${key.apiKeyId}`, status: key.status }));
      setSelection((current) => current?.profile.key === assigned.profileId
        ? { ...current, keys: cursor ? [...current.keys, ...mapped.filter((key) => !current.keys.some((existing) => existing.id === key.id))] : mapped }
        : current);
      setKeyCursor(result.data.nextCursor);
      setKeyTotal(result.data.total);
      if (!cursor) setSelectedKey((current) => mapped.some((key) => key.id === current) ? current : mapped.length === 1 ? mapped[0]!.id : '');
    } catch {
      setSelectionError({ status: 0, code: 'NETWORK_ERROR', title: 'Assigned API keys could not be loaded.' });
    } finally { setKeysLoading(false); }
  }

  function validateRequest(): Record<string, unknown> | null {
    setParametersError(null);
    setTestProblem(null);
    setParameterFieldErrors({});
    setLockedOmittedNotice(null);
    if (!canUseWorkbench || !tenantId || !selection || !selectedActionAllowed || !selectedKeyAllowed) {
      setTestProblem({ status: 403, code: 'FORBIDDEN', title: 'Choose an authorized tenant, active Profile action, and active assigned API key.' });
      return null;
    }
    let parameters: Record<string, unknown>;
    try { parameters = parseJsonObject(parametersText); }
    catch (error) { setParametersError(error instanceof Error ? error.message : 'Parameters must be a JSON object.'); return null; }
    if (new TextEncoder().encode(JSON.stringify(parameters)).byteLength > 32 * 1024) {
      setParametersError('Parameters exceed the 32 KiB request limit.');
      return null;
    }
    const schema = selection.inputSchemas[action];
    const properties = schema && isRecord(schema['properties']) ? schema['properties'] : {};
    const fieldErrors: Record<string, string> = {};
    const required = schema && Array.isArray(schema['required']) ? schema['required'].filter((key): key is string => typeof key === 'string') : [];
    const lockedKeys = Object.entries(selection.parameters)
      .filter(([, stored]) => stored.isLocked === true)
      .map(([key]) => parameterSchemaKey(selection.profile, key));
    const lockedKeySet = new Set(lockedKeys);
    const omittedLocked = lockedKeys.filter((key) => Object.hasOwn(parameters, key));
    for (const key of required) {
      if (!lockedKeySet.has(key) && !secretLikeField(key) && (!Object.hasOwn(parameters, key) || parameters[key] === null || parameters[key] === '')) fieldErrors[key] = 'This field is required.';
    }
    for (const [key, value] of Object.entries(parameters)) {
      if (secretLikeField(key) || lockedKeySet.has(key)) { delete parameters[key]; continue; }
      const definition = recordValue(properties[key]);
      const rawType = definition['type'];
      const allowedTypes = Array.isArray(rawType) ? rawType.filter((item): item is string => typeof item === 'string') : typeof rawType === 'string' ? [rawType] : [];
      if (value === undefined || value === null || allowedTypes.length === 0) continue;
      const typeOk = allowedTypes.some((type) => type === 'object' ? isRecord(value)
        : type === 'array' ? Array.isArray(value)
          : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
            : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
              : type === 'boolean' ? typeof value === 'boolean'
                : type === 'string' ? typeof value === 'string' : true);
      if (!typeOk) fieldErrors[key] = `Value must match the ${allowedTypes.join(' or ')} field type.`;
      if (Array.isArray(definition['enum']) && !definition['enum'].some((candidate) => Object.is(candidate, value) || String(candidate) === String(value))) fieldErrors[key] = 'Choose one of the listed values.';
      if (typeof value === 'string') {
        const length = [...value].length;
        if (typeof definition['minLength'] === 'number' && length < definition['minLength']) fieldErrors[key] = `Enter at least ${definition['minLength']} characters.`;
        if (typeof definition['maxLength'] === 'number' && length > definition['maxLength']) fieldErrors[key] = `Enter no more than ${definition['maxLength']} characters.`;
        if (typeof definition['pattern'] === 'string') {
          try { if (!new RegExp(definition['pattern']).test(value)) fieldErrors[key] = 'Use the format shown by the field schema.'; }
          catch { fieldErrors[key] = 'This field has an invalid schema pattern. Refresh the Profile metadata.'; }
        }
      }
      if (typeof value === 'number') {
        if (typeof definition['minimum'] === 'number' && value < definition['minimum']) fieldErrors[key] = `Enter a value of at least ${definition['minimum']}.`;
        if (typeof definition['maximum'] === 'number' && value > definition['maximum']) fieldErrors[key] = `Enter a value of at most ${definition['maximum']}.`;
        if (typeof definition['exclusiveMinimum'] === 'number' && value <= definition['exclusiveMinimum']) fieldErrors[key] = `Enter a value greater than ${definition['exclusiveMinimum']}.`;
        if (typeof definition['exclusiveMaximum'] === 'number' && value >= definition['exclusiveMaximum']) fieldErrors[key] = `Enter a value less than ${definition['exclusiveMaximum']}.`;
      }
    }
    for (const key of [...lockedKeys, ...Object.keys(properties).filter(secretLikeField)]) delete parameters[key];
    if (Object.keys(fieldErrors).length > 0) {
      setParameterFieldErrors(fieldErrors);
      setParametersError('Fix the highlighted fields before submitting.');
      return null;
    }
    if (omittedLocked.length > 0) setLockedOmittedNotice(`Locked fields were omitted from the request: ${omittedLocked.join(', ')}.`);
    if (sourceUrl.trim()) {
      try {
        const url = new URL(sourceUrl.trim());
        if (!['https:', 's3:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
      } catch { setTestProblem({ status: 422, code: 'INVALID_SCHEMA', title: 'Source URL must be an HTTPS URL or tenant-authorized s3:// object reference without credentials or a fragment.' }); return null; }
    }
    if (uploadedArtifacts.length + files.length > 20) {
      setTestProblem({ status: 422, code: 'INVALID_SCHEMA', title: 'A test can use at most 20 uploaded files.' }); return null;
    }
    return parameters;
  }

  async function uploadFiles(): Promise<AdminWorkbenchEndpointTestRequest['artifacts'] | null> {
    if (!selection || !tenantId) return null;
    if (files.length === 0) return uploadedArtifacts;
    if (files.length + uploadedArtifacts.length > 20) return null;
    const uploadTenant = tenantId;
    uploadInFlight.current.add(uploadTenant);
    if (activeTenantId.current === uploadTenant) setUploading(true);
    try {
      const next = [...uploadedArtifacts];
      for (const file of files) {
        const result = await client.uploadWorkflowFile(tenantId, selectedKey, file);
        if (activeTenantId.current !== tenantId) return null;
        if (!result.ok) { setTestProblem(result.problem); return null; }
        next.push({ artifactId: result.data.artifactId, role: 'input' });
        setUploadedArtifacts([...next]);
        setFiles((current) => current.filter((pending) => pending !== file));
      }
      setUploadedArtifacts(next);
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return next;
    } catch {
      if (activeTenantId.current === uploadTenant) setTestProblem({ status: 0, code: 'NETWORK_ERROR', title: 'File upload failed. Refresh and check tenant scope before retrying.' });
      return null;
    } finally {
      uploadInFlight.current.delete(uploadTenant);
      if (activeTenantId.current === uploadTenant) setUploading(false);
    }
  }

  async function dispatchTestAttempt(originalAttempt: TestAttempt, alreadyClaimed = false): Promise<void> {
    if ((!alreadyClaimed && testInFlight.current.has(originalAttempt.tenantId)) || originalAttempt.tenantId !== tenantId || activeTenantId.current !== originalAttempt.tenantId) return;
    const attempt = markAttemptDispatched(originalAttempt);
    rememberTestAttempt(attempt.tenantId, attempt);
    testInFlight.current.add(attempt.tenantId);
    setTestBusy(true);
    setTestProblem(null);
    try {
      const result = await client.submitAdminWorkbenchEndpointTest(
        attempt.request as unknown as AdminWorkbenchEndpointTestRequest,
        attempt.idempotencyKey,
      );
      const isVisibleScope = activeTenantId.current === attempt.tenantId;
      if (!result.ok) {
        const retained = retainAfterFailure(attempt, result.status);
        rememberTestAttempt(attempt.tenantId, retained);
        if (isVisibleScope) setTestProblem({
          ...result.problem,
          title: retained
            ? `${result.problem.title ?? 'The result is not confirmed.'} The exact request and key are saved for a safe replay.`
            : result.problem.title,
        });
        return;
      }
      const accepted = acceptAttempt(attempt, result.data.operationId);
      rememberTestAttempt(accepted.tenantId, accepted);
      if (isVisibleScope) setOperation({ id: result.data.operationId, kind: 'test', detail: null, checking: true, pollNote: 'Test submitted through the real workflow admission path.' });
    } catch {
      rememberTestAttempt(attempt.tenantId, retainAfterFailure(attempt, 0));
      if (activeTenantId.current === attempt.tenantId) setTestProblem({ status: 0, code: 'NETWORK_ERROR', title: 'Test submission could not be confirmed. The exact request and key are saved for a safe replay.' });
    } finally {
      testInFlight.current.delete(attempt.tenantId);
      if (activeTenantId.current === attempt.tenantId) {
        setTestBusy(false);
        setConfirmAction(null);
      }
    }
  }

  async function retryTestAttempt(): Promise<void> {
    if (!testAttempt || testAttempt.tenantId !== tenantId || testAttempt.state === 'ACCEPTED') return;
    if (testInFlight.current.has(testAttempt.tenantId)) return;
    await dispatchTestAttempt(testAttempt);
  }

  async function submitTest(): Promise<void> {
    if (!tenantId || testInFlight.current.has(tenantId)) return;
    if (testAttempt) {
      setTestProblem({ status: 409, code: 'ATTEMPT_UNRESOLVED', title: testAttempt.state === 'ACCEPTED'
        ? 'The saved test already has an accepted operation. Check that operation before starting another test.'
        : 'The saved test outcome is not confirmed. Retry its exact saved request before changing inputs or starting another test.' });
      return;
    }
    const parameters = validateRequest();
    if (!parameters || !selection || !tenantId || !action) return;
    const submitTenant = tenantId;
    testInFlight.current.add(submitTenant);
    setTestBusy(true);
    setTestProblem(null);
    try {
      const artifacts = await uploadFiles();
      if (artifacts === null || activeTenantId.current !== tenantId) return;
      const body: AdminWorkbenchEndpointTestRequest = {
        tenantId,
        apiKeyId: selectedKey,
        businessId: 'document-core',
        businessVersion: selection.profile.businessVersion,
        action: action as WorkbenchAction,
        profileName: selection.profile.profileName,
        expectedProfileRevision: selection.profile.revision,
        parameters,
        artifacts,
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      };
      const attempt = createImmutableAttempt(tenantId, crypto.randomUUID(), body);
      rememberTestAttempt(tenantId, attempt);
      await dispatchTestAttempt(attempt, true);
    } catch {
      if (activeTenantId.current === submitTenant) setTestProblem({ status: 0, code: 'REQUEST_NOT_SENT', title: 'The test request could not be prepared. Review the current inputs before retrying.' });
      rememberTestAttempt(submitTenant, null);
    } finally {
      if (testInFlight.current.has(submitTenant)) {
        testInFlight.current.delete(submitTenant);
        if (activeTenantId.current === submitTenant) setTestBusy(false);
      }
      if (activeTenantId.current === submitTenant) setConfirmAction(null);
    }
  }

  async function dispatchWizardAttempt(originalAttempt: WizardAttempt, alreadyClaimed = false): Promise<void> {
    if ((!alreadyClaimed && wizardInFlight.current.has(originalAttempt.tenantId)) || originalAttempt.tenantId !== tenantId || activeTenantId.current !== originalAttempt.tenantId) return;
    const attempt = markAttemptDispatched(originalAttempt);
    rememberWizardAttempt(attempt.tenantId, attempt);
    wizardInFlight.current.add(attempt.tenantId);
    setWizardBusy(true);
    setWizardProblem(null);
    try {
      const result = await client.runPromptWizard(
        attempt.request as unknown as AdminWorkbenchPromptWizardRequest,
        attempt.idempotencyKey,
      );
      const isVisibleScope = activeTenantId.current === attempt.tenantId;
      if (!result.ok) {
        const retained = retainAfterFailure(attempt, result.status);
        rememberWizardAttempt(attempt.tenantId, retained);
        if (isVisibleScope) setWizardProblem({
          ...result.problem,
          title: retained
            ? `${result.problem.title ?? 'The result is not confirmed.'} The exact request and key are saved for a safe replay.`
            : result.problem.title,
        });
        return;
      }
      const accepted = acceptAttempt(attempt, result.data.operationId);
      rememberWizardAttempt(accepted.tenantId, accepted);
      if (isVisibleScope) setOperation({ id: result.data.operationId, kind: 'wizard', detail: null, checking: true, pollNote: 'Prompt proposal submitted through the real ext-prompt-wizard reasoning binding. No Profile revision is changed.' });
    } catch {
      rememberWizardAttempt(attempt.tenantId, retainAfterFailure(attempt, 0));
      if (activeTenantId.current === attempt.tenantId) setWizardProblem({ status: 0, code: 'NETWORK_ERROR', title: 'Prompt proposal submission could not be confirmed. The exact request and key are saved for a safe replay.' });
    } finally {
      wizardInFlight.current.delete(attempt.tenantId);
      if (activeTenantId.current === attempt.tenantId) {
        setWizardBusy(false);
        setConfirmAction(null);
      }
    }
  }

  async function retryWizardAttempt(): Promise<void> {
    if (!wizardAttempt || wizardAttempt.tenantId !== tenantId || wizardAttempt.state === 'ACCEPTED') return;
    if (wizardInFlight.current.has(wizardAttempt.tenantId)) return;
    await dispatchWizardAttempt(wizardAttempt);
  }

  async function submitWizard(): Promise<void> {
    if (!tenantId || wizardInFlight.current.has(tenantId)) return;
    if (wizardAttempt) {
      setWizardProblem({ status: 409, code: 'ATTEMPT_UNRESOLVED', title: wizardAttempt.state === 'ACCEPTED'
        ? 'The saved proposal already has an accepted operation. Check that operation before starting another proposal.'
        : 'The saved proposal outcome is not confirmed. Retry its exact saved request before changing inputs or starting another proposal.' });
      return;
    }
    if (!canUseWorkbench || !selection || !tenantId || !selectedKeyAllowed || !wizardAvailable || !selectedActionAllowed || action !== 'generate') {
      setWizardProblem({ status: 403, code: 'FORBIDDEN', title: 'Choose a Profile pinned to the active ext-prompt-wizard Connector and a currently assigned key.' });
      return;
    }
    if (!promptDraft.trim()) { setWizardProblem({ status: 422, code: 'INVALID_SCHEMA', title: 'Enter the current prompt text before proposing a revision.' }); return; }
    const submitTenant = tenantId;
    wizardInFlight.current.add(submitTenant);
    setWizardBusy(true);
    setWizardProblem(null);
    setProposalDraft('');
    setProposalAccepted(false);
    setProposalBasePrompt(promptDraft);
    try {
      const body: AdminWorkbenchPromptWizardRequest = {
        tenantId,
        apiKeyId: selectedKey,
        businessVersion: selection.profile.businessVersion,
        profileName: selection.profile.profileName,
        expectedProfileRevision: selection.profile.revision,
        currentPrompt: promptDraft,
        problem: problemText,
        endpointName: selection.profile.profileName,
        endpointSlug: selection.profile.assigned?.endpointSlug ?? selection.profile.profileName,
        connectorName: wizardBinding!.connectorId,
        connectorSlug: wizardBinding!.connectorId,
        stepId: '_default',
        wizardConnectorId: wizardBinding!.connectorId,
        wizardConnectorRevision: wizardBinding!.revision,
      };
      const attempt = createImmutableAttempt(tenantId, crypto.randomUUID(), body);
      rememberWizardAttempt(tenantId, attempt);
      await dispatchWizardAttempt(attempt, true);
    } catch {
      if (activeTenantId.current === tenantId) setWizardProblem({ status: 0, code: 'REQUEST_NOT_SENT', title: 'The prompt proposal could not be prepared. Review the current inputs before retrying.' });
      rememberWizardAttempt(submitTenant, null);
    } finally {
      if (wizardInFlight.current.has(submitTenant)) {
        wizardInFlight.current.delete(submitTenant);
        if (activeTenantId.current === submitTenant) setWizardBusy(false);
      }
      if (activeTenantId.current === submitTenant) setConfirmAction(null);
    }
  }

  async function pollOperation(operationId: string, kind: 'test' | 'wizard'): Promise<void> {
    const generation = ++operationGeneration.current;
    setPollingNotice(null);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (generation !== operationGeneration.current) return;
      if (attempt > 0) await wait(2000);
      if (generation !== operationGeneration.current) return;
      try {
        const result = await client.getOperation(operationId);
        if (generation !== operationGeneration.current) return;
        if (!result.ok) {
          setOperation((current) => current?.id === operationId ? { ...current, checking: false, pollNote: result.problem.title ?? 'Operation status could not be refreshed.' } : current);
          setPollingNotice('Status refresh failed; use Retry status or open Operations. The submission itself may still be running.');
          return;
        }
        const detail = result.data;
        setOperation({ id: operationId, kind, detail, checking: !terminal(detail.operation?.state), pollNote: null });
        if (kind === 'wizard') {
          const proposal = extractPromptProposal(detail);
          if (proposal) setProposalDraft(proposal);
        }
        if (terminal(detail.operation?.state)) {
          const completedTest = testAttempts.current.get(tenantId ?? '');
          if (kind === 'test' && completedTest?.operationId === operationId) rememberTestAttempt(completedTest.tenantId, null);
          const completedWizard = wizardAttempts.current.get(tenantId ?? '');
          if (kind === 'wizard' && completedWizard?.operationId === operationId) rememberWizardAttempt(completedWizard.tenantId, null);
          return;
        }
      } catch {
        if (generation === operationGeneration.current) {
          setOperation((current) => current?.id === operationId ? { ...current, checking: false, pollNote: 'Network error while refreshing operation status.' } : current);
          setPollingNotice('Status refresh failed; use Retry status or open Operations. The submission itself may still be running.');
        }
        return;
      }
    }
    if (generation === operationGeneration.current) {
      setOperation((current) => current?.id === operationId ? { ...current, checking: false, pollNote: 'Automatic status checks stopped after one minute.' } : current);
      setPollingNotice('Automatic checks stopped after one minute. You can refresh status or open the operation directly.');
    }
  }

  useEffect(() => {
    if (testAttempt?.state === 'ACCEPTED' && testAttempt.operationId && operation?.id !== testAttempt.operationId) {
      setOperation({ id: testAttempt.operationId, kind: 'test', detail: null, checking: true, pollNote: 'Checking the previously accepted test operation.' });
      void pollOperation(testAttempt.operationId, 'test');
      return;
    }
    if (wizardAttempt?.state === 'ACCEPTED' && wizardAttempt.operationId && operation?.id !== wizardAttempt.operationId) {
      setOperation({ id: wizardAttempt.operationId, kind: 'wizard', detail: null, checking: true, pollNote: 'Checking the previously accepted prompt proposal.' });
      void pollOperation(wizardAttempt.operationId, 'wizard');
    }
  }, [operation?.id, testAttempt, wizardAttempt]);

  function openConfirmation(kind: 'test' | 'wizard'): void {
    if (kind === 'test' && testAttempt) {
      setTestProblem({ status: 409, code: 'ATTEMPT_UNRESOLVED', title: 'Resolve the saved test request before starting another test.' });
      return;
    }
    if (kind === 'wizard' && wizardAttempt) {
      setWizardProblem({ status: 409, code: 'ATTEMPT_UNRESOLVED', title: 'Resolve the saved proposal request before starting another proposal.' });
      return;
    }
    if (kind === 'test' && !validateRequest()) return;
    if (kind === 'wizard' && (!selection || !selectedKeyAllowed || !wizardAvailable || !promptDraft.trim())) {
      setWizardProblem({ status: 422, code: 'INVALID_SCHEMA', title: 'Select an eligible Profile and active key, then enter the current prompt.' });
      return;
    }
    setConfirmAction(kind);
  }

  const filteredProfiles = profiles.filter((profile) => profile.profileName.toLowerCase().includes(profileQuery.trim().toLowerCase()));
  const placeholderDiffers = proposalDraft.trim() !== '' && !placeholderSafe;
  const activeSchema = selection && action ? selection.inputSchemas[action] : undefined;
  const actionProperties = activeSchema && isRecord(activeSchema['properties']) ? activeSchema['properties'] : {};
  const actionRequired = activeSchema && Array.isArray(activeSchema['required']) ? activeSchema['required'].filter((key): key is string => typeof key === 'string') : [];
  const formParameters = parseJsonObjectOrEmpty(parametersText);
  const lockedParametersOutsideSchema = selection && action ? Object.entries(selection.parameters).filter(([key, entry]) =>
    entry.isLocked === true && !secretLikeField(key) && !Object.hasOwn(actionProperties, parameterSchemaKey(selection.profile, key))) : [];
  const wizardPromptKey = selection ? promptParameterKey(selection, action || 'generate') : null;
  const diff = promptDiff(proposalBasePrompt || promptDraft, proposalDraft);
  const canOpenProfileEditor = session !== null && (session.role === 'admin' || session.localUser)
    && proposalAccepted && (!session.localUser || Boolean(selection?.profile.assigned && wizardPromptKey));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>API Docs and Test Workbench</CardTitle>
          <CardDescription>Operator tools use same-origin admin routes, active tenant-scoped Profiles and keys, and the admitted document-core workflow. Real tests may call a provider and incur charges.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Browser API surface</h3>
            <Badge variant="info">same-origin /admin/api</Badge>
          </div>
          <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-sm)] border border-[var(--border-subtle)]">
            {ENDPOINTS.map(([name, path, method]) => <li key={name} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-col"><span className="truncate text-sm font-medium">{name}</span><code className="truncate text-xs text-muted-foreground">{path}</code></div>
              <Badge variant="neutral" className="shrink-0">{method}</Badge>
            </li>)}
          </ul>
          {sessionState.kind === 'loading' ? <LoadingState title="Reading the admin session" description="The workbench is disabled until the server issues its CSRF proof and current tenant scope." /> : null}
          {sessionState.kind === 'failed' ? <AlertBanner variant="error" title="Admin session unavailable">{sessionState.problem.title ?? 'The session and CSRF proof could not be read. Retry by reloading this page.'}</AlertBanner> : null}
          {session && session.role === 'viewer' ? <AlertBanner variant="warning" title="Viewer access is read-only">The Test Endpoint and Prompt Wizard require an admin or operator session.</AlertBanner> : null}
          {session && !tenantId ? <AlertBanner variant="warning" title="Choose a tenant first">Select a tenant in the admin shell before loading tenant Profiles.</AlertBanner> : null}
          {session && tenantId ? <p className="text-xs text-[var(--text-sub)]">Tenant scope: <code>{tenantId}</code>{session.localUser ? ' · local USER assignment scope' : ''}</p> : null}
        </CardContent>
      </Card>

      {canUseWorkbench ? <Card>
        <CardHeader>
          <CardTitle>Test Endpoint</CardTitle>
          <CardDescription>Choose an active document-core Profile, one of its active assigned keys, and one allowed action. Files are uploaded to this tenant/key before the operation is submitted.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <div><label htmlFor="workbench-profile-search" className="mb-1 block text-sm font-medium">Find Profile</label><Input id="workbench-profile-search" value={profileQuery} onChange={(event) => setProfileQuery(event.target.value)} placeholder="Search Profile name" /></div>
            <div className="flex items-end gap-2"><Button variant="outline" onClick={() => setProfileRefresh((value) => value + 1)} disabled={profilesLoading} leftIcon={<RefreshCw className="size-4" />}>Refresh Profiles</Button></div>
          </div>
          {profilesLoading && profiles.length === 0 ? <LoadingState title="Loading authorized Profiles" description="The server is applying tenant and local assignment scope." /> : null}
          {profilesError ? <AlertBanner variant="error" title={profilesError.title ?? 'Profile catalog unavailable'}>{profilesError.status} · {profilesError.code ?? 'ERROR'} <button className="ml-2 underline" onClick={() => setProfileRefresh((value) => value + 1)}>Retry</button></AlertBanner> : null}
          {!profilesLoading && !profilesError && filteredProfiles.length === 0 ? <EmptyState title="No active document-core Profiles" description="This tenant has no enabled assigned document-core endpoint in the current search. Profiles and key assignments must be configured first." /> : null}
          {filteredProfiles.length > 0 ? <div className="grid gap-3 md:grid-cols-2">
            <div><label htmlFor="workbench-profile" className="mb-1 block text-sm font-medium">Profile</label><NativeSelect id="workbench-profile" value={selectedProfileValue} onChange={(event) => void chooseProfile(event.target.value)} disabled={selectionLoading || testBusy || wizardBusy}>
              <option value="">Choose a Profile</option>
              {filteredProfiles.map((profile) => <option key={profile.key} value={profile.key}>{profile.profileName} · rev {profile.revision} · {profile.businessVersion}{profile.actions.length ? ` · ${profile.actions.join(', ')}` : ' · no supported action'}</option>)}
            </NativeSelect></div>
            <div><label htmlFor="workbench-key" className="mb-1 block text-sm font-medium">Active API key assigned to Profile</label><NativeSelect id="workbench-key" value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)} disabled={!selection || selectionLoading || testBusy || wizardBusy || keysLoading}>
              <option value="">Choose an active key</option>
              {selection?.keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}
            </NativeSelect></div>
          </div> : null}
          {profileCursor ? <Button variant="outline" size="sm" onClick={() => void loadMoreProfiles()} disabled={profilesLoading}>Load more Profiles ({profiles.length} of {profileTotal})</Button> : null}
          {session?.localUser && selection?.profile.assigned ? <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3">
            <div className="min-w-[14rem] flex-1"><label htmlFor="assigned-key-search" className="mb-1 block text-sm font-medium">Search assigned active keys</label><Input id="assigned-key-search" value={keyQuery} onChange={(event) => setKeyQuery(event.target.value)} placeholder="Name or prefix" /></div>
            <Button size="sm" variant="outline" onClick={() => void searchAssignedKeys()} disabled={keysLoading || testBusy || wizardBusy}>Search keys</Button>
            {keyCursor ? <Button size="sm" variant="outline" onClick={() => void searchAssignedKeys(keyCursor)} disabled={keysLoading || testBusy || wizardBusy}>Load more keys ({selection.keys.length} of {keyTotal})</Button> : null}
          </div> : null}
          {selectionLoading ? <LoadingState title="Loading Profile bindings and active keys" description="The workbench rechecks the exact Profile revision and membership before enabling execution." /> : null}
          {selectionError ? <AlertBanner variant="error" title={selectionError.title ?? 'Profile details unavailable'}>{selectionError.status} · {selectionError.code ?? 'ERROR'} <button className="ml-2 underline" onClick={() => selectionError.code === 'PROFILE_CHANGED' ? setProfileRefresh((value) => value + 1) : setSelectionRefresh((value) => value + 1)}>Retry Profile and key details</button></AlertBanner> : null}
          {selection ? <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-sub)]"><span>Business <code>{selection.profile.businessId}</code></span><span>Revision <code>{selection.profile.revision}</code></span><span>Allowed actions <code>{selection.profile.actions.join(', ') || 'none'}</code></span></div>
            <div className="grid gap-3 md:grid-cols-2">
              <div><label htmlFor="workbench-action" className="mb-1 block text-sm font-medium">Action</label><NativeSelect id="workbench-action" value={action} onChange={(event) => requestActionChange(event.target.value as WorkbenchAction | '')} disabled={testBusy || wizardBusy}>
                <option value="">Choose an allowed action</option>{ACTIONS.filter((candidate) => selection.profile.actions.includes(candidate)).map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
              </NativeSelect></div>
              <div><label htmlFor="workbench-source-url" className="mb-1 block text-sm font-medium">Optional source URL</label><Input id="workbench-source-url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://… or tenant-authorized s3://…" disabled={testBusy || wizardBusy} /></div>
            </div>
            <section aria-labelledby="workbench-parameter-title" className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3">
              <div><h3 id="workbench-parameter-title" className="text-sm font-semibold">Action parameters</h3><p className="text-xs text-[var(--text-sub)]">Fields come from the active document-core manifest and selected Profile. Locked values remain server-managed and are omitted from the test override.</p></div>
              {action && Object.keys(actionProperties).length > 0 ? <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(actionProperties).map(([key, rawDefinition]) => {
                  if (secretLikeField(key)) return null;
                  const definition = recordValue(rawDefinition);
                  const parameterKey = Object.keys(selection.parameters).find((candidate) => parameterSchemaKey(selection.profile, candidate) === key) ?? key;
                  const locked = selection.parameters[parameterKey]?.isLocked === true;
                  const error = parameterFieldErrors[key];
                  const title = typeof definition['title'] === 'string' ? definition['title'] : key;
                  const description = typeof definition['description'] === 'string' ? definition['description'] : locked ? 'Locked by this Profile; the server applies its stored value.' : undefined;
                  const helpId = `workbench-param-help-${key}`;
                  const errorId = `workbench-param-error-${key}`;
                  const describedBy = [description ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
                  const rawType = definition['type'];
                  const types = Array.isArray(rawType) ? rawType.filter((item): item is string => typeof item === 'string' && item !== 'null') : typeof rawType === 'string' ? [rawType] : [];
                  const value = Object.hasOwn(formParameters, key) ? formParameters[key] : definition['default'];
                  const enumValues = Array.isArray(definition['enum']) ? definition['enum'].filter((item) => item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') : [];
                  const enumIndex = enumValues.findIndex((candidate) => Object.is(candidate, value));
                  const fieldType = enumValues.length > 0 ? 'enum' : types.includes('object') && (types.length === 1 || isRecord(value)) ? 'object' : types.includes('array') && (types.length === 1 || Array.isArray(value)) ? 'array' : types.includes('integer') ? 'integer' : types.includes('number') ? 'number' : types.includes('boolean') ? 'boolean' : 'string';
                  return <div key={key} className="min-w-0">
                    <label htmlFor={`workbench-param-${key}`} className="mb-1 block text-sm font-medium">{title}{actionRequired.includes(key) ? <span aria-hidden="true"> *</span> : null}</label>
                    {locked ? <Input id={`workbench-param-${key}`} value="Managed by this Profile" disabled aria-describedby={describedBy} />
                      : fieldType === 'boolean' ? <label className="flex h-9 items-center gap-2 text-sm"><input id={`workbench-param-${key}`} type="checkbox" checked={value === true} disabled={testBusy || wizardBusy} aria-describedby={describedBy} onChange={(event) => updateParameter(key, event.target.checked)} /><span>{value === true ? 'Enabled' : 'Disabled'}</span></label>
                        : fieldType === 'enum' ? <NativeSelect id={`workbench-param-${key}`} value={enumIndex < 0 ? '' : String(enumIndex)} isError={Boolean(error)} aria-required={actionRequired.includes(key)} aria-invalid={error ? true : undefined} aria-describedby={describedBy} disabled={testBusy || wizardBusy} onChange={(event) => { const index = Number(event.target.value); updateParameter(key, Number.isInteger(index) && index >= 0 ? enumValues[index] : undefined); }}><option value="">Choose…</option>{enumValues.map((entry, index) => <option key={`${key}-${index}`} value={String(index)}>{entry === null ? 'null' : String(entry)}</option>)}</NativeSelect>
                          : fieldType === 'object' || fieldType === 'array' ? <textarea id={`workbench-param-${key}`} aria-required={actionRequired.includes(key)} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className="min-h-24 w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2 font-mono text-xs" value={parameterFieldDrafts[key] ?? JSON.stringify(value ?? (fieldType === 'array' ? [] : {}), null, 2)} disabled={testBusy || wizardBusy} spellCheck={false} onChange={(event) => { const text = event.target.value; setParameterFieldDrafts((current) => ({ ...current, [key]: text })); try { const parsed: unknown = JSON.parse(text); if ((fieldType === 'array' && !Array.isArray(parsed)) || (fieldType === 'object' && !isRecord(parsed))) throw new Error(`Enter a JSON ${fieldType}.`); updateParameter(key, parsed); } catch (parseError) { if (parseError instanceof SyntaxError || parseError instanceof Error && parseError.message.startsWith('Enter a JSON')) setParameterFieldErrors((current) => ({ ...current, [key]: parseError.message })); } }} />
                            : fieldType === 'number' || fieldType === 'integer' ? <Input id={`workbench-param-${key}`} type="number" step={fieldType === 'integer' ? '1' : 'any'} min={typeof definition['minimum'] === 'number' ? definition['minimum'] : undefined} max={typeof definition['maximum'] === 'number' ? definition['maximum'] : undefined} aria-required={actionRequired.includes(key)} aria-invalid={error ? true : undefined} aria-describedby={describedBy} value={parameterFieldDrafts[key] ?? (typeof value === 'number' ? String(value) : '')} disabled={testBusy || wizardBusy} onChange={(event) => { const text = event.target.value; setParameterFieldDrafts((current) => ({ ...current, [key]: text })); if (text === '') { updateParameter(key, undefined); return; } const numeric = Number(text); if (Number.isFinite(numeric) && (fieldType !== 'integer' || Number.isInteger(numeric))) updateParameter(key, numeric); else setParameterFieldErrors((current) => ({ ...current, [key]: `Enter a valid ${fieldType}.` })); }} />
                              : <Input id={`workbench-param-${key}`} type="text" minLength={typeof definition['minLength'] === 'number' ? definition['minLength'] : undefined} maxLength={typeof definition['maxLength'] === 'number' ? definition['maxLength'] : undefined} pattern={typeof definition['pattern'] === 'string' ? definition['pattern'] : undefined} aria-required={actionRequired.includes(key)} aria-invalid={error ? true : undefined} aria-describedby={describedBy} value={typeof value === 'string' ? value : ''} disabled={testBusy || wizardBusy} onChange={(event) => updateParameter(key, event.target.value)} />}
                    {description ? <p id={helpId} className="mt-1 text-xs text-[var(--text-sub)]">{description}</p> : null}
                    {error ? <p id={errorId} role="alert" className="mt-1 text-xs text-[var(--badge-danger-text)]">{error}</p> : null}
                  </div>;
                })}
              </div> : action ? <AlertBanner variant="warning" title="Action schema unavailable">This Profile read did not include input metadata for <code>{action}</code>. Use the advanced JSON fallback or refresh the Profile.</AlertBanner> : <p className="text-sm text-[var(--text-sub)]">Choose an allowed action to load its schema-driven form.</p>}
              {lockedParametersOutsideSchema.length > 0 ? <fieldset className="space-y-2 border-t border-[var(--border-subtle)] pt-3"><legend className="px-1 text-xs font-medium">Other locked Profile values</legend>{lockedParametersOutsideSchema.map(([key]) => <label key={key} className="grid gap-1 text-xs text-[var(--text-sub)]">{key} · locked<input value="Managed by this Profile" disabled aria-label={`${key} locked by Profile`} className="h-9 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-muted)] px-2 text-sm" /></label>)}</fieldset> : null}
              {parametersError ? <p role="alert" className="text-xs text-[var(--badge-danger-text)]">{parametersError}</p> : null}
              {lockedOmittedNotice ? <AlertBanner variant="info" title="Locked values omitted">{lockedOmittedNotice}</AlertBanner> : null}
              <details><summary className="cursor-pointer text-sm font-medium">Advanced parameters JSON</summary><label htmlFor="workbench-parameters" className="mb-1 mt-2 block text-xs text-[var(--text-sub)]">Edit declared objects, arrays, or additional fields here.</label><textarea id="workbench-parameters" aria-invalid={parametersError ? true : undefined} className="min-h-36 w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 font-mono text-xs" value={parametersText} onChange={(event) => { setParametersText(event.target.value); setParameterFieldDrafts({}); setParameterFieldErrors({}); setParametersError(null); }} disabled={testBusy || wizardBusy} spellCheck={false} /></details>
              <details><summary className="cursor-pointer text-sm font-medium">Redacted public API cURL placeholder</summary>{action ? <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--bg-muted)] p-3 text-xs">{`curl -i -X POST "$DU_ORCHESTRATOR_BASE/api/v1/docs/${action}" \\\n  -H "x-api-key: $DU_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  --data-raw '{"parameters":{"${actionDiscriminator(action)}":"<choose an allowed value>"}}'`}</pre> : <p className="mt-2 text-xs text-[var(--text-sub)]">Choose an action to see its public compatibility route.</p>}<p className="mt-2 text-xs text-[var(--text-sub)]">Placeholders only. Use an authorized client-side environment variable for the API key; this screen never reads or prints stored key material. Selected files require the public multipart form.</p></details>
              <p className="text-xs text-[var(--text-sub)]">Parameters are limited to 32 KiB. Files are attached separately.</p>
            </section>
            <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="workbench-files" className="text-sm font-medium">Input files (up to 20)</label><Badge variant="neutral">{uploadedArtifacts.length} uploaded · {files.length} waiting</Badge></div>
              <input ref={fileInputRef} id="workbench-files" type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} disabled={!selectedKeyAllowed || testBusy || wizardBusy} className="mt-2 block w-full text-sm" />
              {files.length > 0 ? <p className="mt-2 text-xs text-[var(--text-sub)]">{files.map((file) => file.name).join(', ')}</p> : null}
              {uploadedArtifacts.length > 0 ? <div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-xs text-[var(--text-sub)]">Files are attached to the current draft request.</span><Button size="sm" variant="ghost" disabled={testBusy || wizardBusy} onClick={() => { setUploadedArtifacts([]); setFiles([]); if (fileInputRef.current) fileInputRef.current.value = ''; }}>Clear files</Button></div> : null}
            </div>
            {testProblem ? <AlertBanner variant="error" title={testProblem.title ?? 'Test could not be submitted'}>{testProblem.status} · {testProblem.code ?? 'ERROR'}{testProblem.correlationId ? ` · ${testProblem.correlationId}` : ''}</AlertBanner> : null}
            {testAttempt?.state === 'UNCERTAIN' || testAttempt?.state === 'SENDING' ? <AlertBanner variant="warning" title="Saved test request needs resolution">This exact request belongs to tenant <code>{testAttempt.tenantId}</code>. Replay keeps its original key and uploaded artifact references; form edits are not submitted.</AlertBanner> : null}
            {testAttempt?.state === 'ACCEPTED' && testAttempt.operationId ? <AlertBanner variant="info" title="Test operation already accepted">Operation <code>{testAttempt.operationId}</code> is being tracked. Check its status before starting another test.</AlertBanner> : null}
            <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-xs text-[var(--text-sub)]">Tests run through normal admission, assignment, profile, budget and workflow checks. No simulation is presented as a completed test.</p><div className="flex flex-wrap gap-2">{testAttempt && testAttempt.state !== 'ACCEPTED' ? <Button variant="outline" onClick={() => void retryTestAttempt()} disabled={testBusy || wizardBusy || uploading || testAttempt.tenantId !== tenantId}>Retry exact saved test</Button> : null}<Button onClick={() => openConfirmation('test')} disabled={testBusy || wizardBusy || uploading || Boolean(testAttempt) || !selectedActionAllowed || !selectedKeyAllowed}>Review real test</Button></div></div>
          </> : null}
        </CardContent>
      </Card> : null}

      {canUseWorkbench && selection ? <Card>
        <CardHeader>
          <CardTitle>Prompt Wizard</CardTitle>
          <CardDescription>Propose a prompt revision through the selected Profile’s actual reasoning Connector. The generated result stays a local draft; this screen never publishes a Profile.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!wizardAvailable ? <AlertBanner variant="warning" title="Prompt Wizard unavailable">This Profile must pin an active <code>ext-prompt-wizard</code> revision in its reasoning slot. The workbench does not invent a Connector mapping.</AlertBanner> : <AlertBanner variant="info" title="Pinned Wizard Connector">The Profile pins <code>{wizardBinding!.connectorId}</code> revision <code>{wizardBinding!.revision}</code>. The server verifies that exact active tenant-authorized revision on submit.</AlertBanner>}
          <div><label htmlFor="wizard-current-prompt" className="mb-1 block text-sm font-medium">Current prompt</label><textarea id="wizard-current-prompt" className="min-h-32 w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 text-sm" maxLength={16_000} value={promptDraft} onChange={(event) => { setPromptDraft(event.target.value); setProposalBasePrompt(event.target.value); setProposalAccepted(false); }} disabled={wizardBusy || testBusy} placeholder="Enter or adjust the current prompt. Template placeholders are preserved and checked before using a proposal." /><p className="mt-1 text-xs text-[var(--text-sub)]">{promptDirty ? 'Unsaved prompt text is a local draft and will not change the Profile.' : 'A matching prompt parameter was prefilled when available; profile overrides remain untouched.'}</p></div>
          <div><label htmlFor="wizard-problem" className="mb-1 block text-sm font-medium">What should improve?</label><textarea id="wizard-problem" className="min-h-20 w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 text-sm" maxLength={4_000} value={problemText} onChange={(event) => setProblemText(event.target.value)} disabled={wizardBusy || testBusy} placeholder="Optional: describe a specific issue with clarity, constraints, or output format." /></div>
          {wizardProblem ? <AlertBanner variant="error" title={wizardProblem.title ?? 'Prompt proposal could not be submitted'}>{wizardProblem.status} · {wizardProblem.code ?? 'ERROR'}</AlertBanner> : null}
          {wizardAttempt?.state === 'UNCERTAIN' || wizardAttempt?.state === 'SENDING' ? <AlertBanner variant="warning" title="Saved proposal request needs resolution">This exact request belongs to tenant <code>{wizardAttempt.tenantId}</code>. Replay uses the original prompt, Profile revision, Connector pin, key, and idempotency key.</AlertBanner> : null}
          {wizardAttempt?.state === 'ACCEPTED' && wizardAttempt.operationId ? <AlertBanner variant="info" title="Prompt proposal already accepted">Operation <code>{wizardAttempt.operationId}</code> is being tracked. Check its status before starting another proposal.</AlertBanner> : null}
          {proposalDraft ? <div className="space-y-3"><div><label htmlFor="wizard-proposal" className="mb-1 block text-sm font-medium">Proposal draft</label><textarea id="wizard-proposal" className="min-h-40 w-full rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 text-sm" maxLength={16_000} value={proposalDraft} onChange={(event) => { setProposalDraft(event.target.value); setProposalAccepted(false); }} disabled={wizardBusy} /><p className="mt-1 text-xs text-[var(--text-sub)]">Review the change below. Accepting updates only this browser’s request draft; Profile edits remain a separate explicit save.</p>{placeholderDiffers ? <AlertBanner variant="error" title="Template placeholders changed">The proposal placeholder set differs from the current prompt. Review or correct it before accepting.</AlertBanner> : <p className="mt-1 text-xs text-[var(--text-sub)]">Template placeholders match the current prompt.</p>}</div>
            <section aria-labelledby="wizard-diff-title" className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3"><h3 id="wizard-diff-title" className="mb-2 text-sm font-semibold">Prompt diff</h3><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs"><span>{diff.prefix}</span><del className="rounded bg-[var(--badge-danger-bg)] text-[var(--badge-danger-text)]">{diff.removed || (diff.added ? '' : 'No text changes')}</del><ins className="rounded bg-[var(--badge-success-bg)] text-[var(--badge-success-text)]">{diff.added}</ins><span>{diff.suffix}</span></pre></section>
            <div className="flex flex-wrap items-center gap-2"><Button variant="outline" onClick={acceptProposal} disabled={!placeholderSafe || wizardBusy || testBusy || Boolean(session?.localUser && !wizardPromptKey)}>Accept proposal to local draft</Button>{proposalAccepted ? <span role="status" className="text-sm text-[var(--text-sub)]">Accepted into the local prompt and parameter draft. Nothing has been saved or published.</span> : null}{canOpenProfileEditor && selection ? <Link className="inline-flex items-center gap-1 text-sm underline" to="/profiles" state={{ workbenchPromptProposal: { handoffId: proposalHandoffId, businessId: selection.profile.businessId, businessVersion: selection.profile.businessVersion, profileName: selection.profile.profileName, expectedRevision: selection.profile.revision, tenantId: session?.localUser ? undefined : tenantId, profileId: selection.profile.assigned?.profileId, parameterKey: wizardPromptKey, prompt: promptDraft } }}>Open Profile editor with this draft <ExternalLink className="size-3.5" /></Link> : null}</div>
            {session?.localUser && !wizardPromptKey ? <p className="text-xs text-[var(--text-sub)]">This assigned endpoint has no unlocked prompt parameter in its active schema, so a generated proposal cannot be applied to the assigned Profile.</p> : null}
          </div> : null}
          {operation?.kind === 'wizard' && operation.detail?.resultSummary ? <details className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3"><summary className="cursor-pointer text-sm font-medium">Operation result details</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{operation.detail.resultSummary}</pre></details> : null}
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-xs text-[var(--text-sub)]">The wizard uses the real <code>generate</code> action and selected active key. It may incur provider cost and is separately confirmed below.</p><div className="flex flex-wrap gap-2">{wizardAttempt && wizardAttempt.state !== 'ACCEPTED' ? <Button variant="outline" onClick={() => void retryWizardAttempt()} disabled={wizardBusy || testBusy || wizardAttempt.tenantId !== tenantId}>Retry exact saved proposal</Button> : null}<Button variant="outline" onClick={() => openConfirmation('wizard')} disabled={!wizardAvailable || wizardBusy || testBusy || Boolean(wizardAttempt) || !selectedKeyAllowed || action !== 'generate' || !promptDraft.trim()}>Review prompt proposal</Button></div></div>
        </CardContent>
      </Card> : null}

      {operation ? <Card>
        <CardHeader><CardTitle>{operation.kind === 'wizard' ? 'Prompt proposal operation' : 'Test operation'}</CardTitle><CardDescription>Operation <code>{operation.id}</code> is tracked by the platform.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><Badge variant={operation.detail?.operation?.state === 'SUCCEEDED' ? 'success' : terminal(operation.detail?.operation?.state) ? 'danger' : 'info'}>{operation.detail?.operation?.state ?? (operation.checking ? 'CHECKING' : 'ACCEPTED')}</Badge><Link className="inline-flex items-center gap-1 text-sm underline" to={`/operations?operation=${encodeURIComponent(operation.id)}`}>Open Operations <ExternalLink className="size-3.5" /></Link><Button size="sm" variant="outline" onClick={() => void pollOperation(operation.id, operation.kind)} disabled={operation.checking}><RefreshCw className="mr-1 size-3.5" />Refresh status</Button></div>
          {operation.pollNote ? <p className="text-xs text-[var(--text-sub)]">{operation.pollNote}</p> : null}
          {pollingNotice ? <AlertBanner variant="warning" title="Operation status needs attention">{pollingNotice}</AlertBanner> : null}
          {operation.detail?.operation?.errorCode ? <AlertBanner variant="error" title="Operation failed">{operation.detail.operation.errorCode}</AlertBanner> : null}
          {operation.detail?.resultSummary ? <details className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3"><summary className="cursor-pointer text-sm font-medium">Result and usage details</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{operation.detail.resultSummary}</pre></details> : null}
          {operation.detail?.artifacts.length ? <div><h4 className="mb-2 text-sm font-semibold">Operation artifacts</h4><ul className="space-y-2">{operation.detail.artifacts.map((artifact, index) => {
            const href = safeDownloadHref(artifact.downloadUrl);
            return <li key={`${artifact.role}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-2 text-sm"><span>{artifact.role} · {artifact.status}</span>{href ? <a className="underline" href={href} target="_blank" rel="noreferrer">Download result</a> : <span className="text-xs text-[var(--text-sub)]">No safe download link available</span>}</li>;
          })}</ul></div> : null}
        </CardContent>
      </Card> : null}

      <Modal open={confirmAction !== null} onOpenChange={(open) => { if (!open && !testBusy && !wizardBusy) setConfirmAction(null); }} title={confirmAction === 'wizard' ? 'Confirm real prompt proposal' : 'Confirm real Test Endpoint'} description="This submits through normal workflow admission and can call an external provider." footer={<div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" disabled={testBusy || wizardBusy} onClick={() => setConfirmAction(null)}>Go back</Button><Button disabled={testBusy || wizardBusy || uploading} onClick={() => confirmAction === 'wizard' ? void submitWizard() : void submitTest()}>{testBusy || wizardBusy || uploading ? 'Submitting…' : confirmAction === 'wizard' ? 'Submit prompt proposal' : 'Submit test operation'}</Button></div>}>
        <div className="space-y-3"><AlertBanner variant="warning" title="Provider request and possible charges">The operation will use the selected tenant, active key, Profile revision and server-side policies. It may contact the real provider and incur cost.</AlertBanner><dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"><dt>Tenant</dt><dd className="break-all font-mono">{tenantId ?? '—'}</dd><dt>Profile</dt><dd>{selection?.profile.profileName ?? '—'} · revision {selection?.profile.revision ?? '—'}</dd><dt>Key</dt><dd className="break-all font-mono">{selection?.keys.find((key) => key.id === selectedKey)?.label ?? '—'}</dd><dt>Operation</dt><dd>{confirmAction === 'wizard' ? 'Prompt Wizard proposal' : `${action} Test Endpoint`}</dd><dt>Files</dt><dd>{uploadedArtifacts.length + files.length}</dd></dl><p className="text-xs text-[var(--text-sub)]">No provider call is made until you press the submission button. The resulting operation remains visible in Operations.</p></div>
      </Modal>

      <Modal open={switchConfirmOpen} onOpenChange={(open) => { if (!open) { setSwitchConfirmOpen(false); setSwitchTarget(null); } }} title={switchTarget?.kind === 'action' ? 'Discard action parameter draft?' : 'Discard this local workbench draft?'} description={switchTarget?.kind === 'action' ? `Changing action to ${switchTarget.action || 'no action'} resets only the parameter fields.` : 'Changing Profiles clears the current prompt and request inputs; no Profile revision has been changed.'} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => { setSwitchConfirmOpen(false); setSwitchTarget(null); }}>Keep current draft</Button><Button onClick={commitDraftSwitch}>{switchTarget?.kind === 'action' ? 'Discard parameters and change action' : 'Discard draft and switch'}</Button></div>}><p className="text-sm">{switchTarget?.kind === 'action' ? 'Your current action parameter values will be reset to the new action’s Profile values and schema defaults. Other request and prompt drafts stay intact.' : 'Unsaved prompt text, parameters, source URL, selected files and unsubmitted artifact references will be cleared.'}</p></Modal>
    </div>
  );
}
