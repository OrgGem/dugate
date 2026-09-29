/**
 * Pure HTML renderer for the Admin shell (P6-01).
 *
 * No framework, no JSX, no DOM. The orchestrator ships with
 * `lib: ["ES2022"]` and no browser deps in `node_modules`. The
 * renderer produces a complete HTML document string per request.
 *
 * Output is XHTML-strict-friendly: every attribute is quoted, every
 * text node goes through `esc()` so injected values cannot break out.
 *
 * Pure: the only inputs are the shell view-model (from
 * `p6-01-shell-fixtures.ts`) and the optional screen-state. No DB,
 * no Redis, no I/O.
 *
 * Strict TypeScript, zero `any`.
 */

import type { AdminScreenState, AdminShellView, BreadcrumbEntry } from './p6-01-shell-fixtures';
import { ROLE_ORDER } from './types';
import type { AdminSection, NavItem } from './types';

/**
 * W-ADM-UX-03-AUDIT-ROUTE (Delta 130): the audit ledger pane path.
 * Exported so the route matcher and the nav tab cannot drift.
 */
export const AUDIT_NAV_PATH = '/admin/audit';

// ---------------------------------------------------------------------------
// HTML escape
// ---------------------------------------------------------------------------

/**
 * Escape for HTML text content and unquoted attributes. Replaces
 * the five characters that can break out of either context. Callers
 * embedding into a quoted attribute also escape their quotes via
 * `escAttr` (alias of this).
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    switch (ch) {
      case 0x26: out += '&amp;'; break; // &
      case 0x3c: out += '&lt;'; break;  // <
      case 0x3e: out += '&gt;'; break;  // >
      case 0x22: out += '&quot;'; break; // "
      case 0x27: out += '&#39;'; break; // '
      default: out += s[i];
    }
  }
  return out;
}

/** Attribute-safe escape (same characters as `esc`). */
export const escAttr = esc;

// ---------------------------------------------------------------------------
// h() — minimal string-templated element
// ---------------------------------------------------------------------------

/**
 * Allowed tag whitelist. Tags outside this list fall back to a `<div>`
 * with a `data-block-tag` attribute so the rendered HTML remains
 * parsable but untrusted input cannot inject `<script>`, `<iframe>`,
 * etc. The renderer is intentionally narrow.
 */
const ALLOWED_TAGS = new Set<string>([
  'a', 'article', 'b', 'blockquote', 'br', 'button', 'code',
  'dd', 'div', 'dl', 'dt', 'em', 'form', 'h1', 'h2', 'h3', 'h4',
  'header', 'hr', 'i', 'input', 'label', 'li', 'main', 'nav', 'ol',
  'p', 'pre', 'section', 'small', 'span', 'strong', 'table', 'tbody',
  'td', 'th', 'thead', 'tr', 'ul',
]);

function renderAttrs(attrs: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (v === false) continue; // explicit-false omits
    if (v === true) parts.push(` ${k}`); // boolean true → bare attr
    else parts.push(` ${k}="${escAttr(v)}"`);
  }
  return parts.join('');
}

export interface HtmlNode {
  /** Element name; falls back to `div` if not in the whitelist. */
  tag: string;
  attrs: Record<string, string | number | boolean | undefined>;
  children: HtmlNode[];
  /** Raw text content; escaped on render. Empty when children present. */
  text?: string;
}

function nodeFromParts(
  tag: string,
  attrs: Record<string, string | number | boolean | undefined> | undefined,
  children: (HtmlNode | string | undefined | null | false)[],
): HtmlNode {
  const childNodes: HtmlNode[] = [];
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (typeof c === 'string') {
      childNodes.push({ tag: '#text', attrs: {}, children: [], text: c });
    } else {
      childNodes.push(c);
    }
  }
  return {
    tag: ALLOWED_TAGS.has(tag) ? tag : 'div',
    attrs: { ...(attrs ?? {}), 'data-block-tag': ALLOWED_TAGS.has(tag) ? undefined : tag },
    children: childNodes,
  };
}

