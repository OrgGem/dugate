import { createHash } from 'node:crypto';
import type { ServiceInventory } from '@du/contracts';
import type { IncidentSignal } from '@du/contracts';

type RuntimeInventoryReader = { getServiceInventory(tenantId?: string): Promise<ServiceInventory> };
type IncidentSignalSink = { upsertIncidentSignal(signal: unknown): Promise<unknown> };

const MAX_SAMPLE_AGE_MS = 5 * 60_000;

function stableReplicaRef(serviceId: string, replicaId: string): string {
  const digest = createHash('sha256').update(`${serviceId}\0${replicaId}`).digest('hex').slice(0, 32);
  return `replica:${digest}`;
}

function evidenceRef(sourceRef: string, sampledAt: string, revision: string | null): string {
  const digest = createHash('sha256').update(`${sourceRef}\0${sampledAt}\0${revision ?? 'unknown'}`).digest('hex').slice(0, 32);
  return `replica-ready:${digest}`;
}

/**
 * Projects only a fresh, current host runtime-heartbeat inventory. Missing,
 * stale, and empty inventory cannot recover an existing replica incident.
 */
export async function projectRuntimeReplicaSignals(input: {
  store?: RuntimeInventoryReader;
  incidents: IncidentSignalSink;
  tenantId: string | null;
  now?: () => Date;
}): Promise<'fresh' | 'stale' | 'unavailable'> {
  if (!input.store) return 'unavailable';
  let inventory: ServiceInventory;
  try {
    inventory = await input.store.getServiceInventory(input.tenantId ?? undefined);
  } catch {
    return 'unavailable';
  }
  const now = (input.now ?? (() => new Date()))();
  const sampledAt = Date.parse(inventory.sampledAt);
  if (inventory.freshness !== 'FRESH' || !Number.isFinite(sampledAt)
      || sampledAt > now.getTime() + 30_000 || sampledAt < now.getTime() - MAX_SAMPLE_AGE_MS) return 'stale';

  const scope: IncidentSignal['scope'] = input.tenantId
    ? { kind: 'tenant', tenantId: input.tenantId }
    : { kind: 'platform' };
  for (const service of inventory.services) {
    for (const replica of service.replicas) {
      const sourceRef = stableReplicaRef(service.serviceId, replica.replicaId);
      const common = {
        source: 'runtime' as const,
        sourceRef,
        signalCode: 'replica-readiness',
        scope,
        thresholdRevision: 'runtime-heartbeat-v1',
        sampledAt: inventory.sampledAt,
        affectedResources: [
          { kind: 'service' as const, ref: service.serviceId, label: 'Service' },
          { kind: 'replica' as const, ref: replica.replicaId, label: 'Runtime replica' },
        ],
        counters: typeof replica.activeWork === 'number' ? { activeWork: replica.activeWork } : {},
      };
      if (replica.state === 'READY') {
        await input.incidents.upsertIncidentSignal({
          ...common,
          severity: 'medium',
          state: 'recovered',
          summary: 'The same runtime replica now reports READY in a fresh heartbeat inventory.',
          evidenceRef: evidenceRef(sourceRef, inventory.sampledAt, replica.observedRevision),
        });
      } else if (replica.state === 'OFFLINE' || replica.state === 'DEGRADED' || replica.state === 'UNKNOWN' || replica.state === 'LIVE') {
        await input.incidents.upsertIncidentSignal({
          ...common,
          severity: replica.state === 'OFFLINE' || replica.state === 'DEGRADED' ? 'high' : 'medium',
          state: 'active',
          summary: `Runtime replica readiness is ${replica.state.toLowerCase()}; a READY heartbeat has not been observed.`,
        });
      }
      // DRAINING is an operator-controlled transitional state, not evidence
      // that a prior readiness incident recovered or worsened.
    }
  }
  return 'fresh';
}
