jest.mock('../src/modules/encryption/legacy-payload-migration', () => ({
  createBoundedDualReadWindow: (startsAtMs: number, expiresAtMs: number) => ({
    startsAtMs,
    expiresAtMs,
    allowsLegacyRead: (nowMs = Date.now()) => nowMs >= startsAtMs && nowMs < expiresAtMs,
  }),
  canRetireLegacyPayloads: (
    inventory: { unresolvedReferences: number },
    backupSignedOff: boolean,
  ) => backupSignedOff === true && inventory.unresolvedReferences === 0,
}));

import { InMemoryMetricsRegistry } from '@du/observability';
import {
  MetadataCryptoError,
  type MetadataContext,
} from '../src/modules/runtime/metadata-crypto';
import {
  createMetadataReadPolicy,
  createMetadataReader,
  type MetadataReader,
} from '../src/modules/encryption/metadata-read-policy';
import {
  createMetadataWindowMetrics,
  METADATA_WINDOW_METRIC_NAMES,
  observeMetadataReader,
} from '../src/modules/encryption/metadata-window-metrics';
import {
  createMetadataWindowControl,
  MetadataWindowControlError,
} from '../src/modules/encryption/metadata-window-control';
import type { AdminActionAuth } from '../src/modules/admin-actions/rbac';

const NOW = Date.now();
const context: MetadataContext = {
  tenantId: 'tenant-1',
  slot: 'operations.input_ref',
  refId: 'operation-1',
};

function makeWindowPolicy(startsAtMs = NOW - 1_000, expiresAtMs = NOW + 1_000) {
  return createMetadataReadPolicy(
    'window',
    {
      startsAtMs,
      expiresAtMs,
      allowsLegacyRead: (nowMs = Date.now()) => nowMs >= startsAtMs && nowMs < expiresAtMs,
    },
    startsAtMs,
  );
}

function metricValue(
  metrics: ReturnType<typeof createMetadataWindowMetrics>,
  name: string,
  labels: Record<string, string | number | boolean> = {},
): number | undefined {
  return metrics.snapshot().find(
    (entry) => entry.name === name && JSON.stringify(entry.labels) === JSON.stringify(labels),
  )?.value;
}

describe('metadata read window metrics', () => {
  it('records successful plaintext reads and unresolved slot count in the existing registry', async () => {
    const policy = makeWindowPolicy();
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const reader = observeMetadataReader(
      createMetadataReader(undefined, policy),
      policy,
      metrics,
      () => NOW,
    );

    await expect(reader.readStored({ legacy: true }, context)).resolves.toEqual({ legacy: true });
    await expect(reader.readStoredText('legacy-text-ref', context)).resolves.toBe('legacy-text-ref');
    metrics.recordBackfillProgress({
      migratedDelta: 2,
      verifiedDelta: 2,
      failedDelta: 0,
      unresolvedReferences: 3,
      blockers: 1,
      state: 'incomplete',
    });

    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.plaintextTotal)).toBe(2);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.unresolved)).toBe(3);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.migratedTotal)).toBe(2);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.verifiedTotal)).toBe(2);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.state, { state: 'incomplete' })).toBe(1);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.mode, { mode: 'window', point: 'expires_at_ms' }))
      .toBe(NOW + 1_000);
  });

  it('counts a sealed value separately from plaintext', async () => {
    const policy = makeWindowPolicy();
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const sealedReader: MetadataReader = {
      mode: policy.mode,
      allowPlaintext: (nowMs?: number) => policy.allowPlaintext(nowMs),
      async readStored() { return { opened: true }; },
      async readStoredText() { return '{"opened":true}'; },
    };
    const reader = observeMetadataReader(sealedReader, policy, metrics, () => NOW);
    const envelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      ciphertext: 'ciphertext',
      dek: {},
      nonce: 'nonce',
      tag: 'tag',
    };

    await expect(reader.readStored(envelope, context)).resolves.toEqual({ opened: true });
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.sealedTotal)).toBe(1);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.plaintextTotal)).toBeUndefined();
  });

  it('records a refused plaintext read as blocked in forbid mode', async () => {
    const policy = createMetadataReadPolicy('forbid', null, NOW);
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const reader = observeMetadataReader(
      createMetadataReader(undefined, policy),
      policy,
      metrics,
      () => NOW,
    );

    await expect(reader.readStored('legacy-ref', context)).rejects.toMatchObject({
      code: 'NOT_SEALED',
    });
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.blockedTotal, { reason: 'forbid' })).toBe(1);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.plaintextTotal)).toBeUndefined();
  });

  it('fails closed after expiry and increments blocked with the expired reason', async () => {
    const policy = makeWindowPolicy(NOW - 2_000, NOW - 1_000);
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const reader = observeMetadataReader(
      createMetadataReader(undefined, policy),
      policy,
      metrics,
      () => NOW,
    );

    await expect(reader.readStored('legacy-ref', context)).rejects.toBeInstanceOf(MetadataCryptoError);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.blockedTotal, { reason: 'expired' })).toBe(1);
    expect(metricValue(metrics, METADATA_WINDOW_METRIC_NAMES.plaintextTotal)).toBeUndefined();
  });
});

