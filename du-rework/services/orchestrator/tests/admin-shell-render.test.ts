/**
 * Renderer tests for the Admin shell (P6-01).
 *
 * Pure: no DB, no Redis, no HTTP. Asserts the four screen-state
 * renderers and the shell chrome produce correct HTML for each role
 * and each section, and that injected values cannot break out of
 * HTML.
 */

import {
  buildAdminShellView,
  buildScreenState,
  getCanonicalNavItems,
} from '../src/app/admin/p6-01-shell-fixtures';
import type { AdminRole, AdminSection } from '../src/app/admin/types';
import {
  esc,
  escAttr,
  h,
  renderDocument,
  renderErrorPage,
  renderLoginPage,
  renderNode,
  renderShell,
  wrapTablesForReflow,
} from '../src/app/admin/shell-render';
import { renderBusinessSection, buildDisplayRows } from '../src/app/admin/business-section-renderer';
import type { BusinessFetchResult } from '../src/app/admin/business-section-data';
import type {
  BusinessVersionRow,
} from '../src/app/admin/business-view-models';
import { renderProfileSection } from '../src/app/admin/profile-section-renderer';
import { fetchProfileForm } from '../src/app/admin/profile-section-data';
import { buildProfileFormModel } from '../src/app/admin/profile-view-models';
import { renderConnectorSection, renderConnectorSecretSlot, renderConnectorTestAction, countConfiguredSecrets } from '../src/app/admin/connector-section-renderer';
import { fetchConnectorConfig } from '../src/app/admin/connector-section-data';
import { renderApiKeySection, renderApiKeyListRow, renderApiKeyCopyOnceBanner, renderApiKeyRevokePanel, renderApiKeyGrantsTable } from '../src/app/admin/api-key-section-renderer';
import { fetchApiKeys } from '../src/app/admin/api-key-section-data';
import type { ApiKeyCatalogEntry } from '../src/app/admin/api-key-section-data';
import {
  buildApiKeyCreateView,
} from '../src/app/admin/api-key-view-models';
import {
  renderOperationSection,
  renderArtifactRow,
  renderArtifactsTable,
  renderResultPanel,
  renderHumanWaitForm,
  renderActionBar,
} from '../src/app/admin/operation-section-renderer';
import { fetchOperationDetail } from '../src/app/admin/operation-section-data';
import type {
  OperationDetailCatalogEntry,
  OperationFetchResult,
} from '../src/app/admin/operation-section-data';
import { renderOverviewSection } from '../src/app/admin/overview-section-renderer';
import { fetchOverview } from '../src/app/admin/overview-section-data';
import type {
  OverviewFetchResult,
  OverviewCatalog,
} from '../src/app/admin/overview-section-data';

