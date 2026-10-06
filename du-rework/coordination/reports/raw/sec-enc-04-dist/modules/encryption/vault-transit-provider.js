"use strict";
/**
 * Server-side key provider backed by Vault Transit.
 *
 * The provider accepts opaque, allowlisted key references and never exposes a
 * Vault key. It only returns DEKs from unwrapDek to its trusted caller, which
 * is expected to perform payload encryption/decryption in process memory.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultTransitProvider = exports.VaultTransitError = void 0;
const DEK_BYTES = 32;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_CHARS = 16 * 1024;
const MAX_KEY_VERSION = 2_147_483_647;
class VaultTransitError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.name = 'VaultTransitError';
        this.code = code;
        if (status !== undefined)
            this.status = status;
    }
}
exports.VaultTransitError = VaultTransitError;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(code, message, status) {
    throw new VaultTransitError(code, message, status);
}
function validateVersion(version, label) {
    if (typeof version !== 'number'
        || !Number.isSafeInteger(version)
        || version < 1
        || version > MAX_KEY_VERSION) {
        fail('INVALID_INPUT', label + ' must be a positive Vault key version');
    }
    return version;
}
function parseTransitCiphertext(ciphertext) {
    if (typeof ciphertext !== 'string' || ciphertext.length > MAX_CIPHERTEXT_CHARS) {
        fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid ciphertext');
    }
    const match = /^vault:v([1-9][0-9]*):([A-Za-z0-9+/_=-]+)$/.exec(ciphertext);
    if (!match)
        fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid ciphertext');
    const keyVersion = Number(match[1]);
    if (!Number.isSafeInteger(keyVersion) || keyVersion > MAX_KEY_VERSION) {
        fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid key version');
    }
    return { ciphertext, keyVersion };
}
function validateWrappedDek(value) {
    if (!isRecord(value))
        fail('INVALID_INPUT', 'Wrapped DEK metadata is invalid');
    const keyRef = value.keyRef;
    if (typeof keyRef !== 'string' || keyRef.length < 1 || keyRef.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(keyRef)) {
        fail('INVALID_INPUT', 'Wrapped DEK key reference is invalid');
    }
    const keyVersion = validateVersion(value.keyVersion, 'Wrapped DEK keyVersion');
    const parsed = parseTransitCiphertext(value.ciphertext);
    if (parsed.keyVersion !== keyVersion) {
        fail('INVALID_INPUT', 'Wrapped DEK key version does not match its ciphertext');
    }
    return { keyRef, keyVersion, ciphertext: parsed.ciphertext };
}
function decodeDek(value) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid plaintext DEK');
    }
    const dek = Buffer.from(value, 'base64');
    if (dek.length !== DEK_BYTES || dek.toString('base64') !== value) {
        dek.fill(0);
        fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid plaintext DEK');
    }
    return dek;
}
function validateAddress(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return fail('INVALID_CONFIGURATION', 'Vault address must be a valid URL');
    }
    const loopbackHost = url.hostname === 'localhost'
        || url.hostname === '127.0.0.1'
        || url.hostname === '[::1]';
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHost))
        || url.username !== ''
        || url.password !== ''
        || url.search !== ''
        || url.hash !== ''
        || (url.pathname !== '' && url.pathname !== '/')) {
        return fail('INVALID_CONFIGURATION', 'Vault address must be an HTTPS origin (HTTP is allowed on loopback)');
    }
    return url;
}
function validateIdentity(identity, label) {
    if (!identity || typeof identity.token !== 'function') {
        fail('INVALID_CONFIGURATION', label + ' Vault identity is required');
    }
    return identity;
}
function validateKeyRefName(name) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes('..');
}
/**
 * Vault Transit HTTP adapter. The key-ref map is copied at construction so
 * later mutation of the caller's config cannot broaden the allowlist.
 */
