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
  const progressValue = value['progress'];
  const progress = isRecord(progressValue)
    && typeof progressValue['percent'] === 'number'
    && Number.isFinite(progressValue['percent'])
    && progressValue['percent'] >= 0 && progressValue['percent'] <= 100
    ? { percent: progressValue['percent'], ...(str(progressValue['message']) === null ? {} : { message: str(progressValue['message'])! }) }
    : undefined;
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
    ...(progress ? { progress } : {}),
  };
}

/**
 * HONESTY-AUDIT-OPS: a parsed page plus the one fact the wire type cannot
 * carry — whether the server actually SENT a total. The wire type requires a
 * number, so the parser fills items.length as a placeholder; that placeholder
 * must never be RENDERED as a total, or a truncated page reads as the whole
 * population (it is wrong whenever nextCursor is present).
 */
export interface ParsedOperationsPage extends OperationsPage {
  readonly totalFromServer: boolean;
}

export function parseOperationsPage(value: unknown): ParsedOperationsPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items = value['items'].map(parseOperationWire).filter((op): op is OperationWire => op !== null);
  const serverTotal = typeof value['total'] === 'number' ? value['total'] : null;
  return {
    items,
    total: serverTotal ?? items.length,
    totalFromServer: serverTotal !== null,
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
      state: str(task['state']) ?? '', spawnedBy: str(task['spawnedBy']), leasedBy: str(task['leasedBy']),
      ...(Object.hasOwn(task, 'admissionParkedReason') ? { admissionParkedReason: str(task['admissionParkedReason']) } : {}),
      ...(Object.hasOwn(task, 'admissionParkedAt') ? { admissionParkedAt: str(task['admissionParkedAt']) } : {}),
      leaseExpiresAt: str(task['leaseExpiresAt']), dueAt: str(task['dueAt']),
      awaitedChildren: parseTaskLinks(task['awaitedChildren']),
      attempt: typeof task['attempt'] === 'number' ? task['attempt'] : 0,
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

function parseTaskLinks(value: unknown): Array<{ taskId: string; joinPolicy: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((row) => {
    const taskId = str(row['taskId']);
    const joinPolicy = str(row['joinPolicy']);
    return taskId !== null && joinPolicy !== null ? [{ taskId, joinPolicy }] : [];
  });
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

export interface OperationsFilterInput {
  limit: string;
  state: string;
  sort: string;
  tenantId: string | null;
  id: string;
  business: string;
  action: string;
  apiKey: string;
  profile: string;
  correlation: string;
  provider: string;
  model: string;
  usage: 'any' | 'has-recorded-usage' | 'no-recorded-usage';
  reservation: 'any' | 'unknown';
  attention: 'any' | 'waiting-input';
  cursor: string | null;
  /** A date-input value: an ISO day (YYYY-MM-DD) or empty. */
  fromDate: string;
  toDate: string;
}

/**
 * AWEB-20a: the date pickers stay inclusive UTC DAYS - the same mental model
 * the previous client-side trim had - but the wire wants a UTC instant, so a
 * start day opens at 00:00:00.000Z and an end day closes at 23:59:59.999Z.
 * `null` means no bound on this side, which must stay absent from the query
 * rather than being sent as an empty string (the route answers 422 on an
 * instant it cannot parse).
 */
export function operationsTimeWindow(
  fromDate: string,
  toDate: string,
): { from: string | null; to: string | null } {
  return {
    from: fromDate === '' ? null : `${fromDate}T00:00:00.000Z`,
    to: toDate === '' ? null : `${toDate}T23:59:59.999Z`,
  };
}

/**
 * True when the operator picked a start day AFTER the end day. Answered
 * locally so the list keeps the last good page instead of swapping the whole
 * table for the route's 422.
 */
export function operationsWindowInvalid(fromDate: string, toDate: string): boolean {
  return fromDate !== '' && toDate !== '' && fromDate > toDate;
}

/**
 * Build the exact server-side BFF query. `from`/`to` are SENT so the route
 * filters rows in SQL: trimming the page in the browser hid matching rows that
 * simply were not on the page that had been loaded, and made the advertised
 * `total` disagree with what the table showed.
 */
export function buildOperationsQuery(input: OperationsFilterInput): Record<string, string> {
  const query: Record<string, string> = { limit: input.limit, sort: input.sort };
  if (input.state !== '' && input.state !== 'ALL') query['state'] = input.state;
  if (input.tenantId !== null && input.tenantId !== '') query['tenant'] = input.tenantId;
  const id = input.id.trim();
  if (id !== '') query['id'] = id;
  const textFilters: Array<[string, string]> = [
    ['business', input.business], ['action', input.action], ['apiKey', input.apiKey],
    ['profile', input.profile], ['correlation', input.correlation],
    ['provider', input.provider], ['model', input.model],
  ];
  for (const [name, value] of textFilters) {
    const normalized = value.trim();
    if (normalized !== '') query[name] = normalized;
  }
  if (input.usage !== 'any') query['usage'] = input.usage;
  if (input.reservation !== 'any') query['reservation'] = input.reservation;
  if (input.attention !== 'any') query['attention'] = input.attention;
  if (input.cursor !== null && input.cursor !== '') query['cursor'] = input.cursor;
  const window = operationsTimeWindow(input.fromDate, input.toDate);
  if (window.from !== null) query['from'] = window.from;
  if (window.to !== null) query['to'] = window.to;
  return query;
}

/** The inputs that decide WHICH rows the query returns. */
export type OperationsPopulation = Pick<
  OperationsFilterInput,
  | 'state' | 'sort' | 'tenantId' | 'id' | 'business' | 'action' | 'apiKey'
  | 'profile' | 'correlation' | 'provider' | 'model' | 'usage' | 'reservation'
  | 'attention' | 'fromDate' | 'toDate' | 'limit'
>;

/**
 * AWEB-20: a keyset cursor addresses a position inside ONE population. The
 * token carries only `createdAt|id|sort|direction`
 * (modules/operations/list-query.ts encodeOperationsListCursor), so the route
 * cannot tell it was minted under another tenant, state, id filter, window or
 * page size: it then seeks the NEW population from the OLD position and
 * silently skips or repeats rows. Previous/Next also stops addressing the
 * page the operator is looking at.
 *
 * The server cursor also carries this complete filter/sort/limit and trusted
 * assignment-population fingerprint, so a changed URL cannot replay a cursor
 * over a different result set. Every control that shapes the population goes
 * through it, including tenant selection managed by the global shell.
 */
export function operationsPopulation(input: OperationsPopulation): string {
  return JSON.stringify([
    input.state,
    input.sort,
    input.tenantId ?? '',
    input.id.trim(),
    input.business.trim(),
    input.action.trim(),
    input.apiKey.trim(),
    input.profile.trim(),
    input.correlation.trim(),
    input.provider.trim(),
    input.model.trim(),
    input.usage,
    input.reservation,
    input.attention,
    input.fromDate,
    input.toDate,
    input.limit,
  ]);
}

/**
 * True when a live cursor was minted under a different population than the one
 * currently selected - the cursor must be dropped rather than replayed.
 */
export function operationsCursorIsStale(
  cursor: string | null,
  cursorPopulation: string | null,
  selectedPopulation: string,
): boolean {
  return cursor !== null && cursorPopulation !== selectedPopulation;
}
