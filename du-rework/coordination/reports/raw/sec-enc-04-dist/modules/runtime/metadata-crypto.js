"use strict";
/**
 * ENC-META-01: control-plane metadata crypto for the orchestrator runtime.
 *
 * Every JSON control-plane column (operations.input_ref, tasks.payload_ref,
 * human_waits.response_ref, step_checkpoints.output_ref) carries tenant-
 * supplied business data. Under ADR-18 those must not sit in plaintext in
 * PostgreSQL, Redis, the outbox, or any log/temp copy.
 *
 * Design constraints that drove the shape here:
 *
 *  - The payload is a SMALL inline JSON document (never a document body),
 *    so the chunked streaming facade from ENC-03 is the wrong tool: this is
 *    one authenticated blob that round-trips inside the row it lives in.
 *  - Every value gets its own data-encryption key, wrapped by the ENC-02
 *    Vault Transit provider. No key material is ever persisted beside the
 *    ciphertext, and no caller-supplied key is accepted.
 *  - AAD binds (tenantId, slot, refId). A ciphertext copied from one tenant
    to another, or from one row to another, therefore fails authenticated
    decryption instead of silently decrypting. That is the cross-tenant
    negative the packet asks for, enforced cryptographically rather than
    by a WHERE clause somebody can forget.
 *  - The envelope is self-describing (version/algorithm/keyRef/nonce/tag),
    so key rotation or a future suite change is a version bump, not a
    migration of every row.
 *  - Canonical JSON before hashing, so the content hash a submit path
    already pins stays stable across key reorders.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataCryptoError = exports.METADATA_SLOTS = exports.METADATA_ENVELOPE_VERSION = void 0;
exports.isMetadataSlot = isMetadataSlot;
exports.looksLikeSealedEnvelope = looksLikeSealedEnvelope;
exports.assertReadableWithoutSeam = assertReadableWithoutSeam;
exports.canonicalizeMetadataJson = canonicalizeMetadataJson;
exports.metadataPlaintextHash = metadataPlaintextHash;
exports.createMetadataCrypto = createMetadataCrypto;
exports.readStoredText = readStoredText;
const node_crypto_1 = require("node:crypto");
/** Envelope version. Bump only on a breaking change to the sealed shape. */
exports.METADATA_ENVELOPE_VERSION = 1;
/** AES-256-GCM parameters; identical to the storage facade (ENC-03). */
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/**
 * The control-plane column an envelope belongs to. Bound into the AAD so a
 * sealed value cannot be moved between columns even within one tenant —
 * a tasks.payload_ref blob replayed into operations.input_ref is refused.
 */
exports.METADATA_SLOTS = [
    'operations.input_ref',
    'tasks.payload_ref',
    'human_waits.response_ref',
    'step_checkpoints.output_ref',
    'step_checkpoints.session_ref',
    // P745-CARRIER-IMPL-A (Δ-PC-1): the sealed prompt-content carrier. A NEW
    // slot on purpose — the AAD's cross-column separation (above) must keep a
    // carrier envelope undecryptable if it is ever replayed into another
    // column, and an input_ref envelope must not open as a carrier.
    'operations.prompt_overrides_ref',
    // ENCMETA-RESULTREF-IMPL (Option A): the terminal result pointer is
    // tenant/worker-supplied data resting in PostgreSQL. Two slots because the
    // same string is written to TWO rows — an envelope bound to (tenant,
    // 'tasks.result_ref', taskId) must fail CONTEXT_MISMATCH if replayed onto
    // the operation row, and vice versa.
    'tasks.result_ref',
    'operations.result_ref',
];
function isMetadataSlot(value) {
    return (typeof value === 'string' &&
        exports.METADATA_SLOTS.includes(value));
}
class MetadataCryptoError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'MetadataCryptoError';
        this.code = code;
    }
}
exports.MetadataCryptoError = MetadataCryptoError;
function fail(code, message) {
    throw new MetadataCryptoError(code, message);
}
/**
 * Does this parsed value look like one of our envelopes?
 *
 * BA-02: needed before a seam exists, so `readStoredText` can tell a sealed row
 * (which needs a key) from a legacy plaintext ref (which does not). Mirrors the
 * discriminator `createMetadataCrypto().isSealed` applies.
 */
