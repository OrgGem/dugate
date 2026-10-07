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
