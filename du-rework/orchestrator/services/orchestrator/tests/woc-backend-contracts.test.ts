import {
  BusinessEnableRequestSchema,
  BusinessEnableResultSchema,
  HeartbeatAckSchema,
  RUNTIME_CLAIM_ERROR_DISPOSITION,
  WorkerHeartbeatSchema,
} from '@du/contracts';

describe('WOC runtime v1 compatibility contract', () => {
  it('accepts a legacy heartbeat ACK without inventing a backup fence value', () => {
    const parsed = HeartbeatAckSchema.parse({
      health: 'HEALTHY',
      leaseExpiresAt: new Date().toISOString(),
      capacity: 4,
    });

    expect(parsed.backupEffectFence).toBeUndefined();
    expect(parsed.controlState).toBe('OPEN');
  });

  it('marks only terminal, stale-waiting, and verified-live-lease claim outcomes ACK-safe', () => {
    expect(RUNTIME_CLAIM_ERROR_DISPOSITION).toMatchObject({
      NOT_FOUND: 'ACK_SAFE',
      TASK_TERMINAL: 'ACK_SAFE',
      TASK_WAITING: 'ACK_SAFE',
      TASK_LEASE_ACTIVE: 'ACK_SAFE',
      ADMISSION_PAUSED: 'DEFER',
      WORKER_NOT_REGISTERED: 'DEFER',
      WORKER_ADMISSION_CLOSED: 'DEFER',
      TASK_NOT_READY: 'DEFER',
      WORKER_VERSION_MISMATCH: 'DEFER',
      MANIFEST_DIGEST_MISMATCH: 'DEFER',
      BUSINESS_DISABLED: 'DEFER',
      TASK_LEASE_HELD: 'DEFER',
      TEMPORARY_UNAVAILABLE: 'DEFER',
      SHUTTING_DOWN: 'DEFER',
    });
    expect(RUNTIME_CLAIM_ERROR_DISPOSITION).not.toHaveProperty('STATE_CONFLICT');
  });

  it('keeps worker manifest identity optional on v1 heartbeat while validating an explicit digest', () => {
    const legacy = WorkerHeartbeatSchema.safeParse({
      businessId: 'business-a', businessVersion: '1.0.0', imageDigest: 'sha256:image', capacity: 2,
    });
    expect(legacy.success).toBe(true);
    const explicit = WorkerHeartbeatSchema.safeParse({
      businessId: 'business-a', businessVersion: '1.0.0', imageDigest: 'sha256:image', capacity: 2,
      manifestDigest: `sha256:${'a'.repeat(64)}`,
    });
    expect(explicit.success).toBe(true);
    expect(WorkerHeartbeatSchema.safeParse({
      businessId: 'business-a', businessVersion: '1.0.0', imageDigest: 'sha256:image', capacity: 2,
      manifestDigest: 'wrong',
    }).success).toBe(false);
  });

  it('defines a strict expected-lifecycle-revision CAS for business enable state', () => {
    expect(BusinessEnableRequestSchema.safeParse({ enabled: false, expectedLifecycleRevision: 2 }).success).toBe(true);
    expect(BusinessEnableRequestSchema.safeParse({ enabled: false, expectedLifecycleRevision: 0 }).success).toBe(false);
    expect(BusinessEnableRequestSchema.safeParse({ enabled: false, expectedLifecycleRevision: 2, tenantId: 'caller-owned' }).success).toBe(false);
    expect(BusinessEnableResultSchema.safeParse({
      businessId: 'business-a', enabled: true, lifecycleRevision: 3, replayed: false,
    }).success).toBe(true);
  });
});
