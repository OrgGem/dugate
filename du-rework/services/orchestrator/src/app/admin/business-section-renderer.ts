/**
 * P6-02 Business section renderer.
 *
 * Pure HTML renderer for the Business registry, version, and health
 * pane. Consumes the view-model layer (`business-view-models.ts`)
 * directly — the shell's data fetch produces a `BusinessVersionRow[]`
 * and this module turns it into a fully-escaped, XHTML-friendly
 * string the rest of the shell can splice into the `ready` screen
 * state.
 *
 * Design:
 * - Per-row status badge (ENABLED / DRAINING / REGISTERED_DISABLED /
 *   RETIRED), worker heartbeat, health indicator, and per-row
 *   transition action chips gated by `canEnable` / `canDrain` /
 *   `canRetire`. Chips render as `<form>`-wrapped buttons pointing
 *   at the platform's existing PUT routes; the chips are disabled
 *   (rendered as plain text) when the transition is not allowed.
 * - Overall health summary panel (active version + enabled/draining/
 *   retired counts + worker activity).
 * - Failure fallbacks: an empty `rows` array renders an
 *   "no versions" empty pane; a fetch error renders the error pane;
 *   a 404 / "no business id" renders the not-registered pane.
 * - Strict TypeScript, zero `any`. Every value flowing into HTML
 *   goes through `esc()` (re-exported from the existing
 *   `shell-render.ts`).
 */

import { esc } from './shell-render';
import type {
  BusinessFetchResult,
} from './business-section-data';
import {
  buildBusinessHealthView,
  buildBusinessVersionListView,
  toBusinessVersionDisplayRow,
} from './business-view-models';
import type {
  BusinessHealthView,
  BusinessVersionDisplayRow,
  BusinessVersionListView,
  BusinessVersionRow,
} from './business-view-models';

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

/**
 * The renderer's input. `fetch` is the full discriminated
 * `BusinessFetchResult` so the renderer can map every transport
 * outcome (ok / unauthorized / not-found / error) onto a stable
 * HTML pane. The renderer never throws on a fetch error — the
 * `kind` discriminator is the entire control flow.
 */
export interface BusinessSectionRenderInput {
  fetch: BusinessFetchResult;
  /**
   * Optional canonical list of business ids the shell recognises.
   * The picker only renders ids in this list — it never invents
   * ids from user input. When the platform lands
   * `GET /api/v1/admin/businesses` the list comes from there; until
   * then the shell falls back to this static list (e.g.
   * `['example-review']`).
   */
  knownBusinessIds?: readonly string[];
  /** Currently selected business id; drives the picker active state. */
  selectedBusinessId?: string;
  /** Version selected for the detail pane; defaults to the active version. */
  selectedVersion?: string;
  /** Optional second version selected for a metadata-only comparison. */
  compareVersion?: string;
}

// ---------------------------------------------------------------------------
// Output (string only — the renderer is a pure function)
// ---------------------------------------------------------------------------

