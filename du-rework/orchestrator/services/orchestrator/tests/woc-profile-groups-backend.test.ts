import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { documentCoreManifest } from '../../../../businesses/document-core/src/manifest/document-core.manifest';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import type { BffRuntimeConfig } from '../src/app/admin/bff/upstream';
import type { BusinessManifest, ProfileGroup, ProfileGroupSave } from '@du/contracts';
import {
  ProfileGroupFunctionCatalogSchema,
  ProfileGroupRollbackSchema,
  ProfileGroupSaveSchema,
  ProfilePublishCommandSchema,
  ProfileRollbackCommandSchema,
  ProfileUpsertCommandSchema,
} from '@du/contracts';
import { getBusinessFunctionCatalog } from '../src/modules/admin-read/business-functions';
import { getProfileGroup, rollbackProfileGroup, saveProfileGroup } from '../src/modules/profiles/profile-groups';
import type { ProfileService } from '../src/modules/profiles/profiles';
import { createProfileService } from '../src/modules/profiles/profiles';
import type { ConnectorManagementStore } from '../src/modules/connectors/connector-management-store';
import { createProfileSelfServiceService } from '../src/modules/profiles/self-service';
import { handleProfileGroupsRoute, matchProfileGroupsRoute } from '../src/app/admin/bff/profile-groups';
import { runProfileUpsert } from '../src/modules/admin-actions/profile-actions';
import { runProfilePublish, runProfileRollback } from '../src/modules/admin-actions/profile-actions';
import { dispatchAdminAction } from '../src/modules/admin-actions/dispatcher';
import { handleAdminRoutes } from '../src/http/routes/admin';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const API_KEY_ID = '33333333-3333-4333-8333-333333333333';
const REPLACEMENT_API_KEY_ID = '88888888-8888-4888-8888-888888888888';
const CHILD_PROFILE_ID = '44444444-4444-4444-8444-444444444444';
const LOCAL_USER_ID = '55555555-5555-4555-8555-555555555555';
const MANIFEST_DIGEST = 'sha256:catalog-test';

function makeManifest(businessId = 'invoice-checker', actionName = 'extract'): BusinessManifest {
  const action = structuredClone(documentCoreManifest.actions.find((candidate) => candidate.name === actionName)!);
  return {
    ...structuredClone(documentCoreManifest),
    businessId,
    version: '1.0.0',
    actions: [action],
  };
}

function makeInput(overrides: Partial<ProfileGroupSave> = {}): ProfileGroupSave {
  return ProfileGroupSaveSchema.parse({
    name: 'Invoice review',
    tenantId: TENANT_ID,
    apiKey: { apiKeyId: API_KEY_ID },
    expectedRevision: 0,
    businesses: [{
      businessId: 'invoice-checker',
      businessVersion: '1.0.0',
      manifestDigest: MANIFEST_DIGEST,
      functions: [{
        kind: 'workflow',
        functionId: 'extract',
        action: 'extract',
        policy: {},
        connectorBindings: {},
      }],
    }],
    ...overrides,
  });
}

function catalogDb(manifest: BusinessManifest, businessEnabled: boolean) {
  return {
    query: async <T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> => ({
      rows: [{
        business_id: manifest.businessId,
        business_version: manifest.version,
        manifest,
        digest: MANIFEST_DIGEST,
        business_enabled: businessEnabled,
      }] as unknown as T[],
      rowCount: 1,
    } as unknown as QueryResult<T>),
  };
}

interface FakeOptions {
  manifest?: BusinessManifest;
  digest?: string;
  businessEnabled?: boolean;
  keyTenantId?: string;
  overlap?: boolean;
}

function fakeClient(options: FakeOptions = {}): PoolClient & { calls: string[] } {
  const calls: string[] = [];
  const client = {
    calls,
    query: async <T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> => {
      calls.push(text);
      let rows: unknown[] = [];
      if (text.includes('FROM api_keys') && text.includes("status='ACTIVE'")) {
        rows = [{ id: API_KEY_ID, tenant_id: options.keyTenantId ?? TENANT_ID, hash: 'hash-only-in-test', prefix: 'du_test', status: 'ACTIVE' }];
      } else if (text.includes('FROM business_catalog') && text.includes('FOR SHARE')) {
        rows = [{ business_id: options.manifest?.businessId ?? 'invoice-checker', enabled: options.businessEnabled ?? true }];
      } else if (text.includes('FROM business_versions v')) {
        rows = [{
          business_id: options.manifest?.businessId ?? 'invoice-checker',
          business_version: options.manifest?.version ?? '1.0.0',
          manifest: options.manifest ?? makeManifest(),
          digest: options.digest ?? MANIFEST_DIGEST,
          business_enabled: options.businessEnabled ?? true,
        }];
      } else if (text.includes('SELECT p.profile_id') && text.includes('FROM profile_active_revisions')) {
        rows = options.overlap ? [{ profile_id: '44444444-4444-4444-8444-444444444444' }] : [];
      }
      return { rows, rowCount: rows.length } as unknown as QueryResult<T>;
    },
  };
  return client as unknown as PoolClient & { calls: string[] };
}

interface FakeBindingRecord {
  business_id: string;
  business_version: string;
  action: string;
  endpoint_slug: string | null;
  profile_name: string | null;
  enabled: boolean;
  parameters: unknown;
  job_priority: string;
  allowed_file_extensions: string;
  connections_override: unknown;
  file_url_auth_cipher: string | null;
  callback_policy: unknown;
  allowed_origins: unknown;
  connector_bindings: unknown;
}

interface FakeGroupMemberRecord {
  business_id: string;
  business_version: string;
  manifest_digest: string;
  function_kind: 'endpoint' | 'workflow';
  function_id: string;
  action: string;
  endpoint_slug: string | null;
  workflow_revision: number | null;
  profile_id: string;
  binding_revision: number;
}

interface FakeGroupState {
  businesses: Map<string, { manifest: BusinessManifest; digest: string; enabled: boolean }>;
  groups: Map<string, { group_id: string; tenant_id: string; name: string; active_revision: number; created_at: Date; updated_at: Date }>;
  apiKeys: Map<string, { id: string; tenant_id: string; hash: string; prefix: string; status: string }>;
  groupRevisions: Map<string, { group_id: string; revision: number; tenant_id: string; name: string; api_key_id: string; created_at: Date }>;
  groupMembers: Map<string, FakeGroupMemberRecord[]>;
  profileNames: Map<string, { profile_id: string; tenant_id: string; api_key_id: string; business_id: string; business_version: string; action: string; profile_name: string; group_id: string | null }>;
  bindings: Map<string, Map<number, FakeBindingRecord>>;
  activeRevisions: Map<string, number>;
  memberships: Map<string, 'ACTIVE' | 'REVOKED'>;
}

function fakeGroupKey(groupId: string, revision: number): string {
  return `${groupId}:${revision}`;
}

function fakeMembershipKey(profileId: string, apiKeyId: string): string {
  return `${profileId}:${apiKeyId}`;
}

function fakeStateClone(state: FakeGroupState): FakeGroupState {
  return structuredClone(state);
}

function fakeGroupState(): FakeGroupState {
  const alpha = makeManifest('alpha-business', 'extract');
  const beta = makeManifest('beta-business', 'analyze');
  alpha.actions[0]!.connectorSlots = [];
  beta.actions[0]!.connectorSlots = [];
  return {
    businesses: new Map([
      [JSON.stringify(['alpha-business', '1.0.0']), { manifest: alpha, digest: MANIFEST_DIGEST, enabled: true }],
      [JSON.stringify(['beta-business', '1.0.0']), { manifest: beta, digest: MANIFEST_DIGEST, enabled: true }],
      [JSON.stringify(['invoice-checker', '1.0.0']), { manifest: makeManifest(), digest: MANIFEST_DIGEST, enabled: true }],
      [JSON.stringify(['document-core', documentCoreManifest.version]), { manifest: structuredClone(documentCoreManifest), digest: MANIFEST_DIGEST, enabled: true }],
    ]),
    groups: new Map(),
    apiKeys: new Map([[API_KEY_ID, { id: API_KEY_ID, tenant_id: TENANT_ID, hash: 'test-key-hash', prefix: 'du_test', status: 'ACTIVE' }]]),
    groupRevisions: new Map(),
    groupMembers: new Map(),
    profileNames: new Map(),
    bindings: new Map(),
    activeRevisions: new Map(),
    memberships: new Map(),
  };
}

function fakeRows<T extends QueryResultRow>(rows: unknown[]): QueryResult<T> {
  return { command: 'SELECT', oid: 0, fields: [], rows: rows as T[], rowCount: rows.length };
}

