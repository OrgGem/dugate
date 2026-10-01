/**
 * Table-driven unit tests for the P6-01 headless Admin view models (W26-O).
 *
 * Scope: pure functions in `src/app/admin/*`. No DB, no HTTP, no framework.
 * Generic fixtures only — nothing hardcodes document-core/example-review
 * actions or slots.
 */

import {
  ALL_NAV_ITEMS,
  AdminRole,
  buildBusinessView,
  buildConnectorConfigView,
  buildConnectorEndpointDisplay,
  buildConnectorListViewState,
  buildConnectorTestResult,
  buildOperationsListView,
  buildProfileFormField,
  buildProfileFormModel,
  businessViewState,
  canRunConnectorTest,
  canSeeNavItem,
  checkProfileRevision,
  coerceWidget,
  connectorTestNeedsAttention,
  diffProfileDraft,
  displayValue,
  emptyState,
  errorState,
  forbiddenState,
  loadingState,
  maskConnectorHost,
  operationHealth,
  readyState,
  rotateSecretActionView,
  sectionForPath,
  validateProfileDraft,
  visibleNavItems,
  type ConnectorConfigView,
  type ConnectorRevisionRow,
  type ConnectorRevisionState,
  type ConnectorTestResultKind,
  type DraftValidationInput,
  type NavItem,
  type OperationWire,
  type ProfileSchemaInput,
  type RotateSecretState,
} from '../src/app/admin/view-models';

describe('navigation visibility (admin/operator/viewer)', () => {
  const cases: Array<{ role: AdminRole; expectedSections: string[] }> = [
    { role: 'viewer', expectedSections: ['businesses', 'operations'] },
    { role: 'operator', expectedSections: ['businesses', 'operations', 'profiles', 'connectors'] },
    { role: 'admin', expectedSections: ['businesses', 'operations', 'profiles', 'connectors', 'grants'] },
  ];

  test.each(cases)('$role sees exactly $expectedSections', ({ role, expectedSections }) => {
    expect(visibleNavItems(role).map((i) => i.section)).toEqual(expectedSections);
  });

  const gateCases: Array<{ role: AdminRole; required: NavItem['requiredRole']; expected: boolean }> = [
    { role: 'viewer', required: 'viewer', expected: true },
    { role: 'viewer', required: 'operator', expected: false },
    { role: 'viewer', required: 'admin', expected: false },
    { role: 'operator', required: 'viewer', expected: true },
    { role: 'operator', required: 'operator', expected: true },
    { role: 'operator', required: 'admin', expected: false },
    { role: 'admin', required: 'viewer', expected: true },
    { role: 'admin', required: 'operator', expected: true },
    { role: 'admin', required: 'admin', expected: true },
  ];

  test.each(gateCases)('$role vs required=$required -> $expected', ({ role, required, expected }) => {
    const item: NavItem = { section: 'grants', label: 'Grants', path: '/admin/grants', requiredRole: required };
    expect(canSeeNavItem(role, item)).toBe(expected);
  });

  test('display gating is monotone: higher roles never see fewer items', () => {
    expect(visibleNavItems('viewer').length).toBeLessThanOrEqual(visibleNavItems('operator').length);
    expect(visibleNavItems('operator').length).toBeLessThanOrEqual(visibleNavItems('admin').length);
  });
});

describe('sectionForPath', () => {
  const cases: Array<{ path: string; expected: string | null }> = [
    { path: '/admin/businesses', expected: 'businesses' },
    { path: '/admin/businesses/biz-1', expected: 'businesses' },
    { path: '/admin/operations', expected: 'operations' },
    { path: '/admin/profiles/x', expected: 'profiles' },
    { path: '/admin/connectors', expected: 'connectors' },
    { path: '/admin/grants', expected: 'grants' },
    { path: '/admin/unknown', expected: null },
    { path: '/', expected: null },
  ];

  test.each(cases)('$path -> $expected', ({ path, expected }) => {
    expect(sectionForPath(path)).toBe(expected);
  });
});

describe('page states', () => {
  test('loading/empty/error/forbidden/ready discriminants', () => {
    expect(loadingState()).toEqual({ kind: 'loading' });
    expect(emptyState('none')).toEqual({ kind: 'empty', message: 'none' });
    expect(errorState('boom')).toEqual({ kind: 'error', message: 'boom' });
    expect(forbiddenState('denied')).toEqual({ kind: 'forbidden', message: 'denied' });
    expect(readyState()).toEqual({ kind: 'ready' });
  });
});

describe('operations list view', () => {
  const wire = (overrides: Partial<OperationWire> = {}): OperationWire => ({
    id: 'op-1',
    businessId: 'biz-1',
    businessVersion: '1.0.0',
    action: 'ingest',
    state: 'RUNNING',
    stateVersion: 2,
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:01:00Z',
    deadlineAt: null,
    ...overrides,
  });

  test('projection preserves wire order and fields', () => {
    const view = buildOperationsListView([wire(), wire({ id: 'op-2', state: 'SUCCEEDED' })], 12, 1, 2);
    expect(view.rows.map((r) => r.id)).toEqual(['op-1', 'op-2']);
    expect(view.total).toBe(12);
    expect(view.page).toBe(1);
    expect(view.pageSize).toBe(2);
    expect(view.rows[1]!.state).toBe('SUCCEEDED');
  });

  test('empty page yields empty rows with total carried through', () => {
    const view = buildOperationsListView([], 0, 1, 20);
    expect(view.rows).toEqual([]);
    expect(view.total).toBe(0);
  });

  const healthCases: Array<{ state: OperationWire['state']; expected: string }> = [
    { state: 'SUCCEEDED', expected: 'ok' },
    { state: 'FAILED', expected: 'terminal-bad' },
    { state: 'CANCELLED', expected: 'terminal-bad' },
    { state: 'TIMED_OUT', expected: 'terminal-bad' },
    { state: 'WAITING_INPUT', expected: 'attention' },
    { state: 'ACCEPTED', expected: 'in-flight' },
    { state: 'QUEUED', expected: 'in-flight' },
    { state: 'RUNNING', expected: 'in-flight' },
    { state: 'WAITING_CHILDREN', expected: 'in-flight' },
    { state: 'RETRY_PENDING', expected: 'in-flight' },
    { state: 'CANCEL_REQUESTED', expected: 'in-flight' },
  ];

  test.each(healthCases)('state $state -> health $expected', ({ state, expected }) => {
    expect(operationHealth(wire({ state }))).toBe(expected);
  });
});

