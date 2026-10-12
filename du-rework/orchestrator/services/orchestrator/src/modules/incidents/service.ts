import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import type { AuditService } from '../audit/audit';
import { HttpError, zodIssuesToProblem } from '../../http/errors';
import {
  IncidentAcknowledgeRequestSchema,
  IncidentAssignRequestSchema,
  IncidentDetailSchema,
  IncidentEventSchema,
  IncidentListPageSchema,
  IncidentListQuerySchema,
  IncidentResolveRequestSchema,
  IncidentSchema,
  IncidentSignalSchema,
  MaintenanceSuppressionCreateSchema,
  MaintenanceSuppressionListSchema,
  MaintenanceSuppressionSchema,
  type Incident,
  type IncidentAcknowledgeRequest,
  type IncidentAssignRequest,
  type IncidentDetail,
  type IncidentEvent,
  type IncidentListQuery,
  type IncidentResolveRequest,
  type IncidentSignal,
  type MaintenanceSuppression,
  type MaintenanceSuppressionCreate,
  type MaintenanceSuppressionList,
} from '@du/contracts';

type IncidentRow = QueryResultRow & Record<string, unknown>;
type EventRow = QueryResultRow & Record<string, unknown>;
type SuppressionRow = QueryResultRow & Record<string, unknown>;
export type AssignableIncidentOwner = { id: string; tenantId: string; role: 'ADMIN' | 'USER' };
export type ResolveAssignableIncidentOwner = (input: { tenantId: string | null; ownerId: string }) => Promise<AssignableIncidentOwner | null>;

const INCIDENT_COLUMNS = `i.incident_id, i.tenant_id, i.scope_kind, i.source, i.source_ref, i.signal_code,
  i.severity, i.status, i.source_state, i.summary, i.owner_id, i.first_seen_at, i.last_seen_at,
  i.last_sampled_at, i.occurrence_count, i.state_version, i.threshold_revision,
  i.affected_resources, i.counters, i.acknowledged_at, i.resolved_at, i.resolution_evidence_ref`;

function asIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'stored incident timestamp is invalid');
  return date.toISOString();
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as unknown; } catch { return null; }
  }
  return value ?? null;
}

function parseOrThrow<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function toIncident(row: IncidentRow): Incident {
  return parseOrThrow(IncidentSchema, {
    id: row['incident_id'],
    tenantId: row['tenant_id'] ?? null,
    scope: row['scope_kind'] === 'platform' ? { kind: 'platform' } : { kind: 'tenant', tenantId: row['tenant_id'] },
    source: row['source'], sourceRef: row['source_ref'], signalCode: row['signal_code'],
    severity: row['severity'], status: row['status'], sourceState: row['source_state'], summary: row['summary'],
    ownerId: row['owner_id'] ?? null, firstSeenAt: asIso(row['first_seen_at']), lastSeenAt: asIso(row['last_seen_at']),
    lastSampledAt: asIso(row['last_sampled_at']), occurrenceCount: Number(row['occurrence_count']),
    stateVersion: Number(row['state_version']), thresholdRevision: row['threshold_revision'],
    affectedResources: jsonValue(row['affected_resources']), counters: jsonValue(row['counters']),
    suppressed: row['suppressed'] === true, acknowledgedAt: row['acknowledged_at'] ? asIso(row['acknowledged_at']) : null,
    resolvedAt: row['resolved_at'] ? asIso(row['resolved_at']) : null,
    resolutionEvidenceRef: row['resolution_evidence_ref'] ?? null,
  });
}

function toEvent(row: EventRow): IncidentEvent {
  return parseOrThrow(IncidentEventSchema, {
    id: row['event_id'], kind: row['kind'], occurredAt: asIso(row['created_at']), actor: row['actor'],
    summary: row['summary'], evidenceRef: row['evidence_ref'] ?? null,
    sourceState: row['source_state'] ?? null, details: jsonValue(row['details']),
  });
}

