import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * SEC-ENC-02 (SD-01): application envelope encryption for the Connector's
 * durable invocation fields.
 *
 * Three columns in `connector_invocations` carry tenant/procider content and
 * MUST NOT reach SQL as plaintext:
 *
 *   - `request`     (JSONB)  the full LocalInvocationRequest (prompt/text/
 *                            options/artifact bytes),
 *   - `result`      (JSONB)  the provider result (content/data/session),
 *   - `session_ref` (TEXT)   the continuation session, incl. the async 202
 *                            session captured by CR06-04.
 *
 * The format is deliberately the same envelope the Orchestrator runtime
 * already uses for control-plane metadata (`metadata-crypto.ts`): AES-256-GCM
 * with an independent per-value DEK, the DEK wrapped by a key provider,
 * AAD = sha256(tenantId|slot|refId), and a self-describing v1 envelope. Two
 * identical formats in one platform is one migration less later; the slot
 * names below keep the two domains separate under that shared convention.
 *
 * Fail-closed rules, all enforced here rather than at each call site:
 *   - no key provider / missing key      -> KEY_PROVIDER_FAILED (never plaintext)
 *   - wrong tenant / row / slot          -> CONTEXT_MISMATCH
 *   - tampered ciphertext / tag / AAD    -> AUTHENTICATION_FAILED
 *   - value that is not an envelope      -> NOT_SEALED (unless an explicit
 *                                           migration window allows legacy rows)
 *
 * Key material never appears in envelopes, errors or logs. The DEK exists
 * only inside seal()/open() for the duration of one operation.
 */

export const INVOCATION_ENVELOPE_VERSION = 1 as const;
export const INVOCATION_ENVELOPE_ALGORITHM = 'aes-256-gcm' as const;

const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEK_KEY_BYTES = 32;
const KEY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Slots are bound into the AAD, so a `request` envelope replayed into
 * `result` (or into another service's slot) fails CONTEXT_MISMATCH instead of
 * decrypting. The names are namespaced by table to avoid colliding with the
 * Orchestrator metadata slots under the shared AAD derivation.
 */
export const INVOCATION_CRYPTO_SLOTS = [
  'connector_invocations.request',
  'connector_invocations.result',
  'connector_invocations.session_ref',
] as const;

export type InvocationCryptoSlot = (typeof INVOCATION_CRYPTO_SLOTS)[number];

export function isInvocationCryptoSlot(value: unknown): value is InvocationCryptoSlot {
  return typeof value === 'string' && (INVOCATION_CRYPTO_SLOTS as readonly string[]).includes(value);
}

/** What an envelope is bound to. `refId` is the invocation row identity. */
export interface InvocationCryptoContext {
  readonly tenantId: string;
  readonly slot: InvocationCryptoSlot;
  readonly refId: string;
}

/** The wrapped DEK, matching the metadata/Vault Transit provider output shape. */
export interface InvocationWrappedDek {
  readonly version: number;
  readonly keyName: string;
  readonly keyVersion: number;
  readonly wrappedKey: string;
}

/** The sealed value persisted in place of the plaintext field. */
export interface SealedInvocationField {
  readonly version: typeof INVOCATION_ENVELOPE_VERSION;
  readonly algorithm: typeof INVOCATION_ENVELOPE_ALGORITHM;
  readonly keyRef: string;
  readonly dek: InvocationWrappedDek;
  readonly nonce: string;
  readonly tag: string;
  readonly aad: string;
  readonly ciphertext: string;
  /** SHA-256 hex of the canonical plaintext; keeps business matching possible. */
  readonly plaintextSha256: string;
}

export type InvocationCryptoErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'NOT_SEALED'
  | 'CONTEXT_MISMATCH'
  | 'AUTHENTICATION_FAILED'
  | 'KEY_PROVIDER_FAILED';

export class InvocationFieldCryptoError extends Error {
  public readonly code: InvocationCryptoErrorCode;

  public constructor(code: InvocationCryptoErrorCode, message: string) {
    super(message);
    this.name = 'InvocationFieldCryptoError';
    this.code = code;
  }
}

function fail(code: InvocationCryptoErrorCode, message: string): never {
  throw new InvocationFieldCryptoError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The key-wrapping seam. Production wiring supplies a Vault Transit-backed
 * provider; `createLocalInvocationKekProvider` below is the self-contained
 * implementation for environments whose managed key is injected directly
 * (same trust model as the existing CONNECTOR_ENCRYPTION_KEY credential key).
 */
export interface InvocationDekKeyProvider {
  wrapDek(dek: Buffer, keyRef: string, keyVersion?: number): Promise<InvocationWrappedDek>;
  unwrapDek(wrapped: InvocationWrappedDek): Promise<Buffer>;
}

export interface InvocationFieldCrypto {
  seal(value: unknown, context: InvocationCryptoContext): Promise<SealedInvocationField>;
  open(sealed: SealedInvocationField, context: InvocationCryptoContext): Promise<unknown>;
  isSealed(value: unknown): value is SealedInvocationField;
}

/**
 * Same AAD convention as the Orchestrator metadata crypto:
 * sha256(`${tenantId}|${slot}|${refId}`). The digest is fixed-length and the
 * context itself is not persisted in the clear.
 */
export function deriveInvocationAad(context: InvocationCryptoContext): Buffer {
  return createHash('sha256')
    .update(`${context.tenantId}|${context.slot}|${context.refId}`, 'utf8')
    .digest();
}

/** Canonical JSON (recursively sorted object keys) so hashes are stable. */
export function canonicalizeInvocationJson(value: unknown): Buffer {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort()) sorted[key] = walk(node[key]);
      return sorted;
    }
    return node;
  };
  return Buffer.from(JSON.stringify(walk(value) ?? null), 'utf8');
}