describe('business view (missing capability / unregistered business)', () => {
  test('unregistered business returns not-registered with the id', () => {
    expect(businessViewState({ kind: 'not-found', businessId: 'ghost-biz' })).toEqual({
      kind: 'not-registered',
      businessId: 'ghost-biz',
    });
  });

  test('loaded record maps title/description/actionCount', () => {
    const state = businessViewState({
      kind: 'loaded',
      record: {
        businessId: 'biz-1',
        version: '2.0.0',
        registeredAt: '2026-09-22T00:00:00Z',
        manifest: { title: 'Biz One', description: 'demo', actions: [{ name: 'a' }, { name: 'b' }] },
      },
    });
    expect(state).toEqual({
      kind: 'ready',
      business: {
        businessId: 'biz-1',
        version: '2.0.0',
        title: 'Biz One',
        description: 'demo',
        actionCount: 2,
        registeredAt: '2026-09-22T00:00:00Z',
      },
    });
  });

  test('manifest without title/description degrades gracefully', () => {
    const built = buildBusinessView({
      businessId: 'biz-2',
      version: '1.0.0',
      registeredAt: '2026-09-22T00:00:00Z',
      manifest: { actions: [] },
    });
    expect(built.title).toBe('biz-2');
    expect(built.description).toBe('');
    expect(built.actionCount).toBe(0);
  });

  test('loading and error pass through', () => {
    expect(businessViewState({ kind: 'loading' })).toEqual({ kind: 'loading' });
    expect(businessViewState({ kind: 'error', message: 'db?' })).toEqual({ kind: 'error', message: 'db?' });
  });
});

describe('profile form (no profile / stale revision / unknown widget / missing capability)', () => {
  const manifestInput = (overrides: Partial<ProfileSchemaInput> = {}): ProfileSchemaInput => ({
    businessId: 'biz-1',
    businessVersion: '1.0.0',
    manifest: {
      actions: [
        {
          name: 'alpha',
          slots: [
            { name: 'text_slot', widget: 'text', required: true, description: 'free text' },
            { name: 'mode', widget: 'select', required: true },
          ],
        },
        { name: 'beta', slots: [{ name: 'mystery', widget: 'fancy-future-widget' }] },
      ],
    },
    capabilityOptions: [
      { connectorId: 'conn-a', capability: 'fast', label: 'Conn A fast' },
      { connectorId: 'conn-b', capability: 'cheap', label: 'Conn B cheap' },
    ],
    existingProfile: { name: 'default', revision: 3 },
    ...overrides,
  });

  test('form follows manifest order with revision label', () => {
    const model = buildProfileFormModel(manifestInput());
    expect(model.profileName).toBe('default');
    expect(model.revisionLabel).toBe('rev 3');
    expect(model.sections.map((s) => s.actionName)).toEqual(['alpha', 'beta']);
    expect(model.sections[0]!.fields.map((f) => f.slotName)).toEqual(['text_slot', 'mode']);
  });

  test('no profile -> empty name and rev 0', () => {
    const model = buildProfileFormModel(manifestInput({ existingProfile: null }));
    expect(model.profileName).toBe('');
    expect(model.revisionLabel).toBe('rev 0');
  });

  test('unknown widget falls back to text with flag', () => {
    const model = buildProfileFormModel(manifestInput());
    const mystery = model.sections[1]!.fields[0]!;
    expect(mystery.widget).toBe('text');
    expect(mystery.unknownFallback).toBe(true);
  });

  test('coerceWidget: known passes, unknown/undefined fall back', () => {
    expect(coerceWidget('select')).toEqual({ widget: 'select', unknown: false });
    expect(coerceWidget('fancy')).toEqual({ widget: 'text', unknown: true });
    expect(coerceWidget(undefined)).toEqual({ widget: 'text', unknown: false });
  });

  test('select with missing slot options inherits connector capability options', () => {
    const model = buildProfileFormModel(manifestInput());
    const mode = model.sections[0]!.fields.find((f) => f.slotName === 'mode');
    expect(mode?.widget).toBe('select');
    expect(mode?.options).toEqual([
      { value: 'conn-a:fast', label: 'Conn A fast' },
      { value: 'conn-b:cheap', label: 'Conn B cheap' },
    ]);
  });

  test('missing capability: select with no slot options and no capabilities has no options', () => {
    const model = buildProfileFormModel(manifestInput({ capabilityOptions: [] }));
    const mode = model.sections[0]!.fields.find((f) => f.slotName === 'mode');
    expect(mode?.options).toBeUndefined();
  });

  test('explicit slot options win over capability options', () => {
    const field = buildProfileFormField(
      { name: 'mode', widget: 'select', options: [{ value: 'x', label: 'X' }] },
      [{ connectorId: 'c', capability: 'y', label: 'Y' }],
    );
    expect(field.options).toEqual([{ value: 'x', label: 'X' }]);
    expect(field.unknownFallback).toBeUndefined();
  });

  const revisionCases: Array<{
    name: string;
    formRevision: number;
    server: { revision: number } | null;
    expected: { kind: string };
  }> = [
    { name: 'current', formRevision: 3, server: { revision: 3 }, expected: { kind: 'current' } },
    { name: 'stale', formRevision: 2, server: { revision: 3 }, expected: { kind: 'stale' } },
    { name: 'no profile', formRevision: 0, server: null, expected: { kind: 'no-profile' } },
    { name: 'stale vs deleted', formRevision: 4, server: null, expected: { kind: 'stale' } },
  ];

  test.each(revisionCases)('revision check: $name', ({ formRevision, server, expected }) => {
    const got = checkProfileRevision(formRevision, server);
    expect(got.kind).toBe(expected.kind);
    if (got.kind === 'stale') {
      expect(got.formRevision).toBe(formRevision);
    }
  });
});

