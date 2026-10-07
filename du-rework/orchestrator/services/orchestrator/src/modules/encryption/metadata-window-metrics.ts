import {
  InMemoryMetricsRegistry,
  type MetricsRegistry,
} from '@du/observability';
import {
  looksLikeSealedEnvelope,
  MetadataCryptoError,
  type MetadataContext,
} from '../runtime/metadata-crypto';
import type {
  MetadataReadPolicy,
  MetadataReader,
} from './metadata-read-policy';

/**
 * Metric names from encmeta-window-design-808, expressed in the registry's
 * required snake_case form. The design's dot separates the metric family
 * (metadata_read / backfill); @du/observability rejects dots in metric names.
 */
export const METADATA_WINDOW_METRIC_NAMES = {
  sealedTotal: 'metadata_read_sealed_total',
  plaintextTotal: 'metadata_read_plaintext_total',
  blockedTotal: 'metadata_read_blocked_total',
  mode: 'metadata_read_mode',
  migratedTotal: 'backfill_migrated_total',
  verifiedTotal: 'backfill_verified_total',
  failedTotal: 'backfill_failed_total',
  unresolved: 'backfill_unresolved',
  state: 'backfill_state',
} as const;

export type MetadataBackfillState = 'complete' | 'incomplete';
export type MetadataPlaintextBlockedReason = 'forbid' | 'expired' | 'outside_window';

/** Deltas are used for counters; unresolvedReferences/state are latest snapshot values. */
export interface MetadataBackfillProgress {
  readonly migratedDelta: number;
  readonly verifiedDelta: number;
  readonly failedDelta: number;
  readonly unresolvedReferences: number;
  readonly blockers: number;
  readonly state: MetadataBackfillState;
}

export interface MetadataWindowMetrics {
  recordBackfillProgress(progress: MetadataBackfillProgress): void;
  recordRead(kind: 'sealed' | 'plaintext' | 'blocked', reason?: MetadataPlaintextBlockedReason): void;
  readonly snapshot: () => ReturnType<MetricsRegistry['snapshot']>;
  readonly registry: MetricsRegistry;
}

const COUNTER_FIELDS = ['migratedDelta', 'verifiedDelta', 'failedDelta'] as const;

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

/** Build the bounded metrics used by the metadata-read and backfill window. */
export function createMetadataWindowMetrics(
  policy: MetadataReadPolicy,
  registry: MetricsRegistry = new InMemoryMetricsRegistry(),
): MetadataWindowMetrics {
  const sealed = registry.counter(METADATA_WINDOW_METRIC_NAMES.sealedTotal);
  const plaintext = registry.counter(METADATA_WINDOW_METRIC_NAMES.plaintextTotal);
  const blocked = registry.counter(METADATA_WINDOW_METRIC_NAMES.blockedTotal);
  const mode = registry.gauge(METADATA_WINDOW_METRIC_NAMES.mode);
  const migrated = registry.counter(METADATA_WINDOW_METRIC_NAMES.migratedTotal);
  const verified = registry.counter(METADATA_WINDOW_METRIC_NAMES.verifiedTotal);
  const failed = registry.counter(METADATA_WINDOW_METRIC_NAMES.failedTotal);
  const unresolved = registry.gauge(METADATA_WINDOW_METRIC_NAMES.unresolved);
  const state = registry.gauge(METADATA_WINDOW_METRIC_NAMES.state);

  // The configured mode is a 1-valued, low-cardinality gauge. The same
  // metric carries window timestamps as values, never as high-cardinality labels.
  mode.set(1, { mode: policy.mode, point: 'active' });
  if (policy.window) {
    mode.set(policy.window.startsAtMs, { mode: policy.mode, point: 'starts_at_ms' });
    mode.set(policy.window.expiresAtMs, { mode: policy.mode, point: 'expires_at_ms' });
  }
  // No inventory has been reported yet. Keep the observable state explicitly
  // incomplete instead of fabricating an unresolved count of zero.
  state.set(1, { state: 'incomplete' });

  const snapshot = (): ReturnType<MetricsRegistry['snapshot']> => registry.snapshot();

  return {
    registry,
    snapshot,
    recordRead(kind, reason?: MetadataPlaintextBlockedReason): void {
      if (kind === 'sealed') sealed.inc();
      else if (kind === 'plaintext') plaintext.inc();
      else blocked.inc(reason ? { reason } : {});
    },
    recordBackfillProgress(progress): void {
      if (progress.state !== 'complete' && progress.state !== 'incomplete') {
        throw new Error('backfill state must be complete or incomplete');
      }
      for (const field of COUNTER_FIELDS) assertCount(field, progress[field]);
      assertCount('unresolvedReferences', progress.unresolvedReferences);
      assertCount('blockers', progress.blockers);

      if (progress.migratedDelta > 0) migrated.inc({}, progress.migratedDelta);
      if (progress.verifiedDelta > 0) verified.inc({}, progress.verifiedDelta);
      if (progress.failedDelta > 0) failed.inc({}, progress.failedDelta);
      unresolved.set(progress.unresolvedReferences);
      state.set(0, { state: progress.state === 'complete' ? 'incomplete' : 'complete' });
      state.set(1, { state: progress.state });
    },
  };
}

function isPlaintextValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return !looksLikeSealedEnvelope(value);
}

function isNotSealed(error: unknown): boolean {
  return error instanceof MetadataCryptoError && error.code === 'NOT_SEALED';
}

function blockedReason(policy: MetadataReadPolicy, nowMs: number): MetadataPlaintextBlockedReason {
  if (policy.mode === 'forbid') return 'forbid';
  if (policy.window && nowMs >= policy.window.expiresAtMs) return 'expired';
  return 'outside_window';
}

/**
 * Decorate the existing facade at composition time so counters reflect actual
 * plaintext results/refusals, not calls to allowPlaintext (which is evaluated
 * before the crypto helper has classified sealed versus legacy input).
 */
export function observeMetadataReader(
  reader: MetadataReader,
  policy: MetadataReadPolicy,
  metrics: Pick<MetadataWindowMetrics, 'recordRead'>,
  now: () => number = Date.now,
): MetadataReader {
  const run = async <T>(value: unknown, read: () => Promise<T>): Promise<T> => {
    const plaintextInput = isPlaintextValue(value);
    try {
      const result = await read();
      if (plaintextInput) metrics.recordRead('plaintext');
      else if (value !== undefined && value !== null) metrics.recordRead('sealed');
      return result;
    } catch (error) {
      if (plaintextInput && isNotSealed(error)) {
        metrics.recordRead('blocked', blockedReason(policy, now()));
      }
      throw error;
    }
  };

  return Object.freeze({
    mode: reader.mode,
    allowPlaintext: (nowMs?: number) => reader.allowPlaintext(nowMs),
    readStored(value: unknown, context: MetadataContext): Promise<unknown> {
      return run(value, () => reader.readStored(value, context));
    },
    readStoredText(value: unknown, context: MetadataContext): Promise<string | undefined> {
      return run(value, () => reader.readStoredText(value, context));
    },
  });
}
