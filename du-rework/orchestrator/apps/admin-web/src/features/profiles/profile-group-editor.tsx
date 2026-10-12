import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AlertBanner, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { createAdminApiClient, type ApiKeyRow, type BusinessRow, type ConnectorManagementRevision, type ProfileGroup } from '@/lib/api';
import { parseBusinessPage, parseBusinessVersions } from '@/features/businesses/state';
import { parseConnectorList } from '@/features/connectors/state';
import {
  buildProfileGroupSaveBody,
  emptyProfileGroupFunctionDraft,
  isProfileGroupRevisionConflict,
  parseProfileGroup,
  parseProfileGroupFunctionCatalog,
  parseProfileGroupList,
  profileGroupDraftFromRead,
  profileGroupFunctionDraftKey,
  profileGroupMemberDraftKey,
  validateProfileGroupDraft,
  type ProfileGroupEditorDraft,
  type ProfileGroupFunctionDraft,
  type ProfileGroupMemberDraft,
} from './profile-group-state';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema['properties']) ? schema['properties'] : {};
}

function toApiProblemTitle(result: { status: number; problem: { title?: string; code?: string } }): string {
  return result.problem.title ?? result.problem.code ?? `The request failed (${result.status}).`;
}

function memberLabel(member: Pick<ProfileGroupMemberDraft, 'businessId' | 'businessVersion'>): string {
  return `${member.businessId}@${member.businessVersion || 'select a version'}`;
}

function activeJsonErrors(draft: ProfileGroupEditorDraft, errors: Record<string, string>): string[] {
  const activePrefixes = new Set<string>();
  for (const member of draft.members) {
    const selected = draft.selectedFunctionsByVersion[profileGroupMemberDraftKey(member.businessId, member.businessVersion)] ?? [];
    for (const functionId of selected) {
      const descriptor = member.catalog?.functions.find((item) => item.functionId === functionId);
      if (!descriptor) continue;
      for (const [parameter, rawDefinition] of Object.entries(schemaProperties(descriptor.profileSchema))) {
        const definition = isRecord(rawDefinition) ? rawDefinition : {};
        if (definition['type'] === 'object' || definition['type'] === 'array') {
          activePrefixes.add(`${profileGroupFunctionDraftKey(member.businessId, member.businessVersion, functionId)}:${parameter}`);
        }
      }
    }
  }
  return Object.entries(errors)
    .filter(([key, message]) => message.length > 0 && [...activePrefixes].some((prefix) => key === prefix))
    .map(([, message]) => message);
}

interface Props {
  tenantId: string | null;
}