describe('secret handling', () => {
  test('secret values are masked, never echoed', () => {
    expect(displayValue('secret', 's3cr3t')).toBe('••••••••');
    expect(displayValue('secret', '')).toBe('');
    expect(displayValue('text', 'plain')).toBe('plain');
  });
});

describe('profile draft validation (P6-03 pure client-side)', () => {
  const slot = {
    requiredText: { name: 'title', required: true, widget: 'text' },
    optionalNumber: { name: 'count', widget: 'number' },
    boolSlot: { name: 'flag', widget: 'boolean' },
    selectSlot: { name: 'mode', widget: 'select' },
    secretSlot: { name: 'token', widget: 'secret', required: true },
    lockedSlot: { name: 'region', widget: 'text', locked: true, lockedValue: 'eu' },
    unknownSlot: { name: 'future', widget: 'fancy-future-widget' },
    explicitSelect: { name: 'preset', widget: 'select', options: [{ value: 'a', label: 'A' }] },
  };

  const baseInput = (overrides: Partial<DraftValidationInput> = {}): DraftValidationInput => ({
    draft: {
      businessId: 'biz-1',
      businessVersion: '1.0.0',
      profileName: 'default',
      formRevision: 1,
      entries: [
        { slotName: 'title', value: 'doc' },
        { slotName: 'count', value: '3' },
        { slotName: 'flag', value: 'true' },
        { slotName: 'mode', value: 'conn-a:fast' },
        { slotName: 'token', value: 's3cr3t' },
        { slotName: 'region', value: 'eu' },
      ],
    },
    actions: [
      {
        actionName: 'alpha',
        slots: [
          slot.requiredText,
          slot.optionalNumber,
          slot.boolSlot,
          slot.selectSlot,
          slot.secretSlot,
          slot.lockedSlot,
          slot.unknownSlot,
          slot.explicitSelect,
        ],
      },
    ],
    capabilityOptions: [{ connectorId: 'conn-a', capability: 'fast' }],
    serverProfile: { revision: 1 },
    ...overrides,
  });

  test('valid draft passes with no issues', () => {
    const result = validateProfileDraft(baseInput());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  const invalidCases: Array<{ name: string; mutate: (i: DraftValidationInput) => void; expectedCode: string; slot: string }> = [
    { name: 'required missing', mutate: (i) => { i.draft.entries = i.draft.entries.filter((e) => e.slotName !== 'title'); }, expectedCode: 'required-missing', slot: 'title' },
    { name: 'number bounded coercion', mutate: (i) => { i.draft.entries = i.draft.entries.map((e) => (e.slotName === 'count' ? { slotName: 'count', value: 'abc' } : e)); }, expectedCode: 'widget-invalid-value', slot: 'count' },
    { name: 'boolean coercion', mutate: (i) => { i.draft.entries = i.draft.entries.map((e) => (e.slotName === 'flag' ? { slotName: 'flag', value: 'maybe' } : e)); }, expectedCode: 'widget-invalid-value', slot: 'flag' },
    { name: 'explicit select not in options', mutate: (i) => { i.draft.entries = [...i.draft.entries, { slotName: 'preset', value: 'zzz' }]; }, expectedCode: 'widget-invalid-value', slot: 'preset' },
    { name: 'capability mismatch', mutate: (i) => { i.draft.entries = i.draft.entries.map((e) => (e.slotName === 'mode' ? { slotName: 'mode', value: 'conn-b:slow' } : e)); }, expectedCode: 'capability-mismatch', slot: 'mode' },
    { name: 'locked unchanged violation', mutate: (i) => { i.draft.entries = i.draft.entries.map((e) => (e.slotName === 'region' ? { slotName: 'region', value: 'us' } : e)); }, expectedCode: 'locked-unchanged-violation', slot: 'region' },
    { name: 'stale revision', mutate: (i) => { i.serverProfile = { revision: 2 }; }, expectedCode: 'stale-revision', slot: '' },
    { name: 'no profile target', mutate: (i) => { i.serverProfile = null; i.draft.formRevision = 3; }, expectedCode: 'no-profile-target', slot: '' },
  ];

  test.each(invalidCases)('$name -> $expectedCode', ({ mutate, expectedCode, slot }) => {
    const input = baseInput();
    mutate(input);
    const result = validateProfileDraft(input);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === expectedCode && issue.slotName === slot)).toBe(true);
  });

  test('unknown widget is an explicit validated fallback flag', () => {
    const result = validateProfileDraft(baseInput());
    const issue = result.issues.find((i) => i.code === 'widget-unknown-fallback');
    // 'future' is not bound in the draft entries, so value is empty -> no value check,
    // but the fallback hint still surfaces for any non-empty authored value.
    expect(issue).toBeUndefined();
    const withFuture = baseInput();
    withFuture.draft.entries = [...withFuture.draft.entries, { slotName: 'future', value: 'x' }];
    const hint = validateProfileDraft(withFuture).issues.find((i) => i.code === 'widget-unknown-fallback');
    expect(hint?.slotName).toBe('future');
  });

  test('missing capability catalog fails capability select', () => {
    const input = baseInput({ capabilityOptions: [] });
    input.draft.entries = input.draft.entries.map((e) => (e.slotName === 'mode' ? { slotName: 'mode', value: 'conn-x:fast' } : e));
    const result = validateProfileDraft(input);
    expect(result.issues.some((i) => i.code === 'capability-mismatch')).toBe(true);
  });
});

