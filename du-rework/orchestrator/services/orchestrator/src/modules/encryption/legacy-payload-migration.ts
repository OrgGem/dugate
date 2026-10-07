import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../db/db';

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
  // ENCMETA-ENC09-KIND: the two `result_ref` columns. The kind string is
  // deliberately identical to the METADATA_SLOTS slot name, so the AAD slot a
  // reader opens under and the kind the store seals under cannot drift.
  'operations.result_ref',
  'tasks.result_ref',
  // CONTROL-PLANE-825: the remaining six control-plane slots, same rule —
  // payloadKind equals the METADATA_SLOTS slot name so writer/reader/store
  // cannot drift on the AAD slot.
  'operations.input_ref',
  'tasks.payload_ref',
  'human_waits.response_ref',
  'step_checkpoints.output_ref',
  'step_checkpoints.session_ref',
  'operations.prompt_overrides_ref',
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
/* --------------------------------------------------------------------------- */
/* ENCMETA-ENC09-KIND — `result_ref` family + the PG-backed store              */
/* --------------------------------------------------------------------------- */

/** The two `result_ref` payload kinds, in registration order. */
export const RESULT_REF_PAYLOAD_KINDS = [
  'operations.result_ref',
  'tasks.result_ref',
] as const;
export type ResultRefPayloadKind = (typeof RESULT_REF_PAYLOAD_KINDS)[number];

export function isResultRefPayloadKind(value: unknown): value is ResultRefPayloadKind {
  return typeof value === 'string'
    && (RESULT_REF_PAYLOAD_KINDS as readonly string[]).includes(value);
}

/**
 * The seal binding for one `result_ref` row. `slot === kind` and `refId` is the
 * row id, which is exactly what the writer (`completeTask`) seals under, so an
 * envelope produced here opens at the readers R1/R2/R3. `tasks.result_ref`
 * resolves `tenantId` via the `operations` JOIN because `tasks` has no
 * `tenant_id` column of its own (0001_platform_v1.sql:66-89).
 */
export interface ResultRefSealContext {
  readonly tenantId: string;
  readonly slot: ResultRefPayloadKind;
  readonly refId: string;
}

/**
 * The slice of the metadata seal seam this module needs, declared
 * structurally so `modules/encryption` does not import `modules/runtime`. The
 * real `MetadataCrypto` satisfies it: `ResultRefPayloadKind` is a subset of its
 * `MetadataSlot` union.
 */
export interface ResultRefSealer {
  seal(value: unknown, context: ResultRefSealContext): Promise<Record<string, unknown>>;
  open(sealed: unknown, context: ResultRefSealContext): Promise<unknown>;
  isSealed(value: unknown): boolean;
}

function sealContextFor(context: PayloadCryptoContext): ResultRefSealContext {
  if (!isResultRefPayloadKind(context.payloadKind)) {
    throw new Error(`result_ref codec cannot handle payload kind ${context.payloadKind}`);
  }
  return { tenantId: context.tenantId, slot: context.payloadKind, refId: context.payloadId };
}

/**
 * Bridges the byte-oriented migration codec onto the metadata seal seam.
 *
 * The column is TEXT and the runtime stores a JSON-text envelope, so the
 * ref string's UTF-8 bytes are what get sealed. The `SealedMetadata` object is
 * carried in `ciphertext`; the surrounding `EncryptedPayloadEnvelope` supplies
 * the identity fields `validEnvelope` checks before any decryption happens.
 */
export class ResultRefPayloadCodec implements PayloadMigrationCodec {
  constructor(private readonly sealer: ResultRefSealer) {}

  async encrypt(
    plaintext: Uint8Array,
    context: PayloadCryptoContext,
  ): Promise<EncryptedPayloadEnvelope> {
    const sealed = await this.sealer.seal(
      Buffer.from(plaintext).toString('utf8'),
      sealContextFor(context),
    );
    return {
      formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION,
      tenantId: context.tenantId,
      payloadId: context.payloadId,
      payloadKind: context.payloadKind,
      objectVersion: context.objectVersion,
      plaintextSizeBytes: plaintext.byteLength,
      plaintextSha256: digest(plaintext),
      ciphertext: sealed,
    };
  }

