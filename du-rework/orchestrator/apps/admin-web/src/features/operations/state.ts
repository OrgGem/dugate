/** Runtime parsing for operations list/detail (tolerant, unknown → typed). */
import type {
  OperationArtifactWire,
  OperationDetail,
  OperationsPage,
  OperationWire,
} from '@/lib/api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseOperationWire(value: unknown): OperationWire | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const state = str(value['state']);
  if (id === null || state === null) return null;
  return {
    id,
    state,
    tenantId: str(value['tenantId'] ?? value['tenant_id']),
    businessId: str(value['businessId'] ?? value['business_id']),
    action: str(value['action']),
    createdAt: str(value['createdAt'] ?? value['created_at']),
    updatedAt: str(value['updatedAt'] ?? value['updated_at']),
    startedAt: str(value['startedAt']), completedAt: str(value['completedAt']),
    retryOf: str(value['retryOf']), errorCode: str(value['errorCode']), deadlineAt: str(value['deadlineAt']),
  };
}

export function parseOperationsPage(value: unknown): OperationsPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items = value['items'].map(parseOperationWire).filter((op): op is OperationWire => op !== null);
  return {
    items,
    total: typeof value['total'] === 'number' ? value['total'] : items.length,
    limit: typeof value['limit'] === 'number' ? value['limit'] : items.length,
    nextCursor: str(value['nextCursor']),
    prevCursor: str(value['prevCursor']),
  };
}

export function parseOperationDetail(value: unknown): OperationDetail | null {
  if (!isRecord(value)) return null;
  const operation = parseOperationWire(value['operation'] ?? value);
  const artifactsRaw = Array.isArray(value['artifacts']) ? value['artifacts'] : [];
  const artifacts: OperationArtifactWire[] = [];
  for (const raw of artifactsRaw) {
    if (!isRecord(raw)) continue;
    const st = str(raw['status'] ?? raw['state']);
    artifacts.push({
      role: str(raw['role']) ?? 'output',
      status: st ?? (raw['download'] || raw['downloadUrl'] ? 'READY' : '—'),
      downloadUrl: str(raw['downloadUrl'] ?? raw['download']),
      contentType: str(raw['contentType'] ?? raw['mimeType']),
    });
  }
  const result = value['result'];
  const input = value['requestInput'];
  return {
    operation: operation ?? null,
    tasks: Array.isArray(value['tasks']) ? value['tasks'].filter(isRecord).map(task => ({
      id: str(task['id']) ?? '', taskKey: str(task['taskKey']) ?? '', kind: str(task['kind']) ?? '',
      state: str(task['state']) ?? '', attempt: typeof task['attempt'] === 'number' ? task['attempt'] : 0,
      maxAttempts: typeof task['maxAttempts'] === 'number' ? task['maxAttempts'] : 0, errorCode: str(task['errorCode']),
    })) : [],
    ...(isRecord(input) && ['REDACTED', 'NO_RULES', 'HIDDEN'].includes(String(input['status'])) ? {
      requestInput: { data: input['data'], status: input['status'] as 'REDACTED' | 'NO_RULES' | 'HIDDEN',
        ruleCount: typeof input['ruleCount'] === 'number' ? input['ruleCount'] : 0 },
    } : {}),
    resultSummary: result === undefined || result === null ? null : JSON.stringify(result, null, 2),
    artifacts,
    serverNow: str(value['serverNow']),
    raw: value,
  };
}

export function operationStateVariant(state: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  const value = state.toUpperCase();
  if (value === 'SUCCEEDED') return 'success';
  if (value === 'FAILED' || value === 'CANCELLED' || value === 'TIMED_OUT') return 'danger';
  if (value === 'WAITING_INPUT') return 'warning';
  if (value === 'RUNNING' || value === 'QUEUED' || value === 'DISPATCHING') return 'info';
  return 'neutral';
}

/** End-to-end includes queue/waits. Execution elapsed begins at first RUNNING.
 * Terminal rows without recorded completion stay unknown; never use updatedAt. */
export function elapsedMs(op: OperationWire, now: string, execution = false): number | null {
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(op.state);
  const start = execution ? op.startedAt : op.createdAt;
  const end = terminal ? op.completedAt : now;
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