describe('profile draft diff (client-side preview, secrets masked)', () => {
  const actions = [
    {
      actionName: 'alpha',
      slots: [
        { name: 'title', widget: 'text' },
        { name: 'mode', widget: 'select' },
        { name: 'token', widget: 'secret' },
      ],
    },
  ];

  const draft = (overrides: { entries?: { slotName: string; value: string }[] } = {}): { businessId: string; businessVersion: string; profileName: string; formRevision: number; entries: { slotName: string; value: string }[] } => ({
    businessId: 'biz-1',
    businessVersion: '1.0.0',
    profileName: 'default',
    formRevision: 1,
    entries: overrides.entries ?? [
      { slotName: 'title', value: 'doc' },
      { slotName: 'mode', value: 'conn-a:fast' },
      { slotName: 'token', value: '' },
    ],
  });

  test('identical draft yields identical true, all unchanged', () => {
    const report = diffProfileDraft(draft(), actions, {
      title: 'doc',
      mode: 'conn-a:fast',
      token: '••••••••',
    });
    expect(report.identical).toBe(true);
    expect(report.entries.every((e) => e.kind === 'unchanged')).toBe(true);
  });

  test('plain change reports from/to values', () => {
    const report = diffProfileDraft(draft({ entries: [{ slotName: 'title', value: 'renamed' }] }), actions, { title: 'doc', mode: 'conn-a:fast' });
    const entry = report.entries.find((e) => e.slotName === 'title');
    expect(entry).toEqual({ kind: 'changed', slotName: 'title', from: 'doc', to: 'renamed' });
    expect(report.identical).toBe(false);
  });

  test('secret change is masked as changed-secret, never echoing values', () => {
    const report = diffProfileDraft(
      draft({ entries: [{ slotName: 'title', value: 'doc' }, { slotName: 'mode', value: 'conn-a:fast' }, { slotName: 'token', value: 'new-secret' }] }),
      actions,
      { title: 'doc', mode: 'conn-a:fast', token: '••••••••' },
    );
    const entry = report.entries.find((e) => e.slotName === 'token');
    expect(entry).toEqual({ kind: 'changed-secret', slotName: 'token' });
    expect(JSON.stringify(report)).not.toContain('new-secret');
  });

  test('added / removed non-secret slots', () => {
    const report = diffProfileDraft(
      draft({ entries: [{ slotName: 'title', value: 'new-doc' }] }),
      actions,
      { mode: 'conn-a:fast', token: '••••••••' },
    );
    expect(report.entries.find((e) => e.slotName === 'title')).toEqual({ kind: 'added', slotName: 'title' });
    expect(report.entries.find((e) => e.slotName === 'mode')).toEqual({ kind: 'removed', slotName: 'mode' });
  });
});

// ---------------------------------------------------------------------------
// W31-O — P6-04 Connector configuration view models
// ---------------------------------------------------------------------------

/** Generic connector revision fixture; no business-specific hardcoding. */
const revisionRow = (overrides: Partial<ConnectorRevisionRow> = {}): ConnectorRevisionRow => ({
  connectorId: 'conn-1',
  revision: 3,
  adapter: 'rest',
  endpoint: { kind: 'REST', maskedHost: '***.example.com' },
  capabilities: ['text-extract'],
  state: 'enabled',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T01:00:00.000Z',
  ...overrides,
});

describe('connector endpoint display (secret-safe projection)', () => {
  const cases: Array<{ rawUrl?: string; kind: string; expectedMasked: string }> = [
    { kind: 'REST', rawUrl: 'https://api.openai.com/v1', expectedMasked: '***.openai.com' },
    { kind: 'REST', rawUrl: 'https://api.example.com:8443/path', expectedMasked: '***.example.com' },
    { kind: 'REST', rawUrl: 'http://localhost:8080', expectedMasked: '***' },
    { kind: 'REST', rawUrl: 'not-a-url', expectedMasked: '***' },
    { kind: 'REST', expectedMasked: '***' },
  ];

  test.each(cases)('$kind $rawUrl -> $expectedMasked', ({ rawUrl, kind, expectedMasked }) => {
    const display = buildConnectorEndpointDisplay({ kind, url: rawUrl });
    expect(display).toEqual({ kind, maskedHost: expectedMasked });
  });

  test('raw URL never survives in the serialized projection', () => {
    // Subdomain masked, registrable domain preserved by design
    const display = buildConnectorEndpointDisplay({ kind: 'REST', url: 'https://token.secret-host.internal/api' });
    expect(display.maskedHost).toBe('***.secret-host.internal');
    // No raw `url`/full URL string can be serialized out of the projection
    expect(Object.keys(display).sort()).toEqual(['kind', 'maskedHost']);
    expect(JSON.stringify(display)).not.toContain('token.secret-host.internal');
    expect(JSON.stringify(display)).not.toContain('https://');
  });

  test('maskConnectorHost never returns the raw host', () => {
    expect(maskConnectorHost('api.openai.com')).not.toContain('api.openai.com');
    expect(maskConnectorHost('')).toBe('***');
    expect(maskConnectorHost(undefined)).toBe('***');
  });
});

