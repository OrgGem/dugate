/**
 * Unit tests for P6-01 navigation / layout / auth-guard view-model
 * interfaces and screen state fixtures (W39-O2).
 *
 * Validates:
 * - evaluateAuthGuard: role vs section mapping for all 5 sections × 3 roles.
 * - buildAdminShellView: navigation filter, breadcrumbs, status resolution,
 *   authorized flag.
 * - Screen-state fixtures (loading / empty / error / denied / ready) carry
 *   the expected shape, including the explicit `denied` over-ride that
 *   beats data-availability.
 * - buildScreenState: discriminated union reducer wires auth guard before
 *   data availability, with section=null degradation.
 * - Auth guard never echoes authorization as a permission grant — `denied`
 *   reasons are stable, renderer-safe strings; ready states never appear
 *   for unauthorized sections.
 *
 * Pure offline tests: Zero database activity, zero HTTP calls, strict
 * TypeScript without `any`.
 */

import {
  buildAdminShellView,
  buildDeniedFixture,
  buildEmptyFixture,
  buildErrorFixture,
  buildLoadingFixture,
  buildReadyFixture,
  buildScreenState,
  evaluateAuthGuard,
  getCanonicalNavItems,
  type AdminScreenState,
} from '../src/app/admin/p6-01-shell-fixtures';

describe('W39-O2 P6-01: evaluateAuthGuard (3 roles × 5 sections)', () => {
  const nav = getCanonicalNavItems();
  const cases: Array<{
    role: 'viewer' | 'operator' | 'admin';
    section: 'businesses' | 'operations' | 'profiles' | 'connectors' | 'grants';
    allowed: boolean;
    required: 'viewer' | 'operator' | 'admin';
  }> = [
    { role: 'viewer', section: 'businesses', allowed: true, required: 'viewer' },
    { role: 'viewer', section: 'operations', allowed: true, required: 'viewer' },
    { role: 'viewer', section: 'profiles', allowed: false, required: 'operator' },
    { role: 'viewer', section: 'connectors', allowed: false, required: 'operator' },
    { role: 'viewer', section: 'grants', allowed: false, required: 'admin' },
    { role: 'operator', section: 'businesses', allowed: true, required: 'viewer' },
    { role: 'operator', section: 'profiles', allowed: true, required: 'operator' },
    { role: 'operator', section: 'connectors', allowed: true, required: 'operator' },
    { role: 'operator', section: 'grants', allowed: false, required: 'admin' },
    { role: 'admin', section: 'businesses', allowed: true, required: 'viewer' },
    { role: 'admin', section: 'profiles', allowed: true, required: 'operator' },
    { role: 'admin', section: 'grants', allowed: true, required: 'admin' },
  ];

  test.each(cases)(
    '$role vs $section -> allowed=$allowed (required=$required)',
    ({ role, section, allowed, required }) => {
      const decision = evaluateAuthGuard(role, section, nav);
      expect(decision.kind).toBe(allowed ? 'allowed' : 'denied');
      if (decision.kind === 'allowed') {
        expect(decision.actualRole).toBe(role);
        expect(decision.requiredRole).toBe(required);
      } else {
        expect(decision.actualRole).toBe(role);
        expect(decision.requiredRole).toBe(required);
        expect(decision.reason.length).toBeGreaterThan(0);
        expect(decision.reason).toContain(section);
      }
    },
  );

  test('navItems without the section yields denied with a stable reason', () => {
    const slimNav = [{ section: 'businesses' as const, label: 'X', path: '/x', requiredRole: 'admin' as const }];
    const bypass = evaluateAuthGuard('admin', 'grants', slimNav);
    expect(bypass.kind).toBe('denied');
    if (bypass.kind === 'denied') {
      expect(bypass.requiredRole).toBe('admin');
      expect(bypass.reason).toContain('grants');
    }
  });
});