/** SHA-256 hex over the canonical plaintext bytes. */
export function invocationPlaintextHash(value: unknown): string {
  return createHash('sha256').update(canonicalizeInvocationJson(value)).digest('hex');
}

function assertContext(context: InvocationCryptoContext): void {
  if (!context || typeof context !== 'object') fail('INVALID_INPUT', 'invocation crypto context is required');
  if (!context.tenantId) fail('INVALID_INPUT', 'tenantId is required to bind an invocation envelope');
  if (!context.refId) fail('INVALID_INPUT', 'refId is required to bind an invocation envelope');
  if (!isInvocationCryptoSlot(context.slot)) {
    fail('INVALID_INPUT', `unknown invocation crypto slot ${String(context.slot)}`);
  }
}

function assertEnvelopeShape(value: unknown): asserts value is SealedInvocationField {
  if (!isRecord(value)) fail('NOT_SEALED', 'invocation value is not a sealed envelope');
  const fields = ['version', 'algorithm', 'keyRef', 'dek', 'nonce', 'tag', 'aad', 'ciphertext'] as const;
  for (const field of fields) {
    if (value[field] === undefined) fail('NOT_SEALED', `sealed invocation envelope is missing ${field}`);
  }
  if (value.version !== INVOCATION_ENVELOPE_VERSION) {
    fail('NOT_SEALED', `unsupported invocation envelope version ${String(value.version)}`);
  }
  if (value.algorithm !== INVOCATION_ENVELOPE_ALGORITHM) {
    fail('NOT_SEALED', `unsupported invocation envelope algorithm ${String(value.algorithm)}`);
  }
  if (!isRecord(value.dek)) fail('NOT_SEALED', 'sealed invocation envelope dek is invalid');
}

/**
 * Structural discriminator. A legacy plaintext field (a request object with
 * `invocationId`, a result object with `content`, a bare session string) can
 * never carry this bundle of fields, so an old row is never misread as an
 * envelope; anything that does look like one is opened fail-closed.
 */
export function isSealedInvocationField(value: unknown): value is SealedInvocationField {
  if (!isRecord(value)) return false;
  return value.version === INVOCATION_ENVELOPE_VERSION
    && value.algorithm === INVOCATION_ENVELOPE_ALGORITHM
    && typeof value.keyRef === 'string'
    && isRecord(value.dek)
    && typeof value.nonce === 'string'
    && typeof value.tag === 'string'
    && typeof value.aad === 'string'
    && typeof value.ciphertext === 'string';
}

