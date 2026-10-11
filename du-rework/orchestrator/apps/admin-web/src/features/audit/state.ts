export type AuditSeverity = 'info' | 'success' | 'warning' | 'error';

export interface AuditEvent {
  id: string;
  kind: string;
  severity: string;
  occurredAt: string;
  tenantId: string | null;
  resourceId: string;
  actor: string;
}

export interface AuditPage {
  items: AuditEvent[];
  total: number;
  limit: number;
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface AppliedAuditFilters {
  severity: 'ALL' | AuditSeverity;
  action: string;
  actor: string;
  resource: string;
  from: string;
  to: string;
  sort: 'createdAt:asc' | 'createdAt:desc';
  limit: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function cursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Validate the BFF page envelope and project only fields used by this screen. */
export function parseAuditPage(value: unknown): AuditPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;

  const items: AuditEvent[] = [];
  for (const raw of value['items']) {
    if (!isRecord(raw)) continue;
    const id = text(raw['id']);
    const kind = text(raw['kind']);
    const occurredAt = text(raw['occurredAt']);
    if (id === null || kind === null || occurredAt === null) continue;
    items.push({
      id,
      kind,
      occurredAt,
      severity: text(raw['severity']) ?? 'unknown',
      tenantId: text(raw['tenantId']),
      resourceId: text(raw['resourceId']) ?? '',
      actor: text(raw['actor']) ?? '',
    });
  }

  return {
    items,
    total: typeof value['total'] === 'number' && Number.isSafeInteger(value['total']) && value['total'] >= 0
      ? value['total']
      : items.length,
    limit: typeof value['limit'] === 'number' && Number.isSafeInteger(value['limit']) && value['limit'] > 0
      ? value['limit']
      : items.length,
    nextCursor: cursor(value['nextCursor']),
    prevCursor: cursor(value['prevCursor']),
  };
}

export interface AuditQueryInput {
  tenantId: string;
  cursor: string | null;
  filters: AppliedAuditFilters;
}

/** Build the exact server-side BFF query. The tenant comes from active scope. */
export function buildAuditQuery(input: AuditQueryInput): Record<string, string> {
  const query: Record<string, string> = {
    tenantId: input.tenantId,
    limit: input.filters.limit,
    sort: input.filters.sort,
  };
  if (input.cursor !== null) query['cursor'] = input.cursor;
  if (input.filters.severity !== 'ALL') query['severity'] = input.filters.severity;
  if (input.filters.action.trim() !== '') query['action'] = input.filters.action.trim();
  if (input.filters.actor.trim() !== '') query['actor'] = input.filters.actor.trim();
  if (input.filters.resource.trim() !== '') query['resource'] = input.filters.resource.trim();
  if (input.filters.from !== '') query['from'] = input.filters.from;
  if (input.filters.to !== '') query['to'] = input.filters.to;
  return query;
}

/** Convert a browser-local datetime-local field into the API's UTC instant. */
export function localDateTimeToUtc(value: string): string | null {
  if (value === '') return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/** Escape one cell for RFC 4180 CSV and neutralize spreadsheet formulas. */
function csvCell(value: string): string {
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Export the visible page only. The allowlist deliberately omits message and
 * arbitrary payload fields; each cell is CSV-escaped and formula-neutralized.
 */
export function buildAuditCsv(items: readonly AuditEvent[], activeTenantId: string): string {
  const rows = [
    ['occurred_at', 'severity', 'action', 'actor', 'resource', 'tenant_id', 'event_id'],
    ...items.map((event) => [
      event.occurredAt,
      event.severity,
      event.kind,
      event.actor,
      event.resourceId,
      event.tenantId ?? activeTenantId,
      event.id,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function severityVariant(severity: string): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  switch (severity.toLowerCase()) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'error':
    case 'critical': return 'danger';
    case 'info': return 'info';
    default: return 'neutral';
  }
}
