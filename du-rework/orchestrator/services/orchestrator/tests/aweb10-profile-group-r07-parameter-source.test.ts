/**
 * PC-R07-UI — the editor renders each parameter only in its declared source.
 *
 * Defect under regression: the configuration pane rendered every
 * `profileSchema` property under Profile settings and every `inputSchema`
 * property under Request defaults, ignoring the manifest's
 * `parameterResolution` map. On an opt-in manifest such as example-review v3,
 * `enableReasoning` is declared as `requestDefaults` but was also editable as a
 * profile setting — a save wrote it into `policy.parameters`, which the resolver
 * ignores. On a v1 manifest (no capability) the UI still offered request-default
 * controls that are inert under v1 merge semantics.
 *
 * These cases pin the partition + save-boundary behaviour, and a source guard
 * proves the editor wires them (the app has no Jest runner).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProfileGroupV2SaveSchema, type ProfileGroupFunction } from '@du/contracts';
import {
  buildProfileGroupSaveBody,
  emptyProfileGroupFunctionDraft,
  filterParameterEntriesForSource,
  misplacedParameterEntries,
  parameterSourceOf,
  parseProfileGroupFunctionCatalog,
  partitionParameterSchemas,
  profileGroupFunctionDraftKey,
  profileGroupMemberDraftKey,
  requestDefaultsCapabilityNotice,
  requestDefaultsEmptyMessage,
  validateProfileGroupDraft,
  type ProfileGroupEditorDraft,
  type ProfileGroupFunctionDraft,
} from '../../../apps/admin-web/src/features/profiles/profile-group-state';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '33333333-3333-4333-8333-333333333333';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const FUNCTION_ID = 'review';
const BUSINESS = 'example-review';
const VERSION = '3.0.0';

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');
const EDITOR_PATH = resolve(WORKSPACE_ROOT, 'orchestrator/apps/admin-web/src/features/profiles/profile-group-editor.tsx');

/**
 * Mirrors `businesses/example-review/src/manifest.ts:126-161` (v3): the action
 * declares `enableReasoning: requestDefaults` and both profile-only knobs as
 * `profileSettings`, while `enableReasoning` intentionally overlaps both schemas.
 */
function optInDescriptor(overrides: Partial<ProfileGroupFunction> = {}): ProfileGroupFunction {
  return {
    kind: 'workflow',
    functionId: FUNCTION_ID,
    action: FUNCTION_ID,
    manifestDigest: DIGEST,
    inputSchema: {
      type: 'object',
      required: ['text', 'enableReasoning'],
      properties: {
        text: { type: 'string' },
        enableReasoning: { type: 'boolean', default: true },
      },
    },
    outputSchema: { type: 'object', properties: {} },
    profileSchema: {
      type: 'object',
      required: ['enableReasoning', 'maxParallelItems'],
      properties: {
        enableReasoning: { type: 'boolean', default: true },
        maxParallelItems: { type: 'integer', title: 'Max parallel items' },
        autoApprovePassed: { type: 'boolean', title: 'Auto approve passed' },
      },
    },
    parameterResolution: {
      enableReasoning: 'requestDefaults',
      maxParallelItems: 'profileSettings',
      autoApprovePassed: 'profileSettings',
    },
    available: true,
    connectorSlots: [],
    ...overrides,
  };
}

/** The same action with no `parameterResolution` capability (v1/v2 manifests). */
function legacyDescriptor(): ProfileGroupFunction {
  const descriptor = optInDescriptor();
  const { parameterResolution: _resolution, ...rest } = descriptor;
  return rest;
}

function draftWith(
  descriptor: ProfileGroupFunction,
  config: Partial<ProfileGroupFunctionDraft>,
): { draft: ProfileGroupEditorDraft; functionKey: string } {
  const memberKey = profileGroupMemberDraftKey(BUSINESS, VERSION);
  const functionKey = profileGroupFunctionDraftKey(BUSINESS, VERSION, descriptor.functionId);
  const draft: ProfileGroupEditorDraft = {
    groupId: GROUP,
    tenantId: TENANT,
    name: 'Review operations',
    authMode: 'API_KEY',
    revision: 4,
    accessVersion: 7,
    authAuthority: 'GROUP_GRANT',
    members: [{
      businessId: BUSINESS,
      businessVersion: VERSION,
      versions: [VERSION],
      enabled: true,
      lifecycleRevision: 3,
      catalog: {
        businessId: BUSINESS,
        businessVersion: VERSION,
        manifestDigest: DIGEST,
        businessEnabled: true,
        functions: [descriptor],
      },
      catalogLoading: false,
      catalogProblem: null,
    }],
    selectedFunctionsByVersion: { [memberKey]: [descriptor.functionId] },
    functionDrafts: {
      [functionKey]: { ...emptyProfileGroupFunctionDraft(), ...config },
    },
  };
  return { draft, functionKey };
}