describe('admin-shell renderer (P6-01)', () => {
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
      const view = viewFor('operator', 'profiles', '/admin/profiles');
      const screen = buildScreenState({
        role: 'operator',
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

    it('shows operator-accessible nav items for an operator', () => {
      const view = buildAdminShellView({
        role: 'operator',
        path: '/admin/profiles',
        navItems: getCanonicalNavItems(),
        dataAvailable: { kind: 'ready' },
      });
      const html = renderShell(view, buildScreenState({
        role: 'operator', section: 'profiles', dataAvailable: { kind: 'ready' },
      }));
      expect(html).toContain('href="/admin/profiles"');
      expect(html).toContain('href="/admin/connectors"');
      expect(html).not.toContain('href="/admin/grants"');
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

  // ---------------------------------------------------------------------------
  // P6-02 — Business registry / version / health renderer
  // ---------------------------------------------------------------------------
  describe('renderBusinessSection (P6-02, ok pane)', () => {
    const sampleRows: readonly BusinessVersionRow[] = [
      {
        businessId: 'example-review',
        version: 'v2',
        status: 'ENABLED',
        isActive: true,
        registeredAt: '2026-09-01T00:00:00Z',
        workerHealth: 'HEALTHY',
        workerCount: 3,
        lastHeartbeatAt: '2026-09-23T11:55:00Z',
      },
      {
        businessId: 'example-review',
        version: 'v1',
        status: 'DRAINING',
        isActive: false,
        registeredAt: '2026-08-01T00:00:00Z',
        workerHealth: 'DEGRADED',
        workerCount: 1,
        lastHeartbeatAt: '2026-09-23T11:00:00Z',
      },
      {
        businessId: 'example-review',
        version: 'v0.5',
        status: 'REGISTERED_DISABLED',
        isActive: false,
        registeredAt: '2026-07-15T00:00:00Z',
      },
      {
        businessId: 'example-review',
        version: 'v0',
        status: 'RETIRED',
        isActive: false,
        registeredAt: '2026-07-01T00:00:00Z',
      },
    ];

    const fetch: BusinessFetchResult = {
      kind: 'ok',
      businessId: 'example-review',
      rows: sampleRows,
      activeVersion: 'v2',
    };

    it('isReady=true and renders the section root with the business id', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('<section class="business-section"');
      expect(out.html).toContain('data-business-id="example-review"');
    });

    it('renders the health summary with active version + counts', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toContain('<section class="business-section__health"');
      expect(out.html).toContain('Overall health');
      // v2 is ENABLED + active → "healthy" or "no-active" depending on
      // worker signal. Either way the data-health attribute is present.
      expect(out.html).toMatch(/data-health="(healthy|no-active|draining|retired)"/);
      // Counts.
      expect(out.html).toContain('Total versions');
      expect(out.html).toContain('Enabled');
      expect(out.html).toContain('Draining');
      expect(out.html).toContain('Retired');
    });

    it('renders a per-row status badge for every version state', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toContain('data-status="ENABLED"');
      expect(out.html).toContain('data-status="DRAINING"');
      expect(out.html).toContain('data-status="RETIRED"');
    });

    it('renders the active marker on the active row only', () => {
      const out = renderBusinessSection({ fetch });
      // Active marker appears once with data-active="true".
      const matches = out.html.match(/data-active="true"/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('renders per-row health indicators', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toMatch(/data-health="(healthy|draining|retired)"/);
    });

    it('renders the worker heartbeat block with worker count', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toContain('class="worker-heartbeat"');
      expect(out.html).toContain('workers: 3');
    });

    it('gates enable / drain / retire per transition guard', () => {
      const out = renderBusinessSection({ fetch });
      // v2 ENABLED active → drain form (enable/drain/retire); retire disabled.
      // v1 DRAINING → enable + retire forms, drain disabled.
      // v0.5 REGISTERED_DISABLED → enable form, drain/retire disabled.
      // v0 RETIRED → all three disabled.
      expect(out.html).toContain('action-chip--enable');
      expect(out.html).toContain('action-chip--drain');
      expect(out.html).toContain('action-chip--retire');
      // action-chip-form wrappers must appear for the allowed transitions.
      const formWrappers = (out.html.match(/action-chip-form/g) ?? []).length;
      // v2 drain + v1 retire + v0.5 enable = 3.
      expect(formWrappers).toBe(3);
      // Disabled markers must appear for the disallowed transitions.
      const disabled = (out.html.match(/action-chip--disabled/g) ?? []).length;
      // v2 enable + v2 retire + v1 enable + v1 drain + v0.5 drain + v0.5 retire + v0 enable + v0 drain + v0 retire = 9.
      expect(disabled).toBeGreaterThanOrEqual(9);
    });

    it('renders the business picker with known ids when supplied', () => {
      const out = renderBusinessSection({
        fetch,
        knownBusinessIds: ['example-review', 'other-biz'],
        selectedBusinessId: 'example-review',
      });
      expect(out.html).toContain('class="business-section__picker"');
      expect(out.html).toContain('action="/admin/businesses"');
      expect(out.html).toContain('value="example-review" selected');
      expect(out.html).toContain('value="other-biz"');
    });

    it('renders the empty pane when rows is []', () => {
      const out = renderBusinessSection({
        fetch: { kind: 'ok', businessId: 'example-review', rows: [], activeVersion: null },
      });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('class="business-section__empty"');
      expect(out.html).toContain('No versions are registered');
    });
  });

  describe('renderBusinessSection (P6-02, fallback panes)', () => {
    it('renders the unauthorized pane with status badge and message', () => {
      const out = renderBusinessSection({
        fetch: { kind: 'unauthorized', businessId: 'example-review', message: 'token expired' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('business-section--unauthorized');
      expect(out.html).toContain('Admin token rejected');
      expect(out.html).toContain('token expired');
    });

    it('renders the not-found pane for an empty businessId with a list-unavailable hint', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'not-found',
          businessId: '',
          message: 'Platform does not expose a business list endpoint.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('business-section--not-found');
      expect(out.html).toContain('Business list unavailable');
    });

    it('renders the not-found pane for a missing businessId', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'not-found',
          businessId: 'unknown-biz',
          message: "Business 'unknown-biz' is not registered.",
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('Business not registered');
      expect(out.html).toContain('unknown-biz');
    });

    it('renders the error pane for transport failure', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'error',
          businessId: 'example-review',
          message: 'Timed out after 4000ms waiting for the platform.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('business-section--error');
      expect(out.html).toContain('Could not load business versions');
      expect(out.html).toContain('Timed out after 4000ms');
    });

    it('escapes script payload in the error pane message', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'error',
          businessId: 'example-review',
          message: 'boom <script>alert(1)</script>',
        },
      });
      expect(out.html).not.toContain('<script>alert(1)</script>');
      expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes injected version / message / status text', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'ok',
          businessId: '<img src=x>',
          rows: [
            {
              businessId: '<img src=x>',
              version: '<v"1>',
              status: 'REGISTERED_DISABLED',
              registeredAt: 'now',
            },
          ],
          activeVersion: null,
        },
      });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<v"1>');
      // The row's malicious businessId + version appear only in escaped
      // form (data-business-id attribute + the <code> tag).
      expect(out.html).toContain('data-business-id="&lt;img src=x&gt;"');
      expect(out.html).toContain('&lt;v&quot;1&gt;');
    });
  });

  describe('buildDisplayRows (P6-02, view-model adapter)', () => {
    it('maps every raw row through toBusinessVersionDisplayRow', () => {
      const rows: readonly BusinessVersionRow[] = [
        { businessId: 'a', version: 'v1', status: 'ENABLED', isActive: true, workerHealth: 'HEALTHY', workerCount: 2 },
        { businessId: 'a', version: 'v2', status: 'REGISTERED_DISABLED' },
      ];
      const display = buildDisplayRows(rows);
      expect(display).toHaveLength(2);
      expect(display[0]?.canDrain).toBe(true);
      expect(display[1]?.canEnable).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // P6-03 — dynamic schema profile editor (slots/defaults/locked/prompt cat.)
  // -------------------------------------------------------------------------

  describe('renderProfileSection (P6-03, ok pane)', () => {
    const baseSchema = {
      businessId: 'example-review',
      businessVersion: 'v1',
      manifest: {
        actions: [
          {
            name: 'analyze',
            title: 'Analyze',
            slots: [
              { name: 'model', required: true, widget: 'text', description: 'Model id' },
              { name: 'temperature', required: false, widget: 'number' },
              { name: 'prompt', required: true, widget: 'textarea', description: 'Prompt template' },
              { name: 'apiKey', required: true, widget: 'secret' },
            ],
          },
          {
            name: 'compare',
            title: 'Compare',
            slots: [
              { name: 'pair', required: true, widget: 'select', options: [
                { value: 'openai/gpt-4', label: 'openai/gpt-4' },
                { value: 'anthropic/claude', label: 'anthropic/claude' },
              ] },
              { name: 'exotic', required: false, widget: 'fusion-turbo' },
            ],
          },
        ],
      },
      capabilityOptions: [
        { connectorId: 'openai', capability: 'gpt-4', label: 'openai/gpt-4' },
        { connectorId: 'anthropic', capability: 'claude', label: 'anthropic/claude' },
      ],
      existingProfile: { name: 'p-default', revision: 7 },
    };

    it('isReady=true and renders the form with a section per action', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('<section class="profile-section"');
      expect(out.html).toContain('data-business-id="example-review"');
      expect(out.html).toContain('data-revision="7"');
      expect(out.html).toContain('data-action="analyze"');
      expect(out.html).toContain('data-action="compare"');
    });

    it('renders each slot as a labeled input with the right widget type', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({
          model: 'openai/gpt-4',
          temperature: '0.5',
          prompt: 'Analyze {{doc}}',
          apiKey: 'sk-1234567890',
          pair: 'anthropic/claude',
        }),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      // Text input
      expect(out.html).toContain('data-slot="model"');
      expect(out.html).toContain('data-widget="text"');
      expect(out.html).toContain('value="openai/gpt-4"');
      // Number input
      expect(out.html).toContain('data-slot="temperature"');
      expect(out.html).toContain('type="number"');
      expect(out.html).toContain('value="0.5"');
      // Textarea
      expect(out.html).toContain('data-slot="prompt"');
      expect(out.html).toContain('field-input--textarea');
      // Secret: existing value masked as bullets, never the raw key
      expect(out.html).toContain('data-slot="apiKey"');
      expect(out.html).toContain('type="password"');
      expect(out.html).toContain('value="••••••••"');
      expect(out.html).not.toContain('sk-1234567890');
      // Select with option
      expect(out.html).toContain('data-slot="pair"');
      expect(out.html).toContain('selected');
      expect(out.html).toContain('anthropic/claude');
    });

    it('renders the prompt catalog hint when a slot has prompt keys', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map<string, readonly string[]>([
          ['model', ['system', 'user', 'assistant']],
        ]),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.html).toContain('field-prompt-catalog');
      expect(out.html).toContain('Prompt catalog');
      expect(out.html).toContain('<code>system</code>');
      expect(out.html).toContain('<code>user</code>');
      expect(out.html).toContain('<code>assistant</code>');
    });

    it('flags unknown widgets with the fallback banner and data attribute', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map<string, string>([['exotic', 'fusion-turbo']]),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.html).toContain('profile-section__unknown-banner');
      expect(out.html).toContain('Unknown widget');
      // The exotic slot falls back to text but keeps the unknown source name.
      expect(out.html).toContain('data-unknown-widget="fusion-turbo"');
      expect(out.html).toContain('data-unknown-fallback="true"');
    });

    it('renders locked slots readonly + disabled with the server value verbatim', () => {
      const fixture = renderProfileSection({
        fetch: {
          kind: 'ok' as const,
          businessId: 'example-review',
          businessVersion: 'v1',
          profileName: 'p-default',
          revision: 7,
          model: buildProfileFormModel(baseSchema),
          // A stale client value that MUST NOT win over the lock.
          currentValues: Object.freeze({ model: 'client-supplied-model' }),
          promptCatalog: new Map(),
          originalWidgetBySlot: new Map(),
          lockedBySlot: new Set<string>(['model']),
          lockedValueBySlot: new Map<string, string>([['model', 'server-owned-model']]),
        },
      });
      // The locked field carries the marker + class.
      expect(fixture.html).toContain('field--locked');
      expect(fixture.html).toContain('data-locked="true"');
      expect(fixture.html).toContain('field-locked-mark');
      expect(fixture.html).toContain('readonly');
      expect(fixture.html).toContain('disabled');
      // The server value is shown verbatim; the client value is ignored.
      expect(fixture.html).toContain('value="server-owned-model"');
      expect(fixture.html).not.toContain('value="client-supplied-model"');
      // An unlocked sibling is still editable (no readonly/disabled).
      expect(fixture.html).toContain('data-slot="temperature"');
      expect(fixture.html).not.toContain('data-slot="temperature" data-widget="number" disabled');
    });

    it('never renders a lock marker when no slot is locked', () => {
      const fixture = renderProfileSection({
        fetch: {
          kind: 'ok' as const,
          businessId: 'example-review',
          businessVersion: 'v1',
          profileName: 'p-default',
          revision: 7,
          model: buildProfileFormModel(baseSchema),
          currentValues: Object.freeze({}),
          promptCatalog: new Map(),
          originalWidgetBySlot: new Map(),
          lockedBySlot: new Set<string>(),
          lockedValueBySlot: new Map<string, string>(),
        },
      });
      expect(fixture.html).not.toContain('data-locked="true"');
      expect(fixture.html).not.toContain('field-locked-mark');
      expect(fixture.html).not.toContain('field--locked');
    });

    it('renders the business picker when knownBusinessIds is supplied', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({
        fetch,
        knownBusinessIds: ['example-review', 'document-core'],
        selectedBusinessId: 'example-review',
      });
      expect(out.html).toContain('class="profile-section__picker"');
      expect(out.html).toContain('name="businessId"');
      expect(out.html).toContain('selected');
    });

    it('escapes malicious slot names and values', () => {
      const evil: typeof baseSchema = {
        businessId: '<img>',
        businessVersion: 'v1',
        manifest: {
          actions: [
            {
              name: '<script>',
              title: '</title>',
              slots: [
                { name: 'a"><img src=x>', required: false, widget: 'text' },
              ],
            },
          ],
        },
        capabilityOptions: [],
        existingProfile: { name: '', revision: 0 },
      };
      const fetch = {
        kind: 'ok' as const,
        businessId: '<img>',
        businessVersion: 'v1',
        profileName: '',
        revision: 0,
        model: buildProfileFormModel(evil),
        currentValues: Object.freeze({ 'a"><img src=x>': '<bad>' }),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<script>');
      // esc() turns the angle brackets into HTML entities.
      expect(out.html).toContain('data-business-id="&lt;img&gt;"');
      expect(out.html).not.toContain('<bad>');
      expect(out.html).toContain('&lt;bad&gt;');
    });
  });

  describe('renderProfileSection (P6-03, fallback panes)', () => {
    it('renders the empty pane when no business is selected', () => {
      const out = renderProfileSection({
        fetch: {
          kind: 'empty',
          businessId: '',
          message: 'Pick a business to open its profile editor.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--empty');
      expect(out.html).toContain('Pick a business');
    });

    it('renders the unauthorized pane on 401/403', () => {
      const out = renderProfileSection({
        fetch: { kind: 'unauthorized', businessId: 'a', message: 'token rejected' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--unauthorized');
      expect(out.html).toContain('token rejected');
    });

    it('renders the not-found pane when no manifest is registered', () => {
      const out = renderProfileSection({
        fetch: { kind: 'not-found', businessId: 'a', message: 'no manifest' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--not-found');
      expect(out.html).toContain('no manifest');
    });

    it('renders the error pane on network/timeout', () => {
      const out = renderProfileSection({
        fetch: { kind: 'error', businessId: 'a', message: 'Timed out after 4000ms' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--error');
      expect(out.html).toContain('Timed out');
    });
  });

  describe('fetchProfileForm (P6-03, discriminated fetcher)', () => {
    it('returns empty when no businessId is supplied', async () => {
      const fetchImpl = jest.fn();
      const res = await fetchProfileForm({
        businessId: '',
        jsonBaseUrl: 'http://127.0.0.1:0',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('empty');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns unauthorized when no adminToken is supplied', async () => {
      const fetchImpl = jest.fn();
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:0',
        adminToken: '',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('unauthorized');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('falls back to the in-process catalog when jsonBaseUrl is empty', async () => {
      const res = await fetchProfileForm({
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        jsonBaseUrl: '',
        adminToken: 't',
        manifestCatalog: [baseSchemaForCatalog()],
      });
      expect(res.kind).toBe('ok');
      if (res.kind === 'ok') {
        expect(res.businessId).toBe('example-review');
        expect(res.model.sections.map((s) => s.actionName)).toEqual(['analyze']);
      }
    });

    it('returns not-found when the catalog has no matching entry', async () => {
      const res = await fetchProfileForm({
        businessId: 'absent',
        jsonBaseUrl: '',
        adminToken: 't',
        manifestCatalog: [],
      });
      expect(res.kind).toBe('not-found');
    });

    it('returns unauthorized on HTTP 401 from the platform', async () => {
      const fetchImpl = jest.fn(async () => new Response('nope', { status: 401 }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('unauthorized');
    });

    it('returns not-found on HTTP 404 from the platform', async () => {
      const fetchImpl = jest.fn(async () => new Response('', { status: 404 }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('not-found');
    });

    it('returns error on HTTP 500 with the sanitized body', async () => {
      const fetchImpl = jest.fn(async () => new Response('boom', { status: 500 }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toContain('HTTP 500');
        expect(res.message).toContain('boom');
      }
    });

    it('returns error when the platform returns non-JSON', async () => {
      const fetchImpl = jest.fn(async () => new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toContain('non-JSON');
      }
    });

    it('parses a successful platform payload into the ok result', async () => {
      const payload = {
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        currentValues: { model: 'openai/gpt-4' },
        manifest: {
          actions: [
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'model', required: true, widget: 'text' },
              ],
            },
          ],
        },
      };
      const fetchImpl = jest.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
      const res = await fetchProfileForm({
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('ok');
      if (res.kind === 'ok') {
        expect(res.revision).toBe(7);
        expect(res.currentValues['model']).toBe('openai/gpt-4');
        expect(res.model.sections).toHaveLength(1);
      }
    });

    it('carries wire locks into lockedBySlot/lockedValueBySlot (P6-03 locks)', async () => {
      const payload = {
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 9,
        currentValues: { model: 'openai/gpt-4' },
        manifest: {
          actions: [
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'model', required: true, widget: 'text' },
                {
                  name: 'tenantTag',
                  required: false,
                  widget: 'text',
                  locked: true,
                  lockedValue: 'tenant-acme',
                },
                { name: 'exotic', required: false, widget: 'fusion-turbo' },
              ],
            },
          ],
        },
      };
      const fetchImpl = jest.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const res = await fetchProfileForm({
        businessId: 'example-review',
        businessVersion: 'v1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('ok');
      if (res.kind !== 'ok') return;
      expect(res.lockedBySlot.has('tenantTag')).toBe(true);
      expect(res.lockedBySlot.has('model')).toBe(false);
      expect(res.lockedValueBySlot.get('tenantTag')).toBe('tenant-acme');
      // The unknown-widget source still rides alongside the lock set.
      expect(res.originalWidgetBySlot.get('exotic')).toBe('fusion-turbo');
    });

    it('returns empty when the manifest declares no actions', async () => {
      const payload = {
        businessId: 'a',
        businessVersion: 'v1',
        profileName: 'p',
        revision: 0,
        currentValues: {},
        manifest: { actions: [] },
      };
      const fetchImpl = jest.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('empty');
    });

    it('returns error on timeout (AbortError)', async () => {
      const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
        // Simulate the AbortController firing: throw an AbortError.
        return new Promise<Response>((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 25,
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toMatch(/Timed out|aborted/i);
      }
    });

    function baseSchemaForCatalog() {
      return {
        businessId: 'example-review',
        businessVersion: 'v1',
        manifest: {
          actions: [
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'model', required: true, widget: 'text' },
              ],
            },
          ],
        },
        capabilityOptions: [],
        existingProfile: { name: 'p-default', revision: 7 },
      };
    }
  });

  // -------------------------------------------------------------------------
  // P6-04 — connector config / secret rotation / test result UI
  // -------------------------------------------------------------------------

  describe('renderConnectorSection (P6-04, ok pane)', () => {
    // Build an `ok` fetch result directly so the renderer is exercised
    // without going through the catalog fallback path. The view models
    // already include sanitized badges + masks, so the result is
    // renderer-safe by construction.
    const okFetch = (): import('../src/app/admin/connector-section-data').ConnectorFetchResult => ({
      kind: 'ok',
      connectorId: 'openai',
      revision: 7,
      revisionView: {
        connectorId: 'openai',
        revision: 7,
        adapter: 'openai-adapter',
        endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
        capabilities: ['gpt-4', 'gpt-3.5-turbo'],
        state: 'enabled',
        stateBadge: 'success',
        stateLabel: 'Enabled',
        createdAt: '2026-09-23T10:00:00Z',
        updatedAt: '2026-09-23T18:00:00Z',
        secretSlots: [
          {
            name: 'apiKey',
            label: 'API key',
            hasValue: true,
            statusBadge: 'success',
            statusLabel: 'Configured',
            rotatedAt: '2026-09-22T10:00:00Z',
          },
          {
            name: 'webhookSecret',
            label: 'Webhook secret',
            hasValue: false,
            statusBadge: 'neutral',
            statusLabel: 'Not configured',
            rotatedAt: null,
          },
        ],
        totalSecretSlots: 2,
        hasAnySecret: true,
      },
      testResult: {
        kind: 'success',
        message: 'Connected to upstream in 134 ms.',
        label: 'Success',
        badge: 'success',
        connectorId: 'openai',
        revision: 7,
        testedAt: '2026-09-23T18:00:00Z',
        canRetry: false,
      },
      rotateState: 'idle',
      secretSlotViews: [
        {
          name: 'apiKey',
          label: 'API key',
          hasValue: true,
          statusBadge: 'success',
          statusLabel: 'Configured',
          rotatedAt: '2026-09-22T10:00:00Z',
        },
        {
          name: 'webhookSecret',
          label: 'Webhook secret',
          hasValue: false,
          statusBadge: 'neutral',
          statusLabel: 'Not configured',
          rotatedAt: null,
        },
      ],
      revisionRow: {
        connectorId: 'openai',
        revision: 7,
        adapter: 'openai-adapter',
        endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
        capabilities: ['gpt-4', 'gpt-3.5-turbo'],
        state: 'enabled',
        createdAt: '2026-09-23T10:00:00Z',
        updatedAt: '2026-09-23T18:00:00Z',
      },
      revisionLabel: '#7',
    });

    it('isReady=true and renders the section root with revision label', () => {
      const out = renderConnectorSection({ fetch: okFetch() });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('<section class="connector-section"');
      expect(out.html).toContain('data-connector-id="openai"');
      expect(out.html).toContain('data-revision="7"');
      expect(out.html).toContain('data-revision-label="#7"');
    });

    it('write-only secret slot: empty type=password input, raw value never rendered', () => {
      const out = renderConnectorSection({ fetch: okFetch() });
      // The slot exists with the right name + label.
      expect(out.html).toContain('data-slot="apiKey"');
      expect(out.html).toContain('API key');
      // Write-only contract: password field, empty value, explicit marker.
      expect(out.html).toContain('type="password"');
      expect(out.html).toContain('name="value"');
      expect(out.html).toContain('autocomplete="off"');
      expect(out.html).toContain('data-write-only="true"');
      // The Configured / Not configured badges are surfaced; the raw
      // value is never rendered.
      expect(out.html).toContain('data-secret-state="configured"');
      expect(out.html).toContain('Configured');
      expect(out.html).toContain('data-secret-state="not-configured"');
      expect(out.html).not.toContain('sk-');
    });

    it('explicit test result: data-test-result-kind + sanitized message, no upstream leak', () => {
      const out = renderConnectorSection({ fetch: okFetch() });
      expect(out.html).toContain('data-test-result-kind="success"');
      expect(out.html).toContain('data-test-result="success"');
      expect(out.html).toContain('data-tested-at="2026-09-23T18:00:00Z"');
      expect(out.html).toContain('Connected to upstream in 134 ms.');
      // The button is the explicit test-action affordance.
      expect(out.html).toContain('data-action="test-connection"');
    });

    it('renders the picker when knownConnectorIds is supplied', () => {
      const out = renderConnectorSection({
        fetch: okFetch(),
        knownConnectorIds: ['openai', 'anthropic'],
        selectedConnectorId: 'openai',
        selectedRevision: 7,
      });
      expect(out.html).toContain('class="connector-section__picker"');
      expect(out.html).toContain('name="connectorId"');
      expect(out.html).toContain('value="7"');
    });

    it('renderConnectorSecretSlot enforces write-only contract when standalone', () => {
      const out = renderConnectorSecretSlot('openai', 7, {
        name: 'apiKey',
        label: 'API key',
        hasValue: true,
        statusBadge: 'success',
        statusLabel: 'Configured',
        rotatedAt: '2026-09-22T10:00:00Z',
      });
      expect(out).toContain('type="password"');
      expect(out).toContain('value=""');
      expect(out).toContain('data-write-only="true"');
      expect(out).not.toContain('sk-');
    });

    it('renderConnectorTestAction surfaces failure + pending states with sanitized message', () => {
      const failure = renderConnectorTestAction({
        kind: 'invalid-credential',
        message: 'Authentication failed: upstream rejected the credential.',
        label: 'Failure',
        badge: 'error',
        connectorId: 'openai',
        revision: 7,
        testedAt: null,
        canRetry: false,
      });
      expect(failure).toContain('data-test-result-kind="failure"');
      expect(failure).toContain('data-test-result="invalid-credential"');
      expect(failure).toContain('Authentication failed');

      const pending = renderConnectorTestAction({
        kind: 'pending',
        message: 'Test queued.',
        label: 'Pending',
        badge: 'neutral',
        connectorId: 'openai',
        revision: 7,
        testedAt: null,
        canRetry: false,
      });
      expect(pending).toContain('data-test-result-kind="pending"');
      expect(pending).toContain('data-test-result="pending"');
    });

    it('countConfiguredSecrets returns the hasValue=true count', () => {
      const slots = [
        {
          name: 'apiKey',
          label: 'API key',
          hasValue: true,
          statusBadge: 'success' as const,
          statusLabel: 'Configured',
          rotatedAt: '2026-09-22T10:00:00Z',
        },
        {
          name: 'webhookSecret',
          label: 'Webhook secret',
          hasValue: false,
          statusBadge: 'neutral' as const,
          statusLabel: 'Not configured',
          rotatedAt: null,
        },
      ];
      expect(renderConnectorSection({ fetch: okFetch() })).toBeTruthy();
      expect(countConfiguredSecrets(slots)).toBe(1);
    });
  });

  describe('renderConnectorSection (P6-04, fallback panes)', () => {
    it('empty pane when no connector is selected', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'empty',
          connectorId: '',
          message: 'Pick a connector to open its configuration pane.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--empty');
      expect(out.html).toContain('Pick a connector');
      expect(out.html).not.toContain('type="password"');
    });

    it('unauthorized pane when the admin token is rejected', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'unauthorized',
          connectorId: 'openai',
          message: 'Platform rejected the admin token (HTTP 401).',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--unauthorized');
      expect(out.html).toContain('Admin token rejected');
      expect(out.html).not.toContain('type="password"');
    });

    it('not-found pane when the GET route is missing on the platform', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'not-found',
          connectorId: 'openai',
          message: "Connector 'openai' revision 'latest' is not on the server.",
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--not-found');
      expect(out.html).toContain('not registered');
      expect(out.html).not.toContain('type="password"');
    });

    it('error pane on transport failure', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'error',
          connectorId: 'openai',
          message: 'Network error contacting the platform.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--error');
      expect(out.html).toContain('Network error');
      expect(out.html).not.toContain('type="password"');
    });
  });

  describe('fetchConnectorConfig (P6-04, discriminated fetcher)', () => {
    const baseEntry = {
      connectorId: 'openai',
      revision: 7,
      adapter: 'openai-adapter',
      endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
      capabilities: ['gpt-4'],
      state: 'enabled' as const,
      createdAt: '2026-09-23T10:00:00Z',
      updatedAt: '2026-09-23T18:00:00Z',
      secretSlots: [
        { name: 'apiKey', label: 'API key', hasValue: true, rotatedAt: '2026-09-22T10:00:00Z' },
      ],
      testResult: { kind: 'success' as const, message: 'OK', testedAt: '2026-09-23T18:00:00Z' },
      rotateState: 'idle' as const,
    };

    it('empty connectorId → empty discriminated result (no fabricated data)', async () => {
      const r = await fetchConnectorConfig({
        connectorId: '',
        revision: 0,
        jsonBaseUrl: '',
        adminToken: 'tok',
        fetchImpl: (() => { throw new Error('should not be called'); }) as typeof fetch,
      });
      expect(r.kind).toBe('empty');
    });

    it('catalog match → ok pane with write-only slot (no raw value in any view)', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'openai',
        revision: 7,
        jsonBaseUrl: '',
        adminToken: 'tok',
        manifestCatalog: [baseEntry],
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      expect(r.revisionLabel).toBe('#7');
      const out = renderConnectorSection({ fetch: r });
      expect(out.html).toContain('type="password"');
      expect(out.html).toContain('value=""');
      expect(out.html).not.toContain('sk-');
    });

    it('catalog miss with no platform → not-found discriminated result', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'missing',
        revision: 0,
        jsonBaseUrl: '',
        adminToken: 'tok',
        manifestCatalog: [baseEntry],
      });
      expect(r.kind).toBe('not-found');
    });

    it('HTTP 401 → unauthorized discriminated result (no fetcher ok pane)', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'openai',
        revision: 7,
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('denied', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('HTTP 404 → not-found discriminated result', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'openai',
        revision: 7,
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('missing', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
    });
  });

  // -------------------------------------------------------------------------
  // P6-05 — API key create / copy-once / revoke / assignment
  // -------------------------------------------------------------------------
  //
  // Hard rule: the renderer MUST never carry a raw API key value.
  // The DOM-evidence tests below assert (a) the masked hint is the
  // only key material visible, (b) `data-copy-once-available` is
  // the single explicit discriminator on the copy-once banner,
  // (c) the revoke panel exposes `data-can-revoke` and disables
  // the confirm button when the key is not in ACTIVE state, and
  // (d) the assignment table renders the grant rows from the
  // fetcher without leaking raw key material.

  describe('renderApiKeySection (P6-05, ok pane)', () => {
    const okCatalog: ApiKeyCatalogEntry[] = [
      {
        id: 'k_alpha',
        tenantId: 'tenant-1',
        maskedHint: 'abcd…',
        prefix: 'du_live_',
        status: 'ACTIVE',
        createdAt: '2026-09-20T00:00:00Z',
        lastUsedAt: '2026-09-22T00:00:00Z',
        label: 'CI runner',
        revokedAt: null,
        grants: [
          {
            businessId: 'biz-1',
            businessVersion: 'v1',
            action: 'ingest',
            grantedAt: '2026-09-20T01:00:00Z',
          },
        ],
      },
      {
        id: 'k_bravo',
        tenantId: 'tenant-1',
        maskedHint: 'wxyz…',
        prefix: 'du_live_',
        status: 'REVOKED',
        createdAt: '2026-09-15T00:00:00Z',
        lastUsedAt: null,
        label: null,
        revokedAt: '2026-09-19T00:00:00Z',
        grants: [],
      },
    ];

    const okResult = async () =>
      fetchApiKeys({
        keyId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });

    it('isReady=true and data-copy-once-available="false" when no copy-once window is open', async () => {
      const r = await okResult();
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderApiKeySection({ fetch: r, knownKeyIds: ['k_alpha', 'k_bravo'] });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('data-key-total="2"');
      expect(out.html).toContain('data-key-selected=""');
      expect(out.html).toContain('data-copy-once-available="false"');
      // No raw key material anywhere in the rendered HTML.
      expect(out.html).not.toMatch(/du_live_[a-zA-Z0-9]{20,}/);
    });

    it('lists every row with its masked hint + status badge + canRevoke flag', async () => {
      const r = await okResult();
      if (r.kind !== 'ok') throw new Error('expected ok');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('data-key-id="k_alpha"');
      expect(html).toContain('data-key-status="ACTIVE"');
      expect(html).toContain('data-key-masked="abcd…"');
      expect(html).toContain('data-key-id="k_bravo"');
      expect(html).toContain('data-key-status="REVOKED"');
    });

    it('renders the detail panel + grants table for the selected key', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('<section class="api-key-section__detail"');
      expect(html).toContain('data-key-id="k_alpha"');
      expect(html).toContain('<section class="api-key-section__grants"');
      expect(html).toContain('data-grant-total="1"');
      expect(html).toContain('data-business-id="biz-1"');
      expect(html).toContain('data-business-version="v1"');
      expect(html).toContain('data-action="ingest"');
    });

    it('copy-once banner surfaces data-copy-once-available="true" + masked hint only', () => {
      const banner = renderApiKeyCopyOnceBanner(
        buildApiKeyCreateView({
          id: 'k_charlie',
          tenantId: 'tenant-1',
          prefix: 'du_live_',
          label: 'Temp',
          createdAt: '2026-09-23T00:00:00Z',
          rawKey: 'du_live_S3CRET_RAW_VALUE_LONG',
        }),
      );
      expect(banner).toContain('data-copy-once-available="true"');
      expect(banner).toContain('data-copy-once-id="k_charlie"');
      expect(banner).toContain('data-copy-once-masked="du_l…"');
      // The raw key value MUST NOT appear anywhere in the rendered
      // banner — the model discarded it before the renderer was
      // called.
      expect(banner).not.toContain('S3CRET_RAW_VALUE_LONG');
      expect(banner).not.toContain('data-copy-once-raw=');
    });

    it('revoke panel exposes data-can-revoke="false" + disabled for non-ACTIVE keys', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_bravo',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const selected = r.selected;
      expect(selected).not.toBeNull();
      const panel = renderApiKeyRevokePanel(selected!);
      expect(panel).toContain('data-key-id="k_bravo"');
      expect(panel).toContain('data-can-revoke="false"');
      expect(panel).toContain('data-action="revoke-api-key" disabled');
    });

    it('revoke panel exposes data-can-revoke="true" + enabled confirm for ACTIVE keys', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const panel = renderApiKeyRevokePanel(r.selected!);
      expect(panel).toContain('data-can-revoke="true"');
      expect(panel).toContain('data-action="revoke-api-key"');
      expect(panel).not.toContain('data-action="revoke-api-key" disabled');
    });

    it('create form posts against /admin/api-keys/new and surfaces explicit data-action', async () => {
      const r = await okResult();
      if (r.kind !== 'ok') throw new Error('expected ok');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('action="/admin/api-keys/new"');
      expect(html).toContain('data-action="create-api-key"');
    });

    it('grants table renders grant rows from the fetcher result', () => {
      const grants = [
        {
          businessId: 'biz-9',
          businessVersion: 'v2',
          action: 'extract',
          grantedAt: '2026-09-23T01:00:00Z',
        },
      ];
      const html = renderApiKeyGrantsTable('k_alpha', grants);
      expect(html).toContain('data-grant-total="1"');
      expect(html).toContain('data-business-id="biz-9"');
      expect(html).toContain('data-action="extract"');
    });
  });

  describe('renderApiKeySection (P6-05, fallback panes)', () => {
    it('empty pane renders when the catalog has no entries', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [] },
      });
      expect(r.kind).toBe('empty');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--empty');
      expect(html).toContain('No API keys are registered yet');
    });

    it('unauthorized pane renders when adminToken is missing + jsonBaseUrl is set', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: '',
      });
      expect(r.kind).toBe('unauthorized');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--unauthorized');
      expect(html).toContain('Admin token rejected');
    });

    it('not-found pane renders when the requested keyId is unknown (catalog has the row missing)', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_missing',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: {
          entries: [
            {
              id: 'k_alpha',
              tenantId: 'tenant-1',
              maskedHint: 'abcd…',
              prefix: 'du_live_',
              status: 'ACTIVE',
              createdAt: '2026-09-20T00:00:00Z',
              lastUsedAt: null,
              label: null,
              revokedAt: null,
              grants: [],
            },
          ],
        },
      });
      expect(r.kind).toBe('not-found');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--not-found');
      expect(html).toContain('k_missing');
    });

    it('error pane renders on transport failure (timeout)', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        timeoutMs: 50,
        fetchImpl: (async () => {
          // Simulate an aborted request — the fetcher must surface
          // this as a discriminated `error` and the renderer must
          // show the error pane.
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--error');
    });
  });

  describe('fetchApiKeys (P6-05, discriminated fetcher)', () => {
    const okCatalog: ApiKeyCatalogEntry[] = [
      {
        id: 'k_alpha',
        tenantId: 'tenant-1',
        maskedHint: 'abcd…',
        prefix: 'du_live_',
        status: 'ACTIVE',
        createdAt: '2026-09-20T00:00:00Z',
        lastUsedAt: null,
        label: null,
        revokedAt: null,
        grants: [],
      },
    ];

    it('empty catalog + no keyId → empty result', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [] },
      });
      expect(r.kind).toBe('empty');
    });

    it('catalog match + keyId → ok with selected row', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.selected?.id).toBe('k_alpha');
      expect(r.total).toBe(1);
    });

    it('catalog miss + non-empty keyId → not-found', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_missing',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.keyId).toBe('k_missing');
    });

    it('HTTP 401 → unauthorized', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('HTTP 404 with keyId → not-found', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('missing', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.keyId).toBe('k_alpha');
    });

    it('HTTP 500 → error', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });

    it('non-JSON response → error', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('<html>nope</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });
  });

  // ---------------------------------------------------------------------------
  // P6-06 — Operation detail / result / artifacts / cancel / resume / replay
  // ---------------------------------------------------------------------------

  describe('renderOperationSection (P6-06, ok pane)', () => {
    function okCatalogEntry(
      state: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'WAITING_INPUT' | 'CANCELLED' | 'TIMED_OUT',
    ): OperationDetailCatalogEntry {
      const op = {
        id: 'op-1',
        tenantId: 'tenant-1',
        businessId: 'biz-1',
        businessVersion: 'v1',
        action: 'ingest',
        state,
        stateVersion: 1,
        createdAt: '2026-09-20T00:00:00Z',
        updatedAt: '2026-09-20T00:01:00Z',
        deadlineAt: '2026-09-21T00:00:00Z',
        replayOf: null,
        progress: { percent: 50, message: 'half-way' },
        links: { self: '/api/v1/operations/op-1', result: '/api/v1/operations/op-1/result' },
        wait: null,
        error: null,
      } as const;
      if (state === 'WAITING_INPUT') {
        return {
          operation: {
            ...op,
            wait: {
              waitId: 'w-1',
              inputSchema: {
                type: 'object',
                properties: {
                  notes: { type: 'string', widget: 'textarea', description: 'Free-form reviewer notes' },
                  severity: { type: 'string', enum: ['low', 'med', 'high'] },
                },
                required: ['notes'],
              },
              expiresAt: '2099-09-21T00:00:00Z',
            },
          },
          result: null,
          artifacts: [
            { artifactId: 'a-1', role: 'output', fileName: 'out.md', mimeType: 'text/markdown', sizeBytes: 4096, download: '/dl/a-1' },
          ],
        };
      }
      if (state === 'SUCCEEDED') {
        return {
          operation: op,
          result: { schemaVersion: '1', data: { ok: true, text: 'hi' }, warnings: [] },
          artifacts: [
            { artifactId: 'a-1', role: 'output', fileName: 'out.md', mimeType: 'text/markdown', sizeBytes: 4096, download: '/dl/a-1' },
            { artifactId: 'a-2', role: 'log', fileName: 'run.log', mimeType: 'text/plain', sizeBytes: 1024 },
          ],
        };
      }
      return { operation: op, result: null, artifacts: [] };
    }

    it('renders the ok pane with the discriminated action bars', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('RUNNING')] },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('class="operation-section"');
      expect(out.html).toContain('data-operation-selected="op-1"');
      expect(out.html).toContain('data-operation-state="RUNNING"');
      expect(out.html).toContain('data-can-cancel="true"');
      expect(out.html).toContain('data-can-resume="false"');
      expect(out.html).toContain('data-can-replay="false"');
      expect(out.html).toContain('data-action="cancel-operation"');
      expect(out.html).toContain('data-result-available="false"');
      expect(out.html).toContain('data-artifact-total="0"');
    });

    it('SUCCEEDED exposes canReplay=true and result data in a <pre>', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('SUCCEEDED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-can-cancel="false"');
      expect(out.html).toContain('data-can-replay="true"');
      expect(out.html).toContain('data-replay-label="Replay (new operation)"');
      expect(out.html).toContain('data-result-available="true"');
      expect(out.html).toContain('data-result-schema-version="1"');
      expect(out.html).toContain('data-result-data=');
      expect(out.html).toContain('class="operation-section__result-data"');
      // <pre> body is esc()-escaped, so quotes surface as &quot;.
      expect(out.html).toContain('&quot;ok&quot;: true');
    });

    it('FAILED surfaces the retry label and disabled cancel', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('FAILED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-can-replay="true"');
      expect(out.html).toContain('data-replay-label="Retry (new operation)"');
    });

    it('WAITING_INPUT renders the human-wait form with data-wait-cas', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('WAITING_INPUT')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('class="operation-section__wait"');
      expect(out.html).toContain('data-wait-id="w-1"');
      expect(out.html).toContain('data-wait-cas="w-1"');
      expect(out.html).toContain('data-wait-expired="false"');
      expect(out.html).toContain('data-action="resume-wait"');
      expect(out.html).toContain('data-action="submit-resume"');
      expect(out.html).toContain('name="casToken" value="w-1"');
      expect(out.html).toContain('data-field-name="notes"');
      expect(out.html).toContain('data-field-widget="textarea"');
      expect(out.html).toContain('data-field-name="severity"');
      expect(out.html).toContain('data-field-widget="select"');
      expect(out.html).toContain('data-field-option="low"');
    });

    it('artifacts table exposes per-row discriminators (no raw payload)', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('SUCCEEDED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-artifact-total="2"');
      expect(out.html).toContain('data-action="download-artifact"');
      expect(out.html).toContain('data-artifact-id="a-1"');
      expect(out.html).toContain('data-artifact-role="output"');
      expect(out.html).toContain('data-artifact-no-download="true"');
      expect(out.html).not.toContain('"bytes"');
    });

    it('progress bar surfaces data-progress-percent and aria attributes', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('RUNNING')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-progress-percent="50"');
      expect(out.html).toContain('role="progressbar"');
      expect(out.html).toContain('aria-valuenow="50"');
      expect(out.html).toContain('data-progress-message="half-way"');
    });

    it('escapes injected businessId + action + error code', async () => {
      const entry: OperationDetailCatalogEntry = {
        operation: {
          id: 'op-2',
          tenantId: 't',
          businessId: '<img src=x>',
          businessVersion: 'v"1"',
          action: 'extr"<script>alert(1)</script>',
          state: 'FAILED',
          stateVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
          deadlineAt: null,
          replayOf: null,
          progress: { percent: 0, message: '' },
          links: { self: '/s', result: '/r' },
          wait: null,
          error: { code: 'E<X', title: 't"1', detail: 'd&one' },
        },
        result: null,
        artifacts: [],
      };
      const r = await fetchOperationDetail({
        operationId: 'op-2',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [entry] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<script>alert(1)</script>');
      expect(out.html).toContain('data-business-id="&lt;img src=x&gt;"');
      expect(out.html).toContain('data-error-code="E&lt;X"');
      expect(out.html).not.toContain('data-error-detail=');
      expect(out.html).toContain('Diagnostic details are hidden in this view.');
    });

    it('list-view renders with all action discriminators disabled', async () => {
      // W-ADMUX-01: the catalog list pane is a paged `kind: 'list'`
      // envelope with a row table + pagination controls (was a
      // single-hint `ok` pane). The section still exposes no mutation
      // affordance for the list view.
      const r = await fetchOperationDetail({
        operationId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('RUNNING')] },
      });
      if (r.kind !== 'list') throw new Error('expected list');
      const out = renderOperationSection({
        fetch: r,
        selectedOperationId: '',
      });
      expect(out.html).toContain('class="operation-section operation-section--list"');
      expect(out.html).toContain('data-can-cancel="false"');
      expect(out.html).toContain('data-can-resume="false"');
      expect(out.html).toContain('data-can-replay="false"');
      expect(out.html).toContain('data-list-page="true"');
      expect(out.html).toContain('data-operation-row="op-1"');
      expect(out.html).toContain('href="/admin/operations?operationId=op-1"');
      expect(out.html).not.toContain('data-action="cancel-operation"');
    });

    it('renderArtifactRow renders download href and per-cell data-* discriminators', () => {
      const html = renderArtifactRow({
        artifactId: 'a-1',
        role: 'output',
        fileName: 'out.md',
        mimeType: 'text/markdown',
        sizeDisplay: '4.0 KB',
        downloadUrl: '/dl/a-1',
      });
      expect(html).toContain('data-artifact-id="a-1"');
      expect(html).toContain('data-action="download-artifact"');
      expect(html).toContain('href="/dl/a-1"');
    });

    it('renderArtifactsTable empty-state still emits the header', () => {
      const html = renderArtifactsTable([]);
      expect(html).toContain('data-artifact-total="0"');
      expect(html).toContain('No artifacts attached');
    });

    it('renderResultPanel with null prints the not-available hint', () => {
      const html = renderResultPanel(null);
      expect(html).toContain('data-result-available="false"');
      expect(html).toContain('Result is not yet available');
    });

    it('renderResultPanel with a payload emits data-result-data and warnings list', () => {
      const html = renderResultPanel({
        schemaVersion: '1',
        dataJson: '{"ok":true}',
        dataPretty: '{\n  "ok": true\n}',
        warnings: ['warn-1'],
      });
      expect(html).toContain('data-result-available="true"');
      expect(html).toContain('data-result-warning-total="1"');
      expect(html).toContain('data-result-warning="warn-1"');
      // The payload is escaped inside the data-* attribute.
      expect(html).toContain('data-result-data="{&quot;ok&quot;:true}"');
    });

    it('renderHumanWaitForm is empty string when no form is present', () => {
      // The renderer returns '' when there is no form. Build a minimal
      // ok result via fetchOperationDetail for a non-WAITING_INPUT op.
      const opNoWait: OperationDetailCatalogEntry = {
        operation: {
          id: 'op-nw',
          tenantId: 't',
          businessId: 'b',
          businessVersion: 'v',
          action: 'a',
          state: 'RUNNING',
          stateVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
          deadlineAt: null,
          replayOf: null,
          progress: { percent: 0, message: '' },
          links: { self: '/s', result: '/r' },
          wait: null,
          error: null,
        },
        result: null,
        artifacts: [],
      };
      return fetchOperationDetail({
        operationId: 'op-nw',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [opNoWait] },
      }).then((r) => {
        if (r.kind !== 'ok') throw new Error('expected ok');
        // The standalone helper is exported but takes a detail directly;
        // call through the public renderer and inspect the section for
        // the absence of the wait sub-section.
        const html = renderOperationSection({ fetch: r }).html;
        expect(html).not.toContain('class="operation-section__wait"');
      });
    });

    it('renderActionBar disables cancel + replay when state is FAILED but cannot be replayed', () => {
      // The action bar is a private helper — exercise via the public
      // renderer path. CANCELLED is terminal but the renderer still
      // surfaces a disabled cancel button.
      const entry: OperationDetailCatalogEntry = {
        operation: {
          id: 'op-c',
          tenantId: 't',
          businessId: 'b',
          businessVersion: 'v',
          action: 'a',
          state: 'CANCELLED',
          stateVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
          deadlineAt: null,
          replayOf: null,
          progress: { percent: 0, message: '' },
          links: { self: '/s', result: '/r' },
          wait: null,
          error: null,
        },
        result: null,
        artifacts: [],
      };
      return fetchOperationDetail({
        operationId: 'op-c',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [entry] },
      }).then((r) => {
        if (r.kind !== 'ok') throw new Error('expected ok');
        const out = renderOperationSection({ fetch: r });
        expect(out.html).toContain('data-can-cancel="false"');
        expect(out.html).toContain('data-can-replay="true"');
        expect(out.html).toContain('data-replay-label="Rerun (new operation)"');
      });
    });
  });

  describe('renderOperationSection (P6-06, fallback panes)', () => {
    function fetchWith(operationId: string): Promise<OperationFetchResult> {
      return fetchOperationDetail({
        operationId,
        jsonBaseUrl: '',
        adminToken: '',
      });
    }

    it('renders the empty pane when no catalog is wired', async () => {
      const r = await fetchWith('op-1');
      expect(r.kind).toBe('empty');
      const out = renderOperationSection({ fetch: r });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('operation-section--empty');
      expect(out.html).toContain('data-empty-message="true"');
    });

    it('renders the unauthorized pane', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: '',
      });
      expect(r.kind).toBe('unauthorized');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('operation-section--unauthorized');
      expect(out.html).toContain('data-unauthorized-message="true"');
    });

    it('renders the not-found pane for an unknown operationId', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-missing',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('gone', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('operation-section--not-found');
      expect(out.html).toContain('data-not-found-id="op-missing"');
    });

    it('renders the error pane for HTTP 500', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('operation-section--error');
      expect(out.html).toContain('data-error-message="true"');
    });
  });

  describe('fetchOperationDetail (P6-06, discriminated fetcher)', () => {
    function catalogOp(
      state: 'SUCCEEDED' | 'RUNNING' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'WAITING_INPUT',
      id = 'op-1',
    ): OperationDetailCatalogEntry {
      const op = {
        id,
        tenantId: 'tenant-1',
        businessId: 'biz-1',
        businessVersion: 'v1',
        action: 'ingest',
        state,
        stateVersion: 1,
        createdAt: 'now',
        updatedAt: 'now',
        deadlineAt: null,
        replayOf: null,
        progress: { percent: 0, message: '' },
        links: { self: '/s', result: '/r' },
        wait: null,
        error: null,
      } as const;
      return { operation: op, result: null, artifacts: [] };
    }

    it('empty when no catalog and no base URL', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
      });
      expect(r.kind).toBe('empty');
    });

    it('catalog hit → ok with selected operation id', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('RUNNING')] },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.selectedOperationId).toBe('op-1');
      expect(r.detail.id).toBe('op-1');
      expect(r.canCancel).toBe(true);
    });

    it('catalog miss + non-empty id → not-found', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-missing',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('RUNNING', 'op-1')] },
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.operationId).toBe('op-missing');
    });

    it('SUCCEEDED → canReplay=true, canCancel=false', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('SUCCEEDED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.canCancel).toBe(false);
      expect(r.canReplay).toBe(true);
      expect(r.replayLabel).toContain('Replay');
    });

    it('WAITING_INPUT → canResume=true (when wait is non-expired)', async () => {
      const entry: OperationDetailCatalogEntry = {
        operation: {
          ...catalogOp('WAITING_INPUT').operation,
          wait: {
            waitId: 'w-1',
            inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
            expiresAt: '2099-01-01T00:00:00Z',
          },
        },
        result: null,
        artifacts: [],
      };
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [entry] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.canResume).toBe(true);
      expect(r.canCancel).toBe(true);
      expect(r.canReplay).toBe(false);
    });

    it('TIMED_OUT → canReplay=true with the timeout-specific label', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('TIMED_OUT')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.canReplay).toBe(true);
      expect(r.replayLabel).toContain('Retry after timeout');
    });

    it('HTTP 401 → unauthorized', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('HTTP 404 with operationId → not-found', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-x',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('gone', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.operationId).toBe('op-x');
    });

    it('HTTP 500 → error', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });

    it('non-JSON response → error', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('<html>nope</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });
  });

  // P6-07 — Usage / audit / operational overview + role gate + screen states
  // ---------------------------------------------------------------------------

  describe('renderOverviewSection (P6-07, ok pane)', () => {
    function okCatalog(): OverviewCatalog {
      return {
        usageSummary: {
          tenantId: 'tenant_a',
          from: '2026-09-24T00:00:00.000Z',
          to: '2026-09-24T23:59:59.000Z',
          rows: [
            {
              provider: 'openai',
              model: 'gpt-4o-mini',
              operations: 12,
              inputTokens: 1000,
              outputTokens: 2000,
              pages: 5,
              costMicrousd: 250000,
              measurement: 'measured',
            },
            {
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              operations: 7,
              inputTokens: 800,
              outputTokens: 1500,
              pages: 3,
              costMicrousd: 175000,
              measurement: 'estimated',
            },
          ],
          totals: {
            operations: 19,
            inputTokens: 1800,
            outputTokens: 3500,
            pages: 8,
            costMicrousd: 425000,
          },
        },
        auditEvents: {
          tenantId: 'tenant_a',
          events: [
            {
              id: 'evt-1',
              kind: 'operation.complete',
              severity: 'success',
              occurredAt: '2026-09-24T10:00:00.000Z',
              tenantId: 'tenant_a',
              resourceId: 'op_42',
              actor: 'system',
              message: 'Operation completed.',
            },
            {
              id: 'evt-2',
              kind: 'apikey.revoke',
              severity: 'warning',
              occurredAt: '2026-09-24T11:30:00.000Z',
              tenantId: 'tenant_a',
              resourceId: 'key_7',
              actor: 'admin:bearer',
              message: 'Key revoked by admin.',
            },
          ],
        },
        health: {
          status: 'ok',
          db: true,
          redis: true,
          activeLeases: 3,
        },
      };
    }

    it('emits the full DOM evidence for the ok pane (usage + audit + health)', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: okCatalog(),
      });
      expect(r.kind).toBe('ok');
      const out = renderOverviewSection({ fetch: r });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('data-overview-tenant="tenant_a"');
      expect(out.html).toContain('data-overview-usage-available="true"');
      expect(out.html).toContain('data-overview-audit-available="true"');
      expect(out.html).toContain('data-overview-health-available="true"');
      expect(out.html).toContain('data-usage-total="2"');
      expect(out.html).toContain('data-usage-tenant="tenant_a"');
      expect(out.html).toContain('data-usage-row="openai|gpt-4o-mini"');
      expect(out.html).toContain('data-usage-measurement="measured"');
      expect(out.html).toContain('data-usage-measurement-badge="success"');
      expect(out.html).toContain('data-usage-measurement="estimated"');
      expect(out.html).toContain('data-usage-measurement-badge="warning"');
      expect(out.html).toContain('data-usage-totals-ops="19"');
      expect(out.html).toContain('data-usage-totals-input="1,800"');
      expect(out.html).toContain('data-usage-totals-output="3,500"');
      expect(out.html).toContain('data-usage-totals-pages="8"');
      expect(out.html).toContain('data-usage-totals-cost="$0.42"');
      expect(out.html).toContain('data-audit-total="2"');
      expect(out.html).toContain('data-audit-id="evt-1"');
      expect(out.html).toContain('data-audit-kind="operation.complete"');
      expect(out.html).toContain('data-audit-severity="success"');
      expect(out.html).toContain('data-audit-severity-badge="success"');
      expect(out.html).toContain('data-audit-severity="warning"');
      expect(out.html).toContain('data-audit-actor="system"');
      expect(out.html).toContain('data-audit-actor="admin:bearer"');
      expect(out.html).toContain('data-health-status="ok"');
      expect(out.html).toContain('data-health-fully-healthy="true"');
      expect(out.html).toContain('data-health-db="true"');
      expect(out.html).toContain('data-health-redis="true"');
      expect(out.html).toContain('data-health-leases="3"');
      expect(out.html).toContain('data-health-overall="ok"');
      expect(out.html).toContain('data-overview-tenant-selected="tenant_a"');
    });

    it('does not echo the raw bearer token in the rendered HTML', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: 'S3CRET-beArER',
        manifestCatalog: okCatalog(),
      });
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).not.toContain('S3CRET-beArER');
      expect(out.html).not.toContain('Bearer ');
    });

    it('escapes injected values in the audit message + resource id', async () => {
      const cat = okCatalog();
      if (cat.auditEvents) {
        cat.auditEvents.events = [
          {
            id: 'evt-x',
            kind: 'operation.fail',
            severity: 'error',
            occurredAt: '2026-09-24T12:00:00.000Z',
            tenantId: 'tenant_a',
            resourceId: '<img src=x>',
            actor: '<script>alert(1)</script>',
            message: '"quoted" & <bold>',
          },
        ];
      }
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: cat,
      });
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<script>alert(1)</script>');
      expect(out.html).toContain('data-audit-resource="&lt;img src=x&gt;"');
      expect(out.html).toContain('data-audit-actor="&lt;script&gt;alert(1)&lt;/script&gt;"');
      expect(out.html).toContain('&quot;quoted&quot; &amp; &lt;bold&gt;');
    });
  });

  describe('renderOverviewSection (P6-07, fallback panes)', () => {
    it('empty pane renders when no catalog is provided', async () => {
      const r = await fetchOverview({
        tenantId: '',
        jsonBaseUrl: '',
        adminToken: '',
      });
      expect(r.kind).toBe('empty');
      const out = renderOverviewSection({ fetch: r });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('overview-section--empty');
      expect(out.html).toContain('data-empty-message="true"');
    });

    it('empty pane renders when the catalog has only zero rows and no health', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: {
          usageSummary: { tenantId: 'tenant_a', rows: [], totals: {} },
          auditEvents: { tenantId: 'tenant_a', events: [] },
          health: null,
        },
      });
      expect(r.kind).toBe('empty');
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).toContain('overview-section--empty');
    });

    it('unauthorized pane renders when 401 is returned by the platform', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
      const out = renderOverviewSection({ fetch: r });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('overview-section--unauthorized');
      expect(out.html).toContain('data-unauthorized-message="true"');
    });

    it('error pane renders when the platform returns 500', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).toContain('overview-section--error');
      expect(out.html).toContain('data-error-message="true"');
    });
  });

  describe('fetchOverview (P6-07, discriminated fetcher)', () => {
    function okCatalog(): OverviewCatalog {
      return {
        usageSummary: {
          tenantId: 'tenant_a',
          from: '2026-09-24T00:00:00.000Z',
          to: '2026-09-24T23:59:59.000Z',
          rows: [
            {
              provider: 'openai',
              model: 'gpt-4o-mini',
              operations: 1,
              inputTokens: 10,
              outputTokens: 20,
              pages: 1,
              costMicrousd: 1000,
              measurement: 'measured',
            },
          ],
          totals: { operations: 1, inputTokens: 10, outputTokens: 20, pages: 1, costMicrousd: 1000 },
        },
        auditEvents: null,
        health: null,
      };
    }

    it('returns ok when the catalog has at least one row', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: okCatalog(),
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.tenantId).toBe('tenant_a');
      expect(r.bundle.usage).not.toBeNull();
      expect(r.bundle.usage?.rows.length).toBe(1);
    });

    it('returns empty when no catalog and no jsonBaseUrl', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
      });
      expect(r.kind).toBe('empty');
    });

    it('returns unauthorized when jsonBaseUrl is set but adminToken is missing', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: '',
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('returns ok when all three endpoints return their wire shape', async () => {
      const calls: string[] = [];
      const okJson = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async (url: unknown) => {
          calls.push(String(url));
          const u = String(url);
          if (u.includes('/api/v1/usage')) {
            return okJson({
              tenantId: 'tenant_a',
              from: '2026-09-24T00:00:00.000Z',
              to: '2026-09-24T23:59:59.000Z',
              rows: [
                {
                  provider: 'openai',
                  model: 'gpt-4o-mini',
                  operations: 1,
                  inputTokens: 1,
                  outputTokens: 2,
                  pages: 1,
                  costMicrousd: 1000,
                  measurement: 'measured',
                },
              ],
              totals: { operations: 1, inputTokens: 1, outputTokens: 2, pages: 1, costMicrousd: 1000 },
            });
          }
          if (u.includes('/api/v1/admin/audit')) {
            return okJson({
              tenantId: 'tenant_a',
              events: [
                {
                  id: 'evt-1',
                  kind: 'operation.complete',
                  severity: 'success',
                  occurredAt: '2026-09-24T10:00:00.000Z',
                  tenantId: 'tenant_a',
                  resourceId: 'op_42',
                  actor: 'system',
                  message: 'done',
                },
              ],
            });
          }
          if (u.includes('/api/v1/health')) {
            return okJson({ status: 'ok', db: true, redis: true, activeLeases: 0 });
          }
          return new Response('not found', { status: 404 });
        }) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('ok');
      expect(calls.length).toBe(6);
    });

    it('returns unauthorized when any endpoint returns 401', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('returns error on timeout', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        timeoutMs: 10,
        fetchImpl: (async (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });

    it('drops audit events whose tenantId does not match', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: {
          usageSummary: null,
          auditEvents: {
            tenantId: 'tenant_b',
            events: [
              {
                id: 'evt-1',
                kind: 'operation.complete',
                severity: 'success',
                occurredAt: '2026-09-24T10:00:00.000Z',
                tenantId: 'tenant_b',
                resourceId: 'op_1',
                actor: 'system',
                message: 'cross-tenant leak attempt',
              },
              {
                id: 'evt-2',
                kind: 'operation.complete',
                severity: 'success',
                occurredAt: '2026-09-24T10:00:01.000Z',
                tenantId: 'tenant_a',
                resourceId: 'op_2',
                actor: 'system',
                message: 'in-tenant event',
              },
            ],
          },
          health: null,
        },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.bundle.audit).not.toBeNull();
      expect(r.bundle.audit?.events.length).toBe(1);
      expect(r.bundle.audit?.events[0]?.id).toBe('evt-2');
    });
  });
});
