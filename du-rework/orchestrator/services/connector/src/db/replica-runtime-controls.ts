import { randomUUID } from 'node:crypto';
import {
  ConnectorReplicaControlCommandSchema,
  ConnectorReplicaRuntimeObservationSchema,
  type ConnectorReplicaControlAck,
  type ConnectorReplicaControlCommand,
  type ConnectorReplicaIdentity,
  type ConnectorReplicaRuntimeObservation,
} from '@du/contracts';
import { ConnectorError } from '../errors';
import type { SqlClient } from './sql';

interface ControlRow {
  slot: string;
  runtime_identity: string;
  replica_id: string;
  revision: string;
  image_digest: string;
  control_revision: number | string;
  control_state: 'OPEN' | 'DRAINING';
  requested_at: Date | string;
  acknowledged_at: Date | string | number;
  process_boot_id: string | null;
  acknowledged_boot_id: string | null;
}

const ACTIVE_STATES = ['IN_FLIGHT', 'PENDING', 'POLLING', 'UNKNOWN'] as const;

/** Durable local control state for one host-pinned Connector replica. The
 * control row is also the mutex shared with first invocation claims, so a
 * drain request cannot race an invocation into the provider dispatch path. */
export class PostgresConnectorReplicaRuntimeControl {
  private readonly processBootId: string;

  public constructor(
    private readonly db: SqlClient,
    private readonly identity: ConnectorReplicaIdentity,
    private readonly now: () => Date = () => new Date(),
    private readonly options: { countAllUnresolvedInvocations?: boolean; bootId?: string } = {},
  ) {
    this.processBootId = options.bootId ?? randomUUID();
    if (!isUuid(this.processBootId)) throw new Error('Connector process boot ID must be a UUID.');
  }