describe('metadata window closure authorization', () => {
  it('denies closure without a CSRF-verified, identified platform admin and writes no audit', async () => {
    const policy = makeWindowPolicy();
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const record = jest.fn(async () => ({ id: 'audit-1' }));
    const control = createMetadataWindowControl({
      policy,
      metrics,
      audit: { record },
      resolveAuth: async () => null,
      now: () => NOW,
    });

    await expect(control.requestCloseForNextBoot({}, { backupSignedOff: true }))
      .rejects.toMatchObject({ code: 'OPERATOR_AUTH_REQUIRED' });
    expect(record).not.toHaveBeenCalled();
  });

  it('requires a signed backup and complete zero-blocker backfill; zero metrics do not auto-close', async () => {
    const policy = makeWindowPolicy();
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const record = jest.fn(async () => ({ id: 'audit-1' }));
    const authorized: AdminActionAuth = {
      kind: 'cookie',
      role: 'admin',
      csrfOk: true,
      principalId: 'operator-7',
      issuer: 'https://id.example.test',
    };
    const control = createMetadataWindowControl({
      policy,
      metrics,
      audit: { record },
      resolveAuth: async () => authorized,
      now: () => NOW,
    });
    control.recordBackfillProgress({
      migratedDelta: 0,
      verifiedDelta: 0,
      failedDelta: 0,
      unresolvedReferences: 0,
      blockers: 0,
      state: 'complete',
    });
    expect(record).not.toHaveBeenCalled();

    await expect(control.requestCloseForNextBoot({}, { backupSignedOff: false }))
      .rejects.toBeInstanceOf(MetadataWindowControlError);
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the window open when backfill is incomplete, unresolved, or blocked', async () => {
    const progressCases = [
      { migratedDelta: 0, verifiedDelta: 0, failedDelta: 0, unresolvedReferences: 0, blockers: 0, state: 'incomplete' as const },
      { migratedDelta: 0, verifiedDelta: 0, failedDelta: 0, unresolvedReferences: 1, blockers: 0, state: 'complete' as const },
      { migratedDelta: 0, verifiedDelta: 0, failedDelta: 0, unresolvedReferences: 0, blockers: 1, state: 'complete' as const },
    ];

    for (const progress of progressCases) {
      const policy = makeWindowPolicy();
      const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
      const record = jest.fn(async () => ({ id: 'audit-1' }));
      const control = createMetadataWindowControl({
        policy,
        metrics,
        audit: { record },
        resolveAuth: async () => ({
          kind: 'cookie',
          role: 'admin',
          csrfOk: true,
          principalId: 'operator-7',
          issuer: 'https://id.example.test',
        }),
        now: () => NOW,
      });
      control.recordBackfillProgress(progress);

      await expect(control.requestCloseForNextBoot({}, { backupSignedOff: true }))
        .rejects.toMatchObject({ code: 'WINDOW_NOT_READY' });
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('audits an authorized next-boot close and leaves the live policy unchanged', async () => {
    const policy = makeWindowPolicy();
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const record = jest.fn(async () => ({ id: 'audit-window-close-1' }));
    const authorized: AdminActionAuth = {
      kind: 'cookie',
      role: 'admin',
      csrfOk: true,
      principalId: 'operator-7',
      issuer: 'https://id.example.test',
    };
    const control = createMetadataWindowControl({
      policy,
      metrics,
      audit: { record },
      resolveAuth: async () => authorized,
      now: () => NOW,
    });
    control.recordBackfillProgress({
      migratedDelta: 5,
      verifiedDelta: 5,
      failedDelta: 0,
      unresolvedReferences: 0,
      blockers: 0,
      state: 'complete',
    });

    const result = await control.requestCloseForNextBoot({}, { backupSignedOff: true });

    expect(result).toMatchObject({
      nextMode: 'forbid',
      restartRequired: true,
      auditEventId: 'audit-window-close-1',
      authorizedBy: { issuer: 'https://id.example.test', subject: 'operator-7' },
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: null,
      actor: 'admin',
      actorIssuer: 'https://id.example.test',
      actorSub: 'operator-7',
      actorRole: 'admin',
      action: 'metadata_read.window_close_requested',
      resource: `metadata-read-window:${NOW - 1_000}:${NOW + 1_000}`,
      severity: 'warning',
    }));
    expect(policy.mode).toBe('window');
    expect(policy.allowPlaintext(NOW)).toBe(true);
  });

  it('fails closed when the audit sink cannot persist the closure record', async () => {
    const policy = makeWindowPolicy();
    const metrics = createMetadataWindowMetrics(policy, new InMemoryMetricsRegistry());
    const authorized: AdminActionAuth = {
      kind: 'cookie',
      role: 'admin',
      csrfOk: true,
      principalId: 'operator-7',
      issuer: 'https://id.example.test',
    };
    const control = createMetadataWindowControl({
      policy,
      metrics,
      audit: { record: async () => { throw new Error('offline'); } },
      resolveAuth: async () => authorized,
      now: () => NOW,
    });
    control.recordBackfillProgress({
      migratedDelta: 1,
      verifiedDelta: 1,
      failedDelta: 0,
      unresolvedReferences: 0,
      blockers: 0,
      state: 'complete',
    });

    await expect(control.requestCloseForNextBoot({}, { backupSignedOff: true }))
      .rejects.toMatchObject({ code: 'AUDIT_REQUIRED' });
    expect(policy.mode).toBe('window');
  });
});
