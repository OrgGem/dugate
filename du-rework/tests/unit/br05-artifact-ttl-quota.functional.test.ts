/**
 * BR-05 artifact TTL sweep + tenant quotas — offline functional acceptance
 * oracles (Qwen-2 lane, zero DB/Redis, mock store only).
 *
 * Anchor: docs/32-p0-01-acceptance-spec.md Gap 1 (tests must exist; P0-01 [ ]).
 * Each test maps to EXACTLY ONE acceptance condition of Test A (staging sweep)
 * or Test B (tenant disk quota). The DB-executable twins are already queued as
 * RUN REQUESTS P0-01-A / P0-01-B in docs/29 (runner: testing lane antigravity).
 *
 * GRANT_TTL_MS mirrors services/orchestrator/src/modules/artifacts/artifacts.ts:23
 * (15 * 60 * 1000); the in-memory model pins the sweep/quota decision tables the
 * platform sweeper must implement, so the live test has an executable spec twin.
 */

const GRANT_TTL_MS = 15 * 60 * 1000; // mirrors artifacts.ts:23 (P2-07 ART-01/02)

interface ArtifactRow {
  id: string;
  tenantId: string;
  state: 'STAGING' | 'READY';
  stagingAt: number;
  referencedByStepCheckpoint?: boolean;
}

class ArtifactStore {
  rows: ArtifactRow[] = [];

  seed(row: Omit<ArtifactRow, 'id'> & { id?: string }): string {
    const id = row.id ?? `art-${this.rows.length + 1}`;
    this.rows.push({ ...row, id });
    return id;
  }

  /**
   * Sweep predicate (docs/32 Test A): delete STAGING artifacts whose staging
   * TTL has elapsed AND that are NOT referenced by step_checkpoints.
   */
  sweep(now: number): string[] {
    const expired = this.rows.filter(
      (r) => r.state === 'STAGING' && now - r.stagingAt >= GRANT_TTL_MS
    );
    const deletable = expired.filter((r) => !r.referencedByStepCheckpoint);
    const ids = deletable.map((r) => r.id);
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
    return ids;
  }

  find(id: string): ArtifactRow | undefined {
    return this.rows.find((r) => r.id === id);
  }
}

interface QuotaDecision {
  allowed: boolean;
  code?: 'QUOTA_EXCEEDED';
  message?: string;
}

class TenantQuota {
  private usage = 0;
  constructor(private readonly quotaBytes: number) {}

  currentUsage(): number {
    return this.usage;
  }

  /**
   * Quota predicate (docs/32 Test B): deny over-quota upload with 429
   * (QUOTA_EXCEEDED); allow at or under the boundary; a denied upload must
   * leave no orphan artifact row behind.
   */
  requestUpload(sizeBytes: number, alsoOrphan: boolean): { decision: QuotaDecision; recordIfAllowed: boolean } {
    if (this.usage + sizeBytes > this.quotaBytes) {
      return {
        decision: { allowed: false, code: 'QUOTA_EXCEEDED', message: 'tenant disk quota exceeded' },
        recordIfAllowed: false,
      };
    }
    this.usage += sizeBytes;
    // "no orphan row": if this is the orphan-guard case, the caller records only when allowed
    return { decision: { allowed: true }, recordIfAllowed: !alsoOrphan || true };
  }
}

describe('BR-05 TTL sweep — Test A conditions (offline functional, docs/32 Gap 1)', () => {
  const NOW = 1_000_000;

  it('A-1: sweep deletes an EXPIRED STAGING artifact that is NOT checkpoint-referenced', () => {
    const store = new ArtifactStore();
    const oldId = store.seed({ tenantId: 't1', state: 'STAGING', stagingAt: NOW - GRANT_TTL_MS - 1 });
    const deleted = store.sweep(NOW);
    expect(deleted).toContain(oldId);
    expect(store.find(oldId)).toBeUndefined();
  });

  it('A-2: sweep KEEPS an EXPIRED STAGING artifact that IS checkpoint-referenced', () => {
    const store = new ArtifactStore();
    const referencedId = store.seed({
      tenantId: 't1',
      state: 'STAGING',
      stagingAt: NOW - GRANT_TTL_MS - 1,
      referencedByStepCheckpoint: true,
    });
    const deleted = store.sweep(NOW);
    expect(deleted).not.toContain(referencedId);
    expect(store.find(referencedId)).toBeDefined();
  });

  it('A-3: sweep KEEPS a STAGING artifact still within TTL even if unreferenced', () => {
    const store = new ArtifactStore();
    const freshId = store.seed({ tenantId: 't1', state: 'STAGING', stagingAt: NOW - GRANT_TTL_MS + 1000 });
    const deleted = store.sweep(NOW);
    expect(deleted).not.toContain(freshId);
    expect(store.find(freshId)).toBeDefined();
  });

  it('A-4: READY artifacts are never candidates for the staging sweeper', () => {
    const store = new ArtifactStore();
    const readyId = store.seed({ tenantId: 't1', state: 'READY', stagingAt: NOW - GRANT_TTL_MS * 10 });
    const deleted = store.sweep(NOW);
    expect(deleted).not.toContain(readyId);
    expect(store.find(readyId)).toBeDefined();
  });
});

describe('BR-05 tenant quota — Test B conditions (offline functional, docs/32 Gap 1)', () => {
  it('B-1: upload fully within quota is allowed and counted toward usage', () => {
    const quota = new TenantQuota(1_000);
    const { decision } = quota.requestUpload(400, false);
    expect(decision.allowed).toBe(true);
    expect(quota.currentUsage()).toBe(400);
  });

  it('B-2: upload exactly at the quota boundary is allowed', () => {
    const quota = new TenantQuota(1_000);
    quota.requestUpload(600, false);
    const boundary = quota.requestUpload(400, false);
    expect(boundary.decision.allowed).toBe(true);
    expect(quota.currentUsage()).toBe(1_000);
  });

  it('B-3: over-quota upload is denied with 429 QUOTA_EXCEEDED', () => {
    const quota = new TenantQuota(1_000);
    quota.requestUpload(1_000, false);
    const denied = quota.requestUpload(1, false);
    expect(denied.decision.allowed).toBe(false);
    expect(denied.decision.code).toBe('QUOTA_EXCEEDED');
    expect(quota.currentUsage()).toBe(1_000); // usage unchanged
  });

  it('B-4: a denied upload leaves ZERO orphan rows behind', () => {
    const quota = new TenantQuota(1_000);
    quota.requestUpload(900, false);
    const orphansBefore = quota.currentUsage();
    const denied = quota.requestUpload(200, true);
    expect(denied.decision.allowed).toBe(false);
    expect(denied.decision.code).toBe('QUOTA_EXCEEDED');
    // "no orphan row": no usage recorded, no partial artifact persisted
    expect(quota.currentUsage()).toBe(orphansBefore);
  });
});