  /** Restore rehearsal requires the exact DRAINING row to be present before
   * the listener opens. Missing state must never be auto-created as OPEN. */
  public async assertPreseededDrain(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const selected = await tx.query<ControlRow>(
        `SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at,
                process_boot_id,acknowledged_boot_id
           FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE`,
        [this.identity.replicaId],
      );
      const row = selected.rows[0];
      if (!row) throw unavailable('isolated Connector runtime control row is not pre-seeded');
      this.assertStoredIdentity(row);
      if (row.control_state !== 'DRAINING') throw unavailable('isolated Connector runtime is not durably draining');
    });
  }

  /** Atomically claim the exact pre-seeded DRAINING row for this process boot.
   * Restore startup must not race an operator resume between validation and
   * process ownership registration. */
  public async claimPreseededDrain(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const selected = await tx.query<ControlRow>(
        `SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at,
                process_boot_id,acknowledged_boot_id
           FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE`,
        [this.identity.replicaId],
      );
      const row = selected.rows[0];
      if (!row) throw unavailable('isolated Connector runtime control row is not pre-seeded');
      this.assertStoredIdentity(row);
      if (row.control_state !== 'DRAINING') throw unavailable('isolated Connector runtime is not durably draining');
      const timestamp = this.isoNow();
      const claimed = await tx.query(
        `UPDATE connector_replica_runtime_controls
            SET process_boot_id=$2,acknowledged_at='-infinity',acknowledged_boot_id=NULL,updated_at=$3
          WHERE replica_id=$1 AND control_state='DRAINING' AND control_revision=$4`,
        [this.identity.replicaId, this.processBootId, timestamp, Number(row.control_revision)],
      );
      if (claimed.rowCount !== 1) throw unavailable('isolated Connector process boot could not claim the draining row');
    });
  }

  public async register(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const selected = await tx.query<ControlRow>(
        `SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at,
                process_boot_id,acknowledged_boot_id
           FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE`,
        [this.identity.replicaId],
      );
      const row = selected.rows[0];
      if (row) {
        this.assertStoredIdentity(row);
        const timestamp = this.isoNow();
        const claimed = await tx.query(
          `UPDATE connector_replica_runtime_controls
              SET process_boot_id=$2,acknowledged_at='-infinity',acknowledged_boot_id=NULL,updated_at=$3
            WHERE replica_id=$1`,
          [this.identity.replicaId, this.processBootId, timestamp],
        );
        if (claimed.rowCount !== 1) throw unavailable('Connector process boot could not claim its runtime-control row');
        return;
      }
      const timestamp = this.isoNow();
      await tx.query(
        `INSERT INTO connector_replica_runtime_controls
          (replica_id,slot,runtime_identity,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at,
           process_boot_id,acknowledged_boot_id)
         VALUES($1,$2,$3,$4,$5,1,'OPEN',$6,'-infinity',$7,NULL)`,
        [this.identity.replicaId, this.identity.slot, this.identity.runtimeIdentity,
          this.identity.revision, this.identity.imageDigest, timestamp, this.processBootId],
      );
    });
  }

  public async observe(
    expected: ConnectorReplicaIdentity,
    isReady: () => Promise<boolean>,
    dependencyHealth?: () => Promise<{
      observedAt: string;
      postgres: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
      redis: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
    }>,
    externalEffects?: ConnectorReplicaRuntimeObservation['externalEffects'],
  ): Promise<ConnectorReplicaRuntimeObservation> {
    this.assertExpectedIdentity(expected);
    const [healthy, dependencies] = await Promise.all([
      isReady(),
      dependencyHealth?.(),
    ]);
    return this.db.transaction(async (tx) => {
      const clusterResult = externalEffects
        ? await tx.query<{ cluster_name: string | null }>(`SELECT NULLIF(current_setting('cluster_name', true),'') AS cluster_name`)
        : undefined;
      const clusterName = clusterResult?.rows[0]?.cluster_name ?? undefined;
      if (externalEffects && !dependencies) {
        throw unavailable('isolated Connector dependency observations are unavailable');
      }
      if (externalEffects && !clusterName) throw unavailable('isolated Connector database cluster identity is unavailable');
      const selected = await tx.query<ControlRow>(
        `SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at,
                process_boot_id,acknowledged_boot_id
           FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE`,
        [this.identity.replicaId],
      );
      const row = selected.rows[0];
      if (!row) throw unavailable('replica control registration is unavailable');
      this.assertStoredIdentity(row);
      if (row.process_boot_id !== this.processBootId) {
        throw unavailable('Connector runtime-control row is owned by another process boot');
      }
      const countResult = this.options.countAllUnresolvedInvocations
        ? await tx.query<{ count: string | number }>(
          `SELECT count(*)::text AS count FROM connector_invocations WHERE state = ANY($1::text[])`,
          [ACTIVE_STATES],
        )
        : await tx.query<{ count: string | number }>(
          `SELECT count(*)::text AS count FROM connector_invocations
            WHERE state = ANY($2::text[])
              AND (owner_replica_id=$1 OR owner_replica_id IS NULL)`,
          [this.identity.replicaId, ACTIVE_STATES],
        );
      const count = Number(countResult.rows[0]?.count);
      if (!Number.isSafeInteger(count) || count < 0) throw unavailable('active invocation count is unavailable');
      const sampledAt = this.isoNow();
      const heartbeat = await tx.query<{ acknowledged_at: Date | string; acknowledged_boot_id: string }>(
        `UPDATE connector_replica_runtime_controls SET acknowledged_at=$2,acknowledged_boot_id=$3,updated_at=$2
          WHERE replica_id=$1 AND process_boot_id=$3 AND control_revision=$4
          RETURNING acknowledged_at,acknowledged_boot_id`,
        [this.identity.replicaId, sampledAt, this.processBootId, Number(row.control_revision)],
      );
      const acknowledgedAt = heartbeat.rows[0]?.acknowledged_at;
      if (!acknowledgedAt) throw unavailable('replica control acknowledgement could not be refreshed');
      const acknowledgedBootId = heartbeat.rows[0]?.acknowledged_boot_id;
      if (acknowledgedBootId !== this.processBootId) throw unavailable('Connector runtime-control boot acknowledgement could not be persisted');
      const observed = ConnectorReplicaRuntimeObservationSchema.parse({
        ...this.identity,
        service: 'connector',
        ...(clusterName ? { clusterName } : {}),
        readiness: row.control_state === 'DRAINING' ? 'DRAINING' : healthy ? 'READY' : 'DEGRADED',
        observedAt: sampledAt,
        bootId: this.processBootId,
        liveness: 'LIVE',
        livenessObservedAt: sampledAt,
        ...(dependencies ? { dependencies: {
          postgres: dependencies.postgres,
          redis: dependencies.redis,
        } } : {}),
        ...(externalEffects ? { externalEffects } : {}),
        workObservedAt: sampledAt,
        controlRevision: Number(row.control_revision),
        controlState: row.control_state,
        controlAcknowledgedAt: timestamp(acknowledgedAt),
        controlAcknowledgedBootId: acknowledgedBootId,
        work: {
          workerLeases: { applicable: false, count: null },
          sdkActiveTasks: { applicable: false, count: null },
          connectorInvocations: { applicable: true, count },
          orchestratorRequests: { applicable: false, count: null },
          dispatches: { applicable: false, count: null },
        },
      });
      return observed;
    });
  }

  public async requestDrain(command: ConnectorReplicaControlCommand): Promise<ConnectorReplicaControlAck> {
    return this.setControl(command, 'DRAINING', 'maintenance-rollout');
  }

  public async requestResume(command: ConnectorReplicaControlCommand): Promise<ConnectorReplicaControlAck> {
    return this.setControl(command, 'OPEN', 'maintenance-rollback');
  }

  private async setControl(
    raw: ConnectorReplicaControlCommand,
    target: 'OPEN' | 'DRAINING',
    reason: 'maintenance-rollout' | 'maintenance-rollback',
  ): Promise<ConnectorReplicaControlAck> {
    const command = ConnectorReplicaControlCommandSchema.parse(raw);
    this.assertExpectedIdentity(command);
    if (command.expectedRevision !== this.identity.revision
      || command.expectedImageDigest !== this.identity.imageDigest
      || command.reason !== reason) {
      throw new ConnectorError('BINDING_DENIED', 'Replica control does not match this boot-pinned Connector identity.');
    }
    return this.db.transaction(async (tx) => {
      const selected = await tx.query<ControlRow>(
        `SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at,
                process_boot_id,acknowledged_boot_id
           FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE`,
        [this.identity.replicaId],
      );
      const row = selected.rows[0];
      if (!row) throw unavailable('replica control registration is unavailable');
      this.assertStoredIdentity(row);
      if (row.process_boot_id !== this.processBootId) {
        throw unavailable('Connector runtime-control command was sent to a stale process boot');
      }
      const revision = Number(row.control_revision);
      if (row.control_state === target) {
        return { controlRevision: revision, requestedAt: timestamp(row.requested_at) };
      }
      if (revision !== command.expectedControlRevision) {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Replica control revision changed; refresh before retrying.');
      }
      const requestedAt = this.isoNow();
      const updated = await tx.query<{ control_revision: number | string; requested_at: Date | string }>(
        `UPDATE connector_replica_runtime_controls
            SET control_revision=control_revision+1,control_state=$2,requested_at=$3,
                acknowledged_at='-infinity',acknowledged_boot_id=NULL,updated_at=$3
          WHERE replica_id=$1 AND control_revision=$4 AND process_boot_id=$5
          RETURNING control_revision,requested_at`,
        [this.identity.replicaId, target, requestedAt, command.expectedControlRevision, this.processBootId],
      );
      const saved = updated.rows[0];
      if (!saved) throw new ConnectorError('INVOCATION_UNKNOWN', 'Replica control changed concurrently.');
      return { controlRevision: Number(saved.control_revision), requestedAt: timestamp(saved.requested_at) };
    });
  }

  private assertExpectedIdentity(expected: ConnectorReplicaIdentity): void {
    if (expected.slot !== this.identity.slot
      || expected.runtimeIdentity !== this.identity.runtimeIdentity
      || expected.replicaId !== this.identity.replicaId
      || expected.revision !== this.identity.revision
      || expected.imageDigest !== this.identity.imageDigest) {
      throw new ConnectorError('BINDING_DENIED', 'Replica control identity does not match this Connector process.');
    }
  }

  private assertStoredIdentity(row: ControlRow): void {
    if (row.slot !== this.identity.slot
      || row.runtime_identity !== this.identity.runtimeIdentity
      || row.replica_id !== this.identity.replicaId
      || row.revision !== this.identity.revision
      || row.image_digest !== this.identity.imageDigest) {
      throw unavailable('stored replica control identity differs from the boot-pinned identity');
    }
    const controlRevision = Number(row.control_revision);
    if (!Number.isSafeInteger(controlRevision) || controlRevision < 1) throw unavailable('stored control revision is invalid');
    if (row.process_boot_id !== null && !isUuid(row.process_boot_id)) throw unavailable('stored Connector process boot ID is invalid');
    if (row.acknowledged_boot_id !== null && !isUuid(row.acknowledged_boot_id)) {
      throw unavailable('stored Connector acknowledgement boot ID is invalid');
    }
    // node-postgres' built-in timestamptz parser represents PostgreSQL's
    // special -infinity value as numeric -Infinity. It is a valid durable
    // "not yet acknowledged" sentinel, but must never be made into a fresh ACK.
    if (!isNegativeInfinity(row.acknowledged_at) && !Number.isFinite(Date.parse(timestamp(row.acknowledged_at)))) {
      throw unavailable('stored control acknowledgement is invalid');
    }
  }

  private isoNow(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw unavailable('Connector runtime-control clock is invalid');
    return value.toISOString();
  }
}

function isNegativeInfinity(value: Date | string | number): boolean {
  return value === '-infinity' || (typeof value === 'number' && value === Number.NEGATIVE_INFINITY);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function timestamp(value: Date | string | number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unavailable('stored Connector runtime-control timestamp is invalid');
    const parsedNumber = new Date(value);
    if (!Number.isFinite(parsedNumber.getTime())) throw unavailable('stored Connector runtime-control timestamp is invalid');
    return parsedNumber.toISOString();
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw unavailable('stored Connector runtime-control timestamp is invalid');
  return parsed.toISOString();
}

function unavailable(message: string): ConnectorError {
  return new ConnectorError('PROVIDER_UNAVAILABLE', message);
}