describe('buildConnectorConfigView', () => {
  test('projects revision + testResult + rotateState verbatim', () => {
    const revision = revisionRow();
    const testResult = { kind: 'success' as const, message: 'Connection OK', testedAt: '2026-09-22T02:00:00.000Z' };
    const view = buildConnectorConfigView({ revision, testResult, rotateState: 'idle' });
    expect(view).toEqual({ revision, testResult, rotateState: 'idle' });
  });

  test('endpoint carries only masked projection — no raw url field in view', () => {
    const view = buildConnectorConfigView({
      revision: revisionRow({ endpoint: { kind: 'REST', maskedHost: '***.internal.corp' } }),
      testResult: { kind: 'pending', message: 'Test in progress', testedAt: null },
      rotateState: 'in-progress',
    });
    expect(view.revision.endpoint.maskedHost).toBe('***.internal.corp');
    expect(Object.keys(view.revision.endpoint).sort()).toEqual(['kind', 'maskedHost']);
    expect(JSON.stringify(view)).not.toContain('https://');
  });
});

describe('buildConnectorListViewState', () => {
  test('loading -> loading', () => {
    expect(buildConnectorListViewState({ kind: 'loading' })).toEqual({ kind: 'loading' });
  });

  test('error -> error with message', () => {
    expect(buildConnectorListViewState({ kind: 'error', message: 'registry unavailable' })).toEqual({
      kind: 'error',
      message: 'registry unavailable',
    });
  });

  test('loaded with no rows -> empty', () => {
    const state = buildConnectorListViewState({ kind: 'loaded', rows: [] });
    expect(state.kind).toBe('empty');
    if (state.kind === 'empty') expect(state.message).toBe('No connectors configured');
  });

  test('loaded with rows -> ready, rows preserved', () => {
    const rows = [revisionRow(), revisionRow({ connectorId: 'conn-2', revision: 1 })];
    const state = buildConnectorListViewState({ kind: 'loaded', rows });
    expect(state).toEqual({ kind: 'ready', rows });
  });
});

describe('buildConnectorTestResult', () => {
  const cases: Array<{
    name: string;
    wire: Parameters<typeof buildConnectorTestResult>[0];
    expectedKind: string;
  }> = [
    { name: 'success', wire: { ok: true, testedAt: '2026-09-22T03:00:00.000Z' }, expectedKind: 'success' },
    { name: 'provider-unavailable', wire: { ok: false, errorKind: 'provider-unavailable' }, expectedKind: 'provider-unavailable' },
    { name: 'invalid-credential', wire: { ok: false, errorKind: 'invalid-credential' }, expectedKind: 'invalid-credential' },
    { name: 'quota-exceeded', wire: { ok: false, errorKind: 'quota-exceeded' }, expectedKind: 'quota-exceeded' },
    { name: 'timeout', wire: { ok: false, errorKind: 'timeout' }, expectedKind: 'timeout' },
    { name: 'unknown error defaults to provider-unavailable', wire: { ok: false }, expectedKind: 'provider-unavailable' },
  ];

  test.each(cases)('$name -> $expectedKind', ({ wire, expectedKind }) => {
    expect(buildConnectorTestResult(wire).kind).toBe(expectedKind);
  });

  test('no provider body or credential leaks into the result', () => {
    const result = buildConnectorTestResult({
      ok: false,
      errorKind: 'invalid-credential',
      message: 'Credential rejected by provider',
    });
    expect(JSON.stringify(result)).not.toMatch(/sk-|password|Bearer/i);
    expect(result.testedAt).toBeNull();
  });
});

describe('rotateSecretActionView', () => {
  const cases: Array<{
    state: RotateSecretState;
    actionable: boolean;
    copyOnceHint: boolean;
  }> = [
    { state: 'idle', actionable: true, copyOnceHint: false },
    { state: 'requested', actionable: false, copyOnceHint: false },
    { state: 'in-progress', actionable: false, copyOnceHint: false },
    { state: 'completed', actionable: true, copyOnceHint: true },
    { state: 'conflict', actionable: true, copyOnceHint: false },
  ];

  test.each(cases)('$state -> actionable=$actionable, copyOnceHint=$copyOnceHint', ({ state, actionable, copyOnceHint }) => {
    const view = rotateSecretActionView(state);
    expect(view.state).toBe(state);
    expect(view.actionable).toBe(actionable);
    expect(view.copyOnceHint).toBe(copyOnceHint);
    expect(view.label.length).toBeGreaterThan(0);
  });

  test('completed exposes copy-once hint exactly once', () => {
    expect(rotateSecretActionView('completed').copyOnceHint).toBe(true);
    expect(rotateSecretActionView('idle').copyOnceHint).toBe(false);
  });
});

describe('canRunConnectorTest', () => {
  const viewWith = (
    state: ConnectorRevisionState,
    testKind: ConnectorTestResultKind,
    rotateState: RotateSecretState,
  ): ConnectorConfigView => ({
    revision: revisionRow({ state }),
    testResult: { kind: testKind, message: '', testedAt: null },
    rotateState,
  });

  const cases: Array<{ name: string; state: ConnectorRevisionState; testKind: ConnectorTestResultKind; rotate: RotateSecretState; expected: boolean }> = [
    { name: 'enabled + idle + non-pending test -> true', state: 'enabled', testKind: 'success', rotate: 'idle', expected: true },
    { name: 'pending test -> false', state: 'enabled', testKind: 'pending', rotate: 'idle', expected: false },
    { name: 'rotating (in-progress) -> false', state: 'rotating', testKind: 'success', rotate: 'in-progress', expected: false },
    { name: 'rotation requested -> false', state: 'enabled', testKind: 'success', rotate: 'requested', expected: false },
    { name: 'disabled -> false', state: 'disabled', testKind: 'success', rotate: 'idle', expected: false },
  ];

  test.each(cases)('$name', ({ state, testKind, rotate, expected }) => {
    expect(canRunConnectorTest(viewWith(state, testKind, rotate))).toBe(expected);
  });
});