function fakeGroupClient(state: FakeGroupState): PoolClient {
  return {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      let rows: unknown[] = [];

      if (normalized.includes('from business_catalog') && normalized.includes('for share')) {
        const business = [...state.businesses.entries()].find(([key]) => (JSON.parse(key) as string[])[0] === params[0])?.[1];
        rows = business ? [{ business_id: params[0], enabled: business.enabled }] : [];
      } else if (normalized.includes('from business_versions v')) {
        const business = state.businesses.get(JSON.stringify([params[0], params[1]]));
        rows = business ? [{
          business_id: params[0], business_version: params[1], manifest: business.manifest,
          digest: business.digest, business_enabled: business.enabled,
        }] : [];
      } else if (normalized.includes('from api_keys k') && normalized.includes('unnest($2::uuid[])')) {
        const profileIds = params[1] as string[];
        rows = [...state.apiKeys.values()].filter((apiKey) =>
          apiKey.tenant_id === params[0]
          && apiKey.status === 'ACTIVE'
          && profileIds.every((profileId) => state.memberships.get(fakeMembershipKey(profileId, apiKey.id)) === 'ACTIVE'),
        );
      } else if (normalized.includes('from api_keys') && normalized.includes("status='active'")) {
        const apiKey = state.apiKeys.get(String(params[0]));
        rows = apiKey?.status === 'ACTIVE' ? [apiKey] : [];
      } else if (normalized.includes('from api_keys') && normalized.includes('where id=$1 and tenant_id=$2')) {
        const apiKey = state.apiKeys.get(String(params[0]));
        rows = apiKey?.tenant_id === params[1] ? [apiKey] : [];
      } else if (normalized.includes('from api_keys') && normalized.includes('where id=$1')) {
        const apiKey = state.apiKeys.get(String(params[0]));
        rows = apiKey ? [{ ...apiKey, name: null }] : [];
      } else if (normalized.includes('from profile_api_keys m')
          && normalized.includes('left join profile_active_revisions a')
          && normalized.includes('where m.api_key_id=$1')) {
        const membershipRows: Array<{
          profile_id: string;
          tenant_id: string;
          business_id: string | null;
          business_version: string | null;
          action: string | null;
          endpoint_slug: string | null;
        }> = [];
        for (const [membership, status] of state.memberships.entries()) {
          const [profileId, apiKeyId] = membership.split(':');
          if (apiKeyId !== String(params[0]) || status !== 'ACTIVE' || !profileId) continue;
          const activeRevision = state.activeRevisions.get(profileId!);
          const binding = activeRevision === undefined ? undefined : state.bindings.get(profileId!)?.get(activeRevision);
          if (!binding) {
            membershipRows.push({ profile_id: profileId, tenant_id: TENANT_ID, business_id: null, business_version: null, action: null, endpoint_slug: null });
            continue;
          }
          membershipRows.push({
            profile_id: profileId, tenant_id: TENANT_ID, business_id: binding.business_id,
            business_version: binding.business_version, action: binding.action, endpoint_slug: binding.endpoint_slug,
          });
        }
        rows = membershipRows;
      } else if (normalized.includes('from profile_api_keys')
          && normalized.includes('where api_key_id=$1 and state=\'active\'')) {
        rows = [...state.memberships.entries()].flatMap(([membership, status]) => {
          const [profileId, apiKeyId] = membership.split(':');
          return apiKeyId === String(params[0]) && status === 'ACTIVE'
            ? [{ profile_id: profileId, tenant_id: TENANT_ID }]
            : [];
        });
      } else if (normalized.includes('from profile_groups g join profile_group_revisions r')) {
        const group = state.groups.get(String(params[0]));
        const revision = group ? state.groupRevisions.get(fakeGroupKey(group.group_id, group.active_revision)) : undefined;
        const tenantMatches = params[1] === undefined || group?.tenant_id === params[1];
        rows = group && revision && tenantMatches ? [{
          group_id: group.group_id, tenant_id: group.tenant_id, root_name: group.name,
          active_revision: group.active_revision, created_at: group.created_at, updated_at: group.updated_at,
          revision: revision.revision, name: revision.name, api_key_id: revision.api_key_id,
          revision_created_at: revision.created_at,
        }] : [];
      } else if (normalized.includes('from profile_group_members m') && normalized.includes('join profile_bindings b')) {
        const groupId = String(params[0]);
        const revision = Number(params[1]);
        rows = (state.groupMembers.get(fakeGroupKey(groupId, revision)) ?? []).flatMap((member) => {
          const binding = state.bindings.get(member.profile_id)?.get(member.binding_revision);
          if (!binding) return [];
          return [{ ...member, active_binding_revision: state.activeRevisions.get(member.profile_id) ?? null, ...binding }];
        });
      } else if (normalized.includes('select group_id from profile_groups where group_id=$1')) {
        const group = state.groups.get(String(params[0]));
        rows = group && (params[1] === undefined || params[1] === group.tenant_id) ? [{ group_id: group.group_id }] : [];
      } else if (normalized.includes('select group_id from profile_groups where tenant_id=$1 and name=$2')) {
        rows = [...state.groups.values()].filter((group) => group.tenant_id === params[0] && group.name === params[1] && group.group_id !== params[2]).map((group) => ({ group_id: group.group_id }));
      } else if (normalized.includes('select group_id from profile_groups where tenant_id=$1 order by')) {
        rows = [...state.groups.values()].filter((group) => group.tenant_id === params[0]).map((group) => ({ group_id: group.group_id }));
      } else if (normalized.includes('select pg_advisory_xact_lock')) {
        rows = [];
      } else if (normalized.includes('select p.profile_id, p.revision, p.connector_bindings') && normalized.includes('from profile_active_revisions a')) {
        const [apiKeyId, businessId, businessVersion, action, endpointSlug] = params as [string, string, string, string, string | null];
        rows = [...state.bindings.entries()].flatMap(([profileId, revisions]) => {
          const activeRevision = state.activeRevisions.get(profileId);
          const binding = activeRevision === undefined ? undefined : revisions.get(activeRevision);
          if (!binding
              || state.memberships.get(fakeMembershipKey(profileId, apiKeyId)) !== 'ACTIVE'
              || binding.business_id !== businessId
              || binding.business_version !== businessVersion
              || binding.action !== action
              || (binding.endpoint_slug !== null && binding.endpoint_slug !== endpointSlug)) return [];
          return [{
            profile_id: profileId,
            revision: activeRevision,
            connector_bindings: binding.connector_bindings,
            enabled: binding.enabled,
            parameters: binding.parameters,
            job_priority: binding.job_priority,
            allowed_file_extensions: binding.allowed_file_extensions,
            connections_override: binding.connections_override,
            file_url_auth_cipher: binding.file_url_auth_cipher,
            request_redaction: [],
            callback_policy: binding.callback_policy,
            allowed_origins: binding.allowed_origins,
            profile_name: binding.profile_name,
            moved_at: new Date('2026-10-12T00:00:00.000Z'),
          }];
        });
      } else if (normalized.includes('select 1 from profile_api_keys m') && normalized.includes('where m.api_key_id=$1')) {
        rows = [...state.memberships.entries()].some(([membership, status]) => membership.endsWith(`:${String(params[0])}`) && status === 'ACTIVE') ? [{ '?column?': 1 }] : [];
      } else if (normalized.includes('select p.profile_id') && normalized.includes('from profile_active_revisions a')) {
        rows = [];
      } else if (normalized.includes('select id from tenants where id=$1')) {
        rows = params[0] === TENANT_ID ? [{ id: TENANT_ID }] : [];
      } else if (normalized.startsWith('insert into profile_groups')) {
        const [groupId, tenantId, name] = params as [string, string, string];
        const now = new Date('2026-10-12T00:00:00.000Z');
        state.groups.set(groupId, { group_id: groupId, tenant_id: tenantId, name, active_revision: 0, created_at: now, updated_at: now });
      } else if (normalized.includes('from profile_names') && normalized.includes('where tenant_id=$1 and profile_name=$2')) {
        const profile = [...state.profileNames.values()].find((entry) => entry.tenant_id === params[0] && entry.profile_name === params[1] && entry.business_id === params[2] && entry.business_version === params[3] && entry.action === params[4]);
        rows = profile ? [{ profile_id: profile.profile_id, group_id: profile.group_id }] : [];
      } else if (normalized.startsWith('insert into profile_names')) {
        const [profileId, tenantId, apiKeyId, businessId, businessVersion, action, profileName, groupId] = params as [string, string, string, string, string, string, string, string];
        state.profileNames.set(profileId, { profile_id: profileId, tenant_id: tenantId, api_key_id: apiKeyId, business_id: businessId, business_version: businessVersion, action, profile_name: profileName, group_id: groupId });
      } else if (normalized.startsWith('update profile_names set api_key_id=$2')) {
        const profile = state.profileNames.get(String(params[0]));
        if (profile && profile.group_id === params[2]) profile.api_key_id = String(params[1]);
      } else if (normalized.startsWith('insert into profile_api_keys')) {
        const [profileId, apiKeyId] = params as [string, string];
        state.memberships.set(fakeMembershipKey(profileId, apiKeyId), 'ACTIVE');
        rows = [{ created: true }];
      } else if (normalized.startsWith('update profile_api_keys set state=\'revoked\', revoked_at=now() where api_key_id=$1')) {
        for (const key of state.memberships.keys()) {
          if (key.endsWith(`:${String(params[0])}`)) state.memberships.set(key, 'REVOKED');
        }
      } else if (normalized.startsWith('insert into api_keys')) {
        const [tenantId, hash, prefix] = params as [string, string, string, string | null];
        const apiKey = { id: REPLACEMENT_API_KEY_ID, tenant_id: tenantId, hash, prefix, status: 'ACTIVE' };
        state.apiKeys.set(apiKey.id, apiKey);
        rows = [{ id: apiKey.id, status: apiKey.status, created_at: new Date('2026-10-12T00:00:00.000Z') }];
      } else if (normalized.startsWith('update api_keys set status=\'revoked\'')) {
        const apiKey = state.apiKeys.get(String(params[0]));
        if (apiKey) apiKey.status = 'REVOKED';
        rows = apiKey ? [{ id: apiKey.id }] : [];
      } else if (normalized.startsWith('update profile_api_keys set state=\'revoked\', revoked_at=now() where profile_id=$1 and state=\'active\'')) {
        for (const key of state.memberships.keys()) {
          if (key.startsWith(`${String(params[0])}:`)) state.memberships.set(key, 'REVOKED');
        }
      } else if (normalized.includes('where profile_id=any($1::uuid[]) and api_key_id<>$2')) {
        const profileIds = params[0] as string[];
        for (const memberId of profileIds) {
          for (const key of state.memberships.keys()) {
            if (key.startsWith(`${memberId}:`) && !key.endsWith(`:${String(params[1])}`)) state.memberships.set(key, 'REVOKED');
          }
        }
      } else if (normalized.startsWith('insert into profile_group_revisions')) {
        const [groupId, revision, tenantId, name, apiKeyId] = params as [string, number, string, string, string];
        state.groupRevisions.set(fakeGroupKey(groupId, revision), { group_id: groupId, revision, tenant_id: tenantId, name, api_key_id: apiKeyId, created_at: new Date('2026-10-12T00:00:00.000Z') });
      } else if (normalized.startsWith('insert into profile_group_members')) {
        const [groupId, groupRevision, businessId, businessVersion, digest, kind, functionId, action, endpointSlug, workflowRevision, profileId, bindingRevision] = params as [string, number, string, string, string, 'endpoint' | 'workflow', string, string, string | null, number | null, string, number];
        const groupKey = fakeGroupKey(groupId, groupRevision);
        const members = state.groupMembers.get(groupKey) ?? [];
        members.push({ business_id: businessId, business_version: businessVersion, manifest_digest: digest, function_kind: kind, function_id: functionId, action, endpoint_slug: endpointSlug, workflow_revision: workflowRevision, profile_id: profileId, binding_revision: bindingRevision });
        state.groupMembers.set(groupKey, members);
      } else if (normalized.startsWith('update profile_groups set name=$2, active_revision=$3')) {
        const group = state.groups.get(String(params[0]));
        if (group && group.active_revision === Number(params[3])) {
          group.name = String(params[1]);
          group.active_revision = Number(params[2]);
          group.updated_at = new Date('2026-10-12T00:00:00.000Z');
          return fakeRows<T>([{ group_id: group.group_id }]);
        }
        return fakeRows<T>([]);
      } else if (normalized.includes('select group_id, revision, tenant_id, name, api_key_id, created_at from profile_group_revisions')) {
        const revision = state.groupRevisions.get(fakeGroupKey(String(params[0]), Number(params[1])));
        rows = revision && revision.tenant_id === params[2] ? [revision] : [];
      } else if (normalized.includes('select revision from profile_active_revisions where profile_id=$1 for update')) {
        const revision = state.activeRevisions.get(String(params[0]));
        rows = revision === undefined ? [] : [{ revision }];
      } else if (normalized.startsWith('select 1 from profile_bindings where profile_id=$1 and revision=$2')) {
        rows = state.bindings.get(String(params[0]))?.has(Number(params[1])) ? [{ '?column?': 1 }] : [];
      } else if (normalized.startsWith('insert into profile_active_revisions')) {
        state.activeRevisions.set(String(params[0]), Number(params[1]));
      } else {
        throw new Error(`unhandled fake profile group SQL: ${normalized}`);
      }
      return fakeRows<T>(rows);
    },
  } as unknown as PoolClient;
}

