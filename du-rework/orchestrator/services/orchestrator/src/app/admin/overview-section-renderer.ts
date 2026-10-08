/**
 * P6-07 Overview section renderer.
 *
 * Pure HTML renderer for the Admin Overview pane (usage rollup + audit
 * events + operational health). Consumes the fetcher's discriminated
 * `OverviewFetchResult` and emits a fully-escaped, XHTML-friendly form
 * that the shell splices at `</section></main>`.
 *
 * Hard rules:
 * - Usage rows: provider + model + ops + input/output tokens + pages +
 *   cost + measurement badge — never raw prompt text, never raw
 *   provider error bodies, never any header / credential material.
 * - Audit events: kind + severity + timestamp + tenant + resource +
 *   actor + message. The actor field is a stable identifier
 *   (`'system'`, `'admin:<bearer>'`, or an API key id) — never a raw
 *   bearer token or credential.
 * - Health overview reuses `GET /api/v1/health` verbatim: the renderer
 *   only paints the badges / labels derived from `status`, `db`,
 *   `redis`, `activeLeases`. No parallel schema is invented.
 *
 * Strict TypeScript, zero `any`. Every value flowing into HTML goes
 * through `esc()`.
 */

import { esc } from './shell-render';
import type {
  OverviewFetchResult,
  OverviewOkResult,
  OverviewBundle,
  OverviewTenantOption,
  OverviewTriageMetric,
  OverviewTriageSnapshot,
  OverviewTimePreset,
} from './overview-section-data';
import type {
  AuditEventView,
  AuditListView,
  HealthOverviewView,
  UsageRollupRow,
  UsageRollupView,
} from './overview-view-models';

export interface OverviewSectionRenderInput {
  fetch: OverviewFetchResult;
  selectedTenantId?: string;
  selectedTimePreset?: OverviewTimePreset;
}

export interface OverviewSectionRenderOutput {
  html: string;
  isReady: boolean;
}