/** Build a node from a tag, attrs, and children. Children may be strings or nodes. */
export function h(
  tag: string,
  attrs: Record<string, string | number | boolean | undefined> | undefined,
  ...children: (HtmlNode | string | undefined | null | false)[]
): HtmlNode {
  return nodeFromParts(tag, attrs, children);
}

// ---------------------------------------------------------------------------
// Render a node tree to a string
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set<string>(['br', 'hr', 'input']);

export function renderNode(node: HtmlNode): string {
  const tag = node.tag;
  if (tag === '#text') {
    return node.text !== undefined ? esc(node.text) : '';
  }
  const attrs = renderAttrs(node.attrs);
  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrs}>`;
  }
  const inner = node.children.map(renderNode).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

// ---------------------------------------------------------------------------
// Section content stubs
// ---------------------------------------------------------------------------

/** Build the concise fallback body for a known section. */
function renderSectionBody(section: AdminSection): string {
  return [
    `<h2>${esc(section)}</h2>`,
    '<p>Section content will appear here when available.</p>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Screen-state renderers
// ---------------------------------------------------------------------------

function renderScreenState(state: AdminScreenState): string {
  switch (state.kind) {
    case 'loading':
      return [
        '<section class="screen-state screen-state--loading" role="status" aria-live="polite">',
        '<h2>Loading…</h2>',
        state.section
          ? `<p>Loading section <code>${esc(state.section)}</code>.</p>`
          : '<p>Loading the Admin home.</p>',
        '</section>',
      ].join('');
    case 'empty':
      return [
        '<section class="screen-state screen-state--empty">',
        `<h2>No ${esc(state.section)} yet</h2>`,
        `<p>${esc(state.message)}</p>`,
        '</section>',
      ].join('');
    case 'error':
      return [
        '<section class="screen-state screen-state--error" role="alert">',
        '<h2>Something went wrong</h2>',
        `<p>${esc(state.message)}</p>`,
        state.section
          ? `<p>Section: <code>${esc(state.section)}</code></p>`
          : '<p>The Admin home could not be loaded.</p>',
        '</section>',
      ].join('');
    case 'denied':
      return [
        '<section class="screen-state screen-state--denied" role="alert">',
        '<h2>Access denied</h2>',
        `<p>${esc(state.reason)}</p>`,
        `<p>You are signed in as <code>${esc(state.role)}</code>; this section requires <code>${esc(state.requiredRole)}</code>.</p>`,
        '</section>',
      ].join('');
    case 'ready':
      return [
        '<section class="screen-state screen-state--ready">',
        `<h2>${esc(state.section)}</h2>`,
        renderSectionBody(state.section),
        '</section>',
      ].join('');
  }
}

// ---------------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------------

/** A login form page (when no valid cookie). */
export function renderLoginPage(opts: {
  redirect: string;
  error?: string;
  csrfMarker: string;
}): string {
  const errNode = opts.error
    ? h('p', { class: 'form-error', role: 'alert' }, opts.error)
    : undefined;
  const body = renderNode(
    h('main', { class: 'admin-shell' },
      h('header', { class: 'admin-shell__header' },
        h('h1', undefined, 'Admin sign-in'),
      ),
      h('section', { class: 'admin-shell__login' },
        h('form', {
          method: 'POST',
          action: '/admin/login',
          class: 'admin-login-form',
        },
          errNode,
          h('p', undefined,
            h('label', { for: 'admin-token' }, 'Admin bearer token'),
          ),
          h('input', {
            id: 'admin-token',
            name: 'token',
            type: 'password',
            autocomplete: 'off',
            required: true,
            'data-csrf': opts.csrfMarker,
          }),
          h('input', {
            type: 'hidden',
            name: 'redirect',
            value: opts.redirect,
          }),
          h('button', { type: 'submit' }, 'Sign in'),
        ),
        h('p', { class: 'admin-login__note' },
          'The shell reuses the orchestrator bearer token. The role is inferred from a token that begins with ',
          h('code', undefined, 'role:viewer:'),
          ', ',
          h('code', undefined, 'role:operator:'),
          ', or ',
          h('code', undefined, 'role:admin:'),
          '. Otherwise the role is ',
          h('code', undefined, 'admin'),
          '.',
        ),
      ),
    ),
  );
  return renderDocument('Admin sign-in', body);
}

/** Render an HTTP error page (401 / 403 / 404 / 500) inside the shell chrome. */
export function renderErrorPage(opts: {
  status: number;
  title: string;
  message: string;
}): string {
  const body = renderNode(
    h('main', { class: 'admin-shell' },
      h('header', { class: 'admin-shell__header' },
        h('h1', undefined, `Admin — ${esc(opts.status)}`),
      ),
      h('section', { class: 'screen-state screen-state--error', role: 'alert' },
        // Pass raw strings: `renderNode` escapes text-node children
        // exactly once. Pre-escaping here would double-encode (`'` →
        // `&#39;` → `&amp;#39;`).
        h('h2', undefined, opts.title),
        h('p', undefined, opts.message),
        h('p', undefined,
          h('a', { href: '/admin' }, 'Return to Admin home'),
        ),
      ),
    ),
  );
  return renderDocument(`Admin — ${opts.status}`, body);
}

