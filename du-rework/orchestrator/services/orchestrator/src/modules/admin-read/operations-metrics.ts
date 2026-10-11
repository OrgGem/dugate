import { compareAdminListTimeBounds, isAdminListTimeBound } from '@du/contracts';
import type { QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';

const OPERATIONS_METRICS_STALE_AFTER_MS = 30_000;
const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = "'SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'";

export interface OperationsMetricsQuery {
  from: string;
  to: string;
  tenantId: string | null;
}

export interface OperationsMetrics {
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

interface OperationsMetricsRow extends QueryResultRow {
  sampled_at: Date | string;
  total: string | number;
  success: string | number;
  failure: string | number;
  cancelled: string | number;
  timed_out: string | number;
  running: string | number;
  duration_samples: string | number;
  p50_ms: string | number | null;
  p95_ms: string | number | null;
}

export interface OperationsMetricsDbContext {
  db: Pick<Db, 'query'>;
}

/** Strict filter contract for a bounded Overview aggregation request. */
export function parseOperationsMetricsQuery(params: URLSearchParams): OperationsMetricsQuery {
  const allowed = new Set(['from', 'to', 'tenant']);
  const values = new Map<string, string>();
  for (const [name, value] of params) {
    if (!allowed.has(name) || values.has(name)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'operations metrics query contains an unsupported or repeated parameter');
    }
    values.set(name, value);
  }

  const from = values.get('from')?.trim() ?? '';
  const to = values.get('to')?.trim() ?? '';
  if (!isAdminListTimeBound(from) || !isAdminListTimeBound(to)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'operations metrics requires valid UTC from and to instants');
  }
  if (compareAdminListTimeBounds(from, to) > 0) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'from must not be after to');
  }

  const rawTenantId = values.get('tenant')?.trim() ?? '';
  if (rawTenantId !== '' && !TENANT_UUID.test(rawTenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenant must be a UUID');
  }

  return { from, to, tenantId: rawTenantId === '' ? null : rawTenantId };
}

/**
 * One PostgreSQL statement calculates every value from one MVCC snapshot.
 * Counts and duration percentiles therefore cannot describe different row
 * sets if operations complete while an Overview request is in flight.
 */
export async function getOperationsMetrics(
  ctx: OperationsMetricsDbContext,
  query: OperationsMetricsQuery,
  tenantId: string | null,
): Promise<OperationsMetrics> {
  const params: unknown[] = [query.from, query.to];
  const tenantClause = tenantId === null ? '' : ` AND tenant_id = $${params.push(tenantId)}::uuid`;
  const queryStartedAt = Date.now();
  const result = await ctx.db.query<OperationsMetricsRow>(
    `SELECT statement_timestamp() AS sampled_at,
            count(*)::text AS total,
            (count(*) FILTER (WHERE state='SUCCEEDED'))::text AS success,
            (count(*) FILTER (WHERE state='FAILED'))::text AS failure,
            (count(*) FILTER (WHERE state='CANCELLED'))::text AS cancelled,
            (count(*) FILTER (WHERE state='TIMED_OUT'))::text AS timed_out,
            (count(*) FILTER (WHERE state NOT IN (${TERMINAL_STATES})))::text AS running,
            (count(*) FILTER (
              WHERE completed_at IS NOT NULL AND completed_at >= COALESCE(started_at, created_at)
            ))::text AS duration_samples,
            percentile_cont(0.50) WITHIN GROUP (
              ORDER BY (EXTRACT(EPOCH FROM (completed_at - COALESCE(started_at, created_at))) * 1000)::double precision
            ) FILTER (
              WHERE completed_at IS NOT NULL AND completed_at >= COALESCE(started_at, created_at)
            ) AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (
              ORDER BY (EXTRACT(EPOCH FROM (completed_at - COALESCE(started_at, created_at))) * 1000)::double precision
            ) FILTER (
              WHERE completed_at IS NOT NULL AND completed_at >= COALESCE(started_at, created_at)
            ) AS p95_ms
     FROM operations
     WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz${tenantClause}`,
    params,
  );
  const row = result.rows[0];
  if (!row) throw new Error('operations metrics query returned no aggregate row');

  const sampledAtDate = row.sampled_at instanceof Date ? row.sampled_at : new Date(row.sampled_at);
  if (Number.isNaN(sampledAtDate.getTime())) throw new Error('operations metrics query returned an invalid sample time');

  return {
    from: query.from,
    to: query.to,
    tenantId,
    total: readCount(row.total, 'total'),
    success: readCount(row.success, 'success'),
    failure: readCount(row.failure, 'failure'),
    cancelled: readCount(row.cancelled, 'cancelled'),
    timedOut: readCount(row.timed_out, 'timed_out'),
    running: readCount(row.running, 'running'),
    durationSamples: readCount(row.duration_samples, 'duration_samples'),
    p50Ms: readDuration(row.p50_ms, 'p50_ms'),
    p95Ms: readDuration(row.p95_ms, 'p95_ms'),
    sampledAt: sampledAtDate.toISOString(),
    stale: Date.now() - queryStartedAt > OPERATIONS_METRICS_STALE_AFTER_MS,
  };
}

function readCount(value: string | number, name: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`operations metrics query returned an invalid ${name} count`);
  }
  return count;
}

function readDuration(value: string | number | null, name: string): number | null {
  if (value === null) return null;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`operations metrics query returned an invalid ${name} duration`);
  }
  return Math.round(duration);
}
