import { createHash, timingSafeEqual } from 'node:crypto';

/** Payload families that must be covered by an ENC-09 source adapter. */
export const ENC09_PAYLOAD_KINDS = [
  'artifact',
  'operation_input',
  'task_payload',
  'child_payload',
  'hitl_response',
  'control_metadata',
  'outbox_payload',
  'checkpoint',
] as const;

export type Enc09PayloadKind = (typeof ENC09_PAYLOAD_KINDS)[number];
export type PayloadStorage = 's3' | 'postgres' | 'redis' | 'other';
export type InventoryClassification = 'plaintext' | 'encrypted' | 'unresolved';

const SHA256_RE = /^[a-f0-9]{64}$/;
const ENCRYPTED_PAYLOAD_FORMAT_VERSION = 1;
const MAX_DUAL_READ_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface PayloadInventoryEntry {
  readonly payloadId: string;
  readonly tenantId: string;
  readonly payloadKind: Enc09PayloadKind;
  readonly storage: PayloadStorage;
  /** Immutable row/object generation used for optimistic commit and AAD. */
  readonly objectVersion: string | null;
  readonly classification: InventoryClassification;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  /** Number of live references that still depend on this record. */
  readonly referenceCount: number;
}

export interface PayloadInventorySource {
  readonly name: string;
  /** Explicitly list every payload family this scanner enumerates. */
  readonly covers: readonly Enc09PayloadKind[];
  /** Return metadata only. Payload bytes and ciphertext must never enter a report. */
  scan(): Promise<readonly PayloadInventoryEntry[]>;
}

export interface PayloadInventoryIssue {
  readonly source: string;
  readonly payloadId: string | null;
  readonly code: 'INVALID_IDENTITY' | 'INVALID_METADATA' | 'DUPLICATE_IDENTITY' | 'SOURCE_UNAVAILABLE' | 'UNCOVERED_SCOPE';
}