// ---------------------------------------------------------------------------
// Shell chrome
// ---------------------------------------------------------------------------

/**
 * W-ADM-UX-03-AUDIT-ROUTE (Delta 130): the Audit Log tab.
 *
 * The ledger pane is reached by its OWN PATH, not as a data section:
 * NavItem.section is a closed union in types.ts, outside this packet
 * scope, so the tab is appended here rather than faked as a section -
 * the same treatment /admin/crypto-config already gets.
 *
 * Role gate is operator, matching the profiles/connectors panes: the
 * ledger is tenant-scoped operational data. A tab the route would then
 * refuse would be a lie, so tab and route share one gate.
 */
export function renderAuditNavTab(view: AdminShellView): string {
  if (ROLE_ORDER[view.role] < ROLE_ORDER.operator) return '';
  const active = view.currentPath === AUDIT_NAV_PATH;
  return renderNode(
    h('li',
      { class: active ? 'admin-nav__item admin-nav__item--active' : 'admin-nav__item' },
      h('a', { href: AUDIT_NAV_PATH, 'aria-current': active ? 'page' : undefined }, 'Audit Log'),
    ),
  );
}

function renderNav(view: AdminShellView): string {
  const items = view.visibleNav.map((item: NavItem) => {
    const active = item.section === view.currentSection;
    return renderNode(
      h('li', { class: active ? 'admin-nav__item admin-nav__item--active' : 'admin-nav__item' },
        h('a', { href: item.path, 'aria-current': active ? 'page' : undefined },
          esc(item.label),
        ),
      ),
    );
  }).join('');
  return [
    '<ul class="admin-nav" role="list">',
    items,
    renderAuditNavTab(view),
    '</ul>',
  ].join('');
}

function renderBreadcrumbs(view: AdminShellView): string {
  const crumbs = view.breadcrumbs.map((b: BreadcrumbEntry, idx: number) => {
    const sep = idx === view.breadcrumbs.length - 1 ? '' : ' › ';
    const label = esc(b.label);
    const link = `<a href="${escAttr(b.path)}">${label}</a>${sep}`;
    return idx === view.breadcrumbs.length - 1
      ? `<span class="admin-breadcrumbs__current" aria-current="page">${label}</span>`
      : link;
  }).join('');
  return `<nav class="admin-breadcrumbs" aria-label="Breadcrumbs">${crumbs}</nav>`;
}

function renderShellChrome(view: AdminShellView): string {
  return renderNode(
    h('header', { class: 'admin-shell__header' },
      h('h1', undefined, 'Admin'),
      h('span', { class: 'admin-shell__role', 'data-role': view.role },
        `Role: ${esc(view.role)}`,
      ),
      h('form', { method: 'POST', action: '/admin/logout', class: 'admin-shell__logout' },
        h('button', { type: 'submit' }, 'Sign out'),
      ),
    ),
  );
}

