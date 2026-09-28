import type { PoolClient } from 'pg';
import { Db } from '../src/db/db';
import {
  auditedMutation,
  createAuditService,
  type AuditRecordInput,
} from '../src/modules/audit/audit';
import { createRegistryService } from '../src/modules/registry/registry';
import { createProfileService } from '../src/modules/profiles/profiles';
import { createLifecycleService } from '../src/modules/lifecycle/lifecycle';

/**
 * R3-01 (review.md W-R3): admin mutations and their audit INSERT must be
 * ATOMIC. These are offline unit tests — no PG :5433, no Redis :6380 —
 * driving the REAL module code against a fake Db whose tx journals
 * statements and discards the journal on throw (rollback semantics).
 * failOn is the failure injection: the audit INSERT blows up AFTER the
 * mutation ran inside the transaction, and the assertion is that NOTHING
 * committed. The pre-fix route shape (mutate, commit, then record) leaked
 * exactly a committed mutation with no ledger row here.
 */

interface Attempted {
  sql: string;
  params: unknown[];
  via: 'pool' | 'tx';
}

interface FakeOptions {
  failOn?: (sql: string) => boolean;
  rows?: (sql: string) => Record<string, unknown>[];
}

function makeFake(opts: FakeOptions = {}) {
  const attempted: Attempted[] = [];
  const committed: Attempted[] = [];
  let staged: Attempted[] = [];
  let txCount = 0;

  const run = (via: 'pool' | 'tx', sql: string, params: unknown[]) => {
    attempted.push({ sql, params, via }); // even injected failures count as attempted
    if (via === 'tx') staged.push({ sql, params, via });
    else committed.push({ sql, params, via });
    if (opts.failOn?.(sql)) {
      throw new Error(`injected failure: ${sql.trim().slice(0, 48)}`);
    }
    let rows = opts.rows?.(sql);
    if ((!rows || rows.length === 0) && /RETURNING\s+id/i.test(sql)) {
      rows = [{ id: 'audit-row-1' }];
    }
    rows = rows ?? [];
    return { rows, rowCount: rows.length };
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => run('tx', text, params),
  };

  const db = {
    pool: undefined,
    query: async (text: string, params: unknown[] = []) => run('pool', text, params),
    tx: async (fn: (c: unknown) => Promise<unknown>) => {
      txCount += 1;
      staged = [];
      try {
        const result = await fn(client);
        committed.push(...staged);
        staged = [];
        return result;
      } catch (err) {
        staged = []; // ROLLBACK: staged statements never reach committed
        throw err;
      }
    },
    close: async () => undefined,
  };

  return {
    db: db as unknown as Db,
    client: client as unknown as PoolClient,
    attempted,
    committed,
    txCount: () => txCount,
  };
}

const auditInput = (over?: Partial<AuditRecordInput>): AuditRecordInput => ({
  tenantId: null,
  actor: 'admin',
  action: 'business.enable',
  resource: 'business:biz@1.0.0',
  severity: 'success',
  correlationId: 'corr-unit-1',
  ...over,
});

describe('R3-01 auditedMutation: one transaction, or nothing', () => {
  it('commits mutation + audit INSERT in the SAME transaction (ordered)', async () => {
    const f = makeFake();
    const audit = createAuditService(f.db);
    const result = await auditedMutation(
      f.db,
      audit,
      async (client) => {
        await client.query('UPDATE business_versions SET status=$1 WHERE business_id=$2', [
          'ENABLED',
          'biz',
        ]);
        return 'mutated';
      },
      () => auditInput()
    );
    expect(result).toBe('mutated');
    expect(f.txCount()).toBe(1);
    expect(f.committed.map((c) => c.via)).toEqual(['tx', 'tx']);
    expect(f.committed[0]!.sql).toMatch(/UPDATE business_versions/);
    expect(f.committed[1]!.sql).toMatch(/INSERT INTO admin_audit_events/);
  });

  it('FAILURE INJECTION: audit INSERT fails after the mutation -> mutation is rolled back', async () => {
    const f = makeFake({ failOn: (sql) => /INSERT INTO admin_audit_events/.test(sql) });
    const audit = createAuditService(f.db);
    await expect(
      auditedMutation(
        f.db,
        audit,
        async (client) => {
          await client.query('UPDATE business_versions SET status=$1', ['ENABLED']);
        },
        () => auditInput()
      )
    ).rejects.toThrow(/injected failure/);
    // Both statements were attempted (the mutation genuinely ran before the
    // audit INSERT blew up)...
    expect(f.attempted.some((a) => /UPDATE business_versions/.test(a.sql))).toBe(true);
    expect(f.attempted.some((a) => /INSERT INTO admin_audit_events/.test(a.sql))).toBe(true);
    // ...but the ROLLBACK left NOTHING behind. This is the exact leak R3-01
    // reported: mutation persisted without its audit event.
    expect(f.committed).toEqual([]);
  });

  it('mutation failure -> no audit row is even attempted', async () => {
    const f = makeFake({ failOn: (sql) => /UPDATE business_versions/.test(sql) });
    const audit = createAuditService(f.db);
    await expect(
      auditedMutation(
        f.db,
        audit,
        async (client) => {
          await client.query('UPDATE business_versions SET status=$1', ['ENABLED']);
        },
        () => auditInput()
      )
    ).rejects.toThrow(/injected failure/);
    expect(f.attempted.some((a) => /INSERT INTO admin_audit_events/.test(a.sql))).toBe(false);
    expect(f.committed).toEqual([]);
  });

  it('audit.record writes through the passed executor (not the pool)', async () => {
    const f = makeFake();
    const audit = createAuditService(f.db);
    await audit.record(auditInput(), f.client);
    expect(f.attempted).toHaveLength(1);
    expect(f.attempted[0]!.via).toBe('tx');
    // Standalone (no executor) still uses the pool — reads/diagnostics.
    await audit.record(auditInput({ action: 'operation.deadline' }));
    expect(f.attempted[1]!.via).toBe('pool');
  });
});