  async decrypt(
    envelope: EncryptedPayloadEnvelope,
    context: PayloadCryptoContext,
  ): Promise<Uint8Array> {
    const opened = await this.sealer.open(envelope.ciphertext, sealContextFor(context));
    return Buffer.from(typeof opened === 'string' ? opened : String(opened), 'utf8');
  }
}

function resultRefPayloadId(kind: ResultRefPayloadKind, rowId: string): string {
  return `${kind}:${rowId}`;
}

function parseResultRefPayloadId(payloadId: string): { kind: ResultRefPayloadKind; rowId: string } {
  const sep = payloadId.indexOf(':');
  const kind = payloadId.slice(0, sep);
  const rowId = payloadId.slice(sep + 1);
  if (sep < 1 || rowId.length === 0 || !isResultRefPayloadKind(kind)) {
    throw new Error('invalid result_ref payload id');
  }
  return { kind, rowId };
}

function resultRefSql(kind: ResultRefPayloadKind, body: string): string {
  const operations = kind === 'operations.result_ref';
  return body
    .replace(/\{table}/g, operations ? 'operations' : 'tasks')
    .replace(/\{alias}/g, operations ? 'o' : 't')
    // `tasks` has NO tenant_id column (0001:66-89); its tenant comes from the
    // joined operations row in BOTH families, so this is deliberately `o.`
    // and not `{alias}.`.
    .replace(/\{tenant}/g, 'o.tenant_id')
    .replace(/\{join}/g, operations ? '' : 'JOIN operations o ON o.id = t.operation_id')
    .replace(/\{lock}/g, operations ? 'FOR UPDATE' : 'FOR UPDATE OF t');
}

/** The SQL that reads one row of a `result_ref` family, with its tenant. */
function selectOneSql(kind: ResultRefPayloadKind): string {
  return resultRefSql(kind,
    'SELECT {alias}.id, {tenant} AS tenant_id, {alias}.result_ref AS result_ref, {alias}.updated_at AS updated_at '
    + 'FROM {table} {alias} {join} WHERE {alias}.result_ref IS NOT NULL AND {alias}.id = $1 {lock}');
}

/** All non-null `result_ref` row ids for a family (tenant not needed to list). */
function listIdsSql(kind: ResultRefPayloadKind): string {
  return resultRefSql(kind,
    'SELECT {alias}.id AS id, {tenant} AS tenant_id, {alias}.result_ref AS result_ref, '
    + '{alias}.updated_at AS updated_at FROM {table} {alias} {join} '
    + 'WHERE {alias}.result_ref IS NOT NULL');
}

interface ResultRefRow {
  id: string;
  tenant_id: string;
  result_ref: string;
  updated_at: Date | string;
}

export interface ResultRefPgMigrationStoreOptions {
  readonly db: Db;
  readonly sealer: ResultRefSealer;
  /**
   * The bounded dual-read window the run is executing inside. When supplied,
   * `withPayloadLocked` refuses to start once the window has closed, so a
   * stuck or resumed run cannot keep mutating rows after the ENC-09 window
   * (`MAX_DUAL_READ_WINDOW_MS`, 14 days) has expired.
   */
  readonly window?: BoundedDualReadWindow;
}

/**
 * The PG-backed `PayloadMigrationStore` for both `result_ref` columns.
 *
 * Identity: `payloadId` is `"<kind>:<rowId>"`. Locking is `SELECT ... FOR
 * UPDATE` inside one `db.tx`, and the commit is optimistic on `updated_at` (the
 * `objectVersion`) — a row that changed under us yields 0 rows and is reported
 * as `MIGRATION_COMMIT_CONFLICT`, never a blind overwrite.
 *
 * Note on the encrypted path: unlike the S3/artifact families, this column
 * retains NO separate plaintext copy — after sealing the ref exists only inside
 * the envelope. So the store opens the envelope once to populate `plaintext`,
 * `expectedSizeBytes` and `expectedSha256`, which the framework needs for both
 * its encrypted-path integrity check and `restoreLegacyPayload`. The legacy
 * bytes are therefore still retained, just encrypted rather than duplicated.
 */
export class ResultRefPgMigrationStore implements PayloadMigrationStore {
  constructor(private readonly options: ResultRefPgMigrationStoreOptions) {}

  private get db(): Db { return this.options.db; }

