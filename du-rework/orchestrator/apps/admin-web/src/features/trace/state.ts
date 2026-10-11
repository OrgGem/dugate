import type { AdminApiResult, AdminApiProblem } from '@/lib/api';
import type {
  OperationArtifactWire,
  OperationDetail,
  OperationTaskWire,
  OperationWire,
  OperationsPage,
} from '@/lib/api/types';

export type TraceLookupKind = 'operationId' | 'correlationId' | 'taskId';

export interface TraceLookupApi {
  listOperations(query: Record<string, string>): Promise<AdminApiResult<OperationsPage>>;
  getOperation(operationId: string): Promise<AdminApiResult<OperationDetail>>;
}

export interface TraceTimelineEvent {
  id: string;
  occurredAt: string | null;
  source: 'operation' | 'task' | 'audit' | 'usage';
  title: string;
  summary: string;
  severity?: string;
}

export type TaskLookupResult =
  | { kind: 'found'; detail: OperationDetail; scanned: number }
  | { kind: 'not-found'; scanned: number; capped: boolean; detailFailures: number }
  | { kind: 'failed'; problem: AdminApiProblem; scanned: number };

const TASK_SCAN_LIMIT = 500;
const TASK_SCAN_PAGE_SIZE = 100;
const TASK_SCAN_CONCURRENCY = 8;

interface TraceAuditEvent {
  id: string;
  kind: string;
  severity: string;
  occurredAt: string;
  tenantId: string | null;
  resourceId: string;
  actor: string;
}

interface TraceAuditPage {
  items: TraceAuditEvent[];
  total: number;
  limit: number;
  nextCursor: string | null;
  prevCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseOperationWire(value: unknown): OperationWire | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value['id']);
  const state = stringValue(value['state']);
  if (id === null || state === null) return null;
  return {
    id,
    state,
    tenantId: stringValue(value['tenantId'] ?? value['tenant_id']),
    businessId: stringValue(value['businessId'] ?? value['business_id']),
    action: stringValue(value['action']),
    createdAt: stringValue(value['createdAt'] ?? value['created_at']),
    updatedAt: stringValue(value['updatedAt'] ?? value['updated_at']),
    startedAt: stringValue(value['startedAt']),
    completedAt: stringValue(value['completedAt']),
    retryOf: stringValue(value['retryOf']),
    errorCode: stringValue(value['errorCode']),
    deadlineAt: stringValue(value['deadlineAt']),
  };
}

function parseOperationsPage(value: unknown): OperationsPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items = value['items'].map(parseOperationWire).filter((item): item is OperationWire => item !== null);
  const cursor = (candidate: unknown): string | null => typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  return {
    items,
    total: typeof value['total'] === 'number' && Number.isSafeInteger(value['total']) ? value['total'] : items.length,
    limit: typeof value['limit'] === 'number' && Number.isSafeInteger(value['limit']) ? value['limit'] : items.length,
    nextCursor: cursor(value['nextCursor']),
    prevCursor: cursor(value['prevCursor']),
  };
}

function parseOperationDetail(value: unknown): OperationDetail | null {
  if (!isRecord(value)) return null;
  const operation = parseOperationWire(value['operation'] ?? value);
  const tasks: OperationTaskWire[] = Array.isArray(value['tasks'])
    ? value['tasks'].filter(isRecord).map((task) => ({
      id: stringValue(task['id']) ?? '',
      taskKey: stringValue(task['taskKey']) ?? '',
      kind: stringValue(task['kind']) ?? '',
      state: stringValue(task['state']) ?? '',
      attempt: typeof task['attempt'] === 'number' ? task['attempt'] : 0,
      maxAttempts: typeof task['maxAttempts'] === 'number' ? task['maxAttempts'] : 0,
      errorCode: stringValue(task['errorCode']),
    }))
    : [];
  const artifacts: OperationArtifactWire[] = Array.isArray(value['artifacts'])
    ? value['artifacts'].filter(isRecord).map((artifact) => ({
      role: stringValue(artifact['role']) ?? 'output',
      status: stringValue(artifact['status'] ?? artifact['state']) ?? 'UNKNOWN',
      downloadUrl: stringValue(artifact['downloadUrl'] ?? artifact['download']),
      contentType: stringValue(artifact['contentType'] ?? artifact['mimeType']),
    }))
    : [];
  return {
    operation,
    tasks,
    artifacts,
    requestInput: undefined,
    resultSummary: null,
    serverNow: stringValue(value['serverNow']),
    raw: value,
  };
}

