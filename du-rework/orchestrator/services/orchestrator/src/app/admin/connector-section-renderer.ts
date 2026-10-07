/**
 * P6-04 Connector section renderer.
 *
 * Pure HTML renderer for the connector config / secret rotation /
 * test result pane. Consumes the fetcher's `ConnectorFetchResult`
 * and emits a fully-escaped, XHTML-friendly form that the shell
 * splices at `</section></main>`.
 *
 * Hard rule: secret material is **write-only**. The renderer never
 * carries a raw secret value, never echoes it from `data-*` or
 * `value=` attributes, and never reflects a `<input type="password">`
 * filled with a current value. Per-slot inputs render as empty
 * `type="password"` with the write-only `hasValue` flag surfaced as
 * a "Configured" / "Not configured" badge — no value ever leaves the
 * server's storage layer.
 *
 * Test-result pane: an explicit `data-test-result-kind="success" |
 * failure | pending"` block with a sanitized message, plus the
 * `testedAt` timestamp when present. No upstream response body is
 * ever projected.
 *
 * Failure fallbacks: empty / unauthorized / not-found / error
 * panes map onto the existing screen states. The `isReady` flag
 * flips for the success pane only.
 *
 * Strict TypeScript, zero `any`. Every value flowing into HTML
 * goes through `esc()`.
 */

import { esc } from './shell-render';
import type {
  ConnectorFetchResult,
} from './connector-section-data';
import type {
  ConnectorRevisionView,
  ConnectorSecretSlotView,
  ConnectorTestResultView,
} from './connector-view-models';
import type { RotateSecretState } from './types';

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

export interface ConnectorSectionRenderInput {
  fetch: ConnectorFetchResult;
  csrfToken?: string;
  /**
   * Optional list of connector ids the shell recognises. Drives the
   * picker at the top of the pane (mirrors the P6-02 business picker).
   * When omitted, the renderer omits the picker.
   */
  knownConnectorIds?: readonly string[];
  /** Currently selected connector id. */
  selectedConnectorId?: string;
  /** Currently selected revision. */
  selectedRevision?: number;
  /** Optional second revision loaded by the shell for metadata comparison. */
  compareFetch?: ConnectorFetchResult;
  compareRevision?: number;
}