  private async allRows(): Promise<readonly { kind: ResultRefPayloadKind; row: ResultRefRow }[]> {
    const out: { kind: ResultRefPayloadKind; row: ResultRefRow }[] = [];
    for (const kind of RESULT_REF_PAYLOAD_KINDS) {
      const res = await this.db.query(listIdsSql(kind));
      for (const row of res.rows as unknown as ResultRefRow[]) {
        out.push({ kind, row });
      }
    }
    return out;
  }

  async inventory(): Promise<PayloadMigrationCounts> {
    let plaintextPayloads = 0;
    let encryptedPayloads = 0;
    let unresolvedPayloads = 0;
    let unresolvedReferences = 0;
    for (const { kind, row } of await this.allRows()) {
      const payload = await resultRefToLockedPayload(this.options.sealer, row, kind);
      if (payload.classification === 'plaintext') plaintextPayloads += 1;
      else if (payload.classification === 'encrypted') encryptedPayloads += 1;
      else unresolvedPayloads += 1;
      if (payload.classification !== 'encrypted') {
        unresolvedReferences += Math.max(1, payload.referenceCount);
      }
    }
    return { plaintextPayloads, encryptedPayloads, unresolvedPayloads, unresolvedReferences };
  }

  async listPayloadIds(): Promise<readonly string[]> {
    const rows = await this.allRows();
    return rows.map(({ kind, row }) => resultRefPayloadId(kind, row.id));
  }