function schemaPropertyNames(schema: Record<string, unknown> | null): string[] {
  if (schema === null) return [];
  const properties = schema['properties'];
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>)
    : [];
}

describe('PC-R07-UI: declared source partition', () => {
  it('opt-in manifest: enableReasoning is requestDefaults and never a profile setting', () => {
    const descriptor = optInDescriptor();
    const partition = partitionParameterSchemas(descriptor);

    expect(partition.declared).toBe(true);
    expect(partition.requestDefaultNames).toEqual(['enableReasoning']);
    expect(partition.profileSettingNames).toEqual(['maxParallelItems', 'autoApprovePassed']);
    expect(schemaPropertyNames(partition.profileSettingsSchema)).not.toContain('enableReasoning');
    expect(schemaPropertyNames(partition.requestDefaultsSchema)).toEqual(['enableReasoning']);
    // A client-input property is not a request default and is not rendered anywhere.
    expect(schemaPropertyNames(partition.requestDefaultsSchema)).not.toContain('text');
    expect(schemaPropertyNames(partition.profileSettingsSchema)).not.toContain('text');
    // `required` is filtered with the properties, so a filtered-out property is
    // never demanded as a profile setting.
    expect(partition.profileSettingsSchema['required']).toEqual(['maxParallelItems']);
    expect(partition.requestDefaultsSchema?.['required']).toEqual(['enableReasoning']);
    // Schema-level defaults for a requestDefaults property are not injected into
    // the profile settings schema either.
    expect(partition.requestDefaultsSchema?.['properties']).not.toHaveProperty('maxParallelItems');
  });

  it('legacy manifest: profile settings keeps the whole schema and request defaults are unavailable', () => {
    const descriptor = legacyDescriptor();
    expect(descriptor.parameterResolution).toBeUndefined();
    const partition = partitionParameterSchemas(descriptor);

    expect(partition.declared).toBe(false);
    expect(partition.profileSettingNames).toEqual(['enableReasoning', 'maxParallelItems', 'autoApprovePassed']);
    expect(partition.requestDefaultsSchema).toBeNull();
    expect(partition.requestDefaultNames).toEqual([]);
    expect(requestDefaultsCapabilityNotice(partition)).toMatch(/parameterResolution/);
    expect(requestDefaultsEmptyMessage(partition)).toBeNull();
    expect(requestDefaultsCapabilityNotice(partitionParameterSchemas(optInDescriptor()))).toBeNull();
  });

  it('opt-in manifest with no declared requestDefaults renders the explicit empty message', () => {
    const descriptor = optInDescriptor({ parameterResolution: { maxParallelItems: 'profileSettings' } });
    const partition = partitionParameterSchemas(descriptor);
    expect(partition.declared).toBe(true);
    expect(partition.requestDefaultNames).toEqual([]);
    expect(requestDefaultsEmptyMessage(partition)).toMatch(/declares no request defaults/);
    expect(requestDefaultsCapabilityNotice(partition)).toBeNull();
    expect(partition.profileSettingNames).toContain('enableReasoning');
  });

  it('undeclared properties default to profileSettings; a declared map is authoritative', () => {
    const descriptor = optInDescriptor();
    expect(parameterSourceOf(descriptor.parameterResolution, 'enableReasoning')).toBe('requestDefaults');
    expect(parameterSourceOf(descriptor.parameterResolution, 'maxParallelItems')).toBe('profileSettings');
    expect(parameterSourceOf(descriptor.parameterResolution, 'notMapped')).toBe('profileSettings');
    expect(parameterSourceOf(undefined, 'enableReasoning')).toBe('profileSettings');
  });

  it('the catalog parser preserves the declared map (discovery exposes the capability)', () => {
    const catalog = {
      businessId: BUSINESS,
      businessVersion: VERSION,
      manifestDigest: DIGEST,
      businessEnabled: true,
      functions: [optInDescriptor()],
    };
    const parsed = parseProfileGroupFunctionCatalog(catalog);
    expect(parsed?.functions[0]?.parameterResolution).toEqual({
      enableReasoning: 'requestDefaults',
      maxParallelItems: 'profileSettings',
      autoApprovePassed: 'profileSettings',
    });
    const legacy = { ...catalog, functions: [legacyDescriptor()] };
    expect(parseProfileGroupFunctionCatalog(legacy)?.functions[0]?.parameterResolution).toBeUndefined();
  });
});