/**
 * Render the full Admin shell — nav, breadcrumbs, role badge, content.
 * `state` drives the body pane; the chrome is always the same.
 */
export function renderShell(view: AdminShellView, state: AdminScreenState): string {
  const chrome = renderShellChrome(view);
  const nav = `<nav class="admin-shell__nav" aria-label="Admin navigation">${renderNav(view)}</nav>`;
  const crumbs = renderBreadcrumbs(view);
  // W48-O2 (ADM-UX-01): each section renderer emits raw <table> markup.
  // Wrap every top-level <table> in `.adm-reflow-scroller` so the
  // wrapper becomes an independent layout root (overflow: clip +
  // contain: layout paint) and the table cannot leak into the page
  // scroll chain at 320 CSS px. The helper is idempotent and a no-op
  // when no <table> is present (loading/empty/error/denied states).
  const body = wrapTablesForReflow(renderScreenState(state));
  const html = [
    '<main class="admin-shell" data-admin-shell="v1">',
    chrome,
    nav,
    '<section class="admin-shell__main" aria-label="Admin content">',
    crumbs,
    body,
    '</section>',
    '</main>',
  ].join('');
  return renderDocument(`Admin — ${view.currentSection ?? 'home'}`, html);
}

// ---------------------------------------------------------------------------
// Document scaffolding
// ---------------------------------------------------------------------------

export function renderDocument(title: string, body: string): string {
  const safeTitle = esc(title);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    '<style>',
    CSS,
    '</style>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('');
}