/** Build the invocation field crypto seam over a DEK key provider. */
export function createInvocationFieldCrypto(
  keyProvider: InvocationDekKeyProvider,
  keyRef: string,
): InvocationFieldCrypto {
  if (!keyProvider || typeof keyProvider.wrapDek !== 'function' || typeof keyProvider.unwrapDek !== 'function') {
    fail('INVALID_CONFIGURATION', 'invocation key provider is required');
  }
  if (!KEY_REF_PATTERN.test(keyRef)) {
    fail('INVALID_CONFIGURATION', 'invocation keyRef is not a safe key reference');
  }

  const isSealed = (value: unknown): value is SealedInvocationField => isSealedInvocationField(value);

  const seal = async (
    value: unknown,
    context: InvocationCryptoContext,
  ): Promise<SealedInvocationField> => {
    assertContext(context);
    const plaintext = canonicalizeInvocationJson(value);
    const dek = randomBytes(DEK_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const aad = deriveInvocationAad(context);
    let wrapped: InvocationWrappedDek;
    try {
      wrapped = await keyProvider.wrapDek(dek, keyRef);
    } catch (error) {
      dek.fill(0);
      if (error instanceof InvocationFieldCryptoError) throw error;
      fail('KEY_PROVIDER_FAILED', 'invocation DEK could not be wrapped');
    }
    if (!isRecord(wrapped)
      || typeof wrapped.keyName !== 'string'
      || typeof wrapped.keyVersion !== 'number'
      || typeof wrapped.wrappedKey !== 'string') {
      dek.fill(0);
      fail('KEY_PROVIDER_FAILED', 'invocation DEK wrap returned an invalid envelope');
    }
    try {
      const cipher = createCipheriv(INVOCATION_ENVELOPE_ALGORITHM, dek, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        version: INVOCATION_ENVELOPE_VERSION,
        algorithm: INVOCATION_ENVELOPE_ALGORITHM,
        keyRef,
        dek: wrapped,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        aad: aad.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
      };
    } finally {
      dek.fill(0);
    }
  };

  const open = async (
    sealed: SealedInvocationField,
    context: InvocationCryptoContext,
  ): Promise<unknown> => {
    assertContext(context);
    assertEnvelopeShape(sealed);
    // Compare the stored AAD to the one this context demands BEFORE asking the
    // key provider for anything: a wrong-tenant/row/slot replay is refused
    // without touching a key, and never reaches an authenticated decrypt.
    const expectedAad = deriveInvocationAad(context);
    const storedAad = Buffer.from(sealed.aad, 'base64');
    if (storedAad.length !== expectedAad.length || !timingSafeEqual(storedAad, expectedAad)) {
      fail('CONTEXT_MISMATCH', 'invocation envelope is bound to a different tenant, slot, or row');
    }
    let dek: Buffer;
    try {
      dek = await keyProvider.unwrapDek(sealed.dek);
    } catch (error) {
      if (error instanceof InvocationFieldCryptoError) throw error;
      fail('KEY_PROVIDER_FAILED', 'invocation DEK could not be unwrapped');
    }
    if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
      dek.fill?.(0);
      fail('KEY_PROVIDER_FAILED', 'invocation DEK unwrap returned an invalid key');
    }
    try {
      const decipher = createDecipheriv(INVOCATION_ENVELOPE_ALGORITHM, dek, Buffer.from(sealed.nonce, 'base64'), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(expectedAad);
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]);
      // Defense in depth: the envelope carries the canonical plaintext hash for
      // business matching; a stored hash that does not match the authenticated
      // plaintext is refused rather than returned.
      const digest = createHash('sha256').update(plaintext).digest('hex');
      if (sealed.plaintextSha256 !== undefined && digest !== sealed.plaintextSha256) {
        fail('AUTHENTICATION_FAILED', 'invocation envelope plaintext hash does not match its content');
      }
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof InvocationFieldCryptoError) throw error;
      fail('AUTHENTICATION_FAILED', 'invocation envelope failed authenticated decryption');
    } finally {
      dek.fill(0);
    }
  };

  return { seal, open, isSealed };
}

