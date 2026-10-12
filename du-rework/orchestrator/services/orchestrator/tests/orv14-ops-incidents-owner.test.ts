import { createIncidentService } from '../src/modules/incidents/service';
import { handleInternalIncidentRoutes } from '../src/http/routes/internal-incidents';
import { handleIncidentsRoute } from '../src/app/admin/bff/incidents';
import { projectConnectorSignalSnapshot } from '../src/modules/incidents/connector-signals';
import { projectRuntimeReplicaSignals } from '../src/modules/incidents/runtime-signals';

const tenantId = '11111111-1111-4111-8111-111111111111';
const recoveryEventId = '33333333-3333-4333-8333-333333333333';

function incidentFixture() {
  let row: Record<string, unknown> | null = null;
  const events: Array<Record<string, unknown>> = [];
  let tick = 0;

  async function execute(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('SELECT EXISTS')) return { rows: [{ active: false }] };
    if (sql.includes('INSERT INTO admin_incidents AS i')) {
      row = {
        incident_id: params[0], tenant_id: params[1], scope_kind: params[2], source: params[3], source_ref: params[4],
        signal_code: params[5], dedupe_key: params[6], severity: params[7], status: 'open', source_state: 'active',
        summary: params[8], first_seen_at: params[9], last_seen_at: params[9], last_sampled_at: params[9], occurrence_count: 1,
        state_version: 1, threshold_revision: params[10], affected_resources: params[11], counters: params[12], owner_id: null,
        acknowledged_at: null, resolved_at: null, resolution_evidence_ref: null,
      };
      return { rows: [{ ...row, was_inserted: true }] };
    }
    if (sql.includes('FROM admin_incidents i') && sql.includes('i.dedupe_key=$1')) {
      return { rows: row && row['dedupe_key'] === params[0] && row['status'] !== 'resolved' ? [{ ...row }] : [] };
    }
    if (sql.includes('FROM admin_incidents i') && sql.includes('i.incident_id=$1')) {
      return { rows: row && row['incident_id'] === params[0] && (params[1] === null || row['tenant_id'] === params[1])
        ? [{ ...row, suppressed: false }] : [] };
    }
    if (sql.includes('SELECT event_id,kind,source_state FROM admin_incident_events')) {
      const found = events.find((event) => event['event_id'] === params[0] && event['incident_id'] === params[1]
        && ['source_recovered', 'reconciliation_confirmed'].includes(String(event['kind'])));
      return { rows: found ? [found] : [] };
    }
    if (sql.includes('FROM admin_incident_events WHERE incident_id=$1 ORDER BY')) {
      return { rows: events.filter((event) => event['incident_id'] === params[0]) };
    }
    if (sql.includes('INSERT INTO admin_incident_events')) {
      const event = {
        event_id: params[0], incident_id: params[1], kind: params[2], actor: params[3], summary: params[4],
        evidence_ref: params[5], source_state: params[6], details: params[7], created_at: new Date(Date.parse('2026-10-11T12:00:00.000Z') + tick++).toISOString(),
      };
      if (params[2] === 'reconciliation_confirmed' || params[2] === 'source_recovered') event['event_id'] = recoveryEventId;
      events.push(event);
      return { rows: [] };
    }
    if (sql.includes("UPDATE admin_incidents AS i SET source_state=")) {
      if (!row || row['incident_id'] !== params[0]) return { rows: [] };
      row['source_state'] = params[1]; row['last_sampled_at'] = params[2];
      if (params[3] === true) row['state_version'] = Number(row['state_version']) + 1;
      return { rows: [{ ...row }] };
    }
    if (sql.includes("UPDATE admin_incidents SET status='acknowledged'")) {
      if (row) { row['status'] = 'acknowledged'; row['acknowledged_at'] = '2026-10-11T12:00:00.000Z'; row['state_version'] = Number(row['state_version']) + 1; }
      return { rows: [] };
    }
    if (sql.includes("UPDATE admin_incidents SET status='resolved'")) {
      if (row) { row['status'] = 'resolved'; row['resolved_at'] = '2026-10-11T12:01:00.000Z'; row['resolution_evidence_ref'] = params[1]; row['state_version'] = Number(row['state_version']) + 1; }
      return { rows: [] };
    }
    if (sql.includes('UPDATE admin_incidents SET owner_id=')) {
      if (row) { row['owner_id'] = params[1]; row['state_version'] = Number(row['state_version']) + 1; }
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  const db = { query: execute, tx: async <T>(work: (client: { query: typeof execute }) => Promise<T>) => work({ query: execute }) };
  const audit = { record: jest.fn(async () => undefined) };
  const service = createIncidentService(db as never, audit as never, () => new Date('2026-10-11T12:00:00.000Z'), async ({ tenantId: ownerTenant, ownerId }) => ({
    id: ownerId, tenantId: ownerTenant ?? tenantId, role: 'USER',
  }));
  return { service, events, audit, db, getRow: () => row };
}

function signal(state: 'active' | 'recovered' | 'reconciled', sampledAt: string, evidenceRef?: string) {
  return {
    source: 'connector', sourceRef: 'connector-ledger:tenant-a', signalCode: 'provider-outcome-unknown',
    scope: { kind: 'tenant' as const, tenantId }, severity: 'high', state,
    summary: state === 'active' ? 'Provider invocation outcome is unknown.' : 'A source reconciliation confirmed the invocation outcome.',
    sampledAt, thresholdRevision: 'connector-signal-v1',
    affectedResources: [{ kind: 'invocation', ref: 'invocation-123', label: 'Provider invocation' }],
    ...(evidenceRef ? { evidenceRef } : {}), counters: { unknown: 1 },
  };
}

describe('ORV14 incident lifecycle source evidence', () => {
  test('runtime readiness incidents recover only from the same replica in a fresh READY inventory', async () => {
    const now = () => new Date('2026-10-11T12:00:00.000Z');
    const signals: Array<Record<string, unknown>> = [];
    let state: 'OFFLINE' | 'READY' = 'OFFLINE';
    const store = { getServiceInventory: jest.fn(async () => ({
      sampledAt: '2026-10-11T12:00:00.000Z', source: ['postgres', 'runtime-heartbeat'], freshness: 'FRESH',
      services: [{ serviceId: 'worker:invoice', kind: 'worker', dependencies: [], replicas: [{
        serviceId: 'worker:invoice', replicaId: 'replica-a', role: 'worker', businessId: 'invoice', businessVersion: '3',
        desiredRevision: '3', observedRevision: '3', state, lastSeenAt: '2026-10-11T11:59:59.000Z', activeWork: 0,
        controlRevision: 1, controlState: 'OPEN',
      }] }],
    })) };
    const incidents = { upsertIncidentSignal: jest.fn(async (value: unknown) => { signals.push(value as Record<string, unknown>); }) };

    expect(await projectRuntimeReplicaSignals({ store: store as never, incidents, tenantId, now })).toBe('fresh');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: 'runtime', state: 'active', signalCode: 'replica-readiness' });
    const sourceRef = signals[0]?.['sourceRef'];

    signals.length = 0;
    state = 'READY';
    await projectRuntimeReplicaSignals({ store: store as never, incidents, tenantId, now });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: 'runtime', sourceRef, state: 'recovered', severity: 'medium' });
    expect(signals[0]?.['evidenceRef']).toMatch(/^replica-ready:/);

    signals.length = 0;
    store.getServiceInventory.mockImplementationOnce(async () => ({
      sampledAt: '2026-10-11T11:00:00.000Z', source: ['postgres', 'runtime-heartbeat'], freshness: 'STALE', services: [],
    } as never));
    expect(await projectRuntimeReplicaSignals({ store: store as never, incidents, tenantId, now })).toBe('stale');
    expect(signals).toHaveLength(0);
  });

  test('projects UNKNOWN and pending delivery, then recovers only from same-source terminal evidence', async () => {
    const operationId = '44444444-4444-4444-8444-444444444444';
    const taskId = '55555555-5555-4555-8555-555555555555';
    const invocationId = '66666666-6666-4666-8666-666666666666';
    const eventId = 'outbox:unsafe/provider-response:1';
    const now = () => new Date('2026-10-11T12:00:00.000Z');
    const upserts: Array<Record<string, unknown>> = [];
    const incidents = { upsertIncidentSignal: jest.fn(async (value: unknown) => { upserts.push(value as Record<string, unknown>); }) };
    let state: 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' = 'UNKNOWN';
    let delivery: 'PENDING' | 'DELIVERED' = 'PENDING';
    const store = { getConnectorSignalSnapshot: jest.fn(async ({ tenantId: selectedTenant, from, to }: { tenantId: string; from: string; to: string }) => ({
      snapshotId: '77777777-7777-4777-8777-777777777777', sourceRef: `connector-ledger:${selectedTenant}`,
      tenantId: selectedTenant, from, to, sampledAt: to, freshness: 'fresh' as const,
      invocationCounts: { NEW: 0, IN_FLIGHT: 0, PENDING: state === 'PENDING' ? 1 : 0, POLLING: 0, SUCCEEDED: state === 'SUCCEEDED' ? 1 : 0, FAILED: 0, UNKNOWN: state === 'UNKNOWN' ? 1 : 0, CANCELLED: 0 },
      failedByCode: [],
      affectedInvocations: [{ tenantId: selectedTenant, operationId, taskId, invocationId, stepKey: 'provider_call', connectorId: 'connector_alpha', connectorRevision: 2, state, errorCode: null, updatedAt: to }],
      usageOutbox: { pending: delivery === 'PENDING' ? 1 : 0, failedDeliveryAttempts: delivery === 'PENDING' ? 2 : 0, oldestPendingAt: delivery === 'PENDING' ? to : null, oldestPendingLagMs: delivery === 'PENDING' ? 0 : null, maxAttempts: 2,
        affected: [{ eventId, operationId, taskId, invocationId, state: delivery, attempts: 2, failedAttempts: delivery === 'PENDING' ? 2 : 2, createdAt: to, deliveredAt: delivery === 'DELIVERED' ? to : null }] },
    })) };

    const first = await projectConnectorSignalSnapshot({ store: store as never, incidents, tenantId, now });
    expect(first.status).toBe('fresh');
    expect(upserts).toHaveLength(2);
    expect(upserts.map((value) => value['state'])).toEqual(['active', 'active']);
    expect(upserts.map((value) => value['signalCode'])).toEqual(['provider-outcome-unknown', 'usage-outbox-delivery']);
    expect(JSON.stringify(upserts)).not.toContain('unsafe/provider-response');

    upserts.length = 0;
    state = 'PENDING';
    await projectConnectorSignalSnapshot({ store: store as never, incidents, tenantId, now });
    expect(upserts.map((value) => value['signalCode'])).toEqual(['usage-outbox-delivery']);
    expect(upserts[0]?.['state']).toBe('active');

    upserts.length = 0;
    state = 'SUCCEEDED';
    delivery = 'DELIVERED';
    await projectConnectorSignalSnapshot({ store: store as never, incidents, tenantId, now });
    expect(upserts).toHaveLength(2);
    expect(upserts.map((value) => value['state'])).toEqual(['reconciled', 'recovered']);
    expect(upserts.every((value) => typeof value['evidenceRef'] === 'string')).toBe(true);
    expect(upserts[0]?.['evidenceRef']).toMatch(/^connector-terminal:/);
    expect(upserts[1]?.['evidenceRef']).toMatch(/^connector-outbox-delivered:/);
  });

  test('stale, missing and mismatched snapshots never create or recover incidents', async () => {
    const incidents = { upsertIncidentSignal: jest.fn(async () => undefined) };
    const now = () => new Date('2026-10-11T12:00:00.000Z');
    const baseStore = { getConnectorSignalSnapshot: jest.fn(async ({ tenantId: selectedTenant, from, to }: { tenantId: string; from: string; to: string }) => ({
      snapshotId: '77777777-7777-4777-8777-777777777777', sourceRef: `connector-ledger:${selectedTenant}`,
      tenantId: selectedTenant, from, to, sampledAt: '2026-10-11T11:00:00.000Z', freshness: 'stale' as const,
      invocationCounts: { NEW: 0, IN_FLIGHT: 0, PENDING: 0, POLLING: 0, SUCCEEDED: 0, FAILED: 0, UNKNOWN: 1, CANCELLED: 0 },
      failedByCode: [], affectedInvocations: [],
      usageOutbox: { pending: 0, failedDeliveryAttempts: 0, oldestPendingAt: null, oldestPendingLagMs: null, maxAttempts: 0, affected: [] },
    })) };
    const stale = await projectConnectorSignalSnapshot({ store: baseStore as never, incidents, tenantId, now });
    expect(stale.status).toBe('stale');
    expect(incidents.upsertIncidentSignal).not.toHaveBeenCalled();

    const noSource = await projectConnectorSignalSnapshot({ incidents, tenantId, now });
    expect(noSource.status).toBe('unavailable');
    const noTenant = await projectConnectorSignalSnapshot({ store: baseStore as never, incidents, tenantId: null, now });
    expect(noTenant.status).toBe('not-selected');
    expect(incidents.upsertIncidentSignal).not.toHaveBeenCalled();

    const mismatch = { getConnectorSignalSnapshot: jest.fn(async ({ from, to }: { tenantId: string; from: string; to: string }) => ({
      snapshotId: '77777777-7777-4777-8777-777777777777', sourceRef: 'connector-ledger:99999999-9999-4999-8999-999999999999',
      tenantId: '99999999-9999-4999-8999-999999999999', from, to, sampledAt: to, freshness: 'fresh' as const,
      invocationCounts: { NEW: 0, IN_FLIGHT: 0, PENDING: 0, POLLING: 0, SUCCEEDED: 0, FAILED: 0, UNKNOWN: 0, CANCELLED: 0 }, failedByCode: [],
      affectedInvocations: [], usageOutbox: { pending: 0, failedDeliveryAttempts: 0, oldestPendingAt: null, oldestPendingLagMs: null, maxAttempts: 0, affected: [] },
    })) };
    const wrongTenant = await projectConnectorSignalSnapshot({ store: mismatch as never, incidents, tenantId, now });
    expect(wrongTenant.status).toBe('unavailable');
    expect(incidents.upsertIncidentSignal).not.toHaveBeenCalled();
  });

  test('acknowledgement records a responder but never resolves the incident', async () => {
    const { service, getRow } = incidentFixture();
    const incident = await service.upsertIncidentSignal(signal('active', '2026-10-11T11:59:00.000Z'));
    expect(incident?.status).toBe('open');
    const detail = await service.transition({
      incidentId: incident!.id, tenantScope: tenantId, expectedVersion: 1, actor: 'operator-1', actorRole: 'operator',
      kind: 'acknowledge', body: { expectedVersion: 1, reason: 'Investigating provider response.' },
    });
    expect(detail.incident.status).toBe('acknowledged');
    expect(detail.incident.resolvedAt).toBeNull();
    expect(detail.incident.sourceState).toBe('active');
    expect(getRow()?.['status']).toBe('acknowledged');
    await expect(service.transition({
      incidentId: incident!.id, tenantScope: tenantId, expectedVersion: 2, actor: 'operator-1', actorRole: 'operator',
      kind: 'resolve', body: { expectedVersion: 2, reason: 'Closed without evidence.', evidenceEventId: recoveryEventId },
    })).rejects.toMatchObject({ code: 'SOURCE_NOT_RECOVERED' });
  });

  test('requires matching fresh recovery event and CAS version before resolving', async () => {
    const { service, getRow } = incidentFixture();
    const incident = await service.upsertIncidentSignal(signal('active', '2026-10-11T11:59:00.000Z'));
    await service.upsertIncidentSignal(signal('reconciled', '2026-10-11T12:00:01.000Z', 'connector-snapshot-reconcile-1'));
    const history = await service.getIncident(incident!.id, tenantId);
    expect(history?.history.map((event) => event.kind)).toEqual(['detected', 'reconciliation_confirmed']);
    await expect(service.transition({
      incidentId: incident!.id, tenantScope: tenantId, expectedVersion: 1, actor: 'operator-1', actorRole: 'operator',
      kind: 'resolve', body: { expectedVersion: 1, reason: 'Stale state version.', evidenceEventId: recoveryEventId },
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const resolved = await service.transition({
      incidentId: incident!.id, tenantScope: tenantId, expectedVersion: 2, actor: 'operator-1', actorRole: 'operator',
      kind: 'resolve', body: { expectedVersion: 2, reason: 'Reconciled source record.', evidenceEventId: recoveryEventId },
    });
    expect(resolved.incident.status).toBe('resolved');
    expect(resolved.incident.resolutionEvidenceRef).toBe(recoveryEventId);
    expect(getRow()?.['status']).toBe('resolved');
  });

  test('rejects unverified owner IDs through the authorized directory resolver', async () => {
    const fixture = incidentFixture();
    const incident = await fixture.service.upsertIncidentSignal(signal('active', '2026-10-11T11:59:00.000Z'));
    const service = createIncidentService(fixture.db as never, fixture.audit as never, () => new Date('2026-10-11T12:00:00.000Z'), async () => null);
    await expect(service.transition({
      incidentId: incident!.id, tenantScope: tenantId, expectedVersion: 1, actor: 'operator-1', actorRole: 'operator',
      kind: 'assign', body: { expectedVersion: 1, ownerId: 'not-a-current-identity', reason: 'Assign it.' },
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  test('invalid opaque session never falls back to a tenant bearer on the internal incident route', async () => {
    const get = jest.fn(async () => null);
    await expect(handleInternalIncidentRoutes({
      pathname: '/api/internal/incidents', method: 'GET', ingressAudience: 'internal', searchParams: new URLSearchParams(),
      headers: { cookie: `du_session=${'A'.repeat(43)}`, authorization: 'Bearer tenant-service-token' },
      config: { adminSessionStore: { get } },
    } as never)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('local USER sessions have no tenant-wide incident read or write access', async () => {
    const get = jest.fn(async () => ({ role: 'operator' as const, csrfToken: 'csrf', tenantId, issuer: 'du-local', sub: 'local-user', roleVersion: 2 }));
    const ctx = {
      pathname: '/api/internal/incidents', method: 'GET', ingressAudience: 'internal', searchParams: new URLSearchParams(),
      headers: { cookie: `du_session=${'B'.repeat(43)}` }, config: { adminSessionStore: { get } },
      db: { query: jest.fn(async () => ({ rows: [] })) }, audit: { record: jest.fn() },
    } as never;
    await expect(handleInternalIncidentRoutes(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  test('incident BFF preserves the opaque local issuer proof on reads', async () => {
    const sessionId = 'D'.repeat(43);
    let upstreamCookie = '';
    let upstreamCsrf = '';
    const response = { setHeader: jest.fn(), statusCode: 0, end: jest.fn() };
    await handleIncidentsRoute(
      { method: 'GET', headers: {} } as never,
      response as never,
      { cookies: { du_session: sessionId } } as never,
      { kind: 'list' },
      new URLSearchParams(),
      { oidcSessions: { get: jest.fn(async () => ({ role: 'operator', csrfToken: 'server-csrf', tenantId, issuer: 'du-local', sub: 'local-user', roleVersion: 2 })) } } as never,
      {
        jsonBaseUrl: 'http://admin.internal',
        tenantAdminTokens: { 'tenant-service-token': tenantId },
        fetchImpl: jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          const headers = init?.headers as Record<string, string>;
          upstreamCookie = headers.cookie ?? '';
          upstreamCsrf = headers['x-csrf-token'] ?? '';
          return new Response(JSON.stringify({ items: [], limit: 50, nextCursor: null, prevCursor: null, total: 0, sampledAt: '2026-10-11T12:00:00.000Z' }), { status: 200 });
        }),
      },
      'incident-bff-read-proof',
    );
    expect(upstreamCookie).toBe(`du_session=${sessionId}`);
    expect(upstreamCsrf).toBe('server-csrf');
  });

  test('configured OIDC tenant operators keep tenant reads and viewers remain read-only', async () => {
    const makeContext = (role: 'operator' | 'viewer', issuer: string) => ({
      pathname: '/api/internal/incidents', method: 'GET', ingressAudience: 'internal', searchParams: new URLSearchParams(),
      headers: { cookie: `du_session=${'C'.repeat(43)}` },
      config: { adminSessionStore: { get: jest.fn(async () => ({ role, csrfToken: 'csrf', tenantId, issuer, sub: `${role}-1` })) } },
      db: { query: jest.fn(async () => ({ rows: [] })) }, audit: { record: jest.fn() },
    } as never);
    const operator = await handleInternalIncidentRoutes(makeContext('operator', 'https://idp.example.test'));
    const viewer = await handleInternalIncidentRoutes(makeContext('viewer', 'https://idp.example.test'));
    expect(operator?.status).toBe(200);
    expect(viewer?.status).toBe(200);
  });
});
