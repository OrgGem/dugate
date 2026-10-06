"use strict";
/**
 * RV01-02 (#8): env -> ServerConfig encryption blocks for the production boot.
 *
 * Closes the ordering hole RV01-01 recorded: `main.ts` passed no crypto blocks
 * to `createApp`, so `metadataCrypto` was `undefined` and every control-plane
 * column kept its plaintext behaviour with no warning.
 *
 * Fail-closed by construction. The only way to get "no encryption" is
 * `ARTIFACT_STORAGE_BACKEND=postgres` with every enable flag off, and that is
 * a positive operator choice rather than a silently ignored config. Anything
 * half-specified throws at boot with the missing field named.
 *
 * The operator surface is ONE JSON env var mapped 1:1 onto the existing
 * `VaultTransitProviderOptions`. Tokens are deliberately NOT in that JSON:
 * `VaultTransitIdentity.token` is a thunk, so a token is re-read per request
 * instead of being frozen into process config at boot.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptionBootConfigError = exports.METADATA_WINDOW_END_ENV = exports.METADATA_WINDOW_START_ENV = exports.METADATA_READ_MODE_ENV = exports.PUBLIC_UPLOAD_ENABLED_ENV = exports.METADATA_ENABLED_ENV = exports.VAULT_DECRYPT_TOKEN_ENV = exports.VAULT_ENCRYPT_TOKEN_ENV = exports.VAULT_TRANSIT_OPTIONS_ENV = void 0;
exports.encryptionIsRequired = encryptionIsRequired;
exports.parseEncryptionBootConfig = parseEncryptionBootConfig;
exports.buildMetadataReadPolicy = buildMetadataReadPolicy;
exports.buildEncryptionBootOptions = buildEncryptionBootOptions;
const vault_transit_provider_1 = require("./vault-transit-provider");
const legacy_payload_migration_1 = require("./legacy-payload-migration");
const metadata_read_policy_1 = require("./metadata-read-policy");
exports.VAULT_TRANSIT_OPTIONS_ENV = 'DU_VAULT_TRANSIT_OPTIONS';
exports.VAULT_ENCRYPT_TOKEN_ENV = 'DU_VAULT_TRANSIT_ENC_TOKEN';
exports.VAULT_DECRYPT_TOKEN_ENV = 'DU_VAULT_TRANSIT_DEC_TOKEN';
exports.METADATA_ENABLED_ENV = 'DU_ENCRYPTION_METADATA_ENABLED';
exports.PUBLIC_UPLOAD_ENABLED_ENV = 'DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED';
// CONTROL-PLANE-IMPL-818: the one operator-facing switch for allowPlaintext.
// REQUIRED: an absent or unknown mode fails the boot (buildMetadataReadPolicy).
exports.METADATA_READ_MODE_ENV = 'DU_METADATA_PLAINTEXT_READ_MODE';
// Required when METADATA_READ_MODE_ENV === 'window'; ignored for 'forbid'.
exports.METADATA_WINDOW_START_ENV = 'DU_METADATA_PLAINTEXT_WINDOW_START';
exports.METADATA_WINDOW_END_ENV = 'DU_METADATA_PLAINTEXT_WINDOW_END';
const MAX_TOKEN_CHARS = 8192;
class EncryptionBootConfigError extends Error {
    constructor(message) {
        super('refusing to boot: ' + message);
        this.name = 'EncryptionBootConfigError';
    }
}
exports.EncryptionBootConfigError = EncryptionBootConfigError;
function readOptional(env, name) {
    const value = env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
}
/** Strict boolean: an unset flag is off, a typo is a boot failure, never a guess. */
function readBoolean(env, name) {
    const raw = readOptional(env, name);
    if (raw === undefined)
        return false;
    if (raw === 'true')
        return true;
    if (raw === 'false')
        return false;
    throw new EncryptionBootConfigError(name + ' must be true or false, got ' + JSON.stringify(raw));
}
function requireNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new EncryptionBootConfigError(label + ' is required and must be a non-empty string');
    }
    return value;
}
function readBoundedInt(value, label, min, max) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new EncryptionBootConfigError(label + ' must be an integer between ' + min + ' and ' + max);
    }
    return value;
}
function parseKeyRefs(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new EncryptionBootConfigError(exports.VAULT_TRANSIT_OPTIONS_ENV + '.allowedKeyRefs must be an object');
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
        throw new EncryptionBootConfigError(exports.VAULT_TRANSIT_OPTIONS_ENV + '.allowedKeyRefs must map at least one key ref');
    }
    const out = {};
    for (const [ref, keyName] of entries) {
        out[ref] = requireNonEmptyString(keyName, exports.VAULT_TRANSIT_OPTIONS_ENV + '.allowedKeyRefs[' + ref + ']');
    }
    return out;
}
function parseConfig(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new EncryptionBootConfigError(exports.VAULT_TRANSIT_OPTIONS_ENV + ' must be valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new EncryptionBootConfigError(exports.VAULT_TRANSIT_OPTIONS_ENV + ' must be a JSON object');
    }
    const source = parsed;
    const transitMount = source['transitMount'];
    if (transitMount !== undefined && typeof transitMount !== 'string') {
        throw new EncryptionBootConfigError(exports.VAULT_TRANSIT_OPTIONS_ENV + '.transitMount must be a string');
    }
    return {
        vaultAddress: requireNonEmptyString(source['vaultAddress'], exports.VAULT_TRANSIT_OPTIONS_ENV + '.vaultAddress'),
        allowedKeyRefs: parseKeyRefs(source['allowedKeyRefs']),
        ...(transitMount === undefined ? {} : { transitMount }),
        ...(source['requestTimeoutMs'] === undefined
            ? {}
            : { requestTimeoutMs: readBoundedInt(source['requestTimeoutMs'], 'requestTimeoutMs', 1, 60_000) }),
        ...(source['metadataKeyRef'] === undefined
            ? {}
            : { metadataKeyRef: requireNonEmptyString(source['metadataKeyRef'], 'metadataKeyRef') }),
        ...(source['publicUploadKeyRef'] === undefined
            ? {}
            : { publicUploadKeyRef: requireNonEmptyString(source['publicUploadKeyRef'], 'publicUploadKeyRef') }),
        ...(source['publicUploadKeyVersion'] === undefined
            ? {}
            : { publicUploadKeyVersion: readBoundedInt(source['publicUploadKeyVersion'], 'publicUploadKeyVersion', 1, Number.MAX_SAFE_INTEGER) }),
        ...(source['publicUploadMaxBytes'] === undefined
            ? {}
            : { publicUploadMaxBytes: readBoundedInt(source['publicUploadMaxBytes'], 'publicUploadMaxBytes', 1, Number.MAX_SAFE_INTEGER) }),
    };
}
/**
 * True when this deployment must have a working Vault surface. `s3` implies it
 * because the encrypted upload gateway is the only artifact write path; the
 * enable flags cover the postgres backend where encryption is still opt-in.
 */
