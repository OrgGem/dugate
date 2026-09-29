/**
 * Unit tests for P6-04 pure Connector View Models.
 *
 * Validates:
 * - buildConnectorConfigRevisionView: revision metadata + capability list,
 *   masked endpoint projection, secret slots rendered with status badges,
 *   no raw secret value reaches the model (write-only enforcement).
 * - canRotateSecret: enabled + hasValue only; disabled / rotating / empty
 *   all return false.
 * - buildSecretRotationConfirm: model carries connector id + slot label +
 *   warning + requireTypeToConfirm + submitDisabled mirrors the guard.
 * - buildConnectorTestResultView: every ConnectorTestResultKind maps to a
 *   renderer-safe badge/label; no upstream response body or header leaks.
 * - connectorStateBadge / connectorStateLabel: all 3 state enums covered.
 * - connectorTestBadge / connectorTestLabel: all 6 kind enums covered.
 * - maskConnectorHost: short / empty / single-char inputs handled safely.
 *
 * Hard contract: a raw secret substring MUST never appear in the serialized
 * model. Tests assert against a unique sentinel that only exists in the
 * raw secret value used to simulate a write at the boundary.
 *
 * Pure offline tests: Zero database activity, zero HTTP calls, strict
 * TypeScript without `any`.
 */

import {
  buildConnectorConfigRevisionView,
  buildConnectorTestResultView,
  buildSecretRotationConfirm,
  canRotateSecret,
  connectorStateBadge,
  connectorStateLabel,
  connectorTestBadge,
  connectorTestLabel,
  deriveRotateSecretState,
  type ConnectorRevisionInput,
  type ConnectorRevisionRow,
  type ConnectorSecretSlotRow,
} from '../src/app/admin/connector-view-models';

const RAW_SECRET_SENTINEL = 'sk_supersecret_raw_DO_NOT_LEAK_42';

const baseRevision: ConnectorRevisionRow = {
  connectorId: 'openai-prod',
  revision: 7,
  adapter: 'openai-v1',
  endpoint: { kind: 'REST', maskedHost: '***.openai.com' },
  capabilities: ['chat.completions', 'embeddings'],
  state: 'enabled',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T01:00:00.000Z',
};

const baseSecretSlot = (overrides: Partial<ConnectorSecretSlotRow> = {}): ConnectorSecretSlotRow => ({
  name: 'apiKey',
  label: 'OpenAI API key',
  hasValue: true,
  rotatedAt: '2026-09-22T00:00:00.000Z',
  ...overrides,
});

const baseInput = (overrides: Partial<ConnectorRevisionInput> = {}): ConnectorRevisionInput => ({
  revision: baseRevision,
  secretSlots: [baseSecretSlot()],
  ...overrides,
});

describe('P6-04: connectorStateBadge / connectorStateLabel', () => {
  test.each([
    { state: 'enabled' as const, expectedBadge: 'success', expectedLabel: 'Enabled' },
    { state: 'disabled' as const, expectedBadge: 'neutral', expectedLabel: 'Disabled' },
    { state: 'rotating' as const, expectedBadge: 'warning', expectedLabel: 'Rotating' },
  ])('$state → $expectedBadge / $expectedLabel', ({ state, expectedBadge, expectedLabel }) => {
    expect(connectorStateBadge(state)).toBe(expectedBadge);
    expect(connectorStateLabel(state)).toBe(expectedLabel);
  });
});

describe('P6-04: connectorTestBadge / connectorTestLabel', () => {
  test.each([
    { kind: 'success' as const, badge: 'success', label: 'Success' },
    { kind: 'provider-unavailable' as const, badge: 'warning', label: 'Provider unavailable' },
    { kind: 'invalid-credential' as const, badge: 'error', label: 'Invalid credential' },
    { kind: 'quota-exceeded' as const, badge: 'warning', label: 'Quota exceeded' },
    { kind: 'timeout' as const, badge: 'warning', label: 'Timeout' },
    { kind: 'pending' as const, badge: 'neutral', label: 'Pending' },
  ])('$kind → $badge / $label', ({ kind, badge, label }) => {
    expect(connectorTestBadge(kind)).toBe(badge);
    expect(connectorTestLabel(kind)).toBe(label);
  });
});

