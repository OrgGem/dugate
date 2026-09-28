/**
 * Unit tests for P6-05 pure API Key View Models.
 *
 * Validates:
 * - maskApiKey: first 4 chars + ellipsis; empty/short raw keys handled safely.
 * - buildApiKeyCreateView: copy-once semantics — raw key never stored in
 *   the returned model, only masked hint. copyOnceAvailable reflects input.
 * - buildApiKeyListView: list projection has no raw-key field, status badge
 *   and label resolve correctly for every status, canRevoke wired.
 * - canRevokeApiKey: ACTIVE → true; REVOKING / REVOKED → false.
 * - buildApiKeyRevokeConfirm: only ID + masked hint in the model;
 *   confirmDisabled mirrors canRevokeApiKey.
 * - buildApiKeyAssignmentView: maps grants; totalGrants accurate.
 * - apiKeyStatusBadge / apiKeyStatusLabel: all 3 status enums covered.
 *
 * Pure offline tests: Zero database activity, zero HTTP calls, strict
 * TypeScript without `any`.
 */

import {
  apiKeyStatusBadge,
  apiKeyStatusLabel,
  buildApiKeyAssignmentView,
  buildApiKeyCreateView,
  buildApiKeyListView,
  buildApiKeyRevokeConfirm,
  canRevokeApiKey,
  maskApiKey,
  type ApiKeyGrantRow,
  type ApiKeyRow,
  type ApiKeyStatus,
} from '../src/app/admin/api-key-view-models';

const baseRow = (overrides: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: '00000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  maskedHint: 'du_l…',
  prefix: 'du_live_',
  status: 'ACTIVE',
  createdAt: '2026-09-23T00:00:00.000Z',
  lastUsedAt: null,
  label: 'ci-runner',
  revokedAt: null,
  ...overrides,
});

describe('P6-05: maskApiKey', () => {
  test.each([
    { raw: 'du_live_abcdefghij1234', expected: 'du_l…' },
    { raw: 'abcd', expected: 'abcd…' },
    { raw: '12345678', expected: '1234…' },
    { raw: 'XYZ', expected: '•••…' },
    { raw: 'a', expected: '•…' },
    { raw: '', expected: '' },
  ])('masks $raw → $expected', ({ raw, expected }) => {
    expect(maskApiKey(raw)).toBe(expected);
  });
});

describe('P6-05: apiKeyStatusBadge / apiKeyStatusLabel', () => {
  const all: ApiKeyStatus[] = ['ACTIVE', 'REVOKING', 'REVOKED'];
  test('every status has a badge variant', () => {
    const badgeByStatus: Record<ApiKeyStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
      ACTIVE: 'success',
      REVOKING: 'warning',
      REVOKED: 'error',
    };
    for (const s of all) {
      expect(apiKeyStatusBadge(s)).toBe(badgeByStatus[s]);
    }
  });

  test('every status has a non-empty human label', () => {
    const labelByStatus: Record<ApiKeyStatus, string> = {
      ACTIVE: 'Active',
      REVOKING: 'Revoking',
      REVOKED: 'Revoked',
    };
    for (const s of all) {
      expect(apiKeyStatusLabel(s)).toBe(labelByStatus[s]);
    }
  });
});

describe('P6-05: buildApiKeyCreateView (copy-once)', () => {
  test('raw key accepted as input but never stored in the returned model', () => {
    const view = buildApiKeyCreateView({
      id: 'k-1',
      tenantId: 't-1',
      prefix: 'du_live_',
      label: 'ci',
      createdAt: '2026-09-23T00:00:00.000Z',
      rawKey: 'du_live_supersecretvalue123',
    });

    // No field on the view model carries the raw key.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('supersecretvalue');
    expect(serialized).not.toContain('du_live_supersecret');

    // Only the masked hint is exposed.
    expect(view.maskedHint).toBe('du_l…');
    expect(view.copyOnceAvailable).toBe(true);
    expect(view.copyOnceNotice).toMatch(/copy this key now/i);
  });

  test('empty raw key yields copyOnceAvailable=false with the acknowledged notice', () => {
    const view = buildApiKeyCreateView({
      id: 'k-1',
      tenantId: 't-1',
      prefix: 'du_live_',
      label: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      rawKey: '',
    });
    expect(view.copyOnceAvailable).toBe(false);
    expect(view.copyOnceNotice).toMatch(/no longer available/i);
    expect(view.maskedHint).toBe('');
  });

  test('returned object has no raw-key property at all', () => {
    const view = buildApiKeyCreateView({
      id: 'k-1',
      tenantId: 't-1',
      prefix: 'du_live_',
      label: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      rawKey: 'du_live_value',
    });
    const obj = view as unknown as Record<string, unknown>;
    expect('rawKey' in obj).toBe(false);
    expect('raw_key' in obj).toBe(false);
    expect('key' in obj).toBe(false);
  });
});

describe('P6-05: canRevokeApiKey', () => {
  test.each<{ status: ApiKeyStatus; expected: boolean }>([
    { status: 'ACTIVE', expected: true },
    { status: 'REVOKING', expected: false },
    { status: 'REVOKED', expected: false },
  ])('canRevokeApiKey($status) === $expected', ({ status, expected }) => {
    expect(canRevokeApiKey({ status })).toBe(expected);
  });
});