function encryptionIsRequired(env) {
    const backend = readOptional(env, 'ARTIFACT_STORAGE_BACKEND') ?? 'postgres';
    return backend === 's3' || readBoolean(env, exports.METADATA_ENABLED_ENV) || readBoolean(env, exports.PUBLIC_UPLOAD_ENABLED_ENV);
}
function assertKeyRefAllowed(config, keyRef, label) {
    if (keyRef === undefined) {
        throw new EncryptionBootConfigError(label + ' is required but was not set');
    }
    if (!Object.prototype.hasOwnProperty.call(config.allowedKeyRefs, keyRef)) {
        throw new EncryptionBootConfigError(label + ' ' + JSON.stringify(keyRef) + ' is not present in allowedKeyRefs');
    }
}
/**
 * Validate the operator surface. Returns `null` only when encryption is
 * neither required nor enabled — a deliberate postgres + all-flags-off boot.
 */
function parseEncryptionBootConfig(env) {
    return resolveEncryptionBoot(env).config;
}
/**
 * Single decision point for "which blocks are on". Returning the flags
 * alongside the config keeps the enable decision from being recomputed — the
 * two copies drifted once already, which silently dropped the metadata block
 * while validation still demanded its key ref.
 */
function resolveEncryptionBoot(env) {
    const backend = readOptional(env, 'ARTIFACT_STORAGE_BACKEND') ?? 'postgres';
    if (backend === 'vault') {
        throw new EncryptionBootConfigError('ARTIFACT_STORAGE_BACKEND=vault is not a storage backend; artifact storage is postgres or s3, '
            + 'and Vault is configured through ' + exports.VAULT_TRANSIT_OPTIONS_ENV);
    }
    if (backend !== 'postgres' && backend !== 's3') {
        throw new EncryptionBootConfigError('ARTIFACT_STORAGE_BACKEND must be postgres or s3, got ' + JSON.stringify(backend));
    }
    // s3 is the encrypted-upload backend, so it turns on BOTH blocks: the artifact
    // write path and the control-plane columns. Leaving metadata off here is the
    // exact fail-open RV01-02 exists to close.
    const s3 = backend === 's3';
    const metadataEnabled = readBoolean(env, exports.METADATA_ENABLED_ENV) || s3;
    const publicUploadEnabled = readBoolean(env, exports.PUBLIC_UPLOAD_ENABLED_ENV) || s3;
    if (!metadataEnabled && !publicUploadEnabled)
        return { config: null, metadataEnabled, publicUploadEnabled };
    const raw = readOptional(env, exports.VAULT_TRANSIT_OPTIONS_ENV);
    if (raw === undefined) {
        throw new EncryptionBootConfigError(exports.VAULT_TRANSIT_OPTIONS_ENV + ' is required when artifact encryption is enabled; refusing to store artifacts in plaintext');
    }
    const config = parseConfig(raw);
    if (metadataEnabled)
        assertKeyRefAllowed(config, config.metadataKeyRef, 'metadataKeyRef');
    if (publicUploadEnabled)
        assertKeyRefAllowed(config, config.publicUploadKeyRef, 'publicUploadKeyRef');
    return { config, metadataEnabled, publicUploadEnabled };
}
function readToken(env, name) {
    const value = readOptional(env, name);
    if (value === undefined) {
        throw new EncryptionBootConfigError(name + ' is required when artifact encryption is enabled');
    }
    if (value.length > MAX_TOKEN_CHARS) {
        throw new EncryptionBootConfigError(name + ' is longer than ' + MAX_TOKEN_CHARS + ' characters');
    }
    return value;
}
/**
 * CONTROL-PLANE-IMPL-818: parse the operator's plaintext-read switch.
 *
 * REQUIRED whenever this deployment has a metadata seam — an absent or
 * unknown mode fails the boot, so `allowPlaintext` can never again be an
 * implicit, uncontrolled `true`. A deployment with no seam at all (postgres,
 * every enable flag off) never parses it: there is no plaintext read to
 * govern, `metadataCrypto` is undefined and the reader applies the no-seam
 * rule.
 *
 * | mode     | required env                | policy built |
 * |----------|-----------------------------|--------------|
 * | `window` | start + end (ISO or epoch)  | bounded window (<= 14 days, enforced by createBoundedDualReadWindow) |
 * | `forbid` | none — carrying window vars is a refusal to boot (contradiction) | no window, `allowPlaintext()` always false |
 *
 * An inverted window, an over-cap window, or an unparseable instant becomes
 * `EncryptionBootConfigError` rather than a silently shifted window.
 */
