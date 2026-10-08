/**
 * P6-05 API key section renderer.
 *
 * Pure HTML renderer for the API key create / copy-once / revoke /
 * assignment pane. Consumes the fetcher's `ApiKeyFetchResult` and
 * emits a fully-escaped, XHTML-friendly form that the shell splices
 * at `</section></main>`.
 *
 * Hard rule: the raw API key value is accepted ONLY as the
 * `createCopyOnce.rawKey` payload from the fetcher, and the renderer
 * projects it once inside a `data-copy-once-raw="…"` attribute on
 * a single `<output>` element. Every other surface — list rows,
 * selected detail, grants — sees only the masked hint. The renderer's
 * `data-copy-once-available="true|false"` flag is the single
 * discriminator the P6-05 DOM-evidence tests assert.
 *
 * Revoke action: the renderer asks for confirmation via an inline
 * `<details>` panel; the confirm button carries
 * `data-action="revoke-api-key"`. Revoke is disabled unless the
 * view model says `canRevoke`.
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
  ApiKeyAssignmentRow,
  ApiKeyCreateView,
  ApiKeyListRow,
} from './api-key-view-models';
import type {
  ApiKeyFetchResult,
  ApiKeyListOkResult,
  ApiKeyTenantOption,
} from './api-key-section-data';

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

export interface ApiKeySectionRenderInput {
  fetch: ApiKeyFetchResult;
  /** Session-bound proof for browser mutations. */
  csrfToken?: string;
  canManage?: boolean;
  /** Optional canonical list of known key ids the shell recognises. */
  knownKeyIds?: readonly string[];
  /** Currently selected key id (drives the picker active state). */
  selectedKeyId?: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ApiKeySectionRenderOutput {
  html: string;
  /** True iff the rendered HTML is the success (list+detail) pane. */
  isReady: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeClass(
  badge: 'success' | 'warning' | 'error' | 'neutral',
): string {
  return `status-badge status-badge--${badge}`;
}

function renderStatusBadge(row: ApiKeyListRow): string {
  return [
    `<span class="${esc(statusBadgeClass(row.statusBadge))}" data-key-status="${esc(row.status)}">`,
    esc(row.statusLabel),
    '</span>',
  ].join('');
}

function renderApiKeyPicker(
  knownIds: readonly string[],
  selected: string,
): string {
  if (knownIds.length === 0) {
    return '<p class="api-key-section__picker-empty">No API keys are registered yet.</p>';
  }
  const options = knownIds
    .map(
      (id) =>
        `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(id)}</option>`,
    )
    .join('');
  return [
    '<form method="GET" action="/admin/api-keys" class="api-key-section__picker">',
    '<label for="apiKeyId">API key</label>',
    `<select id="apiKeyId" name="keyId">${options}</select>`,
    '<button type="submit">Open</button>',
    '</form>',
  ].join('');
}

function renderListRow(row: ApiKeyListRow): string {
  const lastUsed = row.lastUsedAt ?? '—';
  const revoked = row.revokedAt ?? '—';
  return [
    '<tr class="api-key-section__row" data-key-id="' + esc(row.id) + '" data-key-status="' + esc(row.status) + '" data-lifecycle="' + esc(row.status === 'REVOKED' ? 'retired' : row.status === 'ACTIVE' ? 'active' : 'draft') + '">',
    `<th scope="row"><a href="/admin/api-keys?keyId=${esc(encodeURIComponent(row.id))}" aria-label="View API key ${esc(row.id)}"><code>${esc(row.id)}</code></a></th>`,
    `<td><code class="api-key-section__masked-hint" data-key-masked="${esc(row.maskedHint)}">${esc(row.maskedHint)}</code></td>`,
    `<td><code>${esc(row.prefix)}</code></td>`,
    '<td>' + renderStatusBadge(row) + '</td>',
    `<td>${esc(row.createdAt)}</td>`,
    `<td>${esc(lastUsed)}</td>`,
    `<td>${esc(revoked)}</td>`,
    '</tr>',
  ].join('');
}

function renderListTable(rows: readonly ApiKeyListRow[]): string {
  if (rows.length === 0) {
    return '<p class="api-key-section__list-empty">No keys on file yet.</p>';
  }
  return [
    '<table class="api-key-section__list" data-list-total="' + esc(String(rows.length)) + '">',
    '<thead>',
    '<tr><th>ID</th><th>Masked hint</th><th>Prefix</th><th>Status</th><th>Created</th><th>Last used</th><th>Revoked</th></tr>',
    '</thead>',
    '<tbody>',
    rows.map(renderListRow).join(''),
    '</tbody>',
    '</table>',
  ].join('');
}

function renderCopyOnceBanner(createCopyOnce: ApiKeyCreateView): string {
  // The renderer ONLY sees the masked hint — `ApiKeyCreateView` is
  // built by `buildApiKeyCreateView` which discards the raw value
  // before the view reaches the renderer. The single
  // `data-copy-once-available="true"` discriminator plus the masked
  // hint are the renderer-safe surface. The actual raw key surface
  // belongs to the platform's create POST response (the operator
  // sees it once, acknowledges, and the next GET re-renders with
  // the masked hint only). `data-copy-once-notice` carries the
  // copy-once contract text; `data-copy-once-id`, `data-copy-once-prefix`
  // and `data-copy-once-masked` carry the rendered metadata. There
  // is NEVER a `data-copy-once-raw` attribute — the renderer cannot
  // echo a raw value it does not hold.
  return [
    '<section class="api-key-section__copy-once" data-copy-once-available="true" data-copy-once-id="' + esc(createCopyOnce.id) + '" role="alert">',
    '<header><h3>Copy-once window</h3></header>',
    `<p class="api-key-section__copy-once-notice" data-copy-once-notice="${esc(createCopyOnce.copyOnceNotice)}">${esc(createCopyOnce.copyOnceNotice)}</p>`,
    '<dl class="api-key-section__copy-once-meta">',
    `<dt>Masked hint</dt><dd><code class="api-key-section__copy-once-masked" data-copy-once-masked="${esc(createCopyOnce.maskedHint)}">${esc(createCopyOnce.maskedHint)}</code></dd>`,
    `<dt>Prefix</dt><dd><code data-copy-once-prefix="${esc(createCopyOnce.prefix)}">${esc(createCopyOnce.prefix)}</code></dd>`,
    `<dt>Label</dt><dd><code data-copy-once-label="${esc(createCopyOnce.label ?? '')}">${esc(createCopyOnce.label ?? '—')}</code></dd>`,
    '</dl>',
    '<p class="api-key-section__copy-once-warn" data-warning="copy-once-blast-radius">',
    'After you leave this page the raw value is no longer retrievable. Store it in your secret manager now.',
    '</p>',
    '<form method="POST" action="/admin/api-keys/' + esc(createCopyOnce.id) + '/acknowledge" class="api-key-section__copy-once-ack">',
    '<button type="submit" class="api-key-section__copy-once-ack-submit" data-action="acknowledge-copy-once">I have stored the key</button>',
    '</form>',
    '</section>',
  ].join('');
}

function renderRevokePanel(row: ApiKeyListRow, csrfToken = ''): string {
  // The renderer always shows the revoke affordance but disables the
  // confirm button when the view model says `canRevoke === false`.
  // `data-can-revoke` is the explicit discriminator — the evidence
  // tests assert the flag matches the row's status.
  const disabled = row.canRevoke ? '' : ' disabled';
  return [
    '<section class="api-key-section__revoke" data-key-id="' + esc(row.id) + '" data-can-revoke="' + esc(row.canRevoke ? 'true' : 'false') + '">',
    '<header><h3>Revoke</h3></header>',
    '<details>',
    '<summary data-action="open-revoke">Revoke this API key</summary>',
    '<p class="api-key-section__revoke-warning" data-warning="revoke-blast-radius">',
    'Revoking this key permanently disables it. Outstanding operations in flight will fail.',
    '</p>',
    '<form method="POST" action="/admin/api-keys/' + esc(row.id) + '/revoke" class="api-key-section__revoke-form" onsubmit="return confirm(\'Revoke this API key? It cannot be used after revocation.\')">',
    '<input type="hidden" name="csrf" value="' + esc(csrfToken) + '">',
    '<button type="submit" class="api-key-section__revoke-submit" data-action="revoke-api-key"' + disabled + '>Confirm revoke</button>',
    '</form>',
    '</details>',
    '</section>',
  ].join('');
}

function renderGrantsTable(
  keyId: string,
  grants: readonly ApiKeyAssignmentRow[],
): string {
  if (grants.length === 0) {
    return [
      '<section class="api-key-section__grants" data-key-id="' + esc(keyId) + '" data-grant-total="0">',
      '<header><h3>Assignments</h3></header>',
      '<p class="api-key-section__grants-empty">No assignments on file for this key.</p>',
      '</section>',
    ].join('');
  }
  const rows = grants
    .map(
      (g) =>
        '<tr class="api-key-section__grant-row" data-business-id="' + esc(g.businessId) + '" data-business-version="' + esc(g.businessVersion) + '" data-action="' + esc(g.action) + '">' +
        `<td><code>${esc(g.businessId)}</code></td>` +
        `<td><code>${esc(g.businessVersion)}</code></td>` +
        `<td><code>${esc(g.action)}</code></td>` +
        `<td>${esc(g.grantedAt)}</td>` +
        '</tr>',
    )
    .join('');
  return [
    '<section class="api-key-section__grants" data-key-id="' + esc(keyId) + '" data-grant-total="' + esc(String(grants.length)) + '">',
    '<header><h3>Assignments</h3></header>',
    '<table class="api-key-section__grants-table">',
    '<thead><tr><th>Business</th><th>Version</th><th>Action</th><th>Granted at</th></tr></thead>',
    '<tbody>' + rows + '</tbody>',
    '</table>',
    '</section>',
  ].join('');
}

function renderDetailPanel(ok: ApiKeyListOkResult, csrfToken = '', canManage = true): string {
  if (!ok.selected) {
    return '';
  }
  return [
    '<section class="api-key-section__detail" aria-label="API key detail" data-key-id="' + esc(ok.selected.id) + '" data-key-status="' + esc(ok.selected.status) + '" data-lifecycle="' + esc(ok.selected.status === 'REVOKED' ? 'retired' : ok.selected.status === 'ACTIVE' ? 'active' : 'draft') + '">',
    '<header><h2>API key <code>' + esc(ok.selected.id) + '</code></h2></header>',
    '<p class="api-key-section__lifecycle">' + esc(ok.selected.status === 'REVOKED' ? 'Retired' : ok.selected.status === 'ACTIVE' ? 'Active' : 'Revocation in progress') + '</p>',
    '<p><a href="/admin/api-keys">Back to API key list</a></p>',
    '<dl class="api-key-section__detail-meta">',
    `<dt>Tenant</dt><dd><code>${esc(ok.selected.tenantId)}</code></dd>`,
    `<dt>Masked hint</dt><dd><code class="api-key-section__masked-hint" data-key-masked="${esc(ok.selected.maskedHint)}">${esc(ok.selected.maskedHint)}</code></dd>`,
    `<dt>Prefix</dt><dd><code>${esc(ok.selected.prefix)}</code></dd>`,
    '<dt>Status</dt><dd>' + renderStatusBadge(ok.selected) + '</dd>',
    `<dt>Created</dt><dd>${esc(ok.selected.createdAt)}</dd>`,
    `<dt>Last used</dt><dd>${esc(ok.selected.lastUsedAt ?? '—')}</dd>`,
    `<dt>Revoked</dt><dd>${esc(ok.selected.revokedAt ?? '—')}</dd>`,
    '</dl>',
    canManage ? renderRevokePanel(ok.selected, csrfToken) : '',
    renderGrantsTable(ok.selected.id, ok.grants),
    '</section>',
  ].join('');
}

function renderCreateForm(
  csrfToken = '',
  tenantOptions: readonly ApiKeyTenantOption[] = [],
  selectedTenantId = '',
): string {
  // The create affordance. The form posts to the shell route
  // `POST /admin/api-keys/new`, which `handleAdminMutationPost`
  // (`app/admin/mutation-dispatch.ts`) forwards as the `apikey.issue`
  // admin action to the BFF (`POST /api/v1/admin/actions`).
  // The tenant id is a value only; a failed/empty roster leaves a required
  // blank placeholder so the form cannot issue a key for an empty tenant.
  const inRoster = tenantOptions.some((tenant) => tenant.id === selectedTenantId);
  const tenantChoices = [
    `<option value=""${inRoster ? '' : ' selected'}>Select a tenant</option>`,
    ...tenantOptions.map((tenant) => {
      const label = tenant.state.length === 0 || tenant.state === 'ACTIVE'
        ? tenant.name
        : `${tenant.name} (${tenant.state})`;
      return `<option value="${esc(tenant.id)}"${tenant.id === selectedTenantId ? ' selected' : ''}>${esc(label)}</option>`;
    }),
  ].join('');
  return [
    '<section class="api-key-section__create">',
    '<header><h3>Issue new API key</h3></header>',
    '<form method="POST" action="/admin/api-keys/new" class="api-key-section__create-form">',
    '<input type="hidden" name="csrf" value="' + esc(csrfToken) + '">',
    '<label>Tenant',
    `<select name="tenantId" aria-label="Tenant" required>${tenantChoices}</select>`,
    '</label>',
    '<button type="submit" class="api-key-section__create-submit" data-action="create-api-key">Issue key</button>',
    '</form>',
    '</section>',
  ].join('');
}

function renderEmpty(
  message: string,
  csrfToken = '',
  canManage = true,
  tenantOptions: readonly ApiKeyTenantOption[] = [],
): string {
  return [
    '<section class="api-key-section api-key-section--empty" role="status">',
    '<h2>API key management</h2>',
    `<p>${esc(message)}</p>`,
    canManage ? renderCreateForm(csrfToken, tenantOptions) : '',
    '</section>',
  ].join('');
}

function renderUnauthorized(message: string): string {
  return [
    '<section class="api-key-section api-key-section--unauthorized" role="alert">',
    '<h2>Admin token rejected</h2>',
    `<p>${esc(message)}</p>`,
    '<p>The shell reuses the orchestrator admin bearer token. Update the platform config and reload.</p>',
    '</section>',
  ].join('');
}

function renderNotFound(message: string): string {
  return [
    '<section class="api-key-section api-key-section--not-found" role="status">',
    '<h2>API key not on file</h2>',
    `<p>${esc(message)}</p>`,
    '<p>The shell cannot render a key detail pane without a registered id. Return to the list and pick another key.</p>',
    '</section>',
  ].join('');
}

function renderError(message: string): string {
  return [
    '<section class="api-key-section api-key-section--error" role="alert">',
    '<h2>Could not load API keys</h2>',
    `<p>${esc(message)}</p>`,
    '</section>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

export function renderApiKeySection(input: ApiKeySectionRenderInput): ApiKeySectionRenderOutput {
  const f = input.fetch;

  if (f.kind === 'ok') {
    const picker = input.knownKeyIds
      ? renderApiKeyPicker(input.knownKeyIds, input.selectedKeyId ?? f.selectedKeyId)
      : '';
    const copyOnce = f.createCopyOnce ? renderCopyOnceBanner(f.createCopyOnce) : '';
    return {
      html: [
        '<section class="api-key-section" data-key-total="' + esc(String(f.total)) + '" data-key-selected="' + esc(f.selectedKeyId) + '" data-copy-once-available="' + esc(f.createCopyOnce ? 'true' : 'false') + '">',
        picker,
        copyOnce,
        input.canManage === false ? '' : renderCreateForm(input.csrfToken, f.tenantOptions ?? [], f.selected?.tenantId ?? ''),
        f.selected ? '' : renderListTable(f.rows),
        renderDetailPanel(f, input.csrfToken, input.canManage),
        '</section>',
      ].join(''),
      isReady: true,
    };
  }
  if (f.kind === 'empty') {
    return { html: renderEmpty(f.message, input.csrfToken, input.canManage, f.tenantOptions ?? []), isReady: false };
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

/** Render a single API key list row independently (for unit tests). */
export function renderApiKeyListRow(row: ApiKeyListRow): string {
  return renderListRow(row);
}

/** Render the copy-once banner independently (for unit tests). */
export function renderApiKeyCopyOnceBanner(createCopyOnce: ApiKeyCreateView): string {
  return renderCopyOnceBanner(createCopyOnce);
}

/** Render the revoke panel independently (for unit tests). */
export function renderApiKeyRevokePanel(row: ApiKeyListRow): string {
  return renderRevokePanel(row);
}

/** Render the grants table independently (for unit tests). */
export function renderApiKeyGrantsTable(keyId: string, grants: readonly ApiKeyAssignmentRow[]): string {
  return renderGrantsTable(keyId, grants);
}
