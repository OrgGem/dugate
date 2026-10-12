import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canReadPlatformSignals,
  canManageCompose,
  deriveOperationSignals,
  effectiveTenantId,
  parseAdminHealthSnapshot,
  sampleAgeState,
} from '../src/features/system-operations/state.ts';

const platformSession = {
  role: 'admin',
  principal: { kind: 'platform', tenantId: null },
  scope: { kind: 'platform' },
};

const tenantSession = {
  role: 'operator',
  principal: { kind: 'tenant_operator', tenantId: 'tenant-a' },
  scope: { kind: 'tenant', tenantId: 'tenant-a' },
};

const health = {
  status: 'degraded',
  db: false,
  redis: null,
  activeLeases: null,
  queueIntegrity: {
    state: 'SUSPECT',
    orphansLast: 2,
    stalled: null,
    lastSweepAt: '2026-10-11T11:59:00.000Z',
  },
  outboxBacklog: null,
  sampledAt: '2026-10-11T12:00:00.000Z',
};

describe('UI13 platform scope and system projections', () => {
  it('allows aggregate health and worker inventory only to a platform administrator', () => {
    assert.equal(canReadPlatformSignals(platformSession), true);
    assert.equal(canReadPlatformSignals(tenantSession), false);
    assert.equal(canReadPlatformSignals({ ...platformSession, role: 'operator' }), false);
  });

  it('requires an admin platform BFF scope for Compose and denies incomplete sessions', () => {
    assert.equal(canManageCompose(platformSession), true);
    assert.equal(canManageCompose(tenantSession), false);
    assert.equal(canManageCompose({ ...platformSession, scope: null }), false);
    assert.equal(canManageCompose({ ...platformSession, principal: { kind: 'unscoped', tenantId: null } }), false);
    assert.equal(canManageCompose(null), false);
  });

  it('pins tenant sessions to their credential tenant and uses the picker only for platform sessions', () => {
    assert.equal(effectiveTenantId(tenantSession, 'tenant-b'), 'tenant-a');
    assert.equal(effectiveTenantId(platformSession, 'tenant-b'), 'tenant-b');
    assert.equal(effectiveTenantId(platformSession, null), null);
  });

  it('validates health observations while preserving unavailable values as null', () => {
    assert.deepEqual(parseAdminHealthSnapshot(health), health);
    assert.equal(parseAdminHealthSnapshot({ ...health, sampledAt: 'later' }), null);
    assert.equal(parseAdminHealthSnapshot({ ...health, activeLeases: -1 }), null);
    assert.equal(parseAdminHealthSnapshot({ ...health, queueIntegrity: { ...health.queueIntegrity, state: 'OKAY' } }), null);
  });

  it('keeps UNKNOWN and overdue HITL signals bounded to the fetched page rows', () => {
    const items = [
      { id: 'unknown-1', state: 'RUNNING', errorCode: 'PROVIDER_OUTCOME_UNKNOWN', deadlineAt: null },
      { id: 'review-late', state: 'WAITING_INPUT', errorCode: null, deadlineAt: '2026-10-11T11:00:00.000Z' },
      { id: 'review-open', state: 'WAITING_INPUT', errorCode: null, deadlineAt: '2026-10-11T13:00:00.000Z' },
      { id: 'done', state: 'SUCCEEDED', errorCode: null, deadlineAt: null },
    ];
    assert.deepEqual(deriveOperationSignals(items, Date.parse('2026-10-11T12:00:00.000Z')), {
      unknown: [items[0]],
      waitingInput: [items[1], items[2]],
      overdueInput: [items[1]],
    });
  });

  it('classifies bad or old timestamps as unknown or stale instead of healthy', () => {
    const now = Date.parse('2026-10-11T12:00:00.000Z');
    assert.equal(sampleAgeState('invalid', now), 'unknown');
    assert.equal(sampleAgeState(null, now), 'unknown');
    assert.equal(sampleAgeState('2026-10-11T11:58:59.000Z', now), 'stale');
    assert.equal(sampleAgeState('2026-10-11T11:59:30.000Z', now), 'fresh');
  });
});
