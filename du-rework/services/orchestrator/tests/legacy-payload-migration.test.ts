import { createHash } from 'node:crypto';
import {
  backfillLegacyPayloads,
  canRetireLegacyPayloads,
  createBoundedDualReadWindow,
  ENC09_PAYLOAD_KINDS,
  inventoryPlaintextPayloads,
  readDuringBoundedDualRead,
  restoreLegacyPayload,
  verifyKeyRotation,
  type EncryptedPayloadEnvelope,
  type KeyRotationVerifier,
  type LockedLegacyPayload,
  type PayloadCryptoContext,
  type PayloadMigrationCodec,
  type PayloadMigrationCounts,
  type PayloadMigrationStore,
  type RotationWrappedKey,
} from '../src/modules/encryption/legacy-payload-migration';

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function xor(value: Uint8Array): Buffer {
  const result = Buffer.from(value);
  for (let index = 0; index < result.length; index += 1) result[index] = (result[index] ?? 0) ^ 0x5a;
  return result;
}

class FakeCodec implements PayloadMigrationCodec {
  encryptCount = 0;
  envelopeChange: ((envelope: EncryptedPayloadEnvelope) => EncryptedPayloadEnvelope) | null = null;

  async encrypt(plaintext: Uint8Array, context: PayloadCryptoContext): Promise<EncryptedPayloadEnvelope> {
    this.encryptCount += 1;
    const envelope: EncryptedPayloadEnvelope = {
      formatVersion: 1,
      ...context,
      plaintextSizeBytes: plaintext.byteLength,
      plaintextSha256: hash(plaintext),
      ciphertext: xor(plaintext).toString('base64'),
    };
    return this.envelopeChange ? this.envelopeChange(envelope) : envelope;
  }

  async decrypt(envelope: EncryptedPayloadEnvelope, context: PayloadCryptoContext): Promise<Uint8Array> {
    if (envelope.tenantId !== context.tenantId || envelope.payloadId !== context.payloadId
      || envelope.payloadKind !== context.payloadKind || envelope.objectVersion !== context.objectVersion) {
      throw new Error('context mismatch');
    }
    if (typeof envelope.ciphertext !== 'string') throw new Error('invalid ciphertext');
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    return xor(bytes);
  }
}

class MemoryPayloadStore implements PayloadMigrationStore {
  readonly rows = new Map<string, LockedLegacyPayload>();
  commitCount = 0;
  commitAllowed = true;

  async inventory(): Promise<PayloadMigrationCounts> {
    const payloads = [...this.rows.values()];
    const plaintextPayloads = payloads.filter((row) => row.classification === 'plaintext').length;
    const encryptedPayloads = payloads.filter((row) => row.classification === 'encrypted').length;
    const unresolvedPayloads = payloads.filter((row) => row.classification === 'unresolved').length;
    const unresolvedReferences = payloads.reduce((count, row) => row.classification === 'encrypted'
      ? count
      : count + Math.max(1, row.referenceCount), 0);
    return { plaintextPayloads, encryptedPayloads, unresolvedPayloads, unresolvedReferences };
  }

  async listPayloadIds(): Promise<readonly string[]> {
    return [...this.rows.keys()];
  }