function buildMetadataReadPolicy(env) {
    const rawMode = readOptional(env, exports.METADATA_READ_MODE_ENV);
    if (rawMode === undefined) {
        throw new EncryptionBootConfigError(exports.METADATA_READ_MODE_ENV + ' is required when metadata encryption is enabled; '
            + 'set it to window (while the ENC-09 backfill is running) or forbid');
    }
    if (!(0, metadata_read_policy_1.isMetadataPlaintextReadMode)(rawMode)) {
        throw new EncryptionBootConfigError(exports.METADATA_READ_MODE_ENV + ' must be window or forbid, got ' + JSON.stringify(rawMode));
    }
    const hasWindowVars = readOptional(env, exports.METADATA_WINDOW_START_ENV) !== undefined
        || readOptional(env, exports.METADATA_WINDOW_END_ENV) !== undefined;
    if (rawMode === 'forbid') {
        if (hasWindowVars) {
            throw new EncryptionBootConfigError(exports.METADATA_READ_MODE_ENV + '=forbid must not be combined with '
                + exports.METADATA_WINDOW_START_ENV + '/' + exports.METADATA_WINDOW_END_ENV
                + ' — forbid admits no window');
        }
        return (0, metadata_read_policy_1.createMetadataReadPolicy)('forbid', null);
    }
    const startsAtMs = readInstantMs(env, exports.METADATA_WINDOW_START_ENV);
    const expiresAtMs = readInstantMs(env, exports.METADATA_WINDOW_END_ENV);
    let window;
    try {
        window = (0, legacy_payload_migration_1.createBoundedDualReadWindow)(startsAtMs, expiresAtMs);
    }
    catch (error) {
        throw new EncryptionBootConfigError(exports.METADATA_WINDOW_START_ENV + '/' + exports.METADATA_WINDOW_END_ENV + ' is not a valid dual-read window: '
            + (error instanceof Error ? error.message : String(error)));
    }
    return (0, metadata_read_policy_1.createMetadataReadPolicy)('window', window, startsAtMs);
}
/** ISO-8601 instant or epoch milliseconds — both are unambiguous on the wire. */
function readInstantMs(env, name) {
    const raw = readOptional(env, name);
    if (raw === undefined) {
        throw new EncryptionBootConfigError(name + ' is required when ' + exports.METADATA_READ_MODE_ENV + '=window');
    }
    if (/^-?\d+$/.test(raw)) {
        const epochMs = Number(raw);
        if (Number.isSafeInteger(epochMs))
            return epochMs;
        throw new EncryptionBootConfigError(name + ' must be an ISO-8601 instant or epoch milliseconds, got ' + JSON.stringify(raw));
    }
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
        throw new EncryptionBootConfigError(name + ' must be an ISO-8601 instant or epoch milliseconds, got ' + JSON.stringify(raw));
    }
    return parsed;
}
/**
 * Build the `createApp` blocks. Encrypt and decrypt identities stay separate
 * objects with separate thunks: `VaultTransitProvider` refuses to share them,
 * and a shared token would collapse the least-privilege split the two suppliers
 * exist to keep.
 */
