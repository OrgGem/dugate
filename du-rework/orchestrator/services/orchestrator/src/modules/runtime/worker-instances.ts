import type { QueryResultRow } from 'pg';
import type { WorkerHeartbeat } from '@du/contracts';
import type { Db } from '../../db/db';

export const WORKER_HEARTBEAT_FRESH_FOR_MS = 60_000;

interface WorkerHeartbeatWriteRow extends QueryResultRow {
  state: 'ONLINE' | 'DRAINING' | 'OFFLINE';
  last_seen_at: Date | string;
}

/** Record one authenticated worker heartbeat and refresh its active lease count. */
export async function recordWorkerHeartbeat(
  db: Pick<Db, 'query'>,
  instanceId: string,
  heartbeat: WorkerHeartbeat,
): Promise<{ state: WorkerHeartbeatWriteRow['state']; lastSeenAt: string }> {
  const result = await db.query<WorkerHeartbeatWriteRow>(
    `WITH lease_count AS (
       SELECT count(*)::int AS active_leases
         FROM tasks t
         JOIN operations o ON o.id = t.operation_id
        WHERE t.leased_by = $2
          AND o.business_id = $1
          AND t.state = 'RUNNING'
          AND t.lease_expires_at > statement_timestamp()
     )
     INSERT INTO worker_instances (
       business_id, instance_id, business_version, state, capacity,
       active_leases, last_seen_at, observed_at
     )
     SELECT $1, $2, $3, 'ONLINE', $4, lease_count.active_leases,
            statement_timestamp(), statement_timestamp()
       FROM lease_count
     ON CONFLICT (business_id, instance_id) DO UPDATE
       SET business_version = EXCLUDED.business_version,
           state = CASE WHEN worker_instances.state = 'DRAINING' THEN 'DRAINING' ELSE 'ONLINE' END,
           capacity = EXCLUDED.capacity,
           active_leases = EXCLUDED.active_leases,
           last_seen_at = EXCLUDED.last_seen_at,
           observed_at = EXCLUDED.observed_at
     RETURNING state, last_seen_at`,
    [heartbeat.businessId, instanceId, heartbeat.businessVersion, heartbeat.capacity],
  );
  const row = result.rows[0];
  if (!row) throw new Error('worker heartbeat upsert returned no row');
  const lastSeenAt = row.last_seen_at instanceof Date ? row.last_seen_at : new Date(row.last_seen_at);
  if (Number.isNaN(lastSeenAt.getTime())) throw new Error('worker heartbeat upsert returned an invalid timestamp');
  return { state: row.state, lastSeenAt: lastSeenAt.toISOString() };
}
