import type { WorkerInstance, WorkerInstanceList } from '@/lib/api';

const WORKER_STATES = new Set<WorkerInstance['state']>(['ONLINE', 'DRAINING', 'OFFLINE']);
const WORKER_HEALTH = new Set<WorkerInstance['health']>(['HEALTHY', 'DEGRADED', 'OFFLINE']);
const MAX_WORKER_INSTANCES = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Runtime-check the platform worker inventory before it enters Overview state. */
export function parseWorkerInstanceList(value: unknown): WorkerInstanceList | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_WORKER_INSTANCES) return null;
  if (!isTimestamp(value.sampledAt) || typeof value.truncated !== 'boolean') return null;

  const items: WorkerInstance[] = [];
  const identities = new Set<string>();
  for (const candidate of value.items) {
    if (!isRecord(candidate)) return null;
    if (
      !isIdentifier(candidate.businessId) ||
      !isIdentifier(candidate.instanceId) ||
      !isIdentifier(candidate.businessVersion, 128) ||
      !WORKER_STATES.has(candidate.state as WorkerInstance['state']) ||
      !WORKER_HEALTH.has(candidate.health as WorkerInstance['health']) ||
      !isCount(candidate.capacity) ||
      !isCount(candidate.activeLeases) ||
      !isTimestamp(candidate.lastSeenAt) ||
      !isTimestamp(candidate.observedAt)
    ) return null;

    const identity = `${candidate.businessId}\u0000${candidate.instanceId}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    items.push({
      businessId: candidate.businessId,
      instanceId: candidate.instanceId,
      businessVersion: candidate.businessVersion,
      state: candidate.state as WorkerInstance['state'],
      health: candidate.health as WorkerInstance['health'],
      capacity: candidate.capacity,
      activeLeases: candidate.activeLeases,
      lastSeenAt: candidate.lastSeenAt,
      observedAt: candidate.observedAt,
    });
  }

  return { items, sampledAt: value.sampledAt, truncated: value.truncated };
}
