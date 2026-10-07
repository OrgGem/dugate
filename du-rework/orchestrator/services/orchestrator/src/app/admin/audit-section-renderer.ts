/**
 * W-ADM-UX-03-AUDIT-TOOLBAR: audit ledger list pane - renderer.
 *
 * Pure HTML renderer for the /admin/audit pane: the filter toolbar, the
 * active-filter chips, the ledger table, and the keyset pagination nav.
 * It consumes the fetcher discriminated AuditFetchResult and emits fully
 * escaped, XHTML-friendly markup for the shell to splice into the page.
 *
 * Hard rules, all inherited from the operations toolbar (Muc 13/16/19):
 * - Every control is a plain link or a GET form. The admin shell ships no
 *   client JS, so refresh and back keep the filters through the URL and a
 *   button that needs a script would be inert.
 * - The toolbar form carries NO cursor field. Changing a filter or the
 *   ordering therefore structurally restarts at page 1 rather than
 *   replaying a cursor the route would reject (T140-A1: the cursor is
 *   bound to the ordering it was minted under).
 * - A rejected filter is named in a chip, never echoed: the value itself
 *   may have been a pasted credential.
 * - total is a COUNT of the FILTERED population, so the count line says
 *   how many events match rather than how many fit on a page.
 *
 * HTML attributes are single-quoted: esc() escapes both quote
 * characters, so the renderer is equally safe in either form.
 *
 * Strict TypeScript, zero any. Every value flowing into HTML goes
 * through esc().
 */

import { esc } from './shell-render';
import type { AuditFetchResult, AuditListOkResult, AuditListRow } from './audit-section-data';
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,

  AUDIT_LIST_DEFAULT_SORT,
  AUDIT_LIST_SORT_OPTIONS,
  AUDIT_SEVERITY_FILTERS,
  areAuditListFiltersActive,
  type AuditListFilters,
  type AuditSeverityFilter,
} from './audit-section-data';

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

export interface AuditSectionRenderInput {
  fetch: AuditFetchResult;
}