export interface PayloadInventoryReport {
  readonly generatedAt: string;
  readonly scannedRecords: number;
  readonly coveredKinds: readonly Enc09PayloadKind[];
  readonly uncoveredKinds: readonly Enc09PayloadKind[];
  readonly plaintextPayloads: number;
  readonly encryptedPayloads: number;
  readonly unresolvedPayloads: number;
  readonly unresolvedReferences: number;
  readonly entries: readonly PayloadInventoryEntry[];
  readonly issues: readonly PayloadInventoryIssue[];
  /** ENC-09 intentionally retains all legacy sources pending backup sign-off. */
  readonly legacyDeletionAllowed: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPayloadKind(value: unknown): value is Enc09PayloadKind {
  return typeof value === 'string' && (ENC09_PAYLOAD_KINDS as readonly string[]).includes(value);
}

function isStorage(value: unknown): value is PayloadStorage {
  return value === 's3' || value === 'postgres' || value === 'redis' || value === 'other';
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function isInventoryEntry(value: unknown): value is PayloadInventoryEntry {
  if (!isRecord(value)) return false;
  return validText(value.payloadId)
    && validText(value.tenantId)
    && isPayloadKind(value.payloadKind)
    && isStorage(value.storage)
    && (value.objectVersion === null || validText(value.objectVersion))
    && (value.classification === 'plaintext' || value.classification === 'encrypted' || value.classification === 'unresolved')
    && (value.sizeBytes === null || validSize(value.sizeBytes))
    && (value.sha256 === null || validHash(value.sha256))
    && validCount(value.referenceCount);
}

/**
 * Collect a metadata-only inventory across independent S3/PG/control-plane
 * scanners. Missing identity/version/hash data is recorded as unresolved and
 * blocks retirement instead of being silently omitted.
 */
export async function inventoryPlaintextPayloads(
  sources: readonly PayloadInventorySource[],
  generatedAt = new Date(),
): Promise<PayloadInventoryReport> {
  if (!Array.isArray(sources) || !(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
    throw new Error('invalid payload inventory configuration');
  }
  const entries: PayloadInventoryEntry[] = [];
  const issues: PayloadInventoryIssue[] = [];
  const identities = new Set<string>();
  const coveredKinds = new Set<Enc09PayloadKind>();
  for (const source of sources) {
    if (!validText(source?.name) || !Array.isArray(source.covers)
      || source.covers.some((kind: unknown) => !isPayloadKind(kind)) || typeof source.scan !== 'function') {
      issues.push({ source: 'unknown', payloadId: null, code: 'INVALID_IDENTITY' });
      continue;
    }
    for (const kind of source.covers) coveredKinds.add(kind);
    let scanned: readonly unknown[];
    try {
      scanned = await source.scan();
    } catch {
      issues.push({ source: source.name, payloadId: null, code: 'SOURCE_UNAVAILABLE' });
      continue;
    }
    if (!Array.isArray(scanned)) {
      issues.push({ source: source.name, payloadId: null, code: 'INVALID_METADATA' });
      continue;
    }
    for (const candidate of scanned) {
      if (!isInventoryEntry(candidate)) {
        issues.push({
          source: source.name,
          payloadId: isRecord(candidate) && validText(candidate.payloadId) ? candidate.payloadId : null,
          code: isRecord(candidate) && (!validText(candidate.payloadId) || !validText(candidate.tenantId))
            ? 'INVALID_IDENTITY'
            : 'INVALID_METADATA',
        });
        continue;
      }
      const identity = `${source.name}\u0000${candidate.storage}\u0000${candidate.tenantId}\u0000${candidate.payloadId}`;
      if (identities.has(identity)) {
        issues.push({ source: source.name, payloadId: candidate.payloadId, code: 'DUPLICATE_IDENTITY' });
        continue;
      }
      identities.add(identity);
      const missingRequiredMetadata = candidate.objectVersion === null
        || candidate.sizeBytes === null
        || candidate.sha256 === null;
      if (missingRequiredMetadata && candidate.classification !== 'unresolved') {
        entries.push({ ...candidate, classification: 'unresolved' });
        issues.push({ source: source.name, payloadId: candidate.payloadId, code: 'INVALID_METADATA' });
      } else {
        entries.push(candidate);
      }
    }
  }
  const plaintextPayloads = entries.filter((entry) => entry.classification === 'plaintext').length;
  const encryptedPayloads = entries.filter((entry) => entry.classification === 'encrypted').length;
  const unresolvedPayloads = entries.filter((entry) => entry.classification === 'unresolved').length;
  const uncoveredKinds = ENC09_PAYLOAD_KINDS.filter((kind) => !coveredKinds.has(kind));
  for (const kind of uncoveredKinds) {
    issues.push({ source: 'inventory', payloadId: kind, code: 'UNCOVERED_SCOPE' });
  }
  const unresolvedReferences = entries.reduce((total, entry) => {
    if (entry.classification === 'encrypted') return total;
    return total + Math.max(1, entry.referenceCount);
  }, 0) + issues.length;
  return {
    generatedAt: generatedAt.toISOString(),
    scannedRecords: entries.length,
    coveredKinds: ENC09_PAYLOAD_KINDS.filter((kind) => coveredKinds.has(kind)),
    uncoveredKinds,
    plaintextPayloads,
    encryptedPayloads,
    unresolvedPayloads,
    unresolvedReferences,
    entries,
    issues,
    legacyDeletionAllowed: false,
  };
}

export interface PayloadCryptoContext {
  readonly tenantId: string;
  readonly payloadId: string;
  readonly payloadKind: Enc09PayloadKind;
  readonly objectVersion: string;
}

/** Opaque authenticated ciphertext plus the metadata needed for safe verify. */
export interface EncryptedPayloadEnvelope {
  readonly formatVersion: number;
  readonly tenantId: string;
  readonly payloadId: string;
  readonly payloadKind: Enc09PayloadKind;
  readonly objectVersion: string;
  readonly plaintextSizeBytes: number;
  readonly plaintextSha256: string;
  readonly ciphertext: unknown;
}

export interface PayloadMigrationCodec {
  encrypt(plaintext: Uint8Array, context: PayloadCryptoContext): Promise<EncryptedPayloadEnvelope>;
  /** Must authenticate tenant, payload id/kind, and object version before returning bytes. */
  decrypt(envelope: EncryptedPayloadEnvelope, context: PayloadCryptoContext): Promise<Uint8Array>;
}

export interface LockedLegacyPayload {
  readonly payloadId: string;
  readonly tenantId: string;
  readonly payloadKind: Enc09PayloadKind;
  readonly storage: PayloadStorage;
  readonly objectVersion: string | null;
  readonly classification: InventoryClassification;
  readonly plaintext: Uint8Array | null;
  readonly envelope: EncryptedPayloadEnvelope | null;
  readonly expectedSizeBytes: number | null;
  readonly expectedSha256: string | null;
  readonly referenceCount: number;
}

export interface PayloadMigrationCounts {
  readonly plaintextPayloads: number;
  readonly encryptedPayloads: number;
  readonly unresolvedPayloads: number;
  readonly unresolvedReferences: number;
}

export interface PayloadMigrationStore {
  inventory(): Promise<PayloadMigrationCounts>;
  listPayloadIds(): Promise<readonly string[]>;
  /** Keep a row/object generation locked until the pointer is committed. */
  withPayloadLocked<T>(
    payloadId: string,
    action: (
      payload: LockedLegacyPayload | null,
      commitEncrypted: (envelope: EncryptedPayloadEnvelope) => Promise<boolean>,
      restoreLegacy: () => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T>;
}

export interface PayloadMigrationIssue {
  readonly payloadId: string;
  readonly code:
    | 'SOURCE_NOT_FOUND'
    | 'SOURCE_INTEGRITY_MISMATCH'
    | 'SOURCE_METADATA_MISSING'
    | 'ENCRYPTED_ENVELOPE_INVALID'
    | 'ENCRYPTED_READBACK_MISMATCH'
    | 'MIGRATION_COMMIT_CONFLICT'
    | 'MIGRATION_STORE_UNAVAILABLE'
    | 'ENCRYPTION_UNAVAILABLE';
}

export interface PayloadMigrationResult {
  readonly state: 'complete' | 'incomplete';
  readonly scannedPayloads: number;
  readonly migratedPayloads: number;
  readonly verifiedPayloads: number;
  readonly failedPayloads: number;
  readonly unresolvedReferences: number;
  readonly before: PayloadMigrationCounts;
  readonly after: PayloadMigrationCounts;
  readonly issues: readonly PayloadMigrationIssue[];
  readonly legacySourcesRetained: true;
  readonly legacyDeletionAllowed: false;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function validContext(payload: LockedLegacyPayload): payload is LockedLegacyPayload & { objectVersion: string } {
  return validText(payload.payloadId) && validText(payload.tenantId) && isPayloadKind(payload.payloadKind)
    && isStorage(payload.storage) && validText(payload.objectVersion);
}

function validEnvelope(envelope: EncryptedPayloadEnvelope, context: PayloadCryptoContext): boolean {
  return isRecord(envelope)
    && envelope.formatVersion === ENCRYPTED_PAYLOAD_FORMAT_VERSION
    && envelope.tenantId === context.tenantId
    && envelope.payloadId === context.payloadId
    && envelope.payloadKind === context.payloadKind
    && envelope.objectVersion === context.objectVersion
    && validSize(envelope.plaintextSizeBytes)
    && validHash(envelope.plaintextSha256)
    && envelope.ciphertext !== undefined && envelope.ciphertext !== null;
}

function isSameIntegrity(bytes: Uint8Array, size: number, sha256: string): boolean {
  return bytes.byteLength === size && digest(bytes) === sha256.toLowerCase();
}

/**
 * Idempotent, lock/CAS based backfill. A source is retained by contract;
 * implementations only switch the active reference after encrypted readback
 * has authenticated the exact tenant, payload, version, size, and digest.
 */
export async function backfillLegacyPayloads(
  store: PayloadMigrationStore,
  codec: PayloadMigrationCodec,
): Promise<PayloadMigrationResult> {
  const before = await store.inventory();
  const candidates = await store.listPayloadIds();
  let migratedPayloads = 0;
  let verifiedPayloads = 0;
  const issues: PayloadMigrationIssue[] = [];

  for (const payloadId of candidates) {
    let outcome: 'migrated' | 'verified' | { failed: PayloadMigrationIssue['code'] };
    try {
      outcome = await store.withPayloadLocked(payloadId, async (payload, commitEncrypted) => {
        if (!payload) return { failed: 'SOURCE_NOT_FOUND' };
        if (payload.classification === 'unresolved' || !validContext(payload)) {
          return { failed: 'SOURCE_METADATA_MISSING' };
        }
        const context: PayloadCryptoContext = {
          tenantId: payload.tenantId,
          payloadId: payload.payloadId,
          payloadKind: payload.payloadKind,
          objectVersion: payload.objectVersion,
        };
        if (
          !validSize(payload.expectedSizeBytes) || !validHash(payload.expectedSha256)
          || payload.referenceCount < 0 || !Number.isSafeInteger(payload.referenceCount)
        ) {
          return { failed: 'SOURCE_METADATA_MISSING' };
        }

        if (payload.classification === 'encrypted') {
          if (!payload.envelope || !validEnvelope(payload.envelope, context)) {
            return { failed: 'ENCRYPTED_ENVELOPE_INVALID' };
          }
          let plaintext: Uint8Array;
          try {
            plaintext = await codec.decrypt(payload.envelope, context);
          } catch {
            return { failed: 'ENCRYPTED_READBACK_MISMATCH' };
          }
          try {
            if (
              !isSameIntegrity(plaintext, payload.expectedSizeBytes, payload.expectedSha256)
              || payload.envelope.plaintextSizeBytes !== payload.expectedSizeBytes
              || payload.envelope.plaintextSha256.toLowerCase() !== payload.expectedSha256.toLowerCase()
            ) return { failed: 'ENCRYPTED_READBACK_MISMATCH' };
          } finally {
            plaintext.fill(0);
          }
          return 'verified';
        }

        if (!payload.plaintext) return { failed: 'SOURCE_NOT_FOUND' };
        if (!isSameIntegrity(payload.plaintext, payload.expectedSizeBytes, payload.expectedSha256)) {
          return { failed: 'SOURCE_INTEGRITY_MISMATCH' };
        }
        let envelope: EncryptedPayloadEnvelope;
        try {
          envelope = await codec.encrypt(payload.plaintext, context);
        } catch {
          return { failed: 'ENCRYPTION_UNAVAILABLE' };
        }
        if (!validEnvelope(envelope, context)
          || envelope.plaintextSizeBytes !== payload.expectedSizeBytes
          || envelope.plaintextSha256.toLowerCase() !== payload.expectedSha256.toLowerCase()) {
          return { failed: 'ENCRYPTED_ENVELOPE_INVALID' };
        }
        let readback: Uint8Array;
        try {
          readback = await codec.decrypt(envelope, context);
        } catch {
          return { failed: 'ENCRYPTED_READBACK_MISMATCH' };
        }
        try {
          if (!isSameIntegrity(readback, payload.expectedSizeBytes, payload.expectedSha256)
            || !sameBytes(payload.plaintext, readback)) {
            return { failed: 'ENCRYPTED_READBACK_MISMATCH' };
          }
        } finally {
          readback.fill(0);
        }
        if (!await commitEncrypted(envelope)) return { failed: 'MIGRATION_COMMIT_CONFLICT' };
        return 'migrated';
      });
    } catch {
      outcome = { failed: 'MIGRATION_STORE_UNAVAILABLE' };
    }

    if (typeof outcome === 'string') {
      if (outcome === 'migrated') migratedPayloads += 1;
      else verifiedPayloads += 1;
    } else {
      issues.push({ payloadId, code: outcome.failed });
    }
  }

  const after = await store.inventory();
  const failedPayloads = issues.length;
  const unresolvedReferences = Math.max(after.unresolvedReferences, failedPayloads);
  return {
    state: unresolvedReferences === 0 ? 'complete' : 'incomplete',
    scannedPayloads: candidates.length,
    migratedPayloads,
    verifiedPayloads,
    failedPayloads,
    unresolvedReferences,
    before,
    after,
    issues,
    legacySourcesRetained: true,
    legacyDeletionAllowed: false,
  };
}

export type PayloadRestoreResult =
  | { readonly state: 'restored' | 'already_legacy' }
  | { readonly state: 'incomplete'; readonly code: 'SOURCE_NOT_FOUND' | 'SOURCE_METADATA_MISSING' | 'SOURCE_INTEGRITY_MISMATCH' | 'ENCRYPTED_READBACK_MISMATCH' | 'RESTORE_COMMIT_CONFLICT' | 'MIGRATION_STORE_UNAVAILABLE' };

/** Restore the active pointer to retained legacy bytes after verifying both copies; ciphertext is kept. */
export async function restoreLegacyPayload(
  store: PayloadMigrationStore,
  codec: PayloadMigrationCodec,
  payloadId: string,
): Promise<PayloadRestoreResult> {
  try {
    return await store.withPayloadLocked(payloadId, async (payload, _commitEncrypted, restoreLegacy) => {
      if (!payload) return { state: 'incomplete', code: 'SOURCE_NOT_FOUND' };
      if (payload.classification === 'plaintext') return { state: 'already_legacy' };
      if (payload.classification !== 'encrypted' || !validContext(payload)
        || !payload.plaintext || !payload.envelope
        || !validSize(payload.expectedSizeBytes) || !validHash(payload.expectedSha256)) {
        return { state: 'incomplete', code: 'SOURCE_METADATA_MISSING' };
      }
      const context: PayloadCryptoContext = {
        tenantId: payload.tenantId,
        payloadId: payload.payloadId,
        payloadKind: payload.payloadKind,
        objectVersion: payload.objectVersion,
      };
      if (!validEnvelope(payload.envelope, context)
        || !isSameIntegrity(payload.plaintext, payload.expectedSizeBytes, payload.expectedSha256)) {
        return { state: 'incomplete', code: 'SOURCE_INTEGRITY_MISMATCH' };
      }
      let readback: Uint8Array;
      try {
        readback = await codec.decrypt(payload.envelope, context);
      } catch {
        return { state: 'incomplete', code: 'ENCRYPTED_READBACK_MISMATCH' };
      }
      try {
        if (!isSameIntegrity(readback, payload.expectedSizeBytes, payload.expectedSha256)
          || !sameBytes(readback, payload.plaintext)) {
          return { state: 'incomplete', code: 'ENCRYPTED_READBACK_MISMATCH' };
        }
      } finally {
        readback.fill(0);
      }
      return await restoreLegacy()
        ? { state: 'restored' }
        : { state: 'incomplete', code: 'RESTORE_COMMIT_CONFLICT' };
    });
  } catch {
    return { state: 'incomplete', code: 'MIGRATION_STORE_UNAVAILABLE' };
  }
}

/** Legacy bytes can be retired only after an independently verified backup and zero references. */
export function canRetireLegacyPayloads(
  inventory: Pick<PayloadMigrationCounts, 'unresolvedReferences'>,
  backupSignedOff: boolean,
): boolean {
  return backupSignedOff === true && Number.isSafeInteger(inventory.unresolvedReferences)
    && inventory.unresolvedReferences === 0;
}

export interface BoundedDualReadWindow {
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  allowsLegacyRead(nowMs?: number): boolean;
}

/** Construct an immutable, at-most-14-day legacy read window. */
export function createBoundedDualReadWindow(
  startsAt: Date | number,
  expiresAt: Date | number,
): BoundedDualReadWindow {
  const startsAtMs = startsAt instanceof Date ? startsAt.getTime() : startsAt;
  const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  if (!Number.isSafeInteger(startsAtMs) || !Number.isSafeInteger(expiresAtMs)
    || startsAtMs < 0 || expiresAtMs <= startsAtMs
    || expiresAtMs - startsAtMs > MAX_DUAL_READ_WINDOW_MS) {
    throw new Error('dual-read window must be positive and no longer than 14 days');
  }
  return Object.freeze({
    startsAtMs,
    expiresAtMs,
    allowsLegacyRead(nowMs = Date.now()): boolean {
      return Number.isFinite(nowMs) && nowMs >= startsAtMs && nowMs < expiresAtMs;
    },
  });
}

/** Resolve legacy data only during the configured window; encrypted reads always use the normal decoder. */
export async function readDuringBoundedDualRead<TStored, TRead>(input: {
  readonly value: TStored;
  readonly isEncrypted: (value: TStored) => boolean;
  readonly readEncrypted: (value: TStored) => Promise<TRead>;
  readonly readLegacy: (value: TStored) => Promise<TRead>;
  readonly window: BoundedDualReadWindow;
  readonly nowMs?: number;
}): Promise<TRead> {
  if (input.isEncrypted(input.value)) return input.readEncrypted(input.value);
  if (!input.window.allowsLegacyRead(input.nowMs)) {
    throw new Error('legacy payload read is outside the bounded dual-read window');
  }
  return input.readLegacy(input.value);
}

export interface RotationWrappedKey {
  readonly keyRef: string;
  readonly keyVersion: number;
  readonly ciphertext: string;
}

export interface RotationReadback {
  readonly plaintext: Uint8Array;
  readonly tenantId: string;
  readonly objectVersion: string;
}

export interface KeyRotationVerifier {
  rewrap(wrapped: RotationWrappedKey, targetKeyVersion: number): Promise<RotationWrappedKey>;
  unwrap(wrapped: RotationWrappedKey): Promise<Uint8Array>;
  /** Decrypt the same payload using the supplied wrapped DEK and authenticated context. */
  readPayload(wrapped: RotationWrappedKey, context: { tenantId: string; objectVersion: string }): Promise<RotationReadback>;
}

export interface KeyRotationVerificationResult {
  readonly keyRef: string;
  readonly previousKeyVersion: number;
  readonly targetKeyVersion: number;
  readonly payloadSizeBytes: number;
  readonly payloadSha256: string;
  readonly tenantId: string;
  readonly objectVersion: string;
  readonly verified: true;
}

/** Rewraps the DEK and proves it is unchanged by opening the payload with old and new wraps. */
export async function verifyKeyRotation(input: {
  readonly verifier: KeyRotationVerifier;
  readonly wrapped: RotationWrappedKey;
  readonly targetKeyVersion: number;
  readonly tenantId: string;
  readonly objectVersion: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
}): Promise<KeyRotationVerificationResult> {
  const { wrapped, targetKeyVersion, tenantId, objectVersion, expectedSizeBytes, expectedSha256 } = input;
  if (!validText(tenantId) || !validText(objectVersion) || !validText(wrapped?.keyRef)
    || !validText(wrapped?.ciphertext) || !Number.isSafeInteger(wrapped?.keyVersion) || wrapped.keyVersion < 1
    || !Number.isSafeInteger(targetKeyVersion) || targetKeyVersion <= wrapped.keyVersion
    || !validSize(expectedSizeBytes) || !validHash(expectedSha256)) {
    throw new Error('invalid key rotation verification input');
  }
  const context = { tenantId, objectVersion };
  let oldDek: Uint8Array | undefined;
  let newDek: Uint8Array | undefined;
  let oldRead: RotationReadback | undefined;
  let newRead: RotationReadback | undefined;
  try {
    const rotated = await input.verifier.rewrap(wrapped, targetKeyVersion);
    if (!isRecord(rotated) || rotated.keyRef !== wrapped.keyRef
      || rotated.keyVersion !== targetKeyVersion || !validText(rotated.ciphertext)) {
      throw new Error('key rotation returned an unexpected wrap');
    }
    oldDek = await input.verifier.unwrap(wrapped);
    newDek = await input.verifier.unwrap(rotated);
    if (oldDek.byteLength !== 32 || newDek.byteLength !== 32 || !sameBytes(oldDek, newDek)) {
      throw new Error('rewrapped DEK does not match the original');
    }
    oldRead = await input.verifier.readPayload(wrapped, context);
    newRead = await input.verifier.readPayload(rotated, context);
    for (const read of [oldRead, newRead]) {
      if (read.tenantId !== tenantId || read.objectVersion !== objectVersion
        || !isSameIntegrity(read.plaintext, expectedSizeBytes, expectedSha256)) {
        throw new Error('key rotation payload verification failed');
      }
    }
    if (!sameBytes(oldRead.plaintext, newRead.plaintext)) {
      throw new Error('key rotation changed the decrypted payload');
    }
    return {
      keyRef: wrapped.keyRef,
      previousKeyVersion: wrapped.keyVersion,
      targetKeyVersion,
      payloadSizeBytes: expectedSizeBytes,
      payloadSha256: expectedSha256.toLowerCase(),
      tenantId,
      objectVersion,
      verified: true,
    };
  } finally {
    if (oldDek) oldDek.fill(0);
    if (newDek) newDek.fill(0);
    if (oldRead) oldRead.plaintext.fill(0);
    if (newRead) newRead.plaintext.fill(0);
  }
}
