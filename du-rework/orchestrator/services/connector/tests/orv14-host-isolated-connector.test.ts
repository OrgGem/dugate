import type { ConnectorReplicaIdentity } from '@du/contracts';
import { createConnectorComposition } from '../src/composition';
import { PostgresConnectorReplicaRuntimeControl } from '../src/db/replica-runtime-controls';
import type { SqlClient, SqlResult } from '../src/db/sql';
import { isolatedConnectorRequestAllowed } from '../src/http/server';
import { connectorIsolatedRestoreModeFromEnvironment } from '../src/isolated-mode';

const IDENTITY: ConnectorReplicaIdentity = {
  slot: 'green',
  runtimeIdentity: 'connector-green-restore',
  replicaId: 'connector-green-restore-1',
  revision: 'restore-build-7',
  imageDigest: `registry.example/connector@sha256:${'b'.repeat(64)}`,
};

class RestoreControlDb implements SqlClient {
  public readonly sql: string[] = [];
  public control: Record<string, unknown> | undefined;
  public unresolvedCount = 2;
  private readonly capturedParameters: unknown[][] = [];

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    this.sql.push(text);
    this.capturedParameters.push([...parameters]);
    if (text.includes('FROM connector_replica_runtime_controls')) {
      return { rows: this.control ? [this.control as unknown as Row] : [] };
    }
    if (text.includes('SET process_boot_id')) {
      const [replicaId, processBootId, updatedAt] = parameters;
      if (this.control?.replica_id !== replicaId) return { rows: [], rowCount: 0 };
      this.control = { ...this.control, process_boot_id: processBootId, acknowledged_at: '-infinity',
        acknowledged_boot_id: null, updated_at: updatedAt };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("current_setting('cluster_name'")) {
      return { rows: [{ cluster_name: 'connector-restore-cluster' } as unknown as Row] };
    }
    if (text.includes('FROM connector_invocations') && text.includes('count(*)')) {
      return { rows: [{ count: String(this.unresolvedCount) } as unknown as Row] };
    }
    if (text.includes('SET acknowledged_at=$2,acknowledged_boot_id=$3')) {
      const [replicaId, acknowledgedAt, bootId, revision] = parameters;
      const control = this.control;
      if (!control || control.replica_id !== replicaId) return { rows: [] };
      if (control.process_boot_id !== bootId || Number(control.control_revision) !== revision) return { rows: [] };
      this.control = { ...control, acknowledged_at: acknowledgedAt, acknowledged_boot_id: bootId };
      return { rows: [{ acknowledged_at: acknowledgedAt, acknowledged_boot_id: bootId } as unknown as Row] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }

  public allParameters(): readonly unknown[][] {
    return this.capturedParameters;
  }
}

function controlRow(controlState: 'OPEN' | 'DRAINING', acknowledgedAt: string | number): Record<string, unknown> {
  return {
    slot: IDENTITY.slot,
    runtime_identity: IDENTITY.runtimeIdentity,
    replica_id: IDENTITY.replicaId,
    revision: IDENTITY.revision,
    image_digest: IDENTITY.imageDigest,
    control_revision: 4,
    control_state: controlState,
    requested_at: '2026-10-11T12:00:00.000Z',
    acknowledged_at: acknowledgedAt,
    process_boot_id: null,
    acknowledged_boot_id: null,
  };
}

describe('ORV14 isolated Connector restore rehearsal', () => {
  it('accepts only the explicit restore-rehearsal environment mode', () => {
    expect(connectorIsolatedRestoreModeFromEnvironment({})).toBe(false);
    expect(connectorIsolatedRestoreModeFromEnvironment({ CONNECTOR_ISOLATED_RUNTIME_MODE: 'restore-rehearsal' })).toBe(true);
    expect(() => connectorIsolatedRestoreModeFromEnvironment({ CONNECTOR_ISOLATED_RUNTIME_MODE: 'true' }))
      .toThrow('must be restore-rehearsal');
  });

  it('requires a host-pinned identity when isolated mode is selected', () => {
    expect(() => createConnectorComposition({
      port: 0,
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      isolatedRestoreRehearsal: true,
    }, {
      http: {
        management: {} as never,
        runtime: {} as never,
        capabilities: () => ({}),
        ready: async () => true,
        allowUnauthenticatedTestTraffic: true,
      },
    })).toThrow('requires an exact runtime-control identity');
  });

  it('permits only reads and the authenticated runtime-control observation endpoint', () => {
    expect(isolatedConnectorRequestAllowed('GET', '/internal/admin/signals/usage')).toBe(true);
    expect(isolatedConnectorRequestAllowed('GET', '/connectors')).toBe(true);
    expect(isolatedConnectorRequestAllowed('GET', '/invocations/previously-unknown')).toBe(false);
    expect(isolatedConnectorRequestAllowed('POST', '/internal/admin/runtime-control/observe')).toBe(true);
    expect(isolatedConnectorRequestAllowed('POST', '/internal/admin/invocations')).toBe(false);
    expect(isolatedConnectorRequestAllowed('POST', '/internal/admin/runtime-control/drain')).toBe(false);
    expect(isolatedConnectorRequestAllowed('POST', '/internal/admin/provider-tests')).toBe(false);
    expect(isolatedConnectorRequestAllowed('PUT', '/internal/admin/runtime-control/observe')).toBe(false);
  });

  it('requires pre-seeded exact DRAINING state and counts all unresolved source history', async () => {
    const db = new RestoreControlDb();
    // node-postgres parses PostgreSQL timestamptz -infinity as numeric
    // -Infinity; it must remain a non-fresh sentinel until observe writes
    // a real acknowledgement from this boot.
    db.control = controlRow('DRAINING', Number.NEGATIVE_INFINITY);
    const control = new PostgresConnectorReplicaRuntimeControl(db, IDENTITY, () => new Date('2026-10-11T12:30:00.000Z'), {
      countAllUnresolvedInvocations: true,
    });

    await expect(control.assertPreseededDrain()).resolves.toBeUndefined();
    await control.claimPreseededDrain();
    const observation = await control.observe(IDENTITY, async () => true);

    expect(observation).toMatchObject({
      readiness: 'DRAINING',
      controlState: 'DRAINING',
      controlRevision: 4,
      controlAcknowledgedAt: '2026-10-11T12:30:00.000Z',
      bootId: expect.any(String),
      controlAcknowledgedBootId: expect.any(String),
      work: { connectorInvocations: { applicable: true, count: 2 } },
    });
    const countSql = db.sql.find((sql) => sql.includes('count(*)')) ?? '';
    expect(countSql).toContain('WHERE state = ANY($1::text[])');
    expect(countSql).not.toContain('owner_replica_id');
    expect(db.control?.acknowledged_at).toBe('2026-10-11T12:30:00.000Z');
    expect(db.control?.acknowledged_boot_id).toBe(db.control?.process_boot_id);
  });

  it('returns actual isolated process, database, and disabled-effect observations', async () => {
    const db = new RestoreControlDb();
    db.control = controlRow('DRAINING', Number.NEGATIVE_INFINITY);
    const control = new PostgresConnectorReplicaRuntimeControl(db, IDENTITY,
      () => new Date('2026-10-11T12:31:00.000Z'), { countAllUnresolvedInvocations: true, bootId: '33333333-3333-4333-8333-333333333333' });
    await control.claimPreseededDrain();
    const externalEffects = {
      admission: 'DISABLED', dispatch: 'DISABLED', providerInvocation: 'DISABLED', connectorPoll: 'DISABLED',
      usageDelivery: 'DISABLED', webhookDelivery: 'DISABLED', alertEmission: 'DISABLED', cleanup: 'DISABLED',
      historicalMaintenance: 'DISABLED', migrations: 'DISABLED',
    } as const;
    const observation = await control.observe(IDENTITY, async () => true, async () => ({
      observedAt: '2026-10-11T12:31:00.000Z',
      postgres: { state: 'HEALTHY', observedAt: '2026-10-11T12:30:59.990Z' },
      redis: { state: 'HEALTHY', observedAt: '2026-10-11T12:30:59.995Z' },
    }), externalEffects);
    expect(observation).toMatchObject({
      clusterName: 'connector-restore-cluster', liveness: 'LIVE',
      dependencies: { postgres: { state: 'HEALTHY' }, redis: { state: 'HEALTHY' } },
      externalEffects, controlState: 'DRAINING',
      bootId: '33333333-3333-4333-8333-333333333333',
      controlAcknowledgedBootId: '33333333-3333-4333-8333-333333333333',
    });
    expect(observation.livenessObservedAt).toBe(observation.observedAt);
  });

  it('does not create or repair a missing/open restore control row', async () => {
    const missing = new PostgresConnectorReplicaRuntimeControl(new RestoreControlDb(), IDENTITY);
    await expect(missing.assertPreseededDrain()).rejects.toThrow('not pre-seeded');

    const openDb = new RestoreControlDb();
    openDb.control = controlRow('OPEN', Number.NEGATIVE_INFINITY);
    const open = new PostgresConnectorReplicaRuntimeControl(openDb, IDENTITY);
    await expect(open.assertPreseededDrain()).rejects.toThrow('not durably draining');
    expect(openDb.sql.some((sql) => sql.includes('INSERT INTO connector_replica_runtime_controls'))).toBe(false);
  });
});