export interface AuditSectionRenderOutput {
  html: string;
  /** True iff the rendered HTML is the ledger table pane. */
  isReady: boolean;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Human labels for the severity chips. ALL is a UI value, not a wire one. */
const SEVERITY_LABEL: Record<AuditSeverityFilter, string> = {
  ALL: 'All severities',
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
};

/** Human labels for the two orderings, keyed by canonical field:direction. */
const SORT_LABEL: Record<string, string> = {
  'createdAt:desc': 'Newest first',
  'createdAt:asc': 'Oldest first',
};

/**
 * Badge tone per ledger severity. A bucket this build does not know falls
 * back to neutral rather than being dropped: the row still happened.
 */
function severityBadgeClass(severity: string): string {
  const tone =
    severity === 'info' ||
    severity === 'success' ||
    severity === 'warning' ||
    severity === 'error'
      ? severity
      : 'neutral';
  return 'status-badge status-badge--' + tone;
}

/** Exact UTC instant shape the route accepts, for the input hint. */
const TIME_INPUT_HINT = 'YYYY-MM-DDTHH:MM:SSZ';

// ---------------------------------------------------------------------------
// Link builder
// ---------------------------------------------------------------------------

/**
 * Build a /admin/audit URL from EFFECTIVE values only. A cursor is only
 * ever emitted together with the ordering it is bound to, and the
 * canonical default ordering is omitted because the route resolves an
 * absent sort to exactly what a default-minted cursor is bound to.
 */
function auditPageHref(opts: {
  limit: number;
  cursor?: string | null;
  filters?: AuditListFilters | null;
  sort?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.sort && opts.sort !== AUDIT_LIST_DEFAULT_SORT) {
    params.set('sort', opts.sort);
  }
  const fl = opts.filters;
  if (fl) {
    if (fl.severity !== 'ALL') params.set('severity', fl.severity);
    if (fl.actor) params.set('actor', fl.actor);
    if (fl.action) params.set('action', fl.action);
    if (fl.resource) params.set('resource', fl.resource);
    if (fl.from) params.set('from', fl.from);
    if (fl.to) params.set('to', fl.to);
  }
  return '/admin/audit?' + params.toString();
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/**
 * Server-rendered GET toolbar. Every submission is a plain link/GET
 * navigation, so refresh and back keep the filters via the URL; there is
 * no client fetch loop to debounce. The form deliberately carries NO
 * cursor field: applying a filter or changing the ordering restarts at
 * page 1 of the new view instead of replaying a cursor bound to the
 * ordering being left behind (T140-A1).
 *
 * The time inputs are text, not datetime-local, on purpose: a
 * datetime-local control submits a LOCAL wall-clock string with no zone,
 * which the route rejects - and silently reinterpreting it as UTC is
 * exactly what a ledger time filter must not do. The operator types the
 * instant the platform will actually compare against.
 */
function renderFilterBar(f: AuditListOkResult): string {
  const active = f.filters;
  const severityOptions = AUDIT_SEVERITY_FILTERS.map((value) => {
    const selected = value === active.severity ? ' selected' : '';
    return `<option value='${esc(value)}' data-filter-option='${esc(value)}'${selected}>${esc(SEVERITY_LABEL[value])}</option>`;
  }).join('');
  const sortOptions = AUDIT_LIST_SORT_OPTIONS.map((value) => {
    const selected = value === f.sort ? ' selected' : '';
    const label = SORT_LABEL[value] ?? value;
    return `<option value='${esc(value)}' data-sort-option='${esc(value)}'${selected}>${esc(label)}</option>`;
  }).join('');
  return [
    `<form class='admin-filter-bar' method='get' action='/admin/audit' data-filter-bar='true'>`,
    `<input type='hidden' name='limit' value='${f.limit}' data-filter-echo-limit='${f.limit}'>`,
    `<label class='admin-filter-bar__label' for='adm-filter-severity'>Severity</label>`,
    `<select id='adm-filter-severity' name='severity' data-filter-severity-select>${severityOptions}</select>`,
    `<label class='admin-filter-bar__label' for='adm-filter-actor'>Actor contains</label>`,
    `<input id='adm-filter-actor' name='actor' type='search' maxlength='64' autocomplete='off' placeholder='actor fragment' value='${esc(active.actor ?? '')}' data-filter-actor-input>`,
    `<label class='admin-filter-bar__label' for='adm-filter-action'>Action contains</label>`,
    `<input id='adm-filter-action' name='action' type='search' maxlength='64' autocomplete='off' placeholder='action fragment' value='${esc(active.action ?? '')}' data-filter-action-input>`,
    `<label class='admin-filter-bar__label' for='adm-filter-resource'>Resource contains</label>`,
    `<input id='adm-filter-resource' name='resource' type='search' maxlength='64' autocomplete='off' placeholder='resource fragment' value='${esc(active.resource ?? '')}' data-filter-resource-input>`,
    `<label class='admin-filter-bar__label' for='adm-filter-from'>From (UTC)</label>`,
    `<input id='adm-filter-from' name='from' type='text' maxlength='27' autocomplete='off' placeholder='${esc(TIME_INPUT_HINT)}' value='${esc(active.from ?? '')}' data-filter-from-input>`,
    `<label class='admin-filter-bar__label' for='adm-filter-to'>To (UTC)</label>`,
    `<input id='adm-filter-to' name='to' type='text' maxlength='27' autocomplete='off' placeholder='${esc(TIME_INPUT_HINT)}' value='${esc(active.to ?? '')}' data-filter-to-input>`,
    `<label class='admin-filter-bar__label' for='adm-filter-sort'>Sort</label>`,
    `<select id='adm-filter-sort' name='sort' data-filter-sort-select>${sortOptions}</select>`,
    `<button type='submit' class='admin-filter-bar__apply' data-filter-apply='true'>Apply filters</button>`,
    `<p class='admin-filter-bar__hint' data-filter-hint='true'>Time bounds are inclusive UTC instants shaped ${esc(TIME_INPUT_HINT)} - a local time, or a date without the trailing Z, is rejected rather than reinterpreted.</p>`,
    `</form>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// Active-filter chips
// ---------------------------------------------------------------------------

/**
 * One removable chip per active filter. The remove link drops that one
 * field and keeps everything else, including the page size the operator
 * chose; Clear all is a separate reset control below.
 */
function renderFilterChips(f: AuditListOkResult): string {
  const active = f.filters;
  const chips: string[] = [];
  const addChip = (field: string, label: string, cleared: AuditListFilters): void => {
    const href = auditPageHref({ limit: f.limit, filters: cleared, sort: f.sort });
    chips.push(
      `<span class='admin-filter-chip' data-filter-chip='${esc(field)}'>${esc(label)} ` +
      `<a href='${esc(href)}' aria-label='Remove the ${esc(field)} filter' data-filter-clear='${esc(field)}'>&#215; remove</a></span>`,
    );
  };

  if (active.severity !== 'ALL') {
    addChip(
      'severity',
      'Severity: ' + SEVERITY_LABEL[active.severity],
      { ...active, severity: 'ALL' },
    );
  }
  if (active.actor) {
    addChip('actor', 'Actor contains: ' + active.actor, { ...active, actor: null });
  }
  if (active.action) {
    addChip('action', 'Action contains: ' + active.action, { ...active, action: null });
  }
  if (active.resource) {
    addChip('resource', 'Resource contains: ' + active.resource, { ...active, resource: null });
  }
  if (active.from) {
    addChip('from', 'From: ' + active.from, { ...active, from: null });
  }
  if (active.to) {
    addChip('to', 'To: ' + active.to, { ...active, to: null });
  }
  for (const rejected of f.ignoredFilters) {
    // The field NAME is echoed; the value never is. An invalid token may
    // have been a pasted credential, and it must not re-enter the DOM.
    chips.push(
      `<span class='admin-filter-chip admin-filter-chip--rejected' role='status' data-filter-rejected='${esc(rejected)}'>Filter ${esc(rejected)} ignored (invalid characters)</span>`,
    );
  }
  if (chips.length === 0) {
    return `<div class='admin-filter-chips admin-filter-chips--empty' data-filter-chips='none'></div>`;
  }
  // Clear all is a RESET, not a filter edit: the per-chip removes above
  // keep the page size the operator chose, this one returns the contract
  // default first page - no filters, and no cursor into the population
  // being abandoned. It stays a GET link because the admin shell ships no
  // client JS, so a button here would be inert.
  const clearAll = auditPageHref({ limit: AUDIT_LIST_DEFAULT_LIMIT });
  chips.push(
    `<a class='admin-filter-chip admin-filter-chip--clear-all' href='${esc(clearAll)}' aria-label='Clear all filters and reset the page size to ${AUDIT_LIST_DEFAULT_LIMIT}' data-filter-clear-all='true'>Clear all</a>`,
  );
  return `<div class='admin-filter-chips' role='group' aria-label='Active filters' data-filter-chips='active'>${chips.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Ledger table
// ---------------------------------------------------------------------------

function renderSeverityBadge(severity: string): string {
  return (
    `<span class='${esc(severityBadgeClass(severity))}' data-audit-severity='${esc(severity)}'>` +
    esc(severity) +
    `</span>`
  );
}

function renderListRow(r: AuditListRow): string {
  return [
    `<tr class='audit-section__row' data-audit-event='${esc(r.id)}'>`,
    `<td class='audit-section__cell adm-col-p1' data-row-occurred-at='${esc(r.occurredAt)}'>${esc(r.occurredAt)}</td>`,
    `<td class='audit-section__cell adm-col-p1'>${renderSeverityBadge(r.severity)}</td>`,
    `<td class='audit-section__cell adm-col-p2' data-row-actor='${esc(r.actor)}'>${esc(r.actor)}</td>`,
    `<td class='audit-section__cell adm-col-p2' data-row-action='${esc(r.action)}'>${esc(r.action)}</td>`,
    `<td class='audit-section__cell adm-col-p3' data-row-resource='${esc(r.resource)}'>${esc(r.resource)}</td>`,
    `<td class='audit-section__cell adm-col-p4' data-row-tenant='${esc(r.tenantId ?? '')}'>${r.tenantId ? esc(r.tenantId) : '(none)'}</td>`,
    `</tr>`,
  ].join('');
}

function renderListTable(rows: readonly AuditListRow[]): string {
  return [
    `<table class='audit-section__list-table' data-list-table='true'>`,
    `<thead><tr>`,
    `<th class='adm-col-p1' scope='col'>Time</th>`,
    `<th class='adm-col-p1' scope='col'>Severity</th>`,
    `<th class='adm-col-p2' scope='col'>Actor</th>`,
    `<th class='adm-col-p2' scope='col'>Action</th>`,
    `<th class='adm-col-p3' scope='col'>Resource</th>`,
    `<th class='adm-col-p4' scope='col'>Tenant</th>`,
    `</tr></thead>`,
    `<tbody>${rows.map(renderListRow).join('')}</tbody>`,
    `</table>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Page sizes offered by the pagination controls; mirrors the route clamp. */
const LIST_PAGE_SIZES: readonly number[] = [20, 50, 100, AUDIT_LIST_MAX_LIMIT];

function renderPaginationNav(f: AuditListOkResult): string {
  const filtered = areAuditListFiltersActive(f.filters);
  const parts: string[] = [];
  parts.push(`<nav class='admin-pagination' aria-label='Audit ledger pages'>`);
  if (f.prevCursor) {
    const href = auditPageHref({
      limit: f.limit,
      cursor: f.prevCursor,
      filters: f.filters,
      sort: f.sort,
    });
    parts.push(
      `<a class='admin-pagination__prev' href='${esc(href)}' rel='prev' data-pagination-prev='link'>&#8592; Previous</a>`,
    );
  } else {
    parts.push(
      `<span class='admin-pagination__prev admin-pagination__prev--disabled' aria-disabled='true' data-pagination-prev='disabled'>&#8592; Previous</span>`,
    );
  }
  if (f.total === null) {
    // The platform withheld the count. Say the page is full and the
    // platform sent no continuation, rather than promising a total this
    // build never received.
    const scope = filtered ? ' on this filtered page' : ' on this page';
    parts.push(
      `<span class='admin-pagination__count' data-list-count='page'>${f.pageRows} events${scope} (page limit ${f.limit})</span>`,
    );
  } else {
    // total is a COUNT of the FILTERED population, so with filters active
    // it is the number of matches in total, not a page-local figure.
    const scope = filtered ? ' match the filters' : '';
    parts.push(
      `<span class='admin-pagination__count' data-list-count='exact'>${f.rows.length} of ${f.total} events${scope}</span>`,
    );
  }
  if (f.nextCursor) {
    const href = auditPageHref({
      limit: f.limit,
      cursor: f.nextCursor,
      filters: f.filters,
      sort: f.sort,
    });
    parts.push(
      `<a class='admin-pagination__next' href='${esc(href)}' rel='next' data-pagination-next='link'>Next &#8594;</a>`,
    );
  } else if (f.total === null && f.pageRows >= f.limit) {
    parts.push(
      `<span class='admin-pagination__next admin-pagination__next--disabled' aria-disabled='true' data-pagination-next='disabled'>Next &#8594;</span>`,
    );
    parts.push(
      `<span class='admin-pagination__note' data-pagination-cursor-unavailable='true'>This page is full and the platform returned no continuation cursor, so the next page cannot be loaded from here - narrow the filters or raise the page size to reach the rest.</span>`,
    );
  } else {
    parts.push(
      `<span class='admin-pagination__next admin-pagination__next--disabled' aria-disabled='true' data-pagination-next='end'>Next &#8594;</span>`,
    );
  }
  const sizes = LIST_PAGE_SIZES.map((size) => {
    const current = size === f.limit ? ` aria-current='true'` : '';
    const href = auditPageHref({ limit: size, filters: f.filters, sort: f.sort });
    return `<a href='${esc(href)}' data-page-size='${size}'${current}>${size}</a>`;
  }).join('');
  parts.push(`<span class='admin-pagination__sizes' role='group' aria-label='Page size'>${sizes}</span>`);
  parts.push('</nav>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Section root
// ---------------------------------------------------------------------------

function renderListPane(f: AuditListOkResult): string {
  const cursorAttr = f.cursor ? ` data-list-cursor='${esc(f.cursor)}'>` : '';
  const filtered = areAuditListFiltersActive(f.filters);
  const emptyBanner =
    f.rows.length === 0
      ? filtered
        ? `
    <div class='audit-section__empty-banner' data-empty-banner='filtered'>
      <h3 class='audit-section__empty-heading'>No events match the active filters</h3>
      <p class='audit-section__empty-body'>The server filters the whole ledger, so this is an empty result,
        not a page you need to page through. 
        <a href='' class='audit-section__clear-filters' data-clear-filters='true'>Clear all filters</a>
        to widen the search.
      </p>
    </div>`
        : `
    <div class='audit-section__empty-banner' data-empty-banner='true'>
      <h3 class='audit-section__empty-heading'>No audit events recorded</h3>
      <p class='audit-section__empty-body'>No events were recorded for this page
        (total: ${f.total === null ? 'unknown' : f.total}). This is data, not an outage.
    </div>`
      : renderListTable(f.rows);
  const content = emptyBanner;
  const dropped =
    f.droppedRows > 0
      ? `<p class='audit-section__dropped' data-dropped-rows='${f.droppedRows}'>${f.droppedRows} row(s) on this page were not shaped like a ledger event and were not shown.</p>`
      : '';
  return [
    `<section class='audit-section audit-section--list' data-list-page='true' data-list-limit='${f.limit}' data-list-total='${f.total === null ? 'unknown' : f.total}' data-list-next-cursor='${f.nextCursor ? 'true' : 'false'}' data-filter-active='${filtered ? 'true' : 'false'}' data-filter-severity='${esc(f.filters.severity)}' data-list-sort='${esc(f.sort)}' data-filter-page-rows='${f.pageRows}' data-filter-ignored='${f.ignoredFilters.join(',') || 'none'}'${cursorAttr}>`,
    `<header class='audit-section__header'><h2 class='audit-section__title'>Audit ledger</h2></header>`,
    renderFilterBar(f),
    renderFilterChips(f),
    dropped,
    content,
    renderPaginationNav(f),
    `</section>`,
  ].join('');
}

function renderStatusPane(
  modifier: string,
  heading: string,
  message: string,
  attribute: string,
  retry: { href: string; label: string; note: string } | null,
): string {
  const action =
    retry === null
      ? ''
      : [
          `<p class='audit-section__retry-note'>${esc(retry.note)}</p>`,
          `<a class='audit-section__retry' href='${esc(retry.href)}' data-retry='${esc(modifier)}'>` +
            esc(retry.label) +
          `</a>`,
        ].join('');
  return [
    `<section class='audit-section audit-section--${modifier}' data-status-pane='${modifier}'>`,
    `<header><h2>${esc(heading)}</h2></header>`,
    `<p class='audit-section__message' ${attribute}='true'>${esc(message)}</p>`,
    action,
    `</section>`,
  ].join('');
}
export function renderAuditSection(
  input: AuditSectionRenderInput,
): AuditSectionRenderOutput {
  const f = input.fetch;
  switch (f.kind) {
    case 'list':
      return { html: renderListPane(f), isReady: true };
    case 'empty':
      return {
        html: renderStatusPane('empty', 'Audit ledger', f.message, 'data-empty-message', null),
        isReady: false,
      };
    case 'unauthorized':
      return {
        html: renderStatusPane('unauthorized', 'Audit ledger', f.message, 'data-unauthorized-message', { href: '/admin/login', label: 'Sign in again', note: 'Your admin session has expired or the platform rejected the token. Sign in again to continue.' }),
        isReady: false,
      };
    case 'error':
      return {
        html: renderStatusPane('error', 'Audit ledger', f.message, 'data-error-message', { href: '', label: 'Try again', note: 'The ledger could not be loaded. Trying again re-fetches the same request with the same filters.' }),
        isReady: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Helpers re-exported for tests
// ---------------------------------------------------------------------------

export const __test = {
  severityBadgeClass,
  renderSeverityBadge,
  renderFilterBar,
  renderFilterChips,
  renderListRow,
  renderListTable,
  renderPaginationNav,
  renderListPane,
  renderStatusPane,
};
