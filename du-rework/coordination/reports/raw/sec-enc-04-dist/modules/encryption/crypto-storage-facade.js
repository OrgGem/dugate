"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CryptoStorageFacade = exports.CryptoStorageError = exports.CRYPTO_STORAGE_MAX_DECRYPT_BYTES = exports.CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES = exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES = void 0;
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const contracts_1 = require("@du/contracts");
exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
exports.CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES = 5 * 1024 * 1024;
/**
 * RFX-08: hard ceiling on the plaintext one streaming decrypt may emit.
 * Deliberately equal to MAX_DECRYPT_BYTES (server.ts) and to the ingress
 * maxBytes cap the encrypted delivery path reads through, so an artifact the
 * store is willing to hand back is never refused here, and one it is not can
 * never grow this process' heap without bound. Callers that collect the whole
 * artifact to serve it need the same cap: raising it here alone only moves the
 * ceiling somewhere else.
 */
exports.CRYPTO_STORAGE_MAX_DECRYPT_BYTES = 64 * 1024 * 1024;
const VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MANIFEST_MAC_BYTES = 32;
const DEFAULT_MAX_CHUNKS = 65_536;
const SHA256_RE = /^[a-f0-9]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
class CryptoStorageError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'CryptoStorageError';
        this.code = code;
    }
}
exports.CryptoStorageError = CryptoStorageError;
function invalidInput(message) {
    throw new CryptoStorageError('INVALID_INPUT', message);
}
function invalidManifest(message) {
    throw new CryptoStorageError('INVALID_MANIFEST', message);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateText(value, label, maxLength = 512) {
    if (typeof value !== 'string'
        || value.length < 1
        || value.length > maxLength
        || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
        invalidInput(label + ' is invalid');
    }
    return value;
}
function validateContext(context) {
    if (!isRecord(context))
        invalidInput('Storage context is required');
    const tenantId = validateText(context.tenantId, 'tenantId');
    const artifactId = validateText(context.artifactId, 'artifactId');
    const objectVersion = validateText(context.objectVersion, 'objectVersion');
    const purpose = context.purpose === undefined
        ? 'artifact-storage'
        : validateText(context.purpose, 'purpose', 128);
    return { tenantId, artifactId, objectVersion, purpose };
}
function validateEncryptContext(context) {
    const validated = validateContext(context);
    const keyRef = validateText(context.keyRef, 'keyRef', 256);
    const keyVersion = context.keyVersion;
    if (keyVersion !== undefined
        && (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || keyVersion > 2_147_483_647)) {
        invalidInput('keyVersion must be a positive integer');
    }
    return { ...validated, keyRef, ...(keyVersion === undefined ? {} : { keyVersion }) };
}
function contextAad(context) {
    const validated = validateContext(context);
    return Buffer.from(JSON.stringify(contracts_1.StorageContextAadSchema.parse({
        format: 'du-crypto-storage-v1',
        tenantId: validated.tenantId,
        artifactId: validated.artifactId,
        objectVersion: validated.objectVersion,
        purpose: validated.purpose,
    })), 'utf8');
}
function singleAad(context, sizeBytes, sha256) {
    return Buffer.from(JSON.stringify(contracts_1.StorageSingleShotAadSchema.parse({
        format: 'du-crypto-storage-single-v1',
        context: contracts_1.StorageContextAadSchema.parse({
            format: 'du-crypto-storage-v1',
            ...validateContext(context),
        }),
        sizeBytes,
        sha256,
    })), 'utf8');
}
function chunkAad(context, index, sizeBytes, sha256) {
    return Buffer.from(JSON.stringify(contracts_1.StorageChunkAadSchema.parse({
        format: 'du-crypto-storage-chunk-v1',
        context: contracts_1.StorageContextAadSchema.parse({
            format: 'du-crypto-storage-v1',
            ...validateContext(context),
        }),
        index,
        sizeBytes,
        sha256,
    })), 'utf8');
}
function sha256(bytes) {
    return (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
}
function decodeBase64(value, length, label) {
    const expectedChars = length === undefined ? 8192 : Math.ceil(length / 3) * 4;
    if (typeof value !== 'string'
        || value.length > expectedChars
        || (length !== undefined && value.length !== expectedChars)
        || !BASE64_RE.test(value)) {
        invalidManifest(label + ' is invalid');
    }
    const bytes = Buffer.from(value, 'base64');
    if ((length !== undefined && bytes.length !== length) || bytes.toString('base64') !== value) {
        bytes.fill(0);
        invalidManifest(label + ' has an invalid length or encoding');
    }
    return bytes;
}
function validateWrappedDek(value) {
    if (!isRecord(value))
        invalidManifest('Wrapped DEK metadata is invalid');
    if (typeof value.keyRef !== 'string'
        || value.keyRef.length < 1
        || value.keyRef.length > 256
        || /[\u0000-\u001f\u007f-\u009f]/.test(value.keyRef)
        || !Number.isSafeInteger(value.keyVersion)
        || value.keyVersion < 1
        || typeof value.ciphertext !== 'string'
        || value.ciphertext.length < 1
        || value.ciphertext.length > 16 * 1024) {
        invalidManifest('Wrapped DEK metadata is invalid');
    }
    return {
        keyRef: value.keyRef,
        keyVersion: value.keyVersion,
        ciphertext: value.ciphertext,
    };
}
function validateWrappedResult(value) {
    if (!isRecord(value))
        throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'Key provider returned invalid wrapped DEK metadata');
    try {
        return validateWrappedDek(value);
    }
    catch {
        throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'Key provider returned invalid wrapped DEK metadata');
    }
}
function unsignedManifest(manifest) {
    return {
        version: manifest.version,
        algorithm: manifest.algorithm,
        chunkSizeBytes: manifest.chunkSizeBytes,
        totalChunks: manifest.totalChunks,
        totalSizeBytes: manifest.totalSizeBytes,
        fileSha256: manifest.fileSha256,
        contextAad: manifest.contextAad,
        chunks: manifest.chunks.map((chunk) => ({
            index: chunk.index,
            nonce: chunk.nonce,
            tag: chunk.tag,
            sha256: chunk.sha256,
            sizeBytes: chunk.sizeBytes,
        })),
        dek: {
            keyRef: manifest.dek.keyRef,
            keyVersion: manifest.dek.keyVersion,
            ciphertext: manifest.dek.ciphertext,
        },
    };
}
function manifestMacKey(dek, aad) {
    return Buffer.from((0, node_crypto_1.hkdfSync)('sha256', dek, (0, node_crypto_1.createHash)('sha256').update(aad).digest(), Buffer.from('du-crypto-storage-manifest-v1', 'utf8'), MANIFEST_MAC_BYTES));
}
function validateManifest(value, context, maxChunks) {
    if (!isRecord(value))
        invalidManifest('Chunk manifest is required');
    const allowedManifestKeys = [
        'version', 'algorithm', 'chunkSizeBytes', 'totalChunks', 'totalSizeBytes',
        'fileSha256', 'contextAad', 'chunks', 'dek', 'manifestMac',
    ];
    if (Object.keys(value).some((key) => !allowedManifestKeys.includes(key))) {
        invalidManifest('Chunk manifest contains unsupported fields');
    }
    if (value.version !== VERSION
        || value.algorithm !== ALGORITHM
        || value.chunkSizeBytes !== exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES
        || !Number.isSafeInteger(value.totalChunks)
        || value.totalChunks < 1
        || value.totalChunks > maxChunks
        || !Number.isSafeInteger(value.totalSizeBytes)
        || value.totalSizeBytes <= exports.CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES
        || typeof value.fileSha256 !== 'string'
        || !SHA256_RE.test(value.fileSha256)
        || typeof value.contextAad !== 'string'
        || value.contextAad.length > 2048
        || !Array.isArray(value.chunks)
        || value.chunks.length !== value.totalChunks) {
        invalidManifest('Chunk manifest metadata is invalid');
    }
    const aad = contextAad(context);
    const suppliedAad = Buffer.from(value.contextAad, 'base64');
    if (suppliedAad.toString('base64') !== value.contextAad
        || !(0, node_crypto_1.timingSafeEqual)(suppliedAad.length === aad.length ? suppliedAad : Buffer.alloc(aad.length), aad)) {
        suppliedAad.fill(0);
        aad.fill(0);
        invalidManifest('Chunk manifest belongs to a different storage context');
    }
    suppliedAad.fill(0);
    aad.fill(0);
    const chunks = [];
    const nonceSet = new Set();
    let summedBytes = 0;
    for (let index = 0; index < value.chunks.length; index++) {
        const raw = value.chunks[index];
        if (!isRecord(raw))
            invalidManifest('Chunk metadata is invalid');
        const allowedChunkKeys = ['index', 'nonce', 'tag', 'sha256', 'sizeBytes'];
        if (Object.keys(raw).some((key) => !allowedChunkKeys.includes(key))) {
            invalidManifest('Chunk metadata contains unsupported fields');
        }
        if (raw.index !== index
            || !Number.isSafeInteger(raw.sizeBytes)
            || raw.sizeBytes < 1
            || raw.sizeBytes > exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES
            || (index < value.chunks.length - 1 && raw.sizeBytes !== exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES)
            || typeof raw.sha256 !== 'string'
            || !SHA256_RE.test(raw.sha256)
            || typeof raw.nonce !== 'string'
            || typeof raw.tag !== 'string') {
            invalidManifest('Chunk metadata is invalid or out of order');
        }
        decodeBase64(raw.nonce, NONCE_BYTES, 'Chunk nonce').fill(0);
        decodeBase64(raw.tag, TAG_BYTES, 'Chunk tag').fill(0);
        if (nonceSet.has(raw.nonce))
            invalidManifest('Chunk nonces must be unique');
        nonceSet.add(raw.nonce);
        summedBytes += raw.sizeBytes;
        if (!Number.isSafeInteger(summedBytes))
            invalidManifest('Chunk total size is invalid');
        chunks.push({
            index,
            nonce: raw.nonce,
            tag: raw.tag,
            sha256: raw.sha256,
            sizeBytes: raw.sizeBytes,
        });
    }
    if (summedBytes !== value.totalSizeBytes)
        invalidManifest('Chunk sizes do not match totalSizeBytes');
    const manifestMac = value.manifestMac;
    if (typeof manifestMac !== 'string')
        invalidManifest('Manifest authentication code is missing');
    decodeBase64(manifestMac, MANIFEST_MAC_BYTES, 'Manifest authentication code').fill(0);
    const manifest = {
        version: VERSION,
        algorithm: ALGORITHM,
        chunkSizeBytes: exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
        totalChunks: value.totalChunks,
        totalSizeBytes: value.totalSizeBytes,
        fileSha256: value.fileSha256,
        contextAad: value.contextAad,
        chunks,
        dek: validateWrappedDek(value.dek),
        manifestMac,
    };
    return manifest;
}
async function* splitIntoChunks(source) {
    const scratch = Buffer.allocUnsafe(exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES);
    let used = 0;
    try {
        for await (const input of source) {
            if (!(input instanceof Uint8Array))
                invalidInput('Stream chunks must be Uint8Array values');
            let offset = 0;
            while (offset < input.byteLength) {
                const take = Math.min(exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES - used, input.byteLength - offset);
                Buffer.from(input.buffer, input.byteOffset + offset, take).copy(scratch, used, 0, take);
                used += take;
                offset += take;
                if (used === exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES) {
                    yield Buffer.from(scratch.subarray(0, used));
                    used = 0;
                }
            }
        }
        if (used > 0)
            yield Buffer.from(scratch.subarray(0, used));
    }
    finally {
        scratch.fill(0);
    }
}
class CiphertextReader {
    iterator;
    current = Buffer.alloc(0);
    offset = 0;
    ended = false;
    constructor(source) {
        this.iterator = source[Symbol.asyncIterator]();
    }
    async readExactly(byteLength) {
        const output = Buffer.allocUnsafe(byteLength);
        let written = 0;
        while (written < byteLength) {
            if (this.offset >= this.current.length) {
                if (this.ended) {
                    output.fill(0);
                    throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext stream is truncated');
                }
                const next = await this.iterator.next();
                if (next.done) {
                    this.ended = true;
                    continue;
                }
                if (!(next.value instanceof Uint8Array)) {
                    output.fill(0);
                    throw new CryptoStorageError('INVALID_INPUT', 'Ciphertext stream chunks must be Uint8Array values');
                }
                this.current = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
                this.offset = 0;
                if (this.current.length === 0)
                    continue;
            }
            const take = Math.min(byteLength - written, this.current.length - this.offset);
            this.current.copy(output, written, this.offset, this.offset + take);
            this.offset += take;
            written += take;
        }
        return output;
    }
    async assertEnd() {
        if (this.offset < this.current.length) {
            throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext stream has trailing bytes');
        }
        while (!this.ended) {
            const next = await this.iterator.next();
            if (next.done) {
                this.ended = true;
                return;
            }
            if (!(next.value instanceof Uint8Array)) {
                throw new CryptoStorageError('INVALID_INPUT', 'Ciphertext stream chunks must be Uint8Array values');
            }
            if (next.value.byteLength > 0) {
                throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext stream has trailing bytes');
            }
        }
    }
    async close() {
        try {
            if (!this.ended && this.iterator.return)
                await this.iterator.return();
        }
        finally {
            this.current = Buffer.alloc(0);
            this.offset = 0;
            this.ended = true;
        }
    }
}
/**
 * Application storage boundary. Each object gets a fresh random 256-bit DEK;
 * only the Vault Transit wrapped form is returned with persisted ciphertext.
 */