function fakeProfileService(state: FakeGroupState, failAtRevision?: number): ProfileService {
  let created = 0;
  const createRevision = async (input: Parameters<ProfileService['createRevision']>[0]) => {
    created += 1;
    if (created === failAtRevision) throw new Error('injected failure after first child revision');
    const profileId = input.profileId;
    if (!profileId) throw new Error('profile id is required in group child fake');
    const revisions = state.bindings.get(profileId) ?? new Map<number, FakeBindingRecord>();
    const revision = Math.max(0, ...revisions.keys()) + 1;
    const policy = input.policy ?? {};
    revisions.set(revision, {
      business_id: input.businessId,
      business_version: input.businessVersion,
      action: input.action,
      endpoint_slug: input.endpointSlug ?? null,
      profile_name: [...state.profileNames.values()].find((entry) => entry.profile_id === profileId)?.profile_name ?? null,
      enabled: typeof policy.enabled === 'boolean' ? policy.enabled : true,
      parameters: policy.parameters ?? {},
      job_priority: typeof policy.jobPriority === 'string' ? policy.jobPriority : 'MEDIUM',
      allowed_file_extensions: typeof policy.allowedFileExtensions === 'string' ? policy.allowedFileExtensions : '',
      connections_override: policy.connectionsOverride ?? [],
      file_url_auth_cipher: null,
      callback_policy: policy.callbackPolicy ?? null,
      allowed_origins: policy.allowedOrigins ?? [],
      connector_bindings: input.connectorBindings,
    });
    state.bindings.set(profileId, revisions);
    state.activeRevisions.set(profileId, revision);
    return { profileId, revision, tenantId: TENANT_ID, apiKeyId: API_KEY_ID };
  };
  const profileService = {
    async lockSelectors() {},
    createRevision,
    async createGroupChildRevision(input: Parameters<ProfileService['createGroupChildRevision']>[0]) {
      return createRevision(input);
    },
    async addMembership(input: Parameters<ProfileService['addMembership']>[0]) {
      state.memberships.set(fakeMembershipKey(input.profileId, input.apiKeyId), 'ACTIVE');
      return { created: true };
    },
    async revokeMemberships(apiKeyId: string) {
      for (const key of state.memberships.keys()) {
        if (key.endsWith(`:${apiKeyId}`)) state.memberships.set(key, 'REVOKED');
      }
      return 1;
    },
  };
  return profileService as unknown as ProfileService;
}

function statefulGroupEnvironment() {
  let committed = fakeGroupState();
  const transact = async <T>(work: (client: PoolClient, profiles: ProfileService) => Promise<T>, failAtRevision?: number): Promise<T> => {
    const working = fakeStateClone(committed);
    const client = fakeGroupClient(working);
    const result = await work(client, fakeProfileService(working, failAtRevision));
    committed = working;
    return result;
  };
  const db = {
    pool: {} as Pool,
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => fakeGroupClient(committed).query<T>(sql, params),
    tx: async <T>(work: (client: PoolClient) => Promise<T>) => transact((client) => work(client)),
    close: async () => undefined,
  };
  return { db, transact, state: () => committed };
}

function multiBusinessInput(): ProfileGroupSave {
  return makeInput({
    businesses: [
      {
        businessId: 'alpha-business', businessVersion: '1.0.0', manifestDigest: MANIFEST_DIGEST,
        functions: [{ kind: 'workflow', functionId: 'extract', action: 'extract', policy: { parameters: { mode: { value: 'alpha' } } }, connectorBindings: {} }],
      },
      {
        businessId: 'beta-business', businessVersion: '1.0.0', manifestDigest: MANIFEST_DIGEST,
        functions: [{ kind: 'workflow', functionId: 'analyze', action: 'analyze', policy: { parameters: { mode: { value: 'beta' } } }, connectorBindings: {} }],
      },
    ],
  });
}

function groupOwnedClient(): PoolClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query: async <T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> => {
      calls.push(text);
      let rows: unknown[] = [];
      if (text.includes('FROM api_keys')) {
        rows = [{ id: API_KEY_ID, tenant_id: TENANT_ID, hash: 'hash-only-in-test', prefix: 'du_test', status: 'ACTIVE' }];
      } else if (text.includes('SELECT n.profile_id FROM profile_names n')) {
        rows = [{ profile_id: CHILD_PROFILE_ID }];
      } else if (text.includes('SELECT group_id FROM profile_names')) {
        rows = [{ group_id: '66666666-6666-4666-8666-666666666666' }];
      } else if (text.includes('SELECT n.group_id, b.business_id')) {
        rows = [{ group_id: '66666666-6666-4666-8666-666666666666', business_id: 'invoice-checker', business_version: '1.0.0', action: 'extract', endpoint_slug: null }];
      }
      return { rows, rowCount: rows.length } as unknown as QueryResult<T>;
    },
  } as unknown as PoolClient & { calls: string[] };
}

function assertHttpError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ status, code });
}

const SECOND_API_KEY_ID = '99999999-9999-4999-8999-999999999999';
const LEGACY_PROFILE_ID = '77777777-7777-4777-8777-777777777777';

