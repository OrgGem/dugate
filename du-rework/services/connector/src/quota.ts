import { randomUUID } from 'node:crypto';
import type { QuotaLease, QuotaStore } from './types';

export class InMemoryQuotaStore implements QuotaStore {
  private readonly leases = new Map<string, Map<string, QuotaLease>>();

  public async acquire(
    key: string,
    now: number,
    leaseMs: number,
    maxInFlight: number,
  ): Promise<QuotaLease | undefined> {
    const active = this.leases.get(key) ?? new Map<string, QuotaLease>();
    for (const [id, lease] of active) {
      if (lease.expiresAt <= now) active.delete(id);
    }
    if (active.size >= maxInFlight) return undefined;
    const lease = { leaseId: randomUUID(), key, expiresAt: now + leaseMs };
    active.set(lease.leaseId, lease);
    this.leases.set(key, active);
    return lease;
  }

  public async release(lease: QuotaLease): Promise<void> {
    this.leases.get(lease.key)?.delete(lease.leaseId);
  }
}