/* ---------------------------------------------------------------------- */
/* Local wrapped-DEK provider (versioned managed key, rotation-ready)      */
/* ---------------------------------------------------------------------- */

export interface LocalInvocationKekConfig {
  /** Opaque application key reference stamped into envelopes. */
  readonly keyRef: string;
  /** Version used for new wraps; older versions stay readable. */
  readonly activeVersion: number;
  /** version -> base64 32-byte AES-256 key-encryption key. */
  readonly keysByVersion: Readonly<Record<string, string>>;
}

/**
 * Parse the JSON key configuration. Malformed configuration fails violently at
 * boot: a silently ignored key would turn "required encryption" into plaintext
 * or a half-open store.
 *
 * Shape: `{"keyRef":"du-connector-invocation-v1","activeVersion":2,
 *          "keys":{"1":"<base64 32B>","2":"<base64 32B>"}}`
 */
export function parseLocalInvocationKekConfig(raw: string | undefined): LocalInvocationKekConfig | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('INVALID_CONFIGURATION', 'invocation encryption key config is not valid JSON');
  }
  if (!isRecord(parsed)) fail('INVALID_CONFIGURATION', 'invocation encryption key config must be an object');
  const keyRef = parsed.keyRef;
  if (typeof keyRef !== 'string' || !KEY_REF_PATTERN.test(keyRef)) {
    fail('INVALID_CONFIGURATION', 'invocation encryption keyRef is invalid');
  }
  const activeVersion = parsed.activeVersion;
  if (typeof activeVersion !== 'number' || !Number.isSafeInteger(activeVersion) || activeVersion < 1) {
    fail('INVALID_CONFIGURATION', 'invocation encryption activeVersion must be a positive integer');
  }
  if (!isRecord(parsed.keys)) {
    fail('INVALID_CONFIGURATION', 'invocation encryption keys must be an object of version -> base64 key');
  }
  const keysByVersion: Record<string, string> = {};
  for (const [version, value] of Object.entries(parsed.keys)) {
    if (!/^[1-9][0-9]*$/.test(version) || Number(version) > 2_147_483_647) {
      fail('INVALID_CONFIGURATION', 'invocation encryption key version is invalid');
    }
    if (typeof value !== 'string' || value.length === 0) {
      fail('INVALID_CONFIGURATION', 'invocation encryption key material is invalid');
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== KEK_KEY_BYTES || decoded.toString('base64') !== value) {
      decoded.fill(0);
      fail('INVALID_CONFIGURATION', 'invocation encryption key must be a base64 32-byte key');
    }
    keysByVersion[version] = value;
  }
  if (keysByVersion[String(activeVersion)] === undefined) {
    fail('INVALID_CONFIGURATION', 'invocation encryption activeVersion has no key material');
  }
  return { keyRef, activeVersion, keysByVersion };
}

/**
 * AES-256-GCM key-encryption-key provider. Each DEK is wrapped under the
 * configured KEK version with a fresh nonce; `wrappedKey` stores
 * base64(nonce[12] | tag[16] | ciphertext[32]) so the envelope is
 * self-describing without a sidecar.
 */