function profileMutationSqlClient(options: { membershipChangesAfterSelectorLock?: boolean; overlapKeyId?: string } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  const overlappingKeys: string[] = [];
  let membershipReads = 0;
  let writes = 0;
  const currentSelector = {
    business_id: 'alpha-business',
    business_version: '1.0.0',
    action: 'extract',
    endpoint_slug: null,
  };
  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: normalized, params });
      let rows: unknown[] = [];
      if (normalized.includes('from api_keys') && normalized.includes('where hash=$1')) {
        rows = [{ id: API_KEY_ID, tenant_id: TENANT_ID, hash: 'hash-only-in-test', prefix: 'du_test', status: 'ACTIVE' }];
      } else if (normalized.startsWith('select b.business_id') && normalized.includes('from profile_active_revisions a')) {
        rows = [currentSelector];
      } else if (normalized.startsWith('select api_key_id, tenant_id from profile_api_keys')) {
        membershipReads += 1;
        const members = options.membershipChangesAfterSelectorLock && membershipReads >= 2
          ? [API_KEY_ID, SECOND_API_KEY_ID]
          : options.membershipChangesAfterSelectorLock
            ? [API_KEY_ID]
            : [API_KEY_ID, SECOND_API_KEY_ID];
        rows = members.map((apiKeyId) => ({ api_key_id: apiKeyId, tenant_id: TENANT_ID }));
      } else if (normalized.includes('pg_advisory_xact_lock')) {
        events.push('selector-lock');
      } else if (normalized.includes('from api_keys') && normalized.includes('where id=$1 for share')) {
        events.push('key-lock');
        rows = [{ id: params[0], tenant_id: TENANT_ID, hash: 'hash-only-in-test', prefix: 'du_test', status: 'ACTIVE' }];
      } else if (normalized.startsWith('select group_id from profile_names')) {
        rows = [{ group_id: null }];
      } else if (normalized.startsWith('select max(revision) as m from profile_bindings')) {
        rows = [{ m: 1 }];
      } else if (normalized.startsWith('select enabled, parameters, job_priority')) {
        rows = [{
          enabled: true, parameters: {}, job_priority: 'MEDIUM', allowed_file_extensions: '',
          connections_override: [], file_url_auth_cipher: null, request_redaction: [], callback_policy: null,
          allowed_origins: [], endpoint_slug: null,
        }];
      } else if (normalized.startsWith('select b.profile_id from profile_active_revisions')) {
        const apiKeyId = String(params[0]);
        overlappingKeys.push(apiKeyId);
        rows = options.overlapKeyId === apiKeyId ? [{ profile_id: '88888888-8888-4888-8888-888888888888' }] : [];
      } else if (normalized.startsWith('insert into ')) {
        writes += 1;
      }
      return { rows, rowCount: rows.length } as unknown as QueryResult<T>;
    },
  } as unknown as PoolClient;
  return { client, calls, events, overlappingKeys, get membershipReads() { return membershipReads; }, get writes() { return writes; } };
}

function legacyPointerHarness() {
  const activeSelector = { businessId: 'alpha-business', businessVersion: '1.0.0', action: 'extract', endpointSlug: null };
  const latestSelector = { businessId: 'alpha-business', businessVersion: '3.0.0', action: 'extract', endpointSlug: null };
  const rollbackSelector = { businessId: 'alpha-business', businessVersion: '0.9.0', action: 'extract', endpointSlug: null };
  const latest = { revision: 3, selector: latestSelector };
  const memberships = [
    { apiKeyId: SECOND_API_KEY_ID, tenantId: TENANT_ID },
    { apiKeyId: API_KEY_ID, tenantId: TENANT_ID },
  ];
  const conflictError = Object.assign(new Error('another active profile already binds this API key and function'), {
    status: 409,
    code: 'STATE_CONFLICT',
  });
  const profiles = {
    lockProfileMutation: jest.fn(async () => ({
      activeSelector,
      memberships,
      keys: new Map([
        [API_KEY_ID, { id: API_KEY_ID, tenant_id: TENANT_ID, hash: 'hash-only-in-test', prefix: 'du_test', status: 'ACTIVE' }],
        [SECOND_API_KEY_ID, { id: SECOND_API_KEY_ID, tenant_id: TENANT_ID, hash: 'other-test-hash', prefix: 'du_other', status: 'ACTIVE' }],
      ]),
    })),
    getLatestRevisionSelector: jest.fn(async () => latest),
    getRevisionSelector: jest.fn(async () => rollbackSelector),
    assertSelectorAvailableForMemberships: jest.fn(async () => { throw conflictError; }),
  } as unknown as ProfileService;
  const calls: string[] = [];
  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push(normalized);
      let rows: unknown[] = [];
      if (normalized.includes('from api_keys') && normalized.includes('where id=$1')) {
        rows = [{ id: API_KEY_ID, tenant_id: TENANT_ID, hash: 'hash-only-in-test' }];
      } else if (normalized.startsWith('select n.profile_id from profile_names n')) {
        rows = [{ profile_id: LEGACY_PROFILE_ID }];
      } else if (normalized.startsWith('select group_id from profile_names')) {
        rows = [{ group_id: null }];
      }
      return { rows, rowCount: rows.length } as unknown as QueryResult<T>;
    },
  } as unknown as PoolClient;
  return { profiles, client, calls, activeSelector, latest, latestSelector, rollbackSelector };
}

function responseCapture() {
  let body = '';
  const res = {
    statusCode: 0,
    setHeader() {},
    end(value?: string) { body = value ?? ''; },
  };
  return { res: res as unknown as ServerResponse, body: () => body, status: () => res.statusCode };
}

function localOperatorConfig(): ShellRuntimeConfig {
  return {
    oidcSessions: {
      async get() {
        return {
          sessionId: 'S'.repeat(43), issuer: 'du-local', sub: LOCAL_USER_ID,
          tenantId: TENANT_ID, role: 'operator', csrfToken: 'C'.repeat(43), roleVersion: 3,
        };
      },
    },
  } as unknown as ShellRuntimeConfig;
}