describe('P6-04: buildConnectorConfigRevisionView (write-only secret slots)', () => {
  test('projection carries metadata verbatim and never holds a raw secret', () => {
    const view = buildConnectorConfigRevisionView(baseInput());

    expect(view.connectorId).toBe('openai-prod');
    expect(view.revision).toBe(7);
    expect(view.adapter).toBe('openai-v1');
    expect(view.endpoint).toEqual({ kind: 'REST', maskedHost: '***.openai.com' });
    expect(view.capabilities).toEqual(['chat.completions', 'embeddings']);
    expect(view.state).toBe('enabled');
    expect(view.stateBadge).toBe('success');
    expect(view.stateLabel).toBe('Enabled');
    expect(view.createdAt).toBe('2026-09-23T00:00:00.000Z');
    expect(view.updatedAt).toBe('2026-09-23T01:00:00.000Z');
    expect(view.totalSecretSlots).toBe(1);
    expect(view.hasAnySecret).toBe(true);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(RAW_SECRET_SENTINEL);
    expect(serialized).not.toContain('rawKey');
    expect(serialized).not.toContain('secret_value');
    expect(serialized).not.toContain('password');
  });

  test('slot view reflects hasValue without leaking any underlying value', () => {
    const configured = buildConnectorConfigRevisionView(
      baseInput({
        secretSlots: [baseSecretSlot({ name: 'apiKey', hasValue: true, rotatedAt: '2026-09-22T00:00:00.000Z' })],
      }),
    );
    expect(configured.secretSlots[0]).toEqual({
      name: 'apiKey',
      label: 'OpenAI API key',
      hasValue: true,
      statusBadge: 'success',
      statusLabel: 'Configured',
      rotatedAt: '2026-09-22T00:00:00.000Z',
    });

    const empty = buildConnectorConfigRevisionView(
      baseInput({
        secretSlots: [baseSecretSlot({ name: 'apiKey', hasValue: false, rotatedAt: null })],
      }),
    );
    expect(empty.secretSlots[0]?.statusBadge).toBe('warning');
    expect(empty.secretSlots[0]?.statusLabel).toBe('Not configured');
    expect(empty.hasAnySecret).toBe(false);
  });

  test('empty secret slots yields totalSecretSlots=0 and hasAnySecret=false', () => {
    const view = buildConnectorConfigRevisionView(baseInput({ secretSlots: [] }));
    expect(view.totalSecretSlots).toBe(0);
    expect(view.secretSlots).toEqual([]);
    expect(view.hasAnySecret).toBe(false);
  });

  test('masked endpoint projection never contains the original URL host', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({
        revision: {
          ...baseRevision,
          endpoint: { kind: 'REST', maskedHost: '***.openai.com' },
        },
      }),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('api.openai.com');
    expect(serialized).toContain('***.openai.com');
  });
});

describe('P6-04: canRotateSecret', () => {
  test('enabled + hasValue=true is the only allowed case', () => {
    expect(canRotateSecret({ state: 'enabled' }, { hasValue: true })).toBe(true);
  });

  test.each([
    { state: 'disabled' as const, hasValue: true, expected: false },
    { state: 'rotating' as const, hasValue: true, expected: false },
    { state: 'enabled' as const, hasValue: false, expected: false },
  ])('$state + hasValue=$hasValue → $expected', ({ state, hasValue, expected }) => {
    expect(canRotateSecret({ state }, { hasValue })).toBe(expected);
  });
});

describe('P6-04: buildSecretRotationConfirm', () => {
  test('allowed rotation has submitDisabled=false and requireTypeToConfirm=true', () => {
    const confirm = buildSecretRotationConfirm(
      { connectorId: 'openai-prod', revision: 7, state: 'enabled' },
      baseSecretSlot(),
    );
    expect(confirm.connectorId).toBe('openai-prod');
    expect(confirm.revision).toBe(7);
    expect(confirm.slotName).toBe('apiKey');
    expect(confirm.slotLabel).toBe('OpenAI API key');
    expect(confirm.requireTypeToConfirm).toBe(true);
    expect(confirm.submitDisabled).toBe(false);
    expect(confirm.warning.length).toBeGreaterThan(0);
  });

  test('disabled connector yields submitDisabled=true', () => {
    const confirm = buildSecretRotationConfirm(
      { connectorId: 'openai-prod', revision: 7, state: 'disabled' },
      baseSecretSlot(),
    );
    expect(confirm.submitDisabled).toBe(true);
  });

  test('rotating connector yields submitDisabled=true (no second rotation)', () => {
    const confirm = buildSecretRotationConfirm(
      { connectorId: 'openai-prod', revision: 7, state: 'rotating' },
      baseSecretSlot(),
    );
    expect(confirm.submitDisabled).toBe(true);
  });

  test('confirmation view contains no raw secret field at all', () => {
    const confirm = buildSecretRotationConfirm(
      { connectorId: 'openai-prod', revision: 7, state: 'enabled' },
      baseSecretSlot(),
    );
    const obj = confirm as unknown as Record<string, unknown>;
    expect(obj['rawKey']).toBeUndefined();
    expect(obj['value']).toBeUndefined();
    expect(obj['secret']).toBeUndefined();
    const serialized = JSON.stringify(confirm);
    expect(serialized).not.toContain(RAW_SECRET_SENTINEL);
  });
});

