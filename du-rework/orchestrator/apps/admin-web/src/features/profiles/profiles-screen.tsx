import { InitialBindings, type InitialBinding } from './initial-bindings';
import { Fragment, type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ReferenceInput, type ReferenceOptionPage } from '@/components/ui/reference-input';
import { Modal } from '@/components/ui/dialog';
import { AlertBanner, DeniedState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TablePagination, TableRow } from '@/components/ui/table';
import { TabsList, TabsPanel, TabsRoot, TabsTab } from '@/components/ui/tabs';
import {
  createAdminApiClient,
  type AdminWebSession,
  type AdminApiProblem,
  type ConnectionStep,
  type FileUrlAuthConfigWrite,
  type ProfileDetail,
  type ProfileGroupFunctionCatalog,
  type ProfileListPage,
  type ProfileWorkflowItem,
  type RequestRedactionRule,
  type ProfileSelfServiceAssignedPage,
  type ProfileSelfServiceAssignedApiKeyPage,
  type ApiKeyRow,
} from '@/lib/api';
import { groupProfileListRows, profileErrorHint, parseProfileDetail, parseProfileListPage, parseProfileWorkflowPage } from './state';
import { buildPublishBody, buildRollbackBody, buildUpsertBody } from './command-bodies';
import { RequestRedactionEditor } from './request-redaction-editor';
import { CallbackPolicyEditor } from './callback-policy-editor';
import { buildCallbackPolicy, callbackPolicyFromRead, emptyCallbackDraft, validateCallbackDraft, type CallbackDraft } from './callback-policy';
import { ProfileApiKeysPanel } from './api-keys-panel';
import { parseSecretListPage } from '@/features/secrets/state';
import type { SecretOption } from '@/features/secrets/value-source-selector';
import { useTenant } from '@/lib/tenant-context';
import { parseBusinessPage, parseBusinessVersions } from '@/features/businesses/state';
import { isLegacyConnectionId, settingsResponseMatchesScope, settingsScopeKey } from '@/features/settings/scope';
import { ProfileGroupEditor } from './profile-group-editor';
import { parseProfileGroupFunctionCatalog } from './profile-group-state';
import { actionFromEndpointSlug, firstSuccessfulProfileTarget, newProfileAction, normalizeProfileTarget, profileTargetAfterSave, resolveProfileIdentityFromCatalog, type SavedProfileTarget } from './profile-identity';
import { createProfileRequestScope, findCurrentActiveProfileApiKey } from './profile-request-scope';
import { Link, useLocation, useNavigate } from 'react-router';

type Priority = 'LOW' | 'MEDIUM' | 'HIGH';
type FileUrlAuthType = 'none' | 'bearer' | 'header' | 'query';

interface ParamDraft {
  key: string;
  value: string;
  isLocked: boolean;
}

/**
 * UI-internal draft row (NOT part of the frozen read wire). The loaded detail
 * seeds one row from its single `policy`; operators may add more rows to bulk
 * upsert several profile keys in one pass (T-UI-04).
 */
interface RowDraft {
  /** Resource identity in profile_names; remains independent from manifest action. */
  profileName: string;
  /** Manifest action this named profile governs. */
  action: string;
  /** Endpoint selector for this row; empty means its action is generic. */
  endpointSlug: string;
  enabled: boolean;
  jobPriority: Priority;
  extensionsCsv: string;
  params: ParamDraft[];
  connSteps: ConnectionStep[];
  requestRedaction: RequestRedactionRule[];
  /** CB-04: null = inherit (absent policy preserves notification-only). */
  callback: CallbackDraft | null;
  /** A policy exists on the server for this revision. */
  callbackConfiguredOnServer: boolean;
  /** WT-04: stored pin failed validation; only an explicit clear/replacement repairs it. */
  callbackPolicyInvalid: boolean;
  /** Operator unchecked the box after a stored policy: send explicit null. */
  callbackClearPending: boolean;
}

interface FileUrlAuthDraft {
  touched: boolean;
  type: FileUrlAuthType;
  token: string;
  header_name: string;
  header_value: string;
  query_key: string;
  query_value: string;
}

interface Draft {
  rows: RowDraft[];
  fileUrlAuth: FileUrlAuthDraft;
  prompt: { connectionId: string; apiKeyId: string; endpointSlug: string; stepId: string; text: string; isActive: boolean };
}

interface RowResult {
  profileName: string;
  ok: boolean;
  detail: string;
}

interface SaveRowOutcome {
  result: RowResult;
  problem?: AdminApiProblem;
  savedTarget?: SavedProfileTarget;
}

type AssignedProfile = ProfileSelfServiceAssignedPage['items'][number];
type AssignedApiKey = ProfileSelfServiceAssignedApiKeyPage['items'][number];
type ProfileApiKeyOption = Pick<ApiKeyRow, 'id' | 'tenantId' | 'name' | 'status'>;
const PROFILE_API_KEY_REQUIRED_MESSAGE = 'Select an active API key for the current tenant before saving, publishing, or rolling back this Profile.';
const PROFILE_TENANT_SCOPE_REQUIRED_MESSAGE = 'Select a tenant and load a Profile for that tenant before saving, publishing, or rolling back.';
type WorkbenchPromptProposal = {
  handoffId: string;
  businessId: string;
  businessVersion: string;
  profileName: string;
  expectedRevision: number;
  tenantId?: string;
  profileId?: string;
  parameterKey?: string | null;
  prompt: string;
};

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function initialBindingsFromProfile(profile: ProfileDetail | null): InitialBinding[] {
  return profile === null
    ? []
    : Object.entries(profile.connectorBindings).map(([slot, pin]) => ({
        slot,
        connectorId: pin.connectorId,
        revision: pin.revision,
      }));
}

function normalizedConnectorBindingEntries(bindings: readonly InitialBinding[]): Array<[string, string, number]> {
  const entries: Array<[string, string, number]> = [];
  for (const binding of bindings) {
    const slot = binding.slot.trim();
    if (slot.length === 0 || slot.length > 128
        || binding.connectorId.trim().length === 0 || binding.connectorId.length > 128
        || !Number.isSafeInteger(binding.revision) || binding.revision < 1) continue;
    entries.push([slot, binding.connectorId, binding.revision]);
  }
  const counts = new Map<string, number>();
  for (const [slot] of entries) counts.set(slot, (counts.get(slot) ?? 0) + 1);
  return entries
    .filter(([slot]) => counts.get(slot) === 1)
    .sort(([leftSlot, leftConnector, leftRevision], [rightSlot, rightConnector, rightRevision]) =>
      leftSlot.localeCompare(rightSlot)
        || leftConnector.localeCompare(rightConnector)
        || leftRevision - rightRevision);
}

function connectorBindingsChanged(
  bindings: readonly InitialBinding[],
  savedBindings: ProfileDetail['connectorBindings'],
): boolean {
  const savedRows = Object.entries(savedBindings).map(([slot, pin]) => ({ slot, ...pin }));
  return JSON.stringify(normalizedConnectorBindingEntries(bindings))
    !== JSON.stringify(normalizedConnectorBindingEntries(savedRows));
}

function parseWorkbenchPromptProposal(value: unknown): WorkbenchPromptProposal | null {
  const wrapper = recordValue(value);
  const item = recordValue(wrapper['workbenchPromptProposal']);
  if (item['businessId'] !== 'document-core'
      || typeof item['handoffId'] !== 'string' || item['handoffId'].length > 128
      || typeof item['businessVersion'] !== 'string' || item['businessVersion'].length > 128
      || typeof item['profileName'] !== 'string' || item['profileName'].length > 255
      || typeof item['expectedRevision'] !== 'number' || !Number.isSafeInteger(item['expectedRevision']) || item['expectedRevision'] < 1
      || typeof item['prompt'] !== 'string' || item['prompt'].trim().length === 0 || item['prompt'].length > 16_000) return null;
  if (item['tenantId'] !== undefined && (typeof item['tenantId'] !== 'string' || item['tenantId'].length > 128)) return null;
  if (item['profileId'] !== undefined && (typeof item['profileId'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(item['profileId']))) return null;
  if (item['parameterKey'] !== undefined && item['parameterKey'] !== null && (typeof item['parameterKey'] !== 'string' || item['parameterKey'].length > 128)) return null;
  return {
    handoffId: item['handoffId'],
    businessId: 'document-core',
    businessVersion: item['businessVersion'],
    profileName: item['profileName'],
    expectedRevision: item['expectedRevision'],
    ...(typeof item['tenantId'] === 'string' ? { tenantId: item['tenantId'] } : {}),
    ...(typeof item['profileId'] === 'string' ? { profileId: item['profileId'] } : {}),
    ...(typeof item['parameterKey'] === 'string' ? { parameterKey: item['parameterKey'] } : {}),
    prompt: item['prompt'],
  };
}

function parameterValuesFor(item: AssignedProfile): Record<string, unknown> {
  const properties = recordValue(item.inputSchema.properties);
  const values: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(properties)) {
    const draftKey = Object.keys(item.parameters).find((candidate) => parameterSchemaKey(item, candidate) === key) ?? key;
    const current = item.parameters[draftKey];
    if (current !== undefined) values[draftKey] = current.value;
    else if (typeof definition === 'object' && definition !== null && Object.hasOwn(definition, 'default')) {
      values[draftKey] = (definition as Record<string, unknown>).default;
    }
  }
  for (const [key, current] of Object.entries(item.parameters)) values[key] = current.value;
  return values;
}

