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

// ===========================================================================
// W-ADM-UX-10-API-KEY-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 54)
//
// Negative + boundary tests for the pure API key view models. Every
// expectation was MEASURED with a throwaway probe against the real function
// first. Several pin behaviour that is arguably wrong; those are marked
// DEFECT and reported, not fixed (production code is out of scope).
//
// Pure unit file: no DB, no HTTP, no listener, so no port band applies.
// ===========================================================================

const WADMUX10_SECRET = 'du_live_SUPERSECRET_do_not_leak_42';
const WADMUX10_XSS = '<script>alert(1)</script>';

// ---------------------------------------------------------------------------
// 1. Secret key masking validation
// ---------------------------------------------------------------------------

describe('W-ADM-UX-10: a raw key of exactly four characters is echoed in full', () => {
  // DEFECT: the mask is raw.slice(0, 4) for any length >= 4, so a key that is
  // itself 4 characters long is reproduced completely - the "mask" IS the
  // secret. Measured: maskApiKey('ABCD') === 'ABCD…'.
  test('a four-character raw key survives the mask intact', () => {
    expect(maskApiKey('ABCD')).toBe('ABCD…');
    expect(maskApiKey('ABCD').slice(0, 4)).toBe('ABCD');
  });

  test('the create view therefore stores a short raw key in the clear', () => {
    const view = buildApiKeyCreateView({
      id: 'k-1',
      tenantId: 't-1',
      prefix: 'du_live_',
      label: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      rawKey: 'ABCD',
    });
    expect(view.maskedHint).toBe('ABCD…');
    expect(JSON.stringify(view)).toContain('ABCD');
  });

  test('one character below the threshold the key is fully masked instead', () => {
    // The guard sits at exactly 4, so the mask is discontinuous there: 3 chars
    // are hidden, 4 are revealed. Pinned so the boundary cannot drift.
    expect(maskApiKey('ABC')).toBe('•••…');
    expect(maskApiKey('ABCD')).toBe('ABCD…');
  });

  test('a realistically long key exposes only the first four characters', () => {
    const view = buildApiKeyCreateView({
      id: 'k-1',
      tenantId: 't-1',
      prefix: 'du_live_',
      label: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      rawKey: WADMUX10_SECRET,
    });
    expect(view.maskedHint).toBe('du_l…');
    expect(JSON.stringify(view)).not.toContain(WADMUX10_SECRET);
    expect(JSON.stringify(view)).not.toContain('SUPERSECRET');
  });

  test('falsy non-string input masks to the empty string rather than echoing', () => {
    for (const bad of [null, undefined, 0] as unknown[]) {
      expect(maskApiKey(bad as string)).toBe('');
    }
  });

  // A truthy non-string has no .length, so '•'.repeat(undefined) yields '' and
  // the caller gets a bare ellipsis - a mask that discloses nothing at all.
  test('a truthy non-string yields a bare ellipsis', () => {
    for (const bad of [12345, {}, [], true] as unknown[]) {
      expect(maskApiKey(bad as string)).toBe('…');
    }
  });

  test('a whitespace-only raw key claims the copy-once window is open', () => {
    const view = buildApiKeyCreateView({
      id: 'k-1',
      tenantId: 't-1',
      prefix: 'du_live_',
      label: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      rawKey: '   ',
    });
    expect(view.copyOnceAvailable).toBe(true);
    expect(view.maskedHint).toBe('•••…');
  });

  test('a null raw key throws rather than being treated as acknowledged', () => {
    // rawKey.length is read unguarded, so the "required" contract is enforced
    // by a crash, not by a graceful empty hint.
    expect(() =>
      buildApiKeyCreateView({
        id: 'k-1',
        tenantId: 't-1',
        prefix: 'du_live_',
        label: null,
        createdAt: '2026-09-23T00:00:00.000Z',
        rawKey: null as never,
      }),
    ).toThrow(TypeError);
  });

  test('maskedHint supplied by the wire is never validated or re-masked', () => {
    // The list and confirm views trust maskedHint completely: a server that
    // sent a full raw key there would have it rendered verbatim.
    const list = buildApiKeyListView([baseRow({ maskedHint: WADMUX10_SECRET })]);
    expect(JSON.stringify(list)).toContain(WADMUX10_SECRET);

    const confirm = buildApiKeyRevokeConfirm(baseRow({ maskedHint: WADMUX10_SECRET }));
    expect(JSON.stringify(confirm)).toContain(WADMUX10_SECRET);
  });
});

// ---------------------------------------------------------------------------
// 2. Expired key badge degradation
// ---------------------------------------------------------------------------

