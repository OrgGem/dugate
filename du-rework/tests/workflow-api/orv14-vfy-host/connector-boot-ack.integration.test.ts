import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PgSqlClient } from '../../../orchestrator/services/connector/src/db/pg-client';
import { PostgresConnectorReplicaRuntimeControl } from '../../../orchestrator/services/connector/src/db/replica-runtime-controls';
import type { ConnectorReplicaControlCommand, ConnectorReplicaIdentity } from '@du/contracts';

const repositoryRoot = process.cwd();
const migrationRoot = path.join(repositoryRoot, 'orchestrator/services/connector/src/db/migrations');
const databaseUrl = process.env.ORV14_CONNECTOR_BOOT_ACK_DATABASE_URL;
const identity: ConnectorReplicaIdentity = {
  slot: 'blue', runtimeIdentity: 'orv14-boot-ack-blue', replicaId: 'orv14-boot-ack-replica-blue',
  revision: 'synthetic-connector-r1', imageDigest: `synthetic-connector@sha256:${'a'.repeat(64)}`,
};

function requiredBootId(): string {
  const bootId = process.env.ORV14_CONNECTOR_BOOT_ACK_BOOT_ID;
  if (!bootId) throw new Error('ORV14_CONNECTOR_BOOT_ACK_BOOT_ID_REQUIRED');
  return bootId;
}

function commandFor(expectedControlRevision = 1): ConnectorReplicaControlCommand {
  return {
    ...identity, expectedRevision: identity.revision, expectedImageDigest: identity.imageDigest,
    expectedControlRevision, reason: 'maintenance-rollout',
  };
}