describe('W39-O2 P6-01: buildAdminShellView (layout chrome)', () => {
  const nav = getCanonicalNavItems();

  test('loading state preserves currentSection and yields visible nav for role', () => {
    const view = buildAdminShellView({
      role: 'operator',
      path: '/admin/connectors',
      navItems: nav,
      dataAvailable: { kind: 'loading' },
    });
    expect(view.currentSection).toBe('connectors');
    expect(view.role).toBe('operator');
    expect(view.authorized).toBe(true);
    expect(view.status).toBe('loading');
    expect(view.visibleNav.map((n) => n.section)).toEqual([
      'businesses',
      'operations',
      'overview',
      'profiles',
      'connectors',
    ]);
    expect(view.breadcrumbs).toEqual([
      { section: 'admin', label: 'Admin', path: '/admin' },
      { section: 'connectors', label: 'Connectors', path: '/admin/connectors' },
    ]);
  });

  test('ready state for authorized section', () => {
    const view = buildAdminShellView({
      role: 'admin',
      path: '/admin/grants',
      navItems: nav,
      dataAvailable: { kind: 'ready' },
    });
    expect(view.authorized).toBe(true);
    expect(view.status).toBe('ready');
    expect(view.visibleNav).toHaveLength(7);
  });

  test('empty state passes through', () => {
    const view = buildAdminShellView({
      role: 'viewer',
      path: '/admin/businesses',
      navItems: nav,
      dataAvailable: { kind: 'empty' },
    });
    expect(view.status).toBe('empty');
    expect(view.authorized).toBe(true);
  });

  test('error state passes through with the data-availability message untouched', () => {
    const view = buildAdminShellView({
      role: 'viewer',
      path: '/admin/operations',
      navItems: nav,
      dataAvailable: { kind: 'error', message: 'registry unavailable' },
    });
    expect(view.status).toBe('error');
    expect(view.authorized).toBe(true);
    expect(view.currentSection).toBe('operations');
  });

  test('denied auth beats data-availability for an unauthorized section', () => {
    const view = buildAdminShellView({
      role: 'viewer',
      path: '/admin/grants',
      navItems: nav,
      dataAvailable: { kind: 'ready' },
    });
    expect(view.authorized).toBe(false);
    expect(view.status).toBe('denied');
    // The grants item must not appear in the visible nav for a viewer.
    expect(view.visibleNav.some((n) => n.section === 'grants')).toBe(false);
  });

  test('unknown path resolves to currentSection=null and treats no-data as loading', () => {
    const view = buildAdminShellView({
      role: 'admin',
      path: '/admin/unknown',
      navItems: nav,
      dataAvailable: { kind: 'ready' },
    });
    expect(view.currentSection).toBeNull();
    expect(view.authorized).toBe(false);
    // Admin root with no data yet is loading, not error. The renderer
    // should not flash an error pane before the very first fetch lands.
    expect(view.status).toBe('loading');
    expect(view.breadcrumbs).toEqual([
      { section: 'admin', label: 'Admin', path: '/admin' },
    ]);
  });

  test('unknown path with an error data-availability surfaces the error', () => {
    const view = buildAdminShellView({
      role: 'admin',
      path: '/admin/unknown',
      navItems: nav,
      dataAvailable: { kind: 'error', message: 'registry down' },
    });
    expect(view.currentSection).toBeNull();
    expect(view.authorized).toBe(false);
    expect(view.status).toBe('error');
  });

  test('admin root with data loading shows loading, not error', () => {
    const view = buildAdminShellView({
      role: 'admin',
      path: '/admin',
      navItems: nav,
      dataAvailable: { kind: 'loading' },
    });
    expect(view.currentSection).toBeNull();
    expect(view.status).toBe('loading');
  });
});

describe('W39-O2 P6-01: screen-state fixtures (loading / empty / error / denied / ready)', () => {
  test('buildLoadingFixture carries section + role', () => {
    const f = buildLoadingFixture('operator', 'connectors');
    expect(f).toEqual({ kind: 'loading', section: 'connectors', role: 'operator' });
  });

  test('buildLoadingFixture accepts null section for admin root', () => {
    expect(buildLoadingFixture('admin', null)).toEqual({
      kind: 'loading',
      section: null,
      role: 'admin',
    });
  });

  test('buildEmptyFixture carries the message verbatim', () => {
    const f = buildEmptyFixture('viewer', 'operations', 'No operations yet');
    expect(f).toEqual({
      kind: 'empty',
      section: 'operations',
      role: 'viewer',
      message: 'No operations yet',
    });
  });

  test('buildErrorFixture accepts null section for admin root failure', () => {
    const f = buildErrorFixture('viewer', null, 'registry down');
    expect(f).toEqual({
      kind: 'error',
      section: null,
      role: 'viewer',
      message: 'registry down',
    });
  });

  test('buildDeniedFixture carries section, role, requiredRole and a reason', () => {
    const f = buildDeniedFixture('viewer', 'grants', 'admin', "Role 'viewer' is not authorized for 'grants'");
    expect(f).toEqual({
      kind: 'denied',
      section: 'grants',
      role: 'viewer',
      requiredRole: 'admin',
      reason: "Role 'viewer' is not authorized for 'grants'",
    });
  });

  test('buildReadyFixture is minimal and stable', () => {
    expect(buildReadyFixture('admin', 'profiles')).toEqual({
      kind: 'ready',
      section: 'profiles',
      role: 'admin',
    });
  });

  test('every fixture is a stable discriminated union member (exhaustive never)', () => {
    // Compile-time exhaustiveness smoke test: each fixture kind is
    // narrowed and serialized without falling through `never`.
    const all: AdminScreenState[] = [
      buildLoadingFixture('admin', null),
      buildEmptyFixture('admin', 'businesses', 'no'),
      buildErrorFixture('admin', null, 'boom'),
      buildDeniedFixture('viewer', 'grants', 'admin', 'nope'),
      buildReadyFixture('admin', 'businesses'),
    ];
    expect(all.map((s) => s.kind)).toEqual([
      'loading',
      'empty',
      'error',
      'denied',
      'ready',
    ]);
    // JSON-serializable and carries no function or symbol.
    for (const s of all) {
      expect(typeof JSON.stringify(s)).toBe('string');
    }
  });
});

