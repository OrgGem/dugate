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

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Envelope version. Bump only on a breaking change to the sealed shape. */
export const METADATA_ENVELOPE_VERSION = 1 as const;

/** AES-256-GCM parameters; identical to the storage facade (ENC-03). */
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The control-plane column an envelope belongs to. Bound into the AAD so a
 * sealed value cannot be moved between columns even within one tenant —
 * a tasks.payload_ref blob replayed into operations.input_ref is refused.
 */
export const METADATA_SLOTS = [
  'operations.input_ref',
  'tasks.payload_ref',
  'human_waits.response_ref',
  'step_checkpoints.output_ref',
] as const;

export type MetadataSlot = (typeof METADATA_SLOTS)[number];

export function isMetadataSlot(value: unknown): value is MetadataSlot {
  return (
    typeof value === 'string' &&
    (METADATA_SLOTS as readonly string[]).includes(value)
  );
}

/**
 * What an envelope is bound to. `refId` is the row identity (operation id,
 * task id, wait id, or checkpoint key) so an envelope cannot be lifted
 * between two rows of the same tenant and slot.
 */
export interface MetadataContext {
  readonly tenantId: string;
  readonly slot: MetadataSlot;
  readonly refId: string;
}

/** The wrapped DEK, matching the ENC-02 Vault Transit provider output. */
export interface MetadataWrappedDek {
  readonly version: number;
  readonly keyName: string;
  readonly keyVersion: number;
  readonly wrappedKey: string;
}

/** The sealed value persisted in place of the plaintext JSON. */
export interface SealedMetadata {
  readonly version: typeof METADATA_ENVELOPE_VERSION;
  readonly algorithm: 'aes-256-gcm';
  readonly keyRef: string;
  readonly dek: MetadataWrappedDek;
  readonly nonce: string;
  readonly tag: string;
  readonly aad: string;
  readonly ciphertext: string;
  /** SHA-256 hex of the canonical plaintext; lets callers keep content hashes. */
  readonly plaintextSha256: string;
}

export type MetadataCryptoErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_SEALED'
  | 'CONTEXT_MISMATCH'
  | 'AUTHENTICATION_FAILED'
  | 'KEY_PROVIDER_FAILED';

export class MetadataCryptoError extends Error {
  public readonly code: MetadataCryptoErrorCode;

  public constructor(code: MetadataCryptoErrorCode, message: string) {
    super(message);
    this.name = 'MetadataCryptoError';
    this.code = code;
  }
}