export function createLocalInvocationKekProvider(config: LocalInvocationKekConfig): InvocationDekKeyProvider {
  const keys = new Map<number, Buffer>();
  for (const [version, value] of Object.entries(config.keysByVersion)) {
    keys.set(Number(version), Buffer.from(value, 'base64'));
  }
  if (!keys.has(config.activeVersion)) {
    fail('INVALID_CONFIGURATION', 'invocation encryption activeVersion has no key material');
  }
  const kekAad = (keyRef: string, version: number): Buffer =>
    Buffer.from(`du-connector-invocation-kek:v1|${keyRef}|${version}`, 'utf8');

  return {
    async wrapDek(dek: Buffer, keyRef: string, keyVersion?: number): Promise<InvocationWrappedDek> {
      if (keyRef !== config.keyRef) fail('KEY_PROVIDER_FAILED', 'invocation DEK keyRef is not configured');
      if (!(dek instanceof Uint8Array) || dek.byteLength !== DEK_BYTES) {
        fail('KEY_PROVIDER_FAILED', 'invocation DEK must be exactly 32 bytes');
      }
      const version = keyVersion ?? config.activeVersion;
      const kek = keys.get(version);
      if (!kek) fail('KEY_PROVIDER_FAILED', 'invocation DEK key version is not configured');
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(INVOCATION_ENVELOPE_ALGORITHM, kek, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(kekAad(config.keyRef, version));
      const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
      return {
        version: 1,
        keyName: config.keyRef,
        keyVersion: version,
        wrappedKey: Buffer.concat([nonce, cipher.getAuthTag(), wrapped]).toString('base64'),
      };
    },

    async unwrapDek(wrapped: InvocationWrappedDek): Promise<Buffer> {
      if (!isRecord(wrapped)
        || wrapped.keyName !== config.keyRef
        || typeof wrapped.keyVersion !== 'number'
        || !Number.isSafeInteger(wrapped.keyVersion)
        || typeof wrapped.wrappedKey !== 'string') {
        fail('KEY_PROVIDER_FAILED', 'wrapped invocation DEK envelope is invalid');
      }
      const kek = keys.get(wrapped.keyVersion);
      if (!kek) fail('KEY_PROVIDER_FAILED', 'invocation DEK key version is not configured');
      let packed: Buffer;
      try {
        packed = Buffer.from(wrapped.wrappedKey, 'base64');
      } catch {
        fail('KEY_PROVIDER_FAILED', 'wrapped invocation DEK is not valid base64');
      }
      if (packed.length !== NONCE_BYTES + TAG_BYTES + DEK_BYTES) {
        fail('KEY_PROVIDER_FAILED', 'wrapped invocation DEK has an invalid length');
      }
      const nonce = packed.subarray(0, NONCE_BYTES);
      const tag = packed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const ciphertext = packed.subarray(NONCE_BYTES + TAG_BYTES);
      try {
        const decipher = createDecipheriv(INVOCATION_ENVELOPE_ALGORITHM, kek, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(kekAad(config.keyRef, wrapped.keyVersion));
        decipher.setAuthTag(tag);
        const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (dek.length !== DEK_BYTES) {
          dek.fill(0);
          fail('KEY_PROVIDER_FAILED', 'unwrapped invocation DEK has an invalid length');
        }
        return dek;
      } catch (error) {
        if (error instanceof InvocationFieldCryptoError) throw error;
        fail('KEY_PROVIDER_FAILED', 'wrapped invocation DEK failed authenticated decryption');
      }
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Environment resolution (composition integration seam)                   */
/* ---------------------------------------------------------------------- */

export interface InvocationStorageCryptoOptions {
  /** Absent = sensitive writes fail closed (no plaintext fallback). */
  readonly fieldCrypto?: InvocationFieldCrypto;
  /** Bounded historical-read window; default false (strict). */
  readonly legacyPlaintextReads?: boolean;
}

/**
 * Resolve the ledger crypto options from the process environment.
 *
 *   CONNECTOR_INVOCATION_ENCRYPTION_KEYS           JSON LocalInvocationKekConfig
 *   CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS    'true' opens the read window
 *
 * Must be called from the composition root so a malformed key config fails
 * startup instead of surfacing at the first invocation. No crypto configured
 * means the Postgres ledger refuses to persist sensitive fields.
 */
export function resolveInvocationStorageCryptoFromEnv(
  env: Record<string, string | undefined>,
): InvocationStorageCryptoOptions {
  const parsed = parseLocalInvocationKekConfig(env.CONNECTOR_INVOCATION_ENCRYPTION_KEYS);
  const fieldCrypto = parsed === undefined
    ? undefined
    : createInvocationFieldCrypto(createLocalInvocationKekProvider(parsed), parsed.keyRef);
  return {
    ...(fieldCrypto === undefined ? {} : { fieldCrypto }),
    legacyPlaintextReads: env.CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS === 'true',
  };
}