async function readControl(db: PgSqlClient) {
  const result = await db.query<{
    slot: string; runtime_identity: string; replica_id: string; revision: string; image_digest: string;
    control_revision: number; control_state: string; requested_at: Date; acknowledged_at: Date | string | number;
    acknowledged_text: string; process_boot_id: string | null; acknowledged_boot_id: string | null; updated_at: Date;
  }>(`SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at,
             acknowledged_at::text AS acknowledged_text,process_boot_id::text,acknowledged_boot_id::text,updated_at
        FROM connector_replica_runtime_controls WHERE replica_id=$1`, [identity.replicaId]);
  const row = result.rows[0];
  if (!row) throw new Error('SYNTHETIC_CONTROL_ROW_MISSING');
  return {
    slot: row.slot, runtimeIdentity: row.runtime_identity, replicaId: row.replica_id, revision: row.revision,
    imageDigest: row.image_digest, controlRevision: Number(row.control_revision), controlState: row.control_state,
    requestedAt: new Date(row.requested_at).toISOString(), acknowledgedAt: row.acknowledged_text,
    processBootId: row.process_boot_id, acknowledgedBootId: row.acknowledged_boot_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function safeErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : null;
}

describe('ORV14 Connector persisted process-boot acknowledgement against real PostgreSQL', () => {
  jest.setTimeout(90000);

  it(`runs the requested ${process.env.ORV14_CONNECTOR_BOOT_ACK_PHASE ?? 'missing'} phase`, async () => {
    if (!databaseUrl) throw new Error('ORV14_CONNECTOR_BOOT_ACK_DATABASE_URL_REQUIRED');
    const phase = process.env.ORV14_CONNECTOR_BOOT_ACK_PHASE;
    const db = new PgSqlClient({ connectionString: databaseUrl, migrationDirectory: migrationRoot });
    try {
      if (phase === 'migration') {
        const migrationFiles = (await readdir(migrationRoot)).filter((name) => /^0(?:0[1-9]|1[0-5])_.*\.sql$/.test(name)).sort();
        const allMigrationFiles = (await readdir(migrationRoot)).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
        // The product PgSqlClient now enumerates 016 unconditionally. Build
        // the real 001-015 baseline with the same per-file transaction and
        // ledger format, using only the checked-in migration SQL, then hand
        // the fixture to the production migrator for 016 and replay.
        await db.query(`CREATE TABLE connector_schema_migrations (
          version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        for (const name of migrationFiles) {
          const version = name.replace(/\.sql$/, '');
          await db.transaction(async (client) => {
            await client.query(await readFile(path.join(migrationRoot, name), 'utf8'));
            await client.query('INSERT INTO connector_schema_migrations (version) VALUES ($1)', [version]);
          });
        }
        const legacyLedger = await db.query<{ version: string }>('SELECT version FROM connector_schema_migrations ORDER BY version');
        expect(legacyLedger.rows.map((row) => row.version)).toEqual(migrationFiles.map((name) => name.replace(/\.sql$/, '')));
        expect(legacyLedger.rows).toHaveLength(15);

        await db.query(
          `INSERT INTO connector_replica_runtime_controls
            (replica_id,slot,runtime_identity,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at)
           VALUES($1,$2,$3,$4,$5,1,'DRAINING',now()-interval '10 seconds',now()-interval '9 seconds')`,
          [identity.replicaId, identity.slot, identity.runtimeIdentity, identity.revision, identity.imageDigest],
        );

        await db.migrate();
        const afterApply = await db.query<{ version: string }>('SELECT version FROM connector_schema_migrations ORDER BY version');
        const legacyRowAfterApply = await readControl(db);
        expect(afterApply.rows.map((row) => row.version)).toEqual(allMigrationFiles.map((name) => name.replace(/\.sql$/, '')));
        expect(afterApply.rows).toHaveLength(16);
        expect(legacyRowAfterApply).toMatchObject({
          controlState: 'DRAINING', acknowledgedAt: '-infinity', processBootId: null, acknowledgedBootId: null,
        });

        await db.migrate();
        const afterReplay = await db.query<{ version: string }>('SELECT version FROM connector_schema_migrations ORDER BY version');
        expect(afterReplay.rows).toEqual(afterApply.rows);
        expect(await readControl(db)).toEqual(legacyRowAfterApply);
        process.stdout.write(`${JSON.stringify({ phase, migrationsBefore016: 15, migrationsAfter016: 16, replayRows: 16, legacyAckInvalidated: true })}\n`);
        return;
      }

      if (phase === 'boot') {
        const bootId = requiredBootId();
        const control = new PostgresConnectorReplicaRuntimeControl(db, identity, () => new Date(), { bootId });
        await control.assertPreseededDrain();
        const prior = await readControl(db);
        await control.claimPreseededDrain();
        const claimed = await readControl(db);
        expect(claimed).toMatchObject({ controlState: 'DRAINING', processBootId: bootId, acknowledgedBootId: null, acknowledgedAt: '-infinity' });
        const observation = await control.observe(identity, async () => true);
        const observed = await readControl(db);
        expect(observation).toMatchObject({ bootId, readiness: 'DRAINING', controlState: 'DRAINING', controlAcknowledgedBootId: bootId });
        expect(observed.processBootId).toBe(bootId);
        expect(observed.acknowledgedBootId).toBe(bootId);
        expect(observed.acknowledgedAt).not.toBe('-infinity');
        expect(Number.isFinite(Date.parse(observed.acknowledgedAt))).toBe(true);
        process.stdout.write(`${JSON.stringify({ phase, bootId, priorBootId: prior.processBootId, preObservationAckWasInfinity: claimed.acknowledgedAt === '-infinity', freshAckPersistedForCurrentBoot: observed.acknowledgedBootId === bootId, unresolvedInvocations: observation.work.connectorInvocations.count })}\n`);
        return;
      }

      if (phase === 'stale') {
        const bootId = requiredBootId();
        const control = new PostgresConnectorReplicaRuntimeControl(db, identity, () => new Date(), { bootId });
        const before = await readControl(db);
        expect(before.processBootId).not.toBe(bootId);
        expect(before.acknowledgedBootId).not.toBe(bootId);
        const observeError = await control.observe(identity, async () => true).then(() => null, (error) => error);
        const drainError = await control.requestDrain(commandFor(before.controlRevision)).then(() => null, (error) => error);
        const resumeError = await control.requestResume({ ...commandFor(before.controlRevision), reason: 'maintenance-rollback' }).then(() => null, (error) => error);
        expect(safeErrorCode(observeError)).toBe('PROVIDER_UNAVAILABLE');
        expect((observeError as Error)?.message).toMatch(/owned by another process boot/);
        expect(safeErrorCode(drainError)).toBe('PROVIDER_UNAVAILABLE');
        expect((drainError as Error)?.message).toMatch(/stale process boot/);
        expect(safeErrorCode(resumeError)).toBe('PROVIDER_UNAVAILABLE');
        expect((resumeError as Error)?.message).toMatch(/stale process boot/);
        const after = await readControl(db);
        expect(after).toEqual(before);
        process.stdout.write(`${JSON.stringify({ phase, staleBootId: bootId, observeDenied: true, drainDenied: true, resumeDenied: true, durableControlUnchanged: true, currentAckBootId: after.acknowledgedBootId })}\n`);
        return;
      }

      throw new Error('ORV14_CONNECTOR_BOOT_ACK_PHASE_INVALID');
    } finally {
      await db.close();
    }
  });
});
