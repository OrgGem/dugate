/**
 * Pure P6-01 Admin navigation / layout / auth-guard view-model interfaces
 * and screen state fixtures (W39-O2 headless slice).
 *
 * Scope: explicit, renderer-agnostic shapes for the Admin shell — the
 * navigation role guard, the layout chrome (current section, breadcrumbs,
 * visible nav items), and the screen-state fixtures for the four
 * acceptance states a renderer must handle uniformly: loading, empty,
 * error, denied. Each fixture carries a stable test-friendly shape so a
 * future rendered shell can be unit-tested against the same projection
 * without any framework or DB dependency.
 *
 * Hard rule: the admin UI may not grant authorization. These fixtures
 * only describe what a renderer with a given role *may display*. The
 * server enforces all authorization independently.
 *
 * Pure and offline: Zero DB activity, zero HTTP I/O, zero framework
 * dependencies, strict TypeScript with zero `any`.
 */

import type {
  AdminRole,
  AdminSection,
  NavItem,
} from './types';
import { ROLE_ORDER } from './types';

// ---------------------------------------------------------------------------
// Auth guard view-model
// ---------------------------------------------------------------------------

/**
 * The decision a renderer can make about whether the current operator
 * may view the requested section. Display-only; the server must still
 * enforce the same authorization. `reason` is a stable, renderer-safe
 * string the renderer can show in a "denied" pane.
 */
export type AuthGuardDecision =
  | { kind: 'allowed'; requiredRole: AdminRole; actualRole: AdminRole }
  | { kind: 'denied'; requiredRole: AdminRole; actualRole: AdminRole; reason: string };

/**
 * Pure auth-guard projection for a single (role, section) pair.
 *
 * - `viewer` and `operator` may see `businesses`, `operations` and `overview`.
 * - `admin` may additionally see `profiles`, `connectors`, `grants` and
 *   `api-keys` (profiles/connectors are admin-gated per the platform RBAC).
 *
 * A request whose section is unknown to the canonical nav (defensive)
 * is treated as denied: the server is the source of truth, and the UI
 * must never render a section it cannot authorize.
 */
export function evaluateAuthGuard(
  role: AdminRole,
  section: AdminSection,
  navItems: readonly NavItem[],
): AuthGuardDecision {
  const item = navItems.find((n) => n.section === section);
  if (!item) {
    return {
      kind: 'denied',
      requiredRole: 'admin',
      actualRole: role,
      reason: `Unknown section '${section}'`,
    };
  }
  if (ROLE_ORDER[role] >= ROLE_ORDER[item.requiredRole]) {
    return { kind: 'allowed', requiredRole: item.requiredRole, actualRole: role };
  }
  return {
    kind: 'denied',
    requiredRole: item.requiredRole,
    actualRole: role,
    reason: `Role '${role}' is not authorized for '${section}' (requires '${item.requiredRole}')`,
  };
}

// ---------------------------------------------------------------------------
// Layout-shell view-model
// ---------------------------------------------------------------------------

/**
 * Breadcrumb entry for the layout header. The first entry is the
 * Admin root; subsequent entries are the path down to the current
 * section.
 */
export interface BreadcrumbEntry {
  /** Section the entry points to. The last entry equals the current section. */
  section: AdminSection | 'admin';
  /** Stable label safe to render as link text. */
  label: string;
  /** Stable path under the admin root (e.g. `/admin/businesses/biz-1`). */
  path: string;
}

export interface AdminShellView {
  /** Currently displayed section. `null` only for the admin root. */
  currentSection: AdminSection | null;
  /** Current path under the admin root. */
  currentPath: string;
  /** Operator's role; the layout shows a role badge derived from this. */
  role: AdminRole;
  /** Nav items visible to the current role, in canonical order. */
  visibleNav: NavItem[];
  /** True when the current section's path matches a nav item's required role. */
  authorized: boolean;
  /** Breadcrumbs from the admin root down to the current section. */
  breadcrumbs: BreadcrumbEntry[];
  /** Renderer-safe shell status (loading / empty / error / denied / ready). */
  status: PageStatus;
}