export type ConnectorSectionOkResult = ConnectorFetchResult & { kind: 'ok' };

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ConnectorSectionRenderOutput {
  html: string;
  /** True iff the rendered HTML is the success (form) pane. */
  isReady: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function revisionLabel(revision: number): string {
  return `#${revision}`;
}

function statusBadgeClass(badge: 'success' | 'warning' | 'error' | 'neutral'): string {
  return `status-badge status-badge--${badge}`;
}

function renderStateBadge(view: ConnectorRevisionView): string {
  return [
    `<span class="${esc(statusBadgeClass(view.stateBadge))}" data-state="${esc(view.state)}">`,
    esc(view.stateLabel),
    '</span>',
  ].join('');
}

function renderTestResultBadge(view: ConnectorTestResultView): string {
  // The renderer maps `success` to the success badge and every other
  // kind to its specific variant. The `data-test-result-kind` attribute
  // carries the explicit state (`success` vs `failure`-classed kinds
  // vs `pending`) so the P6-04 DOM-evidence assertion can verify both
  // the explicit success path and the failure paths.
  const kind = view.kind;
  const isSuccess = kind === 'success';
  return [
    `<span class="${esc(statusBadgeClass(view.badge))}" data-test-result-kind="${esc(isSuccess ? 'success' : (kind === 'pending' ? 'pending' : 'failure'))}" data-test-result="${esc(kind)}">`,
    esc(view.label),
    '</span>',
  ].join('');
}

function renderSecretBadge(slot: ConnectorSecretSlotView): string {
  // Write-only: badge says "Configured" / "Not configured"; the raw
  // value is never present on the wire and never rendered.
  return [
    `<span class="${esc(statusBadgeClass(slot.statusBadge))}" data-secret-state="${esc(slot.hasValue ? 'configured' : 'not-configured')}">`,
    esc(slot.statusLabel),
    '</span>',
  ].join('');
}

function renderConnectorPicker(
  knownIds: readonly string[],
  selected: string,
  revision: number,
  compareRevision: number | undefined,
): string {
  if (knownIds.length === 0) {
    return '<p class="connector-section__picker-empty">No connectors are registered on this shell yet.</p>';
  }
  const options = knownIds
    .map(
      (id) =>
        `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(id)}</option>`,
    )
    .join('');
  const rev = Number.isFinite(revision) && revision > 0 ? String(revision) : '';
  return [
    '<form method="GET" action="/admin/connectors" class="connector-section__picker">',
    '<label for="connectorId">Connector</label>',
    `<select id="connectorId" name="connectorId">${options}</select>`,
    '<label for="connectorRevision">Revision</label>',
    `<input id="connectorRevision" name="revision" type="number" value="${esc(rev)}" min="0" placeholder="latest">`,
    '<label for="connectorCompareRevision">Compare with revision</label>',
    `<input id="connectorCompareRevision" name="compareRevision" type="number" value="${compareRevision && compareRevision > 0 ? esc(String(compareRevision)) : ''}" min="1" placeholder="optional">`,
    '<button type="submit">Open / compare</button>',
    '</form>',
  ].join('');
}

function renderSecretSlotForm(
  connectorId: string,
  revision: number,
  slot: ConnectorSecretSlotView,
  rotateState: RotateSecretState,
  csrfToken = '',
): string {
  // Write-only: the input is empty and `type="password"`. The
  // server never accepts a value from the GET path; rotation is a
  // separate POST. The renderer carries only the slot identity +
  // the configured/not-configured status badge — no value ever.
  const formId = `connector-${esc(connectorId)}-r${revision}-${esc(slot.name)}-rotate`;
  const disabled = rotateState !== 'idle' ? ' disabled' : '';
  return [
    `<form id="${formId}" method="POST" action="/admin/connectors/${esc(connectorId)}/revisions/${esc(String(revision))}/rotate-secret" class="connector-section__rotate-form" data-connector-id="${esc(connectorId)}" data-revision="${esc(String(revision))}" data-slot="${esc(slot.name)}" onsubmit="return confirm('Rotate this credential? The current value will stop working.')">`,
    '<input type="hidden" name="csrf" value="' + esc(csrfToken) + '">',
    '<input type="hidden" name="key" value="' + esc(slot.name) + '">',
    '<label>Vault mount <input name="mount" required></label>',
    '<label>Vault path <input name="path" required></label>',
    '<label class="connector-section__rotate-label" for="' + formId + '-value">',
    esc(slot.label),
    '</label>',
    renderSecretBadge(slot),
    `<input id="${formId}-value" class="field-input field-input--secret" type="password" name="value" autocomplete="off" value="" placeholder="(set a new value)" data-write-only="true"${disabled}>`,
    `<button type="submit" class="connector-section__rotate-submit" data-action="rotate-secret"${disabled}>Rotate</button>`,
    '<p class="connector-section__rotate-warning" data-warning="rotation-blast-radius">',
    'Rotating this secret invalidates the current value. Outstanding operations using the previous secret will fail until they are re-issued.',
    '</p>',
    slot.rotatedAt !== null
      ? `<small class="connector-section__rotate-rotated-at" data-rotated-at="${esc(slot.rotatedAt)}">last rotated: ${esc(slot.rotatedAt)}</small>`
      : '',
    '</form>',
  ].join('');
}

function renderTestAction(view: ConnectorTestResultView, csrfToken = ''): string {
  // Explicit test-action block. `data-test-result-kind` is the
  // coarse "success | failure | pending" discriminator that the
  // evidence tests assert; `data-test-result` carries the fine
  // kind tag (`success` / `invalid-credential` / `timeout` / …).
  // The `data-tested-at` attribute carries the timestamp when the
  // server reports one. The body holds the sanitized message — no
  // upstream response body or header is ever rendered.
  const testedAt = view.testedAt ?? '';
  return [
    '<section class="connector-section__test" data-test-result-kind="' + esc(view.kind === 'success' ? 'success' : view.kind === 'pending' ? 'pending' : 'failure') + '">',
    '<header class="connector-section__test-header"><h3>Test action</h3></header>',
    '<div class="connector-section__test-result" data-test-result="' + esc(view.kind) + '" data-tested-at="' + esc(testedAt) + '">',
    renderTestResultBadge(view),
    `<p class="connector-section__test-message" data-test-message="${esc(view.kind)}">${esc(view.message)}</p>`,
    testedAt.length > 0
      ? `<small class="connector-section__test-tested-at" data-rotated-at="false" data-tested-at="${esc(testedAt)}">tested at: ${esc(testedAt)}</small>`
      : '',
    '</div>',
    // The test-action form is always a POST (the server runs the
    // probe; the renderer is just the affordance). The button is
    // disabled until the operator has confirmed the intent — this
    // is the explicit test-action requirement: the operator must
    // press the button, the page then re-renders with the
    // result block above.
    '<form method="POST" action="/admin/connectors/' + esc(view.connectorId) + '/revisions/' + esc(String(view.revision)) + '/test" class="connector-section__test-form" onsubmit="return confirm(\'Run a connection test against this connector?\')">',
    '<input type="hidden" name="csrf" value="' + esc(csrfToken) + '">',
    '<button type="submit" class="connector-section__test-submit" data-action="test-connection">Run test</button>',
    '</form>',
    '</section>',
  ].join('');
}

function connectorLifecycleLabel(view: ConnectorRevisionView): string {
  if (view.state === 'enabled') return 'Active';
  if (view.state === 'disabled') return 'Draft';
  return 'Rotation in progress';
}

function renderRevisionCompare(
  current: ConnectorRevisionView,
  comparison: ConnectorFetchResult | undefined,
  requestedRevision: number | undefined,
): string {
  if (!requestedRevision) return '';
  if (!comparison || comparison.kind !== 'ok' || comparison.connectorId !== current.connectorId) {
    return `<p class="connector-section__compare-missing" role="status">Revision ${esc(String(requestedRevision))} is unavailable; no comparison data was returned.</p>`;
  }
  const leftSlots = new Map(current.secretSlots.map((slot) => [slot.name, slot]));
  const rightSlots = new Map(comparison.secretSlotViews.map((slot) => [slot.name, slot]));
  const slotNames = [...new Set([...leftSlots.keys(), ...rightSlots.keys()])].sort();
  const slotRows = slotNames.map((name) => {
    const left = leftSlots.get(name);
    const right = rightSlots.get(name);
    return `<tr><th scope="row">${esc(name)}</th><td>${left?.hasValue ? 'Configured' : left ? 'Not configured' : '—'}</td><td>${right?.hasValue ? 'Configured' : right ? 'Not configured' : '—'}</td></tr>`;
  }).join('');
  return [
    `<section class="connector-section__compare" aria-label="Connector revision comparison" data-compare-revision="${esc(String(comparison.revision))}">`,
    `<h3>Compare revision ${esc(String(current.revision))} with ${esc(String(comparison.revision))}</h3>`,
    '<dl>',
    `<dt>Lifecycle</dt><dd>${esc(connectorLifecycleLabel(current))} / ${esc(connectorLifecycleLabel(comparison.revisionView))}</dd>`,
    `<dt>Adapter</dt><dd>${esc(current.adapter)} / ${esc(comparison.revisionView.adapter)}</dd>`,
    `<dt>Masked host</dt><dd>${esc(current.endpoint.maskedHost)} / ${esc(comparison.revisionView.endpoint.maskedHost)}</dd>`,
    `<dt>Latest test</dt><dd>${esc(comparison.testResult.label)}${comparison.testResult.testedAt ? ` · ${esc(comparison.testResult.testedAt)}` : ''}</dd>`,
    '</dl>',
    '<table><thead><tr><th scope="col">Credential slot</th><th scope="col">Selected</th><th scope="col">Compared</th></tr></thead>',
    `<tbody>${slotRows || '<tr><td colspan="3">No credential slots are reported.</td></tr>'}</tbody></table>`,
    '<p>Credential values are write-only and never included in this comparison.</p>',
    '</section>',
  ].join('');
}

function renderRevisionPanel(
  view: ConnectorRevisionView,
  testResult: ConnectorTestResultView,
  rotateState: RotateSecretState,
  secretSlots: readonly ConnectorSecretSlotView[],
  csrfToken = '',
): string {
  const slotForms = secretSlots.map((slot) =>
    renderSecretSlotForm(view.connectorId, view.revision, slot, rotateState, csrfToken),
  );
  return [
    `<section class="connector-section__revision" data-connector-id="${esc(view.connectorId)}" data-revision="${esc(String(view.revision))}" data-revision-label="${esc(revisionLabel(view.revision))}">`,
    '<header class="connector-section__revision-header">',
    `<h2>Connector <code>${esc(view.connectorId)}</code> <span class="connector-section__revision-label" data-revision-label="${esc(revisionLabel(view.revision))}">${esc(revisionLabel(view.revision))}</span></h2>`,
    renderStateBadge(view),
    `<span class="connector-section__lifecycle" data-lifecycle="${esc(connectorLifecycleLabel(view).toLowerCase().replace(/\s+/g, '-'))}">${esc(connectorLifecycleLabel(view))}</span>`,
    '</header>',
    '<dl class="connector-section__revision-meta">',
    `<dt>Adapter</dt><dd>${esc(view.adapter)}</dd>`,
    `<dt>Endpoint kind</dt><dd>${esc(view.endpoint.kind)}</dd>`,
    `<dt>Masked host</dt><dd><code>${esc(view.endpoint.maskedHost)}</code></dd>`,
    `<dt>Capabilities</dt><dd>${view.capabilities.map((c) => `<code>${esc(c)}</code>`).join(', ')}</dd>`,
    `<dt>Created</dt><dd>${esc(view.createdAt)}</dd>`,
    `<dt>Updated</dt><dd>${esc(view.updatedAt)}</dd>`,
    '</dl>',
    '<section class="connector-section__secrets" aria-label="Secret slots">',
    '<header><h3>Secret slots</h3></header>',
    `<p class="connector-section__secrets-summary" data-secret-total="${esc(String(view.totalSecretSlots))}" data-secret-has-any="${esc(view.hasAnySecret ? 'true' : 'false')}">`,
    `${esc(String(view.totalSecretSlots))} slot${view.totalSecretSlots === 1 ? '' : 's'}; `,
    `${esc(String(view.hasAnySecret ? view.secretSlots.filter((s) => s.hasValue).length : 0))} configured.`,
    '</p>',
    slotForms.length > 0 ? slotForms.join('') : '<p class="connector-section__secrets-empty">No secret slots on this revision.</p>',
    '</section>',
    renderTestAction(testResult, csrfToken),
    '</section>',
  ].join('');
}

function renderEmpty(message: string): string {
  return [
    '<section class="connector-section connector-section--empty" role="status">',
    '<h2>Connector configuration</h2>',
    `<p>${esc(message)}</p>`,
    '</section>',
  ].join('');
}

function renderUnauthorized(message: string): string {
  return [
    '<section class="connector-section connector-section--unauthorized" role="alert">',
    '<h2>Admin token rejected</h2>',
    `<p>${esc(message)}</p>`,
    '<p>The shell reuses the orchestrator admin bearer token. Update the platform config and reload.</p>',
    '</section>',
  ].join('');
}

function renderNotFound(message: string): string {
  return [
    '<section class="connector-section connector-section--not-found" role="status">',
    '<h2>Connector not registered</h2>',
    `<p>${esc(message)}</p>`,
    '<p>The shell cannot render a connector pane without a registered revision. There is no platform route for creating connector bindings: connectors are registered in the Connector service, and credential changes go through <code>POST /api/v1/admin/actions</code> with action <code>connectors.rotate_credential</code>, <code>connectors.revoke_credential</code> or <code>connectors.test_credential</code>. For headless tests, use the in-process catalog fixture.</p>',
    '</section>',
  ].join('');
}

function renderError(message: string): string {
  return [
    '<section class="connector-section connector-section--error" role="alert">',
    '<h2>Could not load connector configuration</h2>',
    `<p>${esc(message)}</p>`,
    '</section>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

export function renderConnectorSection(input: ConnectorSectionRenderInput): ConnectorSectionRenderOutput {
  const f = input.fetch;

  if (f.kind === 'ok') {
    const picker = input.knownConnectorIds
      ? renderConnectorPicker(
          input.knownConnectorIds,
          input.selectedConnectorId ?? f.connectorId,
          input.selectedRevision ?? f.revision,
          input.compareRevision,
        )
      : '';
    return {
      html: [
        `<section class="connector-section" data-connector-id="${esc(f.connectorId)}" data-revision="${esc(String(f.revision))}" data-revision-label="${esc(revisionLabel(f.revision))}">`,
        picker,
        renderRevisionPanel(f.revisionView, f.testResult, f.rotateState, f.secretSlotViews, input.csrfToken),
        renderRevisionCompare(f.revisionView, input.compareFetch, input.compareRevision),
        '</section>',
      ].join(''),
      isReady: true,
    };
  }
  if (f.kind === 'empty') {
    return { html: renderEmpty(f.message), isReady: false };
  }
  if (f.kind === 'unauthorized') {
    return { html: renderUnauthorized(f.message), isReady: false };
  }
  if (f.kind === 'not-found') {
    return { html: renderNotFound(f.message), isReady: false };
  }
  return { html: renderError(f.message), isReady: false };
}

// ---------------------------------------------------------------------------
// Standalone helpers re-exported for tests
// ---------------------------------------------------------------------------

/** Render a single secret-slot form independently (for unit tests). */
export function renderConnectorSecretSlot(
  connectorId: string,
  revision: number,
  slot: ConnectorSecretSlotView,
  rotateState: RotateSecretState = 'idle',
): string {
  return renderSecretSlotForm(connectorId, revision, slot, rotateState);
}

/** Render the test-action block independently (for unit tests). */
export function renderConnectorTestAction(view: ConnectorTestResultView): string {
  return renderTestAction(view);
}

/** Count of secret slots currently `hasValue === true`. */
export function countConfiguredSecrets(secretSlots: readonly ConnectorSecretSlotView[]): number {
  let n = 0;
  for (const s of secretSlots) if (s.hasValue) n += 1;
  return n;
}

/** Render the connector picker independently (for unit tests). */
export function renderConnectorPickerOnly(
  knownIds: readonly string[],
  selected: string,
  revision: number,
  compareRevision?: number,
): string {
  return renderConnectorPicker(knownIds, selected, revision, compareRevision);
}
