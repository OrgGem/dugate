/**
 * PC-R06 — editing a request default must preserve its lock metadata.
 *
 * Defect under regression: `updateRequestDefault` replaced the whole entry with
 * `{ value }`, dropping `isLocked`. Because the server resolves the effective
 * lock as `explicit isLocked ?? schema.defaultLocked ?? false`, dropping an
 * explicit `true` silently unlocks a field (unauthorized client override), and
 * dropping an explicit `false` silently re-locks a field the operator had
 * deliberately opened.
 *
 * These cases pin the state boundary the editor now uses, plus a source guard
 * that the editor really calls the preserving helper (the app has no Jest
 * runner, and a pure-state test alone cannot catch a future `{ value }`
 * reintroduction in the component).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProfileGroupV2SaveSchema, type ProfileGroupV2, type ProfileGroupFunctionCatalog } from '@du/contracts';
import {
  buildProfileGroupSaveBody,
  effectiveParameterLock,
  emptyProfileGroupFunctionDraft,
  parseProfileGroup,
  profileGroupDraftFromRead,
  profileGroupFunctionDraftKey,
  schemaDeclaredLock,
  setParameterValue,
  withParameterValue,
  type ProfileGroupEditorDraft,
} from '../../../apps/admin-web/src/features/profiles/profile-group-state';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '33333333-3333-4333-8333-333333333333';
const CHILD = '44444444-4444-4444-8444-444444444444';
const KEY = '22222222-2222-4222-8222-222222222222';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-10-05T00:00:00.000Z';
const FUNCTION_ID = 'extract.invoice';

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');
const EDITOR_PATH = resolve(WORKSPACE_ROOT, 'orchestrator/apps/admin-web/src/features/profiles/profile-group-editor.tsx');
const FIELDS_PATH = resolve(WORKSPACE_ROOT, 'orchestrator/apps/admin-web/src/features/profiles/profile-group-schema-fields.tsx');

/** The schema mapping: `defaultLocked` is the schema-derived lock source. */
function inputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      lockedDefault: { type: 'string', title: 'Locked default' },
      unlockedDefault: { type: 'string', title: 'Unlocked default' },
      schemaLocked: { type: 'string', title: 'Schema-locked', defaultLocked: true },
      explicitlyUnlocked: { type: 'string', title: 'Explicitly unlocked', defaultLocked: true },
      nullableDefault: { type: 'string', title: 'Nullable default' },
      falseDefault: { type: 'boolean', title: 'False default' },
      zeroDefault: { type: 'integer', title: 'Zero default' },
    },
  };
}

function readPolicy() {
  return {
    enabled: true,
    parameters: { documentType: { value: 'invoice' } },
    jobPriority: 'MEDIUM' as const,
    allowedFileExtensions: '',
    fileUrlAuthConfigured: false,
    allowedOrigins: [] as string[],
    connectionsOverride: [] as Array<{ slug: string }>,
  };
}

function groupFixture(): ProfileGroupV2 {
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
        functionId: FUNCTION_ID,
        action: 'extract',
        endpointSlug: FUNCTION_ID,
        manifestDigest: DIGEST,
        childProfileId: CHILD,
        childRevision: 2,
        enabled: true,
        policy: readPolicy(),
        requestDefaults: {
          lockedDefault: { value: 'locked-value', isLocked: true },
          unlockedDefault: { value: 'unlocked-value' },
          explicitlyUnlocked: { value: 'free', isLocked: false },
          nullableDefault: { value: null },
          falseDefault: { value: false },
          zeroDefault: { value: 0 },
        },
        connectorBindings: {},
      }],
    }],
    apiKeyGrants: [{ apiKeyId: KEY, prefix: 'du_live_abc123', status: 'ACTIVE', grantedAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
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
      functionId: FUNCTION_ID,
      action: 'extract',
      endpointSlug: FUNCTION_ID,
      manifestDigest: DIGEST,
      inputSchema: inputSchema(),
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object', properties: { documentType: { type: 'string', title: 'Document type' } } },
      available: true,
      connectorSlots: [],
    }],
  };
}