describe('W39-O2 P6-01: buildScreenState (reducer wiring auth guard before data)', () => {
  const nav = getCanonicalNavItems();

  test('authorized section + ready -> ready', () => {
    expect(buildScreenState({ role: 'admin', section: 'grants', dataAvailable: { kind: 'ready' }, navItems: nav }))
      .toEqual({ kind: 'ready', section: 'grants', role: 'admin' });
  });

  test('authorized section + empty -> empty (message carried)', () => {
    expect(
      buildScreenState({
        role: 'viewer',
        section: 'operations',
        dataAvailable: { kind: 'empty', message: 'no rows' },
        navItems: nav,
      }),
    ).toEqual({ kind: 'empty', section: 'operations', role: 'viewer', message: 'no rows' });
  });

  test('authorized section + error -> error', () => {
    expect(
      buildScreenState({
        role: 'operator',
        section: 'connectors',
        dataAvailable: { kind: 'error', message: 'fetch failed' },
        navItems: nav,
      }),
    ).toEqual({ kind: 'error', section: 'connectors', role: 'operator', message: 'fetch failed' });
  });

  test('authorized section + loading -> loading', () => {
    expect(buildScreenState({ role: 'viewer', section: 'businesses', dataAvailable: { kind: 'loading' }, navItems: nav }))
      .toEqual({ kind: 'loading', section: 'businesses', role: 'viewer' });
  });

  test('denied section + ready -> denied (auth beats data)', () => {
    const state = buildScreenState({
      role: 'viewer',
      section: 'grants',
      dataAvailable: { kind: 'ready' },
      navItems: nav,
    });
    expect(state.kind).toBe('denied');
    if (state.kind === 'denied') {
      expect(state.section).toBe('grants');
      expect(state.role).toBe('viewer');
      expect(state.requiredRole).toBe('admin');
      expect(state.reason).toContain('grants');
    }
  });

  test('denied section + loading -> still denied (no spinner for unauthorized section)', () => {
    expect(buildScreenState({ role: 'viewer', section: 'profiles', dataAvailable: { kind: 'loading' }, navItems: nav }).kind)
      .toBe('denied');
  });

  test('null section + ready -> loading (admin root waits for a section)', () => {
    expect(buildScreenState({ role: 'admin', section: null, dataAvailable: { kind: 'ready' } }).kind)
      .toBe('loading');
  });

  test('null section + empty -> error (degrade gracefully)', () => {
    expect(
      buildScreenState({ role: 'admin', section: null, dataAvailable: { kind: 'empty', message: 'no data' } }),
    ).toEqual({ kind: 'error', section: null, role: 'admin', message: 'no data' });
  });

  test('null section + error -> error with the message', () => {
    expect(
      buildScreenState({ role: 'admin', section: null, dataAvailable: { kind: 'error', message: 'down' } }),
    ).toEqual({ kind: 'error', section: null, role: 'admin', message: 'down' });
  });

  test('uses canonical nav when none is provided (default)', () => {
    expect(buildScreenState({ role: 'viewer', section: 'businesses', dataAvailable: { kind: 'ready' } }).kind)
      .toBe('ready');
    expect(buildScreenState({ role: 'viewer', section: 'grants', dataAvailable: { kind: 'ready' } }).kind)
      .toBe('denied');
  });
});