  async withPayloadLocked<T>(
    payloadId: string,
    action: (
      payload: LockedLegacyPayload | null,
      commit: (envelope: EncryptedPayloadEnvelope) => Promise<boolean>,
      restore: () => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T> {
    const record = this.rows.get(payloadId) ?? null;
    return action(record, async (envelope) => {
      if (!record || !this.commitAllowed || record.classification !== 'plaintext') return false;
      this.commitCount += 1;
      this.rows.set(payloadId, { ...record, classification: 'encrypted', envelope });
      return true;
    }, async () => {
      if (!record || !this.commitAllowed || record.classification !== 'encrypted') return false;
      this.rows.set(payloadId, { ...record, classification: 'plaintext' });
      return true;
    });
  }
}

function legacyRow(payloadId: string, plaintext: Buffer, overrides: Partial<LockedLegacyPayload> = {}): LockedLegacyPayload {
  return {
    payloadId,
    tenantId: 'tenant-a',
    payloadKind: 'task_payload',
    storage: 'postgres',
    objectVersion: 'row-v7',
    classification: 'plaintext',
    plaintext: Buffer.from(plaintext),
    envelope: null,
    expectedSizeBytes: plaintext.byteLength,
    expectedSha256: hash(plaintext),
    referenceCount: 1,
    ...overrides,
  };
}

describe('ENC-09 plaintext inventory and migration', () => {
  test('inventories source metadata without returning payload contents and blocks retirement', async () => {
    const report = await inventoryPlaintextPayloads([
      {
        name: 'postgres-control',
        covers: ['operation_input', 'task_payload', 'child_payload', 'hitl_response', 'control_metadata', 'outbox_payload', 'checkpoint'],
        async scan() {
          return [
            {
              payloadId: 'task-1', tenantId: 'tenant-a', payloadKind: 'task_payload', storage: 'postgres',
              objectVersion: 'row-v3', classification: 'plaintext', sizeBytes: 12, sha256: 'a'.repeat(64), referenceCount: 2,
            },
            {
              payloadId: 'task-2', tenantId: 'tenant-a', payloadKind: 'task_payload', storage: 'postgres',
              objectVersion: null, classification: 'plaintext', sizeBytes: 8, sha256: 'b'.repeat(64), referenceCount: 1,
            },
          ];
        },
      },
      {
        name: 's3-artifacts',
        covers: ['artifact'],
        async scan() {
          return [{
            payloadId: 'artifact-1', tenantId: 'tenant-b', payloadKind: 'artifact', storage: 's3',
            objectVersion: 's3-version-9', classification: 'encrypted', sizeBytes: 100, sha256: 'c'.repeat(64), referenceCount: 1,
          }];
        },
      },
    ], new Date('2026-09-28T00:00:00.000Z'));

    expect(report).toMatchObject({
      scannedRecords: 3,
      plaintextPayloads: 1,
      encryptedPayloads: 1,
      unresolvedPayloads: 1,
      unresolvedReferences: 4,
      legacyDeletionAllowed: false,
    });
    expect(report.coveredKinds).toEqual(ENC09_PAYLOAD_KINDS);
    expect(report.uncoveredKinds).toEqual([]);
    expect(report.issues).toEqual([{ source: 'postgres-control', payloadId: 'task-2', code: 'INVALID_METADATA' }]);
    expect(report.entries[0]).not.toHaveProperty('bytes');
    expect(JSON.stringify(report)).not.toContain('sensitive payload body');
    expect(canRetireLegacyPayloads({ unresolvedReferences: 0 }, false)).toBe(false);
    expect(canRetireLegacyPayloads({ unresolvedReferences: 1 }, true)).toBe(false);
    expect(canRetireLegacyPayloads({ unresolvedReferences: 0 }, true)).toBe(true);
  });

  test('backfills with authenticated readback and retries idempotently while retaining legacy bytes', async () => {
    const source = Buffer.from('legacy task payload');
    const store = new MemoryPayloadStore();
    store.rows.set('task-1', legacyRow('task-1', source));
    const codec = new FakeCodec();

    const first = await backfillLegacyPayloads(store, codec);
    expect(first).toMatchObject({
      state: 'complete', scannedPayloads: 1, migratedPayloads: 1, failedPayloads: 0,
      unresolvedReferences: 0, legacySourcesRetained: true, legacyDeletionAllowed: false,
    });
    expect(store.rows.get('task-1')?.plaintext).toEqual(source);
    expect(store.rows.get('task-1')?.envelope).toMatchObject({
      tenantId: 'tenant-a', payloadId: 'task-1', objectVersion: 'row-v7',
      plaintextSizeBytes: source.byteLength, plaintextSha256: hash(source),
    });

    const retry = await backfillLegacyPayloads(store, codec);
    expect(retry).toMatchObject({ state: 'complete', scannedPayloads: 1, migratedPayloads: 0, verifiedPayloads: 1 });
    expect(codec.encryptCount).toBe(1);
    expect(store.commitCount).toBe(1);

    const restored = await restoreLegacyPayload(store, codec, 'task-1');
    expect(restored).toEqual({ state: 'restored' });
    expect(store.rows.get('task-1')?.classification).toBe('plaintext');
    expect(store.rows.get('task-1')?.envelope).toBeDefined();
    expect(await restoreLegacyPayload(store, codec, 'task-1')).toEqual({ state: 'already_legacy' });
  });

  test.each([
    ['source hash mismatch', (row: LockedLegacyPayload) => ({ ...row, expectedSha256: '0'.repeat(64) }), 'SOURCE_INTEGRITY_MISMATCH'],
    ['source size mismatch', (row: LockedLegacyPayload) => ({
      ...row, expectedSizeBytes: (row.expectedSizeBytes ?? 0) + 1,
    }), 'SOURCE_INTEGRITY_MISMATCH'],
    ['version missing', (row: LockedLegacyPayload) => ({ ...row, objectVersion: null }), 'SOURCE_METADATA_MISSING'],
  ])('rejects %s without committing a pointer', async (_caseName, change, expectedCode) => {
    const store = new MemoryPayloadStore();
    store.rows.set('task-1', change(legacyRow('task-1', Buffer.from('payload'))));
    const result = await backfillLegacyPayloads(store, new FakeCodec());
    expect(result).toMatchObject({ state: 'incomplete', failedPayloads: 1, migratedPayloads: 0 });
    expect(result.issues).toEqual([{ payloadId: 'task-1', code: expectedCode }]);
    expect(store.commitCount).toBe(0);
  });

  test('validates an optimistic migration commit and rejects ciphertext metadata bound to another version', async () => {
    const store = new MemoryPayloadStore();
    store.rows.set('task-1', legacyRow('task-1', Buffer.from('payload')));
    store.commitAllowed = false;
    const conflict = await backfillLegacyPayloads(store, new FakeCodec());
    expect(conflict.issues).toEqual([{ payloadId: 'task-1', code: 'MIGRATION_COMMIT_CONFLICT' }]);

    const mismatchedCodec = new FakeCodec();
    mismatchedCodec.envelopeChange = (envelope) => ({ ...envelope, objectVersion: 'row-v8' });
    const invalidEnvelope = await backfillLegacyPayloads(store, mismatchedCodec);
    expect(invalidEnvelope.issues).toEqual([{ payloadId: 'task-1', code: 'ENCRYPTED_ENVELOPE_INVALID' }]);
    expect(store.rows.get('task-1')?.classification).toBe('plaintext');

    const wrongSizeCodec = new FakeCodec();
    wrongSizeCodec.envelopeChange = (envelope) => ({ ...envelope, plaintextSizeBytes: envelope.plaintextSizeBytes + 1 });
    const invalidSize = await backfillLegacyPayloads(store, wrongSizeCodec);
    expect(invalidSize.issues).toEqual([{ payloadId: 'task-1', code: 'ENCRYPTED_ENVELOPE_INVALID' }]);
  });

  test('refuses to replay an encrypted envelope under another tenant', async () => {
    const bytes = Buffer.from('tenant-bound payload');
    const codec = new FakeCodec();
    const context: PayloadCryptoContext = {
      tenantId: 'tenant-a', payloadId: 'task-1', payloadKind: 'task_payload', objectVersion: 'row-v7',
    };
    const encrypted = await codec.encrypt(bytes, context);
    const store = new MemoryPayloadStore();
    store.rows.set('task-1', legacyRow('task-1', bytes, {
      tenantId: 'tenant-b',
      classification: 'encrypted',
      plaintext: Buffer.from(bytes),
      envelope: encrypted,
    }));

    const result = await backfillLegacyPayloads(store, codec);
    expect(result.issues).toEqual([{ payloadId: 'task-1', code: 'ENCRYPTED_ENVELOPE_INVALID' }]);
    expect(result.state).toBe('incomplete');
  });
});

describe('ENC-09 bounded dual read and key rotation verification', () => {
  test('allows legacy reads only during the inclusive-start, exclusive-expiry window', async () => {
    const window = createBoundedDualReadWindow(1_000, 2_000);
    const calls: string[] = [];
    const read = (nowMs: number, encrypted = false) => readDuringBoundedDualRead({
      value: encrypted ? 'ciphertext' : 'legacy',
      isEncrypted: (value) => value === 'ciphertext',
      async readEncrypted(value) { calls.push(`encrypted:${value}`); return 'opened'; },
      async readLegacy(value) { calls.push(`legacy:${value}`); return value; },
      window,
      nowMs,
    });

    await expect(read(999)).rejects.toThrow(/outside/i);
    await expect(read(1_000)).resolves.toBe('legacy');
    await expect(read(1_999)).resolves.toBe('legacy');
    await expect(read(2_000)).rejects.toThrow(/outside/i);
    await expect(read(0, true)).resolves.toBe('opened');
    expect(calls).toEqual(['legacy:legacy', 'legacy:legacy', 'encrypted:ciphertext']);
    expect(() => createBoundedDualReadWindow(0, 14 * 24 * 60 * 60 * 1000 + 1)).toThrow(/14 days/i);
  });

  test('proves rewrap keeps the same DEK and payload, tenant, version, size, and hash', async () => {
    const plaintext = Buffer.from('rotation fixture');
    const oldWrap: RotationWrappedKey = { keyRef: 'vault-key', keyVersion: 1, ciphertext: 'wrapped-v1' };
    const verifier: KeyRotationVerifier = {
      async rewrap(wrapped, targetKeyVersion) {
        return { ...wrapped, keyVersion: targetKeyVersion, ciphertext: `wrapped-v${targetKeyVersion}` };
      },
      async unwrap(wrapped) {
        return Buffer.alloc(32, wrapped.keyRef.length);
      },
      async readPayload(_wrapped, context) {
        return { plaintext: Buffer.from(plaintext), tenantId: context.tenantId, objectVersion: context.objectVersion };
      },
    };

    await expect(verifyKeyRotation({
      verifier,
      wrapped: oldWrap,
      targetKeyVersion: 2,
      tenantId: 'tenant-a',
      objectVersion: 'object-v4',
      expectedSizeBytes: plaintext.byteLength,
      expectedSha256: hash(plaintext),
    })).resolves.toMatchObject({
      keyRef: 'vault-key', previousKeyVersion: 1, targetKeyVersion: 2,
      payloadSizeBytes: plaintext.byteLength, tenantId: 'tenant-a', objectVersion: 'object-v4', verified: true,
    });

    await expect(verifyKeyRotation({
      verifier: { ...verifier, async readPayload() {
        return { plaintext: Buffer.from(plaintext), tenantId: 'tenant-b', objectVersion: 'object-v4' };
      } },
      wrapped: oldWrap,
      targetKeyVersion: 2,
      tenantId: 'tenant-a',
      objectVersion: 'object-v4',
      expectedSizeBytes: plaintext.byteLength,
      expectedSha256: hash(plaintext),
    })).rejects.toThrow(/verification failed/i);
  });
});
