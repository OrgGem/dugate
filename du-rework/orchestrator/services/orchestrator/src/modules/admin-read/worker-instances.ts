import type { QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { WORKER_HEARTBEAT_FRESH_FOR_MS } from '../runtime/worker-instances';

const DEGRADED_AFTER_MS = 5 * 60_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export type WorkerInstanceState = 'ONLINE' | 'DRAINING' | 'OFFLINE';
export type WorkerInstanceHealth = 'HEALTHY' | 'DEGRADED' | 'OFFLINE';

export interface WorkerInstanceListQuery {
  businessId: string | null;
  limit: number;
}

export interface WorkerInstanceRead {
  businessId: string;
  instanceId: string;
  businessVersion: string;
  state: WorkerInstanceState;
  health: WorkerInstanceHealth;
  capacity: number;
  activeLeases: number;
  lastSeenAt: string;
  observedAt: string;
}

export interface WorkerInstanceList {
  items: WorkerInstanceRead[];
  sampledAt: string;
  truncated: boolean;
}

interface WorkerInstanceDbRow extends QueryResultRow {
  business_id: string;
  instance_id: string;
  business_version: string;
  state: string;
  capacity: number | string;
  active_leases: number | string;
  last_seen_at: Date | string;
  observed_at: Date | string;
}

function readSingleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) throw new HttpError(422, 'INVALID_SCHEMA', `${name} must not be repeated`);
  return values[0] ?? null;
}

/** Parse the closed worker-inventory list contract. */
export function parseWorkerInstanceListQuery(params: URLSearchParams): WorkerInstanceListQuery {
  const allowed = new Set(['businessId', 'limit']);
  for (const name of params.keys()) {
    if (!allowed.has(name)) throw new HttpError(422, 'INVALID_SCHEMA', `unsupported worker query parameter: ${name}`);
  }

  const rawBusinessId = readSingleParam(params, 'businessId');
  const businessId = rawBusinessId === null || rawBusinessId.trim() === '' ? null : rawBusinessId.trim();
  if (businessId !== null && (businessId.length > 256 || /[\u0000-\u001f\u007f]/.test(businessId))) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'businessId must be at most 256 printable characters');
  }

  const rawLimit = readSingleParam(params, 'limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) throw new HttpError(422, 'INVALID_SCHEMA', 'limit must be an integer');
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new HttpError(422, 'INVALID_SCHEMA', `limit must be between 1 and ${MAX_LIMIT}`);
    }
  }
  return { businessId, limit };
}

/** List only recorded worker instances; businesses with no heartbeat produce no synthetic rows. */
export async function listWorkerInstances(
  db: Pick<Db, 'query'>,
  query: WorkerInstanceListQuery,
  nowMs = Date.now(),
): Promise<WorkerInstanceList> {
  const sampledAt = new Date(nowMs);
  if (Number.isNaN(sampledAt.getTime())) throw new Error('worker inventory sample time is invalid');
  const params: unknown[] = [];
  const where = query.businessId === null
    ? ''
    : ` WHERE business_id = $${params.push(query.businessId)}`;
  params.push(query.limit + 1);
  const result = await db.query<WorkerInstanceDbRow>(
    `SELECT business_id, instance_id, business_version, state, capacity, active_leases,
            last_seen_at, observed_at
       FROM worker_instances${where}
      ORDER BY last_seen_at DESC, business_id ASC, instance_id ASC
      LIMIT $${params.length}`,
    params,
  );
  const truncated = result.rows.length > query.limit;
  const items = result.rows.slice(0, query.limit).map((row) => toWorkerInstanceRead(row, nowMs));
  return { items, sampledAt: sampledAt.toISOString(), truncated };
}

function toWorkerInstanceRead(row: WorkerInstanceDbRow, nowMs: number): WorkerInstanceRead {
  if (row.state !== 'ONLINE' && row.state !== 'DRAINING' && row.state !== 'OFFLINE') {
    throw new Error('worker inventory query returned an unknown state');
  }
  const lastSeenAt = readTimestamp(row.last_seen_at, 'last_seen_at');
  const observedAt = readTimestamp(row.observed_at, 'observed_at');
  const capacity = readCount(row.capacity, 'capacity');
  const activeLeases = readCount(row.active_leases, 'active_leases');
  const ageMs = Math.max(0, nowMs - Date.parse(lastSeenAt));
  const health: WorkerInstanceHealth = row.state === 'OFFLINE' || ageMs > DEGRADED_AFTER_MS
    ? 'OFFLINE'
    : row.state === 'DRAINING' || capacity === 0 || ageMs > WORKER_HEARTBEAT_FRESH_FOR_MS
      ? 'DEGRADED'
      : 'HEALTHY';
  const state: WorkerInstanceState = health === 'OFFLINE' ? 'OFFLINE' : row.state;
  return {
    businessId: row.business_id,
    instanceId: row.instance_id,
    businessVersion: row.business_version,
    state,
    health,
    capacity,
    activeLeases,
    lastSeenAt,
    observedAt,
  };
}

function readTimestamp(value: Date | string, name: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`worker inventory query returned invalid ${name}`);
  return date.toISOString();
}

function readCount(value: string | number, name: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`worker inventory query returned invalid ${name}`);
  }
  return count;
}
