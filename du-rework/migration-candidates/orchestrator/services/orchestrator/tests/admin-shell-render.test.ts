/**
 * Focused renderer/fetcher tests for P6-01 shell.
 * Fixtures stay local to this pane; no shared fixture builder is needed.
 */

import { buildAdminShellView, buildScreenState, getCanonicalNavItems } from '../src/app/admin/p6-01-shell-fixtures';
import type { AdminRole, AdminSection } from '../src/app/admin/types';
import { esc, h, renderDocument, renderErrorPage, renderLoginPage, renderNode, renderShell, wrapTablesForReflow } from '../src/app/admin/shell-render';

describe("admin-shell renderer (P6-01)", () => {
describe('esc', () => {
    it('escapes the five HTML-sensitive characters', () => {
      // &, <, >, ", ' all escaped
      const AMP = '&';
      const LT = '<';
      const GT = '>';
      const QT = '"';
      const AP = "'";
      expect(esc(AMP)).toBe('&amp;');
      expect(esc(LT)).toBe('&lt;');
      expect(esc(GT)).toBe('&gt;');
      expect(esc(QT)).toBe('&quot;');
      expect(esc(AP)).toBe('&#39;');
      // All five characters in the input string (`<`, `"`, `>`,
      // `&`, `'`) must be escaped exactly once.
      expect(esc('<a href="x">&\'</a>'))
        .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    });
    it('renders null/undefined as empty', () => {
      expect(esc(null)).toBe('');
      expect(esc(undefined)).toBe('');
    });
  });

  describe('h() and renderNode', () => {
    it('renders a tag with attrs and string children', () => {
      const node = h('div', { class: 'x' }, 'hi ', h('b', undefined, 'there'));
      expect(renderNode(node)).toBe('<div class="x">hi <b>there</b></div>');
    });
    it('omits false attrs and emits bare attrs for true', () => {
      const node = h('input', { type: 'text', required: true, disabled: false });
      expect(renderNode(node)).toBe('<input type="text" required>');
    });
    it('falls back to div when tag is not in the whitelist', () => {
      const node = h('script', undefined, 'alert(1)');
      // The whitelist fallback strips the actual tag but marks the original
      // tag in a data attribute. Crucially the rendered bytes do NOT
      // contain a literal <script> tag.
      const html = renderNode(node);
      expect(html).not.toContain('<script');
      expect(html).toContain('data-block-tag="script"');
    });
  });

  describe('renderDocument', () => {
    it('emits a complete HTML5 doctype with the title and a stylesheet', () => {
      const html = renderDocument('Hello', '<main>body</main>');
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('<title>Hello</title>');
      expect(html).toContain('<main>body</main>');
      expect(html).toContain('<style>');
    });
    it('escapes the title', () => {
      const html = renderDocument('a<b>c&d', '');
      expect(html).toContain('<title>a&lt;b&gt;c&amp;d</title>');
    });
  });

  describe('renderLoginPage', () => {
    it('renders the login form with a CSRF marker', () => {
      const html = renderLoginPage({ redirect: '/admin/businesses', csrfMarker: 'tok123' });
      expect(html).toContain('<form method="POST" action="/admin/login"');
      expect(html).toContain('name="token"');
      expect(html).toContain('data-csrf="tok123"');
      expect(html).toContain('name="redirect" value="/admin/businesses"');
      expect(html).toContain('Admin sign-in');
    });
    it('renders an inline error when one is provided', () => {
      const html = renderLoginPage({ redirect: '/admin', error: 'bad token', csrfMarker: 'c' });
      expect(html).toContain('class="form-error"');
      expect(html).toContain('bad token');
    });
  });

  describe('renderErrorPage', () => {
    it('emits an HTML body with status, title, message, and a return link', () => {
      const html = renderErrorPage({ status: 403, title: 'Denied', message: 'no' });
      expect(html).toContain('Admin — 403');
      expect(html).toContain('Denied');
      expect(html).toContain('no');
      expect(html).toContain('href="/admin"');
    });
  });

  describe('renderShell — four screen states', () => {
    const navItems = getCanonicalNavItems();

    function viewFor(role: AdminRole, section: AdminSection | null, path: string) {
      return buildAdminShellView({
        role,
        path,
        navItems,
        dataAvailable: { kind: 'ready' },
      });
    }

    it('renders a loading screen state', () => {
      const view = viewFor('viewer', 'businesses', '/admin/businesses');
      const screen = buildScreenState({
        role: 'viewer',
        section: 'businesses',
        dataAvailable: { kind: 'loading' },
      });
      const html = renderShell(view, screen);
      expect(html).toContain('screen-state--loading');
      expect(html).toContain('Loading…');
    });

    it('renders an empty screen state with the message', () => {
      const view = viewFor('admin', 'profiles', '/admin/profiles');
      const screen = buildScreenState({
        role: 'admin',
        section: 'profiles',
        dataAvailable: { kind: 'empty', message: 'no profiles yet' },
      });
      const html = renderShell(view, screen);
      expect(html).toContain('screen-state--empty');
      expect(html).toContain('no profiles yet');
      expect(html).toContain('No profiles yet');
    });

    it('renders an error screen state with the message', () => {
      const view = viewFor('viewer', 'operations', '/admin/operations');
      const screen = buildScreenState({
        role: 'viewer',
        section: 'operations',
        dataAvailable: { kind: 'error', message: 'boom' },
      });
      const html = renderShell(view, screen);
      expect(html).toContain('screen-state--error');
      expect(html).toContain('boom');
      expect(html).toContain('Something went wrong');
    });

    it('renders a denied screen state with role + required role', () => {
      const view = viewFor('viewer', 'grants', '/admin/grants');
      const screen = buildScreenState({
        role: 'viewer',
        section: 'grants',
        dataAvailable: { kind: 'ready' },
      });
      const html = renderShell(view, screen);
      expect(html).toContain('screen-state--denied');
      expect(html).toContain('Role &#39;viewer&#39; is not authorized for &#39;grants&#39;');
      expect(html).toContain('requires <code>admin</code>');
    });

    it('renders the ready pane for an authorized role', () => {
      const view = viewFor('admin', 'businesses', '/admin/businesses');
      const screen = buildScreenState({
        role: 'admin',
        section: 'businesses',
        dataAvailable: { kind: 'ready' },
      });
      const html = renderShell(view, screen);
      expect(html).toContain('screen-state--ready');
      expect(html).toContain('<h2>businesses</h2>');
    });
  });

  describe('renderShell — role-filtered nav', () => {
    it('shows only viewer-accessible nav items for a viewer', () => {
      const view = buildAdminShellView({
        role: 'viewer',
        path: '/admin/businesses',
        navItems: getCanonicalNavItems(),
        dataAvailable: { kind: 'ready' },
      });
      const html = renderShell(view, buildScreenState({
        role: 'viewer', section: 'businesses', dataAvailable: { kind: 'ready' },
      }));
      expect(html).toContain('href="/admin/businesses"');
      expect(html).toContain('href="/admin/operations"');
      expect(html).not.toContain('href="/admin/profiles"');
      expect(html).not.toContain('href="/admin/connectors"');
      expect(html).not.toContain('href="/admin/grants"');
    });

    it('shows only viewer-tier nav items for an operator (no admin-gated items)', () => {
      const view = buildAdminShellView({
        role: 'operator',
        path: '/admin/operations',
        navItems: getCanonicalNavItems(),
        dataAvailable: { kind: 'ready' },
      });
      const html = renderShell(view, buildScreenState({
        role: 'operator', section: 'operations', dataAvailable: { kind: 'ready' },
      }));
      expect(html).toContain('href="/admin/businesses"');
      expect(html).toContain('href="/admin/operations"');
      expect(html).not.toContain('href="/admin/profiles"');
      expect(html).not.toContain('href="/admin/connectors"');
      expect(html).not.toContain('href="/admin/grants"');
      expect(html).not.toContain('href="/admin/api-keys"');
    });

    it('shows every nav item for an admin', () => {
      const view = buildAdminShellView({
        role: 'admin',
        path: '/admin/grants',
        navItems: getCanonicalNavItems(),
        dataAvailable: { kind: 'ready' },
      });
      const html = renderShell(view, buildScreenState({
        role: 'admin', section: 'grants', dataAvailable: { kind: 'ready' },
      }));
      expect(html).toContain('href="/admin/businesses"');
      expect(html).toContain('href="/admin/operations"');
      expect(html).toContain('href="/admin/profiles"');
      expect(html).toContain('href="/admin/connectors"');
      expect(html).toContain('href="/admin/grants"');
    });
  });

  describe('renderShell — ADM-UX-01 responsive shell', () => {
    const view = buildAdminShellView({
      role: 'admin',
      path: '/admin/businesses',
      navItems: getCanonicalNavItems(),
      dataAvailable: { kind: 'ready' },
    });
    const html = renderShell(view, buildScreenState({
      role: 'admin', section: 'businesses', dataAvailable: { kind: 'ready' },
    }));

    it('omits development copy and presents a concise section heading', () => {
      expect(html).not.toContain('What this turn proves');
      expect(html).not.toContain('four screen states');
      expect(html).toContain('<h2>businesses</h2>');
      expect(html).toContain('Section content will appear here when available.');
    });

    it('names navigation and breadcrumb landmarks', () => {
      expect(html).toContain('<nav class="admin-shell__nav" aria-label="Admin navigation">');
      expect(html).toContain('<nav class="admin-breadcrumbs" aria-label="Breadcrumbs">');
      expect(html).toContain('<section class="admin-shell__main" aria-label="Admin content">');
      expect(html).toContain('aria-current="page"');
    });

    it('includes desktop layout, compact mobile navigation, and 320px reflow rules', () => {
      expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
      expect(html).toContain('grid-template-columns: 12rem minmax(0, 1fr)');
      expect(html).toContain('grid-template-areas: "header header" "nav main"');
      expect(html).toContain('@media (max-width: 640px)');
      expect(html).toContain('.admin-nav { display: flex; flex-wrap: wrap;');
      expect(html).toContain('@media (max-width: 360px)');
      expect(html).toContain('.admin-filter-bar { display: flex; flex-wrap: wrap;');
      expect(html).toContain(':focus-visible');
      expect(html).toContain('min-width: 0');
    });

    it('wraps wide tables in a named keyboard-focusable region', () => {
      const wrapped = wrapTablesForReflow('<table><thead><tr><th>Operation</th></tr></thead></table>');
      expect(wrapped).toContain('role="region" aria-label="Scrollable data table 1 of 1" tabindex="0"');
      expect(wrapped).toContain('<table>');
    });
  });

  describe('renderShell — escape hardening', () => {
    it('escapes role / reason / message text injected via the screen state', () => {
      const view = buildAdminShellView({
        role: 'viewer',
        path: '/admin/grants',
        navItems: getCanonicalNavItems(),
        dataAvailable: { kind: 'ready' },
      });
      const screen = {
        kind: 'denied' as const,
        section: 'grants' as const,
        role: 'viewer' as const,
        requiredRole: 'admin' as const,
        reason: '<script>alert(1)</script>',
      };
      const html = renderShell(view, screen);
      // The raw payload must NOT appear as a literal <script> element
      // — that is the XSS sink. The escaped form appears as text.
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });
});
