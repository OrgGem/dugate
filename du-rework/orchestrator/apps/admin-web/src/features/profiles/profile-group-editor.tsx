/**
 * PC-08 — Profile Group editor (V2 control plane).
 *
 * Three panes, because the resource has two independent server-owned counters:
 *   Configuration — zero-key CRUD over business/version/function bindings;
 *   Root access   — issue/revoke root grants against the current access version;
 *   Revisions     — roll back the configuration pointer only.
 *
 * The editor never selects a key to create or save a group, and it never
 * writes a server-owned field. A still-`CHILD_PROJECTION` group is inspected
 * read-only: the service refuses every V2 write until the group is converted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ADMIN_AUTH_EXPIRED_EVENT, createAdminApiClient, type ApiKeyRow, type BusinessRow, type ProfileGroupV2 } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AlertBanner, EmptyState, ErrorState, LoadingState } from '@/components/ui/state-panel';
import { TabsList, TabsPanel, TabsRoot, TabsTab } from '@/components/ui/tabs';
import { parseBusinessPage, parseBusinessVersions } from '@/features/businesses/state';
import type { ProfileGroupFunction } from '@du/contracts';
import { loadConnectorPinOptions, type ConnectorPinOption } from './connector-pin-options';
import {
  buildProfileGroupSaveBody,
  emptyProfileGroupFunctionDraft,
  misplacedParameterEntries,
  parseProfileGroupFunctionCatalog,
  parseProfileGroupList,
  parseProfileGroup,
  partitionParameterSchemas,
  profileGroupDraftFromRead,
  profileGroupFunctionDraftKey,
  profileGroupMemberDraftKey,
  profileGroupWritesAllowed,
  requestDefaultsCapabilityNotice,
  requestDefaultsEmptyMessage,
  resolveEffectiveWorkflowRevision,
  resolveProfileGroupV2Error,
  schemaDeclaredLock,
  secretLikeParameterKey,
  setParameterValue,
  validateProfileGroupDraft,
  type ProfileGroupEditorDraft,
  type ProfileGroupFunctionDraft,
  type ProfileGroupMemberDraft,
} from './profile-group-state';
import { ProfileGroupAccessPane } from './profile-group-access-pane';
import { ProfileGroupSchemaFields } from './profile-group-schema-fields';

interface Props {
  tenantId: string | null;
}

type EditorTab = 'configuration' | 'access' | 'revisions';

function functionLabel(descriptor: ProfileGroupFunction): string {
  return descriptor.kind === 'endpoint' ? descriptor.endpointSlug ?? descriptor.functionId : descriptor.action;
}

/**
 * The business registry is authoritative for lifecycle state and version list;
 * a group read carries neither. Enrichment is identity-stable (returns the same
 * object when nothing changed) so it can safely run from an effect.
 */
function enrichDraftWithRegistry(draft: ProfileGroupEditorDraft, businesses: BusinessRow[]): ProfileGroupEditorDraft {
  if (businesses.length === 0) return draft;
  let changed = false;
  const members = draft.members.map((member) => {
    const row = businesses.find((business) => business.businessId === member.businessId);
    if (!row) return member;
    const versions = member.versions.length > 0
      ? member.versions
      : (row.activeVersion ? [row.activeVersion] : member.businessVersion ? [member.businessVersion] : []);
    if (member.enabled === row.enabled && member.lifecycleRevision === row.lifecycleRevision
      && versions.length === member.versions.length) return member;
    changed = true;
    return { ...member, enabled: row.enabled, lifecycleRevision: row.lifecycleRevision, versions };
  });
  return changed ? { ...draft, members } : draft;
}

