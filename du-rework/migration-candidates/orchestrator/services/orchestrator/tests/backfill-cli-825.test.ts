import {
  CONTROL_PLANE_SLOT_SPECS,
  ControlPlanePgMigrationStore,
  isControlPlaneSlot,
  type ControlPlaneSealer,
} from '../src/modules/encryption/legacy-payload-migration';
import { METADATA_AUTH_SLOT_SPECS } from '../src/modules/encryption/metadata-auth-counter';
import {
  BACKFILL_METADATA_EXIT_REFUSED,
  CONTROL_PLANE_SLOT_COUNT,
  databaseApproval,
  evaluateBackfillGate,
} from '../src/modules/encryption/backfill-metadata-cli';

/** BACKFILL-CLI-825: the CLI must be able to refuse, and the store must cover
 * all 8 slots with the exact bindings the writers use. */
describe('evaluateBackfillGate (fail-closed on unresolved data)', () => {
  const pass = {
    gate: 'PASS' as const, blockers: 0, slotsScanned: 8, slotsExpected: 8, rowsVisible: 12,
  };
  it('PASS with every slot scanned proceeds', () => {
    const decision = evaluateBackfillGate(pass);
    expect(decision.proceed).toBe(true);
  });

  it('refuses while any slot is unresolved', () => {
    const decision = evaluateBackfillGate({ ...pass, gate: 'FAIL', blockers: 3 });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('3 unresolved');
  });

  it('refuses when fewer slots were scanned than expected', () => {
    const decision = evaluateBackfillGate({ ...pass, slotsScanned: 7 });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toContain('7/8');
  });

  it('a zero-row run with full coverage still passes (empty is not unresolved)', () => {
    expect(evaluateBackfillGate({ ...pass, rowsVisible: 0 }).proceed).toBe(true);
  });
});

describe('databaseApproval', () => {
  it('refuses a production database without the approval flag', () => {
    const decision = databaseApproval({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x@db/prod' }, false);
    expect(decision.approved).toBe(false);
  });
  it('allows a production database with the approval flag', () => {
    expect(databaseApproval({ NODE_ENV: 'production' }, true).approved).toBe(true);
  });
  it('approves a non-production database without the flag', () => {
    expect(databaseApproval({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x@127.0.0.1:5433/du_gate_test' }, false).approved).toBe(true);
  });
  it('spots a production URL even when NODE_ENV is unset', () => {
    expect(databaseApproval({ DATABASE_URL: 'postgres://x@db.du.example/production' }, false).approved).toBe(false);
  });
});

describe('CONTROL_PLANE_SLOT_SPECS covers all 8 METADATA_SLOTS', () => {
  it('has exactly the 8 auth-counter slots', () => {
    expect(CONTROL_PLANE_SLOT_SPECS.map((s) => s.slot).sort())
      .toEqual(METADATA_AUTH_SLOT_SPECS.map((s) => s.slot).sort());
    expect(CONTROL_PLANE_SLOT_COUNT).toBe(8);
  });

  it('mirrors table/column/kind of the auth counter exactly', () => {
    for (const spec of CONTROL_PLANE_SLOT_SPECS) {
      const auth = METADATA_AUTH_SLOT_SPECS.find((s) => s.slot === spec.slot);
      expect(auth).toBeDefined();
      expect(spec.table).toBe(auth!.table);
      expect(spec.column).toBe(auth!.column);
      expect(spec.kind).toBe(auth!.kind);
      expect(spec.tenantExpr).toBe(auth!.tenantExpr);
      expect(spec.refIdExpr).toBe(auth!.refIdExpr);
    }
  });

  it('validates its own slot names', () => {
    expect(isControlPlaneSlot('operations.input_ref')).toBe(true);
    expect(isControlPlaneSlot('artifact')).toBe(false);
    expect(isControlPlaneSlot('operations.nope')).toBe(false);
  });
});

describe('ControlPlanePgMigrationStore', () => {
  const sealer: ControlPlaneSealer = {
    isSealed: () => false,
    seal: async () => ({ version: 1 }),
    open: async () => 'opened',
  };

  function fakeDb(rows: Record<string, unknown>[]) {
    const seen: string[] = [];
    return {
      queries: seen,
      async query(sql: string) {
        seen.push(sql);
        return { rows, rowCount: rows.length };
      },
    };
  }

  it('queries every slot, not just result_ref', async () => {
    const db = fakeDb([]);
    const store = new ControlPlanePgMigrationStore({ db: db as never, sealer });
    await store.listPayloadIds();
    expect(db.queries).toHaveLength(8);
    expect(db.queries.some((q) => q.includes('input_ref'))).toBe(true);
    expect(db.queries.some((q) => q.includes('payload_ref'))).toBe(true);
    expect(db.queries.some((q) => q.includes('response_ref'))).toBe(true);
    expect(db.queries.some((q) => q.includes('output_ref'))).toBe(true);
    expect(db.queries.some((q) => q.includes('session_ref'))).toBe(true);
    expect(db.queries.some((q) => q.includes('prompt_overrides_ref'))).toBe(true);
    expect(db.queries.filter((q) => q.includes('result_ref'))).toHaveLength(2);
  });

  it('names payloads by slot and row key', async () => {
    const db = fakeDb([{ ref_id: 'row-1', tenant_id: 'tenant-1', value: { a: 1 } }]);
    const store = new ControlPlanePgMigrationStore({ db: db as never, sealer });
    const ids = await store.listPayloadIds();
    expect(ids).toHaveLength(8);
    expect(ids.every((id) => id.endsWith(':row-1'))).toBe(true);
    expect(ids[0]).toContain(':');
  });

  it('counts jsonb and text plaintext rows as unresolved references', async () => {
    const db = fakeDb([{ ref_id: 'row-1', tenant_id: 't', value: { a: 1 } }]);
    const store = new ControlPlanePgMigrationStore({ db: db as never, sealer });
    const counts = await store.inventory();
    // 8 slots x 1 plaintext row each from the fake driver.
    expect(counts.plaintextPayloads).toBe(8);
    expect(counts.encryptedPayloads).toBe(0);
    expect(counts.unresolvedReferences).toBe(8);
  });

  it('refuses to lock a row when a bounded window has expired', async () => {
    const db = fakeDb([]);
    const store = new ControlPlanePgMigrationStore({
      db: db as never,
      sealer,
      window: { startsAtMs: 0, expiresAtMs: 1, allowsLegacyRead: () => false },
    });
    await expect(store.withPayloadLocked('operations.input_ref:row-1', async () => 'never'))
      .rejects.toThrow('bounded dual-read window is closed');
  });
  it('exit code for a refusal is non-zero', () => {
    expect(BACKFILL_METADATA_EXIT_REFUSED).not.toBe(0);
  });
});