function toSuppression(row: SuppressionRow, now: Date): MaintenanceSuppression {
  const scopeKind = row['scope_kind'];
  const scope = scopeKind === 'platform' ? { kind: 'platform' as const } : { kind: scopeKind, ref: row['scope_ref'] };
  const startsAt = asIso(row['starts_at']);
  const expiresAt = asIso(row['expires_at']);
  return parseOrThrow(MaintenanceSuppressionSchema, {
    id: row['suppression_id'], scope, startsAt, expiresAt, reason: row['reason'],
    createdAt: asIso(row['created_at']), createdBy: row['created_by'],
    active: Date.parse(startsAt) <= now.getTime() && Date.parse(expiresAt) > now.getTime(),
  });
}

function sourceDedupKey(signal: IncidentSignal): string {
  return createHash('sha256').update([
    signal.scope.kind,
    signal.scope.kind === 'tenant' ? signal.scope.tenantId : '',
    signal.source,
    signal.sourceRef,
    signal.signalCode,
  ].join('\0')).digest('hex');
}

function sourceLockKey(dedupeKey: string): string {
  // PostgreSQL transaction advisory locks serialize source observations even
  // when the first row has not been inserted yet. Lock the stable dedupe key,
  // not the incident row: otherwise two initial signals can both observe an
  // empty result and race their first event/counters.
  return createHash('sha256').update(`incident-source:${dedupeKey}`).digest().readBigInt64BE(0).toString();
}

function queryFingerprint(query: IncidentListQuery, tenantScope: string | null): string {
  return createHash('sha256').update(JSON.stringify({
    status: query.status ?? null, severity: query.severity ?? null, source: query.source ?? null,
    search: query.search ?? null, selectedTenant: query.tenantId ?? null, tenantScope, limit: query.limit,
  })).digest('hex');
}

function decodeCursor(cursor: string, fingerprint: string): { lastSeenAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (decoded['v'] !== 1 || decoded['fingerprint'] !== fingerprint || typeof decoded['lastSeenAt'] !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(decoded['lastSeenAt']) ||
        typeof decoded['id'] !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded['id'])) throw new Error('invalid cursor');
    return { lastSeenAt: decoded['lastSeenAt'], id: decoded['id'] };
  } catch {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'incident cursor is invalid for this filter and scope');
  }
}

function encodeCursor(fingerprint: string, lastSeenAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, fingerprint, lastSeenAt, id }), 'utf8').toString('base64url');
}

function timestampForCursor(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'stored incident cursor timestamp is invalid');
  // Preserve PG's microseconds when the driver returns a string; JS Date otherwise loses ordering precision.
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)) return value;
  return `${date.toISOString().slice(0, -1)}000Z`;
}

async function auditMutation(
  db: Db,
  audit: AuditService,
  input: { tenantId: string | null; actor: string; actorRole: string; actorIssuer?: string; actorSub?: string; action: string; resource: string; severity?: 'info' | 'warning'; correlationId?: string },
  mutate: (client: PoolClient) => Promise<void>,
): Promise<void> {
  await db.tx(async (client) => {
    await mutate(client);
    await audit.record({ ...input, severity: input.severity ?? 'info' }, client);
  });
}