export type PageStatus = 'loading' | 'empty' | 'error' | 'denied' | 'ready';

/**
 * Build the layout-shell view model for a given role, path and data
 * availability. The `dataAvailable` flag drives the loading / empty /
 * error / denied / ready status; the auth guard independently drives
 * `authorized` and the `status` when the role check fails.
 */
export interface ShellBuildInput {
  role: AdminRole;
  path: string;
  navItems: readonly NavItem[];
  /** Whether the underlying data fetch is in progress. */
  dataAvailable:
    | { kind: 'loading' }
    | { kind: 'empty' }
    | { kind: 'error'; message: string }
    | { kind: 'ready' };
}

export function buildAdminShellView(input: ShellBuildInput): AdminShellView {
  const { role, path, navItems, dataAvailable } = input;

  const visibleNav = navItems.filter(
    (item) => ROLE_ORDER[role] >= ROLE_ORDER[item.requiredRole],
  );

  const hit = navItems.find(
    (item) => path === item.path || path.startsWith(item.path + '/'),
  );
  const currentSection = hit ? hit.section : null;

  // Auth guard: deny when a section is resolved but the role is short of
  // the required role, or when the path resolves to nothing the renderer
  // recognizes.
  const authorized = currentSection !== null
    && ROLE_ORDER[role] >= ROLE_ORDER[hit!.requiredRole];

  // Status: data-availability dominates, but a denied auth check always
  // overrides everything else — the renderer should never show "empty"
  // or "ready" content for an unauthorized section. An unknown path
  // (currentSection === null) is only treated as an error when the
  // renderer actually has data to show; otherwise it is loading.
  let status: PageStatus;
  if (!authorized && currentSection !== null) {
    status = 'denied';
  } else if (currentSection === null) {
    // Admin root with no data yet: spinner, not error. Error only
    // surfaces when the caller passes `error` data availability.
    status = dataAvailable.kind === 'error' ? 'error' : 'loading';
  } else {
    switch (dataAvailable.kind) {
      case 'loading':
        status = 'loading';
        break;
      case 'empty':
        status = 'empty';
        break;
      case 'error':
        status = 'error';
        break;
      case 'ready':
        status = 'ready';
        break;
    }
  }

  // Breadcrumbs: root + current section.
  const breadcrumbs: BreadcrumbEntry[] = [
    { section: 'admin', label: 'Admin', path: '/admin' },
  ];
  if (hit) {
    breadcrumbs.push({ section: hit.section, label: hit.label, path: hit.path });
  }

  return {
    currentSection,
    currentPath: path,
    role,
    visibleNav,
    authorized,
    breadcrumbs,
    status,
  };
}

// ---------------------------------------------------------------------------
// Screen-state fixtures (P6-01 acceptance: loading / empty / error / denied)
// ---------------------------------------------------------------------------

/**
 * Stable screen-state fixture the renderer dispatches on. Mirrors the
 * discriminated `PageState` from `./types` but is bound to the shell
 * (carries the current section + role) so a renderer can render the
 * right chrome around the pane.
 */
export type AdminScreenState =
  | { kind: 'loading'; section: AdminSection | null; role: AdminRole }
  | { kind: 'empty'; section: AdminSection; role: AdminRole; message: string }
  | { kind: 'error'; section: AdminSection | null; role: AdminRole; message: string }
  | {
      kind: 'denied';
      section: AdminSection;
      role: AdminRole;
      requiredRole: AdminRole;
      reason: string;
    }
  | { kind: 'ready'; section: AdminSection; role: AdminRole };

const NAV_ITEMS: readonly NavItem[] = [
  { section: 'businesses', label: 'Businesses', path: '/admin/businesses', requiredRole: 'viewer' },
  { section: 'operations', label: 'Operations', path: '/admin/operations', requiredRole: 'viewer' },
  { section: 'overview', label: 'Overview', path: '/admin/overview', requiredRole: 'viewer' },
  { section: 'profiles', label: 'Profiles', path: '/admin/profiles', requiredRole: 'admin' },
  { section: 'connectors', label: 'Connectors', path: '/admin/connectors', requiredRole: 'admin' },
  { section: 'grants', label: 'Grants', path: '/admin/grants', requiredRole: 'admin' },
  { section: 'api-keys', label: 'API keys', path: '/admin/api-keys', requiredRole: 'admin' },
];

