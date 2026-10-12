import type { Db } from '../src/db/db';
import { createIncidentService } from '../src/modules/incidents/service';

describe('ORV14 incident signal upsert SQL alias', () => {
  test('qualifies conflict-update columns through the INSERT alias', async () => {
    const insertStatements: string[] = [];
    const failure = new Error('stop after capturing INSERT for alias assertion');
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('SELECT i.incident_id')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO admin_incidents AS i')) {
          insertStatements.push(sql);
          throw failure;
        }
        throw new Error('unexpected SQL in alias regression: ' + sql);
      }),
    };
    const db = {
      query: async () => ({ rows: [{ active: false }], rowCount: 1 }),
      tx: async (run: (executor: never) => Promise<unknown>) => run(client as never),
    } as unknown as Db;
    const service = createIncidentService(db, { record: jest.fn() } as never,
      () => new Date('2026-10-11T12:00:00.000Z'));

    await expect(service.upsertIncidentSignal({
      source: 'connector', sourceRef: 'connector-ledger:tenant-a', signalCode: 'usage-outbox-failed',
      scope: { kind: 'tenant', tenantId: '72b8d7bf-16bf-41b8-9e1e-67b9d7b59c61' },
      severity: 'high', state: 'active', summary: 'Connector usage delivery is failing.',
      sampledAt: '2026-10-11T12:00:00.000Z', thresholdRevision: 'v1',
      affectedResources: [], counters: { failed: 1 },
    })).rejects.toBe(failure);

    expect(insertStatements).toHaveLength(1);
    expect(insertStatements[0]).toContain('GREATEST(i.last_seen_at,EXCLUDED.last_seen_at)');
    expect(insertStatements[0]).toContain('GREATEST(i.last_sampled_at,EXCLUDED.last_sampled_at)');
    expect(insertStatements[0]).toContain('occurrence_count=i.occurrence_count+1');
    expect(insertStatements[0]).toContain('state_version=i.state_version+1');
    expect(insertStatements[0]).not.toMatch(/admin_incidents\.(last_seen_at|last_sampled_at|occurrence_count|state_version)/);
  });
});

describe('ORV14 incident source ordering', () => {
  test('serializes the dedupe key before reads and ignores a late older active sample', async () => {
    const tenantId = '72b8d7bf-16bf-41b8-9e1e-67b9d7b59c61';
    const sampledAt = '2026-10-11T12:00:02.000Z';
    const statements: string[] = [];
    const incidentId = 'b8b08c39-6fae-4c78-8c13-f6503e8eb73a';
    let row: Record<string, unknown> | undefined;
    let eventCount = 0;
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM admin_incidents i WHERE i.dedupe_key=$1')) {
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.includes('SELECT $2::timestamptz <= CASE')) {
          const stale = Date.parse(String(params[1])) <= Date.parse(String(row?.['last_sampled_at']));
          return { rows: [{ stale }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO admin_incidents AS i')) {
          const [id, tenant, scope, source, sourceRef, signalCode, , severity, summary, time, threshold, resources, counters] = params;
          row = {
            incident_id: id, tenant_id: tenant, scope_kind: scope, source, source_ref: sourceRef, signal_code: signalCode,
            severity, status: 'open', source_state: 'active', summary, owner_id: null,
            first_seen_at: new Date(String(time)), last_seen_at: new Date(String(time)), last_sampled_at: new Date(String(time)),
            occurrence_count: 1, state_version: 1, threshold_revision: threshold,
            affected_resources: JSON.parse(String(resources)) as unknown, counters: JSON.parse(String(counters)) as unknown,
            acknowledged_at: null, resolved_at: null, resolution_evidence_ref: null,
          };
          return { rows: [{ ...row, was_inserted: true }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO admin_incident_events')) { eventCount += 1; return { rows: [], rowCount: 1 }; }
        throw new Error('unexpected SQL in incident ordering regression: ' + sql);
      }),
    };
    const db = {
      query: async () => ({ rows: [{ active: false }], rowCount: 1 }),
      tx: async (run: (executor: never) => Promise<unknown>) => run(client as never),
    } as unknown as Db;
    const service = createIncidentService(db, { record: jest.fn() } as never,
      () => new Date('2026-10-11T12:00:03.000Z'));
    const signal = (time: string, counters: Record<string, number>) => ({
      source: 'connector', sourceRef: 'connector-ledger:tenant-a', signalCode: 'usage-outbox-failed',
      scope: { kind: 'tenant' as const, tenantId }, severity: 'high' as const, state: 'active' as const,
      summary: 'Connector usage delivery is failing.', sampledAt: time, thresholdRevision: 'v1',
      affectedResources: [], counters,
    });

    const newer = await service.upsertIncidentSignal(signal(sampledAt, { failed: 9 }));
    const older = await service.upsertIncidentSignal(signal('2026-10-11T12:00:01.000Z', { failed: 1 }));

    expect(newer?.counters).toEqual({ failed: 9 });
    expect(older?.counters).toEqual({ failed: 9 });
    expect(eventCount).toBe(1);
    expect(statements.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    for (let index = 0; index < statements.length; index += 1) {
      if (statements[index]?.includes('FROM admin_incidents i WHERE i.dedupe_key=$1')) {
        expect(statements[index - 1]).toContain('pg_advisory_xact_lock');
      }
    }
  });
});