  async withPayloadLocked<T>(
    payloadId: string,
    action: (
      payload: LockedLegacyPayload | null,
      commit: (envelope: EncryptedPayloadEnvelope) => Promise<boolean>,
      restore: () => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T> {
    const { kind, rowId } = parseResultRefPayloadId(payloadId);
    this.assertWindowOpen();
    return this.db.tx(async (client) => {
      const res = await client.query(selectOneSql(kind), [rowId]);
      const row = res.rows[0] as ResultRefRow | undefined;
      const payload = row ? await resultRefToLockedPayload(this.options.sealer, row, kind) : null;
      const commit = async (envelope: EncryptedPayloadEnvelope): Promise<boolean> => {
        if (!row) return false;
        const stored = JSON.stringify(envelope.ciphertext);
        const updated = await client.query(this.updateSql(kind), [rowId, stored, row.updated_at]);
        return updated.rowCount === 1;
      };
      const restore = async (): Promise<boolean> => {
        if (!row || !payload?.plaintext) return false;
        const original = Buffer.from(payload.plaintext).toString('utf8');
        const restored = await client.query(this.restoreSql(kind), [rowId, original, row.result_ref]);
        return restored.rowCount === 1;
      };
      return action(payload, commit, restore);
    });
  }

  /** True when a bounded window was supplied and it has not yet expired. */
  windowOpen(nowMs = Date.now()): boolean {
    return this.options.window ? this.options.window.allowsLegacyRead(nowMs) : true;
  }

  private assertWindowOpen(nowMs = Date.now()): void {
    if (!this.windowOpen(nowMs)) {
      throw new Error('bounded dual-read window is closed; refusing result_ref backfill');
    }
  }

  private updateSql(kind: ResultRefPayloadKind): string {
    return resultRefSql(kind,
      'UPDATE {table} SET result_ref = $2, updated_at = now() '
      + 'WHERE id = $1 AND updated_at = $3');
  }

  private restoreSql(kind: ResultRefPayloadKind): string {
    return resultRefSql(kind,
      'UPDATE {table} SET result_ref = $2, updated_at = now() '
      + 'WHERE id = $1 AND result_ref = $3');
  }

}

/* --------------------------------------------------------------------------- */
/* CONTROL-PLANE-825 — all 8 control-plane slots in one PG store                */
/* --------------------------------------------------------------------------- */

/**
 * The 8 control-plane slots, with the exact SQL the auth counter uses.
 *
 * Mirrors `METADATA_AUTH_SLOT_SPECS` in metadata-auth-counter.ts one-for-one
 * (same table, alias, tenant expression, refId expression, column, kind).
 * Duplicated rather than imported so this module keeps its no-runtime-import
 * rule; the parity is asserted in tests, not assumed.
 */
/** The 8 control-plane slot names, exactly the METADATA_SLOTS set. */
export type ControlPlaneSlotKind =
  | 'operations.input_ref'
  | 'tasks.payload_ref'
  | 'human_waits.response_ref'
  | 'step_checkpoints.output_ref'
  | 'step_checkpoints.session_ref'
  | 'operations.prompt_overrides_ref'
  | 'tasks.result_ref'
  | 'operations.result_ref';

export interface ControlPlaneSlotSpec {
  readonly slot: ControlPlaneSlotKind;
  readonly table: string;
  readonly alias: string;
  readonly column: string;
  readonly kind: 'jsonb' | 'text';
  readonly tenantExpr: string;
  readonly refIdExpr: string;
  readonly join: string;
  readonly lock: string;
  /** Row-key predicate for the single-row lock, with $1..$n placeholders. */
  readonly keySql: string;
}

export const CONTROL_PLANE_SLOT_SPECS: readonly ControlPlaneSlotSpec[] = [
  { slot: 'operations.input_ref', table: 'operations', alias: 'operations', column: 'input_ref', kind: 'jsonb', tenantExpr: 'tenant_id', refIdExpr: 'id', join: '', lock: 'FOR UPDATE', keySql: 'id = $1' },
  { slot: 'tasks.payload_ref', table: 'tasks', alias: 't', column: 'payload_ref', kind: 'jsonb', tenantExpr: 'o.tenant_id', refIdExpr: 't.id', join: 'JOIN operations o ON o.id = t.operation_id', lock: 'FOR UPDATE OF t', keySql: 't.id = $1' },
  { slot: 'human_waits.response_ref', table: 'human_waits', alias: 'w', column: 'response_ref', kind: 'jsonb', tenantExpr: 'o.tenant_id', refIdExpr: 'w.wait_id', join: 'JOIN operations o ON o.id = w.operation_id', lock: 'FOR UPDATE OF w', keySql: 'w.wait_id = $1' },
  { slot: 'step_checkpoints.output_ref', table: 'step_checkpoints', alias: 'sc', column: 'output_ref', kind: 'text', tenantExpr: 'o.tenant_id', refIdExpr: "sc.task_id || ':' || sc.step_key", join: 'JOIN tasks t ON t.id = sc.task_id JOIN operations o ON o.id = t.operation_id', lock: 'FOR UPDATE OF sc', keySql: 'sc.task_id = $1 AND sc.step_key = $2' },
  { slot: 'step_checkpoints.session_ref', table: 'step_checkpoints', alias: 'sc', column: 'session_ref', kind: 'jsonb', tenantExpr: 'o.tenant_id', refIdExpr: "sc.task_id || ':' || sc.step_key || ':' || sc.generation", join: 'JOIN tasks t ON t.id = sc.task_id JOIN operations o ON o.id = t.operation_id', lock: 'FOR UPDATE OF sc', keySql: 'sc.task_id = $1 AND sc.step_key = $2 AND sc.generation = $3' },
  { slot: 'operations.prompt_overrides_ref', table: 'operations', alias: 'operations', column: 'prompt_overrides_ref', kind: 'jsonb', tenantExpr: 'tenant_id', refIdExpr: 'id', join: '', lock: 'FOR UPDATE', keySql: 'id = $1' },
  { slot: 'tasks.result_ref', table: 'tasks', alias: 't', column: 'result_ref', kind: 'text', tenantExpr: 'o.tenant_id', refIdExpr: 't.id', join: 'JOIN operations o ON o.id = t.operation_id', lock: 'FOR UPDATE OF t', keySql: 't.id = $1' },
  { slot: 'operations.result_ref', table: 'operations', alias: 'operations', column: 'result_ref', kind: 'text', tenantExpr: 'tenant_id', refIdExpr: 'id', join: '', lock: 'FOR UPDATE', keySql: 'id = $1' },
] as const;

export function isControlPlaneSlot(value: unknown): value is ControlPlaneSlotKind {
  return typeof value === 'string'
    && (CONTROL_PLANE_SLOT_SPECS as readonly { slot: string }[]).some((spec) => spec.slot === value);
}

/** The seal binding for one control-plane row: slot === payloadKind, refId is the
 * row key the writer binds on (see the spec table). */
export interface ControlPlaneSealContext {
  readonly tenantId: string;
  readonly slot: ControlPlaneSlotKind;
  readonly refId: string;
}

/** The slice of the metadata seal seam this store needs, declared structurally. */
export interface ControlPlaneSealer {
  seal(value: unknown, context: ControlPlaneSealContext): Promise<Record<string, unknown>>;
  open(sealed: unknown, context: ControlPlaneSealContext): Promise<unknown>;
  isSealed(value: unknown): boolean;
}

function controlPlaneSlotFromKind(kind: Enc09PayloadKind): ControlPlaneSlotKind {
  if (!isControlPlaneSlot(kind)) {
    throw new Error(`control-plane codec cannot handle payload kind ${String(kind)}`);
  }
  return kind;
}

/** Bridges the byte-oriented migration codec onto the metadata seal seam. */
export class ControlPlanePayloadCodec implements PayloadMigrationCodec {
  constructor(private readonly sealer: ControlPlaneSealer) {}

  async encrypt(
    plaintext: Uint8Array,
    context: PayloadCryptoContext,
  ): Promise<EncryptedPayloadEnvelope> {
    const slot = controlPlaneSlotFromKind(context.payloadKind);
    const sealed = await this.sealer.seal(
      Buffer.from(plaintext).toString('utf8'),
      { tenantId: context.tenantId, slot, refId: context.payloadId },
    );
    return {
      formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION,
      tenantId: context.tenantId,
      payloadId: context.payloadId,
      payloadKind: context.payloadKind,
      objectVersion: context.objectVersion,
      plaintextSizeBytes: plaintext.byteLength,
      plaintextSha256: digest(plaintext),
      ciphertext: sealed,
    };
  }

  async decrypt(
    envelope: EncryptedPayloadEnvelope,
    context: PayloadCryptoContext,
  ): Promise<Uint8Array> {
    const opened = await this.sealer.open(envelope.ciphertext, {
      tenantId: context.tenantId,
      slot: controlPlaneSlotFromKind(context.payloadKind),
      refId: context.payloadId,
    });
    return Buffer.from(typeof opened === 'string' ? opened : String(opened), 'utf8');
  }
}

interface ControlPlaneRow {
  ref_id: string;
  tenant_id: string;
  value: unknown;
}

export interface ControlPlanePgMigrationStoreOptions {
  readonly db: Db;
  readonly sealer: ControlPlaneSealer;
  /** The bounded dual-read window the run is executing inside. */
  readonly window?: BoundedDualReadWindow;
}

/**
 * The PG-backed `PayloadMigrationStore` for ALL EIGHT control-plane slots.
 *
 * `ResultRefPgMigrationStore` covers only the two TEXT `result_ref` columns and
 * is left untouched; this class is the one the backfill CLI drives, so the run
 * is never limited to result_ref. The row lock is `SELECT ... FOR UPDATE`
 * inside one `db.tx` — the lock is the concurrency guard, so no per-table
 * `updated_at` CAS is needed (and `step_checkpoints` / `human_waits` have no
 * `updated_at` column at all).
 */
export class ControlPlanePgMigrationStore implements PayloadMigrationStore {
  constructor(private readonly options: ControlPlanePgMigrationStoreOptions) {}

  private get db(): Db { return this.options.db; }

  private listSql(spec: ControlPlaneSlotSpec): string {
    return 'SELECT ' + spec.refIdExpr + ' AS ref_id, '
      + spec.tenantExpr + ' AS tenant_id, '
      + spec.alias + '.' + spec.column + ' AS value '
      + 'FROM ' + spec.table + ' ' + spec.alias + ' ' + spec.join
      + ' WHERE ' + spec.alias + '.' + spec.column + ' IS NOT NULL';
  }

  private selectOneSql(spec: ControlPlaneSlotSpec): string {
    return 'SELECT ' + spec.refIdExpr + ' AS ref_id, '
      + spec.tenantExpr + ' AS tenant_id, '
      + spec.alias + '.' + spec.column + ' AS value '
      + 'FROM ' + spec.table + ' ' + spec.alias + ' ' + spec.join
      + ' WHERE ' + spec.alias + '.' + spec.column + ' IS NOT NULL AND ' + spec.keySql
      + ' ' + spec.lock;
  }

  private keyParams(spec: ControlPlaneSlotSpec, refId: string): unknown[] {
    if (spec.slot === 'step_checkpoints.output_ref') {
      const [taskId, stepKey] = refId.split(':');
      return [taskId, stepKey];
    }
    if (spec.slot === 'step_checkpoints.session_ref') {
      const [taskId, stepKey, generation] = refId.split(':');
      return [taskId, stepKey, generation];
    }
    return [refId];
  }

  private async allRows(): Promise<readonly { spec: ControlPlaneSlotSpec; row: ControlPlaneRow }[]> {
    const out: { spec: ControlPlaneSlotSpec; row: ControlPlaneRow }[] = [];
    for (const spec of CONTROL_PLANE_SLOT_SPECS) {
      const res = await this.db.query(this.listSql(spec));
      for (const row of res.rows as unknown as ControlPlaneRow[]) {
        out.push({ spec, row });
      }
    }
    return out;
  }

  async inventory(): Promise<PayloadMigrationCounts> {
    let plaintextPayloads = 0;
    let encryptedPayloads = 0;
    let unresolvedPayloads = 0;
    let unresolvedReferences = 0;
    for (const { spec, row } of await this.allRows()) {
      const payload = await this.toLockedPayload(row, spec);
      if (payload.classification === 'plaintext') plaintextPayloads += 1;
      else if (payload.classification === 'encrypted') encryptedPayloads += 1;
      else unresolvedPayloads += 1;
      if (payload.classification !== 'encrypted') {
        unresolvedReferences += Math.max(1, payload.referenceCount);
      }
    }
    return { plaintextPayloads, encryptedPayloads, unresolvedPayloads, unresolvedReferences };
  }

  async listPayloadIds(): Promise<readonly string[]> {
    const rows = await this.allRows();
    return rows.map(({ spec, row }) => spec.slot + ':' + row.ref_id);
  }

  async withPayloadLocked<T>(
    payloadId: string,
    action: (
      payload: LockedLegacyPayload | null,
      commit: (envelope: EncryptedPayloadEnvelope) => Promise<boolean>,
      restore: () => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T> {
    const sep = payloadId.indexOf(':');
    const slot = payloadId.slice(0, sep);
    const refId = payloadId.slice(sep + 1);
    if (sep < 1 || refId.length === 0 || !isControlPlaneSlot(slot)) {
      throw new Error('invalid control-plane payload id');
    }
    const spec = CONTROL_PLANE_SLOT_SPECS.find((candidate) => candidate.slot === slot);
    if (!spec) throw new Error('unknown control-plane slot ' + slot);
    this.assertWindowOpen();
    return this.db.tx(async (client) => {
      const res = await client.query(this.selectOneSql(spec), this.keyParams(spec, refId));
      const row = res.rows[0] as ControlPlaneRow | undefined;
      const payload = row ? await this.toLockedPayload(row, spec) : null;
      const commit = async (envelope: EncryptedPayloadEnvelope): Promise<boolean> => {
        if (!row) return false;
        const stored = JSON.stringify(envelope.ciphertext);
        const updated = await client.query(
          'UPDATE ' + spec.table + ' ' + spec.alias + ' SET ' + spec.column + ' = $2 '
            + 'WHERE ' + spec.keySql,
          [...this.keyParams(spec, refId), stored],
        );
        return updated.rowCount === 1;
      };
      const restore = async (): Promise<boolean> => {
        if (!row || !payload?.plaintext) return false;
        const original = Buffer.from(payload.plaintext).toString('utf8');
        const restored = await client.query(
          'UPDATE ' + spec.table + ' ' + spec.alias + ' SET ' + spec.column + ' = $2 '
            + 'WHERE ' + spec.keySql,
          [...this.keyParams(spec, refId), original],
        );
        return restored.rowCount === 1;
      };
      return action(payload, commit, restore);
    });
  }

  /** True when a bounded window was supplied and it has not yet expired. */
  windowOpen(nowMs = Date.now()): boolean {
    return this.options.window ? this.options.window.allowsLegacyRead(nowMs) : true;
  }

  private assertWindowOpen(nowMs = Date.now()): void {
    if (!this.windowOpen(nowMs)) {
      throw new Error('bounded dual-read window is closed; refusing control-plane backfill');
    }
  }

  private async toLockedPayload(
    row: ControlPlaneRow,
    spec: ControlPlaneSlotSpec,
  ): Promise<LockedLegacyPayload> {
    // jsonb columns come back parsed; TEXT columns come back as text. Both are
    // normalised to the JSON text the writer binds, so the sealed bytes and the
    // plaintext bytes are the same on either side of the migration.
    const rawText = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
    const objectVersion = new Date().toISOString();
    const base = {
      payloadId: row.ref_id,
      tenantId: row.tenant_id,
      payloadKind: spec.slot,
      storage: 'postgres' as const,
      objectVersion,
      referenceCount: 1,
    };
    const sealContext: ControlPlaneSealContext = {
      tenantId: row.tenant_id,
      slot: spec.slot,
      refId: row.ref_id,
    };
    let stored: unknown;
    try { stored = JSON.parse(rawText); } catch { stored = undefined; }
    if (stored !== undefined && this.options.sealer.isSealed(stored)) {
      let plaintext: Uint8Array;
      try {
        const opened = await this.options.sealer.open(stored, sealContext);
        plaintext = Buffer.from(typeof opened === 'string' ? opened : String(opened), 'utf8');
      } catch {
        return {
          ...base,
          classification: 'unresolved',
          plaintext: null,
          envelope: null,
          expectedSizeBytes: null,
          expectedSha256: null,
        };
      }
      return {
        ...base,
        classification: 'encrypted',
        plaintext,
        envelope: {
          formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION,
          tenantId: row.tenant_id,
          payloadId: row.ref_id,
          payloadKind: spec.slot,
          objectVersion,
          plaintextSizeBytes: plaintext.byteLength,
          plaintextSha256: digest(plaintext),
          ciphertext: stored,
        },
        expectedSizeBytes: plaintext.byteLength,
        expectedSha256: digest(plaintext),
      };
    }
    const plaintext = Buffer.from(rawText, 'utf8');
    return {
      ...base,
      classification: 'plaintext',
      plaintext,
      envelope: null,
      expectedSizeBytes: plaintext.byteLength,
      expectedSha256: digest(plaintext),
    };
  }
}

/**
 * The `result_ref` family payload mapper, lifted out of
 * ResultRefPgMigrationStore so the CONTROL-PLANE-825 block can sit at module
 * level. Behaviour is unchanged.
 */
async function resultRefToLockedPayload(
  sealer: ResultRefSealer,
  row: ResultRefRow,
  kind: ResultRefPayloadKind,
): Promise<LockedLegacyPayload> {
    const objectVersion = new Date(row.updated_at).toISOString();
    // `payloadId` here is the ROW id, not the composite address used by
    // `withPayloadLocked`. The framework feeds it straight into the crypto
    // context as `refId`, and the runtime writer/readers bind on the row id — a
    // composite refId would seal envelopes no reader could ever open.
    const base = {
      payloadId: row.id,
      tenantId: row.tenant_id,
      payloadKind: kind,
      storage: 'postgres' as const,
      objectVersion,
      referenceCount: 1,
    };
    const sealContext: ResultRefSealContext = { tenantId: row.tenant_id, slot: kind, refId: row.id };
    let stored: unknown;
    try { stored = JSON.parse(row.result_ref); } catch { stored = undefined; }
    if (stored !== undefined && sealer.isSealed(stored)) {
      let plaintext: Uint8Array;
      try {
        const opened = await sealer.open(stored, sealContext);
        plaintext = Buffer.from(typeof opened === 'string' ? opened : String(opened), 'utf8');
      } catch {
        // Sealed under another binding, or tampered: flag it so it BLOCKS the
        // flip instead of being silently counted as done.
        return {
          ...base,
          classification: 'unresolved',
          plaintext: null,
          envelope: null,
          expectedSizeBytes: null,
          expectedSha256: null,
        };
      }
      return {
        ...base,
        classification: 'encrypted',
        plaintext,
        envelope: {
          formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION,
          tenantId: row.tenant_id,
          payloadId: row.id,
          payloadKind: kind,
          objectVersion,
          plaintextSizeBytes: plaintext.byteLength,
          plaintextSha256: digest(plaintext),
          ciphertext: stored,
        },
        expectedSizeBytes: plaintext.byteLength,
        expectedSha256: digest(plaintext),
      };
    }
    const plaintext = Buffer.from(row.result_ref, 'utf8');
    return {
      ...base,
      classification: 'plaintext',
      plaintext,
      envelope: null,
      expectedSizeBytes: plaintext.byteLength,
      expectedSha256: digest(plaintext),
    };
}