class CryptoStorageFacade {
    keyProvider;
    maxChunks;
    maxPlaintextBytes;
    constructor(keyProvider, options = {}) {
        if (!keyProvider || typeof keyProvider.wrapDek !== 'function' || typeof keyProvider.unwrapDek !== 'function') {
            invalidInput('A DEK key provider is required');
        }
        const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
        if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > DEFAULT_MAX_CHUNKS) {
            invalidInput('maxChunks must be between 1 and ' + DEFAULT_MAX_CHUNKS);
        }
        const maxPlaintextBytes = options.maxPlaintextBytes ?? exports.CRYPTO_STORAGE_MAX_DECRYPT_BYTES;
        if (!Number.isSafeInteger(maxPlaintextBytes)
            || maxPlaintextBytes < 1
            || maxPlaintextBytes > exports.CRYPTO_STORAGE_MAX_DECRYPT_BYTES) {
            invalidInput('maxPlaintextBytes must be between 1 and ' + exports.CRYPTO_STORAGE_MAX_DECRYPT_BYTES);
        }
        this.keyProvider = keyProvider;
        this.maxChunks = maxChunks;
        this.maxPlaintextBytes = maxPlaintextBytes;
    }
    /** Encrypt one non-empty object up to the 5 MiB single-shot threshold. */
    async encrypt(plaintext, context) {
        if (!(plaintext instanceof Uint8Array))
            invalidInput('Plaintext must be a Uint8Array');
        const validatedContext = validateEncryptContext(context);
        if (plaintext.byteLength < 1)
            invalidInput('Empty artifacts are not supported');
        if (plaintext.byteLength > exports.CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
            throw new CryptoStorageError('SIZE_LIMIT', 'Artifact exceeds the single-shot encryption limit');
        }
        const plaintextCopy = Buffer.from(plaintext);
        const digest = sha256(plaintextCopy);
        const aad = singleAad(validatedContext, plaintextCopy.length, digest);
        const dek = (0, node_crypto_1.randomBytes)(KEY_BYTES);
        let wrapped;
        try {
            wrapped = await this.wrapDek(dek, validatedContext);
            const nonce = (0, node_crypto_1.randomBytes)(NONCE_BYTES);
            const cipher = (0, node_crypto_1.createCipheriv)(ALGORITHM, dek, nonce);
            cipher.setAAD(aad, { plaintextLength: plaintextCopy.length });
            const first = cipher.update(plaintextCopy);
            const last = cipher.final();
            const ciphertext = Buffer.concat([first, last]);
            first.fill(0);
            last.fill(0);
            return {
                version: VERSION,
                algorithm: ALGORITHM,
                nonce: nonce.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
                ciphertext,
                aad: aad.toString('base64'),
                plaintextSizeBytes: plaintextCopy.length,
                plaintextSha256: digest,
                dek: wrapped,
            };
        }
        catch (error) {
            if (error instanceof CryptoStorageError)
                throw error;
            throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Artifact encryption failed');
        }
        finally {
            dek.fill(0);
            plaintextCopy.fill(0);
            aad.fill(0);
        }
    }
    /** Authenticate the GCM tag, context, size, and plaintext digest before returning bytes. */
    async decrypt(encrypted, context) {
        const validatedContext = validateContext(context);
        if (!isRecord(encrypted) || encrypted.version !== VERSION || encrypted.algorithm !== ALGORITHM) {
            invalidInput('Encrypted object metadata is invalid');
        }
        if (!(encrypted.ciphertext instanceof Uint8Array)
            || encrypted.ciphertext.byteLength < 1
            || !Number.isSafeInteger(encrypted.plaintextSizeBytes)
            || encrypted.plaintextSizeBytes < 1
            || encrypted.plaintextSizeBytes > exports.CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES
            || encrypted.ciphertext.byteLength !== encrypted.plaintextSizeBytes
            || typeof encrypted.plaintextSha256 !== 'string'
            || !SHA256_RE.test(encrypted.plaintextSha256)) {
            invalidInput('Encrypted object metadata is invalid');
        }
        const nonce = decodeBase64(encrypted.nonce, NONCE_BYTES, 'Nonce');
        const tag = decodeBase64(encrypted.tag, TAG_BYTES, 'Authentication tag');
        const aad = decodeBase64(encrypted.aad, undefined, 'AAD');
        const expectedAad = singleAad(validatedContext, encrypted.plaintextSizeBytes, encrypted.plaintextSha256);
        if (!(0, node_crypto_1.timingSafeEqual)(aad.length === expectedAad.length ? aad : Buffer.alloc(expectedAad.length), expectedAad)) {
            nonce.fill(0);
            tag.fill(0);
            aad.fill(0);
            expectedAad.fill(0);
            throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Encrypted object context does not match');
        }
        const dek = await this.unwrapDek(encrypted.dek);
        let plaintext;
        try {
            const decipher = (0, node_crypto_1.createDecipheriv)(ALGORITHM, dek, nonce);
            decipher.setAAD(aad, { plaintextLength: encrypted.ciphertext.byteLength });
            decipher.setAuthTag(tag);
            const first = decipher.update(encrypted.ciphertext);
            const last = decipher.final();
            plaintext = Buffer.concat([first, last]);
            first.fill(0);
            last.fill(0);
            if (plaintext.length !== encrypted.plaintextSizeBytes
                || sha256(plaintext) !== encrypted.plaintextSha256) {
                throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Encrypted object integrity check failed');
            }
            const result = plaintext;
            plaintext = undefined;
            return result;
        }
        catch {
            plaintext?.fill(0);
            throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Encrypted object authentication failed');
        }
        finally {
            dek.fill(0);
            nonce.fill(0);
            tag.fill(0);
            aad.fill(0);
            expectedAad.fill(0);
        }
    }
    /**
     * Encrypt a large async byte source as independent authenticated 4 MiB
     * chunks. Consumers must persist/finalize the object only after `manifest`
     * resolves; an interrupted stream has no valid manifest.
     */
    encryptStream(source, context) {
        if (!source || typeof source[Symbol.asyncIterator] !== 'function')
            invalidInput('An async plaintext stream is required');
        const validatedContext = validateEncryptContext(context);
        let resolveManifest;
        let rejectManifest;
        let settled = false;
        const manifest = new Promise((resolve, reject) => {
            resolveManifest = resolve;
            rejectManifest = reject;
        });
        // The stream itself is the primary error channel; attach a handler so a
        // caller that only consumes ciphertext does not cause an unhandled reject.
        void manifest.catch(() => undefined);
        const failManifest = (error) => {
            if (settled)
                return;
            settled = true;
            rejectManifest(error instanceof Error ? error : new Error('Stream encryption failed'));
        };
        const completeManifest = (value) => {
            if (settled)
                return;
            settled = true;
            resolveManifest(value);
        };
        const self = this;
        async function* run() {
            try {
                yield* self.encryptChunkGenerator(source, validatedContext, completeManifest);
            }
            catch (error) {
                failManifest(error);
                throw error;
            }
            finally {
                if (!settled)
                    failManifest(new CryptoStorageError('STREAM_ABORTED', 'Ciphertext stream ended before its manifest was complete'));
            }
        }
        const ciphertext = node_stream_1.Readable.from(run(), {
            objectMode: false,
            highWaterMark: exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES * 2,
        });
        ciphertext.on('close', () => {
            if (!settled)
                failManifest(new CryptoStorageError('STREAM_ABORTED', 'Ciphertext stream was closed before completion'));
        });
        return { ciphertext, manifest };
    }
    /** Verify the complete authenticated manifest before yielding any plaintext. */
    decryptStream(ciphertext, rawManifest, context) {
        if (!ciphertext || typeof ciphertext[Symbol.asyncIterator] !== 'function')
            invalidInput('An async ciphertext stream is required');
        const validatedContext = validateContext(context);
        const manifest = validateManifest(rawManifest, validatedContext, this.maxChunks);
        // RFX-08: the manifest is the only thing that can tell us how much
        // plaintext this call would hand over, and the read paths collect all of
        // it. Refuse here, eagerly and synchronously, so an oversized artifact
        // costs no Vault unwrap, no MAC computation and no plaintext buffer -
        // exactly like the maxChunks refusal above.
        if (manifest.totalSizeBytes > this.maxPlaintextBytes) {
            throw new CryptoStorageError('SIZE_LIMIT', 'Artifact exceeds the plaintext decryption limit');
        }
        const self = this;
        async function* decrypt() {
            yield* self.decryptChunkGenerator(ciphertext, manifest, validatedContext, self.maxPlaintextBytes);
        }
        return node_stream_1.Readable.from(decrypt(), {
            objectMode: false,
            highWaterMark: exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES * 2,
        });
    }
    async wrapDek(dek, context) {
        let wrapped;
        try {
            wrapped = await this.keyProvider.wrapDek({
                keyRef: context.keyRef,
                dek,
                ...(context.keyVersion === undefined ? {} : { keyVersion: context.keyVersion }),
            });
        }
        catch {
            throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'DEK could not be wrapped');
        }
        return validateWrappedResult(wrapped);
    }
    async unwrapDek(wrapped) {
        let dek;
        try {
            dek = await this.keyProvider.unwrapDek(wrapped);
        }
        catch {
            throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'DEK could not be unwrapped');
        }
        if (!Buffer.isBuffer(dek) || dek.byteLength !== KEY_BYTES) {
            if (dek instanceof Uint8Array)
                dek.fill(0);
            throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'Key provider returned an invalid DEK');
        }
        return dek;
    }
    async *encryptChunkGenerator(source, context, complete) {
        const dek = (0, node_crypto_1.randomBytes)(KEY_BYTES);
        let contextBytes;
        let manifestKey;
        try {
            const wrappedDek = await this.wrapDek(dek, context);
            contextBytes = contextAad(context);
            const noncePrefix = (0, node_crypto_1.randomBytes)(4);
            const fullHash = (0, node_crypto_1.createHash)('sha256');
            const chunks = [];
            let totalSizeBytes = 0;
            let index = 0;
            for await (const plaintext of splitIntoChunks(source)) {
                if (index >= this.maxChunks) {
                    plaintext.fill(0);
                    throw new CryptoStorageError('SIZE_LIMIT', 'Artifact exceeds the configured chunk limit');
                }
                totalSizeBytes += plaintext.length;
                if (!Number.isSafeInteger(totalSizeBytes)) {
                    plaintext.fill(0);
                    throw new CryptoStorageError('SIZE_LIMIT', 'Artifact size exceeds the supported limit');
                }
                const digest = sha256(plaintext);
                fullHash.update(plaintext);
                const nonce = Buffer.allocUnsafe(NONCE_BYTES);
                noncePrefix.copy(nonce, 0);
                nonce.writeBigUInt64BE(BigInt(index), 4);
                const aad = chunkAad(context, index, plaintext.length, digest);
                try {
                    const cipher = (0, node_crypto_1.createCipheriv)(ALGORITHM, dek, nonce);
                    cipher.setAAD(aad, { plaintextLength: plaintext.length });
                    const first = cipher.update(plaintext);
                    const last = cipher.final();
                    const encrypted = Buffer.concat([first, last]);
                    first.fill(0);
                    last.fill(0);
                    chunks.push({
                        index,
                        nonce: nonce.toString('base64'),
                        tag: cipher.getAuthTag().toString('base64'),
                        sha256: digest,
                        sizeBytes: plaintext.length,
                    });
                    yield encrypted;
                }
                finally {
                    plaintext.fill(0);
                    nonce.fill(0);
                    aad.fill(0);
                }
                index++;
            }
            if (totalSizeBytes <= exports.CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
                throw new CryptoStorageError('SIZE_LIMIT', 'Chunked encryption requires an artifact larger than 5 MiB');
            }
            const withoutMac = {
                version: VERSION,
                algorithm: ALGORITHM,
                chunkSizeBytes: exports.CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
                totalChunks: chunks.length,
                totalSizeBytes,
                fileSha256: fullHash.digest('hex'),
                contextAad: contextBytes.toString('base64'),
                chunks,
                dek: wrappedDek,
                manifestMac: '',
            };
            manifestKey = manifestMacKey(dek, contextBytes);
            const mac = (0, node_crypto_1.createHmac)('sha256', manifestKey)
                .update(JSON.stringify(unsignedManifest(withoutMac)), 'utf8')
                .digest();
            const manifest = { ...withoutMac, manifestMac: mac.toString('base64') };
            mac.fill(0);
            complete(manifest);
        }
        finally {
            dek.fill(0);
            contextBytes?.fill(0);
            manifestKey?.fill(0);
        }
    }
    /**
     * RFX-16 design rationale for the order below: the DEK is unwrapped BEFORE the
     * manifest MAC is checked, and that ordering is mandatory rather than an
     * oversight. The MAC key is derived FROM the DEK (manifestMacKey runs HKDF
     * over it), so no MAC can be verified without first recovering the DEK; a
     * MAC-first path would need a second key that authenticates the key, which
     * this envelope does not have. The single-shot decrypt path unwraps AFTER its
     * AAD check for the opposite reason - its AAD needs no key - which is why the
     * two orders differ.
     *
     * The cost this ordering could otherwise expose is already spent before the
     * generator runs: validateManifest rejects unknown fields, a foreign context
     * AAD, wrong geometry, out-of-order or oversized chunks, a chunk total that
     * disagrees with totalSizeBytes, and chunk counts over maxChunks; the RFX-08
     * pre-check in decryptStream rejects an over-limit declared size. So an
     * attacker-crafted manifest reaches the unwrap only when its shape and
     * context are right, and the single Vault call is spent on a DEK-wrap this
     * system itself wrote. It is still one call per request against Vault, so
     * rate limit and backoff belong on the Vault caller if decrypt is ever
     * abused. Keep "wrap is wrong" and "MAC is wrong" indistinguishable (both
     * surface as AUTHENTICATION_FAILED) so the error path is not an oracle.
     */
    async *decryptChunkGenerator(ciphertext, manifest, context, maxPlaintextBytes) {
        const dek = await this.unwrapDek(manifest.dek);
        const aad = contextAad(context);
        const suppliedMac = Buffer.from(manifest.manifestMac, 'base64');
        let key;
        const reader = new CiphertextReader(ciphertext);
        const totalHash = (0, node_crypto_1.createHash)('sha256');
        let totalSizeBytes = 0;
        try {
            key = manifestMacKey(dek, aad);
            const expectedMac = (0, node_crypto_1.createHmac)('sha256', key)
                .update(JSON.stringify(unsignedManifest(manifest)), 'utf8')
                .digest();
            if (!(0, node_crypto_1.timingSafeEqual)(expectedMac, suppliedMac)) {
                expectedMac.fill(0);
                throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Chunk manifest authentication failed');
            }
            expectedMac.fill(0);
            for (const metadata of manifest.chunks) {
                const encrypted = await reader.readExactly(metadata.sizeBytes);
                const nonce = Buffer.from(metadata.nonce, 'base64');
                const tag = Buffer.from(metadata.tag, 'base64');
                const chunkAdditionalData = chunkAad(context, metadata.index, metadata.sizeBytes, metadata.sha256);
                let plaintext;
                try {
                    const decipher = (0, node_crypto_1.createDecipheriv)(ALGORITHM, dek, nonce);
                    decipher.setAAD(chunkAdditionalData, { plaintextLength: metadata.sizeBytes });
                    decipher.setAuthTag(tag);
                    const first = decipher.update(encrypted);
                    const last = decipher.final();
                    plaintext = Buffer.concat([first, last]);
                    first.fill(0);
                    last.fill(0);
                    if (plaintext.length !== metadata.sizeBytes || sha256(plaintext) !== metadata.sha256) {
                        throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Chunk integrity check failed');
                    }
                    totalHash.update(plaintext);
                    totalSizeBytes += plaintext.length;
                    // RFX-08 backstop. The declared total was already refused upstream and
                    // validateManifest pins the chunk sizes to that total, so this can
                    // only fire if the two ever stop agreeing. It has to run BEFORE the
                    // yield: the caller keeps every chunk it is handed, so checking after
                    // the hand-off would let one more chunk through.
                    if (totalSizeBytes > maxPlaintextBytes) {
                        throw new CryptoStorageError('SIZE_LIMIT', 'Artifact exceeds the plaintext decryption limit');
                    }
                    yield plaintext;
                    plaintext = undefined;
                }
                catch (error) {
                    plaintext?.fill(0);
                    // A size refusal is a policy decision, not an authentication verdict.
                    // Relabelling it here would tell the caller the artifact failed to
                    // authenticate when the only thing wrong was that it did not fit.
                    if (error instanceof CryptoStorageError && error.code === 'SIZE_LIMIT')
                        throw error;
                    throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext chunk authentication failed');
                }
                finally {
                    encrypted.fill(0);
                    nonce.fill(0);
                    tag.fill(0);
                    chunkAdditionalData.fill(0);
                }
            }
            await reader.assertEnd();
            if (totalSizeBytes !== manifest.totalSizeBytes || totalHash.digest('hex') !== manifest.fileSha256) {
                throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Artifact integrity check failed');
            }
        }
        finally {
            try {
                await reader.close();
            }
            finally {
                dek.fill(0);
                aad.fill(0);
                suppliedMac.fill(0);
                key?.fill(0);
            }
        }
    }
}
exports.CryptoStorageFacade = CryptoStorageFacade;