function badgeClass(badge: 'success' | 'error' | 'warning' | 'neutral'): string {
  return `status-badge status-badge--${badge}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('en-US');
}

function formatMicrousd(value: number): string {
  const dollars = value / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}

function renderUsageTable(usage: UsageRollupView): string {
  if (usage.rows.length === 0) {
    return [
      '<section class="overview-section__usage overview-section__usage--empty" data-usage-total="0">',
      '<header><h3>Usage</h3></header>',
      '<p class="overview-section__usage-empty">No usage was recorded in this window.</p>',
      '</section>',
    ].join('');
  }
  const rows = usage.rows.map(renderUsageRow).join('');
  const t = usage.totals;
  return [
    '<section class="overview-section__usage"',
    `data-usage-total="${usage.rows.length.toString()}"`,
    `data-usage-tenant="${esc(usage.tenantId)}"`,
    `data-usage-from="${esc(usage.from)}"`,
    `data-usage-to="${esc(usage.to)}"`,
    '>',
    '<header><h3>Usage</h3>',
    '<p class="overview-section__usage-window" data-usage-window="true">',
    `Tenant <span data-usage-tenant="${esc(usage.tenantId)}">${esc(usage.tenantId)}</span> · `,
    `Window <span data-usage-from="${esc(usage.from)}">${esc(usage.from)}</span> → `,
    `<span data-usage-to="${esc(usage.to)}">${esc(usage.to)}</span>`,
    '</p>',
    '</header>',
    '<table class="overview-section__usage-table"><thead><tr>',
    '<th>Provider</th><th>Model</th><th>Ops</th><th>Input tokens</th><th>Output tokens</th>',
    '<th>Pages</th><th>Cost</th><th>Measurement</th>',
    `</tr></thead><tbody>${rows}</tbody>`,
    '<tfoot><tr>',
    '<th>Totals</th><td></td>',
    `<td data-usage-totals-ops="${formatNumber(t.operations)}">${formatNumber(t.operations)}</td>`,
    `<td data-usage-totals-input="${formatNumber(t.inputTokens)}">${formatNumber(t.inputTokens)}</td>`,
    `<td data-usage-totals-output="${formatNumber(t.outputTokens)}">${formatNumber(t.outputTokens)}</td>`,
    `<td data-usage-totals-pages="${formatNumber(t.pages)}">${formatNumber(t.pages)}</td>`,
    `<td data-usage-totals-cost="${esc(formatMicrousd(t.costMicrousd))}">${esc(formatMicrousd(t.costMicrousd))}</td>`,
    '<td></td>',
    '</tr></tfoot>',
    '</table>',
    '</section>',
  ].join('');
}

export function renderUsageRow(r: UsageRollupRow): string {
  return [
    '<tr class="overview-section__usage-row"',
    `data-usage-row="${esc(r.provider)}|${esc(r.model)}"`,
    `data-usage-provider="${esc(r.provider)}"`,
    `data-usage-model="${esc(r.model)}"`,
    `data-usage-measurement="${esc(r.measurement)}"`,
    '>',
    `<td data-usage-provider-cell="${esc(r.provider)}">${esc(r.provider)}</td>`,
    `<td data-usage-model-cell="${esc(r.model)}">${esc(r.model)}</td>`,
    `<td data-usage-ops-cell="${formatNumber(r.operations)}">${formatNumber(r.operations)}</td>`,
    `<td data-usage-input-cell="${formatNumber(r.inputTokens)}">${formatNumber(r.inputTokens)}</td>`,
    `<td data-usage-output-cell="${formatNumber(r.outputTokens)}">${formatNumber(r.outputTokens)}</td>`,
    `<td data-usage-pages-cell="${formatNumber(r.pages)}">${formatNumber(r.pages)}</td>`,
    `<td data-usage-cost-cell="${esc(formatMicrousd(r.costMicrousd))}">${esc(formatMicrousd(r.costMicrousd))}</td>`,
    '<td>',
    `<span class="${esc(badgeClass(r.measurementBadge))}" data-usage-measurement-badge="${esc(r.measurementBadge)}">${esc(r.measurementLabel)}</span>`,
    '</td>',
    '</tr>',
  ].join('');
}

function renderAuditTable(audit: AuditListView): string {
  if (audit.events.length === 0) {
    return [
      '<section class="overview-section__audit overview-section__audit--empty" data-audit-total="0">',
      '<header><h3>Audit</h3></header>',
      '<p class="overview-section__audit-empty">No audit events were recorded for this tenant in the window.</p>',
      '</section>',
    ].join('');
  }
  const rows = audit.events.map(renderAuditRow).join('');
  const kinds = audit.kinds.map(esc).join(' ');
  const severities = audit.severities.map(esc).join(' ');
  return [
    '<section class="overview-section__audit"',
    `data-audit-total="${audit.events.length.toString()}"`,
    `data-audit-tenant="${esc(audit.tenantId)}"`,
    `data-audit-kinds="${esc(kinds)}"`,
    `data-audit-severities="${esc(severities)}"`,
    '>',
    '<header><h3>Audit</h3>',
    '<p class="overview-section__audit-tenant" data-audit-tenant-label="true">',
    `Tenant <span data-audit-tenant="${esc(audit.tenantId)}">${esc(audit.tenantId)}</span>`,
    '</p>',
    '</header>',
    '<table class="overview-section__audit-table"><thead><tr>',
    '<th>Kind</th><th>Severity</th><th>Occurred</th><th>Resource</th><th>Actor</th><th>Message</th>',
    `</tr></thead><tbody>${rows}</tbody></table>`,
    '</section>',
  ].join('');
}

export function renderAuditRow(e: AuditEventView): string {
  return [
    '<tr class="overview-section__audit-row"',
    `data-audit-id="${esc(e.id)}"`,
    `data-audit-kind="${esc(e.kind)}"`,
    `data-audit-severity="${esc(e.severity)}"`,
    '>',
    `<td data-audit-kind-cell="${esc(e.kind)}">${esc(e.kindLabel)}</td>`,
    `<td><span class="${esc(badgeClass(e.severityBadge))}" data-audit-severity-badge="${esc(e.severityBadge)}">${esc(e.severity)}</span></td>`,
    `<td data-audit-occurred="${esc(e.occurredAt)}">${esc(e.occurredAt)}</td>`,
    `<td data-audit-resource="${esc(e.resourceId)}">${esc(e.resourceId)}</td>`,
    `<td data-audit-actor="${esc(e.actor)}">${esc(e.actor)}</td>`,
    `<td data-audit-message="${esc(e.message)}">${esc(e.message)}</td>`,
    '</tr>',
  ].join('');
}

function renderHealthPanel(health: HealthOverviewView, serverNow: string): string {
  return [
    '<section class="overview-section__health"',
    `data-health-status="${esc(health.status)}"`,
    `data-health-fully-healthy="${health.fullyHealthy ? 'true' : 'false'}"`,
    '>',
    '<header><h3>Health</h3>',
    `<p class="overview-section__health-as-of" data-health-as-of="${esc(serverNow)}">`,
    `As of <span data-health-now="${esc(serverNow)}">${esc(serverNow)}</span>`,
    '</p>',
    '</header>',
    '<dl class="overview-section__health-list">',
    '<dt>Overall</dt><dd>',
    `<span class="${esc(badgeClass(health.badge))}" data-health-overall="${esc(health.status)}">${esc(health.statusLabel)}</span>`,
    '</dd>',
    '<dt>Database</dt><dd>',
    `<span class="${esc(badgeClass(health.dbBadge))}" data-health-db="${health.db ? 'true' : 'false'}">${esc(health.dbLabel)}</span>`,
    '</dd>',
    '<dt>Redis</dt><dd>',
    `<span class="${esc(badgeClass(health.redisBadge))}" data-health-redis="${health.redis ? 'true' : 'false'}">${esc(health.redisLabel)}</span>`,
    '</dd>',
    `<dt>Active leases</dt><dd data-health-leases="${health.activeLeases.toString()}">${formatNumber(health.activeLeases)}</dd>`,
    '</dl>',
    '</section>',
  ].join('');
}

function unavailableTriage(serverNow: string): OverviewTriageSnapshot {
  const metric: OverviewTriageMetric = {
    status: 'unavailable',
    value: null,
    detail: 'Source unavailable.',
  };
  return {
    failed: metric,
    timedOut: metric,
    pending: metric,
    queueLag: metric,
    connectorDegradations: metric,
    updatedAt: serverNow,
  };
}

function operationListHref(state: string, tenantId: string): string {
  const query = new URLSearchParams({ state });
  if (tenantId.length > 0) query.set('tenant', tenantId);
  return `/admin/operations?${query.toString()}`;
}

function renderTriageMetric(
  name: string,
  label: string,
  metric: OverviewTriageMetric,
  href?: string,
  actionLabel = `View ${label.toLowerCase()}`,
): string {
  const value = metric.status === 'unavailable' || metric.value === null
    ? 'Unavailable'
    : formatNumber(metric.value);
  const statusLabel = metric.status === 'available'
    ? 'Current'
    : metric.status === 'stale'
      ? 'Stale snapshot'
      : 'Source unavailable';
  const valueHtml = href && metric.status !== 'unavailable'
    ? `<a class="overview-section__metric-link" href="${esc(href)}" aria-label="${esc(actionLabel)}">${esc(value)}</a>`
    : `<span class="overview-section__metric-value">${esc(value)}</span>`;
  return [
    `<article class="overview-section__metric overview-section__metric--${esc(metric.status)}" data-overview-metric="${esc(name)}" data-metric-status="${esc(metric.status)}">`,
    `<h3>${esc(label)}</h3>`,
    `<p class="overview-section__metric-value-row">${valueHtml}</p>`,
    `<p class="overview-section__metric-status">${esc(statusLabel)}</p>`,
    metric.detail ? `<p class="overview-section__metric-detail">${esc(metric.detail)}</p>` : '',
    metric.sourceUpdatedAt
      ? `<p class="overview-section__metric-updated">Source updated <time datetime="${esc(metric.sourceUpdatedAt)}">${esc(metric.sourceUpdatedAt)}</time> UTC</p>`
      : '',
    '</article>',
  ].join('');
}

function renderOverviewFilters(
  tenantId: string,
  timePreset: OverviewTimePreset,
  from: string,
  to: string,
  tenantOptions: readonly OverviewTenantOption[],
): string {
  const presets: Array<[OverviewTimePreset, string]> = [
    ['today', 'Today (UTC)'],
    ['24h', 'Last 24 hours (UTC)'],
    ['7d', 'Last 7 days (UTC)'],
    ['custom', 'Custom UTC window'],
  ];
  const options = presets.map(([value, label]) =>
    `<option value="${value}"${timePreset === value ? ' selected' : ''}>${label}</option>`,
  ).join('');
  // F-2: roster-backed picker. Option labels are tenant NAMES; the id is a
  // value only. The placeholder stays selected whenever the current tenant is
  // not in the roster, so a failed roster read can never silently re-point the
  // filter at a different tenant on submit.
  const inRoster = tenantOptions.some((tenant) => tenant.id === tenantId);
  const tenantChoices = [
    `<option value=""${inRoster ? '' : ' selected'}>Select a tenant</option>`,
    ...tenantOptions.map((tenant) => {
      const label = tenant.state.length === 0 || tenant.state === 'ACTIVE'
        ? tenant.name
        : `${tenant.name} (${tenant.state})`;
      return `<option value="${esc(tenant.id)}"${tenant.id === tenantId ? ' selected' : ''}>${esc(label)}</option>`;
    }),
  ].join('');
  return [
    '<form class="overview-section__filters" method="get" action="/admin" aria-label="Overview filters">',
    '<label>Tenant',
    `<select name="tenantId" aria-label="Tenant">${tenantChoices}</select>`,
    '</label>',
    '<label>Time window',
    `<select name="timeRange" aria-label="Overview time window">${options}</select>`,
    '</label>',
    timePreset === 'custom' ? `<input type="hidden" name="from" value="${esc(from)}">` : '',
    timePreset === 'custom' ? `<input type="hidden" name="to" value="${esc(to)}">` : '',
    '<button type="submit">Apply</button>',
    '<a class="overview-section__clear" href="/admin">Clear filters</a>',
    '</form>',
  ].join('');
}

function renderTriagePanel(
  triage: OverviewTriageSnapshot,
  tenantId: string,
  timePreset: OverviewTimePreset,
  from: string,
  to: string,
  tenantOptions: readonly OverviewTenantOption[],
): string {
  return [
    renderOverviewFilters(tenantId, timePreset, from, to, tenantOptions),
    '<section class="overview-section__triage" aria-label="Operational triage metrics" data-overview-triage="true">',
    '<header class="overview-section__triage-header"><h2>Operational triage</h2>',
    `<p class="overview-section__updated" data-overview-updated-at="${esc(triage.updatedAt)}">Updated <time datetime="${esc(triage.updatedAt)}">${esc(triage.updatedAt)}</time> UTC</p>`,
    '</header>',
    '<div class="overview-section__metrics">',
    renderTriageMetric('failed', 'Failed operations', triage.failed, operationListHref('FAILED', tenantId)),
    renderTriageMetric('timed-out', 'Timed out', triage.timedOut, operationListHref('TIMED_OUT', tenantId)),
    renderTriageMetric('pending', 'Pending / active', triage.pending, operationListHref('RUNNING', tenantId)),
    renderTriageMetric(
      'queue-lag',
      'Stalled dispatches',
      triage.queueLag,
      operationListHref('RUNNING', tenantId),
      'Review active operations',
    ),
    renderTriageMetric('connector-degradations', 'Connector degradations', triage.connectorDegradations),
    '</div>',
    '<p class="overview-section__triage-scope">Operation counts are live state totals for the selected tenant. The UTC preset filters usage; audit shows the latest tenant-scoped page because its API has no time filter. Queue and connector health are point-in-time signals.</p>',
    '</section>',
  ].join('');
}

function renderBundle(
  bundle: OverviewBundle,
  tenantId: string,
  from: string,
  to: string,
  timePreset: OverviewTimePreset,
  tenantOptions: readonly OverviewTenantOption[],
  tenantRequired: boolean,
): string {
  const sections: string[] = [];
  sections.push(
    '<header class="overview-section__header">',
    '<h2 class="overview-section__title">Overview</h2>',
    '<p class="overview-section__scope" data-overview-scope="true">',
    `Tenant <span data-overview-tenant="${esc(tenantId)}">${esc(tenantId)}</span> · `,
    `Window <span data-overview-from="${esc(from)}">${esc(from)}</span> → `,
    `<span data-overview-to="${esc(to)}">${esc(to)}</span>`,
    '</p>',
    '</header>',
  );
  sections.push(
    renderTriagePanel(
      bundle.triage ?? unavailableTriage(bundle.serverNow),
      tenantId,
      timePreset,
      from,
      to,
      tenantOptions,
    ),
  );
  if (tenantRequired) {
    sections.push(
      '<p class="overview-section__tenant-required" data-overview-tenant-required="true">',
      'Select a tenant',
      '</p>',
    );
  }
  if (bundle.usage !== null) {
    sections.push(renderUsageTable(bundle.usage));
  }
  if (bundle.audit !== null) {
    sections.push(renderAuditTable(bundle.audit));
  }
  if (bundle.health !== null) {
    sections.push(renderHealthPanel(bundle.health, bundle.serverNow));
  }
  if (!tenantRequired && bundle.usage === null && bundle.audit === null && bundle.health === null) {
    sections.push(
      '<p class="overview-section__empty" data-overview-empty="true">',
      'No overview data is currently available from the platform.',
      '</p>',
    );
  }
  return sections.join('');
}

function renderOkRoot(
  ok: OverviewOkResult,
  selectedTenantId: string,
  timePreset: OverviewTimePreset,
): string {
  const triage = ok.bundle.triage ?? unavailableTriage(ok.bundle.serverNow);
  return [
    '<section class="overview-section"',
    `data-overview-tenant="${esc(ok.tenantId)}"`,
    `data-overview-from="${esc(ok.from)}"`,
    `data-overview-to="${esc(ok.to)}"`,
    `data-overview-usage-available="${ok.bundle.usage !== null ? 'true' : 'false'}"`,
    `data-overview-audit-available="${ok.bundle.audit !== null ? 'true' : 'false'}"`,
    `data-overview-health-available="${ok.bundle.health !== null ? 'true' : 'false'}"`,
    `data-overview-failed-available="${triage.failed.status !== 'unavailable' ? 'true' : 'false'}"`,
    `data-overview-pending-available="${triage.pending.status !== 'unavailable' ? 'true' : 'false'}"`,
    `data-overview-tenant-selected="${esc(selectedTenantId)}"`,
    '>',
    renderBundle(
      ok.bundle,
      ok.tenantId,
      ok.from,
      ok.to,
      timePreset,
      ok.tenantOptions ?? [],
      ok.tenantRequired === true,
    ),
    '</section>',
  ].join('');
}

function renderFallbackRoot(
  kind: 'empty' | 'unauthorized' | 'error',
  message: string,
  tenantId: string,
  from: string,
  to: string,
  triage: OverviewTriageSnapshot,
  timePreset: OverviewTimePreset,
  tenantOptions: readonly OverviewTenantOption[],
): string {
  return [
    `<section class="overview-section overview-section--${kind}" data-overview-tenant="${esc(tenantId)}" data-overview-from="${esc(from)}" data-overview-to="${esc(to)}">`,
    '<header class="overview-section__header"><h2 class="overview-section__title">Overview</h2></header>',
    renderTriagePanel(triage, tenantId, timePreset, from, to, tenantOptions),
    `<p class="overview-section__${kind}" data-${kind}-message="true">${esc(message)}</p>`,
    '</section>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderOverviewSection(
  input: OverviewSectionRenderInput,
): OverviewSectionRenderOutput {
  const f = input.fetch;
  const timePreset: OverviewTimePreset = input.selectedTimePreset ?? 'today';
  // F-2: the roster travels with the result so the picker renders in every
  // pane (ok and fallback alike); a result without one renders an empty picker.
  const tenantOptions: readonly OverviewTenantOption[] = f.tenantOptions ?? [];
  switch (f.kind) {
    case 'ok':
      return {
        html: renderOkRoot(f, input.selectedTenantId ?? f.tenantId, timePreset),
        isReady: true,
      };
    case 'empty':
      return {
        html: renderFallbackRoot(
          'empty',
          f.message,
          input.selectedTenantId ?? f.tenantId ?? '',
          f.from ?? '',
          f.to ?? '',
          f.triage ?? unavailableTriage(new Date().toISOString()),
          timePreset,
          tenantOptions,
        ),
        isReady: false,
      };
    case 'unauthorized':
      return {
        html: renderFallbackRoot(
          'unauthorized',
          f.message,
          input.selectedTenantId ?? f.tenantId ?? '',
          f.from ?? '',
          f.to ?? '',
          f.triage ?? unavailableTriage(new Date().toISOString()),
          timePreset,
          tenantOptions,
        ),
        isReady: false,
      };
    case 'error':
      return {
        html: renderFallbackRoot(
          'error',
          f.message,
          input.selectedTenantId ?? f.tenantId ?? '',
          f.from ?? '',
          f.to ?? '',
          f.triage ?? unavailableTriage(new Date().toISOString()),
          timePreset,
          tenantOptions,
        ),
        isReady: false,
      };
  }
}

export const __test = {
  renderUsageRow,
  renderAuditRow,
};