describe('connectorTestNeedsAttention', () => {
  const attentionKinds = ['pending', 'provider-unavailable', 'invalid-credential', 'quota-exceeded', 'timeout'] as const;

  const view = (
    state: ConnectorRevisionState,
    testKind: ConnectorTestResultKind,
  ): ConnectorConfigView => ({
    revision: revisionRow({ state }),
    testResult: { kind: testKind, message: '', testedAt: null },
    rotateState: 'idle',
  });

  test.each(attentionKinds)('enabled + %s test -> needs attention', (kind) => {
    expect(connectorTestNeedsAttention(view('enabled', kind))).toBe(true);
  });

  test('enabled + success -> no attention', () => {
    expect(connectorTestNeedsAttention(view('enabled', 'success'))).toBe(false);
  });

  const nonEnabled: Array<ConnectorRevisionState> = ['disabled', 'rotating'];
  test.each(nonEnabled)('%s connector never needs attention regardless of test kind', (state) => {
    expect(connectorTestNeedsAttention(view(state, 'timeout'))).toBe(false);
  });
});


// ===========================================================================
// W-ADM-UX-13-BASE-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 57)
//
// Negative + boundary tests for the base admin view models. Every expectation
// was MEASURED with a throwaway probe against the real function first.
// Several pin behaviour that is arguably wrong; those are marked DEFECT and
// reported, not fixed (production code is out of scope).
//
// Pure unit file: no DB, no HTTP, no listener, so no port band applies.
// ===========================================================================

const WADMUX13_XSS = '<script>alert(1)</script>';

const wmNav = (o: Partial<NavItem> = {}): NavItem => ({
  section: 'grants',
  label: 'Grants',
  path: '/admin/grants',
  requiredRole: 'admin',
  ...o,
});

// ConnectorRevisionRow carries `state`, not `status`. A fixture using
// `status` leaves revision.state undefined, so connectorTestNeedsAttention
// short-circuits on `state !== 'enabled'` and every test kind looks healthy.
// I hit exactly that in the probe - it inverts the whole badge verdict.
const wmView = (
  kind: ConnectorTestResultKind,
  state: ConnectorRevisionState = 'enabled',
  rotateState: RotateSecretState = 'idle',
) =>
  buildConnectorConfigView({
    revision: revisionRow({ state }),
    testResult: { kind, message: 'm', testedAt: null },
    rotateState,
  });

const wmBiz = (manifest: Record<string, unknown>, o: Record<string, unknown> = {}) =>
  buildBusinessView({
    businessId: 'biz-1',
    version: '1.0.0',
    registeredAt: '2026-09-22T00:00:00.000Z',
    manifest,
    ...o,
  } as never);

// ---------------------------------------------------------------------------
// 1. Malformed navigation items
// ---------------------------------------------------------------------------

