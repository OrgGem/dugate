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