const CSS = [
  '*, *::before, *::after { box-sizing: border-box; }',
  'html { min-width: 0; }',
  'body { font-family: system-ui, sans-serif; margin: 0; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }',
  '.admin-shell__header { grid-area: header; display: flex; align-items: center; gap: .75rem; min-width: 0; min-height: 3.25rem; padding: .5rem 1rem; border-bottom: 1px solid #ccc; }',
  '.admin-shell__header h1 { margin: 0; font-size: 1.25rem; line-height: 1.2; }',
  '.admin-shell__role { padding: .2rem .45rem; border-radius: .25rem; background: #eef; font-size: .875rem; white-space: nowrap; }',
  '.admin-shell__role[data-role="admin"] { background: #fdd; }',
  '.admin-shell__role[data-role="operator"] { background: #dfd; }',
  '.admin-shell__role[data-role="viewer"] { background: #ddf; }',
  '.admin-shell__logout { margin-left: auto; }',
  '.admin-shell__logout button { min-height: 2.25rem; padding: .35rem .65rem; }',
  // Keep a compact, full-width header above the section nav and main
  // content. Min-width zero on grid tracks keeps long values inside
  // their own reflow regions.
  '.admin-shell[data-admin-shell="v1"] { display: grid; grid-template-columns: 12rem minmax(0, 1fr); grid-template-areas: "header header" "nav main"; min-width: 0; }',
  '.admin-shell__nav { grid-area: nav; min-width: 0; padding: .5rem; border-right: 1px solid #eee; }',
  '.admin-shell__main { grid-area: main; min-width: 0; padding: .75rem 1rem 1rem; }',
  '@media (max-width: 640px) {',
  '  .admin-shell[data-admin-shell="v1"] { grid-template-columns: minmax(0, 1fr); grid-template-areas: "header" "nav" "main"; }',
  '  .admin-shell__header { gap: .5rem; padding: .5rem .75rem; }',
  '  .admin-shell__nav { padding: .35rem .5rem; border-right: none; border-bottom: 1px solid #eee; }',
  '  .admin-shell__main { padding: .75rem; }',
  '  .admin-nav { display: flex; flex-wrap: wrap; gap: .25rem .375rem; }',
  '  .admin-shell__nav .admin-nav__item { padding: 0; }',
  '  .admin-nav__item a { display: block; padding: .35rem .45rem; border-radius: .25rem; }',
  '}',
  '.admin-nav { list-style: none; padding: 0; margin: 0; }',
  '.admin-nav__item { padding: .25rem 0; }',
  '.admin-nav__item a { color: inherit; text-decoration: none; overflow-wrap: anywhere; }',
  '.admin-nav__item--active a { font-weight: 600; background: #eef3fb; }',
  '.admin-shell a:focus-visible, .admin-shell button:focus-visible, .adm-reflow-scroller:focus { outline: 2px solid #1d5fd1; outline-offset: 2px; }',
  '.admin-shell__main > *, .admin-shell__main pre { max-width: 100%; }',
  '.admin-shell__main pre { white-space: pre-wrap; overflow-wrap: anywhere; }',
  // W48-O2 (ADM-UX-01): wrapper for content <table> emitters
  // (api-key-section__list, overview-section__usage-table,
  // overview-section__audit-table, api-key-section__grants-table,
  // operation-section__artifacts-table). The wrapper is a scrollable
  // region so users can reach the rightmost cells / action buttons
  // (Revoke, Cancel, Resume, Replay, Download artifact…) at 320 CSS px
  // when the natural table width exceeds the viewport. Each scroll
  // region has a unique accessible label; `tabindex="0"` lets keyboard
  // users focus the scroller and arrow-key across clipped columns.
  // `overflow-x: auto` keeps horizontal scrolling inside the region;
  // `contain: layout paint` keeps the
  // scroller an independent layout root so its child does not leak
  // into `documentElement.scrollWidth`. The table inside keeps
  // `display: table` so internal rows (THEAD/TBODY/TR/TH/TD) respect
  // table-layout semantics instead of escaping the clip.
  '.adm-reflow-scroller { display: block; width: 100%; max-width: 100%; min-width: 0; overflow-x: auto; overflow-y: hidden; contain: layout paint; }',
  '.adm-reflow-scroller:focus { outline: 2px solid #4d90fe; outline-offset: 2px; }',
  '.adm-reflow-scroller > table { display: table; width: 100%; max-width: 100%; border-collapse: collapse; table-layout: auto; }',
  // W-ADMUX-01 (ADM-UX-01/05): pagination bar for the operations list.
  // Wraps instead of overflowing at 320 CSS px; page-size group falls
  // back to its own line on narrow screens.
  '.admin-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .75rem 0; padding: .5rem .75rem; border: 1px solid #eee; border-radius: .5rem; box-sizing: border-box; }',
  '.admin-pagination a { padding: .25rem .5rem; border: 1px solid #ccc; border-radius: .25rem; text-decoration: none; white-space: nowrap; }',
  '.admin-pagination .admin-pagination__prev--disabled, .admin-pagination .admin-pagination__next--disabled { padding: .25rem .5rem; border: 1px dashed #ccc; border-radius: .25rem; color: #777; white-space: nowrap; }',
  '.admin-pagination__count { font-size: .875rem; overflow-wrap: anywhere; }',
  '.admin-pagination__sizes { display: inline-flex; gap: .25rem; margin-left: auto; }',
  '.admin-pagination__sizes a[aria-current="true"] { font-weight: 700; background: #eef; }',
  '.admin-pagination__note { flex: 1 1 100%; font-size: .8125rem; color: #666; }',
  '@media (max-width: 480px) { .admin-pagination { gap: .25rem; padding: .5rem; } .admin-pagination__sizes { margin-left: 0; width: 100%; justify-content: flex-start; } }',
  // W-ADMUX-01 (ADM-UX-01): column priority on the operations list.
  // p4/p3/p2 columns drop out by viewport width; p1 (id + state) always
  // stays visible and the shell's reflow scroller remains the fallback
  // for any residual width. The back link sits above the detail header.
  '.operation-section__list-table th, .operation-section__list-table td { padding: .35rem .5rem; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }',
  '.operation-section__list-table td a { overflow-wrap: anywhere; }',
  '.operation-section__back { margin: 0 0 .5rem; }',
  // W-ADMUX-03-FILTER-1: GET toolbar + active-filter chips. A plain
  // flex-wrap grid (label/field pairs) so 320 CSS px reflows to one
  // field per line without horizontal page scroll.
  '.admin-filter-bar { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; margin: .5rem 0; padding: .5rem .75rem; border: 1px solid #eee; border-radius: .5rem; box-sizing: border-box; }',
  '.admin-filter-bar__label { font-size: .8125rem; color: #444; margin-right: .25rem; }',
  '.admin-filter-bar select, .admin-filter-bar input { padding: .25rem .4rem; border: 1px solid #ccc; border-radius: .25rem; font: inherit; max-width: 100%; min-width: 0; box-sizing: border-box; }',
  '.admin-filter-bar__apply { padding: .3rem .7rem; border: 1px solid #4d90fe; border-radius: .25rem; background: #4d90fe; color: #fff; font: inherit; }',
  '.admin-filter-chips { display: flex; flex-wrap: wrap; gap: .375rem; margin: .25rem 0 .5rem; }',
  '.admin-filter-chips--empty { display: none; }',
  '.admin-filter-chip { display: inline-flex; align-items: center; gap: .375rem; padding: .125rem .5rem; border: 1px solid #cfd8ea; border-radius: 1rem; background: #eef3fb; font-size: .8125rem; }',
  '.admin-filter-chip a { text-decoration: none; font-weight: 700; }',
  '.admin-filter-chip--rejected { border-color: #fbb; background: #fff3f3; color: #7a1f1f; }',
  '.admin-filter-chip--clear-all { border-style: dashed; background: #fff; }',
  '@media (max-width: 480px) { .admin-filter-bar { align-items: stretch; } .admin-filter-bar select, .admin-filter-bar input, .admin-filter-bar__apply { flex: 1 1 100%; } .admin-filter-bar__label { flex: 1 1 100%; } }',
  '@media (max-width: 720px) { .adm-col-p4 { display: none; } }',
  '@media (max-width: 560px) { .adm-col-p3 { display: none; } }',
  '@media (max-width: 420px) { .adm-col-p2 { display: none; } }',
  '@media (max-width: 360px) { .admin-shell__header { flex-wrap: wrap; gap: .375rem; padding: .375rem .5rem; } .admin-shell__role { font-size: .8125rem; } .admin-shell__nav { padding: .25rem .375rem; } .admin-nav { gap: .125rem .25rem; } .admin-nav__item a { padding: .3rem .35rem; font-size: .875rem; } .admin-shell__main { padding: .5rem; } .admin-shell[data-admin-shell="v1"] .screen-state { padding: .75rem; } }',
  '.admin-breadcrumbs { font-size: .875rem; margin-bottom: .5rem; max-width: 100%; overflow-wrap: anywhere; }',
  '.screen-state { padding: 1rem; border-radius: .5rem; }',
  '.screen-state--loading { background: #f4f4f4; }',
  '.screen-state--empty { background: #eef; }',
  '.screen-state--error { background: #fee; border: 1px solid #fbb; }',
  '.screen-state--denied { background: #ffd; border: 1px solid #fbb; }',
  '.overview-section__filters { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; margin: .5rem 0 .75rem; padding: .5rem .75rem; border: 1px solid #ddd; border-radius: .5rem; }',
  '.overview-section__filters label { display: grid; gap: .2rem; min-width: 10rem; font-size: .8125rem; }',
  '.overview-section__filters input, .overview-section__filters select, .overview-section__filters button { max-width: 100%; min-width: 0; padding: .35rem .5rem; font: inherit; }',
  '.overview-section__filters button { border: 1px solid #4d90fe; border-radius: .25rem; background: #4d90fe; color: #fff; }',
  '.overview-section__clear { padding: .35rem .25rem; }',
  '.overview-section__triage { margin: .75rem 0 1rem; padding: .75rem; border: 1px solid #d7deea; border-radius: .5rem; background: #fbfcff; }',
  '.overview-section__triage-header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .25rem .75rem; }',
  '.overview-section__triage-header h2 { margin: 0; font-size: 1.1rem; }',
  '.overview-section__updated { margin: 0; font-size: .8125rem; color: #555; overflow-wrap: anywhere; }',
  '.overview-section__metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .5rem; margin-top: .6rem; }',
  '.overview-section__metric { min-width: 0; padding: .65rem; border: 1px solid #d9dee7; border-radius: .375rem; background: #fff; overflow-wrap: anywhere; }',
  '.overview-section__metric h3 { margin: 0; font-size: .9rem; }',
  '.overview-section__metric-value-row { margin: .2rem 0; font-size: 1.6rem; font-weight: 700; line-height: 1.2; }',
  '.overview-section__metric-link { color: #164ca1; text-decoration-thickness: .08em; }',
  '.overview-section__metric-status, .overview-section__metric-detail, .overview-section__metric-updated { margin: .15rem 0 0; font-size: .75rem; color: #555; }',
  '.overview-section__metric--stale { border-color: #d9a52e; background: #fffaf0; }',
  '.overview-section__metric--unavailable { border-style: dashed; color: #555; }',
  '.overview-section__triage-scope { margin: .6rem 0 0; font-size: .75rem; color: #555; }',
  '@media (max-width: 480px) { .overview-section__filters { align-items: stretch; padding: .5rem; } .overview-section__filters label, .overview-section__filters button, .overview-section__clear { flex: 1 1 100%; } .overview-section__triage { padding: .5rem; } }',
  '.screen-state--ready { background: #efe; }',
  '.admin-login-form { display: flex; flex-direction: column; gap: .5rem; max-width: 24rem; }',
  '.form-error { background: #fee; padding: .5rem; border: 1px solid #fbb; }',
].join('\n');

