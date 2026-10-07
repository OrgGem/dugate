/**
 * P6-06 Operation detail section renderer.
 *
 * Pure HTML renderer for the operation detail / result / artifacts /
 * cancel / resume / replay pane. Consumes the fetcher's discriminated
 * `OperationFetchResult` and emits a fully-escaped, XHTML-friendly form
 * that the shell splices at `</section></main>`.
 *
 * Hard rules:
 * - State badge reflects the server-reported state — no client-side
 *   mutation. The renderer only flips the explicit `data-action` /
 *   `data-can-*` discriminators the platform binds to the cancel /
 *   resume / replay endpoints.
 * - Result `data` JSON is rendered as escaped text in a `<pre>` block.
 *   No raw provider error body, raw prompt text, or raw artifact bytes
 *   are projected.
 * - The human-wait form carries a `data-wait-cas` token (the
 *   `waitId`); resume POSTs the token back so the server's stale-CAS
 *   check sees the operator's expectation. The renderer never
 *   fabricates the CAS — it surfaces what the wire delivered.
 *
 * Failure fallbacks: empty / unauthorized / not-found / error panes
 * map onto the existing screen states. The `isReady` flag flips for
 * the success pane only.
 *
 * Strict TypeScript, zero `any`. Every value flowing into HTML goes
 * through `esc()`.
 */

import { esc } from './shell-render';
import type {
  OperationFetchResult,
  OperationDetailOkResult,
  OperationListOkResult,
  OperationListRow,
  OperationArtifactDisplay,
  OperationResultDisplay,
} from './operation-section-data';
import {
  areListFiltersActive,
  OPERATION_STATE_FILTERS,
  OPERATION_LIST_DEFAULT_LIMIT,
  OPERATION_LIST_DEFAULT_SORT,
  OPERATION_LIST_MAX_LIMIT,
  OPERATION_LIST_SORT_OPTIONS,
} from './operation-section-data';
import type { OperationListFilters, OperationStateFilter } from './operation-section-data';

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

