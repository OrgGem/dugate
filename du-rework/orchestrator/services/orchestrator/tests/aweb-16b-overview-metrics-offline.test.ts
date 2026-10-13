import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import type { RouteContext } from '../src/http/route-context';
import { handleInternalOperationsRoutes } from '../src/http/routes/internal-operations';
import {
  getOperationsMetrics,
  parseOperationsMetricsQuery,
} from '../src/modules/admin-read/operations-metrics';
import { matchOperationsRoute } from '../src/app/admin/bff/operations';

const FROM = '2026-10-09T00:00:00Z';
const TO = '2026-10-10T00:00:00Z';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SAMPLED_AT = new Date('2026-10-10T00:00:01.000Z');

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

function aggregateRow(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    sampled_at: SAMPLED_AT,
    total: '9',
    success: '4',
    failure: '2',
    cancelled: '1',
    timed_out: '1',
    running: '1',
    duration_samples: '6',
    p50_ms: '120.4',
    p95_ms: '900.6',
    ...overrides,
  };
}

function metricsParams(tenant: string): URLSearchParams {
  return new URLSearchParams({ from: FROM, to: TO, tenant });
}

describe('AWEB-16b Overview metrics aggregation (offline)', () => {
  it('requires one bounded UTC window and rejects ambiguous or unsupported filters', () => {
    expect(parseOperationsMetricsQuery(metricsParams(TENANT_A))).toEqual({
      from: FROM,
      to: TO,
      tenantId: TENANT_A,
    });
    expect(() => parseOperationsMetricsQuery(new URLSearchParams({ from: FROM }))).toThrow(
      expect.objectContaining({ status: 422, code: 'INVALID_SCHEMA' }),
    );
    expect(() => parseOperationsMetricsQuery(new URLSearchParams({ from: TO, to: FROM }))).toThrow(
      expect.objectContaining({ status: 422, code: 'INVALID_SCHEMA' }),
    );
    expect(() => parseOperationsMetricsQuery(new URLSearchParams(`${metricsParams(TENANT_A)}&tenant=${TENANT_B}`))).toThrow(
      expect.objectContaining({ status: 422, code: 'INVALID_SCHEMA' }),
    );
    expect(() => parseOperationsMetricsQuery(new URLSearchParams(`${metricsParams(TENANT_A)}&limit=100`))).toThrow(
      expect.objectContaining({ status: 422, code: 'INVALID_SCHEMA' }),
    );
    expect(() => parseOperationsMetricsQuery(new URLSearchParams({ from: FROM, to: TO, tenant: 'not-a-uuid' }))).toThrow(
      expect.objectContaining({ status: 422, code: 'INVALID_SCHEMA' }),
    );
  });

  it('computes counts and p50/p95 in one query, with tenant and time bounds in SQL', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        calls.push({ sql, params });
        return queryResult<T>([aggregateRow()]);
      },
    } as unknown as Pick<Db, 'query'>;

    const result = await getOperationsMetrics(
      { db },
      { from: FROM, to: TO, tenantId: TENANT_A },
      TENANT_A,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("created_at >= $1::timestamptz AND created_at <= $2::timestamptz");
    expect(calls[0]!.sql).toContain('tenant_id = $3::uuid');
    expect(calls[0]!.sql).toContain("count(*) FILTER (WHERE state='SUCCEEDED')");
    expect(calls[0]!.sql).toContain("count(*) FILTER (WHERE state='FAILED')");
    expect(calls[0]!.sql).toContain('percentile_cont(0.50)');
    expect(calls[0]!.sql).toContain('percentile_cont(0.95)');
    expect(calls[0]!.params).toEqual([FROM, TO, TENANT_A]);
    expect(result).toMatchObject({
      from: FROM,
      to: TO,
      tenantId: TENANT_A,
      total: 9,
      success: 4,
      failure: 2,
      cancelled: 1,
      timedOut: 1,
      running: 1,
      p50Ms: 120,
      p95Ms: 901,
      durationSamples: 6,
      sampledAt: SAMPLED_AT.toISOString(),
      stale: false,
    });
  });

  it('keeps a platform aggregate cross-tenant only when no tenant scope was selected', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        calls.push({ sql, params });
        return queryResult<T>([aggregateRow()]);
      },
    } as unknown as Pick<Db, 'query'>;

    const result = await getOperationsMetrics(
      { db },
      { from: FROM, to: TO, tenantId: null },
      null,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).not.toContain('tenant_id =');
    expect(calls[0]!.sql).toContain('WHERE deleted_at IS NULL');
    expect(calls[0]!.params).toEqual([FROM, TO]);
    expect(result.tenantId).toBeNull();
  });

  it('enforces admin tenant authorization before running the aggregation', async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        queries.push({ sql, params });
        return queryResult<T>([aggregateRow()]);
      },
    } as unknown as Db;
    const context = {
      method: 'GET',
      pathname: '/api/internal/operations/metrics',
      ingressAudience: 'internal',
      searchParams: metricsParams(TENANT_B),
      headers: { authorization: 'Bearer tenant-a-token' },
      config: { tenantAdminTokens: { 'tenant-a-token': TENANT_A } },
      db,
    } as unknown as RouteContext;

    await expect(handleInternalOperationsRoutes(context)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(queries).toEqual([]);
  });

  it('registers a dedicated BFF metrics route instead of treating metrics as an operation id', () => {
    expect(matchOperationsRoute('/operations/metrics')).toEqual({ kind: 'operations-metrics' });
  });
});
