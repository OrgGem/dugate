"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataReadPolicyError = exports.METADATA_PLAINTEXT_READ_MODE = void 0;
exports.isMetadataPlaintextReadMode = isMetadataPlaintextReadMode;
exports.createMetadataReadPolicy = createMetadataReadPolicy;
exports.decidePlaintextRead = decidePlaintextRead;
exports.createMetadataReader = createMetadataReader;
exports.createCompatibilityMetadataReadPolicy = createCompatibilityMetadataReadPolicy;
exports.isMetadataReader = isMetadataReader;
exports.compatibilityMetadataReader = compatibilityMetadataReader;
const metadata_crypto_1 = require("../runtime/metadata-crypto");
const legacy_payload_migration_1 = require("./legacy-payload-migration");
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
exports.METADATA_PLAINTEXT_READ_MODE = ['window', 'forbid'];
function isMetadataPlaintextReadMode(value) {
    return typeof value === 'string'
        && exports.METADATA_PLAINTEXT_READ_MODE.includes(value);
}
class MetadataReadPolicyError extends Error {
    constructor(message) {
        super('refusing to build the metadata read policy: ' + message);
        this.name = 'MetadataReadPolicyError';
    }
}
exports.MetadataReadPolicyError = MetadataReadPolicyError;
function createMetadataReadPolicy(mode, window, startedAtMs = Date.now()) {
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
        allowPlaintext(nowMs = Date.now()) {
            return mode === 'window' && window !== null && window.allowsLegacyRead(nowMs);
        },
    });
}
/** The table, as a function, so a test can pin it without reading prose. */
function decidePlaintextRead(policy, nowMs) {
    return policy.allowPlaintext(nowMs) ? 'allow' : 'not_sealed';
}
/** The fail-closed error for a plaintext read the policy does not allow. */
function plaintextReadRefused() {
    return new metadata_crypto_1.MetadataCryptoError('NOT_SEALED', 'control-plane metadata is stored as plaintext; the plaintext read policy forbids it');
}
function createMetadataReader(crypto, policy) {
    return Object.freeze({
        mode: policy.mode,
        allowPlaintext: (nowMs) => policy.allowPlaintext(nowMs),
        async readStored(value, context) {
            if (!crypto) {
                // CONTROL-PLANE-POLICY-FIX-822: the no-seam rule is kept, but it is not
                // the policy. A sealed value fails closed (KEY_PROVIDER_FAILED); a
                // never-sealed one is returned raw ONLY while the policy allows it.
                (0, metadata_crypto_1.assertReadableWithoutSeam)(value);
                if (!policy.allowPlaintext())
                    throw plaintextReadRefused();
                return value;
            }
            return crypto.readStored(value, context, policy.allowPlaintext());
        },
        async readStoredText(value, context) {
            if (crypto) {
                return (0, metadata_crypto_1.readStoredText)(crypto, value, context, policy.allowPlaintext());
            }
            // Same rule as readStored, mirrored for the TEXT shape. The crypto helper
            // would hand the raw value back verbatim with no seam — the exact bypass
            // 822 closes — so the gate is applied here instead of delegating.
            if (value === undefined || value === null)
                return undefined;
            if (typeof value !== 'string') {
                throw new metadata_crypto_1.MetadataCryptoError('INVALID_INPUT', 'text metadata reader received a non-string value; jsonb values go through readStored');
            }
            (0, metadata_crypto_1.assertReadableWithoutSeam)(value);
            if (!policy.allowPlaintext())
                throw plaintextReadRefused();
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
function createCompatibilityMetadataReadPolicy(nowMs = Date.now(), maxWindowMs = COMPATIBILITY_WINDOW_MS) {
    return createMetadataReadPolicy('window', (0, legacy_payload_migration_1.createBoundedDualReadWindow)(nowMs, nowMs + maxWindowMs), nowMs);
}
function isMetadataReader(value) {
    return typeof value === 'object' && value !== null
        && typeof value.readStored === 'function'
        && typeof value.readStoredText === 'function';
}
// One compatibility reader per seam instance: repeated fallbacks must share a
// single window (built once at first use) rather than open a fresh 14-day
// window on every call.
const COMPATIBILITY_READERS = new WeakMap();
let undefinedSeamCompatibilityReader = null;
/**
 * The bounded fallback used when a caller supplies a seam but no policy.
 * Exists so no code path has to spell `allowPlaintext: true` itself: the
 * literal lives HERE once, bounded by the 14-day compatibility window, and
 * every production path injects the boot policy instead.
 */
function compatibilityMetadataReader(crypto) {
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
