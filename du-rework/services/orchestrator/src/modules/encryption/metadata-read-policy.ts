import {
  assertReadableWithoutSeam,
  MetadataCryptoError,
  readStoredText,
  type MetadataContext,
  type MetadataCrypto,
} from '../runtime/metadata-crypto';
import { createBoundedDualReadWindow, type BoundedDualReadWindow } from './legacy-payload-migration';

/**
 * CONTROL-PLANE-IMPL-818: the ONE control point for `allowPlaintext`.
 *
 * Before this module every reader passed a LITERAL `true` (eight call sites)
 * and the value was not controllable at all: no env, no policy, no way to
 * close the ENC-09 window short of editing code. The policy is built once at
 * boot and injected, so the decision is made in one place and is visible.
 *
 * The window itself is NOT re-implemented here: `BoundedDualReadWindow`,
 * `createBoundedDualReadWindow` (which enforces `MAX_DUAL_READ_WINDOW_MS`,
 * 14 days) and `readDuringBoundedDualRead` live in `legacy-payload-migration`
 * and are reused verbatim. This module only decides WHETHER the legacy lane
 * is open and adapts the two readers to that decision.
 */

/** The closed mode set. A typo is a boot failure, never a silent default. */
export const METADATA_PLAINTEXT_READ_MODE = ['window', 'forbid'] as const;
export type MetadataPlaintextReadMode = (typeof METADATA_PLAINTEXT_READ_MODE)[number];

export function isMetadataPlaintextReadMode(value: unknown): value is MetadataPlaintextReadMode {
  return typeof value === 'string'
    && (METADATA_PLAINTEXT_READ_MODE as readonly string[]).includes(value);
}

export class MetadataReadPolicyError extends Error {
  public constructor(message: string) {
    super('refusing to build the metadata read policy: ' + message);
    this.name = 'MetadataReadPolicyError';
  }
}

/**
 * The standard error table for a plaintext read. It is the whole contract:
 *
 * | mode     | now inside window | now outside window | plaintext result |
 * |----------|-------------------|--------------------|------------------|
 * | window   | yes               | -                  | returned verbatim|
 * | window   | -                 | yes (EXPIRED)      | NOT_SEALED       |
 * | forbid   | -                 | -                  | NOT_SEALED       |
 *
 * `forbid` carries no window at all, so "expired" is not a state it can be in.
 * A SEALED value never consults this table: it always takes the normal
 * decoder and fails closed on its own (AUTHENTICATION_FAILED /
 * CONTEXT_MISMATCH), in every mode.
 */
export type MetadataPlaintextDecision = 'allow' | 'not_sealed';

export interface MetadataReadPolicy {
  readonly mode: MetadataPlaintextReadMode;
  /** Present iff mode === 'window'. A 14-day cap is enforced at construction. */
  readonly window: BoundedDualReadWindow | null;
  readonly startedAtMs: number;
  /** True only while the legacy lane is open. Drives every `allowPlaintext`. */
  allowPlaintext(nowMs?: number): boolean;
}

export function createMetadataReadPolicy(
  mode: MetadataPlaintextReadMode,
  window: BoundedDualReadWindow | null,
  startedAtMs: number = Date.now(),
): MetadataReadPolicy {
  if (!isMetadataPlaintextReadMode(mode)) {
    throw new MetadataReadPolicyError('unknown mode ' + JSON.stringify(mode));
  }
  if (mode === 'window' && window === null) {
    throw new MetadataReadPolicyError("mode 'window' requires a bounded dual-read window");
  }
  if (mode === 'forbid' && window !== null) {
    throw new MetadataReadPolicyError("mode 'forbid' must not carry a window");
  }
  if (!Number.isFinite(startedAtMs)) {
    throw new MetadataReadPolicyError('startedAtMs must be a finite number');
  }
  return Object.freeze({
    mode,
    window,
    startedAtMs,
    allowPlaintext(nowMs: number = Date.now()): boolean {
      return mode === 'window' && window !== null && window.allowsLegacyRead(nowMs);
    },
  });
}

/** The table, as a function, so a test can pin it without reading prose. */
export function decidePlaintextRead(
  policy: MetadataReadPolicy,
  nowMs?: number,
): MetadataPlaintextDecision {
  return policy.allowPlaintext(nowMs) ? 'allow' : 'not_sealed';
}

/**
 * The one reader every consumer uses. It is a thin adapter: the sealed path
 * goes to the existing decoder, the plaintext path asks the policy. There is
 * no third behaviour and no per-call-site boolean.
 *
 * CONTROL-PLANE-POLICY-FIX-822: the no-seam rule is NOT the policy. With no
 * seam configured, a sealed value still fails closed (KEY_PROVIDER_FAILED) and
 * a never-sealed value is returned raw ONLY while the policy allows it —
 * `forbid` and an expired window both fail closed with NOT_SEALED. Both read
 * paths apply the same rule; neither may return raw plaintext on its own.
 */