describe('P6-04: buildConnectorTestResultView', () => {
  test('success kind maps to success badge and label', () => {
    const view = buildConnectorTestResultView('openai-prod', 7, {
      kind: 'success',
      message: 'Connected successfully',
      testedAt: '2026-09-23T01:30:00.000Z',
    });
    expect(view.badge).toBe('success');
    expect(view.label).toBe('Success');
    expect(view.message).toBe('Connected successfully');
    expect(view.canRetry).toBe(false);
    expect(view.testedAt).toBe('2026-09-23T01:30:00.000Z');
  });

  test.each([
    { kind: 'provider-unavailable' as const, badge: 'warning', label: 'Provider unavailable' },
    { kind: 'invalid-credential' as const, badge: 'error', label: 'Invalid credential' },
    { kind: 'quota-exceeded' as const, badge: 'warning', label: 'Quota exceeded' },
    { kind: 'timeout' as const, badge: 'warning', label: 'Timeout' },
    { kind: 'pending' as const, badge: 'neutral', label: 'Pending' },
  ])('$kind → $badge / $label', ({ kind, badge, label }) => {
    const view = buildConnectorTestResultView('openai-prod', 7, {
      kind,
      message: 'safe summary',
      testedAt: null,
    });
    expect(view.badge).toBe(badge);
    expect(view.label).toBe(label);
    expect(view.canRetry).toBe(false);
  });

  test('test result view carries connector id + revision + sanitized message only', () => {
    const view = buildConnectorTestResultView('openai-prod', 7, {
      kind: 'invalid-credential',
      message: 'Authentication failed',
      testedAt: '2026-09-23T01:30:00.000Z',
    });
    const obj = view as unknown as Record<string, unknown>;
    expect(obj['error']).toBeUndefined();
    expect(obj['headers']).toBeUndefined();
    expect(obj['response']).toBeUndefined();
    expect(obj['body']).toBeUndefined();
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });
});

describe('P6-04: deriveRotateSecretState', () => {
  test('rotating state → in-progress', () => {
    expect(deriveRotateSecretState('rotating')).toBe('in-progress');
  });

  test.each([
    { state: 'enabled' as const, expected: 'idle' },
    { state: 'disabled' as const, expected: 'idle' },
  ])('$state → $expected', ({ state, expected }) => {
    expect(deriveRotateSecretState(state)).toBe(expected);
  });
});

