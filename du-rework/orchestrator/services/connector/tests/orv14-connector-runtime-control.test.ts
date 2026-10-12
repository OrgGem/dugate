import { PostgresConnectorReplicaRuntimeControl } from '../src/db/replica-runtime-controls';
import { PostgresInvocationLedger } from '../src/db/repository';
import type { SqlClient, SqlResult } from '../src/db/sql';
import type { ConnectorReplicaIdentity } from '@du/contracts';

const IDENTITY: ConnectorReplicaIdentity = {
  slot: 'green',
  runtimeIdentity: 'connector-green-v7',
  replicaId: 'connector-green-1',
  revision: 'build-7',
  imageDigest: `registry.example/connector@sha256:${'a'.repeat(64)}`,
};

class RuntimeControlDb implements SqlClient {
  public control: Record<string, unknown> | undefined;
  public activeInvocations = 0;

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    if (text.includes('FROM connector_replica_runtime_controls')) {
      return { rows: this.control ? [this.control as unknown as Row] : [] };
    }
    if (text.includes('INSERT INTO connector_replica_runtime_controls')) {
      const [replicaId, slot, runtimeIdentity, revision, imageDigest, timestamp, processBootId] = parameters;
      this.control = {
        replica_id: replicaId, slot, runtime_identity: runtimeIdentity, revision, image_digest: imageDigest,
        control_revision: 1, control_state: 'OPEN', requested_at: timestamp, acknowledged_at: '-infinity',
        process_boot_id: processBootId, acknowledged_boot_id: null,
      };
      return { rows: [] };
    }
    if (text.includes('SET process_boot_id')) {
      const [replicaId, processBootId, timestamp] = parameters;
      if (this.control?.replica_id !== replicaId) return { rows: [], rowCount: 0 };
      this.control = { ...this.control, process_boot_id: processBootId, acknowledged_at: '-infinity',
        acknowledged_boot_id: null, updated_at: timestamp };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM connector_invocations') && text.includes('count(*)')) {
      return { rows: [{ count: String(this.activeInvocations) } as unknown as Row] };
    }
    if (text.includes('SET acknowledged_at=$2,acknowledged_boot_id=$3')) {
      const [replicaId, timestamp, processBootId, revision] = parameters;
      const control = this.control;
      if (!control || control.replica_id !== replicaId) return { rows: [] };
      if (control.process_boot_id !== processBootId || Number(control.control_revision) !== revision) return { rows: [] };
      this.control = { ...control, acknowledged_at: timestamp, acknowledged_boot_id: processBootId };
      return { rows: [{ acknowledged_at: timestamp, acknowledged_boot_id: processBootId } as unknown as Row] };
    }
    if (text.includes('UPDATE connector_replica_runtime_controls')) {
      const [replicaId, state, requestedAt, expectedRevision, processBootId] = parameters;
      const current = this.control;
      if (!current || current.replica_id !== replicaId || Number(current.control_revision) !== expectedRevision
        || current.process_boot_id !== processBootId) return { rows: [] };
      this.control = {
        ...current,
        control_revision: Number(current.control_revision) + 1,
        control_state: state,
        requested_at: requestedAt,
        acknowledged_at: '-infinity',
        acknowledged_boot_id: null,
      };
      return { rows: [{ control_revision: this.control.control_revision, requested_at: requestedAt } as unknown as Row] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

describe('ORV14 Connector replica drain controls', () => {
  it('registers immutable identity, counts unresolved work, and CASes drain/resume durably', async () => {
    const db = new RuntimeControlDb();
    const fixedNow = () => new Date('2026-10-11T12:00:00.000Z');
    const control = new PostgresConnectorReplicaRuntimeControl(db, IDENTITY, fixedNow);
    await control.register();

    const open = await control.observe(IDENTITY, async () => true);
    expect(open).toMatchObject({
      service: 'connector', readiness: 'READY', controlRevision: 1, controlState: 'OPEN',
      work: { connectorInvocations: { applicable: true, count: 0 }, workerLeases: { applicable: false, count: null } },
    });

    const drain = await control.requestDrain({
      ...IDENTITY, expectedRevision: IDENTITY.revision, expectedImageDigest: IDENTITY.imageDigest,
      expectedControlRevision: 1, reason: 'maintenance-rollout',
    });
    expect(drain.controlRevision).toBe(2);
    expect(await control.observe(IDENTITY, async () => true)).toMatchObject({
      readiness: 'DRAINING', controlState: 'DRAINING', controlRevision: 2,
      work: { connectorInvocations: { count: 0 } },
    });

    // A durable UNKNOWN/PENDING/etc. record prevents a false drain ACK.
    db.activeInvocations = 1;
    expect(await control.observe(IDENTITY, async () => true)).toMatchObject({
      readiness: 'DRAINING', work: { connectorInvocations: { count: 1 } },
    });
    await expect(control.requestResume({
      ...IDENTITY, expectedRevision: IDENTITY.revision, expectedImageDigest: IDENTITY.imageDigest,
      expectedControlRevision: 1, reason: 'maintenance-rollback',
    })).rejects.toThrow('Replica control revision changed');

    const resume = await control.requestResume({
      ...IDENTITY, expectedRevision: IDENTITY.revision, expectedImageDigest: IDENTITY.imageDigest,
      expectedControlRevision: 2, reason: 'maintenance-rollback',
    });
    expect(resume.controlRevision).toBe(3);
    expect(await control.observe(IDENTITY, async () => false)).toMatchObject({
      readiness: 'DEGRADED', controlState: 'OPEN', controlRevision: 3,
      work: { connectorInvocations: { count: 1 } },
    });
  });

  it('fences acknowledgements to the process boot that owns the row', async () => {
    const db = new RuntimeControlDb();
    const fixedNow = () => new Date('2026-10-11T12:10:00.000Z');
    const oldBoot = '11111111-1111-4111-8111-111111111111';
    const currentBoot = '22222222-2222-4222-8222-222222222222';
    const oldProcess = new PostgresConnectorReplicaRuntimeControl(db, IDENTITY, fixedNow, { bootId: oldBoot });
    await oldProcess.register();
    const currentProcess = new PostgresConnectorReplicaRuntimeControl(db, IDENTITY, fixedNow, { bootId: currentBoot });
    await currentProcess.register();

    const stateBeforeStaleCommands = { ...db.control };
    await expect(oldProcess.requestDrain({
      ...IDENTITY, expectedRevision: IDENTITY.revision, expectedImageDigest: IDENTITY.imageDigest,
      expectedControlRevision: 1, reason: 'maintenance-rollout',
    })).rejects.toThrow('stale process boot');
    await expect(oldProcess.requestResume({
      ...IDENTITY, expectedRevision: IDENTITY.revision, expectedImageDigest: IDENTITY.imageDigest,
      expectedControlRevision: 1, reason: 'maintenance-rollback',
    })).rejects.toThrow('stale process boot');
    expect(db.control).toEqual(stateBeforeStaleCommands);

    await expect(oldProcess.observe(IDENTITY, async () => true)).rejects.toThrow('owned by another process boot');
    expect(db.control?.acknowledged_at).toBe('-infinity');
    expect(db.control?.acknowledged_boot_id).toBeNull();

    const current = await currentProcess.observe(IDENTITY, async () => true);
    expect(current.bootId).toBe(currentBoot);
    expect(current).toMatchObject({ controlAcknowledgedBootId: currentBoot });
    expect(db.control?.process_boot_id).toBe(currentBoot);
    expect(db.control?.acknowledged_boot_id).toBe(currentBoot);
  });

  it('refuses a first invocation claim after the durable drain fence closes', async () => {
    const db: SqlClient = {
      query: async <Row extends object = Record<string, unknown>>(text: string): Promise<SqlResult<Row>> => {
        if (text.includes('connector_replica_runtime_controls')) return { rows: [{ control_state: 'DRAINING' } as unknown as Row] };
        if (text.includes('FROM connector_invocations')) return { rows: [] };
        throw new Error(`Unexpected SQL: ${text}`);
      },
      transaction: async <T>(callback: (client: SqlClient) => Promise<T>) => callback(db),
    };
    const ledger = new PostgresInvocationLedger(db, { replicaId: IDENTITY.replicaId, legacyPlaintextReads: true });
    await expect(ledger.claim({
      contractVersion: '1', invocationId: 'invocation-1', tenantId: 'tenant-1', operationId: 'operation-1',
      taskId: 'task-1', stepKey: 'step-1', bindingSlot: 'slot-1', input: { prompt: 'safe' },
      deadlineAt: '2026-10-11T12:05:00.000Z',
    }, 'a'.repeat(64))).rejects.toMatchObject({ code: 'CONNECTOR_DISABLED' });
  });
});
