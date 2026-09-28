import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createAuditService } from '../src/modules/audit/audit';

interface AuditEntityRow extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  actor: string;
  action: string;
  resource: string;
  severity: string;
  correlation_id: string | null;
  created_at: Date;
}

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const AUDIT_ENTITY_ID = '50000000-0000-4000-8000-000000000001';
const FOREIGN_AUDIT_ENTITY_ID = '50000000-0000-4000-8000-000000000002';
const TENANT_ID = '60000000-0000-4000-8000-000000000001';
const FOREIGN_TENANT_ID = '60000000-0000-4000-8000-000000000002';
const CORRELATION_ID = 'p8-01-correlation-0001';

function createInMemoryAuditDb(): {
  db: Db;
  rows: AuditEntityRow[];
  queries: CapturedQuery[];
} {
  const rows: AuditEntityRow[] = [];
  const queries: CapturedQuery[] = [];
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> => {
      queries.push({ sql, params });
      let resultRows: QueryResultRow[];
      let command: string;

      if (/INSERT INTO admin_audit_events/i.test(sql)) {
        const [tenantId, actor, action, resource, severity, correlationId] = params;
        if (
          (tenantId !== null && typeof tenantId !== 'string') ||
          typeof actor !== 'string' ||
          typeof action !== 'string' ||
          typeof resource !== 'string' ||
          typeof severity !== 'string' ||
          (correlationId !== null && typeof correlationId !== 'string')
        ) {
          throw new Error('invalid in-memory audit INSERT parameters');
        }
        const entity: AuditEntityRow = {
          id: rows.length === 0 ? AUDIT_ENTITY_ID : FOREIGN_AUDIT_ENTITY_ID,
          tenant_id: tenantId,
          actor,
          action,
          resource,
          severity,
          correlation_id: correlationId,
          created_at: new Date('2026-09-25T00:00:00.000Z'),
        };
        rows.push(entity);
        resultRows = [{ id: entity.id }];
        command = 'INSERT';
      } else if (/FROM admin_audit_events/i.test(sql)) {
        const tenantId = params[0];
        const limit = params[1];
        if (typeof tenantId !== 'string' || typeof limit !== 'number') {
          throw new Error('invalid in-memory audit SELECT parameters');
        }
        resultRows = rows
          .filter((row) => row.tenant_id === tenantId)
          .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())
          .slice(0, limit);
        command = 'SELECT';
      } else {
        throw new Error('unexpected SQL in offline audit harness');
      }

      return {
        command,
        rowCount: resultRows.length,
        oid: 0,
        rows: resultRows as T[],
        fields: [],
      };
    },
  } as unknown as Db;

  return { db, rows, queries };
}

describe('P8-01 offline audit-log entity verification', () => {
  it('declares the audit entity fields in the platform migration', () => {
    const migrationPath = path.resolve(__dirname, '../migrations/0010_admin_audit.sql');
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS admin_audit_events/i);
    for (const column of [
      'tenant_id',
      'actor',
      'action',
      'resource',
      'severity',
      'correlation_id',
      'created_at',
    ]) {
      expect(migration).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it('records and reads a tenant-scoped audit entity with its trace correlation', async () => {
    const { db, rows, queries } = createInMemoryAuditDb();
    const audit = createAuditService(db);
    const recordResult = await audit.record({
      tenantId: TENANT_ID,
      actor: 'admin',
      action: 'profile_binding.bind',
      resource: 'apikey:70000000-0000-4000-8000-000000000001',
      severity: 'info',
      correlationId: CORRELATION_ID,
    });

    expect(recordResult).toEqual({ id: AUDIT_ENTITY_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: AUDIT_ENTITY_ID,
      tenant_id: TENANT_ID,
      actor: 'admin',
      action: 'profile_binding.bind',
      resource: 'apikey:70000000-0000-4000-8000-000000000001',
      severity: 'info',
      correlation_id: CORRELATION_ID,
    });
    expect(queries[0]?.sql).toMatch(/INSERT INTO admin_audit_events/i);
    expect(queries[0]?.params).toEqual([
      TENANT_ID,
      'admin',
      'profile_binding.bind',
      'apikey:70000000-0000-4000-8000-000000000001',
      'info',
      CORRELATION_ID,
    ]);

    await audit.record({
      tenantId: FOREIGN_TENANT_ID,
      actor: 'admin',
      action: 'profile_binding.bind',
      resource: 'apikey:70000000-0000-4000-8000-000000000002',
      severity: 'info',
      correlationId: 'p8-01-foreign-correlation-0002',
    });

    const events = await audit.listForTenant(TENANT_ID, 20);
    expect(queries[2]?.sql).toMatch(/WHERE tenant_id = \$1/i);
    expect(queries[2]?.sql).toMatch(/LIMIT \$2/i);
    expect(queries[2]?.params).toEqual([TENANT_ID, 20]);
    expect(events).toEqual([{
      id: AUDIT_ENTITY_ID,
      kind: 'profile_binding.bind',
      severity: 'info',
      occurredAt: '2026-09-25T00:00:00.000Z',
      tenantId: TENANT_ID,
      resourceId: 'apikey:70000000-0000-4000-8000-000000000001',
      actor: 'admin',
      message: 'profile_binding.bind apikey:70000000-0000-4000-8000-000000000001',
    }]);
    expect(events.map((event) => event.resourceId)).not.toContain(
      'apikey:70000000-0000-4000-8000-000000000002'
    );
  });
});