describe('P6-04: write-only contract — raw secret sentinel never appears in any output', () => {
  test('building a revision view with a sentinel-bearing slot string leaks nothing', () => {
    const slot: ConnectorSecretSlotRow = {
      name: 'apiKey',
      label: 'OpenAI API key',
      hasValue: true,
      rotatedAt: '2026-09-22T00:00:00.000Z',
    };
    const view = buildConnectorConfigRevisionView({
      revision: baseRevision,
      secretSlots: [slot],
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(RAW_SECRET_SENTINEL);
  });

  test('secret rotation confirmation contains only id+slot+warning, never raw bytes', () => {
    const confirm = buildSecretRotationConfirm(
      { connectorId: 'openai-prod', revision: 7, state: 'enabled' },
      baseSecretSlot({ label: 'OpenAI API key', name: 'apiKey' }),
    );
    const serialized = JSON.stringify(confirm);
    expect(serialized).not.toContain(RAW_SECRET_SENTINEL);
    expect(serialized).toContain('openai-prod');
    expect(serialized).toContain('apiKey');
  });
});

// ===========================================================================
// W-ADM-UX-08-CONNECTOR-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 52)
//
// Negative + boundary tests for the pure connector view models. Every
// expectation was MEASURED with a throwaway probe against the real function
// first. Several pin behaviour that is arguably wrong; those are marked
// DEFECT and reported, not fixed (production code is out of scope).
//
// Pure unit file: no DB, no HTTP, no listener, so no port band applies.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1 + 2. Unknown / malformed connectorState and connectorTestResultKind
// ---------------------------------------------------------------------------

describe('W-ADM-UX-08: an unknown connector state throws instead of degrading', () => {
  // DEFECT: STATE_META[state].badge is an unguarded lookup, so a state the
  // server has never seen crashes the projection with a TypeError. Measured.
  // Contrast with the gates below, which fail closed without throwing.
  const malformed: string[] = ['BOGUS', '', 'Enabled', 'enabled ', 'ENABLED'];

  test.each(malformed)('connectorStateBadge(%p) throws a TypeError', (state) => {
    expect(() => connectorStateBadge(state as never)).toThrow(TypeError);
  });

  test.each(malformed)('connectorStateLabel(%p) throws a TypeError', (state) => {
    expect(() => connectorStateLabel(state as never)).toThrow(TypeError);
  });

  test.each(malformed)('connectorTestBadge(%p) throws a TypeError', (kind) => {
    expect(() => connectorTestBadge(kind as never)).toThrow(TypeError);
  });

  test.each(malformed)('connectorTestLabel(%p) throws a TypeError', (kind) => {
    expect(() => connectorTestLabel(kind as never)).toThrow(TypeError);
  });

  test('the three declared states and six declared kinds still resolve (control)', () => {
    // The lists below mirror the ConnectorRevisionState / ConnectorTestResultKind
    // unions. They are type-only unions, so there is no runtime array to derive
    // them from - this control is what stops the rows above being vacuous.
    for (const state of ['enabled', 'disabled', 'rotating'] as const) {
      expect(typeof connectorStateLabel(state)).toBe('string');
      expect(['success', 'warning', 'neutral']).toContain(connectorStateBadge(state));
    }
    for (const kind of [
      'success', 'provider-unavailable', 'invalid-credential',
      'quota-exceeded', 'timeout', 'pending',
    ] as const) {
      expect(typeof connectorTestLabel(kind)).toBe('string');
      expect(['success', 'warning', 'error', 'neutral']).toContain(connectorTestBadge(kind));
    }
  });

  test('the lookup is case-sensitive and does not trim', () => {
    expect(() => connectorStateBadge('Enabled' as never)).toThrow(TypeError);
    expect(() => connectorStateBadge('enabled ' as never)).toThrow(TypeError);
    expect(connectorStateBadge('enabled')).toBe('success');
  });

  test('a malformed state crashes the whole revision projection, not just the badge', () => {
    expect(() =>
      buildConnectorConfigRevisionView({
        revision: { ...baseRevision, state: 'BOGUS' as never },
        secretSlots: [baseSecretSlot()],
      }),
    ).toThrow(TypeError);
  });

  test('a malformed state also crashes the test-result projection', () => {
    expect(() =>
      buildConnectorTestResultView('openai-prod', 7, {
        kind: 'BOGUS' as never,
        message: 'safe',
        testedAt: null,
      }),
    ).toThrow(TypeError);
  });

  test('the GUATES fail closed on the same malformed state instead of throwing', () => {
    // The asymmetry: the display lookups crash, the authorisation-shaped
    // helpers quietly deny. A corrupt state cannot enable a rotation.
    expect(canRotateSecret({ state: 'BOGUS' as never }, { hasValue: true })).toBe(false);
    expect(deriveRotateSecretState('BOGUS' as never)).toBe('idle');
  });

  test('a malformed state still yields a submitDisabled confirm view (no crash there)', () => {
    // buildSecretRotationConfirm does not call the badge lookup, so it
    // survives - and denies, which is the safe direction.
    const confirm = buildSecretRotationConfirm(
      { connectorId: 'openai-prod', revision: 7, state: 'BOGUS' as never },
      baseSecretSlot(),
    );
    expect(confirm.submitDisabled).toBe(true);
    expect(confirm.requireTypeToConfirm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Secret slot corruption
// ---------------------------------------------------------------------------

describe('W-ADM-UX-08: corrupted secret slots pass through the projection', () => {
  test('a null slot name reaches the view, despite the view type saying string', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ name: null as never })] }),
    );
    expect(view.secretSlots[0]!.name).toBeNull();
  });

  test('a null slot label reaches the view', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ label: null as never })] }),
    );
    expect(view.secretSlots[0]!.label).toBeNull();
  });

  test('an undefined rotatedAt reaches the view rather than becoming null', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ rotatedAt: undefined as never })] }),
    );
    expect(view.secretSlots[0]!.rotatedAt).toBeUndefined();
  });

  // DEFECT: secretSlotBadge is a bare truthiness test, so any truthy junk
  // reads as a configured secret. Measured below.
  const falsyHasValue: unknown[] = [null, undefined, 0, '', false];
  test.each(falsyHasValue)('hasValue %p reads as Not configured', (hasValue) => {
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ hasValue: hasValue as never })] }),
    );
    expect(view.secretSlots[0]!.statusLabel).toBe('Not configured');
    expect(view.secretSlots[0]!.statusBadge).toBe('warning');
    expect(view.hasAnySecret).toBe(false);
  });

  const truthyHasValue: unknown[] = [1, 'true', 'yes', {}, []];
  test.each(truthyHasValue)('hasValue %p reads as Configured', (hasValue) => {
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ hasValue: hasValue as never })] }),
    );
    expect(view.secretSlots[0]!.statusLabel).toBe('Configured');
    expect(view.hasAnySecret).toBe(true);
  });

  test("the string 'false' reads as CONFIGURED - the sharpest form of the defect", () => {
    // A corrupt boolean from a sloppy serializer flips the operator-facing
    // badge from "Not configured" to "Configured" with no error anywhere.
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ hasValue: 'false' as never })] }),
    );
    expect(view.secretSlots[0]!.statusBadge).toBe('success');
    expect(view.secretSlots[0]!.statusLabel).toBe('Configured');
    expect(view.hasAnySecret).toBe(true);
  });

  test('a null element in secretSlots throws a TypeError', () => {
    expect(() =>
      buildConnectorConfigRevisionView(baseInput({ secretSlots: [null as never] })),
    ).toThrow(TypeError);
  });

  test('a hole in secretSlots is preserved and serialises to null', () => {
    // Array.prototype.map keeps holes, so the projected array has a hole in
    // the middle: totalSecretSlots counts it, but the rendered row is null.
    const sparse = [baseSecretSlot(), , baseSecretSlot({ name: 'webhookSecret' })] as never;
    const view = buildConnectorConfigRevisionView(baseInput({ secretSlots: sparse }));
    expect(view.totalSecretSlots).toBe(3);
    expect(view.secretSlots).toHaveLength(3);
    expect(view.secretSlots[1]).toBeUndefined();
    expect(JSON.stringify(view.secretSlots)).toContain('null');
  });

  test('hasAnySecret ignores a hole but still counts the real slots', () => {
    const sparse = [baseSecretSlot(), , baseSecretSlot({ hasValue: false })] as never;
    const view = buildConnectorConfigRevisionView(baseInput({ secretSlots: sparse }));
    expect(view.hasAnySecret).toBe(true);
    expect(view.secretSlots.filter(Boolean)).toHaveLength(2);
  });

  test('duplicate slot names are not de-duplicated', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({
        secretSlots: [baseSecretSlot({ name: 'apiKey' }), baseSecretSlot({ name: 'apiKey', hasValue: false })],
      }),
    );
    expect(view.totalSecretSlots).toBe(2);
    expect(view.hasAnySecret).toBe(true);
  });

  test('null capabilities throw rather than yielding an empty list', () => {
    expect(() =>
      buildConnectorConfigRevisionView(
        baseInput({ revision: { ...baseRevision, capabilities: null as never }, secretSlots: [] }),
      ),
    ).toThrow(TypeError);
  });

  test('a null revision row throws', () => {
    expect(() =>
      buildConnectorConfigRevisionView({ revision: null as never, secretSlots: [] }),
    ).toThrow(TypeError);
  });

  test('hostile capability tags are passed through unescaped', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({
        revision: { ...baseRevision, capabilities: ['<script>alert(1)</script>'] },
        secretSlots: [],
      }),
    );
    expect(view.capabilities).toEqual(['<script>alert(1)</script>']);
  });

  test('capabilities are copied, so mutating the input cannot reach the view', () => {
    const capabilities = ['chat.completions'];
    const view = buildConnectorConfigRevisionView(
      baseInput({ revision: { ...baseRevision, capabilities }, secretSlots: [] }),
    );
    capabilities.push('smuggled');
    expect(view.capabilities).toEqual(['chat.completions']);
  });
});

