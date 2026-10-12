import type { AdminHealthSnapshot, AdminWebSession, OperationWire } from '@/lib/api';

const HEALTH_STATES = new Set(['ok', 'degraded', 'unknown']);
const QUEUE_STATES = new Set(['OK', 'RECONSTRUCTING', 'SUSPECT']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Runtime-check the aggregate health wire before presenting it as a platform observation. */
export function parseAdminHealthSnapshot(value: unknown): AdminHealthSnapshot | null {
  if (!isRecord(value)) return null;
  if (!HEALTH_STATES.has(String(value.status)) || !isTimestamp(value.sampledAt)) return null;
  if (!(value.db === null || typeof value.db === 'boolean')) return null;
  if (!(value.redis === null || typeof value.redis === 'boolean')) return null;
  if (!isCount(value.activeLeases) || !isCount(value.outboxBacklog)) return null;

  let queueIntegrity: AdminHealthSnapshot['queueIntegrity'] = null;
  if (value.queueIntegrity !== null) {
    if (!isRecord(value.queueIntegrity) || !QUEUE_STATES.has(String(value.queueIntegrity.state))) return null;
    const orphansLast = value.queueIntegrity.orphansLast;
    const stalled = value.queueIntegrity.stalled;
    const lastSweepAt = value.queueIntegrity.lastSweepAt;
    if (!isCount(orphansLast) || !isCount(stalled)) return null;
    if (!(lastSweepAt === null || isTimestamp(lastSweepAt))) return null;
    queueIntegrity = {
      state: value.queueIntegrity.state as NonNullable<AdminHealthSnapshot['queueIntegrity']>['state'],
      orphansLast,
      stalled,
      lastSweepAt,
    };
  }

  return {
    status: value.status as AdminHealthSnapshot['status'],
    db: value.db,
    redis: value.redis,
    activeLeases: value.activeLeases,
    queueIntegrity,
    outboxBacklog: value.outboxBacklog,
    sampledAt: value.sampledAt,
  };
}

/** The credential's tenant scope wins over the global picker, which is only a platform-admin filter. */
export function effectiveTenantId(session: AdminWebSession, selectedTenantId: string | null): string | null {
  return session.scope?.kind === 'tenant' ? session.scope.tenantId : selectedTenantId;
}

/** Health and worker inventory are explicitly platform-only BFF projections. */
export function canReadPlatformSignals(session: AdminWebSession): boolean {
  return session.role === 'admin'
    && session.principal.kind === 'platform'
    && session.scope?.kind === 'platform';
}

/** Local USER sessions have no assigned-resource incident fence. Use the
 * explicit server-validated session bit for presentation; the internal route
 * remains the authorization boundary and independently returns 403. */
export function isLocalUserSession(session: AdminWebSession | null): boolean {
  return session?.localUser === true;
}

export function canReadIncidentLedger(session: AdminWebSession | null): boolean {
  return Boolean(session?.scope) && !isLocalUserSession(session);
}

/** Compose reads and actions require the complete platform-admin BFF session scope. */
export function canManageCompose(session: AdminWebSession | null | undefined): boolean {
  return session?.role === 'admin'
    && session.principal.kind === 'platform'
    && session.scope?.kind === 'platform';
}

export interface OperationSignals {
  unknown: OperationWire[];
  waitingInput: OperationWire[];
  overdueInput: OperationWire[];
}

/** Counts intentionally describe only the returned operations page, never the full history. */
export function deriveOperationSignals(items: OperationWire[], nowMs = Date.now()): OperationSignals {
  const unknown: OperationWire[] = [];
  const waitingInput: OperationWire[] = [];
  const overdueInput: OperationWire[] = [];
  for (const item of items) {
    if (item.state.toUpperCase() === 'UNKNOWN' || item.errorCode?.toUpperCase().includes('UNKNOWN')) {
      unknown.push(item);
    }
    if (item.state.toUpperCase() === 'WAITING_INPUT') {
      waitingInput.push(item);
      const deadline = item.deadlineAt == null ? Number.NaN : Date.parse(item.deadlineAt);
      if (Number.isFinite(deadline) && deadline < nowMs) overdueInput.push(item);
    }
  }
  return { unknown, waitingInput, overdueInput };
}

export function sampleAgeState(sampledAt: string | null, nowMs: number, staleAfterMs = 60_000): 'fresh' | 'stale' | 'unknown' {
  if (sampledAt === null || !Number.isFinite(Date.parse(sampledAt))) return 'unknown';
  return Math.max(0, nowMs - Date.parse(sampledAt)) > staleAfterMs ? 'stale' : 'fresh';
}