export function getCanonicalNavItems(): readonly NavItem[] {
  return NAV_ITEMS;
}

/**
 * Build the loading fixture. Section is the requested section; role is
 * the operator's role. The renderer shows a spinner pane with the
 * current section header still visible.
 */
export function buildLoadingFixture(
  role: AdminRole,
  section: AdminSection | null,
): AdminScreenState {
  return { kind: 'loading', section, role };
}

/**
 * Build the empty fixture. The section must be a known admin section;
 * an empty state never represents "you are not allowed here" — that
 * is the `denied` fixture.
 */
export function buildEmptyFixture(
  role: AdminRole,
  section: AdminSection,
  message: string,
): AdminScreenState {
  return { kind: 'empty', section, role, message };
}

/**
 * Build the error fixture. Section may be `null` (e.g. admin root
 * fetch failed) or a known section (data fetch for that section
 * failed).
 */
export function buildErrorFixture(
  role: AdminRole,
  section: AdminSection | null,
  message: string,
): AdminScreenState {
  return { kind: 'error', section, role, message };
}

/**
 * Build the denied fixture. Always carries the section, the role, the
 * required role, and a stable, renderer-safe reason string. Pure
 * projection — never invents an authorization verdict.
 */
export function buildDeniedFixture(
  role: AdminRole,
  section: AdminSection,
  requiredRole: AdminRole,
  reason: string,
): AdminScreenState {
  return { kind: 'denied', section, role, requiredRole, reason };
}

/**
 * Build the ready fixture. The section is a known admin section the
 * role is authorized to see; the renderer shows the regular pane.
 */
export function buildReadyFixture(
  role: AdminRole,
  section: AdminSection,
): AdminScreenState {
  return { kind: 'ready', section, role };
}

/**
 * Reduce the canonical (role, section) + data-availability into the
 * discriminated `AdminScreenState`. The auth guard runs first; a
 * denied section is never reported as ready even when data is
 * available.
 */
export function buildScreenState(input: {
  role: AdminRole;
  section: AdminSection | null;
  dataAvailable:
    | { kind: 'loading' }
    | { kind: 'empty'; message: string }
    | { kind: 'error'; message: string }
    | { kind: 'ready' };
  navItems?: readonly NavItem[];
}): AdminScreenState {
  const items = input.navItems ?? NAV_ITEMS;
  if (input.section !== null) {
    const guard = evaluateAuthGuard(input.role, input.section, items);
    if (guard.kind === 'denied') {
      return buildDeniedFixture(
        input.role,
        input.section,
        guard.requiredRole,
        guard.reason,
      );
    }
    switch (input.dataAvailable.kind) {
      case 'loading':
        return buildLoadingFixture(input.role, input.section);
      case 'empty':
        return buildEmptyFixture(
          input.role,
          input.section,
          input.dataAvailable.message,
        );
      case 'error':
        return buildErrorFixture(
          input.role,
          input.section,
          input.dataAvailable.message,
        );
      case 'ready':
        return buildReadyFixture(input.role, input.section);
    }
  }
  // No section resolved (admin root, or unknown path).
  switch (input.dataAvailable.kind) {
    case 'loading':
      return buildLoadingFixture(input.role, null);
    case 'empty':
      // No section to attach the empty message to — degrade to error.
      return buildErrorFixture(input.role, null, input.dataAvailable.message);
    case 'error':
      return buildErrorFixture(input.role, null, input.dataAvailable.message);
    case 'ready':
      // Admin root with no data is a loading state (the chrome
      // decides what to show); callers should pass `loading` instead.
      return buildLoadingFixture(input.role, null);
  }
}
