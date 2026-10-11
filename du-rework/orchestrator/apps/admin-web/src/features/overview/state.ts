/**
 * Overview screen wire parsing + state mapping (AWEB-03b).
 *
 * Pure, typed helpers only — every value that crosses the BFF boundary is
 * validated before it reaches the UI, and the loadable → pane-state mapping
 * is a plain function so the screen stays a thin composition.
 */
import type { AdminApiProblem } from '@/lib/api';

export type Loadable<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'failed'; problem: AdminApiProblem };

export type PaneState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'empty' }
  | { kind: 'denied'; problem: AdminApiProblem }
  | { kind: 'error'; problem: AdminApiProblem };

export interface AuditEventWire {
  id: string;
  kind: string;
  severity: string;
  occurredAt: string;
  tenantId: string | null;
  resourceId: string;
  actor: string;
  message: string;
}

export interface AuditListPage {
  items: AuditEventWire[];
  total: number;
  limit: number;
}

export interface OperationsMetricsSnapshot {
  from: string;
  to: string;
  tenantId: string | null;
  total: number;
  success: number;
  failure: number;
  cancelled: number;
  timedOut: number;
  running: number;
  durationSamples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  sampledAt: string;
  stale: boolean;
}

export interface OperationsMetricsExpectation {
  from: string;
  to: string;
  tenantId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Runtime validation of the audit list page (unknown → typed or null). */
export function parseAuditPage(value: unknown): AuditListPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: AuditEventWire[] = [];
  for (const raw of value['items']) {
    if (!isRecord(raw)) continue;
    const id = readString(raw['id']);
    const kind = readString(raw['kind']);
    const severity = readString(raw['severity']);
    const occurredAt = readString(raw['occurredAt']);
    const message = readString(raw['message']);
    const resourceId = readString(raw['resourceId']);
    const actor = readString(raw['actor']);
    if (id === null || kind === null || occurredAt === null) continue;
    items.push({
      id,
      kind,
      severity: severity ?? 'info',
      occurredAt,
      tenantId: readString(raw['tenantId']),
      resourceId: resourceId ?? '',
      actor: actor ?? '',
      message: message ?? kind,
    });
  }
  return {
    items,
    total: typeof value['total'] === 'number' ? value['total'] : items.length,
    limit: typeof value['limit'] === 'number' ? value['limit'] : items.length,
  };
}

/** Validate the tenant/window echo so an out-of-order response cannot replace current Overview metrics. */
export function parseOperationsMetrics(
  value: unknown,
  expected: OperationsMetricsExpectation,
): OperationsMetricsSnapshot | null {
  if (!isRecord(value)) return null;
  const tenantId = value['tenantId'] === null ? null : readString(value['tenantId']);
  const total = readMetricCount(value['total']);
  const success = readMetricCount(value['success']);
  const failure = readMetricCount(value['failure']);
  const cancelled = readMetricCount(value['cancelled']);
  const timedOut = readMetricCount(value['timedOut']);
  const running = readMetricCount(value['running']);
  const durationSamples = readMetricCount(value['durationSamples']);
  const p50Ms = readMetricDuration(value['p50Ms']);
  const p95Ms = readMetricDuration(value['p95Ms']);
  const from = readString(value['from']);
  const to = readString(value['to']);
  const sampledAt = readString(value['sampledAt']);
  if (
    (tenantId === null && value['tenantId'] !== null) ||
    total === null || success === null || failure === null || cancelled === null ||
    timedOut === null || running === null || durationSamples === null ||
    p50Ms === undefined || p95Ms === undefined ||
    from !== expected.from || to !== expected.to || tenantId !== expected.tenantId ||
    sampledAt === null || Number.isNaN(Date.parse(sampledAt)) || typeof value['stale'] !== 'boolean'
  ) {
    return null;
  }
  if (success + failure + cancelled + timedOut + running !== total) return null;
  if (durationSamples > total || (durationSamples === 0) !== (p50Ms === null)) return null;
  if (p50Ms !== null && p95Ms !== null && p50Ms > p95Ms) return null;
  if ((p50Ms === null) !== (p95Ms === null)) return null;
  return {
    from,
    to,
    tenantId,
    total,
    success,
    failure,
    cancelled,
    timedOut,
    running,
    durationSamples,
    p50Ms,
    p95Ms,
    sampledAt,
    stale: value['stale'],
  };
}

function readMetricCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** undefined means invalid; null is a valid empty latency distribution. */
function readMetricDuration(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Loadable → contract pane state, with `denied` reserved for 403. */
export function paneStateFrom<T>(loadable: Loadable<T>, isEmpty?: (data: T) => boolean): PaneState<T> {
  if (loadable.kind === 'loading') return { kind: 'loading' };
  if (loadable.kind === 'ready') {
    if (isEmpty !== undefined && isEmpty(loadable.data)) return { kind: 'empty' };
    return { kind: 'ready', data: loadable.data };
  }
  if (loadable.problem.status === 403) return { kind: 'denied', problem: loadable.problem };
  return { kind: 'error', problem: loadable.problem };
}

export function severityVariant(severity: string): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  const value = severity.toLowerCase();
  if (value === 'critical' || value === 'error') return 'danger';
  if (value === 'warning') return 'warning';
  if (value === 'info') return 'info';
  if (value === 'debug') return 'neutral';
  return 'neutral';
}
