/**
 * Table-driven unit tests for the P6-01 headless Admin view models (W26-O).
 *
 * Scope: pure functions in `src/app/admin/*`. No DB, no HTTP, no framework.
 * Generic fixtures only — nothing hardcodes document-core/example-review
 * actions or slots.
 */

import {
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