describe('P6-05: buildApiKeyListView', () => {
  test('list projection never carries a raw key in any row', () => {
    const rows: ApiKeyRow[] = [
      baseRow({ id: 'k-1', maskedHint: 'du_l…' }),
      baseRow({ id: 'k-2', maskedHint: 'abcd…', status: 'REVOKING', revokedAt: null }),
      baseRow({ id: 'k-3', maskedHint: 'wxyz…', status: 'REVOKED', revokedAt: '2026-09-22T00:00:00.000Z' }),
    ];
    const view = buildApiKeyListView(rows);
    const serialized = JSON.stringify(view);
    // The raw-key substring (the part AFTER the prefix) must never appear.
    expect(serialized).not.toContain('supersecret');
    // The masked hint must echo back only its 4-char prefix form.
    expect(serialized).not.toContain('du_live_supersecret');
    for (const row of view.rows) {
      const obj = row as unknown as Record<string, unknown>;
      expect('rawKey' in obj).toBe(false);
      expect('key' in obj).toBe(false);
    }
  });

  test('rows include masked hint + metadata, badge variant, and canRevoke', () => {
    const view = buildApiKeyListView([
      baseRow({ id: 'k-1', maskedHint: 'du_l…', status: 'ACTIVE' }),
      baseRow({ id: 'k-2', maskedHint: 'abcd…', status: 'REVOKING' }),
      baseRow({ id: 'k-3', maskedHint: 'wxyz…', status: 'REVOKED' }),
    ]);
    expect(view.total).toBe(3);
    expect(view.rows[0]?.canRevoke).toBe(true);
    expect(view.rows[0]?.statusBadge).toBe('success');
    expect(view.rows[0]?.statusLabel).toBe('Active');
    expect(view.rows[1]?.canRevoke).toBe(false);
    expect(view.rows[1]?.statusBadge).toBe('warning');
    expect(view.rows[1]?.statusLabel).toBe('Revoking');
    expect(view.rows[2]?.canRevoke).toBe(false);
    expect(view.rows[2]?.statusBadge).toBe('error');
    expect(view.rows[2]?.statusLabel).toBe('Revoked');
  });

  test('empty input yields empty list with total=0', () => {
    const view = buildApiKeyListView([]);
    expect(view.rows).toEqual([]);
    expect(view.total).toBe(0);
  });

  test('rows preserve metadata verbatim (label, prefix, timestamps)', () => {
    const row = baseRow({
      id: 'k-1',
      prefix: 'du_live_',
      maskedHint: 'du_l…',
      label: 'ci-runner',
      createdAt: '2026-09-23T10:00:00.000Z',
      lastUsedAt: '2026-09-23T11:00:00.000Z',
    });
    const view = buildApiKeyListView([row]);
    expect(view.rows[0]?.label).toBe('ci-runner');
    expect(view.rows[0]?.prefix).toBe('du_live_');
    expect(view.rows[0]?.createdAt).toBe('2026-09-23T10:00:00.000Z');
    expect(view.rows[0]?.lastUsedAt).toBe('2026-09-23T11:00:00.000Z');
  });
});

describe('P6-05: buildApiKeyRevokeConfirm', () => {
  test('confirmation carries only ID + masked hint (no raw key)', () => {
    const key = baseRow({
      id: 'k-99',
      maskedHint: 'du_l…',
      status: 'ACTIVE',
    });
    const confirm = buildApiKeyRevokeConfirm(key);
    const serialized = JSON.stringify(confirm);
    expect(serialized).not.toContain('supersecret');
    expect(confirm.id).toBe('k-99');
    expect(confirm.maskedHint).toBe('du_l…');
    expect(confirm.status).toBe('ACTIVE');
    expect(confirm.confirmDisabled).toBe(false);
    expect(confirm.warning.length).toBeGreaterThan(0);
  });

  test.each<{ status: ApiKeyStatus; disabled: boolean }>([
    { status: 'ACTIVE', disabled: false },
    { status: 'REVOKING', disabled: true },
    { status: 'REVOKED', disabled: true },
  ])('confirmDisabled for $status is $disabled', ({ status, disabled }) => {
    const confirm = buildApiKeyRevokeConfirm({ ...baseRow({ status }) });
    expect(confirm.confirmDisabled).toBe(disabled);
  });
});

describe('P6-05: buildApiKeyAssignmentView', () => {
  test('maps grant list to display rows and computes totalGrants', () => {
    const grants: ApiKeyGrantRow[] = [
      {
        businessId: 'doc-core',
        businessVersion: '1.2.0',
        action: 'ingest',
        grantedAt: '2026-09-20T00:00:00.000Z',
      },
      {
        businessId: 'doc-core',
        businessVersion: '1.2.0',
        action: 'extract',
        grantedAt: '2026-09-21T00:00:00.000Z',
      },
    ];
    const view = buildApiKeyAssignmentView(
      baseRow({ id: 'k-1', maskedHint: 'du_l…' }),
      grants,
    );
    expect(view.id).toBe('k-1');
    expect(view.maskedHint).toBe('du_l…');
    expect(view.totalGrants).toBe(2);
    expect(view.grants).toHaveLength(2);
    expect(view.grants[0]?.action).toBe('ingest');
    expect(view.grants[1]?.action).toBe('extract');
  });

  test('empty grant list yields totalGrants=0 and an empty grants array', () => {
    const view = buildApiKeyAssignmentView(baseRow({ id: 'k-1' }), []);
    expect(view.totalGrants).toBe(0);
    expect(view.grants).toEqual([]);
  });

  test('assignment view never contains a raw key field', () => {
    const view = buildApiKeyAssignmentView(
      baseRow({ id: 'k-1', maskedHint: 'du_l…' }),
      [
        {
          businessId: 'b1',
          businessVersion: '1',
          action: 'a',
          grantedAt: '2026-09-20T00:00:00.000Z',
        },
      ],
    );
    const obj = view as unknown as Record<string, unknown>;
    expect('rawKey' in obj).toBe(false);
    expect('key' in obj).toBe(false);
  });
});
