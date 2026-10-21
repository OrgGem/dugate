/**
 * PC-08 — Profile Group V2 draft model (pure module, offline).
 *
 * These cases pin the invariants the editor relies on:
 *  - a save body carries NO `apiKey` and parses as `ProfileGroupV2SaveSchema`;
 *  - `revision` (configuration) and `accessVersion` (root grants) are
 *    independent values that the draft never derives from one another;
 *  - request defaults are an explicit operator decision (never auto-filled);
 *  - a still-CHILD_PROJECTION group is not writable;
 *  - every documented problem code maps to a distinct, actionable copy.
 */
import {
  BusinessManifestSchema,
  ProfileGroupFunctionCatalogSchema,
  ProfileGroupV2SaveSchema,
  ProfileGroupV2Schema,
  type BusinessManifest,
  type ProfileGroupFunctionCatalog,
  type ProfileGroupV2,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getBusinessFunctionCatalog } from '../src/modules/admin-read/business-functions';
import type { Db } from '../src/db/db';
import {
  buildProfileGroupSaveBody,
  emptyProfileGroupFunctionDraft,
  isProfileGroupRevisionConflict,
  parseProfileGroup,
  parseProfileGroupFunctionCatalog,
  parseProfileGroupList,
  profileGroupDraftFromRead,
  profileGroupFunctionDraftKey,
  profileGroupWritesAllowed,
  resolveEffectiveWorkflowRevision,
  resolveProfileGroupV2Error,
  secretLikeParameterKey,
  setParameterValue,
  validateProfileGroupDraft,
  type ProfileGroupEditorDraft,
} from '../../../apps/admin-web/src/features/profiles/profile-group-state';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '33333333-3333-4333-8333-333333333333';
const CHILD = '44444444-4444-4444-8444-444444444444';
const KEY = '22222222-2222-4222-8222-222222222222';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-10-05T00:00:00.000Z';

function readPolicy() {
  return {
    enabled: true,
    parameters: { documentType: { value: 'invoice', isLocked: false } },
    jobPriority: 'MEDIUM' as const,
    allowedFileExtensions: '',
    fileUrlAuthConfigured: false,
    allowedOrigins: [] as string[],
    connectionsOverride: [] as Array<{ slug: string }>,
  };
}