describe('R3-01 registry.activateVersion/deactivateVersion join the route transaction', () => {
  const enabledRow = (sql: string) =>
    sql.includes('SELECT status, is_active') ? [{ status: 'ENABLED', is_active: false }] : [];

  it('activate + audit atomic on the caller client; no nested BEGIN', async () => {
    const f = makeFake({ rows: enabledRow });
    const registry = createRegistryService(f.db);
    const audit = createAuditService(f.db);
    const result = await auditedMutation(
      f.db,
      audit,
      (client) => registry.activateVersion('biz', '1.0.0', client),
      (r) => auditInput({ action: 'business.activate', resource: `business:${r.businessId}@${r.version}`, severity: 'info' })
    );
    expect(result).toMatchObject({ businessId: 'biz', version: '1.0.0', replayed: false });
    expect(f.txCount()).toBe(1); // only auditedMutation's tx — registry used the client
    expect(f.committed.some((c) => /is_active = true/.test(c.sql))).toBe(true);
    expect(f.committed.at(-1)!.sql).toMatch(/INSERT INTO admin_audit_events/);
  });

  it('FAILURE INJECTION: activate commits nothing when the audit row fails', async () => {
    const f = makeFake({
      rows: enabledRow,
      failOn: (sql) => /INSERT INTO admin_audit_events/.test(sql),
    });
    const registry = createRegistryService(f.db);
    const audit = createAuditService(f.db);
    await expect(
      auditedMutation(
        f.db,
        audit,
        (client) => registry.activateVersion('biz', '1.0.0', client),
        () => auditInput({ action: 'business.activate' })
      )
    ).rejects.toThrow(/injected failure/);
    expect(f.committed).toEqual([]);
    expect(f.txCount()).toBe(1);
  });

  it('standalone call (no client) still runs in its own tx', async () => {
    const f = makeFake({ rows: enabledRow });
    const registry = createRegistryService(f.db);
    await registry.activateVersion('biz', '1.0.0');
    expect(f.txCount()).toBe(1);
    expect(f.committed.some((c) => /is_active = true/.test(c.sql))).toBe(true);
  });

  it('drain + audit atomic', async () => {
    const f = makeFake({
      rows: (sql) => (sql.includes('SELECT status, is_active') ? [{ status: 'ENABLED', is_active: true }] : []),
    });
    const registry = createRegistryService(f.db);
    const audit = createAuditService(f.db);
    const result = await auditedMutation(
      f.db,
      audit,
      (client) => registry.deactivateVersion('biz', '1.0.0', client),
      () => auditInput({ action: 'business.drain', severity: 'warning' })
    );
    expect(result).toMatchObject({ active: false, replayed: false });
    expect(f.committed.at(-1)!.sql).toMatch(/INSERT INTO admin_audit_events/);
  });
});