// ---------------------------------------------------------------------------
// Reflow table wrapper (WCAG 1.4.10)
// ---------------------------------------------------------------------------

/**
 * Wrap each table in a separately named, keyboard-focusable region so
 * wide columns do not leak into the page's horizontal scroll area.
 *
 * The section renderers (api-key / overview / operation) emit raw
 * `<table>` markup. Rather than thread a wrapper through each one,
 * the shell renderer applies this transformation once as the body
 * is composed. Admin table markup is flat and non-nested; callers pass
 * each table block through this helper once.
 *
 * Returns the input string unchanged when no `<table>` tag is
 * present.
 *
 * Exported because the deferred-extras path in `shell-server.ts`
 * also needs to wrap table markup emitted by the per-section
 * renderers. Keeping the helper in `shell-render.ts` (rather than
 * duplicating it) means a single regex owns the wrapper contract
 * for both the ready-state body and the deferred section HTML.
 */
export function wrapTablesForReflow(html: string): string {
  if (!html.includes('<table')) return html;
  // W48-O2 follow-up (Reviewer 6/6, ADM-UX-01 a11y): wrap each
  // <table> in a keyboard-focusable scrollable region so
  // users can reach clipped columns / action buttons (Revoke, Cancel,
  // Resume, Replay, Download artifact…) at 320 CSS px. `role="region"`
  // + a unique `aria-label` make the scroller discoverable to screen readers;
  // `tabindex="0"` lets keyboard users focus the scroller and arrow
  // across the clipped content. Admin tables are flat and are passed
  // through once so each region has one label and one focus stop.
  const tableCount = (html.match(/<table\b/g) ?? []).length;
  let tableIndex = 0;
  return html.replace(
    /(<table\b)/g,
    (tableOpen) => {
      tableIndex += 1;
      return `<div class="adm-reflow-scroller" role="region" aria-label="Scrollable data table ${tableIndex} of ${tableCount}" tabindex="0">${tableOpen}`;
    },
  ).replace(
    /(<\/table>)/g,
    '$1</div>',
  );
}