export function createIncidentService(db: Db, audit: AuditService, now: () => Date = () => new Date(), resolveAssignableOwner?: ResolveAssignableIncidentOwner) {
  async function findActiveSuppression(input: { tenantId: string | null; sourceRef: string; affectedResources: unknown }): Promise<boolean> {
    const result = await db.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM admin_maintenance_suppressions s
         WHERE s.starts_at <= $1 AND s.expires_at > $1
           AND (s.scope_kind = 'platform'
             OR (s.scope_kind = 'tenant' AND s.scope_ref = $2)
             OR (s.scope_kind IN ('service','queue','connector','operation') AND (
                  s.scope_ref = $3 OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements($4::jsonb) AS resource
                    WHERE resource->>'kind' = s.scope_kind AND resource->>'ref' = s.scope_ref
                  )
                )))
       ) AS active`,
      [now().toISOString(), input.tenantId, input.sourceRef, JSON.stringify(input.affectedResources)],
    );
    return result.rows[0]?.active === true;
  }

  async function appendEvent(
    client: PoolClient,
    input: { incidentId: string; kind: string; actor: string; summary: string; evidenceRef?: string | null; sourceState?: string | null; details?: Record<string, unknown> | null },
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO admin_incident_events(event_id,incident_id,kind,actor,summary,evidence_ref,source_state,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [id, input.incidentId, input.kind, input.actor, input.summary, input.evidenceRef ?? null, input.sourceState ?? null,
        input.details === undefined || input.details === null ? null : JSON.stringify(input.details)],
    );
    return id;
  }

  async function upsertIncidentSignal(input: unknown): Promise<Incident | null> {
    const signal = parseOrThrow(IncidentSignalSchema, input);
    const tenantId = signal.scope.kind === 'tenant' ? signal.scope.tenantId : null;
    const dedupeKey = sourceDedupKey(signal);
    const sampled = Date.parse(signal.sampledAt);
    if (!Number.isFinite(sampled) || sampled > now().getTime() + 30_000 || sampled < now().getTime() - 7 * 24 * 60 * 60 * 1000) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'incident source sample is outside the accepted clock window');
    }
    const suppressed = await findActiveSuppression({ tenantId, sourceRef: signal.sourceRef, affectedResources: signal.affectedResources });
    let mapped: Incident | null = null;
    await db.tx(async (client) => {
      // This lock covers the prior read, state write, and source event insert.
      // Row locks alone cannot serialize the first observation because no row
      // exists yet; the partial unique index only serializes the eventual
      // INSERT and leaves the loser with stale payload/event data.
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [sourceLockKey(dedupeKey)]);
      if (signal.state === 'active') {
        const prior = await client.query<IncidentRow>(
          `SELECT ${INCIDENT_COLUMNS} FROM admin_incidents i WHERE i.dedupe_key=$1
           ORDER BY GREATEST(i.last_sampled_at,COALESCE(i.resolved_at,i.last_sampled_at)) DESC,
                    i.updated_at DESC,i.incident_id DESC
           LIMIT 1 FOR UPDATE`, [dedupeKey],
        );
        const latest = prior.rows[0];
        if (latest) {
          const staleResult = await client.query<{ stale: boolean }>(
            `SELECT $2::timestamptz <= CASE WHEN status='resolved'
                       THEN GREATEST(last_sampled_at,resolved_at)
                       ELSE last_sampled_at END AS stale
               FROM admin_incidents WHERE incident_id=$1`,
            [latest['incident_id'], signal.sampledAt],
          );
          if (staleResult.rows[0]?.stale === true) {
            mapped = toIncident({ ...latest, suppressed } as IncidentRow);
            return;
          }
        }
        // A resolved row is retained as history. A strictly newer source
        // observation starts a new incident; an older/equal observation was
        // returned above and cannot reopen it.
        const previous = latest && latest['status'] !== 'resolved' ? latest : undefined;
        const result = await client.query<IncidentRow & { was_inserted: boolean }>(
          `INSERT INTO admin_incidents AS i(
             incident_id,tenant_id,scope_kind,source,source_ref,signal_code,dedupe_key,severity,status,source_state,
             summary,first_seen_at,last_seen_at,last_sampled_at,occurrence_count,threshold_revision,affected_resources,counters
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open','active',$9,$10,$10,$10,1,$11,$12::jsonb,$13::jsonb)
           ON CONFLICT (dedupe_key) WHERE status <> 'resolved'
           DO UPDATE SET severity=EXCLUDED.severity, source_state='active', summary=EXCLUDED.summary,
             last_seen_at=GREATEST(i.last_seen_at,EXCLUDED.last_seen_at),
             last_sampled_at=GREATEST(i.last_sampled_at,EXCLUDED.last_sampled_at),
             occurrence_count=i.occurrence_count+1, state_version=i.state_version+1,
             threshold_revision=EXCLUDED.threshold_revision, affected_resources=EXCLUDED.affected_resources,
             counters=EXCLUDED.counters, updated_at=now()
           RETURNING ${INCIDENT_COLUMNS}, (xmax=0) AS was_inserted`,
          [randomUUID(), tenantId, signal.scope.kind, signal.source, signal.sourceRef, signal.signalCode, dedupeKey, signal.severity,
            signal.summary, signal.sampledAt, signal.thresholdRevision, JSON.stringify(signal.affectedResources), JSON.stringify(signal.counters ?? {})],
        );
        const row = result.rows[0]!;
        if (!previous || !previous['incident_id']) {
          await appendEvent(client, { incidentId: String(row['incident_id']), kind: 'detected', actor: `source:${signal.source}`, summary: signal.summary,
            sourceState: 'active', details: { thresholdRevision: signal.thresholdRevision, counters: signal.counters ?? {} } });
        } else {
          const elapsed = Date.parse(signal.sampledAt) - Date.parse(asIso(previous['last_seen_at']));
          if (elapsed >= 60_000) await appendEvent(client, { incidentId: String(row['incident_id']), kind: 'signal_repeated', actor: `source:${signal.source}`,
            summary: signal.summary, sourceState: 'active', details: { occurrenceCount: Number(row['occurrence_count']), counters: signal.counters ?? {} } });
        }
        const pageRow = { ...row, suppressed } as IncidentRow;
        mapped = toIncident(pageRow);
      } else {
        const selected = await client.query<IncidentRow>(
          `SELECT ${INCIDENT_COLUMNS}, $2::timestamptz <= i.last_sampled_at AS stale
             FROM admin_incidents i WHERE i.dedupe_key=$1 AND i.status <> 'resolved' FOR UPDATE`, [dedupeKey, signal.sampledAt],
        );
        const current = selected.rows[0];
        if (!current) return;
        // Source reconciliation must be monotonic as well: an old recovery
        // sample that arrives after a newer failure may never clear it.
        if (current['stale'] === true) {
          mapped = toIncident({ ...current, suppressed } as IncidentRow);
          return;
        }
        const kind = signal.state === 'reconciled' ? 'reconciliation_confirmed' : 'source_recovered';
        const stateChanged = current['source_state'] !== signal.state;
        const updated = await client.query<IncidentRow>(
          `UPDATE admin_incidents AS i SET source_state=$2,
             state_version=state_version + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
             last_sampled_at=GREATEST(last_sampled_at,$3),updated_at=now()
           WHERE incident_id=$1 AND status <> 'resolved' RETURNING ${INCIDENT_COLUMNS}`,
          [current['incident_id'], signal.state, signal.sampledAt, stateChanged],
        );
        if (stateChanged) {
          await appendEvent(client, { incidentId: String(current['incident_id']), kind, actor: `source:${signal.source}`,
            summary: signal.summary, evidenceRef: signal.evidenceRef, sourceState: signal.state,
            details: { thresholdRevision: signal.thresholdRevision, counters: signal.counters ?? {} } });
        }
        mapped = toIncident({ ...updated.rows[0]!, suppressed } as IncidentRow);
      }
    });
    return mapped;
  }

  async function listIncidents(queryInput: unknown, tenantScope: string | null): Promise<ReturnType<typeof IncidentListPageSchema.parse>> {
    const query = parseOrThrow(IncidentListQuerySchema, queryInput);
    if (tenantScope !== null && query.tenantId && query.tenantId !== tenantScope) throw new HttpError(403, 'PERMISSION_DENIED', 'incident reads are scoped to the caller tenant');
    const selectedTenant = tenantScope ?? (query.tenantId ?? null);
    const fingerprint = queryFingerprint(query, tenantScope);
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : null;
    const search = query.search ? `%${query.search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const result = await db.query<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS}, to_char(i.last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_last_seen_at, EXISTS(
         SELECT 1 FROM admin_maintenance_suppressions s
         WHERE s.starts_at <= $1 AND s.expires_at > $1
           AND (s.scope_kind='platform'
             OR (s.scope_kind='tenant' AND s.scope_ref=i.tenant_id)
             OR (s.scope_kind IN ('service','queue','connector','operation') AND (
                  s.scope_ref=i.source_ref OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(i.affected_resources) AS resource
                    WHERE resource->>'kind'=s.scope_kind AND resource->>'ref'=s.scope_ref
                  )
                )))
       ) AS suppressed
       FROM admin_incidents i
       WHERE ($2::text IS NULL OR i.tenant_id=$2 OR ($3::boolean AND i.scope_kind='platform'))
         AND ($4::text IS NULL OR i.status=$4)
         AND ($5::text IS NULL OR i.severity=$5)
         AND ($6::text IS NULL OR i.source=$6)
         AND ($7::text IS NULL OR i.summary ILIKE $7 ESCAPE '\\' OR i.source_ref ILIKE $7 ESCAPE '\\'
              OR i.signal_code ILIKE $7 ESCAPE '\\' OR i.owner_id ILIKE $7 ESCAPE '\\')
         AND ($8::timestamptz IS NULL OR i.last_seen_at < $8::timestamptz OR (i.last_seen_at=$8::timestamptz AND i.incident_id<$9::uuid))
       ORDER BY i.last_seen_at DESC,i.incident_id DESC LIMIT $10`,
      // A tenant-scoped caller is fenced to its own rows. Platform incidents
      // are added only for a platform caller selecting a tenant.
      [now().toISOString(), selectedTenant, tenantScope === null && query.tenantId !== undefined, query.status ?? null, query.severity ?? null, query.source ?? null,
        search, after?.lastSeenAt ?? null, after?.id ?? null, query.limit + 1],
    );
    const hasMore = result.rows.length > query.limit;
    const selectedRows = result.rows.slice(0, query.limit);
    const items = selectedRows.map((row) => toIncident(row));
    const last = selectedRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(fingerprint, timestampForCursor(last['cursor_last_seen_at']), String(last['incident_id'])) : undefined;
    return parseOrThrow(IncidentListPageSchema, {
      items, limit: query.limit, hasMore, ...(nextCursor ? { nextCursor } : {}), sampledAt: now().toISOString(), tenantId: selectedTenant,
    });
  }

  async function getIncident(incidentId: string, tenantScope: string | null): Promise<IncidentDetail | null> {
    const result = await db.query<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS}, EXISTS(
        SELECT 1 FROM admin_maintenance_suppressions s WHERE s.starts_at <= $3 AND s.expires_at > $3
          AND (s.scope_kind='platform' OR (s.scope_kind='tenant' AND s.scope_ref=i.tenant_id)
            OR (s.scope_kind IN ('service','queue','connector','operation') AND (s.scope_ref=i.source_ref OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(i.affected_resources) AS resource
              WHERE resource->>'kind'=s.scope_kind AND resource->>'ref'=s.scope_ref))))
       ) AS suppressed
       FROM admin_incidents i WHERE i.incident_id=$1 AND ($2::text IS NULL OR i.tenant_id=$2)`,
      [incidentId, tenantScope, now().toISOString()],
    );
    const row = result.rows[0];
    if (!row) return null;
    const history = await db.query<EventRow>(
      `SELECT event_id,kind,created_at,actor,summary,evidence_ref,source_state,details
       FROM admin_incident_events WHERE incident_id=$1 ORDER BY created_at ASC,event_id ASC LIMIT 500`, [incidentId],
    );
    return parseOrThrow(IncidentDetailSchema, { incident: toIncident(row), history: history.rows.map(toEvent), sampledAt: now().toISOString() });
  }

  async function transition(input: { incidentId: string; tenantScope: string | null; expectedVersion: number; actor: string; actorRole: string;
    actorIssuer?: string; actorSub?: string; correlationId?: string; kind: 'assign' | 'acknowledge' | 'resolve'; body: unknown }): Promise<IncidentDetail> {
    const payload = input.kind === 'assign' ? parseOrThrow(IncidentAssignRequestSchema, input.body)
      : input.kind === 'acknowledge' ? parseOrThrow(IncidentAcknowledgeRequestSchema, input.body)
      : parseOrThrow(IncidentResolveRequestSchema, input.body);
    if (payload.expectedVersion !== input.expectedVersion) throw new HttpError(422, 'INVALID_SCHEMA', 'incident state version does not match request');
    let resolvedOwner: AssignableIncidentOwner | null = null;
    if (input.kind === 'assign') {
      if (!resolveAssignableOwner) throw new HttpError(503, 'IDENTITY_LOOKUP_UNAVAILABLE', 'incident assignment requires the authorized Identity directory');
      const scoped = await getIncident(input.incidentId, input.tenantScope);
      if (!scoped) throw new HttpError(404, 'NOT_FOUND', 'incident was not found');
      resolvedOwner = await resolveAssignableOwner({ tenantId: scoped.incident.tenantId, ownerId: (payload as IncidentAssignRequest).ownerId });
      const validOwnerScope = scoped.incident.tenantId === null
        ? resolvedOwner?.role === 'ADMIN' && resolvedOwner.tenantId.length > 0
        : resolvedOwner?.tenantId === scoped.incident.tenantId && (resolvedOwner.role === 'ADMIN' || resolvedOwner.role === 'USER');
      if (!resolvedOwner || resolvedOwner.id !== (payload as IncidentAssignRequest).ownerId || !validOwnerScope) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'incident owner must be an enabled assignable identity in the incident tenant scope');
      }
    }
    let detail: IncidentDetail | null = null;
    const action = input.kind === 'assign' ? 'incident.assigned' : input.kind === 'acknowledge' ? 'incident.acknowledged' : 'incident.resolved';
    await db.tx(async (client) => {
      const selected = await client.query<IncidentRow>(
        `SELECT ${INCIDENT_COLUMNS} FROM admin_incidents i
         WHERE i.incident_id=$1 AND ($2::text IS NULL OR i.tenant_id=$2) FOR UPDATE`,
        [input.incidentId, input.tenantScope],
      );
      const row = selected.rows[0];
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'incident was not found');
      const auditTenant = typeof row['tenant_id'] === 'string' ? row['tenant_id'] : null;
      if (Number(row['state_version']) !== payload.expectedVersion) throw new HttpError(409, 'STATE_CONFLICT', 'incident changed; reload its current state before acting');
      if (row['status'] === 'resolved') throw new HttpError(409, 'STATE_CONFLICT', 'resolved incidents cannot be changed');
      const current = toIncident({ ...row, suppressed: false } as IncidentRow);
      if (input.kind === 'resolve') {
        const resolve = payload as IncidentResolveRequest;
        if (current.sourceState === 'active') throw new HttpError(409, 'SOURCE_NOT_RECOVERED', 'incident source is still active; resolve requires recovered or reconciled source evidence');
        const evidence = await client.query<EventRow>(
          `SELECT event_id,kind,source_state FROM admin_incident_events
           WHERE event_id=$1 AND incident_id=$2 AND kind IN ('source_recovered','reconciliation_confirmed')`,
          [resolve.evidenceEventId, input.incidentId],
        );
        const event = evidence.rows[0];
        if (!event || event['source_state'] !== current.sourceState) throw new HttpError(422, 'INVALID_SCHEMA', 'resolution evidence must be a current source-recovery or reconciliation event for this incident');
        await client.query(
          `UPDATE admin_incidents SET status='resolved',resolved_at=now(),resolution_evidence_ref=$2,state_version=state_version+1,updated_at=now()
           WHERE incident_id=$1 AND state_version=$3`, [input.incidentId, resolve.evidenceEventId, payload.expectedVersion],
        );
        await appendEvent(client, { incidentId: input.incidentId, kind: 'resolved', actor: input.actor, summary: resolve.reason,
          evidenceRef: resolve.evidenceEventId, sourceState: current.sourceState });
      } else if (input.kind === 'acknowledge') {
        const ack = payload as IncidentAcknowledgeRequest;
        if (row['status'] === 'open') {
          await client.query(`UPDATE admin_incidents SET status='acknowledged',acknowledged_at=now(),state_version=state_version+1,updated_at=now() WHERE incident_id=$1 AND state_version=$2`, [input.incidentId, payload.expectedVersion]);
          await appendEvent(client, { incidentId: input.incidentId, kind: 'acknowledged', actor: input.actor, summary: ack.reason || 'Incident acknowledged by operator.' });
        }
      } else {
        const assign = payload as IncidentAssignRequest;
        const ownerId = resolvedOwner?.id;
        if (!ownerId) throw new HttpError(503, 'IDENTITY_LOOKUP_UNAVAILABLE', 'incident assignment identity could not be confirmed');
        await client.query(`UPDATE admin_incidents SET owner_id=$2,state_version=state_version+1,updated_at=now() WHERE incident_id=$1 AND state_version=$3`, [input.incidentId, ownerId, payload.expectedVersion]);
        await appendEvent(client, { incidentId: input.incidentId, kind: 'assigned', actor: input.actor, summary: assign.reason || 'Incident assigned to an authorized identity.', details: { ownerId } });
      }
      await audit.record({ tenantId: auditTenant, actor: input.actor, actorRole: input.actorRole,
        actorIssuer: input.actorIssuer, actorSub: input.actorSub, action, resource: `incident:${input.incidentId}`,
        severity: input.kind === 'resolve' ? 'info' : 'warning', correlationId: input.correlationId }, client);
    });
    detail = await getIncident(input.incidentId, input.tenantScope);
    if (!detail) throw new HttpError(404, 'NOT_FOUND', 'incident was not found');
    return detail;
  }

  async function listSuppressions(tenantScope: string | null): Promise<MaintenanceSuppressionList> {
    const result = await db.query<SuppressionRow>(
      `SELECT suppression_id,scope_kind,scope_ref,starts_at,expires_at,reason,created_by,created_at
       FROM admin_maintenance_suppressions
       WHERE ($1::text IS NULL OR scope_kind='platform' OR (scope_kind='tenant' AND scope_ref=$1))
       ORDER BY created_at DESC,suppression_id DESC LIMIT 100`, [tenantScope],
    );
    return parseOrThrow(MaintenanceSuppressionListSchema, { items: result.rows.map((row) => toSuppression(row, now())), sampledAt: now().toISOString() });
  }

  async function createSuppression(input: { tenantScope: string | null; actor: string; actorRole: string; actorIssuer?: string; actorSub?: string; correlationId?: string; body: unknown }): Promise<MaintenanceSuppression> {
    const request = parseOrThrow(MaintenanceSuppressionCreateSchema, input.body) as MaintenanceSuppressionCreate;
    const start = Date.parse(request.startsAt); const expiry = Date.parse(request.expiresAt); const current = now().getTime();
    if (start < current - 30_000 || start > current + 5 * 60_000 || expiry <= current || expiry - start > 24 * 60 * 60_000) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'maintenance suppression must start now or within five minutes and expire within 24 hours');
    }
    if (input.tenantScope !== null && (request.scope.kind !== 'tenant' || request.scope.ref !== input.tenantScope)) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'tenant operators may create suppressions only for their own tenant');
    }
    const suppressionId = randomUUID();
    const scopeRef = request.scope.kind === 'platform' ? null : request.scope.ref;
    await auditMutation(db, audit, {
      tenantId: input.tenantScope, actor: input.actor, actorRole: input.actorRole, actorIssuer: input.actorIssuer, actorSub: input.actorSub,
      action: 'maintenance.suppression.created', resource: `maintenance-suppression:${suppressionId}`, severity: 'warning', correlationId: input.correlationId,
    }, async (client) => {
      await client.query(
        `INSERT INTO admin_maintenance_suppressions(suppression_id,scope_kind,scope_ref,starts_at,expires_at,reason,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [suppressionId, request.scope.kind, scopeRef, request.startsAt, request.expiresAt, request.reason, input.actor],
      );
    });
    const result = await db.query<SuppressionRow>(
      `SELECT suppression_id,scope_kind,scope_ref,starts_at,expires_at,reason,created_by,created_at
       FROM admin_maintenance_suppressions WHERE suppression_id=$1`, [suppressionId],
    );
    return toSuppression(result.rows[0]!, now());
  }

  return { upsertIncidentSignal, listIncidents, getIncident, transition, listSuppressions, createSuppression };
}

export type IncidentService = ReturnType<typeof createIncidentService>;