export interface OperationSectionRenderInput {
  fetch: OperationFetchResult;
  /** Currently selected operation id (echoes the request query). */
  selectedOperationId?: string;
  /**
   * W-ADMUX-01: page size the shell requested for the list pane. Echoed
   * onto the back-to-list link so opening a row and returning keeps the
   * operator on the same page configuration.
   */
  listLimit?: number;
  /** W-ADMUX-01: cursor the list pane was requested with (echoed likewise). */
  listCursor?: string | null;
  /**
   * W-ADMUX-03-FILTER-1: sanitized active filters echoed to the
   * back-to-list link so returning from a detail pane keeps the filtered
   * view (list panes carry their own filters on the envelope instead).
   */
  listFilters?: OperationListFilters;
  /**
   * W-ADMUX03-SHELL-SORT-1: effective ordering echoed onto the back-to-list
   * link, so returning from a detail pane re-requests the very ordering the
   * echoed cursor is bound to (T140-A1: cursor and sort travel together).
   * Null/absent means the default ordering, which the href builder omits.
   */
  listSort?: string | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface OperationSectionRenderOutput {
  html: string;
  /** True iff the rendered HTML is the success (detail) pane. */
  isReady: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateBadgeClass(badge: 'success' | 'error' | 'warning' | 'info' | 'neutral'): string {
  return `status-badge status-badge--${badge}`;
}

function progressBar(percent: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return [
    `<div class="operation-section__progress" data-progress-percent="${pct}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Operation progress: ${pct}%">`,
    `<div class="operation-section__progress-bar" data-progress-bar="${pct}" style="width:${pct}%"></div>`,
    `</div>`,
  ].join('');
}

export function renderStatusBadge(state: string, label: string, badge: string): string {
  return [
    `<span class="${esc(stateBadgeClass(badge as 'success'))}" data-operation-state="${esc(state)}" data-state-badge="${esc(badge)}">`,
    esc(label),
    '</span>',
  ].join('');
}

export function renderArtifactRow(a: OperationArtifactDisplay): string {
  const href = a.downloadUrl
    ? `<a href="${esc(a.downloadUrl)}" data-action="download-artifact" data-artifact-id="${esc(a.artifactId)}" rel="noopener">${esc(a.fileName)}</a>`
    : `<span data-artifact-no-download="true">${esc(a.fileName)}</span>`;
  return [
    '<tr class="operation-section__artifact-row"',
    `data-artifact-id="${esc(a.artifactId)}"`,
    `data-artifact-role="${esc(a.role)}"`,
    `data-artifact-mime="${esc(a.mimeType)}"`,
    `data-artifact-size="${esc(a.sizeDisplay)}">`,
    `<td class="operation-section__artifact-name">${href}</td>`,
    `<td class="operation-section__artifact-role" data-artifact-role-cell="${esc(a.role)}">${esc(a.role)}</td>`,
    `<td class="operation-section__artifact-size" data-artifact-size-cell="${esc(a.sizeDisplay)}">${esc(a.sizeDisplay)}</td>`,
    `<td class="operation-section__artifact-mime" data-artifact-mime-cell="${esc(a.mimeType)}">${esc(a.mimeType)}</td>`,
    '</tr>',
  ].join('');
}

export function renderArtifactsTable(artifacts: readonly OperationArtifactDisplay[]): string {
  if (artifacts.length === 0) {
    return [
      '<details class="operation-section__artifacts" data-artifact-total="0">',
      '<summary>Artifacts (0)</summary>',
      '<header><h3>Artifacts</h3></header>',
      '<p class="operation-section__artifacts-empty">No artifacts attached to this operation.</p>',
      '</details>',
    ].join('');
  }
  const rows = artifacts.map(renderArtifactRow).join('');
  return [
    '<details class="operation-section__artifacts" data-artifact-total="' + artifacts.length.toString() + '">',
    '<summary>Artifacts (' + artifacts.length.toString() + ')</summary>',
    '<header><h3>Artifacts</h3></header>',
    '<table class="operation-section__artifacts-table"><thead><tr>',
    '<th>File</th><th>Role</th><th>Size</th><th>MIME</th>',
    `</tr></thead><tbody>${rows}</tbody></table>`,
    '</details>',
  ].join('');
}

export function renderResultPanel(result: OperationResultDisplay | null): string {
  if (!result) {
    return [
      '<section class="operation-section__result" data-result-available="false">',
      '<header><h3>Result</h3></header>',
      '<p class="operation-section__result-empty">Result is not yet available — the operation is still in flight or has not reached a terminal state.</p>',
      '</section>',
    ].join('');
  }
  const warnings =
    result.warnings.length === 0
      ? ''
      : [
          '<section class="operation-section__result-warnings" data-result-warning-total="' +
            result.warnings.length.toString() +
            '"><ul>' +
            result.warnings
              .map(
                (w) =>
                  `<li class="operation-section__result-warning" data-result-warning="${esc(w)}">${esc(w)}</li>`,
              )
              .join('') +
            '</ul></section>',
        ].join('');
  return [
    '<section class="operation-section__result" data-result-available="true" data-result-schema-version="' +
      esc(result.schemaVersion) +
      '">',
    '<header><h3>Result</h3></header>',
    `<pre class="operation-section__result-data" data-result-data="${esc(result.dataJson)}">${esc(result.dataPretty)}</pre>`,
    warnings,
    '</section>',
  ].join('');
}

export function renderHumanWaitForm(detail: OperationDetailOkResult['detail']): string {
  const form = detail.humanWaitForm;
  if (!form) return '';
  const expiredAttr = form.isExpired ? 'data-wait-expired="true"' : 'data-wait-expired="false"';
  const fields = form.fields
    .map((f) => {
      const requiredAttr = f.required ? ' required' : '';
      const descAttr = f.description
        ? ` aria-describedby="hint-${esc(f.name)}"`
        : '';
      const hint = f.description
        ? `<p id="hint-${esc(f.name)}" class="operation-section__form-hint" data-field-help="${esc(f.name)}">${esc(f.description)}</p>`
        : '';
      let widget = '';
      switch (f.widget) {
        case 'textarea':
          widget = `<textarea name="${esc(f.name)}" data-field-name="${esc(f.name)}" data-field-widget="textarea"${requiredAttr}${descAttr} placeholder="${esc(f.placeholder)}"></textarea>`;
          break;
        case 'number':
          widget = `<input type="number" name="${esc(f.name)}" data-field-name="${esc(f.name)}" data-field-widget="number"${requiredAttr}${descAttr} placeholder="${esc(f.placeholder)}">`;
          break;
        case 'boolean':
          widget = `<label class="operation-section__form-boolean"><input type="checkbox" name="${esc(f.name)}" data-field-name="${esc(f.name)}" data-field-widget="boolean"${requiredAttr}${descAttr}> <span data-field-boolean-label="${esc(f.name)}">${esc(f.label)}</span></label>`;
          break;
        case 'select': {
          const opts = f.options
            .map(
              (o) =>
                `<option value="${esc(o.value)}" data-field-option="${esc(o.value)}">${esc(o.label)}</option>`,
            )
            .join('');
          widget = `<select name="${esc(f.name)}" data-field-name="${esc(f.name)}" data-field-widget="select"${requiredAttr}${descAttr}>${opts}</select>`;
          break;
        }
        case 'object':
        case 'array':
        case 'text':
        default:
          widget = `<input type="text" name="${esc(f.name)}" data-field-name="${esc(f.name)}" data-field-widget="${esc(f.widget)}"${requiredAttr}${descAttr} placeholder="${esc(f.placeholder)}">`;
          break;
      }
      return [
        `<div class="operation-section__form-row" data-field-row="${esc(f.name)}" data-field-widget="${esc(f.widget)}" data-field-required="${f.required ? 'true' : 'false'}">`,
        `<label for="field-${esc(f.name)}" data-field-label="${esc(f.name)}">${esc(f.label)}</label>`,
        widget,
        hint,
        '</div>',
      ].join('');
    })
    .join('');
  return [
    '<section class="operation-section__wait"',
    `data-wait-id="${esc(form.waitId)}"`,
    `data-wait-cas="${esc(form.waitId)}"`,
    `data-wait-expires-at="${esc(form.expiresAt)}"`,
    expiredAttr,
    '>',
    `<header><h3>Waiting for input</h3><p class="operation-section__wait-expiry" data-wait-expiry="${esc(form.expiresAt)}">Expires at ${esc(form.expiresAt)}</p></header>`,
    `<form id="operation-wait-form" class="operation-section__wait-form" action="/admin/operations/${esc(detail.id)}/resume" method="post" data-action="resume-wait" data-operation-id="${esc(detail.id)}">`,
    `<input type="hidden" name="casToken" value="${esc(form.waitId)}" data-field-cas="${esc(form.waitId)}">`,
    `<input type="hidden" name="waitId" value="${esc(form.waitId)}" data-field-wait-id="${esc(form.waitId)}">`,
    fields,
    `<button type="button" class="operation-section__wait-submit" data-action="open-resume-confirmation" data-confirmation-trigger="operation-resume-confirmation" command="show-modal" commandfor="operation-resume-confirmation" aria-haspopup="dialog" aria-controls="operation-resume-confirmation"${form.isExpired ? ' disabled' : ''}>Resume</button>`,
    '</form>',
    '<dialog class="operation-section__confirmation" id="operation-resume-confirmation" aria-labelledby="operation-resume-confirmation-title">',
    '<header><h3 id="operation-resume-confirmation-title">Resume this operation?</h3></header>',
    '<p>Review the requested input before submitting the resume action.</p>',
    '<form method="dialog"><button type="submit" value="cancel">Go back</button></form>',
    `<button type="submit" form="operation-wait-form" class="operation-section__wait-confirm" data-action="submit-resume" data-operation-id="${esc(detail.id)}" data-wait-cas="${esc(form.waitId)}"${form.isExpired ? ' disabled' : ''}>Confirm resume</button>`,
    '</dialog>',
    '</section>',
  ].join('');
}

export function renderActionBar(ok: OperationDetailOkResult): string {
  const d = ok.detail;
  const canCancel = ok.canCancel ? 'true' : 'false';
  const canResume = ok.canResume ? 'true' : 'false';
  const canReplay = ok.canReplay ? 'true' : 'false';
  const disabledCancel = ok.canCancel ? '' : ' disabled';
  const disabledResume = ok.canResume ? '' : ' disabled';
  const disabledReplay = ok.canReplay ? '' : ' disabled';
  return [
    '<section class="operation-section__actions" data-action-bar="true" aria-label="Operation actions">',
    `<button type="button" class="operation-section__cancel" data-action="open-cancel-confirmation" data-confirmation-trigger="operation-cancel-confirmation" command="show-modal" commandfor="operation-cancel-confirmation" aria-haspopup="dialog" aria-controls="operation-cancel-confirmation" data-operation-id="${esc(d.id)}" data-can-cancel="${canCancel}"${disabledCancel}>Cancel</button>`,
    d.humanWaitForm
      ? `<button type="button" class="operation-section__resume" data-action="open-resume-confirmation" data-confirmation-trigger="operation-resume-confirmation" command="show-modal" commandfor="operation-resume-confirmation" aria-haspopup="dialog" aria-controls="operation-resume-confirmation" data-operation-id="${esc(d.id)}" data-can-resume="${canResume}"${disabledResume}>Resume</button>`
      : '',
    `<button type="button" class="operation-section__replay" data-action="open-replay-confirmation" data-confirmation-trigger="operation-replay-confirmation" command="show-modal" commandfor="operation-replay-confirmation" aria-haspopup="dialog" aria-controls="operation-replay-confirmation" data-operation-id="${esc(d.id)}" data-can-replay="${canReplay}" data-replay-label="${esc(ok.replayLabel)}"${disabledReplay}>${esc(ok.replayLabel)}</button>`,
    '</section>',
  ].join('');
}

function renderActionDialogs(ok: OperationDetailOkResult): string {
  const d = ok.detail;
  const canCancel = ok.canCancel ? 'true' : 'false';
  const canReplay = ok.canReplay ? 'true' : 'false';
  const disabledCancel = ok.canCancel ? '' : ' disabled';
  const disabledReplay = ok.canReplay ? '' : ' disabled';
  return [
    '<dialog class="operation-section__confirmation" id="operation-cancel-confirmation" aria-labelledby="operation-cancel-confirmation-title">',
    '<header><h3 id="operation-cancel-confirmation-title">Cancel this operation?</h3></header>',
    `<p>Cancel operation ${esc(d.id)}. The status will change only after the request is accepted.</p>`,
    `<form id="operation-cancel-form" class="operation-section__cancel-form" action="/admin/operations/${esc(d.id)}/cancel" method="post" data-action="cancel-form">`,
    `<input type="hidden" name="operationId" value="${esc(d.id)}">`,
    `<button type="submit" data-action="cancel-operation" data-operation-id="${esc(d.id)}" data-can-cancel="${canCancel}"${disabledCancel}>Confirm cancel</button>`,
    '</form>',
    '<form method="dialog"><button type="submit" value="cancel">Keep operation</button></form>',
    '</dialog>',
    '<dialog class="operation-section__confirmation" id="operation-replay-confirmation" aria-labelledby="operation-replay-confirmation-title">',
    '<header><h3 id="operation-replay-confirmation-title">Start a new operation?</h3></header>',
    `<p>${esc(ok.replayLabel)} will create a new operation based on ${esc(d.id)}.</p>`,
    '<form method="dialog">',
    '<button type="submit" value="cancel">Go back</button>',
    `<button type="button" command="close" commandfor="operation-replay-confirmation" data-action="replay-operation" data-operation-id="${esc(d.id)}" data-can-replay="${canReplay}"${disabledReplay}>Confirm ${esc(ok.replayLabel.toLowerCase())}</button>`,
    '</form>',
    '</dialog>',
  ].join('');
}

function renderErrorBlock(detail: OperationDetailOkResult['detail']): string {
  const err = detail.errorDisplay;
  if (!err) return '';
  return [
    '<details class="operation-section__error" data-operation-error="true">',
    '<summary>Error details</summary>',
    '<header><h3>Error</h3></header>',
    `<dl class="operation-section__error-list">`,
    `<dt>Code</dt><dd data-error-code="${esc(err.code)}">${esc(err.code)}</dd>`,
    `<dt>Title</dt><dd data-error-title="${esc(err.title)}">${esc(err.title)}</dd>`,
    `</dl>`,
    '<p class="operation-section__error-safe-note">Diagnostic details are hidden in this view.</p>',
    '</details>',
  ].join('');
}

/** The detail contract provides a latest progress snapshot, not step history. */
function renderCheckpointPanel(detail: OperationDetailOkResult['detail']): string {
  return [
    '<details class="operation-section__checkpoints" data-checkpoint-source="operation-progress" data-checkpoint-total="1">',
    '<summary>Latest progress checkpoint</summary>',
    '<dl class="operation-section__checkpoint-list">',
    `<dt>Status</dt><dd data-checkpoint-state="${esc(detail.status.state)}">${esc(detail.status.label)}</dd>`,
    `<dt>Progress</dt><dd data-checkpoint-progress="${detail.progressPercent.toString()}">${detail.progressPercent.toString()}%</dd>`,
    `<dt>Updated</dt><dd data-checkpoint-updated-at="${esc(detail.updatedAt)}">${esc(detail.updatedAt)}</dd>`,
    `<dt>Update</dt><dd data-checkpoint-message="${esc(detail.progressMessage)}">${detail.progressMessage ? esc(detail.progressMessage) : 'No progress update reported.'}</dd>`,
    '</dl>',
    '</details>',
  ].join('');
}

function renderDetailRoot(ok: OperationDetailOkResult, backHref?: string): string {
  const d = ok.detail;
  const state = d.status.state;
  const badge = renderStatusBadge(state, d.status.label, d.status.badge);
  const backLink = backHref
    ? `<p class="operation-section__back"><a href="${esc(backHref)}" data-back-to-list="true">&#8592; All operations</a></p>`
    : '';
  const meta = [
    `<dt>Business</dt><dd data-business-id="${esc(d.businessId)}">${esc(d.businessId)}@${esc(d.businessVersion)}</dd>`,
    `<dt>Action</dt><dd data-action-name="${esc(d.action)}">${esc(d.action)}</dd>`,
    `<dt>Created</dt><dd data-created-at="${esc(d.createdAt)}">${esc(d.createdAt)}</dd>`,
    `<dt>Updated</dt><dd data-updated-at="${esc(d.updatedAt)}">${esc(d.updatedAt)}</dd>`,
    d.deadlineAt
      ? `<dt>Deadline</dt><dd data-deadline-at="${esc(d.deadlineAt)}">${esc(d.deadlineAt)}</dd>`
      : `<dt>Deadline</dt><dd data-deadline-at="">(none)</dd>`,
    d.replayOf
      ? `<dt>Replay of</dt><dd data-replay-of="${esc(d.replayOf)}">${esc(d.replayOf)}</dd>`
      : '',
    `<dt>Links</dt><dd><a href="${esc(d.selfLink)}" data-self-link="${esc(d.selfLink)}">self</a> <a href="${esc(d.resultLink)}" data-result-link="${esc(d.resultLink)}">result</a></dd>`,
  ].join('');
  const sections = [
    backLink,
    '<header class="operation-section__header">',
    `<h2 class="operation-section__title" data-operation-id="${esc(d.id)}">Operation ${esc(d.id)}</h2>`,
    `<p class="operation-section__status" role="status" aria-label="Current operation status">${badge}</p>`,
    progressBar(d.progressPercent),
    `<p class="operation-section__progress-message" data-progress-message="${esc(d.progressMessage)}">${esc(d.progressMessage)}</p>`,
    renderActionBar(ok),
    '</header>',
    renderActionDialogs(ok),
    `<dl class="operation-section__meta">${meta}</dl>`,
    renderHumanWaitForm(d),
    renderCheckpointPanel(d),
    renderErrorBlock(d),
    renderResultPanel(ok.resultDisplay),
    renderArtifactsTable(ok.artifacts),
  ].join('');
  return [
    '<section class="operation-section"',
    `data-operation-selected="${esc(d.id)}"`,
    `data-operation-state="${esc(state)}"`,
    `data-operation-terminal="${d.status.terminal ? 'true' : 'false'}"`,
    `data-can-cancel="${ok.canCancel ? 'true' : 'false'}"`,
    `data-can-resume="${ok.canResume ? 'true' : 'false'}"`,
    `data-can-replay="${ok.canReplay ? 'true' : 'false'}"`,
    `data-result-available="${ok.resultDisplay ? 'true' : 'false'}"`,
    `data-artifact-total="${ok.artifacts.length.toString()}"`,
    '>',
    sections,
    '</section>',
  ].join('');
}

function renderListEmptyState(ok: OperationDetailOkResult): string {
  const d = ok.detail;
  const state = d.status.state;
  const badge = renderStatusBadge(state, d.status.label, d.status.badge);
  return [
    '<section class="operation-section operation-section--list"',
    `data-operation-selected=""`,
    `data-operation-state="${esc(state)}"`,
    `data-can-cancel="false"`,
    `data-can-resume="false"`,
    `data-can-replay="false"`,
    `data-result-available="false"`,
    `data-artifact-total="0"`,
    '>',
    '<header class="operation-section__header">',
    '<h2 class="operation-section__title">Operations</h2>',
    '<p class="operation-section__list-hint" data-list-hint="true">',
    `Pick an operation from the picker to inspect its detail, result, artifacts, and resume / replay actions.`,
    '</p>',
    `<p class="operation-section__list-current" data-list-current="${esc(d.id)}">Latest: ${badge} ${esc(d.id)}</p>`,
    '</header>',
    '</section>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Paged list pane (W-ADMUX-01: ADM-UX-01/05 list → detail → action)
// ---------------------------------------------------------------------------

/** Page sizes offered by the list controls; mirrors the server clamp. */
const LIST_PAGE_SIZES: readonly number[] = [20, 50, OPERATION_LIST_MAX_LIMIT];

/**
 * List href that returns the operator to the page they selected a row
 * from (limit + cursor echoed). Falls back to the default first page when
 * the shell did not pass list context.
 */
function backToListHref(input: OperationSectionRenderInput): string {
  return opsPageHref({
    limit: input.listLimit ?? OPERATION_LIST_DEFAULT_LIMIT,
    cursor: input.listCursor ?? null,
    filters: input.listFilters ?? null,
    sort: input.listSort ?? null,
  });
}

function opsPageHref(opts: {
  limit: number;
  cursor?: string | null;
  filters?: OperationListFilters | null;
  sort?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit));
  // W-ADMUX03-SHELL-SORT-1 (T140-A1): a keyset cursor is bound to the
  // ordering it was minted under, so EVERY link that echoes a cursor must
  // echo that ordering too - the default is omitted only because the route
  // resolves an absent sort to exactly what a default cursor is bound to.
  // Links that change the ordering (the toolbar form) must carry NO cursor.
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.sort && opts.sort !== OPERATION_LIST_DEFAULT_SORT) params.set('sort', opts.sort);
  const fl = opts.filters;
  if (fl) {
    // Only effective (sanitized) values ever re-enter a URL; ALL is the
    // absence of a filter and is omitted so default links stay stable.
    if (fl.state !== 'ALL') params.set('state', fl.state);
    if (fl.tenant) params.set('tenant', fl.tenant);
    if (fl.idContains) params.set('id', fl.idContains);
  }
  return `/admin/operations?${params.toString()}`;
}

/** Human labels for the six orderings, keyed by canonical `field:direction`. */
const SORT_LABEL: Record<string, string> = {
  'created_at:desc': 'Newest first',
  'created_at:asc': 'Oldest first',
  'updated_at:desc': 'Recently updated',
  'updated_at:asc': 'Least recently updated',
  'deadline_at:asc': 'Deadline soonest first',
  'deadline_at:desc': 'Deadline latest first',
};

/** Human labels for the state filter chips (UI enum, not wire states). */
const STATE_FILTER_LABEL: Record<OperationStateFilter, string> = {
  ALL: 'All states',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  TIMED_OUT: 'Timed out',
};

/**
 * W-ADMUX-03-FILTER-1: server-rendered GET toolbar. Every submission is
 * a plain link/GET navigation, so refresh and back keep the filters via
 * the URL; there is no client fetch loop to debounce (Δ: the shell has
 * intentionally no JS — stale-response risk is covered by the shell's
 * per-request model and the fetcher's 4 s AbortController timeout).
 */
function renderFilterBar(f: OperationListOkResult): string {
  const active = f.filters;
  // W-ADMUX03-SHELL-SORT-1: the ordering control. Submitting this GET form
  // builds the next URL from the form fields alone - there is deliberately
  // no cursor field here - so changing the sort structurally restarts at
  // page 1 of the new ordering instead of replaying a cursor bound to the
  // old one (which the route rejects, T140-A1).
  const sortOptions = OPERATION_LIST_SORT_OPTIONS.map((o) => {
    const selected = o.value === f.sort ? ' selected' : '';
    return `<option value="${esc(o.value)}" data-sort-option="${esc(o.value)}"${selected}>${esc(SORT_LABEL[o.value] ?? o.value)}</option>`;
  }).join('');
  const options = OPERATION_STATE_FILTERS.map((value) => {
    const selected = value === active.state ? ' selected' : '';
    return `<option value="${esc(value)}" data-filter-option="${esc(value)}"${selected}>${esc(STATE_FILTER_LABEL[value])}</option>`;
  }).join('');
  return [
    '<form class="admin-filter-bar" method="get" action="/admin/operations" data-filter-bar="true">',
    `<input type="hidden" name="limit" value="${f.limit}" data-filter-echo-limit="${f.limit}">`,
    '<label class="admin-filter-bar__label" for="adm-filter-state">State</label>',
    '<select id="adm-filter-state" name="state" data-filter-state-select>',
    options,
    '</select>',
    '<label class="admin-filter-bar__label" for="adm-filter-sort">Sort</label>',
    '<select id="adm-filter-sort" name="sort" data-filter-sort-select>',
    sortOptions,
    '</select>',
    '<label class="admin-filter-bar__label" for="adm-filter-tenant">Tenant</label>',
    `<input id="adm-filter-tenant" name="tenant" type="search" maxlength="64" autocomplete="off" placeholder="exact tenant id" value="${esc(active.tenant ?? '')}" data-filter-tenant-input>`,
    '<label class="admin-filter-bar__label" for="adm-filter-id">ID contains</label>',
    `<input id="adm-filter-id" name="id" type="search" maxlength="64" autocomplete="off" placeholder="operation id fragment" value="${esc(active.idContains ?? '')}" data-filter-id-input>`,
    '<button type="submit" class="admin-filter-bar__apply" data-filter-apply="true">Apply filters</button>',
    '</form>',
  ].join('');
}

function renderFilterChips(f: OperationListOkResult): string {
  const active = f.filters;
  const chips: string[] = [];
  if (active.state !== 'ALL') {
    const href = opsPageHref({
      limit: f.limit,
      filters: { ...active, state: 'ALL' },
      sort: f.sort,
    });
    chips.push(
      `<span class="admin-filter-chip" data-filter-chip="state">State: ${esc(STATE_FILTER_LABEL[active.state])} <a href="${esc(href)}" aria-label="Remove state filter" data-filter-clear="state">&#215; remove</a></span>`,
    );
  }
  if (active.tenant) {
    const href = opsPageHref({
      limit: f.limit,
      filters: { ...active, tenant: null },
      sort: f.sort,
    });
    chips.push(
      `<span class="admin-filter-chip" data-filter-chip="tenant">Tenant: ${esc(active.tenant)} <a href="${esc(href)}" aria-label="Remove tenant filter" data-filter-clear="tenant">&#215; remove</a></span>`,
    );
  }
  if (active.idContains) {
    const href = opsPageHref({
      limit: f.limit,
      filters: { ...active, idContains: null },
      sort: f.sort,
    });
    chips.push(
      `<span class="admin-filter-chip" data-filter-chip="id">ID contains: ${esc(active.idContains)} <a href="${esc(href)}" aria-label="Remove id filter" data-filter-clear="id">&#215; remove</a></span>`,
    );
  }
  for (const rejected of f.ignoredFilters) {
    // Rejected tokens are named, never echoed — an invalid value may
    // have been a pasted credential and must not re-enter DOM/URL/logs.
    chips.push(
      `<span class="admin-filter-chip admin-filter-chip--rejected" role="status" data-filter-rejected="${esc(rejected)}">Filter “${esc(rejected)}” ignored (invalid characters)</span>`,
    );
  }
  if (chips.length === 0) {
    return '<div class="admin-filter-chips admin-filter-chips--empty" data-filter-chips="none"></div>';
  }
  // W-ADMUX03-TOOLBAR-CHIPS-1: "Clear all" is a reset, not a filter edit. A
  // per-chip remove above keeps the page size the operator chose; this control
  // returns the default first page - no filters, no cursor into the population
  // being abandoned, and the contract default limit. It stays a GET link
  // because the admin shell ships no client JS, so a <button> here is inert.
  const clearAll = opsPageHref({ limit: OPERATION_LIST_DEFAULT_LIMIT });
  chips.push(
    `<a class="admin-filter-chip admin-filter-chip--clear-all" href="${esc(clearAll)}" aria-label="Clear all filters and reset the page size to ${OPERATION_LIST_DEFAULT_LIMIT}" data-filter-clear-all="true">Clear all</a>`,
  );
  return `<div class="admin-filter-chips" role="group" aria-label="Active filters" data-filter-chips="active">${chips.join('')}</div>`;
}

function renderListRow(r: OperationListRow): string {
  const badge = renderStatusBadge(r.status.state, r.status.label, r.status.badge);
  const progress = `${r.progressPercent}%`;
  return [
    `<tr class="operation-section__row" data-operation-row="${esc(r.id)}" data-operation-state="${esc(r.status.state)}" data-row-terminal="${r.status.terminal ? 'true' : 'false'}">`,
    `<td class="operation-section__row-id adm-col-p1" data-row-link="${esc(r.id)}"><a href="${esc(r.detailHref)}">${esc(r.id)}</a></td>`,
    `<td class="operation-section__row-state adm-col-p1">${badge}</td>`,
    `<td class="operation-section__row-action adm-col-p2" data-row-action="${esc(r.action)}">${esc(r.action)}</td>`,
    `<td class="operation-section__row-business adm-col-p3" data-row-business="${esc(r.businessId)}">${esc(r.businessId)}@${esc(r.businessVersion)}</td>`,
    `<td class="operation-section__row-progress adm-col-p3" data-row-progress="${r.progressPercent}">${esc(progress)}</td>`,
    `<td class="operation-section__row-created adm-col-p2">${esc(r.createdAt)}</td>`,
    `<td class="operation-section__row-updated adm-col-p4">${esc(r.updatedAt)}</td>`,
    `<td class="operation-section__row-deadline adm-col-p4" data-row-deadline="${esc(r.deadlineAt ?? '')}">${r.deadlineAt ? esc(r.deadlineAt) : '(none)'}</td>`,
    '</tr>',
  ].join('');
}

function renderListTable(rows: readonly OperationListRow[]): string {
  const head = [
    '<thead><tr>',
    '<th class="adm-col-p1" scope="col">Operation</th>',
    '<th class="adm-col-p1" scope="col">State</th>',
    '<th class="adm-col-p2" scope="col">Action</th>',
    '<th class="adm-col-p3" scope="col">Business</th>',
    '<th class="adm-col-p3" scope="col">Progress</th>',
    '<th class="adm-col-p2" scope="col">Created</th>',
    '<th class="adm-col-p4" scope="col">Updated</th>',
    '<th class="adm-col-p4" scope="col">Deadline</th>',
    '</tr></thead>',
  ].join('');
  const body = rows.map(renderListRow).join('');
  return `<table class="operation-section__list-table" data-list-table="true">${head}<tbody>${body}</tbody></table>`;
}

function renderPaginationNav(f: OperationListOkResult): string {
  const filtered = areListFiltersActive(f.filters);
  const parts: string[] = ['<nav class="admin-pagination" aria-label="Operations pages">'];
  if (f.prevCursor) {
    parts.push(
      `<a class="admin-pagination__prev" href="${esc(opsPageHref({ limit: f.limit, cursor: f.prevCursor, filters: f.filters, sort: f.sort }))}" rel="prev" data-pagination-prev="link">&#8592; Previous</a>`,
    );
  } else {
    parts.push(
      '<span class="admin-pagination__prev admin-pagination__prev--disabled" aria-disabled="true" data-pagination-prev="disabled">&#8592; Previous</span>',
    );
  }
  if (filtered && f.total === null) {
    // Whole-population filtering is live, so a filtered page is only a partial
    // view when the platform withheld the count. Say exactly that, instead of
    // implying other pages might still hold matches.
    parts.push(
      `<span class="admin-pagination__count" data-list-count="page">${f.rows.length} operations match the filters on this page (page limit ${f.limit}) — the platform did not report how many match in total</span>`,
    );
  } else if (f.total !== null) {
    // `total` is a COUNT of the FILTERED population, so with filters active it
    // is the number of matches in total — not a page-local figure.
    const scope = filtered ? ' match the filters' : '';
    parts.push(
      `<span class="admin-pagination__count" data-list-count="exact">${f.rows.length} of ${f.total} operations${scope}</span>`,
    );
  } else {
    parts.push(
      `<span class="admin-pagination__count" data-list-count="page">${f.rows.length} operations on this page (page limit ${f.limit})</span>`,
    );
  }
  if (f.nextCursor) {
    parts.push(
      `<a class="admin-pagination__next" href="${esc(opsPageHref({ limit: f.limit, cursor: f.nextCursor, filters: f.filters, sort: f.sort }))}" rel="next" data-pagination-next="link">Next &#8594;</a>`,
    );
  } else if (f.total === null && f.pageRows >= f.limit) {
    parts.push(
      '<span class="admin-pagination__next admin-pagination__next--disabled" aria-disabled="true" data-pagination-next="disabled">Next &#8594;</span>',
    );
    // The page is full but the platform sent neither a continuation cursor nor
    // a total. Whether more rows follow is unknown — not "known to exist" — so
    // the note states the limit and the way out rather than promising a
    // contract that has already shipped.
    parts.push(
      '<span class="admin-pagination__note" data-pagination-cursor-unavailable="true">This page is full and the platform returned no continuation cursor, so the next page cannot be loaded from here — narrow the filters or raise the page size to reach the rest.</span>',
    );
  } else {
    parts.push(
      '<span class="admin-pagination__next admin-pagination__next--disabled" aria-disabled="true" data-pagination-next="end">Next &#8594;</span>',
    );
  }
  const sizes = LIST_PAGE_SIZES.map((size) => {
    const current = size === f.limit ? ' aria-current="true"' : '';
    const href = opsPageHref({ limit: size, filters: f.filters, sort: f.sort });
    return `<a href="${esc(href)}" data-page-size="${size}"${current}>${size}</a>`;
  }).join('');
  parts.push(
    `<span class="admin-pagination__sizes" role="group" aria-label="Page size">${sizes}</span>`,
  );
  parts.push('</nav>');
  return parts.join('');
}

function renderOperationsListPane(f: OperationListOkResult): string {
  const cursorAttr = f.cursor ? ` data-list-cursor="${esc(f.cursor)}"` : '';
  const filtered = areListFiltersActive(f.filters);
  const content =
    f.rows.length === 0
      ? filtered
        ? '<p class="operation-section__list-empty" data-empty-banner="filtered">No operations match the active filters. The server filters the whole population, so this is an empty result, not a page you need to page through — clear a filter to widen the search.</p>'
        : '<p class="operation-section__list-empty" data-empty-banner="true">No operations matched this page — the platform reported zero rows. This is data, not an outage.</p>'
      : renderListTable(f.rows);
  return [
    '<section class="operation-section operation-section--list"',
    ' data-operation-selected=""',
    ' data-can-cancel="false"',
    ' data-can-resume="false"',
    ' data-can-replay="false"',
    ' data-result-available="false"',
    ' data-artifact-total="0"',
    ' data-list-page="true"',
    ` data-list-limit="${f.limit}"`,
    ` data-list-total="${f.total === null ? 'unknown' : f.total}"`,
    ` data-list-next-cursor="${f.nextCursor ? 'true' : 'false'}"`,
    ` data-filter-active="${filtered ? 'true' : 'false'}"`,
    ` data-filter-state="${esc(f.filters.state)}"`,
    ` data-list-sort="${esc(f.sort)}"`,
    ` data-filter-page-rows="${f.pageRows}"`,
    ` data-filter-ignored="${f.ignoredFilters.join(',') || 'none'}"`,
    cursorAttr,
    '>',
    '<header class="operation-section__header">',
    '<h2 class="operation-section__title">Operations</h2>',
    '</header>',
    renderFilterBar(f),
    renderFilterChips(f),
    content,
    renderPaginationNav(f),
    '</section>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderOperationSection(
  input: OperationSectionRenderInput,
): OperationSectionRenderOutput {
  const f = input.fetch;
  switch (f.kind) {
    case 'list':
      return { html: renderOperationsListPane(f), isReady: true };
    case 'ok': {
      const isListView =
        input.selectedOperationId !== undefined && input.selectedOperationId.length === 0;
      const html = isListView
        ? renderListEmptyState(f)
        : renderDetailRoot(f, backToListHref(input));
      return { html, isReady: true };
    }
    case 'empty':
      return {
        html: [
          '<section class="operation-section operation-section--empty" data-operation-selected="">',
          '<header><h2>Operations</h2></header>',
          `<p class="operation-section__empty" data-empty-message="true">${esc(f.message)}</p>`,
          '</section>',
        ].join(''),
        isReady: false,
      };
    case 'unauthorized':
      return {
        html: [
          '<section class="operation-section operation-section--unauthorized" data-operation-selected="">',
          '<header><h2>Operations</h2></header>',
          `<p class="operation-section__unauthorized" data-unauthorized-message="true">${esc(f.message)}</p>`,
          '</section>',
        ].join(''),
        isReady: false,
      };
    case 'not-found':
      return {
        html: [
          '<section class="operation-section operation-section--not-found" data-operation-selected="" data-not-found-id="' + esc(f.operationId) + '">',
          '<header><h2>Operations</h2></header>',
          `<p class="operation-section__not-found" data-not-found-message="true">${esc(f.message)}</p>`,
          '</section>',
        ].join(''),
        isReady: false,
      };
    case 'error':
      return {
        html: [
          '<section class="operation-section operation-section--error" data-operation-selected="">',
          '<header><h2>Operations</h2></header>',
          `<p class="operation-section__error" data-error-message="true">${esc(f.message)}</p>`,
          '</section>',
        ].join(''),
        isReady: false,
      };
  }
}

export const __test = {
  renderStatusBadge,
  renderArtifactRow,
  renderArtifactsTable,
  renderResultPanel,
  renderHumanWaitForm,
  renderActionBar,
  renderDetailRoot,
  renderListEmptyState,
};