function parseTraceAuditPage(value: unknown): TraceAuditPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: TraceAuditEvent[] = [];
  for (const raw of value['items']) {
    if (!isRecord(raw)) continue;
    const id = stringValue(raw['id']);
    const kind = stringValue(raw['kind']);
    const occurredAt = stringValue(raw['occurredAt']);
    if (id === null || kind === null || occurredAt === null) continue;
    items.push({
      id,
      kind,
      occurredAt,
      severity: stringValue(raw['severity']) ?? 'unknown',
      tenantId: stringValue(raw['tenantId']),
      resourceId: stringValue(raw['resourceId']) ?? '',
      actor: stringValue(raw['actor']) ?? '',
    });
  }
  const count = (candidate: unknown, fallback: number) =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : fallback;
  const cursor = (candidate: unknown): string | null => typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  return {
    items,
    total: count(value['total'], items.length),
    limit: count(value['limit'], items.length),
    nextCursor: cursor(value['nextCursor']),
    prevCursor: cursor(value['prevCursor']),
  };
}

export function normalizeTraceLookup(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

/** Search operation details within the active tenant; never issue an unscoped list query. */
export async function findOperationByTaskId(
  taskId: string,
  tenantId: string | null,
  api: TraceLookupApi,
): Promise<TaskLookupResult> {
  const normalizedTaskId = normalizeTraceLookup(taskId);
  const normalizedTenantId = tenantId?.trim() ?? '';
  if (normalizedTaskId === null || normalizedTenantId === '') {
    return {
      kind: 'failed',
      problem: { status: 400, code: 'TENANT_SCOPE_REQUIRED', title: 'Select a tenant before looking up a task.' },
      scanned: 0,
    };
  }

  let cursor: string | null = null;
  let scanned = 0;
  let detailFailures = 0;
  const seenCursors = new Set<string>();

  while (scanned < TASK_SCAN_LIMIT) {
    const query: Record<string, string> = {
      tenant: normalizedTenantId,
      limit: String(TASK_SCAN_PAGE_SIZE),
      sort: 'created_at:desc',
    };
    if (cursor !== null) query['cursor'] = cursor;

    const pageResult = await api.listOperations(query);
    if (!pageResult.ok) return { kind: 'failed', problem: pageResult.problem, scanned };
    const page = parseOperationsPage(pageResult.data);
    if (page === null) {
      return {
        kind: 'failed',
        problem: { status: 502, code: 'UNREADABLE_RESPONSE', title: 'Operations search returned an unreadable page.' },
        scanned,
      };
    }

    const remaining = TASK_SCAN_LIMIT - scanned;
    const rows = page.items.slice(0, remaining);
    for (let offset = 0; offset < rows.length; offset += TASK_SCAN_CONCURRENCY) {
      const batch = rows.slice(offset, offset + TASK_SCAN_CONCURRENCY);
      const results = await Promise.all(batch.map(async (operation) => {
        try {
          const detailResult = await api.getOperation(operation.id);
          if (!detailResult.ok) return { detail: null, failed: true };
          const detail = parseOperationDetail(detailResult.data);
          if (detail === null) return { detail: null, failed: true };
          const found = detail.tasks?.some((task) => task.id === normalizedTaskId) ?? false;
          return { detail: found ? detail : null, failed: false };
        } catch {
          return { detail: null, failed: true };
        }
      }));
      scanned += batch.length;
      detailFailures += results.filter((result) => result.failed).length;
      const match = results.find((result) => result.detail !== null)?.detail;
      if (match !== undefined && match !== null) return { kind: 'found', detail: match, scanned };
    }

    if (page.nextCursor === null) return { kind: 'not-found', scanned, capped: false, detailFailures };
    if (seenCursors.has(page.nextCursor)) {
      return {
        kind: 'failed',
        problem: { status: 502, code: 'INVALID_CURSOR_SEQUENCE', title: 'Operations search returned a repeated cursor.' },
        scanned,
      };
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return { kind: 'not-found', scanned, capped: cursor !== null, detailFailures };
}

function safeCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function usageSummary(detail: OperationDetail): string | null {
  const result = detail.raw['result'];
  if (!isRecord(result) || !isRecord(result['usage'])) return null;
  const usage = result['usage'];
  const inputTokens = safeCount(usage['inputTokens']);
  const outputTokens = safeCount(usage['outputTokens']);
  const costMicrousd = safeCount(usage['costMicrousd']);
  const measurementValue = usage['measurement'];
  const measurement = measurementValue === 'pending' || measurementValue === 'estimated' || measurementValue === 'measured'
    ? measurementValue
    : null;
  const items = [
    inputTokens === null ? null : `${inputTokens.toLocaleString()} input tokens`,
    outputTokens === null ? null : `${outputTokens.toLocaleString()} output tokens`,
    costMicrousd === null ? null : `${costMicrousd.toLocaleString()} micro-USD`,
    measurement,
  ].filter((item): item is string => item !== null);
  return items.length === 0 ? null : items.join(' · ');
}

function timeValue(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Build a timeline from safe operation/task projections, usage totals and the operation's audit page. */
export function buildTraceTimeline(detail: OperationDetail, auditValue: unknown): TraceTimelineEvent[] {
  const operation = detail.operation;
  if (operation === null) return [];

  const events: TraceTimelineEvent[] = [];
  const addOperationEvent = (id: string, at: string | null, title: string, summary: string) => {
    if (at !== null) events.push({ id, occurredAt: at, source: 'operation', title, summary });
  };

  addOperationEvent('operation-created', timeValue(operation.createdAt), 'Operation created', `State: ${operation.state}`);
  addOperationEvent('operation-started', timeValue(operation.startedAt), 'Execution started', operation.action ?? 'Operation execution began.');
  const lastUpdated = timeValue(operation.completedAt ?? operation.updatedAt);
  if (lastUpdated !== null) {
    events.push({
      id: 'operation-current-state',
      occurredAt: lastUpdated,
      source: 'operation',
      title: 'Latest operation state',
      summary: `${operation.state}${operation.errorCode ? ` · ${operation.errorCode}` : ''}`,
    });
  }

  const taskObservedAt = timeValue(operation.updatedAt ?? operation.createdAt);
  for (const task of detail.tasks ?? []) {
    events.push({
      id: `task-${task.id}`,
      occurredAt: taskObservedAt,
      source: 'task',
      title: `${task.taskKey || task.kind || 'Task'} snapshot`,
      summary: [task.state, `attempt ${task.attempt}/${task.maxAttempts}`, task.errorCode].filter(Boolean).join(' · '),
    });
  }

  const usage = usageSummary(detail);
  if (usage !== null) {
    events.push({
      id: 'usage-summary',
      occurredAt: timeValue(operation.completedAt ?? operation.updatedAt),
      source: 'usage',
      title: 'Usage summary',
      summary: usage,
    });
  }

  const auditPage = parseTraceAuditPage(auditValue);
  const relatedAudit = auditPage?.items.filter((event) =>
    event.resourceId === `operation:${operation.id}` || event.resourceId === operation.id,
  ) ?? [];
  for (const event of relatedAudit) {
    events.push({
      id: `audit-${event.id}`,
      occurredAt: timeValue(event.occurredAt),
      source: 'audit',
      title: event.kind,
      summary: [event.severity, event.actor, event.resourceId].filter(Boolean).join(' · '),
      severity: event.severity,
    });
  }

  const sourceOrder: Record<TraceTimelineEvent['source'], number> = { operation: 0, task: 1, usage: 2, audit: 3 };
  return events.sort((left, right) => {
    const leftTime = left.occurredAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.occurredAt);
    const rightTime = right.occurredAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.occurredAt);
    return leftTime - rightTime || sourceOrder[left.source] - sourceOrder[right.source] || left.id.localeCompare(right.id);
  });
}

/** Strict preview masking: retain a little object shape, redact every scalar value. */
export function maskSensitivePayload(value: unknown): unknown {
  let remainingNodes = 120;
  const visit = (current: unknown, depth: number): unknown => {
    remainingNodes -= 1;
    if (remainingNodes < 0 || depth > 6) return '[MASKED]';
    if (current === null) return null;
    if (Array.isArray(current)) return current.slice(0, 20).map((item) => visit(item, depth + 1));
    if (isRecord(current)) {
      const entries = Object.entries(current).slice(0, 40);
      return Object.fromEntries(entries.map(([, child], index) => [`field_${index + 1}`, visit(child, depth + 1)]));
    }
    return '[MASKED]';
  };
  return visit(value, 0);
}

export function getTracePayloadPreview(detail: OperationDetail): unknown {
  const preview: Record<string, unknown> = {};
  const requestInput = detail.raw['requestInput'];
  const result = detail.raw['result'];
  if (requestInput !== undefined && requestInput !== null) preview['requestInput'] = requestInput;
  if (result !== undefined && result !== null) preview['result'] = result;
  return maskSensitivePayload(preview);
}

export function buildTraceLinks(operationId: string, tenantId: string): { operations: string; audit: string } {
  const operationQuery = new URLSearchParams({ id: operationId });
  const auditQuery = new URLSearchParams({ tenantId, resource: `operation:${operationId}` });
  return {
    operations: `/operations?${operationQuery.toString()}`,
    audit: `/audit?${auditQuery.toString()}`,
  };
}