describe('W-ADM-UX-10: there is no EXPIRED status, and supplying one crashes the list', () => {
  // DEFECT, and the sharpest one in this packet. ApiKeyStatus is
  // ACTIVE | REVOKING | REVOKED - there is no expired state at all, so the
  // natural server-side value throws instead of degrading.
  const unknownStatus: string[] = ['EXPIRED', 'BOGUS', '', 'Active', 'ACTIVE '];

  test.each(unknownStatus)('apiKeyStatusBadge(%p) throws a TypeError', (status) => {
    expect(() => apiKeyStatusBadge(status as never)).toThrow(TypeError);
  });

  test.each(unknownStatus)('apiKeyStatusLabel(%p) throws a TypeError', (status) => {
    expect(() => apiKeyStatusLabel(status as never)).toThrow(TypeError);
  });

  test('an EXPIRED status takes down the entire list projection, not just one row', () => {
    expect(() => buildApiKeyListView([baseRow({ status: 'EXPIRED' as never })])).toThrow(TypeError);
  });

  test('the three declared statuses still resolve (control)', () => {
    const cases: Array<[ApiKeyStatus, string, string]> = [
      ['ACTIVE', 'success', 'Active'],
      ['REVOKING', 'warning', 'Revoking'],
      ['REVOKED', 'error', 'Revoked'],
    ];
    for (const [status, badge, label] of cases) {
      expect(apiKeyStatusBadge(status)).toBe(badge);
      expect(apiKeyStatusLabel(status)).toBe(label);
    }
  });

  test('the lookup is case-sensitive and does not trim', () => {
    expect(() => apiKeyStatusBadge('Active' as never)).toThrow(TypeError);
    expect(() => apiKeyStatusBadge('ACTIVE ' as never)).toThrow(TypeError);
    expect(apiKeyStatusBadge('ACTIVE')).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed scope / grant arrays
// ---------------------------------------------------------------------------

describe('W-ADM-UX-10: malformed grant arrays (the closest analogue to a scope array)', () => {
  // NOTE: the packet asks for "malformed scope arrays", but ApiKeyRow carries
  // no scopes field at all - its keys are createdAt, id, label, lastUsedAt,
  // maskedHint, prefix, revokedAt, status, tenantId. Authorisation scopes
  // live in the separate grant list consumed by buildApiKeyAssignmentView,
  // so that is what these tests exercise.
  const grant = (o: Partial<ApiKeyGrantRow> = {}): ApiKeyGrantRow => ({
    businessId: 'b',
    businessVersion: '1.0.0',
    action: 'review',
    grantedAt: '2026-09-23T00:00:00.000Z',
    ...o,
  });

  test('a null grant list throws', () => {
    expect(() => buildApiKeyAssignmentView(baseRow(), null as never)).toThrow(TypeError);
  });

  test('a string grant list throws (map is not a function)', () => {
    expect(() => buildApiKeyAssignmentView(baseRow(), 'abc' as never)).toThrow(TypeError);
  });

  test('a null element inside the grant list throws', () => {
    expect(() => buildApiKeyAssignmentView(baseRow(), [null as never])).toThrow(TypeError);
  });

  test('a hole in the grant list is preserved and counted in the total', () => {
    const sparse = [grant(), , grant({ action: 'x' })] as never;
    const view = buildApiKeyAssignmentView(baseRow(), sparse);
    expect(view.totalGrants).toBe(3);
    expect(view.grants).toHaveLength(3);
    expect(view.grants[1]).toBeUndefined();
  });

  test('hostile grant strings are passed through unescaped', () => {
    const view = buildApiKeyAssignmentView(
      baseRow(),
      [grant({ businessId: WADMUX10_XSS, action: '"><img src=x onerror=alert(1)>' })],
    );
    expect(view.grants[0]!.businessId).toBe(WADMUX10_XSS);
    expect(view.grants[0]!.action).toBe('"><img src=x onerror=alert(1)>');
  });

  test('a null grant list element in the LIST view shape is equally unhandled', () => {
    expect(() => buildApiKeyListView([null as never])).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 4. Revoked key action guards
// ---------------------------------------------------------------------------

describe('W-ADM-UX-10: the revoke guard reads status only and ignores revokedAt', () => {
  const revokable: string[] = ['ACTIVE'];
  const denied: string[] = ['REVOKING', 'REVOKED', 'EXPIRED', 'BOGUS', ''];

  test.each(revokable)('canRevokeApiKey(%p) is true', (status) => {
    expect(canRevokeApiKey({ status: status as ApiKeyStatus })).toBe(true);
  });

  test.each(denied)('canRevokeApiKey(%p) is false', (status) => {
    expect(canRevokeApiKey({ status: status as ApiKeyStatus })).toBe(false);
  });

  // DEFECT: canRevokeApiKey compares status alone, so a key the server has
  // already stamped with a revokedAt date is still offered for revocation.
  test('an ACTIVE key that already carries a revokedAt is still revokable', () => {
    const row = baseRow({ status: 'ACTIVE', revokedAt: '2026-01-01T00:00:00.000Z' });
    expect(row.revokedAt).not.toBeNull();
    expect(canRevokeApiKey(row)).toBe(true);
  });

  test('the list row agrees with the guard on that contradiction', () => {
    const view = buildApiKeyListView([
      baseRow({ status: 'ACTIVE', revokedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(view.rows[0]!.canRevoke).toBe(true);
    expect(view.rows[0]!.revokedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('the reverse contradiction - REVOKED with no revokedAt - is not detected', () => {
    const view = buildApiKeyListView([baseRow({ status: 'REVOKED', revokedAt: null })]);
    expect(view.rows[0]!.status).toBe('REVOKED');
    expect(view.rows[0]!.revokedAt).toBeNull();
    expect(view.rows[0]!.canRevoke).toBe(false);
  });

  test('the revoke confirm mirrors the guard for a revoked key', () => {
    const confirm = buildApiKeyRevokeConfirm(baseRow({ status: 'REVOKED' }));
    expect(confirm.confirmDisabled).toBe(true);
    expect(confirm.status).toBe('REVOKED');
  });

  test('the revoke confirm degrades where the list crashes', () => {
    // It never touches the status meta table, so an unknown status leaves the
    // button safely disabled instead of throwing. Worth knowing: the two
    // surfaces disagree about how an unknown status is handled.
    const confirm = buildApiKeyRevokeConfirm(baseRow({ status: 'BOGUS' as never }));
    expect(confirm.confirmDisabled).toBe(true);
    expect(() => buildApiKeyListView([baseRow({ status: 'BOGUS' as never })])).toThrow(TypeError);
  });

  test('the confirm warning is a constant and cannot echo a key', () => {
    const confirm = buildApiKeyRevokeConfirm(baseRow({ id: WADMUX10_SECRET }));
    expect(confirm.warning).not.toContain(WADMUX10_SECRET);
    expect(confirm.warning.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Corrupt timestamps
// ---------------------------------------------------------------------------

describe('W-ADM-UX-10: no timestamp is ever parsed, so corruption is invisible', () => {
  // There is no date handling anywhere in this module: createdAt,
  // lastUsedAt, revokedAt and grantedAt are copied through as opaque strings.
  const corrupt: string[] = [
    'garbage',
    'not-a-date',
    '2026-13-45T99:99:99Z',
    '2026-02-30T00:00:00.000Z',
    '',
  ];

  test.each(corrupt)('a corrupt createdAt %p reaches the list row verbatim', (createdAt) => {
    const view = buildApiKeyListView([baseRow({ createdAt })]);
    expect(view.rows[0]!.createdAt).toBe(createdAt);
  });

  test.each(corrupt)('a corrupt lastUsedAt %p reaches the list row verbatim', (lastUsedAt) => {
    const view = buildApiKeyListView([baseRow({ lastUsedAt })]);
    expect(view.rows[0]!.lastUsedAt).toBe(lastUsedAt);
  });

  test.each(corrupt)('a corrupt revokedAt %p reaches the list row verbatim', (revokedAt) => {
    const view = buildApiKeyListView([baseRow({ revokedAt })]);
    expect(view.rows[0]!.revokedAt).toBe(revokedAt);
  });

  test('a corrupt grantedAt reaches the assignment row verbatim and is still counted', () => {
    const view = buildApiKeyAssignmentView(
      baseRow(),
      [
        {
          businessId: 'b',
          businessVersion: '1.0.0',
          action: 'review',
          grantedAt: 'garbage',
        },
      ],
    );
    expect(view.grants[0]!.grantedAt).toBe('garbage');
    expect(view.totalGrants).toBe(1);
  });

  test('a corrupt createdAt in the create view is copied through unchanged', () => {
    const view = buildApiKeyCreateView({
      id: 'k-1',
      tenantId: 't-1',
      prefix: 'du_live_',
      label: null,
      createdAt: 'garbage',
      rawKey: 'du_live_abcdefgh',
    });
    expect(view.createdAt).toBe('garbage');
  });

  test('because nothing is parsed, a rolled-over date is indistinguishable from a valid one', () => {
    // 2026-02-30 is not a real date, but this module has no opinion on that,
    // so it is as good as any other string to the renderer.
    const rolled = '2026-02-30T00:00:00.000Z';
    const view = buildApiKeyListView([baseRow({ createdAt: rolled }), baseRow({ createdAt: '2026-03-02T00:00:00.000Z' })]);
    expect(view.rows[0]!.createdAt).toBe(rolled);
    expect(view.rows[0]!.createdAt).not.toBe(view.rows[1]!.createdAt);
  });

  test('total counts rows, not distinct keys, even when timestamps collide', () => {
    const same = '2026-09-23T00:00:00.000Z';
    const view = buildApiKeyListView([
      baseRow({ id: 'a', createdAt: same }),
      baseRow({ id: 'a', createdAt: same }),
    ]);
    expect(view.total).toBe(2);
    expect(view.rows).toHaveLength(2);
  });
});