class VaultTransitProvider {
    vaultAddress;
    allowedKeyRefs;
    encryptIdentity;
    decryptIdentity;
    rewrapIdentity;
    transitMount;
    requestTimeoutMs;
    fetchImpl;
    constructor(options) {
        if (!options || typeof options !== 'object') {
            fail('INVALID_CONFIGURATION', 'Vault Transit provider options are required');
        }
        this.vaultAddress = validateAddress(options.vaultAddress);
        this.encryptIdentity = validateIdentity(options.encryptIdentity, 'Encrypt');
        this.decryptIdentity = validateIdentity(options.decryptIdentity, 'Decrypt');
        if (this.encryptIdentity === this.decryptIdentity
            || this.encryptIdentity.token === this.decryptIdentity.token) {
            fail('INVALID_CONFIGURATION', 'Encrypt and decrypt must use separate Vault identities');
        }
        this.rewrapIdentity = validateIdentity(options.rewrapIdentity ?? options.encryptIdentity, 'Rewrap');
        this.transitMount = options.transitMount ?? 'transit';
        if (!validateKeyRefName(this.transitMount)) {
            fail('INVALID_CONFIGURATION', 'Transit mount must be a safe single path segment');
        }
        const timeout = options.requestTimeoutMs ?? 10_000;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
            fail('INVALID_CONFIGURATION', 'Vault request timeout must be between 1 and 60000 milliseconds');
        }
        this.requestTimeoutMs = timeout;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        if (typeof this.fetchImpl !== 'function') {
            fail('INVALID_CONFIGURATION', 'A Fetch implementation is required');
        }
        const entries = Object.entries(options.allowedKeyRefs ?? {});
        if (entries.length === 0)
            fail('INVALID_CONFIGURATION', 'At least one allowlisted Transit key ref is required');
        const keyRefs = new Map();
        for (const [ref, transitKeyName] of entries) {
            if (ref.length < 1
                || ref.length > 256
                || /[\u0000-\u001f\u007f-\u009f]/.test(ref)
                || typeof transitKeyName !== 'string'
                || !validateKeyRefName(transitKeyName)) {
                fail('INVALID_CONFIGURATION', 'Allowlisted Transit key refs must map to safe key names');
            }
            keyRefs.set(ref, transitKeyName);
        }
        this.allowedKeyRefs = keyRefs;
    }
    async wrapDek(input) {
        if (!input || typeof input !== 'object')
            fail('INVALID_INPUT', 'DEK wrap input is required');
        const keyName = this.resolveKeyRef(input.keyRef);
        if (!(input.dek instanceof Uint8Array) || input.dek.byteLength !== DEK_BYTES) {
            fail('INVALID_INPUT', 'DEK must be exactly 32 bytes');
        }
        const keyVersion = input.keyVersion === undefined
            ? undefined
            : validateVersion(input.keyVersion, 'keyVersion');
        const request = { plaintext: Buffer.from(input.dek).toString('base64') };
        if (keyVersion !== undefined)
            request.key_version = keyVersion;
        const response = await this.request('encrypt', keyName, request, this.encryptIdentity);
        const ciphertext = parseTransitCiphertext(this.responseField(response, 'ciphertext')).ciphertext;
        const parsed = parseTransitCiphertext(ciphertext);
        if (keyVersion !== undefined && parsed.keyVersion !== keyVersion) {
            fail('INVALID_VAULT_RESPONSE', 'Vault Transit did not honor the pinned key version');
        }
        return { keyRef: input.keyRef, keyVersion: parsed.keyVersion, ciphertext };
    }
    async unwrapDek(value) {
        const wrapped = validateWrappedDek(value);
        const keyName = this.resolveKeyRef(wrapped.keyRef);
        const response = await this.request('decrypt', keyName, { ciphertext: wrapped.ciphertext }, this.decryptIdentity);
        return decodeDek(this.responseField(response, 'plaintext'));
    }
    /** Rewrap with the latest key version by default, or an explicit pinned version. */
    async rewrap(value, targetKeyVersion) {
        const wrapped = validateWrappedDek(value);
        const keyName = this.resolveKeyRef(wrapped.keyRef);
        const targetVersion = targetKeyVersion === undefined
            ? undefined
            : validateVersion(targetKeyVersion, 'targetKeyVersion');
        if (targetVersion !== undefined && targetVersion < wrapped.keyVersion) {
            fail('INVALID_INPUT', 'Rewrap cannot downgrade a DEK key version');
        }
        const request = { ciphertext: wrapped.ciphertext };
        if (targetVersion !== undefined)
            request.key_version = targetVersion;
        const response = await this.request('rewrap', keyName, request, this.rewrapIdentity);
        const ciphertext = this.responseField(response, 'ciphertext');
        const parsed = parseTransitCiphertext(ciphertext);
        if (parsed.keyVersion < wrapped.keyVersion
            || (targetVersion !== undefined && parsed.keyVersion !== targetVersion)) {
            fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an unexpected rewrapped key version');
        }
        return { keyRef: wrapped.keyRef, keyVersion: parsed.keyVersion, ciphertext: parsed.ciphertext };
    }
    resolveKeyRef(keyRef) {
        if (typeof keyRef !== 'string')
            fail('KEY_REF_NOT_ALLOWED', 'Vault Transit key ref is not allowlisted');
        const name = this.allowedKeyRefs.get(keyRef);
        if (!name)
            fail('KEY_REF_NOT_ALLOWED', 'Vault Transit key ref is not allowlisted');
        return name;
    }
    responseField(response, name) {
        if (!isRecord(response.data))
            fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid response');
        return response.data[name];
    }
    async request(operation, keyName, payload, identity) {
        let token;
        try {
            token = await identity.token();
        }
        catch {
            return fail('IDENTITY_UNAVAILABLE', 'Vault Transit identity is unavailable');
        }
        if (typeof token !== 'string' || token.trim() === '' || /[\r\n\u0000]/.test(token)) {
            return fail('IDENTITY_UNAVAILABLE', 'Vault Transit identity is unavailable');
        }
        const path = '/v1/'
            + encodeURIComponent(this.transitMount)
            + '/' + operation
            + '/' + encodeURIComponent(keyName);
        const url = new URL(path, this.vaultAddress);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            let response;
            try {
                response = await this.fetchImpl(url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-vault-token': token,
                    },
                    body: JSON.stringify(payload),
                    redirect: 'error',
                    signal: controller.signal,
                });
            }
            catch {
                return fail('VAULT_UNAVAILABLE', 'Vault Transit request failed');
            }
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    return fail('VAULT_FORBIDDEN', 'Vault Transit denied the operation', response.status);
                }
                if (response.status === 408 || response.status === 429 || response.status >= 500) {
                    return fail('VAULT_UNAVAILABLE', 'Vault Transit is unavailable', response.status);
                }
                return fail('VAULT_REJECTED', 'Vault Transit rejected the operation', response.status);
            }
            let text;
            try {
                text = await response.text();
            }
            catch {
                return fail('VAULT_UNAVAILABLE', 'Vault Transit response could not be read');
            }
            if (text.length > MAX_RESPONSE_BYTES) {
                return fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an oversized response');
            }
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                return fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid response');
            }
            if (!isRecord(parsed))
                fail('INVALID_VAULT_RESPONSE', 'Vault Transit returned an invalid response');
            return parsed;
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
exports.VaultTransitProvider = VaultTransitProvider;