function parameterSchemaKey(item: AssignedProfile, key: string): string {
  if (item.endpointSlug && item.action === 'transform' && key === 'action') return 'variant';
  if (!item.endpointSlug) return key;
  return key.replace(/_+([a-zA-Z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

function AssignedProfilesWorkspace({
  client,
  tenantId,
  proposalDraft,
  onProposalConsumed,
}: {
  client: ReturnType<typeof createAdminApiClient>;
  tenantId: string;
  proposalDraft: WorkbenchPromptProposal | null;
  onProposalConsumed: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [page, setPage] = useState<ProfileSelfServiceAssignedPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<AdminApiProblem | null>(null);
  const [selected, setSelected] = useState<AssignedProfile | null>(null);
  const [keys, setKeys] = useState<AssignedApiKey[]>([]);
  const [keyQuery, setKeyQuery] = useState('');
  const [keyPage, setKeyPage] = useState<ProfileSelfServiceAssignedApiKeyPage | null>(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({});
  const [baseValues, setBaseValues] = useState<Record<string, unknown>>({});
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [draftConnections, setDraftConnections] = useState<AssignedProfile['connectionsOverride']>([]);
  const [baseConnections, setBaseConnections] = useState<AssignedProfile['connectionsOverride']>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyNextCursor, setKeyNextCursor] = useState<string | null>(null);
  const [assignedPageCursors, setAssignedPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [assignedPageIndex, setAssignedPageIndex] = useState(0);
  const [conflictRow, setConflictRow] = useState<AssignedProfile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const assignedScopeRef = useRef(tenantId);
  const keyGeneration = useRef(0);
  const saveInFlight = useRef(false);
  const proposalHandoffAttempt = useRef('');
  const workbenchId = useMemo(() => `assigned-${crypto.randomUUID()}`, []);

  useLayoutEffect(() => {
    if (assignedScopeRef.current === tenantId) return;
    assignedScopeRef.current = tenantId;
    searchGeneration.current += 1;
    setLoading(false);
    setProblem(null);
    setPage(null);
    setQuery('');
    setActiveQuery('');
    setAssignedPageCursors([undefined]);
    setAssignedPageIndex(0);
  }, [tenantId]);

  async function fetchAssigned(next?: string | null, queryValue = activeQuery): Promise<ProfileSelfServiceAssignedPage | null> {
    const requestTenantId = tenantId;
    const generation = ++searchGeneration.current;
    setLoading(true);
    setProblem(null);
    try {
      const result = await client.listAssignedProfileEndpoints({ query: queryValue.trim() || undefined, cursor: next ?? undefined, limit: 50 });
      if (generation !== searchGeneration.current || assignedScopeRef.current !== requestTenantId) return null;
      if (!result.ok) {
        setProblem(result.problem);
        return null;
      }
      if (result.data.tenantId !== tenantId) {
        setProblem({ status: 502, code: 'SCOPE_MISMATCH', title: 'The assigned Profile response belongs to a different session tenant.' });
        return null;
      }
      return result.data;
    } catch {
      if (generation === searchGeneration.current && assignedScopeRef.current === requestTenantId) setProblem({ status: 0, code: 'NETWORK_ERROR', title: 'Assigned Profiles could not be loaded.' });
      return null;
    } finally {
      if (generation === searchGeneration.current && assignedScopeRef.current === requestTenantId) setLoading(false);
    }
  }

  function showFirstAssignedPage(result: ProfileSelfServiceAssignedPage): void {
    setPage(result);
    setAssignedPageIndex(0);
    setAssignedPageCursors([undefined]);
  }

  async function refreshAssigned(): Promise<void> {
    const result = await fetchAssigned(undefined, activeQuery);
    if (!result) return;
    showFirstAssignedPage(result);
    if (selected) {
      const refreshed = result.items.find((item) => item.profileId === selected.profileId);
      if (refreshed && refreshed.revision !== selected.revision) setConflictRow(refreshed);
    }
  }

  useEffect(() => {
    let active = true;
    const generation = ++searchGeneration.current;
    const requestTenantId = tenantId;
    setLoading(true);
    void (async () => {
      const result = await client.listAssignedProfileEndpoints({ limit: 50 });
      if (!active || generation !== searchGeneration.current || assignedScopeRef.current !== requestTenantId) return;
      if (!result.ok) { setProblem(result.problem); return; }
      if (result.data.tenantId !== requestTenantId) { setProblem({ status: 502, code: 'SCOPE_MISMATCH', title: 'The assigned Profile response belongs to a different session tenant.' }); return; }
      showFirstAssignedPage(result.data);
    })().catch(() => { if (active && generation === searchGeneration.current && assignedScopeRef.current === requestTenantId) setProblem({ status: 0, code: 'NETWORK_ERROR', title: 'Assigned Profiles could not be loaded.' }); })
      .finally(() => { if (active && generation === searchGeneration.current && assignedScopeRef.current === requestTenantId) setLoading(false); });
    return () => { active = false; };
  }, [client, tenantId]);

  useEffect(() => {
    let active = true;
    const generation = ++keyGeneration.current;
    setKeys([]);
    setKeyPage(null);
    setSelectedKey('');
    setKeyNextCursor(null);
    if (!selected) return () => { active = false; };
    setKeyLoading(true);
    void client.listAssignedProfileApiKeys(selected.profileId, { query: keyQuery.trim() || undefined, limit: 50 }).then((result) => {
      if (!active || generation !== keyGeneration.current) return;
      if (!result.ok) { setProblem(result.problem); return; }
      if (result.data.profileId !== selected.profileId || result.data.tenantId !== tenantId) {
        setProblem({ status: 502, code: 'SCOPE_MISMATCH', title: 'Assigned API keys did not match the selected Profile and tenant.' });
        return;
      }
      setKeyPage(result.data);
      setKeys(result.data.items);
      setKeyNextCursor(result.data.nextCursor);
      if (result.data.items.length === 1) setSelectedKey(result.data.items[0]!.apiKeyId);
    }).catch(() => { if (active) setProblem({ status: 0, code: 'NETWORK_ERROR', title: 'Assigned API keys could not be loaded.' }); })
      .finally(() => { if (active && generation === keyGeneration.current) setKeyLoading(false); });
    return () => { active = false; };
  }, [client, selected?.profileId, tenantId, keyQuery]);

  function chooseProfile(item: AssignedProfile): void {
    if (saving) return;
    const values = parameterValuesFor(item);
    const jsonValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const definition = recordValue(recordValue(item.inputSchema.properties)[parameterSchemaKey(item, key)]);
      if (definition.type === 'object' || definition.type === 'array') jsonValues[key] = JSON.stringify(value, null, 2);
    }
    setSelected(item);
    setBaseValues(values);
    setDraftValues(values);
    setJsonDrafts(jsonValues);
    setBaseConnections(item.connectionsOverride);
    setDraftConnections(item.connectionsOverride);
    setFieldErrors({});
    setConflictRow(null);
    setNotice(null);
    setProblem(null);
  }

  useEffect(() => {
    if (!proposalDraft?.profileId || !proposalDraft.parameterKey || proposalHandoffAttempt.current === proposalDraft.handoffId) return;
    proposalHandoffAttempt.current = proposalDraft.handoffId;
    const generation = ++searchGeneration.current;
    setLoading(true);
    setProblem(null);
    const requestTenantId = tenantId;
    void client.listAssignedProfileEndpoints({ query: proposalDraft.profileName, limit: 50 }).then((result) => {
      if (generation !== searchGeneration.current || assignedScopeRef.current !== requestTenantId) return;
      if (!result.ok) { setProblem(result.problem); onProposalConsumed(); return; }
      if (result.data.tenantId !== requestTenantId) { setProblem({ status: 502, code: 'SCOPE_MISMATCH', title: 'The Profile proposal belongs to a different session tenant.' }); onProposalConsumed(); return; }
      const item = result.data.items.find((entry) => entry.profileId === proposalDraft.profileId);
      if (!item) { setProblem({ status: 404, code: 'PROFILE_NOT_ASSIGNED', title: 'This Profile is no longer assigned to your local account.' }); onProposalConsumed(); return; }
      if (item.revision !== proposalDraft.expectedRevision) {
        setConflictRow(item);
        setProblem({ status: 409, code: 'PROFILE_CHANGED', title: `The Profile changed from revision ${proposalDraft.expectedRevision} to ${item.revision}. Review its current values before accepting the prompt.` });
        onProposalConsumed();
        return;
      }
      const properties = recordValue(item.inputSchema.properties);
      const schemaKey = parameterSchemaKey(item, proposalDraft.parameterKey!);
      const actualKey = Object.keys(item.parameters).find((key) => parameterSchemaKey(item, key) === schemaKey) ?? proposalDraft.parameterKey!;
      if (!Object.hasOwn(properties, schemaKey) || item.parameters[actualKey]?.isLocked === true || /pass(word)?|secret|token|api.?key|credential|authorization|private.?key/i.test(actualKey)) {
        setProblem({ status: 422, code: 'PARAMETER_NOT_EDITABLE', title: 'This prompt field is missing, locked, or sensitive on the current endpoint.' });
        onProposalConsumed();
        return;
      }
      showFirstAssignedPage(result.data);
      setQuery(proposalDraft.profileName);
      setActiveQuery(proposalDraft.profileName);
      chooseProfile(item);
      setDraftValues({ ...parameterValuesFor(item), [actualKey]: proposalDraft.prompt });
      setNotice('Wizard proposal loaded into the local assigned-Profile draft. Review and save to create a new revision.');
      onProposalConsumed();
    }).catch(() => {
      if (generation === searchGeneration.current && assignedScopeRef.current === requestTenantId) setProblem({ status: 0, code: 'NETWORK_ERROR', title: 'The assigned Profile draft could not be loaded.' });
      onProposalConsumed();
    }).finally(() => { if (generation === searchGeneration.current && assignedScopeRef.current === requestTenantId) setLoading(false); });
  }, [client, proposalDraft, tenantId, onProposalConsumed]);

  async function searchProfiles(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const result = await fetchAssigned(undefined, query);
    if (result) {
      setActiveQuery(query);
      showFirstAssignedPage(result);
    }
  }

  async function navigateAssignedPage(direction: 'first' | 'next' | 'previous'): Promise<void> {
    if (loading || !page) return;
    const targetIndex = direction === 'first' ? 0 : direction === 'next' ? assignedPageIndex + 1 : assignedPageIndex - 1;
    if (targetIndex < 0) return;
    const cursor: string | undefined = direction === 'first' ? undefined : direction === 'next' ? page.nextCursor ?? undefined : assignedPageCursors[targetIndex];
    if (direction === 'next' && !cursor) return;
    if (direction === 'previous' && targetIndex > 0 && !cursor) return;
    const result = await fetchAssigned(cursor);
    if (!result) return;
    if (direction === 'first') showFirstAssignedPage(result);
    else {
      setPage(result);
      setAssignedPageIndex(targetIndex);
      if (direction === 'next') setAssignedPageCursors((history) => [...history.slice(0, targetIndex), cursor]);
    }
  }

  async function loadMoreKeys(): Promise<void> {
    if (!selected || !keyNextCursor || keyLoading) return;
    const generation = keyGeneration.current;
    setKeyLoading(true);
    try {
      const result = await client.listAssignedProfileApiKeys(selected.profileId, { query: keyQuery.trim() || undefined, cursor: keyNextCursor, limit: 50 });
      if (generation !== keyGeneration.current) return;
      if (result.ok && result.data.profileId === selected.profileId && result.data.tenantId === tenantId) {
        setKeys((current) => [...current, ...result.data.items]);
        setKeyNextCursor(result.data.nextCursor);
      } else if (!result.ok) setProblem(result.problem);
      else setProblem({ status: 502, code: 'SCOPE_MISMATCH', title: 'More API keys did not match the selected Profile and tenant.' });
    } catch {
      if (generation === keyGeneration.current) setProblem({ status: 0, code: 'NETWORK_ERROR', title: 'More assigned API keys could not be loaded.' });
    } finally {
      if (generation === keyGeneration.current) setKeyLoading(false);
    }
  }

  function updateParameter(key: string, value: unknown): void {
    setDraftValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => { const next = { ...current }; delete next[key]; return next; });
  }

  function validateDraft(): { values: Record<string, unknown>; errors: Record<string, string> } {
    const values = { ...draftValues };
    const errors: Record<string, string> = {};
    if (!selected) return { values, errors };
    for (const [key, text] of Object.entries(jsonDrafts)) {
      const definition = recordValue(recordValue(selected.inputSchema.properties)[parameterSchemaKey(selected, key)]);
      if (definition.type !== 'object' && definition.type !== 'array') continue;
      try { values[key] = JSON.parse(text) as unknown; }
      catch { errors[key] = 'Enter valid JSON for this object or array.'; }
    }
    const required = Array.isArray(selected.inputSchema.required) ? selected.inputSchema.required.filter((value): value is string => typeof value === 'string') : [];
    const bySchema = new Map(Object.entries(recordValue(selected.inputSchema.properties)).map(([key, value]) => [key, recordValue(value)]));
    for (const [key, definition] of bySchema) {
      const draftKey = Object.keys(selected.parameters).find((candidate) => parameterSchemaKey(selected, candidate) === key) ?? key;
      if (required.includes(key) && (values[draftKey] === undefined || values[draftKey] === '')) errors[draftKey] = 'This field is required by the active endpoint schema.';
      if ((definition.type === 'number' || definition.type === 'integer') && values[draftKey] !== undefined && values[draftKey] !== ''
          && (typeof values[draftKey] !== 'number' || !Number.isFinite(values[draftKey] as number)
            || (definition.type === 'integer' && !Number.isInteger(values[draftKey] as number)))) errors[draftKey] = definition.type === 'integer' ? 'Enter a whole number.' : 'Enter a finite number.';
    }
    const captured = new Set(valuesFromConnections(draftConnections, 'captureSession'));
    for (const slot of valuesFromConnections(draftConnections, 'injectSession')) {
      if (!captured.has(slot)) errors.connectionsOverride = `Session slot "${slot}" is injected but no existing step captures it.`;
    }
    return { values, errors };
  }

  async function saveAssignedProfile(): Promise<void> {
    if (!selected || !page || saveInFlight.current || saving) return;
    const validation = validateDraft();
    setFieldErrors(validation.errors);
    if (Object.keys(validation.errors).length > 0) return;
    const changedValues = Object.fromEntries(Object.entries(validation.values).filter(([key, value]) => !sameJson(value, baseValues[key])));
    const changedConnections = !sameJson(draftConnections, baseConnections);
    if (Object.keys(changedValues).length === 0 && !changedConnections) { setNotice('There are no unsaved Profile changes.'); return; }
    saveInFlight.current = true;
    setSaving(true);
    setProblem(null);
    setNotice(null);
    try {
      const response = await client.editAssignedProfile({
        businessId: selected.businessId,
        businessVersion: selected.businessVersion,
        profileName: selected.profileName,
        profileId: selected.profileId,
        expectedRevision: selected.revision,
        ...(Object.keys(changedValues).length ? { parameterValues: changedValues } : {}),
        ...(changedConnections ? { connectionsOverride: draftConnections } : {}),
      }, crypto.randomUUID());
      if (!response.ok) {
        setProblem(response.problem);
        if (response.status === 409) {
          const latest = await fetchAssigned();
          const latestRow = latest?.items.find((item) => item.profileId === selected.profileId);
          if (latest && latestRow) {
            showFirstAssignedPage(latest);
            setConflictRow(latestRow);
          }
        }
        return;
      }
      const updated: AssignedProfile = { ...selected, revision: response.data.revision };
      setSelected(updated);
      setBaseValues(validation.values);
      setDraftValues(validation.values);
      setBaseConnections(draftConnections);
      setConflictRow(null);
      setNotice(`Saved as Profile revision ${response.data.revision}.`);
      const refreshed = await fetchAssigned();
      if (refreshed) {
        showFirstAssignedPage(refreshed);
        const row = refreshed.items.find((item) => item.profileId === updated.profileId);
        if (row) { setSelected(row); setBaseValues(parameterValuesFor(row)); setDraftValues(parameterValuesFor(row)); setBaseConnections(row.connectionsOverride); setDraftConnections(row.connectionsOverride); }
      }
    } catch {
      setProblem({ status: 0, code: 'NETWORK_ERROR', title: 'The Profile edit could not be confirmed. The draft is still available; refresh before retrying.' });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  function rebaseDraft(): void {
    if (!conflictRow) return;
    const nextBase = parameterValuesFor(conflictRow);
    setSelected(conflictRow);
    setBaseValues(nextBase);
    setBaseConnections(conflictRow.connectionsOverride);
    setConflictRow(null);
    setNotice(`Draft kept. Review the new server revision ${conflictRow.revision} before saving again.`);
  }

  const properties = selected ? recordValue(selected.inputSchema.properties) : {};
  const keysToEdit = selected ? [...new Set([...Object.keys(properties).map((schemaKey) => Object.keys(selected.parameters).find((key) => parameterSchemaKey(selected, key) === schemaKey) ?? schemaKey), ...Object.keys(selected.parameters)])] : [];
  const requiredFields = selected && Array.isArray(selected.inputSchema.required)
    ? selected.inputSchema.required.filter((field): field is string => typeof field === 'string')
    : [];
  const hasChanges = selected !== null && (
    !sameJson(draftConnections, baseConnections)
    || Object.entries(draftValues).some(([key, value]) => !sameJson(value, baseValues[key]))
  );

  return (
    <section aria-labelledby="assigned-profiles-title" className="flex min-w-0 flex-col gap-5">
      <div>
        <h1 id="assigned-profiles-title" className="text-lg font-semibold">Assigned Profiles</h1>
        <p className="mt-1 text-sm text-[var(--text-sub)]">Edit parameters and existing session mappings on enabled endpoints assigned to your account. Changes create a new Profile revision.</p>
      </div>
      <AlertBanner variant="info" title="Your assigned tenant">This list is scoped by your signed-in local account. API keys, credentials, enablement, priority, and connector bindings remain managed by an administrator. Tenant: <code>{tenantId}</code></AlertBanner>
      <Card>
        <CardHeader>
          <CardTitle>Enabled assigned endpoints</CardTitle>
          <CardDescription>{page ? `Server page ${assignedPageIndex + 1} · ${page.items.length} rows on this page · ${page.total} assigned endpoint${page.total === 1 ? '' : 's'} reported.` : 'Only active, enabled endpoint assignments are shown.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start" onSubmit={(event) => void searchProfiles(event)}>
            <FormField id={`${workbenchId}-search`} label="Search assigned endpoints" className="min-w-0"><Input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={128} placeholder="Business, version, profile, action" /></FormField>
            <div className="flex flex-wrap gap-2 sm:mt-[1.375rem]">
              <Button type="submit" variant="outline" disabled={loading}>Search</Button>
              <Button type="button" variant="outline" onClick={() => void refreshAssigned()} disabled={loading}>Refresh</Button>
            </div>
          </form>
          {problem ? <AlertBanner variant="error" title={problem.title ?? 'Assigned Profile action failed'}>{problem.status || 'Network error'} · {problem.code ?? 'ERROR'}</AlertBanner> : null}
          {loading && !page ? <LoadingState title="Loading assigned endpoints" description="The server is checking your current local-user assignments." /> : null}
          {page?.items.length === 0 ? <div role="status" className="rounded border border-dashed p-6 text-sm text-[var(--text-sub)]">No enabled Profile endpoints are assigned to this account.</div> : null}
          {page?.items.length ? (
            <div role="region" aria-label="Current server page of assigned endpoints" tabIndex={0} className="max-h-[28rem] overflow-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            <div className="grid gap-2 p-1 sm:grid-cols-2">
              {page.items.map((item) => (
                <button key={item.profileId} type="button" onClick={() => chooseProfile(item)} aria-pressed={selected?.profileId === item.profileId} disabled={saving}
                  className={`min-w-0 rounded border p-3 text-left transition-colors ${selected?.profileId === item.profileId ? 'border-[var(--cf-blue)] bg-[var(--bg-subtle)]' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)]'}`}>
                  <span className="block truncate font-medium">{item.profileName} · {item.action}</span>
                  <span className="mt-1 block text-xs text-[var(--text-sub)]">{item.businessId}@{item.businessVersion} · revision {item.revision}{item.endpointSlug ? ` · ${item.endpointSlug}` : ''}</span>
                </button>
              ))}
            </div>
            </div>
          ) : null}
          {page ? <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => void navigateAssignedPage('first')} disabled={loading || assignedPageIndex === 0}>First page</Button>
            <TablePagination ariaLabel="Assigned endpoint server pages" hasPreviousPage={assignedPageIndex > 0} hasNextPage={page.nextCursor !== null} onPreviousPage={() => void navigateAssignedPage('previous')} onNextPage={() => void navigateAssignedPage('next')} pending={loading} status={`Server page ${assignedPageIndex + 1} · ${page.items.length} rows on this page · ${page.total} assigned endpoints reported`} />
          </div> : null}
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{selected.profileName} parameters and session mappings</CardTitle>
            <CardDescription>{selected.businessId}@{selected.businessVersion} · active revision {selected.revision} · {selected.action}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {conflictRow ? (
              <AlertBanner variant="warning" title={`Profile changed on the server (revision ${conflictRow.revision})`}>
                Your draft remains intact. Server changes since revision {selected.revision}: parameters {Object.keys(conflictRow.parameters).filter((key) => !sameJson(conflictRow.parameters[key]?.value, baseValues[key])).join(', ') || 'none detected'}; session mappings {sameJson(conflictRow.connectionsOverride, baseConnections) ? 'unchanged' : 'changed'}. Review before rebasing.
                <div className="mt-2"><Button type="button" size="sm" variant="outline" onClick={() => void rebaseDraft()}>Keep draft on revision {conflictRow.revision}</Button></div>
              </AlertBanner>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {keysToEdit.map((key) => {
                const schemaKey = parameterSchemaKey(selected, key);
                const definition = recordValue(properties[schemaKey]);
                const current = selected.parameters[key];
                const locked = current?.isLocked === true || (current === undefined && definition.defaultLocked === true);
                const type = Array.isArray(definition.enum) ? 'enum' : definition.type;
                const label = typeof definition.title === 'string' ? definition.title : typeof definition.label === 'string' ? definition.label : key;
                const description = typeof definition.description === 'string' ? definition.description : locked ? 'Locked by an administrator.' : undefined;
                const error = fieldErrors[key];
                const enumValues: unknown[] = Array.isArray(definition.enum) ? definition.enum : [];
                return (
                  <FormField key={key} id={`${workbenchId}-param-${key}`} label={label} description={description} error={error} required={requiredFields.includes(schemaKey)}>
                    {type === 'boolean' ? (
                      <span className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={label} checked={draftValues[key] === true} disabled={locked || saving} onChange={(event) => updateParameter(key, event.target.checked)} /><span>Enabled</span></span>
                    ) : type === 'object' || type === 'array' ? (
                      <textarea className="min-h-24 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] p-2 font-mono text-xs" aria-label={label} aria-invalid={error ? true : undefined} value={jsonDrafts[key] ?? JSON.stringify(draftValues[key] ?? (type === 'array' ? [] : {}), null, 2)} disabled={locked || saving}
                        onChange={(event) => { setJsonDrafts((currentDraft) => ({ ...currentDraft, [key]: event.target.value })); setFieldErrors((currentErrors) => { const next = { ...currentErrors }; delete next[key]; return next; }); }} />
                    ) : type === 'enum' && enumValues.length > 0 ? (
                      <select className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" aria-label={label} value={String(draftValues[key] ?? '')} disabled={locked || saving} onChange={(event) => updateParameter(key, enumValues.find((entry: unknown) => String(entry) === event.target.value) ?? event.target.value)}>
                        <option value="">Select…</option>{enumValues.filter((entry): entry is string | number | boolean => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean').map((entry) => <option key={String(entry)} value={String(entry)}>{String(entry)}</option>)}
                      </select>
                    ) : (
                      <Input type={type === 'number' || type === 'integer' ? 'number' : 'text'} step={type === 'integer' ? '1' : type === 'number' ? 'any' : undefined} aria-label={label} value={String(draftValues[key] ?? '')} disabled={locked || saving}
                        onChange={(event) => updateParameter(key, type === 'number' || type === 'integer' ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value)} />
                    )}
                  </FormField>
                );
              })}
            </div>
            <section aria-labelledby={`${workbenchId}-connections-title`} className="space-y-3 rounded border border-[var(--border-subtle)] p-3">
              <h3 id={`${workbenchId}-connections-title`} className="font-medium">Existing connector session mappings</h3>
              {draftConnections.length === 0 ? <p className="text-sm text-[var(--text-sub)]">This Profile has no existing connection steps to edit.</p> : draftConnections.map((step, index) => (
                <div key={`${step.slug}:${step.stepId ?? index}`} className="grid gap-3 sm:grid-cols-3">
                  <FormField label="Existing step"><Input value={`${step.slug}${step.stepId ? ` · ${step.stepId}` : ''}`} disabled aria-label={`Existing step ${index + 1}`} /></FormField>
                  <FormField label="Capture session slot"><Input maxLength={64} value={step.captureSession ?? ''} aria-label={`Capture session slot for ${step.slug}`} onChange={(event) => setDraftConnections((current) => current.map((entry, row) => row === index ? { ...entry, captureSession: event.target.value || null } : entry))} disabled={saving} /></FormField>
                  <FormField label="Inject session slot"><Input maxLength={64} value={step.injectSession ?? ''} aria-label={`Inject session slot for ${step.slug}`} onChange={(event) => setDraftConnections((current) => current.map((entry, row) => row === index ? { ...entry, injectSession: event.target.value || null } : entry))} disabled={saving} /></FormField>
                </div>
              ))}
              {fieldErrors.connectionsOverride ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{fieldErrors.connectionsOverride}</p> : null}
              <p className="text-xs text-[var(--text-sub)]">Step order, slugs, IDs, connector revisions, and credentials are read-only. Session slot names are checked on save.</p>
            </section>
            <section aria-labelledby={`${workbenchId}-key-title`} className="space-y-3 rounded border border-[var(--border-subtle)] p-3">
              <div><h3 id={`${workbenchId}-key-title`} className="font-medium">Assigned active API key for tests</h3><p className="text-xs text-[var(--text-sub)]">Only keys currently assigned to both your account and this Profile are listed. This view never returns key material.</p></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Search assigned API keys"><Input value={keyQuery} onChange={(event) => setKeyQuery(event.target.value)} maxLength={128} placeholder="Name or prefix" /></FormField>
                <FormField label="API key"><select className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)} disabled={keyLoading}>
                  <option value="">Select an assigned key</option>{keys.map((key) => <option key={key.apiKeyId} value={key.apiKeyId}>{key.name || 'Unnamed key'} · {key.prefix} · {key.apiKeyId}</option>)}
                </select></FormField>
              </div>
              {keyPage?.total === 0 ? <p role="status" className="text-sm text-[var(--text-sub)]">No active key is currently assigned to this Profile and your account.</p> : null}
              {keyNextCursor ? <Button type="button" variant="outline" size="sm" onClick={() => void loadMoreKeys()} disabled={keyLoading}>Load more keys</Button> : null}
            </section>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void saveAssignedProfile()} disabled={saving || !hasChanges}>{saving ? 'Saving revision…' : 'Save assigned Profile changes'}</Button>
              {selected.revision > 0 ? <Badge variant="neutral">CAS revision {selected.revision}</Badge> : null}
              {notice ? <span role="status" className="text-sm text-[var(--text-sub)]">{notice}</span> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function valuesFromConnections(steps: AssignedProfile['connectionsOverride'], field: 'captureSession' | 'injectSession'): string[] {
  return steps.flatMap((step) => typeof step[field] === 'string' && step[field] !== '' ? [step[field]!] : []);
}

/**
 * Profile vertical slice (AWEB-04) — conformant with the frozen Phase-1 wire:
 * read = `{businessId, businessVersion, profileName, revision, currentValues,
 * policy, manifest, capabilities:[{connectorId, capability}]}`; writes ride
 * `/admin/api/profiles/…/{upsert|publish|rollback}` → dispatcher.
 */
export function ProfilesScreen() {
  const { tenantId: globalTenantId } = useTenant();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useMemo(() => createAdminApiClient(), []);
  const workbenchProposal = useMemo(() => parseWorkbenchPromptProposal(location.state), [location.state]);
  const consumedWorkbenchProposal = useRef('');
  const [access, setAccess] = useState<{ kind: 'loading' } | { kind: 'ready'; session: AdminWebSession } | { kind: 'failed'; problem: AdminApiProblem }>({ kind: 'loading' });
  const [businesses, setBusinesses] = useState<string[]>([]);
  const [versions, setVersions] = useState<string[]>([]);
  const [apiKeys, setApiKeys] = useState<ProfileApiKeyOption[]>([]);
  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>('');
  const [businessId, setBusinessId] = useState(() => new URLSearchParams(window.location.search).get('businessId') ?? 'document-core');
  const [businessVersion, setBusinessVersion] = useState(() => new URLSearchParams(window.location.search).get('businessVersion') ?? '1.1.0');
  const [businessFunctionCatalog, setBusinessFunctionCatalog] = useState<ProfileGroupFunctionCatalog | null>(null);
  const [businessFunctionCatalogLoading, setBusinessFunctionCatalogLoading] = useState(false);
  const [businessFunctionCatalogProblem, setBusinessFunctionCatalogProblem] = useState<string | null>(null);
  const [endpointSlug, setEndpointSlug] = useState('');
  const [initialBindings, setInitialBindings] = useState<InitialBinding[]>([]);
  const [profileName, setProfileName] = useState(() => new URLSearchParams(window.location.search).get('profileName') ?? 'default');
  const [profileListBusinessId, setProfileListBusinessId] = useState('');
  const [profileListPage, setProfileListPage] = useState<ProfileListPage | null>(null);
  const [profileListLoading, setProfileListLoading] = useState(false);
  const [profileListLoadingMore, setProfileListLoadingMore] = useState(false);
  const [profileListCursors, setProfileListCursors] = useState<Array<string | undefined>>([undefined]);
  const [profileListPageIndex, setProfileListPageIndex] = useState(0);
  const [profileListProblem, setProfileListProblem] = useState<AdminApiProblem | null>(null);
  const [profileListRefresh, setProfileListRefresh] = useState(0);
  const profileListScopeKey = JSON.stringify([globalTenantId, profileListBusinessId]);
  const profileListScopeRef = useRef(profileListScopeKey);
  const profileListRequestGeneration = useRef(0);
  const [screenTab, setScreenTab] = useState<'catalog' | 'groups' | 'editor'>(() => {
    const query = new URLSearchParams(window.location.search);
    return query.has('profileName') ? 'editor' : 'catalog';
  });

  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [loadedAs, setLoadedAs] = useState<{ tenantId: string | null; businessId: string; businessVersion: string; profileName: string; profileId: string | null; action: string; endpointSlug: string | null } | null>(null);
  const profileRequestScope = useRef(createProfileRequestScope(globalTenantId));
  const busyOperationSequence = useRef(0);
  const busyOperationOwner = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<AdminApiProblem | null>(null);
  const [profileWorkflows, setProfileWorkflows] = useState<ProfileWorkflowItem[]>([]);
  const [profileWorkflowsLoading, setProfileWorkflowsLoading] = useState(false);
  const [profileWorkflowsProblem, setProfileWorkflowsProblem] = useState<string | null>(null);
  const [profileWorkflowPending, setProfileWorkflowPending] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowResults, setRowResults] = useState<RowResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [workbenchConfirmOpen, setWorkbenchConfirmOpen] = useState(false);
  const [pendingWorkbenchHandoff, setPendingWorkbenchHandoff] = useState<{
    handoffId: string;
    tenantId: string;
    businessId: string;
    businessVersion: string;
    profileName: string;
    expectedRevision: number;
  } | null>(null);
  const [secretOptions, setSecretOptions] = useState<SecretOption[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsProblem, setSecretsProblem] = useState<AdminApiProblem | null>(null);

  function beginBusyOperation(): number {
    const operation = ++busyOperationSequence.current;
    busyOperationOwner.current = operation;
    setBusy(true);
    return operation;
  }

  function clearBusyOperation(operation: number): void {
    if (busyOperationOwner.current !== operation) return;
    busyOperationOwner.current = null;
    setBusy(false);
  }

  function cancelBusyOperation(): void {
    busyOperationOwner.current = null;
    setBusy(false);
  }

  useLayoutEffect(() => {
    if (profileListScopeRef.current === profileListScopeKey) return;
    profileListScopeRef.current = profileListScopeKey;
    profileListRequestGeneration.current += 1;
    setProfileListLoadingMore(false);
    setProfileListPage(null);
    setProfileListProblem(null);
    setProfileListCursors([undefined]);
    setProfileListPageIndex(0);
    setProfileListLoading(globalTenantId !== null && access.kind === 'ready' && !access.session.localUser && access.session.role !== 'viewer');
  }, [access, globalTenantId, profileListScopeKey]);

  function consumeWorkbenchProposal(): void {
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }

  function changeProfileListBusinessId(nextBusinessId: string): void {
    const nextScope = JSON.stringify([globalTenantId, nextBusinessId]);
    if (profileListScopeRef.current !== nextScope) {
      profileListScopeRef.current = nextScope;
      profileListRequestGeneration.current += 1;
      setProfileListLoadingMore(false);
      setProfileListLoading(globalTenantId !== null && access.kind === 'ready' && !access.session.localUser && access.session.role !== 'viewer');
      setProfileListPage(null);
      setProfileListProblem(null);
      setProfileListCursors([undefined]);
      setProfileListPageIndex(0);
    }
    setProfileListBusinessId(nextBusinessId);
  }

  function refreshProfileCatalog(): void {
    profileListRequestGeneration.current += 1;
    setProfileListLoadingMore(false);
    setProfileListLoading(globalTenantId !== null && access.kind === 'ready' && !access.session.localUser && access.session.role !== 'viewer');
    setProfileListPage(null);
    setProfileListProblem(null);
    setProfileListCursors([undefined]);
    setProfileListPageIndex(0);
    setProfileListRefresh((current) => current + 1);
  }

  useEffect(() => {
    let active = true;
    void client.getSession().then((result) => {
      if (active) setAccess(result.ok ? { kind: 'ready', session: result.data } : { kind: 'failed', problem: result.problem });
    }).catch(() => {
      if (active) setAccess({ kind: 'failed', problem: { status: 0, code: 'NETWORK_ERROR', title: 'Admin session could not be read.' } });
    });
    return () => { active = false; };
  }, [client]);

  useLayoutEffect(() => {
    if (!profileRequestScope.current.updateTenant(globalTenantId)) return;
    setEndpointSlug('');
    setInitialBindings([]);
    setApiKeys([]);
    setSelectedApiKeyId('');
    setDetail(null);
    setDraft(null);
    setLoadedAs(null);
    setLoading(false);
    cancelBusyOperation();
    setRowResults(null);
    setProblem(null);
    setProfileWorkflows([]);
    setProfileWorkflowsProblem(null);
    setNotice(null);
  }, [globalTenantId]);

  useEffect(() => () => profileRequestScope.current.invalidateRequests(), []);

  useEffect(() => {
    let active = true;
    const generation = ++profileListRequestGeneration.current;
    const requestScope = profileListScopeKey;
    const isCurrent = (): boolean => active
      && generation === profileListRequestGeneration.current
      && profileListScopeRef.current === requestScope;
    setProfileListPage(null);
    setProfileListProblem(null);
    setProfileListCursors([undefined]);
    setProfileListPageIndex(0);
    setProfileListLoadingMore(false);
    if (access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer') {
      setProfileListLoading(false);
      return () => { active = false; };
    }
    if (!globalTenantId) {
      setProfileListLoading(false);
      return () => { active = false; };
    }
    setProfileListLoading(true);
    const query: Record<string, string> = { tenantId: globalTenantId, limit: '50' };
    if (profileListBusinessId) query.businessId = profileListBusinessId;
    void client.listProfiles(query).then((result) => {
      if (!isCurrent()) return;
      if (!result.ok) {
        setProfileListProblem(result.problem);
        return;
      }
      const page = parseProfileListPage(result.data, globalTenantId, profileListBusinessId || null);
      if (page === null) {
        setProfileListProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'The profile list response did not match the contract.' });
        return;
      }
      setProfileListPage(page);
    }).catch(() => {
      if (isCurrent()) setProfileListProblem({ status: 0, code: 'NETWORK_ERROR', title: 'The profile list could not be loaded.' });
    }).finally(() => {
      if (isCurrent()) setProfileListLoading(false);
    });
    return () => { active = false; };
  }, [client, globalTenantId, profileListBusinessId, profileListRefresh, profileListScopeKey, access]);

  // AWEB-14: workflow choices are loaded only for the stored profile's exact
  // business/version and current tenant. The backend applies the same fence.
  useEffect(() => {
    let active = true;
    setProfileWorkflows([]);
    setProfileWorkflowsProblem(null);
    const targetName = loadedAs?.profileName;
    if (access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer' || detail === null || detail.revision < 1 || targetName === undefined || !globalTenantId) {
      setProfileWorkflowsLoading(false);
      return () => { active = false; };
    }
    setProfileWorkflowsLoading(true);
    void client.listProfileWorkflows(
      detail.businessId,
      detail.businessVersion,
      targetName,
      globalTenantId,
    ).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setProfileWorkflowsProblem(result.problem.title ?? result.problem.code ?? 'Could not load profile workflows.');
        setProfileWorkflows([]);
        return;
      }
      const page = parseProfileWorkflowPage(result.data, detail.businessId, detail.businessVersion);
      if (page === null) {
        setProfileWorkflowsProblem('The workflow list did not match the selected business and version.');
        setProfileWorkflows([]);
        return;
      }
      setProfileWorkflows(page.items);
    }).catch(() => {
      if (active) setProfileWorkflowsProblem('Could not load profile workflows.');
    }).finally(() => {
      if (active) setProfileWorkflowsLoading(false);
    });
    return () => { active = false; };
  }, [client, detail, loadedAs, globalTenantId, access]);

  // Load registered businesses
  useEffect(() => {
    let active = true;
    if (access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer') return () => { active = false; };
    void client.listBusinesses().then((result) => {
      if (!active) return;
      const page = result.ok ? parseBusinessPage(result.data) : null;
      if (page && page.items.length > 0) {
        const list = page.items.map((b) => b.businessId);
        setBusinesses(list);
        setBusinessId((prev) => (!prev || !list.includes(prev) ? list[0]! : prev));
      }
    });
    return () => { active = false; };
  }, [client, access]);

  // Load versions for selected business
  useEffect(() => {
    let active = true;
    if (access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer') return () => { active = false; };
    if (!businessId.trim()) return;
    void client.getBusinessVersions(businessId.trim()).then((result) => {
      if (!active) return;
      const vers = result.ok ? parseBusinessVersions(result.data) : null;
      if (vers && vers.rows.length > 0) {
        const list = vers.rows.map((r) => r.version);
        setVersions(list);
        setBusinessVersion((prev) => (!prev || !list.includes(prev) ? list[0]! : prev));
      }
    });
    return () => { active = false; };
  }, [client, businessId, access]);

  useEffect(() => {
    let active = true;
    setBusinessFunctionCatalog(null);
    setBusinessFunctionCatalogProblem(null);
    if (businessId !== 'document-core' || access.kind !== 'ready' || access.session.localUser || access.session.role !== 'admin' || !businessVersion.trim()) {
      setBusinessFunctionCatalogLoading(false);
      return () => { active = false; };
    }
    setBusinessFunctionCatalogLoading(true);
    void client.getBusinessFunctionCatalog(businessId, businessVersion.trim()).then((result) => {
      if (!active) return;
      const parsed = result.ok ? parseProfileGroupFunctionCatalog(result.data) : null;
      if (!parsed || parsed.businessId !== businessId || parsed.businessVersion !== businessVersion.trim()) {
        setBusinessFunctionCatalogProblem(result.ok ? 'Selected version function catalog did not match the selected manifest.' : result.problem.title ?? result.problem.code ?? 'The selected version endpoint catalog is unavailable.');
        return;
      }
      setBusinessFunctionCatalog(parsed);
    }).catch(() => {
      if (active) setBusinessFunctionCatalogProblem('The selected version endpoint catalog is unavailable.');
    }).finally(() => { if (active) setBusinessFunctionCatalogLoading(false); });
    return () => { active = false; };
  }, [access, businessId, businessVersion, client]);

  // Load API keys for global tenant
  useEffect(() => {
    let active = true;
    setApiKeys([]);
    setSelectedApiKeyId('');
    if (access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer') return () => { active = false; };
    if (!globalTenantId) return () => { active = false; };
    void client.listApiKeys({ tenantId: globalTenantId }).then((result) => {
      if (!active) return;
      if (result.ok && result.data && Array.isArray(result.data.items)) {
        setApiKeys(result.data.items.filter((key) => key.tenantId === globalTenantId));
      }
    });
    return () => { active = false; };
  }, [client, globalTenantId, access]);

  useEffect(() => {
    if (detail === null) return;
    const detailApiKeyId = detail.apiKeyId;
    const matchingActiveKey = findCurrentActiveProfileApiKey(apiKeys, detailApiKeyId ?? '', globalTenantId);
    setSelectedApiKeyId(matchingActiveKey?.id ?? '');
  }, [apiKeys, detail, globalTenantId]);

  // CB-04: the callback credential fields select from the live secret catalog
  useEffect(() => {
    let active = true;
    if (access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer') {
      setSecretsLoading(false);
      setSecretOptions([]);
      return () => { active = false; };
    }
    setSecretsLoading(true);
    void client.listSecrets({ limit: '100' }).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setSecretOptions([]);
        setSecretsProblem(result.problem);
        setSecretsLoading(false);
        return;
      }
      const page = parseSecretListPage(result.data);
      if (page === null) {
        setSecretOptions([]);
        setSecretsProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'The secret catalog response did not match the contract.' });
        setSecretsLoading(false);
        return;
      }
      setSecretOptions(page.items.map((entry) => ({
        secretId: entry.secretId,
        name: entry.name,
        state: entry.state,
        purpose: entry.purpose,
      })));
      setSecretsProblem(null);
      setSecretsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [client, access]);

  const identifiers = { businessId: businessId.trim(), businessVersion: businessVersion.trim() || 'latest', profileName: profileName.trim() || 'default' };

  async function lookupStoredProfileIdentity(
    target: { businessId: string; businessVersion: string; profileName: string },
    tenantId: string | null,
    isCurrentRequest: () => boolean,
    profileId?: string,
  ): Promise<ReturnType<typeof resolveProfileIdentityFromCatalog>> {
    if (!tenantId) return { kind: 'missing' };
    try {
      const rows: ProfileListPage['items'] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        const result = await client.listProfiles({
          tenantId,
          businessId: target.businessId,
          limit: '100',
          ...(cursor ? { cursor } : {}),
        });
        if (!isCurrentRequest()) return { kind: 'missing' };
        if (!result.ok) return { kind: 'missing' };
        const page = parseProfileListPage(result.data, tenantId, target.businessId);
        if (page === null) return { kind: 'missing' };
        rows.push(...page.items);
        if (page.nextCursor === null) break;
        if (seenCursors.has(page.nextCursor)) return { kind: 'ambiguous' };
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return resolveProfileIdentityFromCatalog(rows, {
        tenantId,
        businessId: target.businessId,
        businessVersion: target.businessVersion,
        profileName: target.profileName,
        ...(profileId ? { profileId } : {}),
      });
    } catch {
      return { kind: 'missing' };
    }
  }

  async function load(
    nameToLoad?: string,
    identityOverride?: { businessId: string; businessVersion: string; profileName: string; profileId?: string; action?: string; endpointSlug?: string | null },
    preserveBusyOperation?: number,
  ): Promise<ProfileDetail | null> {
    const requestToken = profileRequestScope.current.beginRequest();
    const isCurrentRequest = (): boolean => profileRequestScope.current.isRequestCurrent(requestToken)
      && requestToken.tenantId === globalTenantId;
    if (busyOperationOwner.current !== null && busyOperationOwner.current !== preserveBusyOperation) cancelBusyOperation();
    setScreenTab('editor');
    setLoading(true);
    setProblem(null);
    setNotice(null);
    setRowResults(null);
    setDetail(null);
    setDraft(null);
    setLoadedAs(null);
    setInitialBindings([]);
    const targetName = (identityOverride?.profileName ?? nameToLoad ?? profileName).trim() || 'default';
    const target: { businessId: string; businessVersion: string; profileName: string; profileId?: string; action?: string; endpointSlug?: string | null } = identityOverride ?? {
      businessId: identifiers.businessId,
      businessVersion: identifiers.businessVersion,
      profileName: targetName,
    };
    try {
      const sessionResult = await client.getSession();
      if (!isCurrentRequest()) return null;
      if (!sessionResult.ok) {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem(sessionResult.problem);
        return null;
      }
      const result = await client.getProfile(target.businessId, target.businessVersion, targetName, {
        ...(requestToken.tenantId ? { tenantId: requestToken.tenantId } : {}),
        ...(target.profileId ? { profileId: target.profileId } : {}),
      });
      if (!isCurrentRequest()) return null;
      if (!result.ok) {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem(result.problem);
        return null;
      }
      let parsed = parseProfileDetail(result.data);
      if (!isCurrentRequest()) return null;
      if (parsed === null) {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable profile payload.' });
        return null;
      }
      if (!parsed.profileName) {
        parsed.profileName = targetName;
      }
      const resolvedTarget = normalizeProfileTarget(target, parsed);
      const resolvedName = resolvedTarget.profileName;
      let action = '';
      let resolvedProfileId: string | null = identityOverride?.profileId ?? null;
      let storedEndpointSlug: string | null | undefined;
      if (parsed.revision > 0) {
        const resolution = await lookupStoredProfileIdentity(
          resolvedTarget,
          requestToken.tenantId,
          isCurrentRequest,
          identityOverride?.profileId,
        );
        if (!isCurrentRequest()) return null;
        if (resolution.kind !== 'resolved') {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem({
            status: 409,
            code: 'PROFILE_ACTION_UNRESOLVED',
            title: resolution.kind === 'ambiguous'
              ? 'The selected profile name maps to more than one manifest action in this tenant. Open a single-action catalog row.'
              : 'The profile action could not be resolved from this tenant’s profile catalog. Select a tenant and open the exact catalog row before editing.',
          });
          return null;
        }
        if ((parsed.action && parsed.action !== resolution.action)
            || (parsed.endpointSlug !== undefined && resolution.endpointSlug !== undefined && parsed.endpointSlug !== resolution.endpointSlug)
            || (identityOverride?.action && identityOverride.action !== resolution.action)
            || (identityOverride?.endpointSlug !== undefined && resolution.endpointSlug !== undefined && identityOverride.endpointSlug !== resolution.endpointSlug)) {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem({ status: 409, code: 'PROFILE_IDENTITY_MISMATCH', title: 'The selected Profile catalog identity does not match its stored action and endpoint binding. Reopen the catalog row.' });
          return null;
        }
        if (resolvedProfileId !== resolution.profileId) {
          const exactResult = await client.getProfile(resolvedTarget.businessId, resolvedTarget.businessVersion, resolvedName, {
            tenantId: requestToken.tenantId ?? undefined,
            profileId: resolution.profileId,
          });
          if (!isCurrentRequest()) return null;
          if (!exactResult.ok) {
            setDetail(null);
            setDraft(null);
            setLoadedAs(null);
            setProblem(exactResult.problem);
            return null;
          }
          const exactDetail = parseProfileDetail(exactResult.data);
          if (exactDetail === null || exactDetail.businessId !== resolvedTarget.businessId
              || exactDetail.businessVersion !== resolvedTarget.businessVersion
              || exactDetail.profileName !== resolvedName
              || (exactDetail.action && exactDetail.action !== resolution.action)
              || (exactDetail.endpointSlug !== undefined && resolution.endpointSlug !== undefined && exactDetail.endpointSlug !== resolution.endpointSlug)) {
            setDetail(null);
            setDraft(null);
            setLoadedAs(null);
            setProblem({ status: 409, code: 'PROFILE_IDENTITY_MISMATCH', title: 'The exact Profile identity changed while it was loading. Reopen the catalog row.' });
            return null;
          }
          parsed = exactDetail;
        }
        action = resolution.action;
        resolvedProfileId = resolution.profileId;
        storedEndpointSlug = resolution.endpointSlug;
      }
      const storedEndpoint = storedEndpointSlug !== undefined
        ? storedEndpointSlug
        : parsed.endpointSlug !== undefined
          ? parsed.endpointSlug
          : identityOverride?.endpointSlug;
      if (parsed.revision > 0 && storedEndpoint === undefined) {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem({ status: 409, code: 'PROFILE_ENDPOINT_UNRESOLVED', title: 'The saved Profile endpoint is missing from its tenant catalog and detail metadata. Reopen the exact catalog row before editing.' });
        return null;
      }
      const targetEndpointSlug = parsed.revision > 0
        ? storedEndpoint?.trim() || ''
        : parsed.endpointSlug?.trim() || identityOverride?.endpointSlug?.trim() || (resolvedTarget.businessId === 'document-core' ? endpointSlug : '');
      if (parsed.revision === 0 && action.length === 0) {
        action = newProfileAction(parsed, targetEndpointSlug) ?? '';
      }
      setDetail(parsed);
      setInitialBindings(initialBindingsFromProfile(parsed));
      setBusinessId(resolvedTarget.businessId);
      setBusinessVersion(resolvedTarget.businessVersion);
      setProfileName(resolvedName);
      setEndpointSlug(targetEndpointSlug);
      setLoadedAs({
        tenantId: requestToken.tenantId,
        businessId: resolvedTarget.businessId,
        businessVersion: resolvedTarget.businessVersion,
        profileName: resolvedName,
        profileId: resolvedProfileId,
        action,
        endpointSlug: targetEndpointSlug || null,
      });
      setDraft(draftFromDetail(parsed, action, targetEndpointSlug));
      setNotice(`Profile "${resolvedName}" loaded (Revision ${parsed.revision}, action ${action || 'unselected'}).`);
      return parsed;
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }

  useEffect(() => {
    const proposal = workbenchProposal;
    if (!proposal || access.kind !== 'ready' || access.session.localUser || access.session.role !== 'admin'
        || consumedWorkbenchProposal.current === proposal.handoffId) return;
    consumedWorkbenchProposal.current = proposal.handoffId;
    if (!globalTenantId || (proposal.tenantId !== undefined && proposal.tenantId !== globalTenantId)) {
      setProblem({ status: 403, code: 'TENANT_SCOPE_MISMATCH', title: 'Select the tenant used by the workbench proposal before opening it in Profiles.' });
      consumeWorkbenchProposal();
      return;
    }
    void (async () => {
      const loaded = await load(proposal.profileName, {
        businessId: proposal.businessId,
        businessVersion: proposal.businessVersion,
        profileName: proposal.profileName,
      });
      if (!loaded) { consumeWorkbenchProposal(); return; }
      if (loaded.revision !== proposal.expectedRevision) {
        setProblem({ status: 409, code: 'PROFILE_CHANGED', title: `The Profile changed from revision ${proposal.expectedRevision} to ${loaded.revision}. Review the current revision before applying this proposal.` });
        setNotice('The generated prompt remains available in the workbench. The newer Profile draft was loaded without applying it.');
        consumeWorkbenchProposal();
        return;
      }
      setDraft((current) => current ? { ...current, prompt: { ...current.prompt, text: proposal.prompt } } : current);
      setNotice(`Wizard proposal loaded into the local Profile prompt draft at revision ${loaded.revision}. Review and save it explicitly.`);
      consumeWorkbenchProposal();
    })().catch(() => {
      setProblem({ status: 0, code: 'NETWORK_ERROR', title: 'The Profile draft could not be loaded for the Wizard proposal.' });
      consumeWorkbenchProposal();
    });
  // The route state is consumed once per proposal; loading and user interaction remain in the existing Profile editor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access, globalTenantId, workbenchProposal]);

  async function loadMoreProfiles(direction: 'next' | 'previous'): Promise<void> {
    if (!globalTenantId || profileListPage === null || profileListLoadingMore) return;
    const nextIndex = direction === 'next' ? profileListPageIndex + 1 : profileListPageIndex - 1;
    const cursor = direction === 'next'
      ? profileListPage.nextCursor
      : profileListPage.prevCursor ?? profileListCursors[nextIndex];
    if (nextIndex < 0 || cursor === null || cursor === undefined) return;
    const requestScope = JSON.stringify([globalTenantId, profileListBusinessId]);
    const generation = ++profileListRequestGeneration.current;
    const isCurrent = (): boolean => generation === profileListRequestGeneration.current
      && profileListScopeRef.current === requestScope;
    setProfileListLoadingMore(true);
    setProfileListProblem(null);
    try {
      const query: Record<string, string> = {
        tenantId: globalTenantId,
        limit: String(profileListPage.limit),
        cursor,
      };
      if (profileListBusinessId) query.businessId = profileListBusinessId;
      const result = await client.listProfiles(query);
      if (!isCurrent()) return;
      if (!result.ok) {
        setProfileListProblem(result.problem);
        return;
      }
      const page = parseProfileListPage(result.data, globalTenantId, profileListBusinessId || null);
      if (page === null) {
        setProfileListProblem({ status: 502, code: 'UNREADABLE_RESPONSE', title: 'The profile list response did not match the selected tenant and business.' });
        return;
      }
      setProfileListPage(page);
      setProfileListPageIndex(nextIndex);
      if (direction === 'next') {
        setProfileListCursors((history) => [...history.slice(0, nextIndex), cursor]);
      }
    } catch {
      if (isCurrent()) setProfileListProblem({ status: 0, code: 'NETWORK_ERROR', title: 'The requested profile page could not be loaded.' });
    } finally {
      if (isCurrent()) setProfileListLoadingMore(false);
    }
  }

  async function createProfile(): Promise<void> {
    const requestToken = profileRequestScope.current.beginRequest();
    const isCurrentRequest = (): boolean => profileRequestScope.current.isRequestCurrent(requestToken)
      && requestToken.tenantId === globalTenantId;
    cancelBusyOperation();
    setScreenTab('editor');
    setLoading(true);
    setProblem(null);
    setNotice(null);
    setRowResults(null);
    setDetail(null);
    setDraft(null);
    setLoadedAs(null);
    setInitialBindings([]);
    const bId = businessId.trim();
    const bVer = businessVersion.trim() || 'latest';
    const pName = profileName.trim() || 'default';
    const selectedEndpointSlug = bId === 'document-core' ? endpointSlug.trim() : '';
    if (!bId) {
      setNotice('Please select or enter a business ID first.');
      setLoading(false);
      return;
    }
    try {
      const sessionResult = await client.getSession();
      if (!isCurrentRequest()) return;
      if (!sessionResult.ok) {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem(sessionResult.problem);
        return;
      }
      const scope = { ...(requestToken.tenantId ? { tenantId: requestToken.tenantId } : {}) };
      const result = await client.getProfile(bId, bVer, pName, scope);
      if (!isCurrentRequest()) return;
      let readResult = result;
      let parsed: ProfileDetail | null = null;
      if (result.ok) {
        parsed = parseProfileDetail(result.data);
      } else if (result.problem.status === 404 || result.problem.code === 'NOT_FOUND') {
        // Tenant-scoped detail reads intentionally return 404 for a named
        // profile that is not stored under the selected tenant. The /new
        // sentinel supplies that tenant's manifest for a new named draft.
        const fallback = await client.getProfile(bId, bVer, 'new', scope);
        if (!isCurrentRequest()) return;
        readResult = fallback;
        if (fallback.ok) {
          parsed = parseProfileDetail(fallback.data);
        } else {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem(fallback.problem);
          return;
        }
      } else {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem(result.problem);
        return;
      }
      if (!isCurrentRequest()) return;
      if (parsed === null) {
        setDetail(null);
        setDraft(null);
        setLoadedAs(null);
        setProblem(readResult.ok ? { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Unreadable profile payload.' } : readResult.problem);
        return;
      }
      parsed.profileName = pName;
      const resolvedTarget = normalizeProfileTarget({ businessId: bId, businessVersion: bVer, profileName: pName }, parsed);
      if (parsed.revision === 0 && selectedActiveApiKey) {
        parsed.apiKeyId = selectedActiveApiKey.id;
      }
      let selectedProfileEndpoint = '';
      let action = '';
      let resolvedProfileId: string | null = null;
      if (parsed.revision > 0) {
        const resolution = await lookupStoredProfileIdentity(resolvedTarget, requestToken.tenantId, isCurrentRequest);
        if (!isCurrentRequest()) return;
        if (resolution.kind !== 'resolved') {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem({
            status: 409,
            code: 'PROFILE_ACTION_UNRESOLVED',
            title: resolution.kind === 'ambiguous'
              ? 'This resource name matches multiple saved Profiles in the selected tenant. Open its exact catalog row.'
              : 'The saved Profile identity could not be resolved from this tenant’s catalog. Select a tenant and open the exact catalog row.',
          });
          return;
        }
        if ((parsed.action && parsed.action !== resolution.action)
            || (parsed.endpointSlug !== undefined && resolution.endpointSlug !== undefined && parsed.endpointSlug !== resolution.endpointSlug)) {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem({ status: 409, code: 'PROFILE_IDENTITY_MISMATCH', title: 'The stored Profile action or endpoint does not match its tenant catalog row.' });
          return;
        }
        const exactResult = await client.getProfile(resolvedTarget.businessId, resolvedTarget.businessVersion, resolvedTarget.profileName, {
          tenantId: requestToken.tenantId ?? undefined,
          profileId: resolution.profileId,
        });
        if (!isCurrentRequest()) return;
        if (!exactResult.ok) {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem(exactResult.problem);
          return;
        }
        const exactDetail = parseProfileDetail(exactResult.data);
        if (exactDetail === null || exactDetail.businessId !== resolvedTarget.businessId
            || exactDetail.businessVersion !== resolvedTarget.businessVersion
            || exactDetail.profileName !== resolvedTarget.profileName
            || (exactDetail.action && exactDetail.action !== resolution.action)
            || (exactDetail.endpointSlug !== undefined && resolution.endpointSlug !== undefined && exactDetail.endpointSlug !== resolution.endpointSlug)) {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem({ status: 409, code: 'PROFILE_IDENTITY_MISMATCH', title: 'The exact Profile identity changed while it was loading. Reopen the catalog row.' });
          return;
        }
        parsed = exactDetail;
        action = resolution.action;
        const storedEndpoint = resolution.endpointSlug !== undefined ? resolution.endpointSlug : parsed.endpointSlug;
        if (storedEndpoint === undefined) {
          setDetail(null);
          setDraft(null);
          setLoadedAs(null);
          setProblem({ status: 409, code: 'PROFILE_ENDPOINT_UNRESOLVED', title: 'The saved Profile endpoint is missing from its tenant catalog and detail metadata. Reopen the exact catalog row before editing.' });
          return;
        }
        selectedProfileEndpoint = storedEndpoint?.trim() || '';
        resolvedProfileId = resolution.profileId;
      } else {
        selectedProfileEndpoint = parsed.endpointSlug === null
          ? ''
          : parsed.endpointSlug?.trim() || selectedEndpointSlug;
        action = parsed.action?.trim() || '';
        action = action || newProfileAction(parsed, selectedProfileEndpoint) || '';
      }
      setDetail(parsed);
      setInitialBindings(initialBindingsFromProfile(parsed));
      setBusinessId(resolvedTarget.businessId);
      setBusinessVersion(resolvedTarget.businessVersion);
      setProfileName(resolvedTarget.profileName);
      setEndpointSlug(selectedProfileEndpoint);
      setLoadedAs({
        tenantId: requestToken.tenantId,
        businessId: resolvedTarget.businessId,
        businessVersion: resolvedTarget.businessVersion,
        profileName: resolvedTarget.profileName,
        profileId: resolvedProfileId,
        action,
        endpointSlug: selectedProfileEndpoint || null,
      });
      const initialized = draftFromDetail(parsed, action, selectedProfileEndpoint);
      setDraft(initialized);
      if (parsed.revision === 0) {
        setNotice(`New profile "${pName}" initialized from manifest for action "${action || 'unselected'}". Configure options below and click "Save Profile" to create it.`);
      } else {
        setNotice(`Existing profile "${pName}" loaded for action "${action}" (Revision ${parsed.revision}). You can modify and save updates.`);
      }
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }

  async function setWorkflowEnabled(item: ProfileWorkflowItem, enabled: boolean): Promise<void> {
    if (detail === null || loadedAs === null || !globalTenantId) return;
    const mutationToken = profileRequestScope.current.beginRequest();
    if (loadedAs.tenantId !== globalTenantId || mutationToken.tenantId !== globalTenantId) return;
    const pendingKey = `${item.slug}:${item.revision}`;
    setProfileWorkflowPending(pendingKey);
    setProfileWorkflowsProblem(null);
    try {
      const result = await client.setProfileWorkflow(
        detail.businessId,
        detail.businessVersion,
        loadedAs.profileName,
        globalTenantId,
        { workflowSlug: item.slug, workflowRevision: item.revision, enabled },
        `profile-workflow-${globalThis.crypto.randomUUID()}`,
      );
      if (!profileRequestScope.current.isRequestCurrent(mutationToken)) return;
      if (!result.ok) {
        setProfileWorkflowsProblem(result.problem.title ?? result.problem.code ?? 'Could not update workflow selection.');
      } else {
        setProfileWorkflows((current) => current.map((workflow) => workflow.slug === item.slug
          ? { ...workflow, enabled: workflow.revision === item.revision && enabled }
          : workflow));
        setNotice(`Workflow "${item.slug}" ${enabled ? 'enabled' : 'disabled'} for this profile.`);
      }
    } catch {
      if (profileRequestScope.current.isRequestCurrent(mutationToken)) setProfileWorkflowsProblem('Could not update workflow selection.');
    } finally {
      if (profileRequestScope.current.isRequestCurrent(mutationToken)) setProfileWorkflowPending(null);
    }
  }

  const caps = detail?.capabilities ?? [];
  const policyShipped = true;
  const activeApiKeys = apiKeys.filter((key) => key.tenantId === globalTenantId && key.status === 'ACTIVE');
  const promptConnectionScope = {
    tenantId: globalTenantId,
    apiKeyId: draft?.prompt.apiKeyId ?? '',
    endpointSlug: draft?.prompt.endpointSlug ?? '',
  };
  const promptConnectionScopeKey = promptConnectionScope.tenantId
    && promptConnectionScope.apiKeyId
    && promptConnectionScope.endpointSlug
    ? settingsScopeKey(promptConnectionScope)
    : null;
  const loadPromptApiKeySuggestions = useCallback(async (
    query: string,
    scopeKey: string,
    cursor: string | null,
  ): Promise<ReferenceOptionPage> => {
    if (!globalTenantId || globalTenantId.toLowerCase() !== scopeKey.toLowerCase()
      || access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer') {
      return { items: [], nextCursor: null };
    }
    const result = await client.listApiKeys({ tenantId: scopeKey, limit: '50', ...(cursor ? { cursor } : {}) });
    if (!result.ok) throw new Error('Tenant API key suggestions are unavailable.');
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const items = result.data.items
      .filter((key) => key.tenantId.toLowerCase() === scopeKey.toLowerCase() && key.status === 'ACTIVE')
      .map((key) => ({
        value: key.id,
        label: key.name || 'Unnamed API key',
        description: `Active · ${key.prefix}`,
      }))
      .filter((option) => `${option.value} ${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(normalizedQuery));
    return { items, nextCursor: result.data.nextCursor };
  }, [access, client, globalTenantId]);
  const loadPromptConnectionSuggestions = useCallback(async (
    query: string,
    scopeKey: string,
    cursor: string | null,
  ): Promise<ReferenceOptionPage> => {
    if (cursor || promptConnectionScopeKey === null || scopeKey !== promptConnectionScopeKey
      || access.kind !== 'ready' || access.session.localUser || access.session.role === 'viewer') {
      return { items: [], nextCursor: null };
    }
    const target = promptConnectionScope;
    const result = await client.getSettings({
      ...(target.tenantId ? { tenantId: target.tenantId } : {}),
      apiKeyId: target.apiKeyId,
      endpointSlug: target.endpointSlug,
    });
    if (!result.ok) throw new Error('Scoped connection suggestions are unavailable.');
    if (!settingsResponseMatchesScope(result.data, target)) throw new Error('Connection suggestions did not match the selected tenant, key, and endpoint.');
    const rawPins = result.data['availableConnections'];
    if (!Array.isArray(rawPins)) throw new Error('Scoped connection suggestions were unreadable.');
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const items = rawPins.flatMap((raw): Array<{ value: string; label: string; description?: string }> => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
      const pin = raw as Record<string, unknown>;
      if (typeof pin['slot'] !== 'string' || pin['slot'].length === 0
        || typeof pin['connectionId'] !== 'string' || !isLegacyConnectionId(pin['connectionId'])
        || typeof pin['revision'] !== 'number' || !Number.isSafeInteger(pin['revision']) || pin['revision'] < 1) return [];
      const option = {
        value: pin['connectionId'],
        label: pin['slot'],
        description: `Legacy UUID mapping · revision ${pin['revision']}`,
      };
      return `${option.value} ${option.label} ${option.description}`.toLocaleLowerCase().includes(normalizedQuery) ? [option] : [];
    });
    return { items, nextCursor: null };
  }, [access, client, promptConnectionScope, promptConnectionScopeKey]);
  const selectedActiveApiKey = findCurrentActiveProfileApiKey(apiKeys, selectedApiKeyId, globalTenantId);
  const loadedProfileScopeCurrent = detail !== null && loadedAs !== null && globalTenantId !== null
    && loadedAs.tenantId === globalTenantId;
  const profileWriteBlockMessage = !globalTenantId || (detail !== null && !loadedProfileScopeCurrent)
    ? PROFILE_TENANT_SCOPE_REQUIRED_MESSAGE
    : !selectedActiveApiKey ? PROFILE_API_KEY_REQUIRED_MESSAGE : null;
  const canMutateLoadedProfile = loadedProfileScopeCurrent && selectedActiveApiKey !== undefined;
  const profileWriteProblem: AdminApiProblem = {
    status: 409,
    code: 'ACTIVE_API_KEY_REQUIRED',
    title: PROFILE_API_KEY_REQUIRED_MESSAGE,
  };
  const profileTenantScopeProblem: AdminApiProblem = {
    status: 409,
    code: 'PROFILE_TENANT_SCOPE_REQUIRED',
    title: PROFILE_TENANT_SCOPE_REQUIRED_MESSAGE,
  };
  const canPublish = detail !== null && detail.revision >= 1;
  const canRollback = detail !== null && detail.revision >= 2;
  const profileDraftHasChanges = detail !== null && draft !== null
    && (!sameJson(draft, draftFromDetail(detail, loadedAs?.action, loadedAs?.endpointSlug ?? ''))
      || connectorBindingsChanged(initialBindings, detail.connectorBindings));
  const manifestActionOptions = detail?.manifest.actions
    .map((item) => item.name?.trim() || item.action?.trim() || '')
    .filter((action, index, actions) => action.length > 0 && actions.indexOf(action) === index) ?? [];

  function updateDraft(mutate: (current: Draft) => Draft): void {
    setDraft((current) => (current === null ? current : mutate(current)));
  }

  function updateRow(index: number, next: RowDraft): void {
    updateDraft((d) => ({ ...d, rows: d.rows.map((row, i) => (i === index ? next : row)) }));
  }

  function buildPolicy(row: RowDraft): Record<string, unknown> {
    const parameters: Record<string, { value: unknown }> = {};
    for (const param of row.params) {
      if (param.isLocked) continue; // locked slots are omitted entirely (server 400s presence)
      parameters[param.key] = { value: param.value };
    }
    const policy: Record<string, unknown> = {
      enabled: row.enabled,
      parameters,
      jobPriority: row.jobPriority,
      allowedFileExtensions: row.extensionsCsv,
      connectionsOverride: row.connSteps,
      requestRedaction: row.requestRedaction,
    };
    if (draft !== null && draft.fileUrlAuth.touched) {
      policy.fileUrlAuthConfig = buildFileUrlAuth(draft.fileUrlAuth);
    }
    if (row.callbackClearPending) {
      // CB-01/CB-02 write semantics: explicit `null` clears; an omitted key
      // would PRESERVE the stored policy (profiles.ts:268-276).
      policy.callbackPolicy = null;
    } else if (row.callback !== null && row.callback.touched) {
      const callbackPolicy = buildCallbackPolicy(row.callback);
      if (callbackPolicy !== null) policy.callbackPolicy = callbackPolicy;
    }
    return policy;
  }

  async function saveRow(row: RowDraft): Promise<SaveRowOutcome> {
    const target = loadedAs;
    if (detail === null || target === null) {
      return { result: { profileName: row.profileName, ok: false, detail: 'no profile loaded' } };
    }
    const profileKey = row.profileName.trim() || target.profileName;
    const action = row.action.trim();
    if (!action) {
      return { result: { profileName: profileKey, ok: false, detail: 'Select a manifest action before saving this profile.' } };
    }
    const currentScope = profileRequestScope.current.captureTenant();
    if (!globalTenantId || target.tenantId !== globalTenantId || currentScope.tenantId !== globalTenantId) {
      return {
        result: { profileName: profileKey, ok: false, detail: PROFILE_TENANT_SCOPE_REQUIRED_MESSAGE },
        problem: profileTenantScopeProblem,
      };
    }
    const writeApiKey = findCurrentActiveProfileApiKey(apiKeys, selectedApiKeyId, currentScope.tenantId);
    if (!writeApiKey) {
      return {
        result: { profileName: profileKey, ok: false, detail: PROFILE_API_KEY_REQUIRED_MESSAGE },
        problem: profileWriteProblem,
      };
    }
    const connectorSlots = initialBindings.map((binding) => binding.slot.trim());
    if (initialBindings.length > 32
        || initialBindings.some((binding, index) => connectorSlots[index] === ''
          || connectorSlots[index]!.length > 128
          || binding.connectorId.trim().length === 0
          || binding.connectorId.length > 128
          || !Number.isSafeInteger(binding.revision)
          || binding.revision < 1)
        || new Set(connectorSlots).size !== initialBindings.length) {
      return { result: { profileName: profileKey, ok: false, detail: 'Connector slots must be unique, within the 32-slot limit, and pin a selected positive revision.' } };
    }
    if (detail.revision === 0 && row.endpointSlug && actionFromEndpointSlug(row.endpointSlug) !== action) return { result: { profileName: profileKey, ok: false, detail: 'The selected Document Core endpoint must belong to this row’s manifest action.' } };

    if (row.callback !== null && row.callback.touched) {
      const callbackErrors = validateCallbackDraft(row.callback);
      if (callbackErrors.length > 0) {
        return {
          result: {
            profileName: profileKey,
            ok: false,
            detail: `callback policy invalid: ${callbackErrors[0] ?? 'configuration error'}`,
          },
        };
      }
    }
    const effectiveDetail: ProfileDetail = {
      ...detail,
      apiKeyId: writeApiKey.id,
    };
    const response = await client.upsertProfile(
      target.businessId,
      target.businessVersion,
      profileKey,
      {
        ...buildUpsertBody(effectiveDetail, buildPolicy(row), action),
        ...(row.endpointSlug ? { endpointSlug: row.endpointSlug } : {}),
        connectorBindings: Object.fromEntries(initialBindings.map((binding) => [binding.slot.trim(), { connectorId: binding.connectorId, revision: binding.revision }])),
      },
      crypto.randomUUID(),
    );
    if (response.ok) {
      return {
        result: { profileName: profileKey, ok: true, detail: `saved (revision ${response.data.revision ?? '?'})` },
        savedTarget: profileTargetAfterSave(target, { ...row, profileName: profileKey, action }, response.data.profileId),
      };
    }
    return {
      result: { profileName: profileKey, ok: false, detail: `${response.status} · ${response.problem.code ?? 'ERROR'}` },
      problem: response.problem,
    };
  }

  async function saveOne(row: RowDraft): Promise<void> {
    const target = loadedAs;
    const mutationToken = profileRequestScope.current.beginRequest();
    if (!target || !globalTenantId || target.tenantId !== globalTenantId || mutationToken.tenantId !== globalTenantId) {
      setProblem(profileTenantScopeProblem);
      return;
    }
    const busyOperation = beginBusyOperation();
    setNotice(null);
    setRowResults(null);
    setProblem(null);
    try {
      const { result, problem: failure, savedTarget } = await saveRow(row);
      if (!profileRequestScope.current.isRequestCurrent(mutationToken)) return;
      if (result.ok) {
        if (!savedTarget) {
          setProblem({ status: 502, code: 'PROFILE_IDENTITY_UNRESOLVED', title: 'The Profile was saved, but its returned identity could not be used to reopen it. Open the exact catalog row to continue.' });
          setRowResults([result]);
          return;
        }
        const refreshPromise = load(savedTarget.profileName, savedTarget, busyOperation);
        const refreshToken = profileRequestScope.current.captureRequest();
        const refreshed = await refreshPromise;
        if (!refreshed || !profileRequestScope.current.isRequestCurrent(refreshToken)) return;
        setRowResults([result]);
        setNotice('Saved — profile created/updated in registry.');
      } else {
        setRowResults([result]);
        if (failure !== undefined) setProblem(failure);
      }
    } finally {
      clearBusyOperation(busyOperation);
    }
  }

  async function saveAll(): Promise<void> {
    if (draft === null) return;
    const target = loadedAs;
    const mutationToken = profileRequestScope.current.beginRequest();
    if (!target || !globalTenantId || target.tenantId !== globalTenantId || mutationToken.tenantId !== globalTenantId) {
      setProblem(profileTenantScopeProblem);
      return;
    }
    const busyOperation = beginBusyOperation();
    setNotice(null);
    setProblem(null);
    try {
      // T-UI-04 / R-04: one POST per row, Promise.allSettled, per-row reporting,
      // no common rollback of the rows that did persist.
      const settled = await Promise.allSettled(draft.rows.map((row) => saveRow(row)));
      if (!profileRequestScope.current.isRequestCurrent(mutationToken)) return;
      const rows: RowResult[] = settled.map((entry, index) =>
        entry.status === 'fulfilled'
          ? entry.value.result
          : { profileName: draft.rows[index]?.profileName ?? '?', ok: false, detail: 'transport error' },
      );
      if (rows.some((row) => row.ok)) {
        const savedTarget = firstSuccessfulProfileTarget(settled.flatMap((entry) =>
          entry.status === 'fulfilled'
            ? [{ ok: entry.value.result.ok, ...(entry.value.savedTarget ? { savedTarget: entry.value.savedTarget } : {}) }]
            : [],
        ));
        if (!savedTarget) {
          setRowResults(rows);
          setProblem({ status: 502, code: 'PROFILE_IDENTITY_UNRESOLVED', title: 'The Profiles were saved, but the first successful row did not return an identity that can be reopened. Open the exact catalog row to continue.' });
          return;
        }
        const refreshPromise = load(savedTarget.profileName, savedTarget, busyOperation);
        const refreshToken = profileRequestScope.current.captureRequest();
        const refreshed = await refreshPromise;
        if (!refreshed || !profileRequestScope.current.isRequestCurrent(refreshToken)) return;
        setRowResults(rows);
        setNotice('Save complete: rows that succeeded are persisted.');
      } else {
        setRowResults(rows);
        const firstFailure = settled.find(
          (entry): entry is PromiseFulfilledResult<{ result: RowResult; problem?: AdminApiProblem }> =>
            entry.status === 'fulfilled' && entry.value.problem !== undefined,
        );
        if (firstFailure?.value.problem !== undefined) setProblem(firstFailure.value.problem);
      }
    } finally {
      clearBusyOperation(busyOperation);
    }
  }

  async function publish(): Promise<void> {
    if (detail === null || loadedAs === null) return;
    const mutationToken = profileRequestScope.current.beginRequest();
    if (!globalTenantId || loadedAs.tenantId !== globalTenantId || mutationToken.tenantId !== globalTenantId) { setProblem(profileTenantScopeProblem); return; }
    const writeApiKey = findCurrentActiveProfileApiKey(apiKeys, selectedApiKeyId, mutationToken.tenantId);
    if (!writeApiKey) { setProblem(profileWriteProblem); return; }
    const busyOperation = beginBusyOperation();
    setNotice(null);
    try {
      const effectiveDetail: ProfileDetail = {
        ...detail,
        apiKeyId: writeApiKey.id,
      };
      const result = await client.publishProfile(
        loadedAs.businessId,
        loadedAs.businessVersion,
        loadedAs.profileName,
        buildPublishBody(effectiveDetail, loadedAs.action),
        crypto.randomUUID(),
      );
      if (!profileRequestScope.current.isRequestCurrent(mutationToken)) return;
      if (result.ok) {
        const refreshPromise = load(loadedAs.profileName, {
          businessId: loadedAs.businessId,
          businessVersion: loadedAs.businessVersion,
          profileName: loadedAs.profileName,
          ...(loadedAs.profileId ? { profileId: loadedAs.profileId } : {}),
          action: loadedAs.action,
          endpointSlug: loadedAs.endpointSlug,
        }, busyOperation);
        const refreshToken = profileRequestScope.current.captureRequest();
        const refreshed = await refreshPromise;
        if (!refreshed || !profileRequestScope.current.isRequestCurrent(refreshToken)) return;
        setNotice(`Published (revision ${result.data.revision ?? '?'}).`);
      } else {
        setProblem(result.problem);
      }
    } finally {
      clearBusyOperation(busyOperation);
    }
  }

  async function rollback(target: number): Promise<void> {
    if (detail === null || loadedAs === null) return;
    const mutationToken = profileRequestScope.current.beginRequest();
    if (!globalTenantId || loadedAs.tenantId !== globalTenantId || mutationToken.tenantId !== globalTenantId) { setProblem(profileTenantScopeProblem); return; }
    const writeApiKey = findCurrentActiveProfileApiKey(apiKeys, selectedApiKeyId, mutationToken.tenantId);
    if (!writeApiKey) { setProblem(profileWriteProblem); return; }
    const busyOperation = beginBusyOperation();
    setNotice(null);
    try {
      const effectiveDetail: ProfileDetail = {
        ...detail,
        apiKeyId: writeApiKey.id,
      };
      const result = await client.rollbackProfile(
        loadedAs.businessId,
        loadedAs.businessVersion,
        loadedAs.profileName,
        buildRollbackBody(effectiveDetail, target, loadedAs.action),
        crypto.randomUUID(),
      );
      if (!profileRequestScope.current.isRequestCurrent(mutationToken)) return;
      if (result.ok) {
        const refreshPromise = load(loadedAs.profileName, {
          businessId: loadedAs.businessId,
          businessVersion: loadedAs.businessVersion,
          profileName: loadedAs.profileName,
          ...(loadedAs.profileId ? { profileId: loadedAs.profileId } : {}),
          action: loadedAs.action,
          endpointSlug: loadedAs.endpointSlug,
        }, busyOperation);
        const refreshToken = profileRequestScope.current.captureRequest();
        const refreshed = await refreshPromise;
        if (!refreshed || !profileRequestScope.current.isRequestCurrent(refreshToken)) return;
        setNotice(`Rolled back (active revision ${result.data.revision ?? '?'}).`);
      } else {
        setProblem(result.problem);
      }
    } finally {
      clearBusyOperation(busyOperation);
    }
  }

  async function applyPromptOverride(): Promise<void> {
    if (draft === null) return;
    setNotice(null);
    setProblem(null);
    const result = await client.postAction(
      'prompt-override.upsert',
      {
        connectionId: draft.prompt.connectionId,
        apiKeyId: draft.prompt.apiKeyId,
        endpointSlug: draft.prompt.endpointSlug,
        stepId: draft.prompt.stepId || '_default',
        promptOverride: draft.prompt.text,
        isActive: draft.prompt.isActive,
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    if (result.ok) {
      setNotice('Prompt override submitted.');
    } else {
      setProblem(result.problem);
    }
  }

  function requestWorkbenchHandoff(): void {
    if (!detail || !loadedAs || !globalTenantId || loadedAs.tenantId !== globalTenantId
        || profileRequestScope.current.captureTenant().tenantId !== globalTenantId || detail.revision < 1) {
      setProblem({ status: 409, code: 'PROFILE_REVISION_REQUIRED', title: 'Save a Profile revision and select a tenant before opening the Test Workbench.' });
      return;
    }
    const handoff = {
      handoffId: crypto.randomUUID(),
      tenantId: globalTenantId,
      businessId: detail.businessId,
      businessVersion: detail.businessVersion,
      profileName: detail.profileName,
      expectedRevision: detail.revision,
    };
    setPendingWorkbenchHandoff(handoff);
    if (profileDraftHasChanges) {
      setWorkbenchConfirmOpen(true);
      return;
    }
    navigate('/docs', { state: { profileWorkbenchHandoff: handoff } });
  }

  function confirmWorkbenchHandoff(): void {
    if (!pendingWorkbenchHandoff) return;
    const handoff = pendingWorkbenchHandoff;
    if (handoff.tenantId !== globalTenantId || profileRequestScope.current.captureTenant().tenantId !== globalTenantId) {
      setPendingWorkbenchHandoff(null);
      setProblem(profileTenantScopeProblem);
      return;
    }
    setWorkbenchConfirmOpen(false);
    setPendingWorkbenchHandoff(null);
    navigate('/docs', { state: { profileWorkbenchHandoff: handoff } });
  }

  const profileGroups = groupProfileListRows(profileListPage?.items ?? []);

  if (access.kind === 'loading') {
    return <LoadingState title="Checking Profile access" description="The session must load before catalog or write actions are enabled." />;
  }
  if (access.kind === 'failed') {
    return <ErrorState title={access.problem.title ?? 'Profile access could not be checked.'} statusCode={access.problem.status || undefined} error={access.problem.code} onRetry={() => { setAccess({ kind: 'loading' }); void client.getSession().then((result) => setAccess(result.ok ? { kind: 'ready', session: result.data } : { kind: 'failed', problem: result.problem })); }} />;
  }
  if (access.session.localUser) {
    const assignedTenantId = access.session.principal.kind === 'tenant_operator' ? access.session.principal.tenantId : null;
    if (!assignedTenantId) return <DeniedState title="Assigned Profile scope unavailable" description="This local-user session has no validated tenant scope." />;
    return <AssignedProfilesWorkspace client={client} tenantId={assignedTenantId} proposalDraft={workbenchProposal} onProposalConsumed={consumeWorkbenchProposal} />;
  }
  if (access.session.role !== 'admin') {
    return <DeniedState title="Profile management requires an administrator session" description="Operator and viewer sessions can’t create, publish, roll back, or manage Profile assignments here." tenantId={globalTenantId ?? undefined} />;
  }

  return (
    <section aria-labelledby="profiles-title" className="flex flex-col gap-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="profiles-title" className="text-lg font-semibold">
          Profiles
        </h1>
        <Badge variant="neutral">PAR-12 + PAR-13 slice</Badge>
        {!policyShipped && detail !== null ? (
          <Badge variant="warning" dot>
            policy backend not shipped (T-API-01..03)
          </Badge>
        ) : null}
      </div>

      <AlertBanner variant="info" title="How Profiles work">
        Profiles define versioned endpoint settings and connector bindings for each business. Saving creates a new
        revision; publishing selects the active revision, and rollback restores an earlier revision.
      </AlertBanner>

      <TabsRoot value={screenTab} onValueChange={(value) => { if (value) setScreenTab(value as 'catalog' | 'groups' | 'editor'); }} className="min-w-0">
        <TabsList aria-label="Profile management sections" className="flex-wrap">
          <TabsTab value="catalog">Catalog</TabsTab>
          {access.session.principal.kind === 'platform' ? <TabsTab value="groups">Groups</TabsTab> : null}
          <TabsTab value="editor">Selected editor</TabsTab>
        </TabsList>
        <TabsPanel value="catalog" keepMounted>

      <Card>
        <CardHeader>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(20rem,auto)] sm:items-start">
            <div>
              <CardTitle>Profiles</CardTitle>
              <CardDescription>
                Catalog for the selected tenant. Active key count includes only active profile-to-key bindings; bound actions come from the active revision.
              </CardDescription>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto] sm:items-start">
              <FormField id="profile-list-business" label="Business filter">
                <select
                  id="profile-list-business"
                  aria-label="Filter profiles by business"
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm font-medium"
                  value={profileListBusinessId}
                  onChange={(event) => changeProfileListBusinessId(event.target.value)}
                  disabled={!globalTenantId}
                >
                  <option value="">All businesses</option>
                  {businesses.map((business) => <option key={business} value={business}>{business}</option>)}
                </select>
              </FormField>
              {profileWriteBlockMessage !== null ? (
                <p role="status" className="mt-2 text-xs text-[var(--text-sub)]">
                  {profileWriteBlockMessage}{' '}
                  {profileWriteBlockMessage === PROFILE_API_KEY_REQUIRED_MESSAGE ? <Link className="font-medium text-[var(--cf-blue)] underline underline-offset-2" to="/api-keys">Manage API keys</Link> : null}
                </p>
              ) : null}
              <div className="sm:mt-[1.375rem]">
                <Button variant="outline" onClick={refreshProfileCatalog} disabled={!globalTenantId || profileListLoading}>
                  Refresh
                </Button>
              </div>
            </div>
          </div>
          {profileListPage ? <p className="text-xs text-[var(--text-sub)]">Server page {profileListPageIndex + 1} · {profileListPage.items.length} rows on this page · {profileListPage.total} reported total</p> : null}
        </CardHeader>
        <CardContent>
          {!globalTenantId ? (
            <AlertBanner variant="warning" title="Select a tenant to view profiles">
              Profile metadata is tenant-scoped. Choose a tenant in the application header to load its profile catalog.
            </AlertBanner>
          ) : profileListLoading ? (
            <LoadingState title="Loading profiles" description="Reading profile metadata for the selected tenant." />
          ) : profileListPage === null && profileListProblem !== null ? (
            profileListProblem.status === 401 || profileListProblem.status === 403 ? (
              <DeniedState title={profileListProblem.status === 401 ? 'Sign-in required' : 'Access denied'} description={profileListProblem.title ?? 'This session cannot read profiles in the selected tenant.'} tenantId={globalTenantId} />
            ) : (
              <ErrorState title={profileListProblem.title ?? 'The profile catalog could not be loaded.'} statusCode={profileListProblem.status || undefined} error={profileListProblem.code} onRetry={refreshProfileCatalog} />
            )
          ) : profileListPage === null ? null : profileListPage.items.length === 0 ? (
            <div role="status" className="rounded-md border border-dashed border-[var(--border-subtle)] px-4 py-10 text-center text-sm text-[var(--text-sub)]">
              No profiles were found for this tenant and business filter.
            </div>
          ) : (
            <>
              {profileListProblem !== null ? (
                <AlertBanner variant="error" title={profileListProblem.title ?? 'Profile page navigation failed.'} className="mb-3">
                  {profileListProblem.status || 'Network error'} · {profileListProblem.code ?? 'ERROR'} The rows already loaded remain visible.
                </AlertBanner>
              ) : null}
              <TableContainer maxHeight={520} aria-label="Current server page of the profile catalog">
                <Table density="compact">
                  <TableHeader sticky>
                    <TableRow>
                      <TableHead>Profile</TableHead>
                      <TableHead>Business</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Active keys</TableHead>
                      <TableHead>Bound actions</TableHead>
                      <TableHead><span className="sr-only">Open profile</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profileGroups.map((group) => (
                      <Fragment key={group.businessId}>
                        <TableRow className="bg-[var(--bg-subtle)]">
                          <TableCell colSpan={7} className="font-semibold">
                            {group.businessId} <span className="font-normal text-[var(--text-sub)]">· {group.items.length} profile{group.items.length === 1 ? '' : 's'}</span>
                          </TableCell>
                        </TableRow>
                        {group.items.map(({ row, key }) => (
                          <TableRow key={key}>
                            <TableCell className="font-medium">{row.profileName}</TableCell>
                            <TableCell>{row.businessId}</TableCell>
                            <TableCell>{row.businessVersion}</TableCell>
                            <TableCell>
                              <Badge variant={row.status === 'ACTIVE' ? 'success' : row.status === 'DISABLED' ? 'warning' : 'neutral'}>{row.status}</Badge>
                            </TableCell>
                            <TableCell>{row.keyCount}</TableCell>
                            <TableCell>
                              {row.boundActions.length > 0 ? (
                                <div className="flex flex-wrap gap-1.5">
                                  {row.boundActions.map((action) => <Badge key={action} variant="info">{action}</Badge>)}
                                </div>
                              ) : <span className="text-[var(--text-sub)]">None</span>}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={loading}
                                onClick={() => void load(undefined, {
                                  businessId: row.businessId,
                                  businessVersion: row.businessVersion,
                                  profileName: row.profileName,
                                  ...(row.profileId ? { profileId: row.profileId } : {}),
                                  ...(row.action ? { action: row.action } : row.boundActions.length === 1 ? { action: row.boundActions[0] } : {}),
                                  ...(row.endpointSlug !== undefined ? { endpointSlug: row.endpointSlug } : {}),
                                })}
                              >
                                Open
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <TablePagination
                ariaLabel="Profile catalog server pages"
                hasPreviousPage={profileListPageIndex > 0 || profileListPage.prevCursor !== null}
                hasNextPage={profileListPage.nextCursor !== null}
                onPreviousPage={() => void loadMoreProfiles('previous')}
                onNextPage={() => void loadMoreProfiles('next')}
                pending={profileListLoadingMore}
                status={`Server page ${profileListPageIndex + 1} · ${profileListPage.items.length} rows on this page · ${profileListPage.total} reported total`}
                className="mt-3 justify-end"
              />
            </>
          )}
        </CardContent>
      </Card>

        </TabsPanel>
        <TabsPanel value="groups" keepMounted>
          {access.session.principal.kind === 'platform' ? <ProfileGroupEditor tenantId={globalTenantId} /> : <p className="text-sm text-[var(--text-sub)]">Profile groups are available only to platform administrators.</p>}
        </TabsPanel>
        <TabsPanel value="editor" keepMounted>

      <Card>
        <CardHeader>
          <CardTitle>Create Profile</CardTitle>
          <CardDescription>
            Select a business service, version, and name to create a new profile from its manifest or load an existing profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {businessId === 'document-core' && <label className="block min-w-0 text-sm sm:col-span-2 xl:col-span-3">Document Core endpoint (optional)<select aria-label="Legacy endpoint" className="mt-1 block w-full min-w-0 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] p-2" value={endpointSlug} onChange={e => {
              const selected = e.target.value;
              setEndpointSlug(selected);
              if (detail?.revision === 0) {
                const action = selected ? actionFromEndpointSlug(selected) ?? '' : newProfileAction(detail, '') ?? '';
                setDraft((current) => current === null ? current : {
                  ...current,
                  rows: current.rows.map((row, index) => index === 0 ? { ...row, action, endpointSlug: selected } : row),
                  prompt: { ...current.prompt, endpointSlug: selected || action },
                });
                setLoadedAs((current) => current === null ? current : { ...current, action, endpointSlug: selected || null });
              }
            }} disabled={businessFunctionCatalogLoading || !businessFunctionCatalog}><option value="">Generic action profile</option>{businessFunctionCatalog?.functions.filter((fn) => fn.kind === 'endpoint').map((fn) => <option key={fn.functionId} value={fn.endpointSlug ?? ''} disabled={fn.available === false}>{fn.endpointSlug ?? fn.functionId}{fn.available === false ? ` — unavailable: ${fn.unavailableReason ?? 'not supported'}` : ''}</option>)}</select>{businessFunctionCatalogLoading ? <span className="mt-1 block text-xs text-[var(--text-sub)]">Loading endpoints from {businessVersion} manifest…</span> : null}{businessFunctionCatalogProblem ? <span role="alert" className="mt-1 block break-words text-xs text-[var(--badge-danger-text)]">{businessFunctionCatalogProblem}</span> : null}<span className="mt-1 block text-xs text-[var(--text-sub)]">Exact endpoint profiles override generic action profiles; endpoint choices come from the selected version manifest.</span></label>}
            <div className="min-w-0 sm:col-span-2 xl:col-span-3">
              <p className="mb-2 text-sm text-[var(--text-sub)]">Connector pins are saved with each Profile revision. Select an active tenant Connector revision for every slot you want pinned.</p>
              <InitialBindings value={initialBindings} onChange={setInitialBindings} />
            </div>
            <div className="w-full min-w-0 max-w-xs xl:col-span-2">
              <FormField id="profile-business" label="Business Service">
                <select
                  id="profile-business"
                  aria-label="Business"
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm font-medium"
                  value={businessId}
                  onChange={(e) => setBusinessId(e.target.value)}
                >
                  {businesses.length === 0 ? (
                    <option value="">No businesses registered</option>
                  ) : (
                    businesses.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))
                  )}
                </select>
              </FormField>
            </div>

            <div className="w-full min-w-0 max-w-[10rem] xl:col-span-1">
              <FormField id="profile-version" label="Version">
                <select
                  id="profile-version"
                  aria-label="Version"
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm font-medium"
                  value={businessVersion}
                  onChange={(e) => setBusinessVersion(e.target.value)}
                >
                  {versions.length === 0 ? (
                    <option value="latest">latest</option>
                  ) : (
                    versions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))
                  )}
                </select>
              </FormField>
            </div>

            <div className="w-full min-w-0 max-w-[12rem] xl:col-span-1">
              <FormField id="profile-name" label="Profile Name">
                <Input
                  id="profile-name"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="e.g. default"
                />
              </FormField>
            </div>

            <div className="w-full min-w-0 max-w-xs xl:col-span-2">
              <FormField id="profile-api-key" label="API Key">
                <select
                  id="profile-api-key"
                  aria-label="API Key"
                  className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm"
                  value={selectedApiKeyId}
                  onChange={(e) => setSelectedApiKeyId(e.target.value)}
                >
                  <option value="">{activeApiKeys.length === 0 ? 'No active key in tenant' : 'Select an active API key'}</option>
                  {activeApiKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name ? `${k.name} (${k.id.slice(0, 8)}...)` : `Key (${k.id.slice(0, 8)}...)`}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-6">
              <Button
                onClick={() => void createProfile()}
                isLoading={loading}
                disabled={businessId.trim().length === 0}
              >
                Create Profile
              </Button>
              <Button
                variant="outline"
                onClick={() => void load()}
                isLoading={loading}
                disabled={businessId.trim().length === 0}
              >
                Load Profile
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {problem !== null && detail === null ? (
        problem.status === 403 ? (
          <DeniedState
            title="Access denied"
            description={profileErrorHint(problem.code) ?? problem.title ?? 'This session is not authorized for the Profile screen.'}
          />
        ) : (
          <ErrorState
            title={problem.title ?? 'The Profile API rejected the request.'}
            statusCode={problem.status}
            error={problem.code}
            onRetry={identifiers.businessId.length > 0 ? () => void load() : undefined}
          />
        )
      ) : null}

      {problem !== null && detail !== null ? (
        <AlertBanner variant="error" title={problem.title ?? 'The Profile API rejected the request.'}>
          {problem.status} · {problem.code ?? 'ERROR'}
          {profileErrorHint(problem.code) ? <> — {profileErrorHint(problem.code)}</> : null}
        </AlertBanner>
      ) : null}
      {notice !== null ? (
        <AlertBanner variant="success" title="Profile">
          {notice}
        </AlertBanner>
      ) : null}

      {loading ? <LoadingState title="Loading profile…" /> : null}

      {detail !== null && draft !== null ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>
                  {detail.businessId}@{detail.businessVersion} · {detail.profileName || '(new)'}
                </CardTitle>
                <Badge variant={detail.revision === 0 ? 'warning' : 'success'}>
                  {detail.revision === 0 ? 'Draft / New Profile (Revision 0)' : `Revision ${detail.revision}`}
                </Badge>
                {caps.length === 0 ? <Badge variant="warning" dot>no capabilities reported</Badge> : null}
                {caps.slice(0, 6).map((capability) => (
                  <Badge key={`${capability.connectorId}:${capability.capability}`} variant="info">
                    {capability.connectorId}:{capability.capability}
                  </Badge>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {rowResults !== null ? (
                <div className="mb-3">
                  <AlertBanner variant={rowResults.every((r) => r.ok) ? 'success' : 'warning'} title="Bulk save results (per row)">
                    <ul>
                      {rowResults.map((row) => (
                        <li key={row.profileName}>
                          <code>{row.profileName}</code>: {row.ok ? 'OK' : 'FAILED'} — {row.detail}
                        </li>
                      ))}
                    </ul>
                  </AlertBanner>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveAll()} disabled={busy || loading || !canMutateLoadedProfile} title={profileWriteBlockMessage ?? 'Save profile settings to registry'}>
                  Save Profile
                </Button>
                <Button variant="outline" onClick={() => void publish()} disabled={!canPublish || busy || loading || !canMutateLoadedProfile} title={profileWriteBlockMessage ?? (canPublish ? 'Publish' : 'Publish capability not reported')}>
                  Publish
                </Button>
                <Button variant="outline" onClick={() => void rollback(Math.max(1, detail.revision - 1))} disabled={!canRollback || busy || loading || detail.revision < 2 || !canMutateLoadedProfile} title={profileWriteBlockMessage ?? (canRollback ? 'Rollback to previous revision' : 'Rollback capability not reported')}>
                  Rollback to v{Math.max(1, detail.revision - 1)}
                </Button>
                <Button variant="outline" onClick={requestWorkbenchHandoff} disabled={busy || loading || detail.revision < 1 || !globalTenantId} title="Open the exact saved Profile revision in the Test Workbench">
                  Test in Workbench
                </Button>
                <Button
                  variant="secondary"
                  disabled={!policyShipped}
                  onClick={() =>
                    updateDraft((d) => ({
                      ...d,
                      rows: [
                        ...d.rows,
                        { profileName: '', action: '', endpointSlug: '', enabled: true, jobPriority: 'MEDIUM', extensionsCsv: '', params: [], connSteps: [], requestRedaction: [], callback: null, callbackConfiguredOnServer: false, callbackPolicyInvalid: false, callbackClearPending: false },
                      ],
                    }))
                  }
                >
                  Add endpoint row
                </Button>
              </div>
            </CardContent>
          </Card>

          <TabsRoot defaultValue="parameters" className="min-w-0">
            <TabsList aria-label="Selected profile configuration" className="flex-wrap">
              <TabsTab value="parameters">Parameters &amp; bindings</TabsTab>
              <TabsTab value="workflows">Workflows</TabsTab>
              <TabsTab value="api-keys">API keys</TabsTab>
              <TabsTab value="callback">Callback &amp; redaction</TabsTab>
              <TabsTab value="auth-prompts">Auth &amp; prompts</TabsTab>
              <TabsTab value="snapshot">Snapshot</TabsTab>
            </TabsList>
            <TabsPanel value="workflows" keepMounted>
          {detail.revision > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Workflow schemas</CardTitle>
                <CardDescription>
                  Choose workflow revisions registered to {detail.businessId}@{detail.businessVersion}. Legacy workflows without a business assignment are not shown here.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {!globalTenantId ? (
                  <p className="text-sm text-[var(--text-sub)]">Select a tenant before managing profile workflows.</p>
                ) : profileWorkflowsLoading ? (
                  <LoadingState title="Loading business workflows…" />
                ) : profileWorkflowsProblem !== null ? (
                  <AlertBanner variant="error" title="Workflow selection unavailable">
                    {profileWorkflowsProblem}
                  </AlertBanner>
                ) : profileWorkflows.length === 0 ? (
                  <p className="text-sm text-[var(--text-sub)]">No workflow schemas are registered to this business version.</p>
                ) : (
                  profileWorkflows.map((workflow) => {
                    const pendingKey = `${workflow.slug}:${workflow.revision}`;
                    const pending = profileWorkflowPending === pendingKey;
                    return (
                      <div key={pendingKey} className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--border-subtle)] p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="text-sm">{workflow.slug}</code>
                          <span className="text-xs text-[var(--text-sub)]">Revision {workflow.revision}</span>
                          <Badge variant={workflow.status === 'active' ? 'success' : 'neutral'}>{workflow.status}</Badge>
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            aria-label={`Use workflow ${workflow.slug} revision ${workflow.revision}`}
                            checked={workflow.enabled}
                            disabled={profileWorkflowPending !== null || (workflow.status === 'retired' && !workflow.enabled)}
                            onChange={(event) => void setWorkflowEnabled(workflow, event.target.checked)}
                          />
                          {pending ? 'Saving…' : 'Enabled for profile'}
                        </label>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          ) : null}

            </TabsPanel>
            <TabsPanel value="parameters" keepMounted>
          {draft.rows.map((row, rowIndex) => (
            <Card key={`row-${rowIndex}`}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    aria-label="row profile name"
                    className="w-full max-w-[12rem]"
                    value={row.profileName}
                    disabled={!policyShipped}
                    onChange={(e) => updateRow(rowIndex, { ...row, profileName: e.target.value })}
                    placeholder="profile name"
                  />
                  <label className="block w-full max-w-[12rem] text-xs text-[var(--text-sub)]">
                    Manifest action
                    <select
                      aria-label="row manifest action"
                      className="mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-main)]"
                      value={row.action}
                      disabled={!policyShipped}
                      onChange={(event) => updateRow(rowIndex, { ...row, action: event.currentTarget.value })}
                    >
                      <option value="">Select action</option>
                      {row.action && !manifestActionOptions.includes(row.action) ? <option value={row.action}>{row.action} (stored)</option> : null}
                      {manifestActionOptions.map((action) => <option key={action} value={action}>{action}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={!policyShipped}
                      onChange={(e) => updateRow(rowIndex, { ...row, enabled: e.target.checked })}
                    />{' '}
                    enabled
                  </label>
                </div>
                <CardDescription>Profile name is the tenant-scoped resource key. Manifest action controls the API binding. Locked slots are display-only; the server rejects a locked field even when unchanged.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-3">
                  <div className="w-full max-w-[10rem]">
                    <FormField id={`priority-${rowIndex}`} label="Job priority">
                      <select
                        id={`priority-${rowIndex}`}
                        className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm"
                        value={row.jobPriority}
                        disabled={!policyShipped}
                        onChange={(e) => updateRow(rowIndex, { ...row, jobPriority: e.target.value as Priority })}
                      >
                        <option value="LOW">LOW (queue 20)</option>
                        <option value="MEDIUM">MEDIUM (queue 10)</option>
                        <option value="HIGH">HIGH (queue 1)</option>
                      </select>
                    </FormField>
                  </div>
                  <div className="w-full max-w-sm">
                    <FormField id={`ext-${rowIndex}`} label="Allowed file extensions (CSV)">
                      <Input
                        id={`ext-${rowIndex}`}
                        value={row.extensionsCsv}
                        disabled={!policyShipped}
                        onChange={(e) => updateRow(rowIndex, { ...row, extensionsCsv: e.target.value })}
                        placeholder=".pdf,.docx"
                      />
                    </FormField>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <strong className="text-sm">Parameters</strong>
                  {row.params.length === 0 ? (
                    <p className="text-xs text-[var(--text-sub)]">No parameters in this policy.</p>
                  ) : null}
                  {row.params.map((param, paramIndex) => (
                    <div key={param.key} className="flex flex-wrap items-center gap-2">
                      <code className="text-xs w-full max-w-[14rem] break-all">{param.key}</code>
                      <Input
                        aria-label={`value ${param.key}`}
                        value={param.value}
                        readOnly={param.isLocked}
                        disabled={param.isLocked || !policyShipped}
                        data-locked={param.isLocked ? 'true' : undefined}
                        className="w-full max-w-sm"
                        onChange={(e) =>
                          updateRow(rowIndex, {
                            ...row,
                            params: row.params.map((p, i) => (i === paramIndex ? { ...p, value: e.target.value } : p)),
                          })
                        }
                      />
                      {param.isLocked ? (
                        <Badge variant="neutral" dot>
                          locked
                        </Badge>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div className="flex flex-col gap-2">
                  <strong className="text-sm">Connections override (ConnectionStep[])</strong>
                  {row.connSteps.map((step, stepIndex) => (
                    <div key={`${step.slug}:${stepIndex}`} className="flex flex-wrap items-center gap-2 text-xs">
                      <code>{step.slug}</code>
                      {step.stepId ? <span>step {step.stepId}</span> : null}
                      {step.captureSession ? <Badge variant="info">capture</Badge> : null}
                      {step.injectSession ? <Badge variant="info">inject</Badge> : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!policyShipped}
                        onClick={() => updateRow(rowIndex, { ...row, connSteps: row.connSteps.filter((_, i) => i !== stepIndex) })}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-start gap-2">
                    <Input id={`step-slug-${rowIndex}`} aria-label="connection slug" placeholder="connection slug" className="w-full max-w-[12rem]" disabled={!policyShipped} />
                    <Input id={`step-id-${rowIndex}`} aria-label="step id" placeholder="stepId (optional)" className="w-full max-w-[10rem]" disabled={!policyShipped} />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!policyShipped}
                      onClick={() => {
                        const slugInput = document.getElementById(`step-slug-${rowIndex}`) as HTMLInputElement | null;
                        const stepInput = document.getElementById(`step-id-${rowIndex}`) as HTMLInputElement | null;
                        const slug = slugInput?.value.trim() ?? '';
                        if (slug.length === 0) return;
                        updateRow(rowIndex, {
                          ...row,
                          connSteps: [...row.connSteps, { slug, ...(stepInput?.value.trim() ? { stepId: stepInput.value.trim() } : {}) }],
                        });
                      }}
                    >
                      Add step
                    </Button>
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy || draft.rows.length < 2}
                    onClick={() =>
                      updateDraft((d) => ({ ...d, rows: d.rows.filter((_, i) => i !== rowIndex) }))
                    }
                  >
                    Remove row
                  </Button>
                  <Button
                    onClick={() => void saveOne(row)}
                    disabled={!policyShipped || busy || loading || !canMutateLoadedProfile}
                    title={profileWriteBlockMessage ?? (policyShipped ? 'Save row' : 'Policy backend not shipped')}
                  >
                    Save {row.profileName.trim() || '(unnamed)'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

            </TabsPanel>
            <TabsPanel value="callback" keepMounted>
              <div className="flex flex-col gap-3">
                {draft.rows.map((row, rowIndex) => <Card key={`callback-${rowIndex}`}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2"><CardTitle>{row.profileName.trim() || `Endpoint row ${rowIndex + 1}`}</CardTitle><Badge variant="info" dot>secrets stay server-side</Badge></div>
                    <CardDescription>Callback and request redaction settings for this endpoint row.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <RequestRedactionEditor rules={row.requestRedaction} disabled={!policyShipped || busy} onChange={(rules) => updateRow(rowIndex, { ...row, requestRedaction: rules })} />
                    <section className="flex flex-col gap-4 rounded-md border border-[var(--border-subtle)] p-3" aria-label={`Callback policy for ${row.profileName || `row ${rowIndex + 1}`}`}>
                      <div>
                        <h3 className="text-sm font-semibold">Callback policy (CB-04)</h3>
                        <p className="mt-1 text-xs text-[var(--text-sub)]">Credentials are catalog secret references only. Leaving the policy unchecked preserves notification-only behavior.</p>
                      </div>
                      {row.callbackPolicyInvalid ? <div role="alert" className="flex flex-col items-start gap-2 text-sm text-[var(--badge-warning-text)]">
                        <p>The stored callback policy is invalid. Callback processing remains blocked until you replace or clear it.</p>
                        <Button type="button" disabled={!policyShipped || busy || row.callbackClearPending} onClick={() => updateRow(rowIndex, { ...row, callback: null, callbackClearPending: true })}>Clear invalid callback policy</Button>
                      </div> : null}
                      <label className="flex items-center gap-2 text-sm text-[var(--text-main)]">
                        <input type="checkbox" checked={row.callback !== null} disabled={!policyShipped || busy} onChange={(event) => updateRow(rowIndex, event.target.checked ? { ...row, callback: emptyCallbackDraft(), callbackClearPending: false } : { ...row, callback: null, callbackClearPending: row.callbackConfiguredOnServer })} />
                        Configure a callback policy for this profile
                      </label>
                      {row.callbackClearPending ? <p className="text-xs text-[var(--badge-warning-text)]" role="status">Saving now sends an explicit clear (`callbackPolicy: null`); an omitted key would keep the stored policy active.</p> : null}
                      {row.callback !== null ? <CallbackPolicyEditor idPrefix={`profile-${rowIndex}-callback`} draft={row.callback} onChange={(callback) => updateRow(rowIndex, { ...row, callback })} secrets={secretOptions} secretsLoading={secretsLoading} secretsProblem={secretsProblem} disabled={!policyShipped || busy} /> : row.callbackClearPending ? null : <p className="text-xs text-[var(--text-sub)]">No callback policy is attached: the platform keeps the existing notification-only delivery (submission callback URL + HMAC signature).</p>}
                    </section>
                  </CardContent>
                </Card>)}
              </div>
            </TabsPanel>
            <TabsPanel value="auth-prompts" keepMounted>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>fileUrlAuthConfig (write-only)</CardTitle>
                <Badge variant="warning" dot>
                  write-only · snake_case
                </Badge>
                {detail.policy.fileUrlAuthConfigured ? <Badge variant="info">configured on server</Badge> : null}
              </div>
              <CardDescription>
                Encrypted server-side (AES-256-GCM, T-PROF-04); the read wire never returns it. Fields below follow the
                frozen legacy shape and are sent only when touched — nothing is stored in the browser.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="w-full max-w-[10rem]">
                <FormField id="fua-type" label="type">
                  <select
                    id="fua-type"
                    className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 text-sm"
                    value={draft.fileUrlAuth.type}
                    disabled={!policyShipped}
                    onChange={(e) =>
                      updateDraft((d) => ({
                        ...d,
                        fileUrlAuth: { ...d.fileUrlAuth, touched: true, type: e.target.value as FileUrlAuthType },
                      }))
                    }
                  >
                    <option value="none">none</option>
                    <option value="bearer">bearer</option>
                    <option value="header">header</option>
                    <option value="query">query</option>
                  </select>
                </FormField>
              </div>
              {draft.fileUrlAuth.type === 'bearer' ? (
                <div className="w-full max-w-sm">
                  <FormField id="fua-token" label="token">
                    <Input
                      id="fua-token"
                      type="password"
                      value={draft.fileUrlAuth.token}
                      disabled={!policyShipped}
                      onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, token: e.target.value } }))}
                      placeholder="sent on save, never re-read"
                    />
                  </FormField>
                </div>
              ) : null}
              {draft.fileUrlAuth.type === 'header' ? (
                <>
                  <div className="w-full max-w-[12rem]">
                    <FormField id="fua-header-name" label="header_name">
                      <Input id="fua-header-name" value={draft.fileUrlAuth.header_name} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, header_name: e.target.value } }))} />
                    </FormField>
                  </div>
                  <div className="w-full max-w-sm">
                    <FormField id="fua-header-value" label="header_value">
                      <Input id="fua-header-value" type="password" value={draft.fileUrlAuth.header_value} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, header_value: e.target.value } }))} />
                    </FormField>
                  </div>
                </>
              ) : null}
              {draft.fileUrlAuth.type === 'query' ? (
                <>
                  <div className="w-full max-w-[12rem]">
                    <FormField id="fua-query-key" label="query_key">
                      <Input id="fua-query-key" value={draft.fileUrlAuth.query_key} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, query_key: e.target.value } }))} />
                    </FormField>
                  </div>
                  <div className="w-full max-w-sm">
                    <FormField id="fua-query-value" label="query_value">
                      <Input id="fua-query-value" type="password" value={draft.fileUrlAuth.query_value} disabled={!policyShipped} onChange={(e) => updateDraft((d) => ({ ...d, fileUrlAuth: { ...d.fileUrlAuth, touched: true, query_value: e.target.value } }))} />
                    </FormField>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>


          <Card>
            <CardHeader>
              <CardTitle>Prompt override (PAR-13, key-4)</CardTitle>
              <CardDescription>
                Upsert via <code>prompt-override.upsert</code> (dispatcher). Errors are shown honestly until the
                dispatcher case lands.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="w-full max-w-[16rem]"><FormField id="prompt-connection-id" label="Connection ID" description="Choose a legacy connection UUID pinned to this tenant, key, and endpoint, or enter a UUID directly."><ReferenceInput id="prompt-connection-id" value={draft.prompt.connectionId} onValueChange={(value) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, connectionId: value } }))} scopeKey={promptConnectionScopeKey} loadOptions={loadPromptConnectionSuggestions} sourceVersion={access.kind} placeholder="connectionId (UUID)" autoComplete="off" /></FormField></div>
                <div className="w-full max-w-[16rem]"><FormField id="prompt-api-key-id" label="API key ID" description="Select an active API key for the current tenant or enter its UUID directly."><ReferenceInput id="prompt-api-key-id" value={draft.prompt.apiKeyId} onValueChange={(value) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, apiKeyId: value } }))} scopeKey={globalTenantId} loadOptions={loadPromptApiKeySuggestions} sourceVersion={access.kind} placeholder="apiKeyId (UUID)" autoComplete="off" /></FormField></div>
                <div className="w-full max-w-[10rem]"><FormField id="prompt-endpoint-slug" label="Endpoint slug"><Input id="prompt-endpoint-slug" placeholder="endpointSlug" value={draft.prompt.endpointSlug} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, endpointSlug: e.target.value } }))} /></FormField></div>
                <div className="w-full max-w-[10rem]"><FormField id="prompt-step-id" label="Step ID"><Input id="prompt-step-id" placeholder="stepId (_default)" value={draft.prompt.stepId} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, stepId: e.target.value } }))} /></FormField></div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.prompt.isActive} onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, isActive: e.target.checked } }))} />
                  active (off = delete)
                </label>
              </div>
              <textarea
                aria-label="prompt override"
                className="min-h-24 w-full rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] p-3 text-sm"
                value={draft.prompt.text}
                onChange={(e) => updateDraft((d) => ({ ...d, prompt: { ...d.prompt, text: e.target.value } }))}
                placeholder="Prompt override for this (connection, key, endpoint, step)"
              />
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => void applyPromptOverride()}>
                  Apply prompt override
                </Button>
              </div>
            </CardContent>
          </Card>

            </TabsPanel>
            <TabsPanel value="api-keys" keepMounted>
              {detail !== null && loadedAs !== null ? <ProfileApiKeysPanel businessId={loadedAs.businessId} businessVersion={loadedAs.businessVersion} profileName={loadedAs.profileName} revision={detail.revision} /> : <p className="text-sm text-[var(--text-sub)]">Load a saved Profile before managing its API keys.</p>}
            </TabsPanel>
            <TabsPanel value="snapshot" keepMounted>
          <Card>
            <CardHeader>
              <CardTitle>Profile snapshot</CardTitle>
              <CardDescription>
                This is the selected saved Profile revision. The Test Workbench rechecks this exact revision and current tenant access before running it; this screen does not synthesize a merged callsite configuration.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div><span className="font-medium">Profile:</span> {detail.businessId}@{detail.businessVersion} · {detail.profileName} · revision {detail.revision}</div>
              <div><span className="font-medium">Connector bindings:</span> {Object.keys(detail.connectorBindings ?? {}).length === 0
                ? 'none recorded'
                : Object.entries(detail.connectorBindings).map(([slot, binding]) => `${slot}: ${binding.connectorId}@${binding.revision}`).join(' · ')}</div>
              <div className="text-xs text-[var(--text-sub)]">Credentials and effective provider configuration are not shown here.</div>
            </CardContent>
          </Card>
            </TabsPanel>
          </TabsRoot>
        </>
      ) : null}

        </TabsPanel>
      </TabsRoot>

      <Modal
        open={workbenchConfirmOpen}
        onOpenChange={(open) => {
          setWorkbenchConfirmOpen(open);
          if (!open) setPendingWorkbenchHandoff(null);
        }}
        title="Open the Test Workbench?"
        description="The Workbench will load the current saved revision. Local Profile edits on this screen will not be carried over."
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => { setWorkbenchConfirmOpen(false); setPendingWorkbenchHandoff(null); }}>
              Keep editing
            </Button>
            <Button onClick={confirmWorkbenchHandoff} disabled={!pendingWorkbenchHandoff}>
              Discard local edits and continue
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm">Unsaved Profile changes stay in this page only. The Workbench loads the saved revision and displays a conflict if it has changed since this screen read it.</p>
        </div>
      </Modal>
    </section>
  );
}

function buildFileUrlAuth(draft: FileUrlAuthDraft): FileUrlAuthConfigWrite {
  const config: FileUrlAuthConfigWrite = { type: draft.type };
  if (draft.type === 'bearer' && draft.token.length > 0) config.token = draft.token;
  if (draft.type === 'header') {
    if (draft.header_name.length > 0) config.header_name = draft.header_name;
    if (draft.header_value.length > 0) config.header_value = draft.header_value;
  }
  if (draft.type === 'query') {
    if (draft.query_key.length > 0) config.query_key = draft.query_key;
    if (draft.query_value.length > 0) config.query_value = draft.query_value;
  }
  return config;
}

function draftFromDetail(detail: ProfileDetail, actionOverride?: string, endpointSlug = ''): Draft {
  const firstAction = detail.manifest.actions[0];
  const resourceName = detail.profileName?.trim() || 'new';
  const selectedAction = actionOverride?.trim() || firstAction?.name?.trim() || firstAction?.action?.trim() || '';
  const params: ParamDraft[] = Object.entries(detail.policy.parameters).map(([key, parameter]) => ({
    key,
    value: parameter.value === null || parameter.value === undefined ? '' : String(parameter.value),
    isLocked: parameter.isLocked === true,
  }));
  return {
    rows: [
      {
        profileName: resourceName,
        action: selectedAction,
        endpointSlug,
        enabled: detail.policy.enabled,
        jobPriority: detail.policy.jobPriority,
        extensionsCsv: detail.policy.allowedFileExtensions,
        params,
        connSteps: detail.policy.connectionsOverride,
        requestRedaction: detail.policy.requestRedaction ?? [],
        callback: callbackPolicyFromRead(detail.policy.callbackPolicy),
        callbackConfiguredOnServer: detail.policy.callbackPolicyInvalid === true || (detail.policy.callbackPolicy !== undefined && detail.policy.callbackPolicy !== null),
        callbackPolicyInvalid: detail.policy.callbackPolicyInvalid === true,
        callbackClearPending: false,
      },
    ],
    fileUrlAuth: {
      touched: false,
      type: 'none',
      token: '',
      header_name: '',
      header_value: '',
      query_key: '',
      query_value: '',
    },
    prompt: {
      connectionId: '',
      apiKeyId: '',
      endpointSlug: endpointSlug || selectedAction || resourceName,
      stepId: '_default',
      text: '',
      isActive: true,
    },
  };
}
