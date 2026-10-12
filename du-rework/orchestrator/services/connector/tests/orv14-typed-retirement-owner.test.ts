import { PostgresConnectorParityRepository } from '../src/db/parity-repository';
import type { SqlClient, SqlResult } from '../src/db/sql';
import { createConnectorServer } from '../src/http/server';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const CONNECTOR = 'tenant-owned-recipe';

class RetirementDb implements SqlClient {
  public currentRevision: number | null;
  public targetState: 'PENDING' | 'ACTIVE' | 'RETIRED' | undefined;
  public pendingDraft = false;
  public currentReads = 0;
  public writes = 0;
  private readonly receipts = new Map<string, {
    payload_hash: string;
    retired: boolean;
    current_revision: number | null;
  }>();

  public constructor(public owner: string | undefined, currentRevision: number | null, targetState: RetirementDb['targetState']) {
    this.currentRevision = currentRevision;
    this.targetState = targetState;
  }

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.includes('SELECT tenant_id FROM connector_parity_chains')) {
      return { rows: this.owner ? [{ tenant_id: this.owner } as unknown as Row] : [] };
    }
    if (text.includes('SELECT payload_hash,retired,current_revision FROM connector_parity_retire_intents')) {
      const key = String(parameters[2]);
      const receipt = this.receipts.get(key);
      return { rows: receipt ? [receipt as unknown as Row] : [] };
    }
    if (text.includes('SELECT idempotency_key FROM connector_parity_draft_intents')) {
      return { rows: this.pendingDraft ? [{ idempotency_key: 'pending-draft-key' } as unknown as Row] : [] };
    }
    if (text.includes("state='ACTIVE' FOR UPDATE")) {
      this.currentReads += 1;
      return { rows: this.currentRevision === null ? [] : [{ revision: this.currentRevision } as unknown as Row] };
    }
    if (text.includes('SELECT state FROM connector_parity_revisions')) {
      return { rows: this.targetState ? [{ state: this.targetState } as unknown as Row] : [] };
    }
    if (text.includes("UPDATE connector_parity_revisions SET state='RETIRED'")) {
      this.writes += 1;
      this.targetState = 'RETIRED';
      if (String(parameters[3]) === 'ACTIVE') this.currentRevision = null;
      return { rows: [] };
    }
    if (text.includes('INSERT INTO connector_parity_retire_intents')) {
      const [tenantId, connectorId, _revision, key, payloadHash, _reason, retired, currentRevision] = parameters;
      this.receipts.set(String(key), {
        payload_hash: String(payloadHash),
        retired: Boolean(retired),
        current_revision: currentRevision === null ? null : Number(currentRevision),
      });
      return { rows: [] };
    }
    throw new Error('Unexpected SQL in retirement test: ' + text);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

describe('ORV14 tenant-owned typed Connector retirement', () => {
  it('serves the scoped typed retirement route with strict request and acknowledgement DTOs', async () => {
    let called: unknown;
    let scopes = ['connector:management'];
    const server = createConnectorServer({
      management: {} as never,
      parityManagement: {
        retireRevision: async (input: unknown) => {
          called = input;
          return { retired: true, currentRevision: null };
        },
      } as never,
      runtime: {} as never,
      capabilities: () => ({}),
      ready: async () => true,
      identityVerifier: {
        verify: async () => ({ subject: 'owner-test', audience: 'connector', scopes }),
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Connector test server did not bind');
    const url = `http://127.0.0.1:${address.port}/internal/admin/connector-revisions/${encodeURIComponent(CONNECTOR)}/4/retire`;

    try {
      const body = {
        tenantId: TENANT,
        expectedCurrentRevision: 4,
        idempotencyKey: 'retire-route-0001',
        reason: 'PROFILE_UNBOUND',
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ retired: true, currentRevision: null });
      expect(called).toEqual({ ...body, connectorId: CONNECTOR, revision: 4 });

      scopes = ['connector:invoke'];
      const denied = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(403);
      expect(called).toEqual({ ...body, connectorId: CONNECTOR, revision: 4 });

      scopes = ['connector:management'];
      const malformed = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-test', 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, unexpected: true }),
      });
      expect(malformed.status).toBe(400);
      expect(called).toEqual({ ...body, connectorId: CONNECTOR, revision: 4 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('retires an active revision with CAS and replays the exact durable acknowledgement', async () => {
    const db = new RetirementDb(TENANT, 4, 'ACTIVE');
    const repository = new PostgresConnectorParityRepository(db);
    const input = {
      tenantId: TENANT,
      connectorId: CONNECTOR,
      revision: 4,
      expectedCurrentRevision: 4,
      idempotencyKey: 'retire-active-0001',
      reason: 'OPERATOR_RETIRE' as const,
    };

    await expect(repository.retireRevision(input)).resolves.toEqual({ retired: true, currentRevision: null });
    await expect(repository.retireRevision(input)).resolves.toEqual({ retired: true, currentRevision: null });

    expect(db.targetState).toBe('RETIRED');
    expect(db.currentRevision).toBeNull();
    expect(db.writes).toBe(1);
    // Exact replay returns before reading mutable active state.
    expect(db.currentReads).toBe(1);
    await expect(repository.retireRevision({ ...input, reason: 'PROFILE_UNBOUND' }))
      .rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH' });
  });

  it('retires a pending revision without changing the existing active revision', async () => {
    const db = new RetirementDb(TENANT, 2, 'PENDING');
    const repository = new PostgresConnectorParityRepository(db);

    await expect(repository.retireRevision({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      revision: 3,
      expectedCurrentRevision: 2,
      idempotencyKey: 'retire-pending-0001',
      reason: 'LEGACY_DISABLED_IMPORT',
    })).resolves.toEqual({ retired: true, currentRevision: 2 });

    expect(db.targetState).toBe('RETIRED');
    expect(db.currentRevision).toBe(2);
  });

  it('does not reveal or mutate a connector chain owned by another tenant', async () => {
    const db = new RetirementDb(OTHER_TENANT, 7, 'ACTIVE');
    const repository = new PostgresConnectorParityRepository(db);

    await expect(repository.retireRevision({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      revision: 7,
      expectedCurrentRevision: 7,
      idempotencyKey: 'retire-foreign-0001',
      reason: 'OPERATOR_RETIRE',
    })).resolves.toEqual({ retired: false, currentRevision: null });

    expect(db.writes).toBe(0);
    expect(db.currentReads).toBe(0);
  });

  it('refuses to retire while a typed Vault draft intent is unresolved', async () => {
    const db = new RetirementDb(TENANT, 4, 'ACTIVE');
    db.pendingDraft = true;
    const repository = new PostgresConnectorParityRepository(db);

    await expect(repository.retireRevision({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      revision: 4,
      expectedCurrentRevision: 4,
      idempotencyKey: 'retire-pending-intent-01',
      reason: 'OPERATOR_RETIRE',
    })).resolves.toEqual({ retired: false, currentRevision: 4 });

    expect(db.targetState).toBe('ACTIVE');
    expect(db.writes).toBe(0);
  });
});