export interface BusinessSectionRenderOutput {
  /** The full section HTML (summary + table + fallback pane). */
  html: string;
  /**
   * True iff the rendered HTML represents the success state (the
   * table). When false, the body pane is one of the fallback states
   * (empty / not-found / unauthorized / error). The shell's screen
   * state builder uses this to pick the right CSS class.
   */
  isReady: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeClass(badge: 'success' | 'warning' | 'error' | 'neutral' | 'info'): string {
  return `status-badge status-badge--${badge}`;
}

function healthClass(health: 'healthy' | 'no-active' | 'draining' | 'retired'): string {
  return `health-indicator health-indicator--${health}`;
}

function renderStatusBadge(row: BusinessVersionDisplayRow): string {
  return [
    `<span class="${esc(statusBadgeClass(row.statusBadge.badge))}" data-status="${esc(row.status)}">`,
    esc(row.statusBadge.label),
    '</span>',
  ].join('');
}

function renderHealthIndicator(row: BusinessVersionDisplayRow): string {
  return [
    `<span class="${esc(healthClass(row.health))}" data-health="${esc(row.health)}">`,
    esc(row.health),
    '</span>',
  ].join('');
}

function renderHeartbeat(row: BusinessVersionDisplayRow): string {
  const hb = row.workerHeartbeat;
  const status = esc(hb.status);
  const label = esc(hb.label);
  const count = typeof hb.workerCount === 'number' ? ` (workers: ${esc(String(hb.workerCount))})` : '';
  const last = hb.lastHeartbeatAt ? ` <small>${esc(hb.lastHeartbeatAt)}</small>` : '';
  return [
    `<span class="worker-heartbeat" data-heartbeat="${status}">`,
    `${label}${count}${last}`,
    '</span>',
  ].join('');
}

function renderActiveMarker(row: BusinessVersionDisplayRow): string {
  if (row.isActive) {
    return '<span class="active-marker" data-active="true">active</span>';
  }
  return '<span class="active-marker" data-active="false"></span>';
}

function renderTransitionChip(
  row: BusinessVersionDisplayRow,
  action: 'enable' | 'drain' | 'retire',
  allowed: boolean,
): string {
  if (!allowed) {
    return [
      `<span class="action-chip action-chip--disabled" data-action="${esc(action)}" aria-disabled="true">`,
      esc(action),
      '</span>',
    ].join('');
  }
  return [
    `<form method="POST" action="/admin/businesses/${esc(row.businessId)}/versions/${esc(row.version)}/${esc(action)}" class="action-chip-form" onsubmit="return confirm('${action === 'retire' ? 'Retire this version permanently?' : action === 'drain' ? 'Stop routing new work to this version?' : 'Enable this version for new work?'}')">`,
    `<button type="submit" class="action-chip action-chip--${esc(action)}" data-action="${esc(action)}">`,
    esc(action),
    '</button>',
    '</form>',
  ].join('');
}

function renderTableRow(row: BusinessVersionDisplayRow, selectedVersion: string): string {
  const query = `?businessId=${encodeURIComponent(row.businessId)}&version=${encodeURIComponent(row.version)}`;
  return [
    '<tr class="business-version-row" data-version="' + esc(row.version) + '" data-selected="' + esc(row.version === selectedVersion ? 'true' : 'false') + '" data-lifecycle="' + esc(lifecycleLabel(row).toLowerCase()) + '">',
    '<td class="col-version">',
    `<a href="/admin/businesses${esc(query)}" aria-label="View business version ${esc(row.version)}"><code>${esc(row.version)}</code></a>`,
    '</td>',
    '<td class="col-status">',
    renderStatusBadge(row),
    '</td>',
    '<td class="col-active">',
    renderActiveMarker(row),
    '</td>',
    '<td class="col-health">',
    renderHealthIndicator(row),
    '</td>',
    '<td class="col-heartbeat">',
    renderHeartbeat(row),
    '</td>',
    '<td class="col-registered">',
    row.registeredAt ? `<time>${esc(row.registeredAt)}</time>` : '<span class="muted">—</span>',
    '</td>',
    // W47-C2 (B): the dispatch queue is a real `business_versions` column
    // the live route already projects — the pane shows it so operators can
    // see where enabling this version routes new operations. Escaped like
    // every other cell (queue names are platform-controlled, still escaped).
    '<td class="col-queue">',
    row.queue ? `<code>${esc(row.queue)}</code>` : '<span class="muted">—</span>',
    '</td>',
    '<td class="col-actions"><div class="action-chips" aria-label="Version actions">',
    renderTransitionChip(row, 'enable', row.canEnable),
    renderTransitionChip(row, 'drain', row.canDrain),
    renderTransitionChip(row, 'retire', row.canRetire),
    '</div></td>',
    '</tr>',
  ].join('');
}

function renderTable(view: BusinessVersionListView, selectedVersion: string): string {
  if (view.total === 0) {
    return [
      '<section class="business-section__empty" role="status">',
      '<p>No versions are registered for this business.</p>',
      '</section>',
    ].join('');
  }
  const rows = view.rows.map((row) => renderTableRow(row, selectedVersion)).join('');
  return [
    '<table class="business-version-table" data-active-version="' + esc(view.activeVersion ?? '') + '">',
    '<thead>',
    '<tr>',
    '<th scope="col">Version</th>',
    '<th scope="col">Status</th>',
    '<th scope="col">Active</th>',
    '<th scope="col">Health</th>',
    '<th scope="col">Worker heartbeat</th>',
    '<th scope="col">Registered</th>',
    '<th scope="col">Queue</th>',
    '<th scope="col">Actions</th>',
    '</tr>',
    '</thead>',
    '<tbody>',
    rows,
    '</tbody>',
    '</table>',
  ].join('');
}

function lifecycleLabel(row: BusinessVersionDisplayRow): string {
  if (row.status === 'RETIRED') return 'Retired';
  if (row.isActive) return 'Active';
  if (row.status === 'REGISTERED_DISABLED') return 'Draft';
  return row.status === 'DRAINING' ? 'Draining' : 'Enabled, not active';
}

function renderVersionDetail(
  row: BusinessVersionDisplayRow,
  compareRow: BusinessVersionDisplayRow | undefined,
): string {
  const comparison = compareRow
    ? [
        '<section class="business-section__compare" aria-label="Version comparison" data-compare-version="' + esc(compareRow.version) + '">',
        `<h3>Compare ${esc(row.version)} with ${esc(compareRow.version)}</h3>`,
        '<dl>',
        `<dt>Status</dt><dd>${esc(row.statusBadge.label)} / ${esc(compareRow.statusBadge.label)}</dd>`,
        `<dt>Lifecycle</dt><dd>${esc(lifecycleLabel(row))} / ${esc(lifecycleLabel(compareRow))}</dd>`,
        `<dt>Queue</dt><dd>${esc(row.queue ?? '—')} / ${esc(compareRow.queue ?? '—')}</dd>`,
        `<dt>Registered</dt><dd>${esc(row.registeredAt || '—')} / ${esc(compareRow.registeredAt || '—')}</dd>`,
        `<dt>Worker health</dt><dd>${esc(row.workerHeartbeat.label)} / ${esc(compareRow.workerHeartbeat.label)}</dd>`,
        '</dl>',
        '</section>',
      ].join('')
    : '';
  return [
    `<section class="business-section__detail" aria-label="Business version detail" data-version="${esc(row.version)}" data-lifecycle="${esc(lifecycleLabel(row).toLowerCase())}">`,
    `<h3>Version ${esc(row.version)} <span class="business-section__lifecycle">${esc(lifecycleLabel(row))}</span></h3>`,
    '<dl class="business-section__detail-meta">',
    `<dt>Status</dt><dd>${renderStatusBadge(row)}</dd>`,
    `<dt>Active pointer</dt><dd>${row.isActive ? 'Active' : 'Not active'}</dd>`,
    `<dt>Health</dt><dd>${renderHealthIndicator(row)}</dd>`,
    `<dt>Queue</dt><dd>${row.queue ? `<code>${esc(row.queue)}</code>` : '<span class="muted">—</span>'}</dd>`,
    `<dt>Registered</dt><dd>${esc(row.registeredAt || '—')}</dd>`,
    '</dl>',
    comparison,
    '</section>',
  ].join('');
}

function renderVersionComparePicker(
  businessId: string,
  versions: readonly BusinessVersionDisplayRow[],
  selectedVersion: string,
  compareVersion: string,
): string {
  if (versions.length < 2) return '';
  const options = versions.map((row) =>
    `<option value="${esc(row.version)}"${row.version === compareVersion ? ' selected' : ''}>${esc(row.version)}</option>`,
  ).join('');
  return [
    '<form method="GET" action="/admin/businesses" class="business-section__compare-picker" aria-label="Compare business versions">',
    `<input type="hidden" name="businessId" value="${esc(businessId)}">`,
    `<input type="hidden" name="version" value="${esc(selectedVersion)}">`,
    '<label for="businessCompareVersion">Compare with</label>',
    `<select id="businessCompareVersion" name="compareVersion">${options}</select>`,
    '<button type="submit">Compare</button>',
    '</form>',
  ].join('');
}

function renderHealthSummary(view: BusinessHealthView): string {
  return [
    '<section class="business-section__health" data-health="' + esc(view.health) + '">',
    '<h3>Overall health</h3>',
    '<dl class="business-health-summary">',
    `<dt>Active version</dt><dd>${view.activeVersion ? `<code>${esc(view.activeVersion)}</code>` : '<span class="muted">none</span>'}</dd>`,
    `<dt>Total versions</dt><dd>${esc(String(view.totalVersions))}</dd>`,
    `<dt>Enabled</dt><dd>${esc(String(view.enabledVersions))}</dd>`,
    `<dt>Draining</dt><dd>${esc(String(view.drainingVersions))}</dd>`,
    `<dt>Retired</dt><dd>${esc(String(view.retiredVersions))}</dd>`,
    `<dt>Disabled</dt><dd>${esc(String(view.disabledVersions))}</dd>`,
    `<dt>Active workers</dt><dd>${view.hasActiveWorkers ? 'yes' : 'no'}</dd>`,
    '</dl>',
    `<p class="business-health-summary__narrative" data-badge="${esc(view.healthBadge)}">${esc(view.summary)}</p>`,
    '</section>',
  ].join('');
}

function renderBusinessPicker(
  knownIds: readonly string[],
  selected: string,
): string {
  if (knownIds.length === 0) {
    return '<p class="business-section__picker-empty">No businesses are registered on this shell yet.</p>';
  }
  const options = knownIds
    .map(
      (id) =>
        `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(id)}</option>`,
    )
    .join('');
  return [
    '<form method="GET" action="/admin/businesses" class="business-section__picker">',
    '<label for="businessId">Business</label>',
    `<select id="businessId" name="businessId">${options}</select>`,
    '<button type="submit">View</button>',
    '</form>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the Business registry / version / health pane from a
 * `BusinessFetchResult`. Pure: same input → same output, no I/O.
 * Never throws.
 */
export function renderBusinessSection(input: BusinessSectionRenderInput): BusinessSectionRenderOutput {
  if (input.fetch.kind === 'ok') {
    const listView = buildBusinessVersionListView(input.fetch.rows, {
      activeVersion: input.fetch.activeVersion ?? undefined,
    });
    const healthView = buildBusinessHealthView(
      input.fetch.rows,
      input.fetch.activeVersion,
    );
    const picker = input.knownBusinessIds
      ? renderBusinessPicker(input.knownBusinessIds, input.selectedBusinessId ?? input.fetch.businessId)
      : '';
    const selectedVersion = input.selectedVersion ?? healthView.activeVersion ?? listView.rows[0]?.version ?? '';
    const selectedRow = listView.rows.find((row) => row.version === selectedVersion);
    const compareRow = input.compareVersion
      ? listView.rows.find((row) => row.version === input.compareVersion)
      : undefined;
    const comparePicker = selectedRow
      ? renderVersionComparePicker(input.fetch.businessId, listView.rows, selectedVersion, input.compareVersion ?? '')
      : '';
    const html = [
      '<section class="business-section" data-business-id="' + esc(input.fetch.businessId) + '">',
      '<header class="business-section__header">',
      `<h2>Business <code>${esc(input.fetch.businessId)}</code></h2>`,
      picker,
      '</header>',
      renderHealthSummary(healthView),
      '<section class="business-section__versions" aria-label="Business version list">',
      '<h3>Versions</h3>',
      renderTable(listView, selectedVersion),
      '</section>',
      selectedRow
        ? [
            comparePicker,
            input.compareVersion && !compareRow
              ? `<p class="business-section__compare-not-found" role="status">Version ${esc(input.compareVersion)} is not available for comparison.</p>`
              : '',
            renderVersionDetail(selectedRow, compareRow),
          ].join('')
        : input.selectedVersion && listView.rows.length > 0
          ? '<p class="business-section__revision-not-found" role="status">The requested business version was not found.</p>'
          : '',
      '</section>',
    ].join('');
    return { html, isReady: !(Boolean(input.selectedVersion) && listView.rows.length > 0 && !selectedRow) };
  }

  if (input.fetch.kind === 'unauthorized') {
    return {
      html: [
        '<section class="business-section business-section--unauthorized" role="alert">',
        `<h2>Admin token rejected</h2>`,
        `<p>${esc(input.fetch.message)}</p>`,
        '<p>The shell reuses the orchestrator admin bearer token. Update the platform config and reload.</p>',
        '</section>',
      ].join(''),
      isReady: false,
    };
  }

  if (input.fetch.kind === 'not-found') {
    return {
      html: [
        '<section class="business-section business-section--not-found" role="status">',
        `<h2>${esc(input.fetch.businessId.length > 0 ? `Business not registered` : 'Business list unavailable')}</h2>`,
        `<p>${esc(input.fetch.message)}</p>`,
        '</section>',
      ].join(''),
      isReady: false,
    };
  }

  // kind === 'error'
  return {
    html: [
      '<section class="business-section business-section--error" role="alert">',
      '<h2>Could not load business versions</h2>',
      `<p>${esc(input.fetch.message)}</p>`,
      '</section>',
    ].join(''),
    isReady: false,
  };
}

// ---------------------------------------------------------------------------
// Standalone helpers re-exported for tests
// ---------------------------------------------------------------------------

/**
 * Build a `BusinessVersionDisplayRow[]` for a known set of raw rows.
 * Re-export of the view-model builder, so the test file can assert
 * the renderer consumed a normalised shape without importing the
 * business-view-models module directly.
 */
export function buildDisplayRows(rows: readonly BusinessVersionRow[]): BusinessVersionDisplayRow[] {
  return rows.map((r) => toBusinessVersionDisplayRow(r));
}