/** Same test, accepting either a TEXT column value or an already-parsed jsonb one. */
function looksLikeSealedEnvelope(value) {
    if (typeof value === 'string') {
        try {
            return looksLikeEnvelope(JSON.parse(value));
        }
        catch {
            return false;
        }
    }
    return looksLikeEnvelope(value);
}
/**
 * WRAPPER-FIX-812 (A15): a SEALED value read with no seam must fail closed on
 * every path.
 *
 * The runtime wrapper used to `return value` before touching the crypto, so a
 * sealed envelope came back as raw JSON while this reader threw for the same
 * value — the BA-02 guard bypassed through the wrapper. Both now call this, so
 * they share one rule and one error code.
 *
 * The legitimate no-seam path is a value that was never sealed (a backfill
 * feeding its first copy, a deployment with encryption simply off). That is
 * not envelope-shaped and still passes through verbatim — deliberately.
 */
function assertReadableWithoutSeam(value) {
    if (!looksLikeSealedEnvelope(value))
        return;
    fail('KEY_PROVIDER_FAILED', 'metadata is sealed but no metadata seam is configured');
}
function looksLikeEnvelope(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const v = value;
    return v.version === exports.METADATA_ENVELOPE_VERSION
        && v.algorithm === 'aes-256-gcm'
        && typeof v.ciphertext === 'string'
        && typeof v.dek === 'object' && v.dek !== null
        && typeof v.nonce === 'string'
        && typeof v.tag === 'string';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Canonical JSON: object keys sorted recursively. The same logical value then
 * always produces the same bytes, so the content hash the submit path pins
 * survives a key-order change. Arrays keep their order (order is meaning).
 */
function canonicalizeMetadataJson(value) {
    const walk = (node) => {
        if (Array.isArray(node))
            return node.map(walk);
        if (isRecord(node)) {
            const sorted = {};
            for (const key of Object.keys(node).sort())
                sorted[key] = walk(node[key]);
            return sorted;
        }
        return node;
    };
    return Buffer.from(JSON.stringify(walk(value) ?? null), 'utf8');
}
/** SHA-256 hex over the canonical bytes. */
function metadataPlaintextHash(value) {
    return (0, node_crypto_1.createHash)('sha256').update(canonicalizeMetadataJson(value)).digest('hex');
}
/**
 * The AAD is a digest of the binding context rather than the context itself:
 * it stays a fixed 32 bytes whatever the ids look like, and it leaks no row
 * identifier into a place an attacker can read without the key.
 */
function deriveAad(context) {
    return (0, node_crypto_1.createHash)('sha256')
        .update(`${context.tenantId}|${context.slot}|${context.refId}`, 'utf8')
        .digest();
}
function assertContext(context) {
    if (!context.tenantId)
        fail('INVALID_INPUT', 'tenantId is required to bind a metadata envelope');
    if (!context.refId)
        fail('INVALID_INPUT', 'refId is required to bind a metadata envelope');
    if (!isMetadataSlot(context.slot)) {
        fail('INVALID_INPUT', `unknown metadata slot ${String(context.slot)}`);
    }
}
const ENVELOPE_FIELDS = [
    'version',
    'algorithm',
    'keyRef',
    'dek',
    'nonce',
    'tag',
    'aad',
    'ciphertext',
];
function assertEnvelopeShape(value) {
    if (!isRecord(value))
        fail('NOT_SEALED', 'metadata value is not a sealed envelope');
    for (const field of ENVELOPE_FIELDS) {
        if (value[field] === undefined) {
            fail('NOT_SEALED', `sealed metadata is missing ${field}`);
        }
    }
    if (value.version !== exports.METADATA_ENVELOPE_VERSION) {
        fail('NOT_SEALED', `unsupported metadata envelope version ${String(value.version)}`);
    }
    if (!isRecord(value.dek)) {
        fail('NOT_SEALED', 'sealed metadata dek is not a wrapped DEK envelope');
    }
}
/**
 * Build the metadata crypto seam over the ENC-02 Vault Transit provider.
 *
 * The provider is injected rather than constructed here so the runtime has
 * exactly one configured key path, and so an offline test can drive the same
 * code with a deterministic provider instead of a fake cipher.
 */
function createMetadataCrypto(keyProvider, keyRef) {
    if (!keyRef)
        fail('INVALID_INPUT', 'metadata keyRef must be configured');
    const isSealed = (value) => {
        if (!isRecord(value))
            return false;
        // The discriminator pair is a shape a legacy plaintext control-plane
        // object can never carry, so an old row is never misread as an envelope.
        return (value.version === exports.METADATA_ENVELOPE_VERSION &&
            value.algorithm === 'aes-256-gcm' &&
            typeof value.ciphertext === 'string' &&
            isRecord(value.dek) &&
            typeof value.nonce === 'string' &&
            typeof value.tag === 'string');
    };
    const seal = async (value, context, options = {}) => {
        assertContext(context);
        const plaintext = canonicalizeMetadataJson(value);
        const dek = (0, node_crypto_1.randomBytes)(DEK_BYTES);
        const nonce = (0, node_crypto_1.randomBytes)(NONCE_BYTES);
        const aad = deriveAad(context);
        let wrapped;
        try {
            wrapped = await keyProvider.wrapDek(dek, keyRef, options.keyVersion);
        }
        catch (err) {
            fail('KEY_PROVIDER_FAILED', `failed to wrap metadata DEK: ${err.message}`);
        }
        const cipher = (0, node_crypto_1.createCipheriv)('aes-256-gcm', dek, nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return {
            version: exports.METADATA_ENVELOPE_VERSION,
            algorithm: 'aes-256-gcm',
            keyRef,
            dek: wrapped,
            nonce: nonce.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            aad: aad.toString('base64'),
            ciphertext: ciphertext.toString('base64'),
            plaintextSha256: (0, node_crypto_1.createHash)('sha256').update(plaintext).digest('hex'),
        };
    };
    const open = async (sealed, context) => {
        assertContext(context);
        assertEnvelopeShape(sealed);
        let dek;
        try {
            dek = await keyProvider.unwrapDek(sealed.dek);
        }
        catch (err) {
            fail('KEY_PROVIDER_FAILED', `failed to unwrap metadata DEK: ${err.message}`);
        }
        // Compare the stored AAD to the one this context demands BEFORE touching
        // the cipher. A cross-tenant or cross-slot replay therefore reports a
        // context mismatch instead of an authentication failure, and never gets
        // as far as attempting a decryption with the wrong binding.
        const expectedAad = deriveAad(context);
        const storedAad = Buffer.from(sealed.aad, 'base64');
        if (storedAad.length !== expectedAad.length || !(0, node_crypto_1.timingSafeEqual)(storedAad, expectedAad)) {
            fail('CONTEXT_MISMATCH', 'metadata envelope is bound to a different tenant, slot, or row');
        }
        let plaintext;
        try {
            const decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', dek, Buffer.from(sealed.nonce, 'base64'), {
                authTagLength: TAG_BYTES,
            });
            decipher.setAAD(expectedAad);
            decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
            plaintext = Buffer.concat([
                decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
                decipher.final(),
            ]);
        }
        catch {
            fail('AUTHENTICATION_FAILED', 'metadata envelope failed authenticated decryption');
        }
        return JSON.parse(plaintext.toString('utf8'));
    };
    const readStored = async (value, context, allowPlaintext) => {
        if (!isSealed(value)) {
            if (!allowPlaintext) {
                fail('NOT_SEALED', 'control-plane metadata is stored as plaintext; backfill required');
            }
            return value;
        }
        return open(value, context);
    };
    return { seal, open, isSealed, readStored };
}
/**
 * ENCMETA-RESULTREF-IMPL: read a TEXT column that may hold either a sealed
 * envelope (JSON text) or a legacy plaintext value.
 *
 * `readStored` operates on parsed values (jsonb columns); text columns hand
 * back strings. This lifts the same convention one level: an envelope-looking
 * string is parsed and then opened FAIL-CLOSED (an envelope that does not open
 * throws); anything else is returned verbatim when `allowPlaintext` — the
 * backfill window — and a non-JSON plaintext is never mistaken for an
 * envelope. No seam → the stored value verbatim, as everywhere else.
 */
async function readStoredText(crypto, value, context, allowPlaintext) {
    if (value === undefined || value === null)
        return undefined;
    // BA-02: a non-string here is a caller bug — a parsed jsonb value belongs to
    // `readStored`. `String(value)` would hand back "[object Object]" and hide it.
    if (typeof value !== 'string') {
        fail('INVALID_INPUT', 'text metadata reader received a non-string value; jsonb values go through readStored');
    }
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        // Not JSON at all: a legacy plaintext ref — never an envelope.
        parsed = undefined;
    }
    if (!crypto) {
        // WRAPPER-FIX-812 (A15): share the no-seam decision with the runtime
        // wrapper. Only an explicit plaintext-window caller may pass legacy data.
        assertReadableWithoutSeam(value);
        return value;
    }
    if (parsed === undefined || !crypto.isSealed(parsed)) {
        // Not an envelope: keep it verbatim in the window, and never return an
        // unsealed value outside it.
        return allowPlaintext ? value : fail('NOT_SEALED', 'text metadata is stored as plaintext; backfill required');
    }
    const opened = await crypto.readStored(parsed, context, false);
    if (typeof opened !== 'string') {
        fail('INVALID_INPUT', 'sealed text metadata did not open to a string');
    }
    return opened;
}