function groupFixture(overrides: Partial<ProfileGroupV2> = {}): ProfileGroupV2 {
  return {
    groupId: GROUP,
    tenantId: TENANT,
    name: 'Invoice operations',
    authMode: 'API_KEY',
    authAuthority: 'GROUP_GRANT',
    revision: 4,
    accessVersion: 7,
    businesses: [{
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST,
      functions: [{
        kind: 'endpoint',
        functionId: 'extract.invoice',
        action: 'extract',
        endpointSlug: 'extract.invoice',
        manifestDigest: DIGEST,
        childProfileId: CHILD,
        childRevision: 2,
        enabled: true,
        policy: readPolicy(),
        requestDefaults: { language: { value: 'en' } },
        connectorBindings: { reasoning: { connectorId: 'acme-llm', revision: 7 } },
      }],
    }],
    apiKeyGrants: [{ apiKeyId: KEY, prefix: 'du_live_abc123', status: 'ACTIVE', grantedAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function catalogFixture(): ProfileGroupFunctionCatalog {
  return {
    businessId: 'document-core',
    businessVersion: '1.0.0',
    manifestDigest: DIGEST,
    businessEnabled: true,
    functions: [{
      kind: 'endpoint',
      functionId: 'extract.invoice',
      action: 'extract',
      endpointSlug: 'extract.invoice',
      manifestDigest: DIGEST,
      inputSchema: {
        type: 'object',
        properties: { language: { type: 'string', title: 'Language' }, apiKey: { type: 'string' } },
      },
      outputSchema: { type: 'object' },
      profileSchema: {
        type: 'object',
        required: ['documentType'],
        properties: { documentType: { type: 'string', title: 'Document type' } },
      },
      available: true,
      connectorSlots: [{ name: 'reasoning', required: true, acceptedCapabilities: ['chat'] }],
    }],
  };
}

/** A saved-group draft with a loaded catalog, ready to validate. */
function readyDraft(group: ProfileGroupV2 = groupFixture()): ProfileGroupEditorDraft {
  const draft = profileGroupDraftFromRead(group);
  draft.members = draft.members.map((member) => ({
    ...member,
    enabled: true,
    lifecycleRevision: 3,
    catalog: catalogFixture(),
    catalogLoading: false,
    catalogProblem: null,
    versions: ['1.0.0'],
  }));
  return draft;
}

describe('PC-08 profile group V2 state: read projection', () => {
  it('accepts a contract-shaped v2 read and rejects a v1-shaped one', () => {
    expect(ProfileGroupV2Schema.safeParse(groupFixture()).success).toBe(true);
    const v1Shape = {
      groupId: GROUP,
      name: 'legacy',
      tenantId: TENANT,
      revision: 1,
      apiKey: { apiKeyId: KEY, prefix: 'du_x', status: 'ACTIVE' },
      businesses: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(ProfileGroupV2Schema.safeParse(v1Shape).success).toBe(false);
    expect(parseProfileGroup(v1Shape)).toBeNull();
  });

  it('keeps config revision, access version and authority separate in the draft', () => {
    const draft = profileGroupDraftFromRead(groupFixture());
    expect(draft.revision).toBe(4);
    expect(draft.accessVersion).toBe(7);
    expect(draft.authAuthority).toBe('GROUP_GRANT');
    expect(draft.authMode).toBe('API_KEY');
    expect('apiKeyId' in draft).toBe(false);
  });

  it('round-trips profile settings, request defaults and connector pins', () => {
    const draft = profileGroupDraftFromRead(groupFixture());
    const config = draft.functionDrafts[profileGroupFunctionDraftKey('document-core', '1.0.0', 'extract.invoice')];
    expect(config).toBeDefined();
    expect(config?.parameters.documentType?.value).toBe('invoice');
    expect(config?.requestDefaults.language?.value).toBe('en');
    expect(config?.connectorBindings.reasoning).toEqual({ connectorId: 'acme-llm', revision: 7 });
    expect(config?.childPin).toEqual({ childProfileId: CHILD, childRevision: 2 });
    expect(config?.manifestDigest).toBe(DIGEST);
  });

  it('parses the list/catalog envelopes and refuses foreign shapes', () => {
    expect(parseProfileGroupList({ groups: [groupFixture()] })?.groups).toHaveLength(1);
    expect(parseProfileGroupList({ groups: [{ nope: true }] })).toBeNull();
    expect(parseProfileGroupFunctionCatalog(catalogFixture())).not.toBeNull();
    expect(parseProfileGroupFunctionCatalog({ businessId: 'x' })).toBeNull();
  });
});

describe('PC-08 profile group V2 state: save body', () => {
  it('builds a zero-key save body that satisfies the frozen contract', () => {
    const draft = readyDraft();
    draft.name = '  Invoice operations  ';
    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    expect(ProfileGroupV2SaveSchema.safeParse(body).success).toBe(true);
    expect('apiKey' in body).toBe(false);
    expect(body.authMode).toBe('API_KEY');
    expect(body.name).toBe('Invoice operations');
    expect(body.expectedRevision).toBe(4);
    const fn = body.businesses[0]?.functions[0];
    expect(fn?.requestDefaults).toEqual({ language: { value: 'en' } });
    expect(fn?.policy.parameters?.documentType).toEqual({ value: 'invoice', isLocked: false });
    expect(fn?.connectorBindings.reasoning).toEqual({ connectorId: 'acme-llm', revision: 7 });
    expect(body.businesses[0]?.manifestDigest).toBe(DIGEST);
  });

  it('does not auto-fill request defaults from the input schema', () => {
    const draft = readyDraft();
    const key = profileGroupFunctionDraftKey('document-core', '1.0.0', 'extract.invoice');
    draft.functionDrafts[key] = { ...emptyProfileGroupFunctionDraft(), parameters: { documentType: { value: 'invoice' } }, connectorBindings: { reasoning: { connectorId: 'acme-llm', revision: 7 } } };
    const body = buildProfileGroupSaveBody(draft, TENANT);
    expect(body.businesses[0]?.functions[0]?.requestDefaults).toEqual({});
  });

  it('refuses to build without a matching catalog', () => {
    const draft = readyDraft();
    draft.members[0]!.catalog = null;
    expect(() => buildProfileGroupSaveBody(draft, TENANT)).toThrow(/catalog is missing/);
  });

  it('refuses a selected function that is unavailable', () => {
    const draft = readyDraft();
    const catalog = catalogFixture();
    catalog.functions[0]!.available = false;
    draft.members[0]!.catalog = catalog;
    expect(() => buildProfileGroupSaveBody(draft, TENANT)).toThrow(/unavailable/);
  });
});

describe('PC-08 profile group V2 state: validation', () => {
  it('accepts a complete draft', () => {
    expect(validateProfileGroupDraft(readyDraft())).toEqual([]);
  });

  it('requires a name and at least one business', () => {
    const draft = readyDraft();
    draft.name = '   ';
    draft.members = [];
    const errors = validateProfileGroupDraft(draft);
    expect(errors.some((error) => /name up to 120/.test(error))).toBe(true);
    expect(errors.some((error) => /at least one enabled registered business/.test(error))).toBe(true);
  });

  it('blocks a disabled business and an unreadable catalog', () => {
    const draft = readyDraft();
    draft.members[0]!.enabled = false;
    draft.members[0]!.catalog = null;
    const errors = validateProfileGroupDraft(draft);
    expect(errors.some((error) => /not currently enabled/.test(error))).toBe(true);
    expect(errors.some((error) => /no selected-version function catalog/.test(error))).toBe(true);
  });

  it('blocks a missing required profile setting and a missing connector slot', () => {
    const draft = readyDraft();
    const key = profileGroupFunctionDraftKey('document-core', '1.0.0', 'extract.invoice');
    draft.functionDrafts[key] = emptyProfileGroupFunctionDraft();
    const errors = validateProfileGroupDraft(draft);
    expect(errors.some((error) => /needs profile setting documentType/.test(error))).toBe(true);
    expect(errors.some((error) => /needs connector slot reasoning/.test(error))).toBe(true);
  });

  it('refuses credential-shaped request defaults', () => {
    const draft = readyDraft();
    const key = profileGroupFunctionDraftKey('document-core', '1.0.0', 'extract.invoice');
    draft.functionDrafts[key] = {
      ...draft.functionDrafts[key]!,
      requestDefaults: { api_key: { value: 'sk-live-secret' } },
    };
    const errors = validateProfileGroupDraft(draft);
    expect(errors.some((error) => /looks like a credential/.test(error))).toBe(true);
  });

  it('recognises secret-like parameter names narrowly enough to allow normal fields', () => {
    expect(secretLikeParameterKey('apiKey')).toBe(true);
    expect(secretLikeParameterKey('openai_token')).toBe(true);
    expect(secretLikeParameterKey('client_secret')).toBe(true);
    expect(secretLikeParameterKey('documentType')).toBe(false);
    expect(secretLikeParameterKey('language')).toBe(false);
    expect(secretLikeParameterKey('tokenizer')).toBe(false);
  });
});

describe('PC-08 profile group V2 state: authority and errors', () => {
  it('allows writes only for a converted group', () => {
    expect(profileGroupWritesAllowed(profileGroupDraftFromRead(groupFixture()))).toBe(true);
    expect(profileGroupWritesAllowed(profileGroupDraftFromRead(groupFixture({ authAuthority: 'CHILD_PROJECTION' })))).toBe(false);
    expect(profileGroupWritesAllowed(null)).toBe(false);
  });

  it('maps every documented problem code to a distinct recovery', () => {
    const cases = [
      ['PROFILE_GROUP_V2_REQUIRED', 'conversion_required'],
      ['PROFILE_CHANGED', 'reload'],
      ['PROFILE_GROUP_UNAUTHORIZED', 'select_granted_key'],
      ['REVISION_CONFLICT', 'reload'],
      ['PRECONDITION_REQUIRED', 'reload'],
      ['PRECONDITION_FAILED', 'reload'],
      ['STATE_CONFLICT', 'review'],
      ['INVALID_SCHEMA', 'fix_input'],
      ['PERMISSION_DENIED', 'review'],
    ] as const;
    for (const [code, recovery] of cases) {
      expect(resolveProfileGroupV2Error({ status: 409, code }).recovery).toBe(recovery);
    }
    expect(resolveProfileGroupV2Error({ status: 418, code: undefined }).kind).toBe('unknown');
    expect(isProfileGroupRevisionConflict(409, 'REVISION_CONFLICT')).toBe(true);
    expect(isProfileGroupRevisionConflict(409, 'PRECONDITION_FAILED')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Wave3-F4 — workflow revision pin (catalog metadata + draft state)   */
/* ------------------------------------------------------------------ */

const WORKFLOW = 'review';
const WORKFLOW_BUSINESS = 'example-review';
const WORKFLOW_VERSION = '3.0.0';

function workflowPolicy() {
  return {
    enabled: true,
    parameters: {},
    jobPriority: 'MEDIUM' as const,
    allowedFileExtensions: '',
    fileUrlAuthConfigured: false,
    allowedOrigins: [] as string[],
    connectionsOverride: [] as Array<{ slug: string }>,
  };
}

/** A group read whose only function is a manifest WORKFLOW action. */
function workflowGroupFixture(storedRevision?: number): ProfileGroupV2 {
  return {
    ...groupFixture(),
    businesses: [{
      businessId: WORKFLOW_BUSINESS,
      businessVersion: WORKFLOW_VERSION,
      manifestDigest: DIGEST,
      functions: [{
        kind: 'workflow',
        functionId: WORKFLOW,
        action: WORKFLOW,
        manifestDigest: DIGEST,
        childProfileId: CHILD,
        childRevision: 2,
        enabled: true,
        policy: workflowPolicy(),
        requestDefaults: {},
        connectorBindings: {},
        ...(storedRevision !== undefined ? { workflowRevision: storedRevision } : {}),
      }],
    }],
    apiKeyGrants: [{ apiKeyId: KEY, prefix: 'du_live_abc123', status: 'ACTIVE', grantedAt: NOW }],
  };
}

/** The tenant-scoped active revision the catalog may expose (Wave3-F4). */
function workflowCatalog(activeRevision?: number): ProfileGroupFunctionCatalog {
  return {
    businessId: WORKFLOW_BUSINESS,
    businessVersion: WORKFLOW_VERSION,
    manifestDigest: DIGEST,
    businessEnabled: true,
    functions: [{
      kind: 'workflow',
      functionId: WORKFLOW,
      action: WORKFLOW,
      manifestDigest: DIGEST,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object', properties: {} },
      available: true,
      connectorSlots: [],
      ...(activeRevision !== undefined ? { workflowRevision: activeRevision } : {}),
    }],
  };
}

function workflowDraft(options: { storedRevision?: number; catalogRevision?: number }): {
  draft: ProfileGroupEditorDraft;
  draftKey: string;
} {
  const parsed = parseProfileGroup(workflowGroupFixture(options.storedRevision));
  if (!parsed) throw new Error('workflow group fixture is not contract-valid');
  const draft = profileGroupDraftFromRead(parsed);
  draft.members = draft.members.map((member) => ({
    ...member,
    enabled: true,
    lifecycleRevision: 3,
    catalog: workflowCatalog(options.catalogRevision),
    catalogLoading: false,
    catalogProblem: null,
    versions: [WORKFLOW_VERSION],
  }));
  return {
    draft,
    draftKey: profileGroupFunctionDraftKey(WORKFLOW_BUSINESS, WORKFLOW_VERSION, WORKFLOW),
  };
}

describe('Wave3-F4: workflow revision pin in catalog and group state', () => {
  it('preserves the stored pin through read and an unrelated value edit', () => {
    const { draft, draftKey } = workflowDraft({ storedRevision: 3 });
    const config = draft.functionDrafts[draftKey]!;
    expect(config.workflowRevision).toBe(3);

    // Editing a value (the PC-R06 path) must not drop the pin.
    config.parameters = setParameterValue(config.parameters, 'tone', 'formal');
    expect(draft.functionDrafts[draftKey]?.workflowRevision).toBe(3);

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    expect(ProfileGroupV2SaveSchema.safeParse(body).success).toBe(true);
    expect(body.businesses[0]?.functions[0]?.workflowRevision).toBe(3);
  });

  it('falls back to the catalog active revision when the binding has no pin', () => {
    const { draft, draftKey } = workflowDraft({ catalogRevision: 5 });
    expect(draft.functionDrafts[draftKey]?.workflowRevision).toBeNull();
    expect(validateProfileGroupDraft(draft)).toEqual([]);

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    expect(ProfileGroupV2SaveSchema.safeParse(body).success).toBe(true);
    expect(body.businesses[0]?.functions[0]?.workflowRevision).toBe(5);
  });

  it('omits an unresolvable revision instead of fabricating one (contract refuses the body)', () => {
    const { draft } = workflowDraft({});
    expect(validateProfileGroupDraft(draft)).toEqual([]);
    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const fn = body.businesses[0]?.functions[0];
    expect(fn && 'workflowRevision' in fn).toBe(false);
    // The frozen contract still demands the pin; omitting it surfaces there
    // rather than inventing a revision the workflow engine could not resolve.
    expect(ProfileGroupV2SaveSchema.safeParse(body).success).toBe(false);
  });

  it('an explicit draft pin wins over the catalog default', () => {
    const { draft, draftKey } = workflowDraft({ storedRevision: 2, catalogRevision: 5 });
    const config = draft.functionDrafts[draftKey]!;
    expect(config.workflowRevision).toBe(2);
    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    expect(body.businesses[0]?.functions[0]?.workflowRevision).toBe(2);
  });

  it('endpoint selectors never carry a workflowRevision, even from a stale draft', () => {
    const draft = readyDraft();
    const draftKey = profileGroupFunctionDraftKey('document-core', '1.0.0', 'extract.invoice');
    draft.functionDrafts[draftKey] = { ...draft.functionDrafts[draftKey]!, workflowRevision: 9 };
    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const fn = body.businesses[0]?.functions[0];
    expect(fn && 'workflowRevision' in fn).toBe(false);
    expect(ProfileGroupV2SaveSchema.safeParse(body).success).toBe(true);
  });

  it('the catalog parser preserves workflowRevision and leaves it absent otherwise', () => {
    expect(parseProfileGroupFunctionCatalog(workflowCatalog(4))?.functions[0]?.workflowRevision).toBe(4);
    expect(parseProfileGroupFunctionCatalog(workflowCatalog())?.functions[0]?.workflowRevision).toBeUndefined();
  });

  it('the empty draft starts with no workflow revision', () => {
    expect(emptyProfileGroupFunctionDraft().workflowRevision).toBeNull();
  });
});

function workflowManifest(): BusinessManifest {
  return BusinessManifestSchema.parse({
    contractVersion: '1',
    businessId: WORKFLOW_BUSINESS,
    version: WORKFLOW_VERSION,
    displayName: 'Example review',
    description: '',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    runtime: { wireVersion: '1', handlerKinds: ['workflow'] },
    capabilities: { cancel: true, resume: true, parallel: false },
    actions: [{
      name: WORKFLOW,
      displayName: 'Review',
      description: '',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      outputSchema: { type: 'object', properties: {} },
      profileSchema: { type: 'object', properties: {} },
      connectorSlots: [],
      artifactPolicy: { minFiles: 1, maxFiles: 1 },
      capabilities: { cancel: false, resume: false },
      defaultLimits: {},
    }],
  });
}

/** A db that answers only the two catalog reads and records every statement. */
function catalogDb(activeRevision?: number): {
  db: Pick<Db, 'query'>;
  queries: Array<{ sql: string; params?: unknown[] }>;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query = async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> => {
    queries.push({ sql, params });
    if (sql.includes('legacy_workflow_schemas')) {
      const rows = activeRevision === undefined
        ? []
        : [{ slug: WORKFLOW, revision: String(activeRevision) }];
      return { rows: rows as unknown as T[], rowCount: rows.length } as QueryResult<T>;
    }
    if (sql.includes('FROM business_versions')) {
      return {
        rows: [{
          business_id: WORKFLOW_BUSINESS,
          business_version: WORKFLOW_VERSION,
          manifest: workflowManifest(),
          digest: DIGEST,
          business_enabled: true,
        }] as unknown as T[],
        rowCount: 1,
      } as QueryResult<T>;
    }
    throw new Error(`unexpected catalog SQL: ${sql}`);
  };
  return { db: { query } as unknown as Pick<Db, 'query'>, queries };
}

describe('Wave3-F4: catalog exposes the tenant active workflow revision', () => {
  it('pins a manifest workflow action with the tenant-scoped active revision', async () => {
    const { db, queries } = catalogDb(7);
    const catalog = await getBusinessFunctionCatalog(db, WORKFLOW_BUSINESS, WORKFLOW_VERSION, { tenantId: TENANT });
    const fn = catalog.functions[0]!;
    expect(fn.kind).toBe('workflow');
    expect(fn.workflowRevision).toBe(7);
    const revisionQuery = queries.find((entry) => entry.sql.includes('legacy_workflow_schemas'));
    expect(revisionQuery?.params).toEqual([TENANT, [WORKFLOW]]);
    // The emitted descriptor is what the route actually returns.
    expect(ProfileGroupFunctionCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('never invents a revision when the tenant has no active schema row', async () => {
    const { db } = catalogDb();
    const catalog = await getBusinessFunctionCatalog(db, WORKFLOW_BUSINESS, WORKFLOW_VERSION, { tenantId: TENANT });
    expect(catalog.functions[0]?.workflowRevision).toBeUndefined();
    expect(catalog.functions[0] !== undefined && 'workflowRevision' in catalog.functions[0]).toBe(false);
  });

  it('ignores a registry value that is not a positive safe integer', async () => {
    const { db } = catalogDb(0);
    const catalog = await getBusinessFunctionCatalog(db, WORKFLOW_BUSINESS, WORKFLOW_VERSION, { tenantId: TENANT });
    expect(catalog.functions[0]?.workflowRevision).toBeUndefined();
  });

  it('stays platform-scoped and revision-free when the caller supplies no tenant', async () => {
    const { db, queries } = catalogDb(7);
    const catalog = await getBusinessFunctionCatalog(db, WORKFLOW_BUSINESS, WORKFLOW_VERSION);
    expect(catalog.functions[0]?.workflowRevision).toBeUndefined();
    expect(queries.some((entry) => entry.sql.includes('legacy_workflow_schemas'))).toBe(false);
  });
});

describe('Wave3-F4: effective workflow revision is what display and save agree on', () => {
  it('a draft pin wins over the catalog default, and the save body carries that exact value', () => {
    const { draft, draftKey } = workflowDraft({ storedRevision: 2, catalogRevision: 5 });
    const config = draft.functionDrafts[draftKey]!;
    const descriptor = draft.members[0]!.catalog!.functions[0]!;
    expect(resolveEffectiveWorkflowRevision(config, descriptor)).toBe(2);

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    expect(body.businesses[0]?.functions[0]?.workflowRevision).toBe(2);
  });

  it('falls back to the catalog active revision when the draft stores no pin', () => {
    const { draft, draftKey } = workflowDraft({ catalogRevision: 5 });
    const config = draft.functionDrafts[draftKey]!;
    const descriptor = draft.members[0]!.catalog!.functions[0]!;
    expect(resolveEffectiveWorkflowRevision(config, descriptor)).toBe(5);
  });

  it('never resolves a revision for an endpoint, even from a stale draft value', () => {
    expect(resolveEffectiveWorkflowRevision({ workflowRevision: 9 }, { kind: 'endpoint', workflowRevision: 5 }))
      .toBeNull();
  });

  it('normalises unusable pins exactly the way the save contract will', () => {
    expect(resolveEffectiveWorkflowRevision({ workflowRevision: null }, { kind: 'workflow' })).toBeNull();
    expect(resolveEffectiveWorkflowRevision({ workflowRevision: undefined }, { kind: 'workflow', workflowRevision: 7 })).toBe(7);
    // An explicitly unusable pin is NOT silently replaced by the catalog default:
    // the body omits it, so the display must read as unresolved too.
    expect(resolveEffectiveWorkflowRevision({ workflowRevision: 0 }, { kind: 'workflow', workflowRevision: 5 })).toBeNull();
    expect(resolveEffectiveWorkflowRevision({ workflowRevision: Number.NaN }, { kind: 'workflow', workflowRevision: 5 })).toBeNull();
    expect(resolveEffectiveWorkflowRevision({ workflowRevision: 2.5 }, { kind: 'workflow' })).toBeNull();
  });

  it('the editor renders the resolved pin instead of the raw catalog value', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../apps/admin-web/src/features/profiles/profile-group-editor.tsx'),
      'utf8',
    );
    expect(source).toContain('resolveEffectiveWorkflowRevision(config, descriptor)');
    expect(source).not.toContain("{descriptor.workflowRevision ?? '—'}");
    // A differing catalog value is reported beside the effective pin, never in
    // its place.
    expect(source).toContain('(catalog: ${catalogWorkflowRevision})');
  });
});