function fail(code: MetadataCryptoErrorCode, message: string): never {
  throw new MetadataCryptoError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted recursively. The same logical value then
 * always produces the same bytes, so the content hash the submit path pins
 * survives a key-order change. Arrays keep their order (order is meaning).
 */
export function canonicalizeMetadataJson(value: unknown): Buffer {
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

/** SHA-256 hex over the canonical bytes. */
export function metadataPlaintextHash(value: unknown): string {
  return createHash('sha256').update(canonicalizeMetadataJson(value)).digest('hex');
}

/**
 * The AAD is a digest of the binding context rather than the context itself:
 * it stays a fixed 32 bytes whatever the ids look like, and it leaks no row
 * identifier into a place an attacker can read without the key.
 */
function deriveAad(context: MetadataContext): Buffer {
  return createHash('sha256')
    .update(`${context.tenantId}|${context.slot}|${context.refId}`, 'utf8')
    .digest();
}

function assertContext(context: MetadataContext): void {
  if (!context.tenantId) fail('INVALID_INPUT', 'tenantId is required to bind a metadata envelope');
  if (!context.refId) fail('INVALID_INPUT', 'refId is required to bind a metadata envelope');
  if (!isMetadataSlot(context.slot)) {
    fail('INVALID_INPUT', `unknown metadata slot ${String(context.slot)}`);
  }
}

/** The ENC-02 provider surface this module depends on (key wrapping only). */
export interface MetadataKeyProvider {
  wrapDek(dek: Buffer, keyRef: string, keyVersion?: number): Promise<MetadataWrappedDek>;
  unwrapDek(wrapped: MetadataWrappedDek): Promise<Buffer>;
}

export interface SealOptions {
  /** Pin the Transit key version for this value; omit to use the provider default. */
  readonly keyVersion?: number;
}

export interface MetadataCrypto {
/** Encrypt a control-plane value into a self-describing envelope. */
  seal(value: unknown, context: MetadataContext, options?: SealOptions): Promise<SealedMetadata>;
  /** Decrypt an envelope, refusing any context it was not bound to. */
  open(sealed: SealedMetadata, context: MetadataContext): Promise<unknown>;
  /** True when a stored column value is already an envelope we produced. */
  isSealed(value: unknown): value is SealedMetadata;
  /**
   * Read a stored value that may be a legacy plaintext row.
   *
   * A plaintext value is returned as-is only when `allowPlaintext` is set —
   * that flag exists for the ENC-09 backfill window and for the submit path
   * before a row is written. Every other caller must fail closed, so a
   * forgotten encryption cannot degrade into "read the plaintext anyway".
   */
  readStored(value: unknown, context: MetadataContext, allowPlaintext: boolean): Promise<unknown>;
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
] as const;

function assertEnvelopeShape(value: unknown): asserts value is SealedMetadata {
  if (!isRecord(value)) fail('NOT_SEALED', 'metadata value is not a sealed envelope');
  for (const field of ENVELOPE_FIELDS) {
    if (value[field] === undefined) {
      fail('NOT_SEALED', `sealed metadata is missing ${field}`);
    }
  }
  if (value.version !== METADATA_ENVELOPE_VERSION) {
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
export function createMetadataCrypto(
  keyProvider: MetadataKeyProvider,
  keyRef: string,
): MetadataCrypto {
  if (!keyRef) fail('INVALID_INPUT', 'metadata keyRef must be configured');

  const isSealed = (value: unknown): value is SealedMetadata => {
    if (!isRecord(value)) return false;
    // The discriminator pair is a shape a legacy plaintext control-plane
    // object can never carry, so an old row is never misread as an envelope.
    return (
      value.version === METADATA_ENVELOPE_VERSION &&
      value.algorithm === 'aes-256-gcm' &&
      typeof value.ciphertext === 'string' &&
      isRecord(value.dek) &&
      typeof value.nonce === 'string' &&
      typeof value.tag === 'string'
    );
  };

  const seal = async (
    value: unknown,
    context: MetadataContext,
    options: SealOptions = {},
  ): Promise<SealedMetadata> => {
    assertContext(context);
    const plaintext = canonicalizeMetadataJson(value);
    const dek = randomBytes(DEK_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const aad = deriveAad(context);
    let wrapped: MetadataWrappedDek;
    try {
      wrapped = await keyProvider.wrapDek(dek, keyRef, options.keyVersion);
    } catch (err) {
      fail('KEY_PROVIDER_FAILED', `failed to wrap metadata DEK: ${(err as Error).message}`);
    }
    const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      version: METADATA_ENVELOPE_VERSION,
      algorithm: 'aes-256-gcm',
      keyRef,
      dek: wrapped,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      aad: aad.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
    };
  };

  const open = async (sealed: SealedMetadata, context: MetadataContext): Promise<unknown> => {
    assertContext(context);
    assertEnvelopeShape(sealed);
    let dek: Buffer;
    try {
      dek = await keyProvider.unwrapDek(sealed.dek);
    } catch (err) {
      fail('KEY_PROVIDER_FAILED', `failed to unwrap metadata DEK: ${(err as Error).message}`);
    }
    // Compare the stored AAD to the one this context demands BEFORE touching
    // the cipher. A cross-tenant or cross-slot replay therefore reports a
    // context mismatch instead of an authentication failure, and never gets
    // as far as attempting a decryption with the wrong binding.
    const expectedAad = deriveAad(context);
    const storedAad = Buffer.from(sealed.aad, 'base64');
    if (storedAad.length !== expectedAad.length || !timingSafeEqual(storedAad, expectedAad)) {
      fail('CONTEXT_MISMATCH', 'metadata envelope is bound to a different tenant, slot, or row');
    }
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(sealed.nonce, 'base64'), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(expectedAad);
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]);
    } catch {
      fail('AUTHENTICATION_FAILED', 'metadata envelope failed authenticated decryption');
    }
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  };

  const readStored = async (
    value: unknown,
    context: MetadataContext,
    allowPlaintext: boolean,
  ): Promise<unknown> => {
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