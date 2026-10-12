import { createHash } from 'node:crypto';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import type { IncidentConnectorSourceSnapshot } from '@du/contracts';
import type { IncidentSignal } from '@du/contracts';

type ConnectorSnapshotReader = Pick<ConnectorManagementStore, 'getConnectorSignalSnapshot'>;
type IncidentSignalSink = { upsertIncidentSignal(signal: unknown): Promise<unknown> };

const DAY_MS = 24 * 60 * 60 * 1000;

function emptySnapshot(status: IncidentConnectorSourceSnapshot['status'], tenantId: string | null): IncidentConnectorSourceSnapshot {
  return {
    status,
    tenantId,
    sampledAt: null,
    invocationCounts: null,
    failedDeliveryAttempts: null,
    pendingOutbox: null,
    oldestPendingLagMs: null,
  };
}

function opaqueRef(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function invocationResources(row: {
  operationId: string;
  invocationId: string;
  connectorId: string | null;
}): IncidentSignal['affectedResources'] {
  return [
    { kind: 'operation', ref: row.operationId, label: 'Affected operation' },
    { kind: 'invocation', ref: row.invocationId, label: 'Connector invocation' },
    ...(row.connectorId ? [{ kind: 'connector' as const, ref: row.connectorId, label: 'Connector' }] : []),
  ];
}

function eventResources(row: { eventId: string; operationId: string; invocationId: string }): IncidentSignal['affectedResources'] {
  return [
    { kind: 'operation', ref: row.operationId, label: 'Affected operation' },
    { kind: 'invocation', ref: row.invocationId, label: 'Connector invocation' },
    { kind: 'delivery', ref: opaqueRef('usage-event', row.eventId), label: 'Usage outbox event' },
  ];
}

/**
 * Projects only tenant-bound persisted Connector ledger/outbox evidence.
 * Stale or missing reads are returned to the UI as such and never change an
 * incident's source state. Recovery signals identify the exact invocation or
 * outbox event that supplied the terminal evidence.
 */
export async function projectConnectorSignalSnapshot(input: {
  store?: ConnectorSnapshotReader;
  incidents: IncidentSignalSink;
  tenantId: string | null;
  now?: () => Date;
}): Promise<IncidentConnectorSourceSnapshot> {
  if (!input.tenantId) return emptySnapshot('not-selected', null);
  if (!input.store) return emptySnapshot('unavailable', input.tenantId);

  const sampledNow = (input.now ?? (() => new Date()))();
  const to = sampledNow.toISOString();
  const from = new Date(sampledNow.getTime() - 30 * DAY_MS).toISOString();
  let snapshot;
  try {
    snapshot = await input.store.getConnectorSignalSnapshot({ tenantId: input.tenantId, from, to });
  } catch {
    return emptySnapshot('unavailable', input.tenantId);
  }
  if (!snapshot) return emptySnapshot('unavailable', input.tenantId);

  const sampledAtMs = Date.parse(snapshot.sampledAt);
  if (snapshot.tenantId !== input.tenantId || snapshot.sourceRef !== `connector-ledger:${input.tenantId}`
      || snapshot.from !== from || snapshot.to !== to || !Number.isFinite(sampledAtMs)) {
    return emptySnapshot('unavailable', input.tenantId);
  }
  const reading: IncidentConnectorSourceSnapshot = {
    status: snapshot.freshness,
    tenantId: snapshot.tenantId,
    sampledAt: snapshot.sampledAt,
    invocationCounts: snapshot.invocationCounts,
    failedDeliveryAttempts: snapshot.usageOutbox.failedDeliveryAttempts,
    pendingOutbox: snapshot.usageOutbox.pending,
    oldestPendingLagMs: snapshot.usageOutbox.oldestPendingLagMs,
  };
  if (snapshot.freshness !== 'fresh' || sampledAtMs > sampledNow.getTime() + 30_000 || sampledAtMs < sampledNow.getTime() - 5 * 60_000) {
    return { ...reading, status: snapshot.freshness === 'fresh' ? 'stale' : snapshot.freshness };
  }

  const invocationById = new Map(snapshot.affectedInvocations.map((invocation) => [invocation.invocationId, invocation]));
  for (const invocation of snapshot.affectedInvocations) {
    const sourceRef = `connector-invocation:${invocation.invocationId}`;
    const common = {
      source: 'connector' as const,
      sourceRef,
      scope: { kind: 'tenant' as const, tenantId: snapshot.tenantId },
      thresholdRevision: 'connector-ledger-signal-v1',
      affectedResources: invocationResources(invocation),
      counters: { unknown: snapshot.invocationCounts.UNKNOWN, failed: snapshot.invocationCounts.FAILED },
    };
    if (invocation.state === 'UNKNOWN') {
      const code = invocation.errorCode ? ` · ${invocation.errorCode}` : '';
      await input.incidents.upsertIncidentSignal({
        ...common,
        signalCode: 'provider-outcome-unknown',
        severity: 'high',
        state: 'active',
        summary: `Connector invocation outcome is unknown${code}. Reconcile this exact source record before retrying.`,
        sampledAt: snapshot.sampledAt,
      });
    } else if (invocation.state === 'SUCCEEDED' || invocation.state === 'FAILED' || invocation.state === 'CANCELLED') {
      // An UNKNOWN invocation is reconciled only after this same durable
      // invocation ID is observed in a terminal state. NEW/IN_FLIGHT/PENDING/
      // POLLING are not recovery evidence. A separate successful invocation
      // or an empty aggregate cannot clear it.
      const terminalEvidence = opaqueRef('connector-terminal', `${invocation.invocationId}:${invocation.state}:${invocation.updatedAt}`);
      await input.incidents.upsertIncidentSignal({
        ...common,
        signalCode: 'provider-outcome-unknown',
        severity: 'high',
        state: 'reconciled',
        summary: `Connector source reconciled this invocation as ${invocation.state}.`,
        sampledAt: snapshot.sampledAt,
        evidenceRef: terminalEvidence,
      });
    }
  }

  for (const event of snapshot.usageOutbox.affected) {
    const invocation = invocationById.get(event.invocationId);
    if (!invocation) continue; // The strict producer normally guarantees this join.
    const sourceRef = opaqueRef('connector-outbox-event', event.eventId);
    const eventEvidence = opaqueRef('connector-outbox-delivered', `${event.eventId}:${event.deliveredAt ?? ''}`);
    await input.incidents.upsertIncidentSignal({
      source: 'delivery',
      sourceRef,
      signalCode: 'usage-outbox-delivery',
      scope: { kind: 'tenant', tenantId: snapshot.tenantId },
      severity: event.failedAttempts >= 5 ? 'high' : 'medium',
      state: event.state === 'PENDING' ? 'active' : 'recovered',
      summary: event.state === 'PENDING'
        ? `Connector usage event remains pending after ${event.attempts} delivery attempts.`
        : 'The Connector usage outbox confirms delivery of this exact event.',
      sampledAt: snapshot.sampledAt,
      thresholdRevision: 'connector-outbox-signal-v1',
      affectedResources: eventResources(event),
      counters: { attempts: event.attempts, failedAttempts: event.failedAttempts, maxAttempts: snapshot.usageOutbox.maxAttempts },
      ...(event.state === 'DELIVERED' ? { evidenceRef: eventEvidence } : {}),
    });
  }
  return reading;
}