describe('W-ADM-UX-13: a malformed nav item fails closed, a malformed item object throws', () => {
  const badRoles: string[] = ['BOGUS', 'ADMIN', 'Admin', '', 'viewer '];
  test.each(badRoles)('canSeeNavItem with role %p is false against every requiredRole', (role) => {
    for (const required of ['viewer', 'operator', 'admin'] as AdminRole[]) {
      expect(canSeeNavItem(role as AdminRole, wmNav({ requiredRole: required }))).toBe(false);
    }
  });

  test('a well-formed admin/admin pair is true (control for the rows above)', () => {
    expect(canSeeNavItem('admin', wmNav({ requiredRole: 'admin' }))).toBe(true);
  });

  test('an unknown requiredRole denies even the highest role', () => {
    expect(canSeeNavItem('admin', wmNav({ requiredRole: 'BOGUS' as AdminRole }))).toBe(false);
    expect(canSeeNavItem('admin', wmNav({ requiredRole: undefined as never }))).toBe(false);
  });

  test('a null or undefined role denies rather than throwing', () => {
    expect(canSeeNavItem(undefined as never, wmNav())).toBe(false);
    expect(canSeeNavItem(null as never, wmNav())).toBe(false);
  });

  // The role is a Record lookup, so an unknown key yields undefined and the
  // >= comparison is false - a safe default, but by accident rather than by
  // design: nothing here is defensive.
  test('the role gate degrades by accident of undefined comparison, not by a guard', () => {
    // undefined >= undefined === false, and 0 >= undefined === false too.
    expect(canSeeNavItem('admin', wmNav({ requiredRole: 'BOGUS' as AdminRole }))).toBe(false);
    expect(canSeeNavItem('viewer', wmNav({ requiredRole: 'viewer' }))).toBe(true);
  });

  test('a null or undefined item throws - the item is dereferenced unguarded', () => {
    expect(() => canSeeNavItem('admin', null as never)).toThrow(TypeError);
    expect(() => canSeeNavItem('admin', undefined as never)).toThrow(TypeError);
  });

  test('a nav item with no section is still considered visible', () => {
    // The gate only reads requiredRole; section is never validated.
    expect(canSeeNavItem('admin', wmNav({ section: undefined as never }))).toBe(true);
  });

  test('a hostile label and path pass through verbatim', () => {
    const item = wmNav({ label: WADMUX13_XSS, path: '/admin/' + WADMUX13_XSS });
    expect(canSeeNavItem('admin', item)).toBe(true);
    expect(item.label).toBe(WADMUX13_XSS);
    expect(item.path).toBe('/admin/' + WADMUX13_XSS);
  });

  test('the canonical nav list carries constant labels', () => {
    expect(ALL_NAV_ITEMS.map((i) => i.label)).toEqual([
      'Businesses',
      'Operations',
      'Profiles',
      'Connectors',
      'Grants',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2 + 5. Invalid paths and corrupt role authorizations
// ---------------------------------------------------------------------------

describe('W-ADM-UX-13: an unknown role yields an empty nav, and sectionForPath ignores roles', () => {
  // The packet asks for "invalid tenant paths". There is no tenant concept in
  // this module (0 matches for tenant/csrf/notification/user). The real
  // path surface is sectionForPath, so that is what these tests drive.
  test.each(['BOGUS', 'ADMIN', '', 'viewer '])(
    'visibleNavItems(%p) is empty rather than throwing',
    (role) => {
      expect(visibleNavItems(role as AdminRole)).toEqual([]);
    },
  );

  test('a null role yields an empty nav', () => {
    expect(visibleNavItems(null as never)).toEqual([]);
  });

  test('the three real roles still see their sections (control)', () => {
    expect(visibleNavItems('viewer').map((i) => i.section)).toEqual(['businesses', 'operations']);
    expect(visibleNavItems('admin')).toHaveLength(ALL_NAV_ITEMS.length);
  });

  // DEFECT-shaped observation, documented rather than alarming: sectionForPath
  // takes no role at all, so it happily resolves a section the requesting role
  // may not see. The two surfaces disagree, and a renderer trusting
  // sectionForPath alone would show a gated section.
  test('sectionForPath resolves an admin-only section without any role check', () => {
    expect(sectionForPath('/admin/grants')).toBe('grants');
    expect(visibleNavItems('viewer').map((i) => i.section)).not.toContain('grants');
  });

  const pathCases: Array<[string, string | null]> = [
    ['/admin/grants', 'grants'],
    ['/admin/grants/', 'grants'],
    ['/admin/grants//x', 'grants'],
    ['/admin/businesses-extra', null],
    ['/ADMIN/grants', null],
    ['//admin/grants', null],
    ['admin/grants', null],
    ['', null],
    ['/', null],
  ];
  test.each(pathCases)('sectionForPath(%p) -> %p', (path, expected) => {
    expect(sectionForPath(path)).toBe(expected);
  });

  // The prefix guard is a raw string prefix, so a traversal segment resolves
  // against the FIRST segment. A router would normalise ../grants to grants.
  test('a traversal path resolves to the first segment, not the traversed one', () => {
    expect(sectionForPath('/admin/businesses/../grants')).toBe('businesses');
  });

  test('a null or undefined path throws', () => {
    expect(() => sectionForPath(null as never)).toThrow(TypeError);
    expect(() => sectionForPath(undefined as never)).toThrow(TypeError);
  });

  test('a hostile path resolves to null, it is not reflected anywhere', () => {
    expect(sectionForPath('/admin/' + WADMUX13_XSS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Missing CSRF token in context
// ---------------------------------------------------------------------------

describe('W-ADM-UX-13: there is no CSRF surface in this module to test', () => {
  // The packet asks about a missing CSRF token in context. Grepping
  // view-models.ts and types.ts returns no match for csrf at all: these are
  // pure display mappers with no request context and no token of any kind.
  // These tests pin the absence so a future CSRF concern is not assumed to be
  // covered by this file.
  test('the business view model carries no csrf-shaped field', () => {
    const view = wmBiz({ title: 'T', description: 'D' });
    expect(Object.keys(view).sort()).toEqual([
      'actionCount',
      'businessId',
      'description',
      'registeredAt',
      'title',
      'version',
    ]);
  });

  test('the nav gate takes only a role and an item - no request context', () => {
    // Signature-level: there is nowhere to pass a token even if one existed.
    expect(ALL_NAV_ITEMS.every((i) => !('csrf' in i))).toBe(true);
    expect(canSeeNavItem.length).toBe(2);
    expect(sectionForPath.length).toBe(1);
  });

  test('page-state helpers carry only a message, never a token', () => {
    expect(Object.keys(readyState()).sort()).toEqual(['kind']);
    expect(Object.keys(errorState('m')).sort()).toEqual(['kind', 'message']);
  });
});

// ---------------------------------------------------------------------------
// 4. Unescaped display names
// ---------------------------------------------------------------------------

describe('W-ADM-UX-13: display names are passthrough, and a missing manifest throws', () => {
  // The packet asks about user display names. There is no user/actor concept
  // in this module either; the display-name surface that does exist is the
  // business title/description and the nav label.
  test('a hostile title and description pass through verbatim', () => {
    const view = wmBiz({ title: WADMUX13_XSS, description: WADMUX13_XSS });
    expect(view.title).toBe(WADMUX13_XSS);
    expect(view.description).toBe(WADMUX13_XSS);
  });

  test('the title falls back to businessId, which can itself be hostile', () => {
    expect(wmBiz({}, { businessId: WADMUX13_XSS }).title).toBe(WADMUX13_XSS);
  });

  test('a missing manifest throws instead of degrading', () => {
    expect(() =>
      buildBusinessView({
        businessId: 'b',
        version: '1',
        registeredAt: 'r',
      } as never),
    ).toThrow(TypeError);
  });

  test('a null actions array counts zero, but a null ELEMENT still counts one', () => {
    // actionCount is actions?.length, so a null element is never inspected -
    // a manifest of [null] reports one action.
    expect(wmBiz({ actions: null }).actionCount).toBe(0);
    expect(wmBiz({ actions: [] }).actionCount).toBe(0);
    expect(wmBiz({ actions: [null] }).actionCount).toBe(1);
  });

  test('a loaded business state carries the hostile title into the ready view', () => {
    const state = businessViewState({
      kind: 'loaded',
      record: { businessId: 'b', version: '1', registeredAt: 'r', manifest: { title: WADMUX13_XSS } },
    });
    expect(state.kind).toBe('ready');
    expect((state as { business: { title: string } }).business.title).toBe(WADMUX13_XSS);
  });

  // The same shape as the auditSeverityBadge gap in cycle 55: a switch with no
  // default returns undefined, and the return type does not include it.
  test('an unknown business view state kind returns undefined', () => {
    expect(businessViewState({ kind: 'BOGUS' } as never)).toBeUndefined();
  });

  test('the four declared kinds still resolve (control)', () => {
    expect(businessViewState({ kind: 'loading' })).toEqual({ kind: 'loading' });
    expect(businessViewState({ kind: 'not-found', businessId: 'x' })).toEqual({
      kind: 'not-registered',
      businessId: 'x',
    });
    expect(businessViewState({ kind: 'error', message: 'm' })).toEqual({ kind: 'error', message: 'm' });
  });
});

// ---------------------------------------------------------------------------
// 6. Notification badge boundary cases
// ---------------------------------------------------------------------------

describe('W-ADM-UX-13: an unknown badge input reads as the healthy or working value', () => {
  // There is no notification concept here; the real badge surfaces are
  // operationHealth (list badge tinting) and connectorTestNeedsAttention.
  const healthCases: Array<[string, string]> = [
    ['SUCCEEDED', 'ok'],
    ['FAILED', 'terminal-bad'],
    ['CANCELLED', 'terminal-bad'],
    ['TIMED_OUT', 'terminal-bad'],
    ['WAITING_INPUT', 'attention'],
    ['RUNNING', 'in-flight'],
    ['WAITING_CHILDREN', 'in-flight'],
  ];
  test.each(healthCases)('operationHealth(%p) -> %p', (state, expected) => {
    expect(operationHealth({ state } as never)).toBe(expected);
  });

  // DEFECT, and the same fail-open shape as the business health in cycle 53:
  // the default branch paints an unknown state as still working.
  test.each(['BOGUS', '', 'enabled', 'SUCCEEDED '])(
    'operationHealth(%p) -> in-flight, i.e. looks like it is running',
    (state) => {
      expect(operationHealth({ state } as never)).toBe('in-flight');
    },
  );

  const attentionKinds: ConnectorTestResultKind[] = [
    'pending',
    'timeout',
    'invalid-credential',
    'quota-exceeded',
    'provider-unavailable',
  ];
  test.each(attentionKinds)('enabled + %s -> needs attention', (kind) => {
    expect(connectorTestNeedsAttention(wmView(kind))).toBe(true);
  });

  test('enabled + success -> no attention (control)', () => {
    expect(connectorTestNeedsAttention(wmView('success'))).toBe(false);
  });

  // DEFECT: a corrupt test-result kind is not in the attention list, so it
  // reads as "nothing needs attention" - the badge goes quiet on bad data.
  test.each(['BOGUS', '', 'Success'])(
    'an unknown test kind %p reads as needing no attention',
    (kind) => {
      expect(connectorTestNeedsAttention(wmView(kind as ConnectorTestResultKind))).toBe(false);
    },
  );

  test.each(['disabled', 'rotating'])('%s connector never needs attention', (state) => {
    expect(connectorTestNeedsAttention(wmView('timeout', state as ConnectorRevisionState))).toBe(false);
  });

  // canRunConnectorTest denies on three named states only, so anything else -
  // including corrupt input - permits the action.
  const canRunCases: Array<[ConnectorTestResultKind | string, RotateSecretState | string, ConnectorRevisionState | string, boolean]> = [
    ['pending', 'idle', 'enabled', false],
    ['success', 'requested', 'enabled', false],
    ['success', 'in-progress', 'enabled', false],
    ['success', 'idle', 'enabled', true],
    ['success', 'completed', 'enabled', true],
    ['success', 'conflict', 'enabled', true],
    ['success', 'idle', 'disabled', false],
    ['BOGUS', 'idle', 'enabled', true],
    ['success', 'BOGUS', 'enabled', true],
    ['success', 'idle', 'BOGUS', true],
  ];
  test.each(canRunCases)(
    'canRunConnectorTest kind=%p rotate=%p rev=%p -> %p',
    (kind, rotate, state, expected) => {
      const view = wmView(kind as ConnectorTestResultKind, state as ConnectorRevisionState, rotate as RotateSecretState);
      expect(canRunConnectorTest(view)).toBe(expected);
    },
  );

  const rotateViews: Array<[RotateSecretState, boolean, boolean]> = [
    ['idle', true, false],
    ['requested', false, false],
    ['in-progress', false, false],
    ['completed', true, true],
    ['conflict', true, false],
  ];
  test.each(rotateViews)(
    'rotateSecretActionView(%p) actionable=%p copyOnceHint=%p',
    (state, actionable, copyOnce) => {
      const view = rotateSecretActionView(state);
      expect(view.actionable).toBe(actionable);
      expect(view.copyOnceHint).toBe(copyOnce);
    },
  );

  // Same undefined-from-switch pattern: a switch with no default, and the
  // declared return type cannot express it.
  test('rotateSecretActionView with an unknown state returns undefined', () => {
    expect(rotateSecretActionView('BOGUS' as never)).toBeUndefined();
  });

  const maskCases: Array<[string, string]> = [
    ['', '***'],
    ['localhost', '***'],
    ['localhost:8080', '***'],
    ['a', '***'],
    ['a.b', '***.a.b'],
    ['a.b.c.d', '***.c.d'],
    ['.', '***..'],
    [':', '***'],
    ['x:' + WADMUX13_XSS, '***'],
  ];
  test.each(maskCases)('maskConnectorHost(%p) -> %p', (raw, expected) => {
    expect(maskConnectorHost(raw)).toBe(expected);
  });

  // A two-label host keeps the registrable domain by design, which means the
  // mask hides nothing meaningful for a short host.
  test('a two-label host is masked to almost itself', () => {
    expect(maskConnectorHost('a.b')).toBe('***.a.b');
    expect(maskConnectorHost('api.openai.com')).toBe('***.openai.com');
  });

  test('a null host masks to *** but a number throws', () => {
    expect(maskConnectorHost(null as never)).toBe('***');
    expect(maskConnectorHost(undefined)).toBe('***');
    expect(() => maskConnectorHost(12345 as never)).toThrow(TypeError);
  });
});