export interface MetadataReader {
  readonly mode: MetadataPlaintextReadMode;
  allowPlaintext(nowMs?: number): boolean;
  /** Parsed jsonb slots. No seam => no-seam rule AND the policy gate. */
  readStored(value: unknown, context: MetadataContext): Promise<unknown>;
  /** TEXT columns holding a JSON envelope. Same rule as readStored. */
  readStoredText(value: unknown, context: MetadataContext): Promise<string | undefined>;
}

/** The fail-closed error for a plaintext read the policy does not allow. */
function plaintextReadRefused(): MetadataCryptoError {
  return new MetadataCryptoError(
    'NOT_SEALED',
    'control-plane metadata is stored as plaintext; the plaintext read policy forbids it',
  );
}

export function createMetadataReader(
  crypto: MetadataCrypto | undefined,
  policy: MetadataReadPolicy,
): MetadataReader {
  return Object.freeze({
    mode: policy.mode,
    allowPlaintext: (nowMs?: number) => policy.allowPlaintext(nowMs),
    async readStored(value: unknown, context: MetadataContext): Promise<unknown> {
      if (!crypto) {
        // CONTROL-PLANE-POLICY-FIX-822: the no-seam rule is kept, but it is not
        // the policy. A sealed value fails closed (KEY_PROVIDER_FAILED); a
        // never-sealed one is returned raw ONLY while the policy allows it.
        assertReadableWithoutSeam(value);
        if (!policy.allowPlaintext()) throw plaintextReadRefused();
        return value;
      }
      return crypto.readStored(value, context, policy.allowPlaintext());
    },
    async readStoredText(value: unknown, context: MetadataContext): Promise<string | undefined> {
      if (crypto) {
        return readStoredText(crypto, value, context, policy.allowPlaintext());
      }
      // Same rule as readStored, mirrored for the TEXT shape. The crypto helper
      // would hand the raw value back verbatim with no seam — the exact bypass
      // 822 closes — so the gate is applied here instead of delegating.
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string') {
        throw new MetadataCryptoError(
          'INVALID_INPUT',
          'text metadata reader received a non-string value; jsonb values go through readStored',
        );
      }
      assertReadableWithoutSeam(value);
      if (!policy.allowPlaintext()) throw plaintextReadRefused();
      return value;
    },
  });
}

/**
 * The compatibility policy for an embedder that supplies none.
 *
 * The PRODUCTION boot (`buildEncryptionBootOptions`) requires an explicit mode
 * and fails without one, so this default is never reached in a deployment.
 * In-process `createApp` callers that predate the policy get the pre-policy
 * behaviour — plaintext readable — but BOUNDED by the 14-day cap instead of
 * unbounded, so it cannot become a forever window.
 */
const COMPATIBILITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function createCompatibilityMetadataReadPolicy(
  nowMs: number = Date.now(),
  maxWindowMs: number = COMPATIBILITY_WINDOW_MS,
): MetadataReadPolicy {
  return createMetadataReadPolicy('window', createBoundedDualReadWindow(nowMs, nowMs + maxWindowMs), nowMs);
}

export function isMetadataReader(value: unknown): value is MetadataReader {
  return typeof value === 'object' && value !== null
    && typeof (value as { readStored?: unknown }).readStored === 'function'
    && typeof (value as { readStoredText?: unknown }).readStoredText === 'function';
}

// One compatibility reader per seam instance: repeated fallbacks must share a
// single window (built once at first use) rather than open a fresh 14-day
// window on every call.
const COMPATIBILITY_READERS = new WeakMap<object, MetadataReader>();
let undefinedSeamCompatibilityReader: MetadataReader | null = null;

/**
 * The bounded fallback used when a caller supplies a seam but no policy.
 * Exists so no code path has to spell `allowPlaintext: true` itself: the
 * literal lives HERE once, bounded by the 14-day compatibility window, and
 * every production path injects the boot policy instead.
 */
export function compatibilityMetadataReader(
  crypto: MetadataCrypto | undefined,
): MetadataReader {
  if (crypto === undefined) {
    undefinedSeamCompatibilityReader ??= createMetadataReader(undefined, createCompatibilityMetadataReadPolicy());
    return undefinedSeamCompatibilityReader;
  }
  let reader = COMPATIBILITY_READERS.get(crypto);
  if (!reader) {
    reader = createMetadataReader(crypto, createCompatibilityMetadataReadPolicy());
    COMPATIBILITY_READERS.set(crypto, reader);
  }
  return reader;
}