export function ProfileGroupEditor({ tenantId }: Props) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [businesses, setBusinesses] = useState<BusinessRow[]>([]);
  const [businessesLoading, setBusinessesLoading] = useState(false);
  const [businessesProblem, setBusinessesProblem] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [apiKeysProblem, setApiKeysProblem] = useState<string | null>(null);
  const [groups, setGroups] = useState<ProfileGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsProblem, setGroupsProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileGroupEditorDraft | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedGroupLoading, setSelectedGroupLoading] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [conflictDetected, setConflictDetected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState('');
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const [connectors, setConnectors] = useState<ConnectorManagementRevision[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const [connectorsProblem, setConnectorsProblem] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const memberCatalogGeneration = useRef(new Map<string, number>());

  const loadBusinesses = useCallback(async (): Promise<BusinessRow[] | null> => {
    setBusinessesLoading(true);
    setBusinessesProblem(null);
    try {
      const rows: BusinessRow[] = [];
      let cursor: string | undefined;
      let total: number | null = null;
      do {
        const result = await client.listBusinesses({ limit: '100', ...(cursor ? { cursor } : {}) });
        if (!result.ok) {
          setBusinessesProblem(toApiProblemTitle(result));
          setBusinesses([]);
          return null;
        }
        const page = parseBusinessPage(result.data);
        if (!page) {
          setBusinessesProblem('Business registry response did not include readable lifecycle fields.');
          setBusinesses([]);
          return null;
        }
        rows.push(...page.items);
        total = page.total;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      setBusinesses(rows);
      if (total !== null && total > rows.length) setBusinessesProblem(`The registry reported ${total} businesses but only ${rows.length} were returned.`);
      return rows;
    } catch {
      setBusinessesProblem('The registered business catalog could not be reached.');
      setBusinesses([]);
      return null;
    } finally {
      setBusinessesLoading(false);
    }
  }, [client]);

  const loadApiKeys = useCallback(async (): Promise<void> => {
    setApiKeys([]);
    setApiKeysProblem(null);
    if (!tenantId) {
      setApiKeysLoading(false);
      return;
    }
    setApiKeysLoading(true);
    try {
      const result = await client.listApiKeys({ tenantId, limit: '100' });
      if (!result.ok) {
        setApiKeysProblem(toApiProblemTitle(result));
        return;
      }
      setApiKeys(result.data.items.filter((key) => key.status === 'ACTIVE'));
    } catch {
      setApiKeysProblem('The active API key list could not be reached.');
    } finally {
      setApiKeysLoading(false);
    }
  }, [client, tenantId]);

  const loadConnectors = useCallback(async (): Promise<void> => {
    setConnectorsLoading(true);
    setConnectorsProblem(null);
    try {
      const result = await client.listConnectors();
      const parsed = result.ok ? parseConnectorList(result.data) : null;
      if (!parsed) {
        setConnectors([]);
        setConnectorsProblem(result.ok ? 'Connector catalog response was unreadable.' : toApiProblemTitle(result));
        return;
      }
      setConnectors(parsed.items.filter((connector) => connector.state === 'ACTIVE'));
    } catch {
      setConnectors([]);
      setConnectorsProblem('The connector catalog could not be reached.');
    } finally {
      setConnectorsLoading(false);
    }
  }, [client]);

  const loadGroups = useCallback(async (): Promise<ProfileGroup[] | null> => {
    if (!tenantId) {
      setGroups([]);
      setGroupsProblem(null);
      setGroupsLoading(false);
      return [];
    }
    setGroupsLoading(true);
    setGroupsProblem(null);
    try {
      const result = await client.listProfileGroups(tenantId);
      if (!result.ok) {
        setGroupsProblem(toApiProblemTitle(result));
        return null;
      }
      const parsed = parseProfileGroupList(result.data);
      if (!parsed) {
        setGroupsProblem('Profile group response did not match the API contract.');
        return null;
      }
      setGroups(parsed.groups);
      return parsed.groups;
    } catch {
      setGroupsProblem('Profile groups could not be reached.');
      return null;
    } finally {
      setGroupsLoading(false);
    }
  }, [client, tenantId]);

  useEffect(() => {
    loadGeneration.current += 1;
    setDraft(null);
    setSelectedGroupId('');
    setConflictDetected(false);
    setNotice(null);
    setProblem(null);
    if (!tenantId) {
      setGroups([]);
      setBusinesses([]);
      setApiKeys([]);
      return;
    }
    void loadBusinesses();
    void loadApiKeys();
    void loadGroups();
    void loadConnectors();
  }, [loadApiKeys, loadBusinesses, loadConnectors, loadGroups, tenantId]);

  function updateDraft(update: (current: ProfileGroupEditorDraft) => ProfileGroupEditorDraft): void {
    setDraft((current) => current ? update(current) : current);
  }

  function updateMember(businessId: string, update: (current: ProfileGroupMemberDraft) => ProfileGroupMemberDraft): void {
    updateDraft((current) => ({
      ...current,
      members: current.members.map((member) => member.businessId === businessId ? update(member) : member),
    }));
  }

  async function loadMemberVersion(businessId: string, requestedVersion?: string): Promise<void> {
    const generation = loadGeneration.current;
    updateMember(businessId, (member) => ({ ...member, catalogLoading: true, catalogProblem: null, catalog: null }));
    const versionsResult = await client.getBusinessVersions(businessId);
    if (generation !== loadGeneration.current) return;
    if (!versionsResult.ok) {
      updateMember(businessId, (member) => ({ ...member, catalogLoading: false, catalogProblem: toApiProblemTitle(versionsResult) }));
      return;
    }
    const parsedVersions = parseBusinessVersions(versionsResult.data);
    if (!parsedVersions) {
      updateMember(businessId, (member) => ({ ...member, catalogLoading: false, catalogProblem: 'Registered versions response is unreadable.' }));
      return;
    }
    const versionRows = parsedVersions.rows.map((row) => row.version);
    const version = requestedVersion && versionRows.includes(requestedVersion)
      ? requestedVersion
      : parsedVersions.activeVersion && versionRows.includes(parsedVersions.activeVersion)
        ? parsedVersions.activeVersion
        : versionRows[0] ?? '';
    updateMember(businessId, (member) => ({
      ...member,
      businessVersion: version,
      versions: versionRows,
      enabled: parsedVersions.enabled,
      lifecycleRevision: parsedVersions.lifecycleRevision,
      catalogLoading: version.length > 0,
      catalogProblem: version ? null : 'No registered version is available for this business.',
    }));
    if (!version) return;
    await loadFunctionCatalog(businessId, version, generation);
  }

  async function loadFunctionCatalog(businessId: string, businessVersion: string, generation = loadGeneration.current): Promise<void> {
    const catalogGeneration = (memberCatalogGeneration.current.get(businessId) ?? 0) + 1;
    memberCatalogGeneration.current.set(businessId, catalogGeneration);
    updateMember(businessId, (member) => ({ ...member, businessVersion, catalogLoading: true, catalogProblem: null, catalog: null }));
    const result = await client.getBusinessFunctionCatalog(businessId, businessVersion);
    if (generation !== loadGeneration.current || memberCatalogGeneration.current.get(businessId) !== catalogGeneration) return;
    if (!result.ok) {
      updateMember(businessId, (member) => ({ ...member, catalogLoading: false, catalogProblem: toApiProblemTitle(result) }));
      return;
    }
    const catalog = parseProfileGroupFunctionCatalog(result.data);
    if (!catalog || catalog.businessId !== businessId || catalog.businessVersion !== businessVersion) {
      updateMember(businessId, (member) => ({ ...member, catalogLoading: false, catalogProblem: 'Function catalog does not match the selected business version.' }));
      return;
    }
    updateMember(businessId, (member) => ({
      ...member,
      catalog,
      catalogLoading: false,
      catalogProblem: null,
      enabled: catalog.businessEnabled,
    }));
    updateDraft((current) => {
      const selectedKey = profileGroupMemberDraftKey(businessId, businessVersion);
      const selected = current.selectedFunctionsByVersion[selectedKey] ?? [];
      const existing = new Set(selected);
      const initialized = { ...current.functionDrafts };
      for (const descriptor of catalog.functions) {
        const key = profileGroupFunctionDraftKey(businessId, businessVersion, descriptor.functionId);
        if (!initialized[key]) initialized[key] = emptyProfileGroupFunctionDraft();
      }
      return {
        ...current,
        selectedFunctionsByVersion: { ...current.selectedFunctionsByVersion, [selectedKey]: [...existing] },
        functionDrafts: initialized,
      };
    });
  }

  async function createNewGroup(): Promise<void> {
    if (!tenantId) return;
    loadGeneration.current += 1;
    setSelectedGroupLoading(false);
    setSelectedGroupId('');
    setConflictDetected(false);
    setNotice(null);
    setProblem(null);
    setJsonDrafts({});
    setJsonErrors({});
    const firstKey = apiKeys[0]?.id ?? '';
    setDraft({
      groupId: null,
      tenantId,
      name: '',
      apiKeyId: firstKey,
      revision: 0,
      members: [],
      selectedFunctionsByVersion: {},
      functionDrafts: {},
    });
  }

  async function openGroup(groupId: string): Promise<void> {
    const generation = ++loadGeneration.current;
    setSelectedGroupId(groupId);
    setSelectedGroupLoading(true);
    setConflictDetected(false);
    setNotice(null);
    setProblem(null);
    setDraft(null);
    setJsonDrafts({});
    setJsonErrors({});
    try {
      const result = await client.getProfileGroup(groupId);
      if (generation !== loadGeneration.current) return;
      if (!result.ok) {
        setProblem(toApiProblemTitle(result));
        return;
      }
      const group = parseProfileGroup(result.data);
      if (!group || group.tenantId !== tenantId) {
        setProblem('Profile group response did not match this tenant.');
        return;
      }
      setDraft(profileGroupDraftFromRead(group));
      setRollbackTarget('');
      for (const member of group.businesses) void loadMemberVersion(member.businessId, member.businessVersion);
    } catch {
      if (generation === loadGeneration.current) setProblem('Profile group could not be loaded.');
    } finally {
      if (generation === loadGeneration.current) setSelectedGroupLoading(false);
    }
  }

  async function addBusiness(businessId: string): Promise<void> {
    if (!draft || draft.members.some((member) => member.businessId === businessId)) return;
    const registered = businesses.find((business) => business.businessId === businessId);
    if (registered?.enabled !== true) return;
    updateDraft((current) => ({
      ...current,
      members: [...current.members, {
        businessId,
        businessVersion: '',
        versions: [],
        enabled: registered.enabled,
        lifecycleRevision: registered.lifecycleRevision,
        catalog: null,
        catalogLoading: true,
        catalogProblem: null,
      }],
    }));
    await loadMemberVersion(businessId);
  }

  function removeBusiness(businessId: string): void {
    memberCatalogGeneration.current.set(businessId, (memberCatalogGeneration.current.get(businessId) ?? 0) + 1);
    updateDraft((current) => ({ ...current, members: current.members.filter((member) => member.businessId !== businessId) }));
  }

  function toggleFunction(member: ProfileGroupMemberDraft, functionId: string, checked: boolean): void {
    const key = profileGroupMemberDraftKey(member.businessId, member.businessVersion);
    updateDraft((current) => {
      const selected = current.selectedFunctionsByVersion[key] ?? [];
      return {
        ...current,
        selectedFunctionsByVersion: {
          ...current.selectedFunctionsByVersion,
          [key]: checked ? [...new Set([...selected, functionId])] : selected.filter((item) => item !== functionId),
        },
      };
    });
  }

  function updateFunctionDraft(member: ProfileGroupMemberDraft, functionId: string, update: (current: ProfileGroupFunctionDraft) => ProfileGroupFunctionDraft): void {
    const key = profileGroupFunctionDraftKey(member.businessId, member.businessVersion, functionId);
    updateDraft((current) => ({
      ...current,
      functionDrafts: { ...current.functionDrafts, [key]: update(current.functionDrafts[key] ?? emptyProfileGroupFunctionDraft()) },
    }));
  }

  function updateParameter(member: ProfileGroupMemberDraft, functionId: string, parameter: string, value: unknown): void {
    updateFunctionDraft(member, functionId, (current) => ({
      ...current,
      parameters: { ...current.parameters, [parameter]: { value, isLocked: current.parameters[parameter]?.isLocked ?? false } },
    }));
  }

  function updateConnectorBinding(member: ProfileGroupMemberDraft, functionId: string, slotName: string, value: string): void {
    const connector = connectors.find((item) => `${item.connectorId}@${item.revision}` === value);
    updateFunctionDraft(member, functionId, (current) => {
      const connectorBindings = { ...current.connectorBindings };
      if (connector) {
        connectorBindings[slotName] = { connectorId: connector.connectorId, revision: connector.revision };
      } else {
        delete connectorBindings[slotName];
      }
      return { ...current, connectorBindings };
    });
  }

  async function reloadGroupListAndConflict(): Promise<void> {
    await Promise.all([loadGroups(), loadBusinesses()]);
    if (selectedGroupId) {
      setConflictDetected(true);
      setNotice('The server rejected this revision. Your draft is still here; reload the server version before editing or saving again.');
    }
  }

  async function validateCurrentBusinessState(currentDraft: ProfileGroupEditorDraft): Promise<boolean> {
    const registry = await loadBusinesses();
    if (!registry) return false;
    const disabled = currentDraft.members.filter((member) => registry.find((row) => row.businessId === member.businessId)?.enabled !== true);
    if (disabled.length > 0) {
      updateDraft((current) => ({
        ...current,
        members: current.members.map((member) => disabled.some((entry) => entry.businessId === member.businessId)
          ? { ...member, enabled: false, catalog: member.catalog ? { ...member.catalog, businessEnabled: false } : null }
          : member),
      }));
      setProblem(`Business ${disabled.map((member) => member.businessId).join(', ')} was disabled while this editor was open. Refresh and remove it before saving.`);
      return false;
    }
    for (const member of currentDraft.members) {
      const result = await client.getBusinessFunctionCatalog(member.businessId, member.businessVersion);
      if (!result.ok) {
        setProblem(toApiProblemTitle(result));
        return false;
      }
      const fresh = parseProfileGroupFunctionCatalog(result.data);
      if (!fresh || fresh.businessId !== member.businessId || fresh.businessVersion !== member.businessVersion) {
        setProblem(`Function catalog is unreadable for ${memberLabel(member)}.`);
        return false;
      }
      if (!fresh.businessEnabled) {
        updateMember(member.businessId, (current) => ({ ...current, enabled: false, catalog: fresh }));
        setProblem(`Business ${member.businessId} was disabled while this editor was open. Remove it before saving.`);
        return false;
      }
      if (member.catalog?.manifestDigest !== fresh.manifestDigest) {
        updateMember(member.businessId, (current) => ({ ...current, catalog: fresh, enabled: true }));
        setProblem(`Manifest changed for ${memberLabel(member)}. Review its available functions and configuration, then save again.`);
        return false;
      }
    }
    return true;
  }

  async function saveGroup(): Promise<void> {
    if (!draft || mutationBusy || conflictDetected) return;
    setNotice(null);
    setProblem(null);
    const errors = validateProfileGroupDraft(draft);
    const invalidJson = activeJsonErrors(draft, jsonErrors).length > 0;
    if (errors.length > 0 || invalidJson) {
      setProblem(errors[0] ?? 'Fix the invalid profile schema JSON before saving.');
      return;
    }
    setMutationBusy(true);
    try {
      if (!(await validateCurrentBusinessState(draft))) return;
      const body = buildProfileGroupSaveBody(draft, tenantId ?? draft.tenantId, draft.revision);
      const result = draft.groupId
        ? await client.replaceProfileGroup(draft.groupId, body)
        : await client.createProfileGroup(body);
      if (!result.ok) {
        setProblem(toApiProblemTitle(result));
        if (isProfileGroupRevisionConflict(result.status, result.problem.code)) await reloadGroupListAndConflict();
        return;
      }
      const saved = parseProfileGroup(result.data);
      if (!saved) {
        setProblem('The save returned an unreadable group. Refresh before editing it again.');
        return;
      }
      setSelectedGroupId(saved.groupId);
      await loadGroups();
      await openGroup(saved.groupId);
      setNotice(`Saved ${saved.name} as revision ${saved.revision}; the complete group has been reloaded.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The profile group could not be saved.');
    } finally {
      setMutationBusy(false);
    }
  }

  async function rollbackGroup(): Promise<void> {
    if (!draft?.groupId || mutationBusy || conflictDetected) return;
    const targetRevision = Number(rollbackTarget);
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1 || targetRevision >= draft.revision) {
      setProblem('Enter an earlier group revision number.');
      return;
    }
    setMutationBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await client.rollbackProfileGroup(draft.groupId, { expectedRevision: draft.revision, targetRevision });
      if (!result.ok) {
        setProblem(toApiProblemTitle(result));
        if (isProfileGroupRevisionConflict(result.status, result.problem.code)) await reloadGroupListAndConflict();
        return;
      }
      const group = parseProfileGroup(result.data);
      if (!group) {
        setProblem('Rollback returned an unreadable group. Refresh before editing it again.');
        return;
      }
      await loadGroups();
      await openGroup(group.groupId);
      setNotice(`Rolled back all business/function bindings to revision ${targetRevision}; current revision is ${group.revision}.`);
    } catch {
      setProblem('The group rollback could not be confirmed. Reload the group before retrying.');
    } finally {
      setMutationBusy(false);
    }
  }

  const validationErrors = draft ? validateProfileGroupDraft(draft) : [];
  const currentJsonErrors = draft ? activeJsonErrors(draft, jsonErrors) : [];
  const enabledBusinesses = businesses.filter((business) => business.enabled === true);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Profile groups</CardTitle>
            <CardDescription>Create one named profile entry with an atomic set of business, version, and function bindings. Connector revisions are selected from the separate Connectors screen.</CardDescription>
          </div>
          <Button type="button" variant="primary" disabled={!tenantId || groupsLoading || apiKeysLoading || selectedGroupLoading || mutationBusy} onClick={() => void createNewGroup()}>New profile group</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!tenantId ? <AlertBanner variant="warning" title="Choose a tenant first">Profile groups require a tenant scope.</AlertBanner> : null}
        {problem ? <AlertBanner variant="error" title="Profile group action failed">{problem}</AlertBanner> : null}
        {notice ? <AlertBanner variant="success" title="Profile groups">{notice}</AlertBanner> : null}
        <div className="grid gap-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]">
          <section aria-labelledby="profile-group-list-title" className="rounded border border-[var(--border-subtle)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="profile-group-list-title" className="text-sm font-semibold">Saved groups</h3>
              <Button type="button" size="sm" variant="outline" disabled={groupsLoading || !tenantId} onClick={() => void loadGroups()}>Refresh</Button>
            </div>
            {groupsLoading ? <LoadingState title="Loading profile groups" /> : null}
            {groupsProblem ? <ErrorState title={groupsProblem} onRetry={() => void loadGroups()} /> : null}
            {!groupsLoading && !groupsProblem && groups.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No profile groups are saved for this tenant.</p> : null}
            <div className="flex flex-col gap-2">
              {groups.map((group) => (
                <button key={group.groupId} type="button" aria-pressed={selectedGroupId === group.groupId} onClick={() => void openGroup(group.groupId)} disabled={selectedGroupLoading || mutationBusy}
                  className={`rounded border p-3 text-left ${selectedGroupId === group.groupId ? 'border-[var(--cf-blue)] bg-[var(--bg-subtle)]' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)]'}`}>
                  <span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{group.name}</span><Badge variant="neutral">rev {group.revision}</Badge></span>
                  <span className="mt-1 block text-xs text-[var(--text-sub)]">{group.businesses.length} business version{group.businesses.length === 1 ? '' : 's'} · {group.businesses.reduce((total, item) => total + item.functions.length, 0)} functions</span>
                </button>
              ))}
            </div>
            {businessesProblem ? <p role="status" className="mt-2 text-xs text-[var(--badge-warning-text)]">Business catalog: {businessesProblem}</p> : null}
          </section>

          {selectedGroupLoading ? <LoadingState title="Loading the complete profile group" description="Every business/version/function binding is being reloaded." /> : null}
          {draft ? (
            <section aria-label="Profile group editor" className="min-w-0 space-y-4 rounded border border-[var(--border-subtle)] p-3">
              {conflictDetected ? <AlertBanner variant="warning" title="Profile group revision conflict">Your draft is preserved. Load the current server revision to continue.</AlertBanner> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Profile group name"><Input maxLength={120} value={draft.name} onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))} disabled={mutationBusy || conflictDetected} /></FormField>
                <FormField label="Existing active API key" description="The existing key membership is reused. No group credential is created.">
                  <select aria-label="Existing active API key" className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" value={draft.apiKeyId} onChange={(event) => updateDraft((current) => ({ ...current, apiKeyId: event.target.value }))} disabled={mutationBusy || conflictDetected || apiKeysLoading}>
                    <option value="">Select an active API key</option>
                    {apiKeys.map((key) => <option key={key.id} value={key.id}>{key.name || 'Unnamed key'} · {key.prefix}</option>)}
                    {draft.apiKeyId && !apiKeys.some((key) => key.id === draft.apiKeyId) ? <option value={draft.apiKeyId}>Current group key · unavailable or inactive</option> : null}
                  </select>
                  {apiKeysProblem ? <span role="alert" className="text-xs text-[var(--badge-danger-text)]">{apiKeysProblem}</span> : null}
                  {!apiKeysLoading && apiKeys.length === 0 && !apiKeysProblem ? <span role="alert" className="text-xs text-[var(--badge-warning-text)]">This tenant has no active API key to bind. Reuse or create one in the existing API key management flow first.</span> : null}
                  {draft.apiKeyId && !apiKeys.some((key) => key.id === draft.apiKeyId) ? <span role="alert" className="text-xs text-[var(--badge-warning-text)]">The selected group key is no longer active. Select an active tenant key to save a replacement revision.</span> : null}
                </FormField>
              </div>
              <section aria-labelledby="profile-group-businesses-title" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><h3 id="profile-group-businesses-title" className="text-sm font-semibold">Registered enabled businesses</h3><p className="text-xs text-[var(--text-sub)]">Each business keeps an independent version and function selection.</p></div>
                  <Button type="button" size="sm" variant="outline" disabled={businessesLoading || mutationBusy || conflictDetected} onClick={() => void loadBusinesses()}>{businessesLoading ? 'Refreshing…' : 'Refresh businesses'}</Button>
                </div>
                {businessesLoading ? <LoadingState title="Loading registered businesses" /> : null}
                {businessesProblem ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{businessesProblem}</p> : null}
                {!businessesLoading && !businessesProblem && enabledBusinesses.length === 0 ? <p className="rounded border border-dashed p-3 text-sm text-[var(--text-sub)]">No enabled registered businesses are available to bind.</p> : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  {enabledBusinesses.map((business) => {
                    const checked = draft.members.some((member) => member.businessId === business.businessId);
                    return <label key={business.businessId} className="flex min-w-0 items-center gap-2 rounded border border-[var(--border-subtle)] p-2 text-sm">
                      <input type="checkbox" checked={checked} disabled={mutationBusy || conflictDetected || businessesLoading} onChange={(event) => event.target.checked ? void addBusiness(business.businessId) : removeBusiness(business.businessId)} />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{business.businessId}</span>
                      <Badge variant="success" dot>Enabled</Badge>
                    </label>;
                  })}
                </div>
              </section>

              {draft.members.map((member) => {
                const memberKey = profileGroupMemberDraftKey(member.businessId, member.businessVersion);
                const selectedFunctions = draft.selectedFunctionsByVersion[memberKey] ?? [];
                return <section key={member.businessId} aria-label={`${member.businessId} profile group settings`} className="space-y-3 rounded border border-[var(--border-subtle)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono text-sm font-semibold">{member.businessId}</h3>
                    <Badge variant={member.enabled === true ? 'success' : member.enabled === false ? 'danger' : 'warning'} dot>{member.enabled === true ? 'Enabled' : member.enabled === false ? 'Disabled' : 'Unknown'}</Badge>
                    <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={mutationBusy || conflictDetected} onClick={() => removeBusiness(member.businessId)}>Remove business</Button>
                  </div>
                  {member.enabled === false ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">This business was disabled while the editor was open. Remove it or enable it in the Business registry, then refresh.</p> : null}
                  <FormField label="Registered version" description="The function catalog is loaded from this exact business version and manifest digest.">
                    <select aria-label={`Version for ${member.businessId}`} className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" value={member.businessVersion} disabled={member.catalogLoading || mutationBusy || conflictDetected || member.versions.length === 0} onChange={(event) => void loadFunctionCatalog(member.businessId, event.target.value)}>
                      {member.versions.length === 0 ? <option value="">No registered versions</option> : null}
                      {member.versions.map((version) => <option key={version} value={version}>{version}</option>)}
                    </select>
                  </FormField>
                  {member.catalogLoading ? <LoadingState title={`Loading ${member.businessId} function catalog`} /> : null}
                  {member.catalogProblem ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{member.catalogProblem}</p> : null}
                  {member.catalog ? (
                    <>
                      <p className="text-xs text-[var(--text-sub)]">Manifest digest <code>{member.catalog.manifestDigest}</code> · {member.catalog.functions.length} declared functions.</p>
                      {member.catalog.functions.length === 0 ? <p className="text-sm text-[var(--text-sub)]">This registered version declares no selectable profile functions.</p> : null}
                      {selectedFunctions.filter((functionId) => !member.catalog?.functions.some((descriptor) => descriptor.functionId === functionId)).map((functionId) => (
                        <div key={functionId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-subtle)] p-3 text-sm">
                          <span><Badge variant="warning">No longer declared</Badge> <code>{functionId}</code></span>
                          <Button type="button" size="sm" variant="outline" disabled={mutationBusy || conflictDetected} onClick={() => toggleFunction(member, functionId, false)}>Remove unavailable binding</Button>
                        </div>
                      ))}
                      <div className="space-y-2">
                        {member.catalog.functions.map((descriptor) => {
                          const checked = selectedFunctions.includes(descriptor.functionId);
                          const available = descriptor.available !== false && member.catalog?.businessEnabled === true;
                          const key = profileGroupFunctionDraftKey(member.businessId, member.businessVersion, descriptor.functionId);
                          const config = draft.functionDrafts[key] ?? emptyProfileGroupFunctionDraft();
                          return <article key={descriptor.functionId} className="rounded border border-[var(--border-subtle)] p-3">
                            <label className="flex items-start gap-2">
                              <input type="checkbox" checked={checked} disabled={(!available && !checked) || mutationBusy || conflictDetected} onChange={(event) => toggleFunction(member, descriptor.functionId, event.target.checked)} />
                              <span className="min-w-0 flex-1"><span className="font-medium">{descriptor.kind === 'endpoint' ? 'Document Core endpoint' : 'Declared workflow action'} · <code>{descriptor.endpointSlug ?? descriptor.action}</code></span><span className="mt-1 block text-xs text-[var(--text-sub)]">Function id: {descriptor.functionId}</span></span>
                              {available ? <Badge variant="success">Available</Badge> : <Badge variant="warning">Unavailable</Badge>}
                            </label>
                            {descriptor.available === false ? <p className="mt-2 text-xs text-[var(--badge-warning-text)]">{descriptor.unavailableReason ?? 'This declared function is not supported by the selected runtime.'}</p> : null}
                            {checked && available ? (
                              <div className="mt-3 space-y-4 border-t border-[var(--border-subtle)] pt-3">
                                <div className="grid gap-3 sm:grid-cols-3">
                                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.enabled} disabled={mutationBusy || conflictDetected} onChange={(event) => updateFunctionDraft(member, descriptor.functionId, (current) => ({ ...current, enabled: event.target.checked }))} />Enabled</label>
                                  <FormField label="Job priority"><select aria-label={`Job priority for ${descriptor.functionId}`} className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" value={config.jobPriority} disabled={mutationBusy || conflictDetected} onChange={(event) => updateFunctionDraft(member, descriptor.functionId, (current) => ({ ...current, jobPriority: event.target.value as ProfileGroupFunctionDraft['jobPriority'] }))}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></FormField>
                                  <FormField label="Allowed file extensions"><Input value={config.allowedFileExtensions} placeholder="pdf,docx" disabled={mutationBusy || conflictDetected} onChange={(event) => updateFunctionDraft(member, descriptor.functionId, (current) => ({ ...current, allowedFileExtensions: event.target.value }))} /></FormField>
                                </div>
                                <section aria-label={`Profile schema settings for ${descriptor.functionId}`} className="space-y-2">
                                  <h4 className="text-sm font-medium">Manifest profile settings</h4>
                                  {Object.entries(schemaProperties(descriptor.profileSchema)).length === 0 ? <p className="text-xs text-[var(--text-sub)]">This function declares no profile-specific settings.</p> : null}
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    {Object.entries(schemaProperties(descriptor.profileSchema)).map(([parameter, rawDefinition]) => {
                                      const definition = isRecord(rawDefinition) ? rawDefinition : {};
                                      const required = Array.isArray(descriptor.profileSchema['required']) && descriptor.profileSchema['required'].includes(parameter);
                                      const currentValue = config.parameters[parameter]?.value ?? definition['default'] ?? '';
                                      const jsonKey = `${key}:${parameter}`;
                                      const type = Array.isArray(definition['enum']) ? 'enum' : definition['type'];
                                      const enumValues = Array.isArray(definition['enum']) ? definition['enum'] : null;
                                      const title = typeof definition['title'] === 'string' ? definition['title'] : parameter;
                                      if (type === 'object' || type === 'array') {
                                        const textValue = jsonDrafts[jsonKey] ?? JSON.stringify(currentValue ?? (type === 'array' ? [] : {}), null, 2);
                                        return <FormField key={parameter} label={`${title}${required ? ' *' : ''}`} description={typeof definition['description'] === 'string' ? definition['description'] : undefined} error={jsonErrors[jsonKey]}>
                                          <textarea aria-label={`${title} for ${descriptor.functionId}`} className="min-h-24 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] p-2 font-mono text-xs" value={textValue} disabled={mutationBusy || conflictDetected} onChange={(event) => {
                                            const value = event.target.value;
                                            setJsonDrafts((current) => ({ ...current, [jsonKey]: value }));
                                            try {
                                              updateParameter(member, descriptor.functionId, parameter, JSON.parse(value) as unknown);
                                              setJsonErrors((current) => { const next = { ...current }; delete next[jsonKey]; return next; });
                                            } catch {
                                              setJsonErrors((current) => ({ ...current, [jsonKey]: 'Enter valid JSON.' }));
                                            }
                                          }} />
                                        </FormField>;
                                      }
                                      if (type === 'boolean') return <label key={parameter} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={currentValue === true} disabled={mutationBusy || conflictDetected} onChange={(event) => updateParameter(member, descriptor.functionId, parameter, event.target.checked)} />{title}{required ? ' *' : ''}</label>;
                                      if (type === 'enum' && enumValues) return <FormField key={parameter} label={`${title}${required ? ' *' : ''}`}><select aria-label={`${title} for ${descriptor.functionId}`} className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" value={String(currentValue)} disabled={mutationBusy || conflictDetected} onChange={(event) => updateParameter(member, descriptor.functionId, parameter, enumValues.find((item) => String(item) === event.target.value) ?? event.target.value)}><option value="">Select…</option>{enumValues.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number').map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</select></FormField>;
                                      return <FormField key={parameter} label={`${title}${required ? ' *' : ''}`} description={typeof definition['description'] === 'string' ? definition['description'] : undefined}><Input aria-label={`${title} for ${descriptor.functionId}`} type={type === 'number' || type === 'integer' ? 'number' : 'text'} step={type === 'integer' ? '1' : type === 'number' ? 'any' : undefined} value={String(currentValue)} disabled={mutationBusy || conflictDetected} onChange={(event) => updateParameter(member, descriptor.functionId, parameter, type === 'number' || type === 'integer' ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value)} /></FormField>;
                                    })}
                                  </div>
                                </section>
                                <section className="space-y-2">
                                  <h4 className="text-sm font-medium">Connector bindings</h4>
                                  <p className="text-xs text-[var(--text-sub)]">Connector credentials and provider settings remain managed on the separate <Link className="underline" to="/connectors">Connectors screen</Link>.</p>
                                  {connectorsLoading ? <LoadingState title="Loading configured connector revisions" /> : null}
                                  {connectorsProblem ? <p role="alert" className="text-xs text-[var(--badge-warning-text)]">{connectorsProblem}</p> : null}
                                  {descriptor.connectorSlots.length === 0 ? <p className="text-xs text-[var(--text-sub)]">This function declares no connector slots.</p> : null}
                                  {descriptor.connectorSlots.map((slot) => {
                                    const pin = config.connectorBindings[slot.name];
                                    return <FormField key={slot.name} label={`${slot.name}${slot.required ? ' *' : ''}`} description={slot.acceptedCapabilities.length > 0 ? `Accepted capabilities: ${slot.acceptedCapabilities.join(', ')}` : 'No connector capability restriction declared.'}>
                                      <select aria-label={`Connector for ${slot.name} in ${descriptor.functionId}`} className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm" value={pin ? `${pin.connectorId}@${pin.revision}` : ''} disabled={connectorsLoading || mutationBusy || conflictDetected} onChange={(event) => updateConnectorBinding(member, descriptor.functionId, slot.name, event.target.value)}>
                                        <option value="">{slot.required ? 'Select a connector revision' : 'No connector bound'}</option>
                                        {connectors.map((connector) => <option key={`${connector.connectorId}@${connector.revision}`} value={`${connector.connectorId}@${connector.revision}`}>{connector.connectorId} · revision {connector.revision}</option>)}
                                      </select>
                                    </FormField>;
                                  })}
                                </section>
                              </div>
                            ) : null}
                          </article>;
                        })}
                      </div>
                    </>
                  ) : null}
                </section>;
              })}

              {validationErrors.length > 0 ? <div role="status" className="rounded border border-[var(--border-subtle)] p-3 text-xs text-[var(--text-sub)]"><strong>Before save:</strong><ul className="mt-1 list-disc pl-5">{validationErrors.slice(0, 5).map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
              {conflictDetected ? <Button type="button" variant="outline" disabled={selectedGroupLoading || mutationBusy} onClick={() => void openGroup(selectedGroupId)}>Reload server version</Button> : null}
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
                <Button type="button" variant="primary" disabled={mutationBusy || conflictDetected || validationErrors.length > 0 || currentJsonErrors.length > 0 || apiKeysLoading || !apiKeys.some((key) => key.id === draft.apiKeyId)} onClick={() => void saveGroup()}>{mutationBusy ? 'Saving complete group…' : draft.groupId ? 'Save full group revision' : 'Create profile group'}</Button>
                {draft.groupId ? (
                  <>
                    <FormField label="Rollback to revision"><Input aria-label="Rollback to revision" type="number" min="1" max={Math.max(1, draft.revision - 1)} value={rollbackTarget} disabled={mutationBusy || conflictDetected || draft.revision < 2} onChange={(event) => setRollbackTarget(event.target.value)} /></FormField>
                    <Button type="button" variant="outline" disabled={mutationBusy || conflictDetected || draft.revision < 2 || !rollbackTarget} onClick={() => void rollbackGroup()}>Rollback complete group</Button>
                  </>
                ) : null}
              </div>
            </section>
          ) : selectedGroupLoading ? null : (
            <div className="rounded border border-dashed p-6 text-sm text-[var(--text-sub)]">Choose a saved group or create a new one. Existing single-business profiles remain below.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