function buildEncryptionBootOptions(env) {
    const { config, metadataEnabled, publicUploadEnabled } = resolveEncryptionBoot(env);
    if (config === null)
        return null;
    const encryptToken = readToken(env, exports.VAULT_ENCRYPT_TOKEN_ENV);
    const decryptToken = readToken(env, exports.VAULT_DECRYPT_TOKEN_ENV);
    if (encryptToken === decryptToken) {
        throw new EncryptionBootConfigError(exports.VAULT_ENCRYPT_TOKEN_ENV + ' and ' + exports.VAULT_DECRYPT_TOKEN_ENV + ' must be different Vault tokens');
    }
    const keyProvider = new vault_transit_provider_1.VaultTransitProvider({
        vaultAddress: config.vaultAddress,
        allowedKeyRefs: config.allowedKeyRefs,
        encryptIdentity: { token: () => readOptional(env, exports.VAULT_ENCRYPT_TOKEN_ENV) ?? encryptToken },
        decryptIdentity: { token: () => readOptional(env, exports.VAULT_DECRYPT_TOKEN_ENV) ?? decryptToken },
        ...(config.transitMount === undefined ? {} : { transitMount: config.transitMount }),
        ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    });
    const metadataKeyRef = config.metadataKeyRef;
    const publicUploadKeyRef = config.publicUploadKeyRef;
    return {
        cryptoConfig: { allowedKeyRefs: Object.keys(config.allowedKeyRefs) },
        ...(metadataEnabled && metadataKeyRef !== undefined
            ? { metadataEncryption: { keyProvider, keyRef: metadataKeyRef } }
            : {}),
        ...(publicUploadEnabled && publicUploadKeyRef !== undefined
            ? {
                publicUploadEncryption: {
                    keyProvider,
                    keyRef: publicUploadKeyRef,
                    ...(config.publicUploadKeyVersion === undefined
                        ? {}
                        : { keyVersion: config.publicUploadKeyVersion }),
                    ...(config.publicUploadMaxBytes === undefined
                        ? {}
                        : { maxBytes: config.publicUploadMaxBytes }),
                },
            }
            : {}),
    };
}