describe('R3-01 profiles.createRevision joins the route transaction', () => {
  const rows = (sql: string) =>
    sql.includes('FROM api_keys')
      ? [{ id: 'key-9', tenant_id: 'ten-9' }]
      : sql.includes('max(revision)')
        ? [{ m: 2 }]
        : [];

  it('binding INSERT + audit INSERT commit together, audit carries the tenant', async () => {
    const f = makeFake({ rows });
    const profiles = createProfileService(f.db);
    const audit = createAuditService(f.db);
    const result = await auditedMutation(
      f.db,
      audit,
      (client) =>
        profiles.createRevision(
          {
            apiKeyHash: 'hash-x',
            businessId: 'biz',
            businessVersion: '1.0.0',
            action: 'extract',
            connectorBindings: { ocr: { connectorId: 'c1', revision: 1 } },
          },
          client
        ),
      (r) =>
        auditInput({
          tenantId: r.tenantId,
          action: 'profile_binding.bind',
          resource: `apikey:${r.apiKeyId}`,
          severity: 'info',
        })
    );
    expect(result).toMatchObject({ revision: 3, tenantId: 'ten-9', apiKeyId: 'key-9' });
    expect(f.txCount()).toBe(1);
    const binding = f.committed.find((c) => /INSERT INTO profile_bindings/.test(c.sql));
    const ledger = f.committed.find((c) => /INSERT INTO admin_audit_events/.test(c.sql));
    expect(binding).toBeDefined();
    expect(ledger).toBeDefined();
    expect(ledger!.params).toContain('ten-9');
    expect(ledger!.params).toContain('apikey:key-9');
  });

  it('FAILURE INJECTION: no orphan profile revision when the audit INSERT fails', async () => {
    const f = makeFake({
      rows,
      failOn: (sql) => /INSERT INTO admin_audit_events/.test(sql),
    });
    const profiles = createProfileService(f.db);
    const audit = createAuditService(f.db);
    await expect(
      auditedMutation(
        f.db,
        audit,
        (client) =>
          profiles.createRevision(
            {
              apiKeyHash: 'hash-x',
              businessId: 'biz',
              businessVersion: '1.0.0',
              action: 'extract',
              connectorBindings: { ocr: { connectorId: 'c1', revision: 1 } },
            },
            client
          ),
        () => auditInput({ action: 'profile_binding.bind' })
      )
    ).rejects.toThrow(/injected failure/);
    expect(f.committed.some((c) => /INSERT INTO profile_bindings/.test(c.sql))).toBe(false);
    expect(f.committed).toEqual([]);
  });

  it("standalone createRevision is transactional too (was untx'ed pre-fix)", async () => {
    const f = makeFake({ rows });
    const profiles = createProfileService(f.db);
    await profiles.createRevision({
      apiKeyHash: 'hash-x',
      businessId: 'biz',
      businessVersion: '1.0.0',
      action: 'extract',
      connectorBindings: { ocr: { connectorId: 'c1', revision: 1 } },
    });
    expect(f.txCount()).toBe(1);
    expect(f.committed.every((c) => c.via === 'tx')).toBe(true);
  });
});

describe('R3-01 lifecycle.sweepDeadlines joins the route transaction', () => {
  it('sweep + audit commit as one unit', async () => {
    const f = makeFake({
      rows: (sql) => (/UPDATE operations SET state='TIMED_OUT'/.test(sql) ? [{ id: 'op-1' }] : []),
    });
    const lifecycle = createLifecycleService(f.db);
    const audit = createAuditService(f.db);
    const count = await auditedMutation(
      f.db,
      audit,
      (client) => lifecycle.sweepDeadlines(client),
      () => auditInput({ action: 'operation.deadline', resource: 'operations:deadline-sweep', severity: 'warning' })
    );
    expect(count).toBe(1);
    expect(f.txCount()).toBe(1);
    expect(f.committed.at(-1)!.sql).toMatch(/INSERT INTO admin_audit_events/);
    expect(f.committed.some((c) => /TIMED_OUT/.test(c.sql))).toBe(true);
  });

  it('FAILURE INJECTION: timed-out rows are NOT persisted when the audit row fails', async () => {
    const f = makeFake({
      rows: (sql) => (/UPDATE operations SET state='TIMED_OUT'/.test(sql) ? [{ id: 'op-1' }] : []),
      failOn: (sql) => /INSERT INTO admin_audit_events/.test(sql),
    });
    const lifecycle = createLifecycleService(f.db);
    const audit = createAuditService(f.db);
    await expect(
      auditedMutation(
        f.db,
        audit,
        (client) => lifecycle.sweepDeadlines(client),
        () => auditInput({ action: 'operation.deadline' })
      )
    ).rejects.toThrow(/injected failure/);
    expect(f.committed).toEqual([]);
  });
});