export function ProfileGroupEditor({ tenantId }: Props) {
  const client = useMemo(() => createAdminApiClient(), []);
  const [businesses, setBusinesses] = useState<BusinessRow[]>([]);
  const [businessesLoading, setBusinessesLoading] = useState(false);
  const [businessesProblem, setBusinessesProblem] = useState<string | null>(null);
  const [groups, setGroups] = useState<ProfileGroupV2[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsProblem, setGroupsProblem] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<ProfileGroupV2 | null>(null);
  const [draft, setDraft] = useState<ProfileGroupEditorDraft | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [connectors, setConnectors] = useState<ConnectorPinOption[]>([]);
  const [connectorsProblem, setConnectorsProblem] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('configuration');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState('');
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);
  const [memberFilters, setMemberFilters] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const tenantRef = useRef(tenantId);
  tenantRef.current = tenantId;

  useEffect(() => {
    const onExpired = (): void => setProblem('The admin session expired. Sign in again to continue.');
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  /**
   * The business registry is authoritative for lifecycle state. A group read
   * has no lifecycle fields, so members opened from a read are enriched here
   * (enabled/lifecycleRevision) once the registry lands — validation then tells
   * the truth about a disabled business instead of guessing.
   */
  useEffect(() => {
    if (businesses.length === 0) return;
    setDraft((current) => (current === null ? current : enrichDraftWithRegistry(current, businesses)));
  }, [businesses]);

  const loadBusinesses = useCallback(async (): Promise<void> => {
    if (!tenantId) {
      setBusinesses([]);
      return;
    }
    setBusinessesLoading(true);
    setBusinessesProblem(null);
    try {
      const rows: BusinessRow[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await client.listBusinesses({ limit: '100', ...(cursor ? { cursor } : {}) });
        if (!result.ok) {
          setBusinessesProblem(result.problem.title ?? 'The business registry could not be read.');
          setBusinesses([]);
          return;
        }
        const page = parseBusinessPage(result.data);
        if (!page) {
          setBusinessesProblem('The business registry response was not readable.');
          setBusinesses([]);
          return;
        }
        rows.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) break;
        if (cursor) seen.add(cursor);
      } while (cursor);
      setBusinesses(rows);
    } catch {
      setBusinessesProblem('The business registry could not be reached.');
      setBusinesses([]);
    } finally {
      setBusinessesLoading(false);
    }
  }, [client, tenantId]);

  const loadGroups = useCallback(async (): Promise<ProfileGroupV2[] | null> => {
    if (!tenantId) {
      setGroups([]);
      return [];
    }
    setGroupsLoading(true);
    setGroupsProblem(null);
    try {
      const result = await client.listProfileGroupsV2(tenantId);
      if (!result.ok) {
        setGroupsProblem(resolveProfileGroupV2Error(result.problem).title);
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

  const loadMemberCatalog = useCallback(async (member: ProfileGroupMemberDraft): Promise<void> => {
    const requestGeneration = generation.current;
    // Identity is the business id, not the (business, version) key: the first
    // load may resolve the version, and every later update must still land.
    const update = (change: Partial<ProfileGroupMemberDraft>): void => {
      if (requestGeneration !== generation.current) return;
      setDraft((current) => current === null ? current : {
        ...current,
        members: current.members.map((item) => (item.businessId === member.businessId ? { ...item, ...change } : item)),
      });
    };
    update({ catalogLoading: true, catalogProblem: null, catalog: null });
    try {
      let version = member.businessVersion;
      const versionsResult = await client.getBusinessVersions(member.businessId);
      if (versionsResult.ok) {
        const versions = parseBusinessVersions(versionsResult.data);
        if (versions) {
          if (!version) version = versions.activeVersion ?? versions.rows.find((row) => row.isActive)?.version ?? versions.rows[0]?.version ?? '';
          update({
            versions: versions.rows.map((row) => row.version),
            ...(version && version !== member.businessVersion ? { businessVersion: version } : {}),
          });
        }
      }
      if (!version) {
        update({ catalogLoading: false, catalogProblem: 'The registered versions could not be read.' });
        return;
      }
      // Wave3-F4: pass the current tenant so the catalog can pin each workflow
      // action to that tenant's ACTIVE revision. Without it the editor has no
      // default to offer for a newly selected workflow function.
      const catalogResult = await client.getBusinessFunctionCatalog(member.businessId, version, tenantId ?? undefined);
      if (!catalogResult.ok) {
        update({ catalogLoading: false, catalogProblem: catalogResult.problem.title ?? 'The function catalog could not be read.' });
        return;
      }
      const catalog = parseProfileGroupFunctionCatalog(catalogResult.data);
      if (!catalog || catalog.businessId !== member.businessId || catalog.businessVersion !== version) {
        update({ catalogLoading: false, catalogProblem: 'The function catalog did not match the selected business version.' });
        return;
      }
      update({ catalogLoading: false, catalog, catalogProblem: catalog.businessEnabled ? null : 'This business is disabled.' });
    } catch {
      update({ catalogLoading: false, catalogProblem: 'The function catalog could not be reached.' });
    }
  }, [client, tenantId]);

  const openGroup = useCallback(async (groupId: string, preserveTab = false): Promise<void> => {
    if (!tenantId) return;
    generation.current += 1;
    const requestGeneration = generation.current;
    setGroupLoading(true);
    setProblem(null);
    setNotice(null);
    setReloadRequired(false);
    try {
      const result = await client.getProfileGroupV2(groupId, tenantId);
      if (requestGeneration !== generation.current) return;
      if (!result.ok) {
        const copy = resolveProfileGroupV2Error(result.problem);
        setProblem(copy.title);
        return;
      }
      const parsed = parseProfileGroup(result.data);
      const group = parsed;
      if (!group) {
        setProblem('The profile group response did not match the API contract.');
        return;
      }
      setSelectedGroup(group);
      const nextDraft = enrichDraftWithRegistry(profileGroupDraftFromRead(group), businesses);
      setDraft(nextDraft);
      if (!preserveTab) setTab('configuration');
      await Promise.all(nextDraft.members.map((member) => loadMemberCatalog(member)));
    } catch {
      if (requestGeneration === generation.current) setProblem('The profile group could not be reached.');
    } finally {
      if (requestGeneration === generation.current) setGroupLoading(false);
    }
  }, [businesses, client, loadMemberCatalog, tenantId]);

  /**
   * Grant mutations only move `accessVersion` and the grant ledger. Refresh the
   * group snapshot WITHOUT replacing the configuration draft, so an operator
   * does not lose unsaved edits by visiting the Root access pane.
   */
  const reloadGroup = useCallback(async (): Promise<void> => {
    const groupId = selectedGroup?.groupId;
    if (!groupId || !tenantId) return;
    try {
      const result = await client.getProfileGroupV2(groupId, tenantId);
      if (!result.ok) {
        setProblem(resolveProfileGroupV2Error(result.problem).title);
        return;
      }
      const group = parseProfileGroup(result.data);
      if (!group) {
        setProblem('The refreshed profile group was not readable.');
        return;
      }
      setSelectedGroup(group);
      setDraft((current) => (current === null ? current : {
        ...current,
        accessVersion: group.accessVersion,
        authAuthority: group.authAuthority,
      }));
    } catch {
      setProblem('The profile group could not be refreshed.');
    }
  }, [client, selectedGroup?.groupId, tenantId]);

  useEffect(() => {
    generation.current += 1;
    setSelectedGroup(null);
    setDraft(null);
    setGroups([]);
    setBusinesses([]);
    setProblem(null);
    setNotice(null);
    setTab('configuration');
    if (!tenantId) return;
    void loadBusinesses();
    void loadGroups();
    void client.listApiKeys({ tenantId, limit: '100' }).then((result) => {
      if (result.ok) setApiKeys(result.data.items.filter((key) => key.status === 'ACTIVE'));
    });
    void loadConnectorPinOptions(client, tenantId).then((catalog) => {
      setConnectors(catalog.items);
      setConnectorsProblem(catalog.problem);
    });
  }, [client, loadBusinesses, loadGroups, tenantId]);

  function createNewGroup(): void {
    if (!tenantId) return;
    generation.current += 1;
    setSelectedGroup(null);
    setProblem(null);
    setNotice(null);
    setReloadRequired(false);
    setDraft({
      groupId: null,
      tenantId,
      name: '',
      authMode: 'API_KEY',
      revision: 0,
      accessVersion: 1,
      authAuthority: 'GROUP_GRANT',
      members: [],
      selectedFunctionsByVersion: {},
      functionDrafts: {},
    });
    setTab('configuration');
  }

  function updateDraft(update: (current: ProfileGroupEditorDraft) => ProfileGroupEditorDraft): void {
    setDraft((current) => (current === null ? current : update(current)));
  }

  function addBusiness(businessId: string): void {
    const business = businesses.find((item) => item.businessId === businessId);
    if (!business || business.enabled !== true) return;
    updateDraft((current) => {
      if (current.members.some((member) => member.businessId === businessId)) return current;
      return {
        ...current,
        members: [...current.members, {
          businessId,
          businessVersion: business.activeVersion ?? business.version ?? '',
          versions: [],
          enabled: business.enabled,
          lifecycleRevision: business.lifecycleRevision,
          catalog: null,
          catalogLoading: true,
          catalogProblem: null,
        }],
      };
    });
    const member: ProfileGroupMemberDraft = {
      businessId,
      businessVersion: business.activeVersion ?? business.version ?? '',
      versions: [],
      enabled: business.enabled,
      lifecycleRevision: business.lifecycleRevision,
      catalog: null,
      catalogLoading: true,
      catalogProblem: null,
    };
    void loadMemberCatalog(member);
  }

  function removeBusiness(businessId: string): void {
    updateDraft((current) => ({
      ...current,
      members: current.members.filter((member) => member.businessId !== businessId),
    }));
  }

  function changeMemberVersion(member: ProfileGroupMemberDraft, version: string): void {
    const key = profileGroupMemberDraftKey(member.businessId, member.businessVersion);
    updateDraft((current) => {
      const selected = { ...current.selectedFunctionsByVersion };
      delete selected[key];
      return {
        ...current,
        members: current.members.map((item) => (item.businessId === member.businessId
          ? { ...item, businessVersion: version, catalog: null, catalogLoading: true, catalogProblem: null }
          : item)),
        selectedFunctionsByVersion: selected,
      };
    });
    void loadMemberCatalog({ ...member, businessVersion: version });
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

  function updateFunctionDraft(
    member: ProfileGroupMemberDraft,
    functionId: string,
    update: (current: ProfileGroupFunctionDraft) => ProfileGroupFunctionDraft,
  ): void {
    const key = profileGroupFunctionDraftKey(member.businessId, member.businessVersion, functionId);
    updateDraft((current) => ({
      ...current,
      functionDrafts: { ...current.functionDrafts, [key]: update(current.functionDrafts[key] ?? emptyProfileGroupFunctionDraft()) },
    }));
  }

  /**
   * PC-R06: editing a value must never touch `isLocked`. The helper spreads the
   * stored entry, so an explicit `true`/`false` survives and an ABSENT lock
   * stays absent (a schema `defaultLocked` then keeps applying).
   */
  function updatePolicyParameter(member: ProfileGroupMemberDraft, functionId: string, parameter: string, value: unknown): void {
    updateFunctionDraft(member, functionId, (current) => ({
      ...current,
      parameters: setParameterValue(current.parameters, parameter, value),
    }));
  }

  /** PC-R06 defect fix: the previous `{ value }` replacement dropped the lock. */
  function updateRequestDefault(member: ProfileGroupMemberDraft, functionId: string, parameter: string, value: unknown): void {
    updateFunctionDraft(member, functionId, (current) => ({
      ...current,
      requestDefaults: setParameterValue(current.requestDefaults, parameter, value),
    }));
  }

  function updateConnectorBinding(member: ProfileGroupMemberDraft, functionId: string, slotName: string, value: string): void {
    const connector = connectors.find((item) => `${item.connectorId}@${item.revision}` === value);
    updateFunctionDraft(member, functionId, (current) => {
      const connectorBindings = { ...current.connectorBindings };
      if (connector) connectorBindings[slotName] = { connectorId: connector.connectorId, revision: connector.revision };
      else delete connectorBindings[slotName];
      return { ...current, connectorBindings };
    });
  }

  async function saveGroup(): Promise<void> {
    if (!draft || !tenantId || busy) return;
    if (!profileGroupWritesAllowed(draft)) return;
    const validationErrors = validateProfileGroupDraft(draft);
    if (validationErrors.length > 0) {
      setProblem(validationErrors[0] ?? 'Review the highlighted configuration.');
      return;
    }
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const body = buildProfileGroupSaveBody(draft, tenantId, draft.revision);
      const result = draft.groupId
        ? await client.replaceProfileGroupV2(draft.groupId, body)
        : await client.createProfileGroupV2(body);
      if (!result.ok) {
        const copy = resolveProfileGroupV2Error(result.problem);
        setProblem(copy.title);
        setReloadRequired(copy.recovery === 'reload' || copy.recovery === 'conversion_required');
        return;
      }
      const parsed = parseProfileGroup(result.data);
      const group = parsed;
      if (!group) {
        setProblem('The saved profile group response was not readable. Reload the group before editing it again.');
        return;
      }
      setSelectedGroup(group);
      const nextDraft = enrichDraftWithRegistry(profileGroupDraftFromRead(group), businesses);
      setDraft(nextDraft);
      setReloadRequired(false);
      setRollbackTarget('');
      setNotice(draft.groupId
        ? `Saved configuration revision ${group.revision}; the access version remains ${group.accessVersion}.`
        : `Created ${group.name} with configuration revision ${group.revision}. No API key was minted.`);
      await loadGroups();
      await Promise.all(nextDraft.members.map((member) => loadMemberCatalog(member)));
    } catch {
      setProblem('The save could not be confirmed. Reload the group before retrying.');
    } finally {
      setBusy(false);
    }
  }

  async function rollbackGroup(): Promise<void> {
    const group = selectedGroup;
    const targetRevision = Number(rollbackTarget);
    if (!group || busy) return;
    if (!profileGroupWritesAllowed(draft) || !Number.isSafeInteger(targetRevision) || targetRevision < 1 || targetRevision >= group.revision) {
      setProblem('Enter an earlier configuration revision number.');
      return;
    }
    setBusy(true);
    setProblem(null);
    setNotice(null);
    setRollbackConfirmOpen(false);
    try {
      const result = await client.rollbackProfileGroupV2(group.groupId, {
        expectedRevision: group.revision,
        targetRevision,
      });
      if (!result.ok) {
        const copy = resolveProfileGroupV2Error(result.problem);
        setProblem(copy.title);
        setReloadRequired(copy.recovery === 'reload');
        return;
      }
      const rolledBack = parseProfileGroup(result.data);
      if (!rolledBack) {
        setProblem('Rollback returned an unreadable group. Refresh before editing it again.');
        return;
      }
      setSelectedGroup(rolledBack);
      const nextDraft = enrichDraftWithRegistry(profileGroupDraftFromRead(rolledBack), businesses);
      setDraft(nextDraft);
      setRollbackTarget('');
      setNotice(`Restored configuration revision ${targetRevision}; the access version remains ${rolledBack.accessVersion}. Grants were not changed.`);
      await loadGroups();
      await Promise.all(nextDraft.members.map((member) => loadMemberCatalog(member)));
    } catch {
      setProblem('The rollback could not be confirmed. Reload the group before retrying.');
    } finally {
      setBusy(false);
    }
  }

  const writesAllowed = profileGroupWritesAllowed(draft);
  const validationErrors = draft ? validateProfileGroupDraft(draft) : [];
  const enabledBusinesses = businesses.filter((business) => business.enabled === true);
  const availableBusinesses = enabledBusinesses.filter((business) => !draft?.members.some((member) => member.businessId === business.businessId));

  function renderFunctionEditor(member: ProfileGroupMemberDraft, descriptor: ProfileGroupFunction) {
    const key = profileGroupFunctionDraftKey(member.businessId, member.businessVersion, descriptor.functionId);
    const config = draft?.functionDrafts[key] ?? emptyProfileGroupFunctionDraft();
    const locked = !writesAllowed || busy;
    // Wave3-F4: display the revision the save body will actually carry. The
    // draft's stored/explicit pin wins over the catalog default; when the
    // catalog advertises a different active revision, name it beside the pin so
    // the operator can see the override without being misled by either value.
    const effectiveWorkflowRevision = resolveEffectiveWorkflowRevision(config, descriptor);
    const catalogWorkflowRevision = descriptor.workflowRevision;
    // PC-R07: render each parameter ONLY in the source the manifest declares.
    const partition = partitionParameterSchemas({
      ...(descriptor.parameterResolution ? { parameterResolution: descriptor.parameterResolution } : {}),
      profileSchema: descriptor.profileSchema,
      inputSchema: (descriptor.inputSchema ?? {}) as Record<string, unknown>,
    });
    const capabilityNotice = requestDefaultsCapabilityNotice(partition);
    const emptyRequestDefaults = requestDefaultsEmptyMessage(partition);
    const requestDefaultsSchema = partition.requestDefaultsSchema;
    const misplaced = misplacedParameterEntries(
      descriptor.parameterResolution,
      config.parameters,
      config.requestDefaults,
    );
    const secretLikeDefaults = partition.requestDefaultNames.filter((name) => secretLikeParameterKey(name));
    return (
      <details key={descriptor.functionId} className="rounded border border-[var(--border-subtle)] p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {functionLabel(descriptor)} <span className="text-xs text-[var(--text-sub)]">· {descriptor.kind} · {descriptor.functionId}</span>
        </summary>
        <div className="mt-3 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={`Enabled for ${descriptor.functionId}`}
                checked={config.enabled}
                disabled={locked}
                onChange={(event) => updateFunctionDraft(member, descriptor.functionId, (current) => ({ ...current, enabled: event.target.checked }))}
              />
              Enabled
            </label>
            <FormField label="Job priority">
              <select
                aria-label={`Job priority for ${descriptor.functionId}`}
                className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm"
                value={config.jobPriority}
                disabled={locked}
                onChange={(event) => updateFunctionDraft(member, descriptor.functionId, (current) => ({
                  ...current,
                  jobPriority: event.target.value as ProfileGroupFunctionDraft['jobPriority'],
                }))}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </select>
            </FormField>
            <FormField label="Allowed file extensions">
              <Input
                aria-label={`Allowed file extensions for ${descriptor.functionId}`}
                value={config.allowedFileExtensions}
                placeholder="pdf,docx"
                disabled={locked}
                onChange={(event) => updateFunctionDraft(member, descriptor.functionId, (current) => ({
                  ...current,
                  allowedFileExtensions: event.target.value,
                }))}
              />
            </FormField>
          </div>

          <section aria-label={`Profile settings for ${descriptor.functionId}`} className="space-y-2">
            <h4 className="text-sm font-medium">Profile settings</h4>
            <p className="text-xs text-[var(--text-sub)]">
              Manifest profileSchema values become the pinned policy for this function. Parameters declared as
              request defaults are shown only under Request defaults.
            </p>
            {partition.declared && misplaced.profileSettings.length > 0 ? (
              <AlertBanner variant="warning" title="Stored profile settings are declared as request defaults">
                {misplaced.profileSettings.join(', ')} {misplaced.profileSettings.length === 1 ? 'is' : 'are'} declared
                as request defaults in this manifest. The resolver ignores the stored profile setting, and it is not
                saved in the next configuration revision.
              </AlertBanner>
            ) : null}
            <ProfileGroupSchemaFields
              schema={partition.profileSettingsSchema}
              values={config.parameters}
              onChange={(parameter, value) => updatePolicyParameter(member, descriptor.functionId, parameter, value)}
              disabled={locked}
              labelPrefix={`Profile setting for ${descriptor.functionId}`}
              emptyMessage={partition.declared
                ? 'This function declares no profile settings: every mapped parameter is a request default.'
                : 'This function declares no profile-specific settings.'}
            />
          </section>

          <section aria-label={`Request defaults for ${descriptor.functionId}`} className="space-y-2">
            <h4 className="text-sm font-medium">Request defaults</h4>
            <p className="text-xs text-[var(--text-sub)]">
              Values supplied here are applied to the request instead of the caller's input. They are separate
              from profile settings and must never carry credentials. Editing a value keeps its lock state;
              the effective lock is shown under each field.
            </p>
            {capabilityNotice ? (
              <AlertBanner variant="info" title="Request defaults are not editable for this function">
                {capabilityNotice}
              </AlertBanner>
            ) : null}
            {emptyRequestDefaults ? (
              <AlertBanner variant="info" title="No request defaults declared">
                {emptyRequestDefaults} Parameters that are not declared as request defaults are caller input.
              </AlertBanner>
            ) : null}
            {partition.declared && misplaced.requestDefaults.length > 0 ? (
              <AlertBanner variant="warning" title="Stored request defaults are not declared by this manifest">
                {misplaced.requestDefaults.join(', ')} {misplaced.requestDefaults.length === 1 ? 'is' : 'are'} no
                longer declared as request defaults, so the resolver ignores the stored value and it is not saved in
                the next configuration revision.
              </AlertBanner>
            ) : null}
            {secretLikeDefaults.length > 0 ? (
              <AlertBanner variant="warning" title="Credential-shaped request fields are hidden">
                {secretLikeDefaults.join(', ')} look like credentials. Provider credentials belong to the connector
                and cannot be configured here.
              </AlertBanner>
            ) : null}
            {requestDefaultsSchema ? (
              <ProfileGroupSchemaFields
                schema={requestDefaultsSchema}
                values={config.requestDefaults}
                onChange={(parameter, value) => updateRequestDefault(member, descriptor.functionId, parameter, value)}
                disabled={locked}
                labelPrefix={`Request default for ${descriptor.functionId}`}
                skip={secretLikeParameterKey}
                lockMeta={(parameter) => ({
                  entry: config.requestDefaults[parameter],
                  schemaDefaultLocked: schemaDeclaredLock(requestDefaultsSchema, parameter),
                })}
                emptyMessage="This function declares no request defaults."
              />
            ) : null}
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-medium">Connector bindings</h4>
            {connectorsProblem ? <p role="alert" className="text-xs text-[var(--badge-warning-text)]">{connectorsProblem}</p> : null}
            {descriptor.connectorSlots.length === 0 ? <p className="text-xs text-[var(--text-sub)]">This function declares no connector slots.</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {descriptor.connectorSlots.map((slot) => {
                const pin = config.connectorBindings[slot.name];
                return (
                  <FormField key={slot.name} label={`${slot.name}${slot.required ? ' *' : ''}`} description={slot.acceptedCapabilities.join(', ')}>
                    <select
                      aria-label={`Connector for ${slot.name} in ${descriptor.functionId}`}
                      className="h-9 w-full rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm"
                      value={pin ? `${pin.connectorId}@${pin.revision}` : ''}
                      disabled={locked}
                      onChange={(event) => updateConnectorBinding(member, descriptor.functionId, slot.name, event.target.value)}
                    >
                      <option value="">{slot.required ? 'Select a connector revision' : 'No connector bound'}</option>
                      {connectors.map((connector) => (
                        <option key={`${connector.connectorId}@${connector.revision}`} value={`${connector.connectorId}@${connector.revision}`}>
                          {connector.connectorId} · revision {connector.revision}
                        </option>
                      ))}
                    </select>
                  </FormField>
                );
              })}
            </div>
          </section>

          <section aria-label={`Server-owned pins for ${descriptor.functionId}`} className="rounded border border-dashed border-[var(--border-subtle)] p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-sub)]">Server-owned pins (read only)</h4>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-[var(--text-sub)]">Manifest digest</dt>
              <dd className="break-all font-mono">{config.manifestDigest || descriptor.manifestDigest}</dd>
              <dt className="text-[var(--text-sub)]">Child profile</dt>
              <dd className="break-all font-mono">{config.childPin?.childProfileId ?? 'assigned on save'}</dd>
              <dt className="text-[var(--text-sub)]">Child revision</dt>
              <dd className="font-mono">{config.childPin?.childRevision ?? 'assigned on save'}</dd>
              <dt className="text-[var(--text-sub)]">Selector</dt>
              <dd className="break-all font-mono">{descriptor.endpointSlug ?? descriptor.action}</dd>
              <dt className="text-[var(--text-sub)]">Workflow revision</dt>
              <dd className="font-mono">
                {effectiveWorkflowRevision ?? '—'}
                {effectiveWorkflowRevision !== null
                    && catalogWorkflowRevision !== undefined
                    && catalogWorkflowRevision !== effectiveWorkflowRevision
                  ? ` (catalog: ${catalogWorkflowRevision})`
                  : ''}
              </dd>
            </dl>
          </section>
        </div>
      </details>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Profile groups</CardTitle>
            <CardDescription>
              One named group binds business versions, functions and connector pins. Root key grants are a
              separate ledger: issuing or revoking a grant changes the access version, never the configuration.
            </CardDescription>
          </div>
          <Button type="button" variant="primary" disabled={!tenantId || busy || groupsLoading} onClick={createNewGroup}>
            New profile group
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!tenantId ? <AlertBanner variant="warning" title="Choose a tenant first">Profile groups require a tenant scope.</AlertBanner> : null}
        {problem ? (
          <AlertBanner variant="error" title="Profile group action failed">
            {problem}
            {reloadRequired ? (
              <Button size="sm" variant="outline" className="ml-3" disabled={busy || !selectedGroup} onClick={() => void openGroup(selectedGroup!.groupId)}>
                Reload from server
              </Button>
            ) : null}
          </AlertBanner>
        ) : null}
        {notice ? <AlertBanner variant="success" title="Profile groups">{notice}</AlertBanner> : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(15rem,0.7fr)_minmax(0,2.3fr)]">
          <section aria-labelledby="profile-group-list-title" className="h-[24rem] overflow-y-auto rounded border border-[var(--border-subtle)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="profile-group-list-title" className="text-sm font-semibold">Saved groups</h3>
              <Button type="button" size="sm" variant="outline" disabled={groupsLoading || !tenantId || busy} onClick={() => void loadGroups()}>Refresh</Button>
            </div>
            {groupsLoading ? <LoadingState title="Loading profile groups" /> : null}
            {groupsProblem ? <ErrorState title={groupsProblem} onRetry={() => void loadGroups()} /> : null}
            {!groupsLoading && !groupsProblem && groups.length === 0 ? <p className="text-sm text-[var(--text-sub)]">No profile groups are saved for this tenant.</p> : null}
            <div className="flex flex-col gap-2">
              {groups.map((group) => (
                <button
                  key={group.groupId}
                  type="button"
                  aria-pressed={selectedGroup?.groupId === group.groupId}
                  disabled={groupLoading || busy}
                  onClick={() => void openGroup(group.groupId)}
                  className={`rounded border p-3 text-left ${selectedGroup?.groupId === group.groupId ? 'border-[var(--cf-blue)] bg-[var(--bg-subtle)]' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)]'}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{group.name}</span>
                    <Badge variant={group.authAuthority === 'GROUP_GRANT' ? 'success' : 'warning'}>
                      {group.authAuthority === 'GROUP_GRANT' ? 'grants' : 'legacy'}
                    </Badge>
                  </span>
                  <span className="mt-1 block text-xs text-[var(--text-sub)]">
                    config rev {group.revision} · access v{group.accessVersion} · {group.apiKeyGrants.length} grant{group.apiKeyGrants.length === 1 ? '' : 's'}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--text-sub)]">
                    {group.businesses.length} business version{group.businesses.length === 1 ? '' : 's'} · {group.businesses.reduce((total, item) => total + item.functions.length, 0)} functions
                  </span>
                </button>
              ))}
            </div>
            {apiKeys.length === 0 && tenantId ? (
              <p className="mt-3 text-xs text-[var(--text-sub)]">
                This tenant has no active API key. Groups can still be configured; submission needs a granted key.
              </p>
            ) : null}
          </section>

          <div className="min-w-0 space-y-3">
            {groupLoading ? <LoadingState title="Loading the complete profile group" description="Configuration, root grants and both counters are being re-read." /> : null}
            {draft === null && !groupLoading ? (
              <EmptyState
                title="Select a group or create one"
                description="Configuration needs no API key. Root key grants are issued separately, after the group exists."
              />
            ) : null}
            {draft !== null ? (
              <TabsRoot value={tab} onValueChange={(value) => { if (value) setTab(value as EditorTab); }} className="min-w-0">
                <TabsList aria-label="Profile group panes">
                  <TabsTab value="configuration">Configuration</TabsTab>
                  <TabsTab value="access">Root access</TabsTab>
                  <TabsTab value="revisions">Revisions</TabsTab>
                </TabsList>

                <TabsPanel value="configuration" keepMounted>
                  <div className="space-y-4 pt-3">
                    <div className="rounded border border-[var(--border-subtle)] p-3">
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                        <dt className="text-[var(--text-sub)]">Group id</dt>
                        <dd className="break-all font-mono">{draft.groupId ?? 'created on first save'}</dd>
                        <dt className="text-[var(--text-sub)]">Tenant</dt>
                        <dd className="break-all font-mono">{draft.tenantId}</dd>
                        <dt className="text-[var(--text-sub)]">Config revision</dt>
                        <dd className="font-mono">{draft.revision}</dd>
                        <dt className="text-[var(--text-sub)]">Access version (grants)</dt>
                        <dd className="font-mono">{draft.accessVersion}</dd>
                        <dt className="text-[var(--text-sub)]">Authority</dt>
                        <dd>{draft.authAuthority === 'GROUP_GRANT' ? 'Root grants' : 'Legacy child projection'}</dd>
                      </dl>
                    </div>

                    {!writesAllowed ? (
                      <AlertBanner variant="warning" title="Read-only: this group still uses the legacy child projection">
                        The service refuses V2 configuration, rollback and grant writes with
                        <code className="mx-1">409 PROFILE_GROUP_V2_REQUIRED</code>
                        until the group is converted. Nothing on this screen can perform that conversion.
                      </AlertBanner>
                    ) : null}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField label="Profile group name" description="Up to 120 characters.">
                        <Input
                          aria-label="Profile group name"
                          maxLength={120}
                          value={draft.name}
                          disabled={!writesAllowed || busy}
                          onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
                        />
                      </FormField>
                      <FormField label="Authentication mode" description="The frozen contract exposes one mode; keys are issued in the Root access pane.">
                        <Input aria-label="Authentication mode" value={draft.authMode} disabled readOnly />
                      </FormField>
                    </div>

                    <section aria-labelledby="profile-group-businesses-title" className="space-y-3">
                      <div className="flex flex-wrap items-end justify-between gap-2">
                        <div>
                          <h3 id="profile-group-businesses-title" className="text-sm font-semibold">Registered businesses</h3>
                          <p className="text-xs text-[var(--text-sub)]">Each member keeps its own version and function set.</p>
                        </div>
                        <div className="flex items-end gap-2">
                          <label className="text-sm">
                            <span className="mb-1 block text-xs text-[var(--text-sub)]">Add enabled business</span>
                            <select
                              aria-label="Add enabled business"
                              className="h-9 min-w-48 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm"
                              value=""
                              disabled={!writesAllowed || busy || businessesLoading || availableBusinesses.length === 0}
                              onChange={(event) => { if (event.target.value) addBusiness(event.target.value); }}
                            >
                              <option value="">{businessesLoading ? 'Loading registry…' : availableBusinesses.length === 0 ? 'No enabled business available' : 'Select a business'}</option>
                              {availableBusinesses.map((business) => (
                                <option key={business.businessId} value={business.businessId}>{business.businessId}</option>
                              ))}
                            </select>
                          </label>
                          <Button type="button" size="sm" variant="outline" disabled={businessesLoading || busy} onClick={() => void loadBusinesses()}>
                            Refresh
                          </Button>
                        </div>
                      </div>
                      {businessesProblem ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{businessesProblem}</p> : null}
                      {draft.members.length === 0 ? <p className="rounded border border-dashed p-3 text-sm text-[var(--text-sub)]">No business is bound yet.</p> : null}

                      {draft.members.map((member) => {
                        const memberKey = profileGroupMemberDraftKey(member.businessId, member.businessVersion);
                        const selected = draft.selectedFunctionsByVersion[memberKey] ?? [];
                        const filter = memberFilters[memberKey] ?? '';
                        const descriptors = (member.catalog?.functions ?? []).filter((descriptor) => {
                          if (!filter.trim()) return true;
                          const needle = filter.trim().toLocaleLowerCase();
                          return [descriptor.functionId, descriptor.action, descriptor.endpointSlug ?? '', descriptor.kind]
                            .some((value) => value.toLocaleLowerCase().includes(needle));
                        });
                        return (
                          <div key={member.businessId} className="space-y-2 rounded border border-[var(--border-subtle)] p-3">
                            <div className="flex flex-wrap items-end justify-between gap-2">
                              <div>
                                <h4 className="text-sm font-semibold">{member.businessId}</h4>
                                <p className="text-xs text-[var(--text-sub)]">
                                  {member.enabled === true ? 'enabled' : 'lifecycle unknown'}
                                  {member.catalog ? ` · digest ${member.catalog.manifestDigest}` : ''}
                                </p>
                              </div>
                              <div className="flex flex-wrap items-end gap-2">
                                <label className="text-sm">
                                  <span className="mb-1 block text-xs text-[var(--text-sub)]">Version</span>
                                  <select
                                    aria-label={`Version for ${member.businessId}`}
                                    className="h-9 rounded border border-[var(--border-dark)] bg-[var(--bg-card)] px-2 text-sm"
                                    value={member.businessVersion}
                                    disabled={!writesAllowed || busy || member.versions.length === 0}
                                    onChange={(event) => changeMemberVersion(member, event.target.value)}
                                  >
                                    {(member.versions.length > 0 ? member.versions : [member.businessVersion]).filter(Boolean).map((version) => (
                                      <option key={version} value={version}>{version}</option>
                                    ))}
                                  </select>
                                </label>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={!writesAllowed || busy}
                                  onClick={() => removeBusiness(member.businessId)}
                                >
                                  Remove
                                </Button>
                              </div>
                            </div>
                            {member.catalogLoading ? <LoadingState title="Loading the function catalog" /> : null}
                            {member.catalogProblem ? <p role="alert" className="text-sm text-[var(--badge-danger-text)]">{member.catalogProblem}</p> : null}
                            {member.catalog && !member.catalogLoading ? (
                              <>
                                <FormField label="Filter functions" description={`${selected.length} selected of ${member.catalog.functions.length} registered.`}>
                                  <Input
                                    aria-label={`Filter functions for ${member.businessId}`}
                                    value={filter}
                                    disabled={busy}
                                    onChange={(event) => setMemberFilters((current) => ({ ...current, [memberKey]: event.target.value }))}
                                  />
                                </FormField>
                                <ul className="max-h-56 space-y-1 overflow-y-auto rounded border border-[var(--border-subtle)] p-2">
                                  {descriptors.length === 0 ? <li className="text-xs text-[var(--text-sub)]">No function matches this filter.</li> : null}
                                  {descriptors.map((descriptor) => {
                                    const checked = selected.includes(descriptor.functionId);
                                    const unavailable = descriptor.available === false;
                                    return (
                                      <li key={descriptor.functionId} className="flex items-start gap-2 text-sm">
                                        <input
                                          type="checkbox"
                                          aria-label={`Select ${descriptor.functionId}`}
                                          checked={checked}
                                          disabled={!writesAllowed || busy || unavailable}
                                          onChange={(event) => toggleFunction(member, descriptor.functionId, event.target.checked)}
                                        />
                                        <span className="min-w-0">
                                          <span className="block truncate font-mono text-xs">{functionLabel(descriptor)}</span>
                                          <span className="block truncate text-xs text-[var(--text-sub)]">
                                            {descriptor.kind} · {descriptor.functionId}
                                            {unavailable ? ` · unavailable: ${descriptor.unavailableReason ?? 'not supported'}` : ''}
                                          </span>
                                        </span>
                                      </li>
                                    );
                                  })}
                                </ul>
                                <div className="space-y-2">
                                  {member.catalog.functions
                                    .filter((descriptor) => selected.includes(descriptor.functionId))
                                    .map((descriptor) => renderFunctionEditor(member, descriptor))}
                                </div>
                              </>
                            ) : null}
                          </div>
                        );
                      })}
                    </section>

                    {validationErrors.length > 0 ? (
                      <AlertBanner variant="info" title="Before this group can be saved">
                        <ul className="list-disc pl-5 text-sm">
                          {validationErrors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}
                        </ul>
                      </AlertBanner>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="max-w-2xl text-xs text-[var(--text-sub)]">
                        Saving creates a new configuration revision. It never issues, revokes or transfers a key grant.
                      </p>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={!writesAllowed || busy || validationErrors.length > 0}
                        onClick={() => void saveGroup()}
                      >
                        {busy ? 'Saving…' : draft.groupId ? 'Save configuration revision' : 'Create profile group'}
                      </Button>
                    </div>
                  </div>
                </TabsPanel>

                <TabsPanel value="access" keepMounted>
                  <div className="pt-3">
                    {selectedGroup ? (
                      <ProfileGroupAccessPane
                        client={client}
                        group={selectedGroup}
                        writesAllowed={writesAllowed && !busy}
                        onAccessVersionChange={(accessVersion) => {
                          setSelectedGroup((current) => (current === null ? current : { ...current, accessVersion }));
                          updateDraft((current) => ({ ...current, accessVersion }));
                        }}
                        onReload={reloadGroup}
                        onNotice={setNotice}
                      />
                    ) : (
                      <AlertBanner variant="info" title="Save the group first">
                        Root grants address an existing group. Create the configuration revision, then issue the first key.
                      </AlertBanner>
                    )}
                  </div>
                </TabsPanel>

                <TabsPanel value="revisions" keepMounted>
                  <div className="space-y-3 pt-3">
                    <Card className="border-[var(--border-subtle)] shadow-sm">
                      <CardHeader>
                        <CardTitle className="text-base">Roll back configuration</CardTitle>
                        <CardDescription>
                          Rollback restores an earlier configuration revision. It does not issue, revoke or
                          transfer root grants, and the access version does not change.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-sm">
                          Current configuration revision: <strong>{draft.revision}</strong> · access version: <strong>{draft.accessVersion}</strong>
                        </p>
                        <div className="flex flex-wrap items-end gap-3">
                          <FormField label="Target configuration revision">
                            <Input
                              aria-label="Rollback target revision"
                              type="number"
                              min="1"
                              max={Math.max(1, draft.revision - 1)}
                              value={rollbackTarget}
                              disabled={!writesAllowed || busy || draft.revision < 2 || draft.groupId === null}
                              onChange={(event) => setRollbackTarget(event.target.value)}
                            />
                          </FormField>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!writesAllowed || busy || draft.revision < 2 || draft.groupId === null || !rollbackTarget}
                            onClick={() => setRollbackConfirmOpen(true)}
                          >
                            Roll back configuration
                          </Button>
                        </div>
                        {draft.groupId === null ? <p className="text-xs text-[var(--text-sub)]">A new group has no earlier revision to restore.</p> : null}
                      </CardContent>
                    </Card>
                  </div>
                </TabsPanel>
              </TabsRoot>
            ) : null}
          </div>
        </div>
      </CardContent>

      <ConfirmDialog
        open={rollbackConfirmOpen}
        onOpenChange={(open) => { if (!open && !busy) setRollbackConfirmOpen(false); }}
        title={`Roll back to configuration revision ${rollbackTarget || '—'}?`}
        description={`This restores the configuration pointer only. Root grants stay exactly as they are and the access version (${draft?.accessVersion ?? '—'}) does not change.`}
        confirmText="Roll back configuration"
        cancelText="Keep current revision"
        isLoading={busy}
        onConfirm={() => void rollbackGroup()}
        onCancel={() => setRollbackConfirmOpen(false)}
      />
    </Card>
  );
}