function draftFromRead(): { draft: ProfileGroupEditorDraft; draftKey: string } {
  const group = parseProfileGroup(groupFixture());
  if (!group) throw new Error('fixture is not a valid ProfileGroupV2');
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
  return { draft, draftKey: profileGroupFunctionDraftKey('document-core', '1.0.0', FUNCTION_ID) };
}

function defaults(draft: ProfileGroupEditorDraft, draftKey: string) {
  const functionDraft = draft.functionDrafts[draftKey];
  if (!functionDraft) throw new Error('function draft missing');
  return functionDraft.requestDefaults;
}

describe('PC-R06: request-default lock metadata survives load and edit', () => {
  it('loads every entry byte-for-byte: explicit true, explicit false, absent, null, false, zero', () => {
    const { draft, draftKey } = draftFromRead();
    const entries = defaults(draft, draftKey);

    expect(entries['lockedDefault']).toEqual({ value: 'locked-value', isLocked: true });
    expect(entries['unlockedDefault']).toEqual({ value: 'unlocked-value' });
    expect(Object.prototype.hasOwnProperty.call(entries['unlockedDefault'], 'isLocked')).toBe(false);
    expect(entries['explicitlyUnlocked']).toEqual({ value: 'free', isLocked: false });
    expect(entries['nullableDefault']).toEqual({ value: null });
    expect(entries['falseDefault']).toEqual({ value: false });
    expect(entries['zeroDefault']).toEqual({ value: 0 });
  });

  it('editing ONLY the value of a locked default keeps isLocked true', () => {
    const { draft, draftKey } = draftFromRead();
    const config = draft.functionDrafts[draftKey]!;
    config.requestDefaults = setParameterValue(config.requestDefaults, 'lockedDefault', 'rotated-value');

    expect(config.requestDefaults['lockedDefault']).toEqual({ value: 'rotated-value', isLocked: true });
    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const parsed = ProfileGroupV2SaveSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.businesses[0]?.functions[0]?.requestDefaults?.['lockedDefault'])
      .toEqual({ value: 'rotated-value', isLocked: true });
  });

  it('editing an entry with no explicit lock never writes an explicit false', () => {
    const { draft, draftKey } = draftFromRead();
    const config = draft.functionDrafts[draftKey]!;
    config.requestDefaults = setParameterValue(config.requestDefaults, 'unlockedDefault', 'edited');

    const entry = config.requestDefaults['unlockedDefault']!;
    expect(Object.prototype.hasOwnProperty.call(entry, 'isLocked')).toBe(false);
    // The schema-derived lock therefore still applies after the edit.
    expect(schemaDeclaredLock(inputSchema(), 'schemaLocked')).toBe(true);
    const schemaLockedAfterEdit = setParameterValue(config.requestDefaults, 'schemaLocked', 'filled');
    expect(Object.prototype.hasOwnProperty.call(schemaLockedAfterEdit['schemaLocked'], 'isLocked')).toBe(false);
    expect(effectiveParameterLock(schemaLockedAfterEdit['schemaLocked'], true)).toBe(true);

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const parsed = ProfileGroupV2SaveSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.businesses[0]?.functions[0]?.requestDefaults?.['unlockedDefault'])
      .toEqual({ value: 'edited' });
  });

  it('editing an explicit false keeps the deliberate unlock (overrides schema defaultLocked)', () => {
    const { draft, draftKey } = draftFromRead();
    const config = draft.functionDrafts[draftKey]!;
    config.requestDefaults = setParameterValue(config.requestDefaults, 'explicitlyUnlocked', 'still-free');

    const entry = config.requestDefaults['explicitlyUnlocked']!;
    expect(entry).toEqual({ value: 'still-free', isLocked: false });
    expect(effectiveParameterLock(entry, schemaDeclaredLock(inputSchema(), 'explicitlyUnlocked'))).toBe(false);

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const parsed = ProfileGroupV2SaveSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.businesses[0]?.functions[0]?.requestDefaults?.['explicitlyUnlocked'])
      .toEqual({ value: 'still-free', isLocked: false });
  });

  it('preserves explicit null, false and zero through an edit of another field and the save body', () => {
    const { draft, draftKey } = draftFromRead();
    const config = draft.functionDrafts[draftKey]!;
    config.requestDefaults = setParameterValue(config.requestDefaults, 'lockedDefault', 'edited-again');

    const body = buildProfileGroupSaveBody(draft, TENANT, draft.revision);
    const defaultsOut = body.businesses[0]?.functions[0]?.requestDefaults;
    expect(defaultsOut?.['nullableDefault']).toEqual({ value: null });
    expect(defaultsOut?.['falseDefault']).toEqual({ value: false });
    expect(defaultsOut?.['zeroDefault']).toEqual({ value: 0 });

    const parsed = ProfileGroupV2SaveSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const roundTripped = parsed.data.businesses[0]?.functions[0]?.requestDefaults;
    expect(roundTripped?.['nullableDefault']?.value).toBeNull();
    expect(roundTripped?.['falseDefault']?.value).toBe(false);
    expect(roundTripped?.['zeroDefault']?.value).toBe(0);
  });

  it('re-writing null/false/0 as the value keeps them as values (truthiness never decides)', () => {
    expect(withParameterValue({ value: 'x', isLocked: true }, null)).toEqual({ value: null, isLocked: true });
    expect(withParameterValue({ value: 'x' }, false)).toEqual({ value: false });
    expect(withParameterValue(undefined, 0)).toEqual({ value: 0 });
    expect(Object.prototype.hasOwnProperty.call(withParameterValue(undefined, 0), 'isLocked')).toBe(false);
    expect(withParameterValue({ value: 'x', isLocked: false }, 0)).toEqual({ value: 0, isLocked: false });
  });

  it('effective lock chain matches the server: explicit ?? schema.defaultLocked ?? false', () => {
    expect(effectiveParameterLock({ value: 'x', isLocked: true }, false)).toBe(true);
    expect(effectiveParameterLock({ value: 'x', isLocked: false }, true)).toBe(false);
    expect(effectiveParameterLock({ value: 'x' }, true)).toBe(true);
    expect(effectiveParameterLock({ value: 'x' }, undefined)).toBe(false);
    expect(effectiveParameterLock(undefined, true)).toBe(true);
    expect(effectiveParameterLock(undefined, undefined)).toBe(false);
    expect(schemaDeclaredLock(inputSchema(), 'schemaLocked')).toBe(true);
    expect(schemaDeclaredLock(inputSchema(), 'lockedDefault')).toBeUndefined();
    expect(schemaDeclaredLock({ properties: { p: { defaultLocked: 'yes' } } }, 'p')).toBeUndefined();
  });

  it('the empty draft has no request defaults, so a value edit starts unlocked', () => {
    const empty = emptyProfileGroupFunctionDraft();
    expect(empty.requestDefaults).toEqual({});
  });
});