function profileGroupWire(): ProfileGroup {
  return {
    groupId: '66666666-6666-4666-8666-666666666666',
    name: 'Invoice review',
    tenantId: TENANT_ID,
    revision: 1,
    apiKey: { apiKeyId: API_KEY_ID, prefix: 'du_test', status: 'ACTIVE' },
    businesses: [{
      businessId: 'invoice-checker',
      businessVersion: '1.0.0',
      manifestDigest: MANIFEST_DIGEST,
      functions: [{
        kind: 'workflow', functionId: 'extract', action: 'extract', manifestDigest: MANIFEST_DIGEST,
        childProfileId: CHILD_PROFILE_ID, childRevision: 1, enabled: true,
        policy: {
          enabled: true, parameters: {}, jobPriority: 'MEDIUM', allowedFileExtensions: '',
          fileUrlAuthConfigured: false, allowedOrigins: [], connectionsOverride: [], callbackPolicy: null,
        },
        connectorBindings: {},
      }],
    }],
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
}

describe('WOC-10 selected-version function catalog', () => {
  it('derives Core endpoint variants from the exact selected manifest and keeps other declared actions as workflow functions', async () => {
    const manifest = structuredClone(documentCoreManifest);
    const coreDb = catalogDb(manifest, true);
    const core = await getBusinessFunctionCatalog(coreDb, manifest.businessId, manifest.version);
    expect(ProfileGroupFunctionCatalogSchema.parse(core)).toEqual(core);
    const extractVariants = manifest.actions.find((action) => action.name === 'extract')!.inputSchema.properties as Record<string, { enum?: string[] }>;
    const declared = extractVariants.type!.enum!;
    expect(core.functions.filter((fn) => fn.action === 'extract').map((fn) => fn.endpointSlug)).toEqual(declared.map((value) => `extract:${value}`));
    expect(core.functions.every((fn) => fn.available === true)).toBe(true);

    const customManifest = makeManifest();
    const workflowDb = catalogDb(customManifest, false);
    const workflow = await getBusinessFunctionCatalog(workflowDb, customManifest.businessId, customManifest.version);
    expect(workflow.businessEnabled).toBe(false);
    expect(workflow.functions).toMatchObject([{ kind: 'workflow', functionId: 'extract', action: 'extract', available: true }]);
    expect(workflow.functions[0]!.endpointSlug).toBeUndefined();
  });

  it('fails explicitly when a Core manifest action has no declared string endpoint variants', async () => {
    const manifest = structuredClone(documentCoreManifest) as BusinessManifest;
    const ingest = manifest.actions.find((action) => action.name === 'ingest')!;
    const properties = ingest.inputSchema.properties as Record<string, unknown>;
    properties.mode = { type: 'string' };
    await expect(getBusinessFunctionCatalog(catalogDb(manifest, true), manifest.businessId, manifest.version)).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
  });
});

describe('WOC-10 group-save validation fences', () => {
  const noProfiles = { lockSelectors: jest.fn(async () => undefined) } as unknown as ProfileService;

  it('rejects overlapping functions before any database read or write', async () => {
    const client = fakeClient();
    const input = makeInput({
      businesses: [{
        businessId: 'invoice-checker', businessVersion: '1.0.0', manifestDigest: MANIFEST_DIGEST,
        functions: [
          { kind: 'workflow', functionId: 'extract', action: 'extract', policy: {}, connectorBindings: {} },
          { kind: 'workflow', functionId: 'extract-again', action: 'extract', policy: {}, connectorBindings: {} },
        ],
      }],
    });
    await assertHttpError(saveProfileGroup(client, noProfiles, undefined, input, null), 409, 'STATE_CONFLICT');
    expect(client.calls).toHaveLength(0);
  });

  it('requires an active key in the selected tenant', async () => {
    const client = fakeClient({ keyTenantId: OTHER_TENANT_ID });
    await assertHttpError(saveProfileGroup(client, noProfiles, undefined, makeInput(), null), 403, 'PERMISSION_DENIED');
    expect(client.calls.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('rejects disabled business roots and stale manifest digests before writes', async () => {
    const disabled = fakeClient({ businessEnabled: false });
    await assertHttpError(saveProfileGroup(disabled, noProfiles, undefined, makeInput(), null), 409, 'STATE_CONFLICT');
    expect(disabled.calls.some((sql) => /FROM business_catalog WHERE business_id=\$1 FOR SHARE/i.test(sql))).toBe(true);
    expect(disabled.calls.some((sql) => sql.includes('INSERT INTO'))).toBe(false);

    const stale = fakeClient({ digest: 'sha256:new-digest' });
    await assertHttpError(saveProfileGroup(stale, noProfiles, undefined, makeInput(), null), 409, 'MANIFEST_DIGEST_MISMATCH');
    expect(stale.calls.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('can request the business availability lock only for transactional binding validation', async () => {
    const client = fakeClient();
    await getBusinessFunctionCatalog(client, 'invoice-checker', '1.0.0', { lockAvailability: true });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toMatch(/FROM business_catalog WHERE business_id=\$1 FOR SHARE$/i);
    expect(client.calls[1]).toMatch(/FROM business_versions v/i);
    expect(client.calls[1]).not.toMatch(/FOR SHARE/i);
  });

  it('rejects undeclared functions and required connector slots that are not pinned', async () => {
    const undeclared = makeInput({
      businesses: [{
        businessId: 'invoice-checker', businessVersion: '1.0.0', manifestDigest: MANIFEST_DIGEST,
        functions: [{ kind: 'workflow', functionId: 'not-in-manifest', action: 'not-in-manifest', policy: {}, connectorBindings: {} }],
      }],
    });
    await assertHttpError(saveProfileGroup(fakeClient(), noProfiles, undefined, undeclared, null), 422, 'INVALID_SCHEMA');

    const manifest = makeManifest();
    manifest.actions[0]!.connectorSlots = [{ name: 'ocr', required: true, acceptedCapabilities: ['ocr'] }];
    const missingPin = fakeClient({ manifest });
    await assertHttpError(saveProfileGroup(missingPin, noProfiles, undefined, makeInput(), null), 422, 'INVALID_SCHEMA');
    expect(missingPin.calls.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it('validates explicit connector pins against a live tenant-visible revision and rejects active selector overlaps', async () => {
    const manifest = makeManifest();
    manifest.actions[0]!.connectorSlots = [{ name: 'ocr', required: false, acceptedCapabilities: ['ocr'] }];
    const input = makeInput({
      businesses: [{
        businessId: 'invoice-checker', businessVersion: '1.0.0', manifestDigest: MANIFEST_DIGEST,
        functions: [{
          kind: 'workflow', functionId: 'extract', action: 'extract', policy: {},
          connectorBindings: { ocr: { connectorId: 'conn-ocr', revision: 2 } },
        }],
      }],
    });
    const connectorStore = {
      getRecipeRevision: jest.fn(async () => ({ tenantId: TENANT_ID, connectorId: 'conn-ocr', revision: 2, state: 'ACTIVE' })),
      hasRecipeChain: jest.fn(async () => true),
      getRevision: jest.fn(async () => ({ connectorId: 'conn-ocr', revision: 2, state: 'ACTIVE', tenantId: TENANT_ID })),
    } as unknown as ConnectorManagementStore;
    const overlap = fakeClient({ manifest, overlap: true });
    await assertHttpError(saveProfileGroup(overlap, noProfiles, connectorStore, input, null), 409, 'STATE_CONFLICT');
    expect(connectorStore.getRecipeRevision).toHaveBeenCalledWith({ tenantId: TENANT_ID, connectorId: 'conn-ocr', revision: 2 });
    expect(connectorStore.getRevision).not.toHaveBeenCalled();
    expect(overlap.calls.some((sql) => sql.includes('INSERT INTO'))).toBe(false);

    const wrongTenantConnector = {
      // Typed NOT_FOUND permits the deliberate compatibility lookup.
      getRecipeRevision: async () => undefined,
      hasRecipeChain: async () => false,
      getRevision: async () => ({ connectorId: 'conn-ocr', revision: 2, state: 'ACTIVE', tenantId: OTHER_TENANT_ID }),
    } as unknown as ConnectorManagementStore;
    await assertHttpError(saveProfileGroup(fakeClient({ manifest }), noProfiles, wrongTenantConnector, input, null), 422, 'INVALID_SCHEMA');

    const shadowedLegacyConnector = {
      getRecipeRevision: jest.fn(async () => undefined),
      hasRecipeChain: jest.fn(async () => true),
      getRevision: jest.fn(async () => ({ connectorId: 'conn-ocr', revision: 2, state: 'ACTIVE', tenantId: TENANT_ID })),
    } as unknown as ConnectorManagementStore;
    await assertHttpError(saveProfileGroup(fakeClient({ manifest }), noProfiles, shadowedLegacyConnector, input, null), 422, 'INVALID_SCHEMA');
    expect(shadowedLegacyConnector.getRevision).not.toHaveBeenCalled();

    const inactiveTypedConnector = {
      getRecipeRevision: async () => ({ tenantId: TENANT_ID, connectorId: 'conn-ocr', revision: 2, state: 'RETIRED' }),
      hasRecipeChain: async () => true,
      getRevision: jest.fn(async () => ({ connectorId: 'conn-ocr', revision: 2, state: 'ACTIVE', tenantId: TENANT_ID })),
    } as unknown as ConnectorManagementStore;
    await assertHttpError(saveProfileGroup(fakeClient({ manifest }), noProfiles, inactiveTypedConnector, input, null), 422, 'INVALID_SCHEMA');
    expect(inactiveTypedConnector.getRevision).not.toHaveBeenCalled();

    const unavailableTypedConnector = {
      getRecipeRevision: async () => { throw new Error('typed Connector service unavailable'); },
      hasRecipeChain: async () => false,
      getRevision: jest.fn(async () => ({ connectorId: 'conn-ocr', revision: 2, state: 'ACTIVE', tenantId: TENANT_ID })),
    } as unknown as ConnectorManagementStore;
    await expect(saveProfileGroup(fakeClient({ manifest }), noProfiles, unavailableTypedConnector, input, null))
      .rejects.toThrow('typed Connector service unavailable');
    expect(unavailableTypedConnector.getRevision).not.toHaveBeenCalled();
  });
});

describe('WOC-10 direct legacy binding ownership guard', () => {
  it('rejects POST profile-bindings for a group-owned child before revision, pointer, membership, or audit writes', async () => {
    const queries: string[] = [];
    let auditWrites = 0;
    let apiKeyHash = '';
    const client = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        queries.push(normalized);
        if (normalized.includes('from api_keys') && normalized.includes('where hash=$1')) {
          apiKeyHash = String(params[0]);
          return fakeRows<T>([{ id: API_KEY_ID, tenant_id: TENANT_ID, hash: apiKeyHash }]);
        }
        if (normalized.includes('from api_keys') && normalized.includes('where id=$1')) {
          return fakeRows<T>([{ id: API_KEY_ID, tenant_id: TENANT_ID, hash: apiKeyHash, prefix: 'du_test', status: 'ACTIVE' }]);
        }
        if (normalized.includes('select group_id from profile_names')) {
          return fakeRows<T>([{ group_id: '66666666-6666-4666-8666-666666666666' }]);
        }
        return fakeRows<T>([]);
      },
    };
    const db = {
      pool: {} as Pool,
      query: async () => ({ rows: [], rowCount: 0 }),
      tx: async <T>(work: (transactionClient: PoolClient) => Promise<T>) => work(client as unknown as PoolClient),
      close: async () => undefined,
    };
    const audit = { record: async () => { auditWrites += 1; return { id: 'audit' }; } };
    const ctx = {
      method: 'POST',
      pathname: '/api/v1/admin/profile-bindings',
      headers: { authorization: 'Bearer group-test-admin' },
      body: {
        apiKey: 'raw-api-key-value',
        profileId: CHILD_PROFILE_ID,
        businessId: 'invoice-checker',
        businessVersion: '1.0.0',
        action: 'extract',
        connectorBindings: {},
      },
      rawBody: Buffer.from(''),
      searchParams: new URLSearchParams(),
      correlationId: 'corr-profile-groups-direct-child',
      host: 'localhost',
      config: { adminToken: 'group-test-admin' },
      db,
      audit,
      profiles: createProfileService(db as never),
    };

    await expect(handleAdminRoutes(ctx as never)).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(queries.some((sql) => sql.startsWith('insert into profile_bindings'))).toBe(false);
    expect(queries.some((sql) => sql.startsWith('insert into profile_active_revisions'))).toBe(false);
    expect(queries.some((sql) => sql.startsWith('insert into profile_api_keys'))).toBe(false);
    expect(auditWrites).toBe(0);
  });
});

describe('WOC-10 atomic group revisions', () => {
  it('orders selector serialization before key, business-availability, and child writes', async () => {
    const env = statefulGroupEnvironment();
    const order: string[] = [];
    await env.transact(async (client, profiles) => {
      const originalLock = profiles.lockSelectors.bind(profiles);
      profiles.lockSelectors = async (...args) => {
        order.push('selector-lock');
        await originalLock(...args);
      };
      const tracedClient = {
        query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => {
          const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
          if (normalized.includes('from api_keys') && normalized.includes('for share')) order.push('key-lock');
          if (normalized.includes('from business_catalog') && normalized.includes('for share')) order.push('catalog-lock');
          if (normalized.startsWith('insert into profile_names')) order.push('child-write');
          return client.query<T>(sql, params);
        },
      } as unknown as PoolClient;
      return saveProfileGroup(tracedClient, profiles, undefined, multiBusinessInput(), null);
    });
    const first = (event: string) => order.indexOf(event);
    expect(first('selector-lock')).toBeGreaterThanOrEqual(0);
    expect(first('selector-lock')).toBeLessThan(first('key-lock'));
    expect(first('key-lock')).toBeLessThan(first('catalog-lock'));
    expect(first('catalog-lock')).toBeLessThan(first('child-write'));
  });

  it('saves multiple declared Core endpoints sharing extract and resolves each endpoint to its own child policy', async () => {
    const catalog = await getBusinessFunctionCatalog(
      catalogDb(documentCoreManifest, true),
      'document-core',
      documentCoreManifest.version,
    );
    const endpoints = ['extract:invoice', 'extract:contract'].map((endpointSlug) => {
      const descriptor = catalog.functions.find((fn) => fn.kind === 'endpoint' && fn.functionId === endpointSlug);
      if (!descriptor || descriptor.endpointSlug !== endpointSlug || !descriptor.available) {
        throw new Error(`Core function catalog did not declare ${endpointSlug}`);
      }
      return {
        kind: 'endpoint' as const,
        functionId: endpointSlug,
        action: descriptor.action,
        endpointSlug,
        policy: { parameters: { type: { value: endpointSlug.endsWith(':invoice') ? 'invoice' : 'contract' } } },
        connectorBindings: { reasoning: { connectorId: 'core-reasoning', revision: 1 } },
      };
    });
    const input = ProfileGroupSaveSchema.parse({
      name: 'Core invoice and contract endpoints',
      tenantId: TENANT_ID,
      apiKey: { apiKeyId: API_KEY_ID },
      expectedRevision: 0,
      businesses: [{
        businessId: 'document-core',
        businessVersion: documentCoreManifest.version,
        manifestDigest: MANIFEST_DIGEST,
        functions: endpoints,
      }],
    });
    const connectors = {
      getRecipeRevision: async () => ({ tenantId: TENANT_ID, connectorId: 'core-reasoning', revision: 1, state: 'ACTIVE' }),
      hasRecipeChain: async () => true,
      getRevision: async (connectorId: string, revision: number) => ({
        connectorId, revision, state: 'ACTIVE', tenantId: TENANT_ID,
      }),
    } as unknown as ConnectorManagementStore;
    const env = statefulGroupEnvironment();
    const created = await env.transact((client, profiles) => saveProfileGroup(client, profiles, connectors, input, null));
    const savedFunctions = created.businesses[0]!.functions;
    expect(savedFunctions.map((fn) => fn.endpointSlug).sort()).toEqual(['extract:contract', 'extract:invoice']);
    expect(new Set(savedFunctions.map((fn) => fn.childProfileId)).size).toBe(2);

    const profiles = createProfileService(env.db as never);
    const invoice = await profiles.resolveEffectiveProfile(
      API_KEY_ID, 'document-core', documentCoreManifest.version, 'extract', {}, undefined, 'extract:invoice',
    );
    const contract = await profiles.resolveEffectiveProfile(
      API_KEY_ID, 'document-core', documentCoreManifest.version, 'extract', {}, undefined, 'extract:contract',
    );
    expect(invoice).toMatchObject({
      mode: 'pinned',
      profileId: savedFunctions.find((fn) => fn.endpointSlug === 'extract:invoice')!.childProfileId,
      policy: { parameters: { type: { value: 'invoice' } } },
    });
    expect(contract).toMatchObject({
      mode: 'pinned',
      profileId: savedFunctions.find((fn) => fn.endpointSlug === 'extract:contract')!.childProfileId,
      policy: { parameters: { type: { value: 'contract' } } },
    });
  });

  it('saves and reloads a full multi-business group, disables removed children, and rolls the full set back', async () => {
    const env = statefulGroupEnvironment();
    const created = await env.transact((client, profiles) => saveProfileGroup(client, profiles, undefined, multiBusinessInput(), null));
    expect(created.revision).toBe(1);
    expect(created.businesses.map((business) => business.businessId).sort()).toEqual(['alpha-business', 'beta-business']);
    expect(created.businesses.flatMap((business) => business.functions).map((fn) => fn.childRevision)).toEqual([1, 1]);

    const reloaded = await getProfileGroup(env.db as never, created.groupId, TENANT_ID);
    expect(reloaded).toMatchObject({ revision: 1, businesses: [{ businessId: 'alpha-business' }, { businessId: 'beta-business' }] });

    const betaOnly = makeInput({
      name: 'Invoice review v2', expectedRevision: 1,
      businesses: [{
        businessId: 'beta-business', businessVersion: '1.0.0', manifestDigest: MANIFEST_DIGEST,
        functions: [{ kind: 'workflow', functionId: 'analyze', action: 'analyze', policy: { parameters: { mode: { value: 'updated-beta' } } }, connectorBindings: {} }],
      }],
    });
    const second = await env.transact((client, profiles) => saveProfileGroup(client, profiles, undefined, betaOnly, created.groupId, TENANT_ID));
    expect(second.revision).toBe(2);
    expect(second.businesses.map((business) => business.businessId)).toEqual(['beta-business']);

    const stateAfterEdit = env.state();
    const alpha = [...stateAfterEdit.profileNames.values()].find((profile) => profile.business_id === 'alpha-business');
    expect(alpha).toBeDefined();
    expect(stateAfterEdit.activeRevisions.get(alpha!.profile_id)).toBe(2);
    expect(stateAfterEdit.bindings.get(alpha!.profile_id)?.get(2)?.enabled).toBe(false);
    expect(stateAfterEdit.memberships.get(fakeMembershipKey(alpha!.profile_id, API_KEY_ID))).toBe('REVOKED');

    const rollback = ProfileGroupRollbackSchema.parse({ targetRevision: 1, expectedRevision: 2 });
    const restored = await env.transact((client, profiles) => rollbackProfileGroup(client, profiles, undefined, created.groupId, rollback, TENANT_ID));
    expect(restored.revision).toBe(3);
    expect(restored.businesses.map((business) => business.businessId).sort()).toEqual(['alpha-business', 'beta-business']);
    expect(restored.businesses.flatMap((business) => business.functions.map((fn) => fn.childRevision))).toEqual([1, 1]);
    expect(env.state().activeRevisions.get(alpha!.profile_id)).toBe(1);
    const restoredReload = await getProfileGroup(env.db as never, created.groupId, TENANT_ID);
    expect(restoredReload.businesses.map((business) => business.businessId).sort()).toEqual(['alpha-business', 'beta-business']);
  });

  it('aborts rotation when ACTIVE membership selectors expand after the old-key lock', async () => {
    const env = statefulGroupEnvironment();
    await env.transact((client, profiles) => saveProfileGroup(client, profiles, undefined, multiBusinessInput(), null));
    const originalMemberships = [...env.state().memberships.entries()].filter(([, membershipState]) => membershipState === 'ACTIVE');
    const profiles = createProfileService(env.db as never);
    const readSelectors = profiles.listActiveMembershipSelectors.bind(profiles);
    const lockSelectorScopes = profiles.lockSelectors.bind(profiles);
    const lockOldApiKey = profiles.lockApiKeyRow.bind(profiles);
    const events: string[] = [];
    let selectorReads = 0;
    let initialSelectors: Awaited<ReturnType<typeof readSelectors>> = [];
    const selectorRead = jest.spyOn(profiles, 'listActiveMembershipSelectors').mockImplementation(async (apiKeyId, client) => {
      const current = await readSelectors(apiKeyId, client);
      selectorReads += 1;
      events.push(`selectors-${selectorReads}`);
      if (selectorReads === 1) {
        initialSelectors = current;
        return current;
      }
      return [...current, {
        profileId: '77777777-7777-4777-8777-777777777777',
        tenantId: TENANT_ID,
        selector: { businessId: 'beta-business', businessVersion: '1.0.0', action: 'extract', endpointSlug: null },
      }];
    });
    const lockSelectors = jest.spyOn(profiles, 'lockSelectors').mockImplementation(async (...args) => {
      events.push('selector-lock');
      return lockSelectorScopes(...args);
    });
    const lockApiKeyRow = jest.spyOn(profiles, 'lockApiKeyRow').mockImplementation(async (...args) => {
      events.push('key-update-lock');
      return lockOldApiKey(...args);
    });
    const listActiveMemberships = jest.spyOn(profiles, 'listActiveMemberships');
    const addMembership = jest.spyOn(profiles, 'addMembership');
    const revokeMemberships = jest.spyOn(profiles, 'revokeMemberships');
    const audit = { record: jest.fn(async () => ({ id: 'rotation-conflict-audit' })) };
    const hashApiKey = jest.fn(() => 'replacement-key-hash');
    const result = dispatchAdminAction({
      db: env.db,
      audit,
      registry: {},
      profiles,
      lifecycle: {},
      runtime: { resumeOperation: async () => ({}) },
      hashApiKey,
      correlationId: 'woc-profile-group-rotation-snapshot-change',
    } as never, { kind: 'bearer', principal: { role: 'platform' } }, {
      action: 'apikey.rotate', params: { apiKeyId: API_KEY_ID, apiKey: 'du_rotated_profile_group_20261012' },
    });

    await expect(result).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
      message: 'active API-key memberships changed while acquiring selector locks; retry rotation',
    });
    expect(selectorRead).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['selectors-1', 'selector-lock', 'key-update-lock', 'selectors-2']);
    expect(lockSelectors).toHaveBeenCalledTimes(1);
    expect(lockSelectors.mock.calls[0]?.[0]).toEqual(initialSelectors.map((membership) => membership.selector));
    expect(lockApiKeyRow).toHaveBeenCalledWith(API_KEY_ID, expect.anything(), 'update');
    expect(listActiveMemberships).not.toHaveBeenCalled();
    expect(hashApiKey).not.toHaveBeenCalled();
    expect(addMembership).not.toHaveBeenCalled();
    expect(revokeMemberships).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    const state = env.state();
    expect(state.apiKeys.has(REPLACEMENT_API_KEY_ID)).toBe(false);
    expect(state.apiKeys.get(API_KEY_ID)?.status).toBe('ACTIVE');
    expect([...state.memberships.entries()].filter(([, membershipState]) => membershipState === 'ACTIVE')).toEqual(originalMemberships);
    expect([...state.memberships.keys()].every((membership) => membership.endsWith(`:${API_KEY_ID}`))).toBe(true);
  });

  it('rotates through the existing dispatcher, recovers assigned reads, and edits and rolls back with the replacement key', async () => {
    const env = statefulGroupEnvironment();
    const created = await env.transact((client, profiles) => saveProfileGroup(client, profiles, undefined, multiBusinessInput(), null));
    const audit = { record: async () => ({ id: 'rotation-audit' }) };
    const rotationDeps = {
      db: env.db,
      audit,
      registry: {},
      profiles: createProfileService(env.db as never),
      lifecycle: {},
      runtime: { resumeOperation: async () => ({}) },
      hashApiKey: () => 'replacement-key-hash',
      correlationId: 'woc-profile-group-rotation',
    };
    const rotated = await dispatchAdminAction(
      rotationDeps as never,
      { kind: 'bearer', principal: { role: 'platform' } },
      { action: 'apikey.rotate', params: { apiKeyId: API_KEY_ID, apiKey: 'du_rotated_profile_group_20261012' } },
    );
    expect(rotated.body).toMatchObject({ apiKeyId: REPLACEMENT_API_KEY_ID, revokedId: API_KEY_ID });
    expect(env.state().apiKeys.get(API_KEY_ID)?.status).toBe('REVOKED');
    for (const member of created.businesses.flatMap((business) => business.functions)) {
      expect(env.state().memberships.get(fakeMembershipKey(member.childProfileId, API_KEY_ID))).toBe('REVOKED');
      expect(env.state().memberships.get(fakeMembershipKey(member.childProfileId, REPLACEMENT_API_KEY_ID))).toBe('ACTIVE');
    }

    const current = await getProfileGroup(env.db as never, created.groupId, TENANT_ID);
    expect(current.apiKey).toMatchObject({ apiKeyId: REPLACEMENT_API_KEY_ID, status: 'ACTIVE' });
    await expect(getProfileGroup(env.db as never, created.groupId, OTHER_TENANT_ID)).rejects.toMatchObject({ status: 404 });

    const assignedChildIds = current.businesses.flatMap((business) => business.functions.map((fn) => fn.childProfileId));
    const localQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT version FROM admin_local_users')) return { rows: [{ version: 3 }], rowCount: 1 };
      const apiKeyId = String(params[3]);
      const key = env.state().apiKeys.get(apiKeyId);
      const profileIds = params[4] as string[];
      const allowed = key?.status === 'ACTIVE'
        && key.tenant_id === TENANT_ID
        && profileIds.every((profileId) => env.state().memberships.get(fakeMembershipKey(profileId, apiKeyId)) === 'ACTIVE');
      return { rows: [{ ok: allowed }], rowCount: 1 };
    });
    const localReader = createProfileSelfServiceService({
      db: { query: localQuery } as never,
      profiles: {} as never,
      registry: {} as never,
      audit: {} as never,
      identity: { isLocalUserAssignedProfile: async () => true },
    });
    const localActor = { tenantId: TENANT_ID, issuer: 'du-local', userId: LOCAL_USER_ID, roleVersion: 3 };
    expect(await localReader.canReadAssignedProfileGroup({ profileIds: assignedChildIds, apiKeyId: REPLACEMENT_API_KEY_ID }, localActor)).toBe(true);
    expect(await localReader.canReadAssignedProfileGroup({ profileIds: assignedChildIds, apiKeyId: API_KEY_ID }, localActor)).toBe(false);
    expect(String(localQuery.mock.calls.at(-1)?.[0])).toContain('admin_local_user_api_key_grants');

    const editedInput = ProfileGroupSaveSchema.parse({
      ...multiBusinessInput(),
      name: `${created.name} after rotation`,
      apiKey: { apiKeyId: REPLACEMENT_API_KEY_ID },
      expectedRevision: 1,
    });
    const edited = await env.transact((client, profiles) => saveProfileGroup(client, profiles, undefined, editedInput, created.groupId, TENANT_ID));
    expect(edited.revision).toBe(2);
    expect(edited.apiKey.apiKeyId).toBe(REPLACEMENT_API_KEY_ID);
    const rolledBack = await env.transact((client, profiles) => rollbackProfileGroup(
      client,
      profiles,
      undefined,
      created.groupId,
      { targetRevision: 1, expectedRevision: 2 },
      TENANT_ID,
    ));
    expect(rolledBack).toMatchObject({ revision: 3, apiKey: { apiKeyId: REPLACEMENT_API_KEY_ID, status: 'ACTIVE' } });
    const alpha = await createProfileService(env.db as never).resolveEffectiveProfile(
      REPLACEMENT_API_KEY_ID, 'alpha-business', '1.0.0', 'extract',
    );
    expect(alpha).toMatchObject({ mode: 'pinned', profileId: created.businesses.find((business) => business.businessId === 'alpha-business')!.functions[0]!.childProfileId });
  });

  it('rolls back all writes when a later child revision fails inside the save transaction', async () => {
    const env = statefulGroupEnvironment();
    await expect(env.transact(
      (client, profiles) => saveProfileGroup(client, profiles, undefined, multiBusinessInput(), null),
      2,
    )).rejects.toThrow('injected failure after first child revision');
    expect(env.state().groups.size).toBe(0);
    expect(env.state().groupRevisions.size).toBe(0);
    expect(env.state().groupMembers.size).toBe(0);
    expect(env.state().profileNames.size).toBe(0);
    expect(env.state().bindings.size).toBe(0);
    expect(env.state().activeRevisions.size).toBe(0);
    expect(env.state().memberships.size).toBe(0);
  });
});

describe('WOC-10 selector and target-pointer overlap protection', () => {
  it('checks a changed revision against every active API-key membership before writing', async () => {
    const harness = profileMutationSqlClient({ overlapKeyId: SECOND_API_KEY_ID });
    const profiles = createProfileService({ tx: async (work: (client: PoolClient) => Promise<unknown>) => work(harness.client) } as never);
    await assertHttpError(profiles.createRevision({
      profileId: LEGACY_PROFILE_ID,
      apiKeyHash: 'hash-only-in-test',
      businessId: 'beta-business',
      businessVersion: '1.0.0',
      action: 'extract',
      connectorBindings: {},
      policy: {},
    }, harness.client), 409, 'STATE_CONFLICT');

    expect(harness.overlappingKeys).toEqual([API_KEY_ID, SECOND_API_KEY_ID]);
    expect(harness.events.filter((event) => event === 'selector-lock')).toHaveLength(2);
    expect(harness.events.filter((event) => event === 'key-lock')).toHaveLength(2);
    expect(harness.events.indexOf('selector-lock')).toBeLessThan(harness.events.indexOf('key-lock'));
    expect(harness.writes).toBe(0);
  });

  it('aborts when the active membership snapshot changes while selector locks are acquired', async () => {
    const harness = profileMutationSqlClient({ membershipChangesAfterSelectorLock: true });
    const profiles = createProfileService({ tx: async (work: (client: PoolClient) => Promise<unknown>) => work(harness.client) } as never);
    await assertHttpError(profiles.createRevision({
      profileId: LEGACY_PROFILE_ID,
      apiKeyHash: 'hash-only-in-test',
      businessId: 'beta-business',
      businessVersion: '1.0.0',
      action: 'extract',
      connectorBindings: {},
      policy: {},
    }, harness.client), 409, 'STATE_CONFLICT');

    expect(harness.membershipReads).toBe(2);
    expect(harness.events).toContain('selector-lock');
    expect(harness.events).not.toContain('key-lock');
    expect(harness.writes).toBe(0);
  });

  it('checks rollback target and latest publish target against all memberships before moving the pointer', async () => {
    const harness = legacyPointerHarness();
    const base = {
      apiKey: { apiKeyId: API_KEY_ID },
      businessId: 'alpha-business',
      businessVersion: '1.0.0',
      profileName: 'legacy-profile',
      action: 'extract',
    };
    const publish = ProfilePublishCommandSchema.parse({ ...base, expectedRevision: 2 });
    const rollback = ProfileRollbackCommandSchema.parse({ ...base, targetRevision: 1, expectedRevision: 2 });
    const deps = { db: {} as never, profiles: harness.profiles };
    const fence = () => undefined;

    await assertHttpError(runProfilePublish(harness.client, deps, publish, fence), 409, 'STATE_CONFLICT');
    await assertHttpError(runProfileRollback(harness.client, deps, rollback, fence), 409, 'STATE_CONFLICT');

    const lockCalls = (harness.profiles.lockProfileMutation as unknown as jest.Mock).mock.calls;
    expect(lockCalls.map((call) => call[1])).toEqual([[harness.latestSelector], [harness.rollbackSelector]]);
    const checked = (harness.profiles.assertSelectorAvailableForMemberships as unknown as jest.Mock).mock.calls;
    expect(checked.map((call) => new Set((call[0] as { apiKeyIds: string[] }).apiKeyIds))).toEqual([
      new Set([API_KEY_ID, SECOND_API_KEY_ID]),
      new Set([API_KEY_ID, SECOND_API_KEY_ID]),
    ]);
    expect(checked[0]![0]).toMatchObject(harness.latestSelector);
    expect(checked[1]![0]).toMatchObject(harness.rollbackSelector);
    expect(harness.calls.some((sql) => sql.startsWith('insert into profile_active_revisions'))).toBe(false);
  });
});

describe('WOC-10 group-owned children and local assignment visibility', () => {
  it('blocks legacy profile upsert, publish, rollback, and API-key attach against an owned child', async () => {
    const profiles = {
      createRevision: jest.fn(),
      createGroupChildRevision: jest.fn(),
      lockSelectors: jest.fn(async () => undefined),
      lockApiKeyRow: jest.fn(async (id: string) => ({ id, tenant_id: TENANT_ID, hash: 'hash-only-in-test', prefix: 'du_test', status: 'ACTIVE' })),
      lockProfileMutation: jest.fn(async () => ({
        activeSelector: { businessId: 'invoice-checker', businessVersion: '1.0.0', action: 'extract', endpointSlug: null },
        memberships: [{ apiKeyId: API_KEY_ID, tenantId: TENANT_ID }],
        keys: new Map([[API_KEY_ID, { id: API_KEY_ID, tenant_id: TENANT_ID, hash: 'hash-only-in-test', prefix: 'du_test', status: 'ACTIVE' }]]),
      })),
      getActiveSelector: jest.fn(async () => ({ businessId: 'invoice-checker', businessVersion: '1.0.0', action: 'extract', endpointSlug: null })),
      getLatestRevisionSelector: jest.fn(async () => ({ revision: 1, selector: { businessId: 'invoice-checker', businessVersion: '1.0.0', action: 'extract', endpointSlug: null } })),
      getRevisionSelector: jest.fn(async () => ({ businessId: 'invoice-checker', businessVersion: '1.0.0', action: 'extract', endpointSlug: null })),
      assertSelectorAvailableForMemberships: jest.fn(async () => undefined),
      addMembership: jest.fn(),
    } as unknown as ProfileService;
    const base = {
      apiKey: { apiKeyId: API_KEY_ID },
      businessId: 'invoice-checker',
      businessVersion: '1.0.0',
      profileName: '__du_group_child',
      action: 'extract',
    };
    const upsert = ProfileUpsertCommandSchema.parse({ ...base, policy: {} });
    const publish = ProfilePublishCommandSchema.parse({ ...base, expectedRevision: 1 });
    const rollback = ProfileRollbackCommandSchema.parse({ ...base, targetRevision: 1, expectedRevision: 1 });
    const deps = { db: {} as never, profiles };
    const fence = () => undefined;
    for (const run of [
      () => runProfileUpsert(groupOwnedClient(), deps, upsert, fence),
      () => runProfilePublish(groupOwnedClient(), deps, publish, fence),
      () => runProfileRollback(groupOwnedClient(), deps, rollback, fence),
    ]) {
      await assertHttpError(run(), 409, 'STATE_CONFLICT');
    }
    expect(profiles.createRevision).not.toHaveBeenCalled();

    const audit = { record: jest.fn() };
    const db = { tx: async (work: (client: PoolClient) => Promise<unknown>) => work(groupOwnedClient()) };
    await assertHttpError(dispatchAdminAction({
      db, audit, registry: {}, profiles, lifecycle: {}, runtime: { resumeOperation: async () => ({}) },
      hashApiKey: () => 'unused', correlationId: 'group-child-test',
    } as never, { kind: 'bearer', principal: { role: 'platform' } }, {
      action: 'apikey.attach', params: { apiKeyId: API_KEY_ID, profileId: CHILD_PROFILE_ID },
    }), 409, 'STATE_CONFLICT');
    expect(profiles.addMembership).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('requires every child assignment and the selected active API-key grant/membership for local reads', async () => {
    const query = jest.fn(async (text: string) => ({
      rows: text.includes('SELECT version FROM admin_local_users') ? [{ version: 3 }] : [{ ok: true }],
      rowCount: 1,
    }));
    const isAssignedProfile = jest.fn(async () => true);
    const service = createProfileSelfServiceService({
      db: { query } as never,
      profiles: {} as never,
      registry: {} as never,
      audit: {} as never,
      identity: { isLocalUserAssignedProfile: isAssignedProfile },
    });
    const actor = { tenantId: TENANT_ID, issuer: 'du-local', userId: LOCAL_USER_ID, roleVersion: 3 };
    expect(await service.canReadAssignedProfileGroup({
      profileIds: [CHILD_PROFILE_ID, '77777777-7777-4777-8777-777777777777'], apiKeyId: API_KEY_ID,
    }, actor)).toBe(true);
    expect(isAssignedProfile).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('admin_local_user_api_key_grants');
    expect(String(query.mock.calls[1]?.[0])).toContain("m.state='ACTIVE'");

    query.mockImplementation(async (text: string) => ({
      rows: text.includes('SELECT version FROM admin_local_users') ? [{ version: 3 }] : [{ ok: false }],
      rowCount: 1,
    }));
    expect(await service.canReadAssignedProfileGroup({ profileIds: [CHILD_PROFILE_ID], apiKeyId: API_KEY_ID }, actor)).toBe(false);
  });
});

describe('WOC-10 BFF route matching', () => {
  it('matches only the profile-group and exact business-version function catalog paths', () => {
    expect(matchProfileGroupsRoute('/profile-groups')).toEqual({ kind: 'list' });
    expect(matchProfileGroupsRoute('/profile-groups/11111111-1111-4111-8111-111111111111')).toEqual({ kind: 'group', groupId: '11111111-1111-4111-8111-111111111111' });
    expect(matchProfileGroupsRoute('/profile-groups/11111111-1111-4111-8111-111111111111/rollback')).toEqual({ kind: 'rollback', groupId: '11111111-1111-4111-8111-111111111111' });
    expect(matchProfileGroupsRoute('/businesses/document-core/versions/1.1.0/functions')).toEqual({ kind: 'functions', businessId: 'document-core', version: '1.1.0' });
    expect(matchProfileGroupsRoute('/businesses/document-core/versions/1.1.0/functions/')).toBeNull();
  });

  it('hides a known group id from a local USER without every child/key assignment and denies local creation', async () => {
    const group = profileGroupWire();
    const canReadAssignedProfileGroup = jest.fn(async () => false);
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify(group), { status: 200 }));
    const runtime: BffRuntimeConfig = {
      jsonBaseUrl: 'http://127.0.0.1:3000',
      tenantCredentialFor: (tenantId) => tenantId === TENANT_ID ? 'local-tenant-token' : undefined,
      profileSelfService: { canReadAssignedProfileGroup } as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    const shellRequest: AdminShellRequest = {
      method: 'GET', pathname: `/admin/api/profile-groups/${group.groupId}`,
      cookies: { du_session: 'S'.repeat(43) }, body: {},
    };
    const req = { method: 'GET', headers: {} } as unknown as IncomingMessage;
    const denied = responseCapture();
    await handleProfileGroupsRoute(
      req, denied.res, shellRequest, { kind: 'group', groupId: group.groupId }, new URLSearchParams(),
      localOperatorConfig(), runtime, 'local-group-read-test',
    );
    expect(denied.status()).toBe(404);
    expect(JSON.parse(denied.body())).toMatchObject({ code: 'NOT_FOUND' });
    expect(canReadAssignedProfileGroup).toHaveBeenCalledWith({ profileIds: [CHILD_PROFILE_ID], apiKeyId: API_KEY_ID }, {
      tenantId: TENANT_ID, issuer: 'du-local', userId: LOCAL_USER_ID, roleVersion: 3,
    });

    const createRequest: AdminShellRequest = {
      method: 'POST', pathname: '/admin/api/profile-groups', cookies: { du_session: 'S'.repeat(43) }, body: {},
    };
    const createDenied = responseCapture();
    await handleProfileGroupsRoute(
      { method: 'POST', headers: {} } as unknown as IncomingMessage,
      createDenied.res, createRequest, { kind: 'list' }, new URLSearchParams(),
      localOperatorConfig(), runtime, 'local-group-create-test',
    );
    expect(createDenied.status()).toBe(403);
    expect(JSON.parse(createDenied.body())).toMatchObject({ code: 'PROFILE_GROUP_ASSIGNMENT_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    for (const mutation of [
      { method: 'PUT' as const, route: { kind: 'group' as const, groupId: group.groupId }, pathname: `/admin/api/profile-groups/${group.groupId}` },
      { method: 'POST' as const, route: { kind: 'rollback' as const, groupId: group.groupId }, pathname: `/admin/api/profile-groups/${group.groupId}/rollback` },
    ]) {
      const request = {
        method: mutation.method,
        pathname: mutation.pathname,
        cookies: { du_session: 'S'.repeat(43) },
        body: {},
      } as unknown as AdminShellRequest;
      const deniedMutation = responseCapture();
      await handleProfileGroupsRoute(
        { method: mutation.method, headers: {} } as unknown as IncomingMessage,
        deniedMutation.res, request, mutation.route, new URLSearchParams(),
        localOperatorConfig(), runtime, 'local-group-mutation-test',
      );
      expect(deniedMutation.status()).toBe(403);
      expect(JSON.parse(deniedMutation.body())).toMatchObject({ code: 'PROFILE_GROUP_ASSIGNMENT_REQUIRED' });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