describe('PC-R07-UI: save boundary keeps each parameter in its declared source', () => {
  it('drops wrong-source entries from the payload instead of re-saving them', () => {
    // The save body is validated by `ProfileGroupV2SaveSchema`. A manifest
    // WORKFLOW action needs an explicit `workflowRevision` in that contract,
    // which the catalog does not currently expose (recorded as an adjacent,
    // out-of-scope finding). Source partitioning is kind-independent, so this
    // case pins it on the endpoint form of the same action.
    const { draft } = draftWith(optInDescriptor({ kind: 'endpoint', endpointSlug: FUNCTION_ID }), {
      parameters: {
        enableReasoning: { value: true },              // stored by the old defect
        maxParallelItems: { value: 4 },
        autoApprovePassed: { value: false },
      },
      requestDefaults: {
        enableReasoning: { value: true, isLocked: true },
        text: { value: 'stale' },                      // no longer a request default
      },
    });

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const parsed = ProfileGroupV2SaveSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const fn = parsed.data.businesses[0]?.functions[0];
    expect(Object.keys(fn?.policy.parameters ?? {})).toEqual(['maxParallelItems', 'autoApprovePassed']);
    expect(fn?.policy.parameters).not.toHaveProperty('enableReasoning');
    expect(Object.keys(fn?.requestDefaults ?? {})).toEqual(['enableReasoning']);
    // PC-R06 interplay: the value moved source but its lock metadata survived.
    expect(fn?.requestDefaults?.['enableReasoning']).toEqual({ value: true, isLocked: true });
    expect(fn?.requestDefaults).not.toHaveProperty('text');
  });

  it('legacy manifest keeps stored entries untouched (inert values are not destroyed)', () => {
    const { draft } = draftWith(legacyDescriptor(), {
      parameters: {
        enableReasoning: { value: true },
        maxParallelItems: { value: 4 },
      },
      requestDefaults: {
        legacyDefault: { value: 'kept', isLocked: true },
      },
    });

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const fn = body.businesses[0]?.functions[0];
    expect(fn?.policy.parameters).toHaveProperty('enableReasoning');
    expect(fn?.policy.parameters?.['maxParallelItems']).toEqual({ value: 4 });
    expect(fn?.requestDefaults).toEqual({ legacyDefault: { value: 'kept', isLocked: true } });
  });

  it('filter/misplacement helpers report both directions and never guess for v1', () => {
    const descriptor = optInDescriptor();
    const parameters = { enableReasoning: { value: true }, maxParallelItems: { value: 4 } };
    const requestDefaults = { enableReasoning: { value: true }, text: { value: 'x' } };

    expect(misplacedParameterEntries(descriptor.parameterResolution, parameters, requestDefaults))
      .toEqual({ profileSettings: ['enableReasoning'], requestDefaults: ['text'] });
    expect(misplacedParameterEntries(undefined, parameters, requestDefaults))
      .toEqual({ profileSettings: [], requestDefaults: [] });

    const keptProfile = filterParameterEntriesForSource(parameters, descriptor.parameterResolution, 'profileSettings');
    expect(Object.keys(keptProfile.kept)).toEqual(['maxParallelItems']);
    expect(keptProfile.dropped).toEqual(['enableReasoning']);
    const legacy = filterParameterEntriesForSource(parameters, undefined, 'requestDefaults');
    expect(legacy.kept).toBe(parameters);
    expect(legacy.dropped).toEqual([]);
  });
});

describe('PC-R07-UI: validation and rendering follow the declared source', () => {
  it('a required requestDefaults property is not demanded as a profile setting', () => {
    // profileSchema.required names enableReasoning; the declared source is
    // requestDefaults, so only maxParallelItems may be required here.
    const { draft } = draftWith(optInDescriptor(), {
      parameters: { maxParallelItems: { value: 4 } },
      requestDefaults: {},
    });
    expect(validateProfileGroupDraft(draft)).toEqual([]);
  });

  it('a genuinely missing profile setting still blocks the save', () => {
    const { draft } = draftWith(optInDescriptor(), {
      parameters: {},
      requestDefaults: {},
    });
    const errors = validateProfileGroupDraft(draft);
    expect(errors.some((error) => /needs profile setting maxParallelItems/.test(error))).toBe(true);
    expect(errors.some((error) => /needs profile setting enableReasoning/.test(error))).toBe(false);
  });

  it('the editor wires the partition instead of rendering both raw schemas', () => {
    const source = readFileSync(EDITOR_PATH, 'utf8');
    expect(source).toContain('partitionParameterSchemas({');
    expect(source).toContain('schema={partition.profileSettingsSchema}');
    expect(source).toContain('schema={requestDefaultsSchema}');
    expect(source).toContain('requestDefaultsCapabilityNotice(partition)');
    expect(source).toContain('requestDefaultsEmptyMessage(partition)');
    expect(source).toContain('misplacedParameterEntries(');
    // The pre-fix wiring rendered the unfiltered inputSchema as request defaults.
    expect(source).not.toContain('schema={(descriptor.inputSchema ?? {})');
  });
});