describe('PC-R06: editor wiring guard', () => {
  const editorSource = readFileSync(EDITOR_PATH, 'utf8');
  const fieldsSource = readFileSync(FIELDS_PATH, 'utf8');

  it('request defaults are edited through the metadata-preserving helper', () => {
    expect(editorSource).toContain('requestDefaults: setParameterValue(current.requestDefaults');
    expect(editorSource).toContain('parameters: setParameterValue(current.parameters');
  });

  it('the defect pattern ({ value } replacement) is gone from both updaters', () => {
    expect(editorSource).not.toContain('requestDefaults: { ...current.requestDefaults, [parameter]: { value } }');
    expect(editorSource).not.toContain('isLocked: current.requestDefaults');
    // The old profile-settings updater also fabricated `false`, re-locking a
    // schema-defaultLocked field on every edit; it must not come back either.
    expect(editorSource).not.toContain('isLocked: current.parameters[parameter]?.isLocked ?? false');
  });

  it('request-default fields expose the effective lock state to the operator', () => {
    expect(editorSource).toContain('lockMeta={(parameter) => ({');
    expect(editorSource).toContain('schemaDeclaredLock(');
    expect(fieldsSource).toContain('parameterLockDisplay');
    expect(fieldsSource).toContain('data-lock-state={lockDisplay}');
  });
});