// ---------------------------------------------------------------------------
// 4. Raw secret leakage in error states
// ---------------------------------------------------------------------------

describe('W-ADM-UX-08: the write-only rule is a CALLER contract, not an enforced one', () => {
  // The module docstring promises that "no raw secret value ever leaks into
  // a view model", but every projected string is a verbatim passthrough. The
  // sanitisation happens (if at all) before the call. These tests pin the
  // measured passthrough: if someone later adds stripping INSIDE the view
  // model, these turn red, which is exactly the signal a real fix would make.
  const leak = (view: unknown): boolean => JSON.stringify(view).includes(RAW_SECRET_SENTINEL);

  test('a raw secret in the error message reaches the test-result view', () => {
    const view = buildConnectorTestResultView('openai-prod', 7, {
      kind: 'invalid-credential',
      message: 'upstream 401 for key ' + RAW_SECRET_SENTINEL,
      testedAt: '2026-09-23T01:30:00.000Z',
    });
    expect(view.message).toContain(RAW_SECRET_SENTINEL);
    expect(leak(view)).toBe(true);
  });

  test('a raw secret in the slot label reaches the revision view', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ label: 'key ' + RAW_SECRET_SENTINEL })] }),
    );
    expect(view.secretSlots[0]!.label).toContain(RAW_SECRET_SENTINEL);
    expect(leak(view)).toBe(true);
  });

  test('a raw secret in connectorId reaches the test-result view', () => {
    const view = buildConnectorTestResultView(RAW_SECRET_SENTINEL, 7, {
      kind: 'success',
      message: 'ok',
      testedAt: null,
    });
    expect(view.connectorId).toBe(RAW_SECRET_SENTINEL);
    expect(leak(view)).toBe(true);
  });

  test('a raw secret in rotatedAt reaches the revision view', () => {
    const view = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ rotatedAt: RAW_SECRET_SENTINEL })] }),
    );
    expect(view.secretSlots[0]!.rotatedAt).toBe(RAW_SECRET_SENTINEL);
    expect(leak(view)).toBe(true);
  });

  test('a raw secret in the slot name reaches the rotation-confirm view', () => {
    const confirm = buildSecretRotationConfirm(
      { connectorId: 'openai-prod', revision: 7, state: 'enabled' },
      baseSecretSlot({ name: RAW_SECRET_SENTINEL }),
    );
    expect(confirm.slotName).toBe(RAW_SECRET_SENTINEL);
    expect(leak(confirm)).toBe(true);
  });

  test('hostile HTML in the error message is not escaped', () => {
    const view = buildConnectorTestResultView('openai-prod', 7, {
      kind: 'timeout',
      message: '<img src=x onerror=alert(1)>',
      testedAt: null,
    });
    expect(view.message).toBe('<img src=x onerror=alert(1)>');
  });

  test('an undefined testedAt passes through rather than becoming null', () => {
    const view = buildConnectorTestResultView('openai-prod', 7, {
      kind: 'success',
      message: 'm',
      testedAt: undefined as never,
    });
    expect(view.testedAt).toBeUndefined();
  });

  test('the rotation warning is the one field that CANNOT carry a secret', () => {
    // The contrast that makes the passthrough above worth reporting: the
    // warning is a module constant, so it is genuinely injection-proof, and
    // the same model is otherwise fully caller-controlled.
    const confirm = buildSecretRotationConfirm(
      { connectorId: RAW_SECRET_SENTINEL, revision: 7, state: 'enabled' },
      baseSecretSlot({ name: RAW_SECRET_SENTINEL, label: RAW_SECRET_SENTINEL }),
    );
    expect(confirm.warning).not.toContain(RAW_SECRET_SENTINEL);
    expect(confirm.warning.length).toBeGreaterThan(0);
  });

  test('canRetry is hard-wired false regardless of what the caller passes', () => {
    for (const kind of ['success', 'timeout', 'invalid-credential'] as const) {
      const view = buildConnectorTestResultView('c', 1, { kind, message: 'm', testedAt: null });
      expect(view.canRetry).toBe(false);
    }
  });

  test('the four pre-existing sentinel assertions pass only because the sentinel is never injected', () => {
    // Recorded, not fixed: the P6-04 write-only block asserts the sentinel is
    // absent from output, but never puts the sentinel into an input, so those
    // assertions would still pass if the model echoed every field. This test
    // is the non-vacuous version of the same intent - it injects the sentinel
    // and shows the current behaviour is a passthrough.
    const clean = buildConnectorConfigRevisionView(baseInput());
    expect(JSON.stringify(clean)).not.toContain(RAW_SECRET_SENTINEL);

    const dirty = buildConnectorConfigRevisionView(
      baseInput({ secretSlots: [baseSecretSlot({ label: RAW_SECRET_SENTINEL })] }),
    );
    expect(JSON.stringify(dirty)).toContain(RAW_SECRET_SENTINEL);
  });
});
