/**
 * ENC-META-01 - control-plane metadata must not rest as plaintext.
 *
 * Production seam under test: src/modules/runtime/metadata-crypto.ts plus the
 * runtime call sites that persist or read a control-plane JSON column
 * (operations.input_ref, tasks.payload_ref, human_waits.response_ref,
 * step_checkpoints.output_ref).
 *
 * Pinned here, in the order the packet asks for:
 *  1. INVENTORY - a sealed column holds no plaintext (byte scan for a
 *     sentinel that is present in the original value).
 *  2. BINDING - an envelope is bound to (tenant, slot, row); opening it
 *     under any other context fails instead of returning the plaintext.
 *  3. FENCE - Vault outage and wrong key both fail closed, never plaintext.
 *  4. SEMANTICS - content hashing stays stable, so idempotency keys and the
 *     replay fence keep working once the column is sealed.
 *
 * The key provider is a REAL transform, not an echo: wrapDek applies a keyed
 * keystream and unwrapDek removes it. An echo provider would make a broken
 * AAD binding look authenticated, which is exactly the negative this file
 * exists to pin. It is a test double for Vault Transit, so its own security
 * is irrelevant - only reversibility and wrong-key behaviour matter.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { contentHash } from '@du/contracts';
import {
  createMetadataCrypto,
  canonicalizeMetadataJson,
  metadataPlaintextHash,
  MetadataCryptoError,
  METADATA_SLOTS,
  type MetadataKeyProvider,
  type MetadataContext,
  type MetadataWrappedDek,
} from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import { decryptStoredArtifact } from '../src/modules/encryption/artifact-read-decrypt';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import { sealSubmitMetadata, markIngestionReadyOn } from '../src/modules/operations/submission';

const KEY_REF = 'du-orch-metadata-v1';
const SENTINEL = 'CONFIDENTIAL-TENANT-DOC-BODY-7f3a91';

/** Deterministic keystream stand-in for the Transit key material. */
const HASH = String.fromCharCode(35);

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'offline-transit-double').update(seed + ':' + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}

function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  }
  return out;
}

interface ProviderOptions {
  failWrap?: boolean;
  failUnwrap?: boolean;
  wrongKey?: boolean;
}

interface TestProvider {
  readonly provider: MetadataKeyProvider;
  readonly stats: { wraps: number; unwraps: number };
}

function makeProvider(options: ProviderOptions = {}): TestProvider {
  const stats = { wraps: 0, unwraps: 0 };
  const provider: MetadataKeyProvider = {
    async wrapDek(dek: Buffer, keyRef: string, keyVersion?: number): Promise<MetadataWrappedDek> {
      stats.wraps += 1;
      if (options.failWrap) throw new Error('vault transit unavailable');
      const version = keyVersion ?? 1;
      const stream = keystream(keyRef + HASH + version, dek.length);
      return {
        version: 1,
        keyName: keyRef,
        keyVersion: version,
        wrappedKey: xor(dek, stream).toString('base64'),
      };
    },
    async unwrapDek(wrapped: MetadataWrappedDek): Promise<Buffer> {
      stats.unwraps += 1;
      if (options.failUnwrap) throw new Error('vault transit 403');
      const raw = Buffer.from(wrapped.wrappedKey, 'base64');
      if (options.wrongKey) return randomBytes(32);
      return xor(raw, keystream(wrapped.keyName + HASH + wrapped.keyVersion, raw.length));
    },
  };
  return { provider, stats };
}

const CTX: MetadataContext = { tenantId: 'tenant-a', slot: 'tasks.payload_ref', refId: 'task-1' };
const TENANT = 'tenant-cr28';
const OPERATION_ID = 'op-cr28-1';
const TASK_ID = 'task-cr28-1';
const SENSITIVE = { document: SENTINEL, pages: 12, nested: { secret: SENTINEL } };

/** Build the seam and hand back the provider call counters. */
function makeCrypto(options: ProviderOptions = {}): {
  crypto: ReturnType<typeof createMetadataCrypto>;
  stats: { wraps: number; unwraps: number };
} {
  const { provider, stats } = makeProvider(options);
  return { crypto: createMetadataCrypto(provider, KEY_REF), stats };
}

function expectCryptoError(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  return expect(fn()).rejects.toMatchObject({ name: 'MetadataCryptoError', code });
}

describe('ENC-META-01 inventory: a sealed control-plane column holds no plaintext', () => {
  it('the serialized envelope contains neither the sentinel nor a plaintext key', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain('CONFIDENTIAL');
    expect(wire).not.toContain('pages');
  });

  it('no plaintext DEK is persisted beside the ciphertext', async () => {
    const { crypto, stats } = makeCrypto();
    const dek = randomBytes(32);
    const sealed = await crypto.seal({ body: dek }, CTX);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain(dek.toString('hex'));
    expect(sealed.dek.wrappedKey).not.toEqual(dek.toString('base64'));
    expect(stats.wraps).toBe(1);
  });

  it('sealing is non-deterministic while the content hash stays stable', async () => {
    const crypto = makeCrypto().crypto;
    const a = await crypto.seal(SENSITIVE, CTX);
    const b = await crypto.seal(SENSITIVE, CTX);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.plaintextSha256).toEqual(b.plaintextSha256);
  });
});

describe('ENC-META-01 binding: an envelope opens only under its own context', () => {
  it('round-trips the original value under the bound context', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    expect(await crypto.open(sealed, CTX)).toEqual(SENSITIVE);
  });

  it('refuses a different TENANT (cross-tenant negative)', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open(sealed, { ...CTX, tenantId: 'tenant-b' }), 'CONTEXT_MISMATCH');
  });

  it('refuses a different SLOT (payload_ref cannot move to input_ref)', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(
      () => crypto.open(sealed, { ...CTX, slot: 'operations.input_ref' }),
      'CONTEXT_MISMATCH',
    );
  });

  it('refuses a different ROW (same tenant and slot, other task)', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open(sealed, { ...CTX, refId: 'task-2' }), 'CONTEXT_MISMATCH');
  });

  it('a tampered ciphertext fails authentication instead of returning junk', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    const raw = Buffer.from(sealed.ciphertext, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    await expectCryptoError(
      () => crypto.open({ ...sealed, ciphertext: raw.toString('base64') }, CTX),
      'AUTHENTICATION_FAILED',
    );
  });

  it('a wrong DEK from the provider fails authentication, no plaintext fallback', async () => {
    const crypto = makeCrypto({ wrongKey: true }).crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open(sealed, CTX), 'AUTHENTICATION_FAILED');
  });

  it('Vault outage on write fails closed: nothing is stored unsealed', async () => {
    const crypto = makeCrypto({ failWrap: true }).crypto;
    await expectCryptoError(() => crypto.seal(SENSITIVE, CTX), 'KEY_PROVIDER_FAILED');
  });

  it('Vault outage on read fails closed: no plaintext is served', async () => {
    const good = makeCrypto().crypto;
    const sealed = await good.seal(SENSITIVE, CTX);
    const broken = makeCrypto({ failUnwrap: true }).crypto;
    await expectCryptoError(() => broken.open(sealed, CTX), 'KEY_PROVIDER_FAILED');
  });

  it('rejects an unknown envelope version instead of guessing', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open({ ...sealed, version: 99 } as never, CTX), 'NOT_SEALED');
  });

  it('rejects an empty tenant binding rather than sealing under an empty AAD', async () => {
    const crypto = makeCrypto().crypto;
    await expectCryptoError(() => crypto.seal(SENSITIVE, { ...CTX, tenantId: '' }), 'INVALID_INPUT');
  });
});

describe('ENC-META-01 legacy rows: readable only behind the backfill flag', () => {
  it('isSealed does not mistake a legacy plaintext object for an envelope', () => {
    const crypto = makeCrypto().crypto;
    expect(crypto.isSealed(SENSITIVE)).toBe(false);
    expect(crypto.isSealed({ version: 1, algorithm: 'aes-256-gcm' })).toBe(false);
  });

  it('readStored fails closed on a plaintext row when the flag is off', async () => {
    const crypto = makeCrypto().crypto;
    await expectCryptoError(() => crypto.readStored(SENSITIVE, CTX, false), 'NOT_SEALED');
  });

  it('readStored passes a legacy row through during the backfill window', async () => {
    const crypto = makeCrypto().crypto;
    expect(await crypto.readStored(SENSITIVE, CTX, true)).toBe(SENSITIVE);
  });

  it('readStored still enforces the binding on a sealed row even with the flag on', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(
      () => crypto.readStored(sealed, { ...CTX, tenantId: 'tenant-b' }, true),
      'CONTEXT_MISMATCH',
    );
  });
});

describe('ENC-META-01 semantics: hashing stays stable so idempotency survives sealing', () => {
  it('key order does not change the hash; array order does', () => {
    expect(metadataPlaintextHash({ b: 1, a: 2 })).toBe(metadataPlaintextHash({ a: 2, b: 1 }));
    expect(metadataPlaintextHash([1, 2])).not.toBe(metadataPlaintextHash([2, 1]));
  });

  it('the sealed plaintextSha256 matches the hash of the original value', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal({ z: 1, a: [1, 2] }, CTX);
    expect(sealed.plaintextSha256).toBe(metadataPlaintextHash({ z: 1, a: [1, 2] }));
  });

  it('canonicalize emits sorted keys so equal documents are byte-equal', () => {
    expect(canonicalizeMetadataJson({ b: 1, a: 2 }).toString('utf8')).toBe('{"a":2,"b":1}');
  });

  it('hashing the raw column would mismatch, which is why the runtime opens first', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    expect(contentHash(sealed)).not.toBe(contentHash(SENSITIVE));
    expect(contentHash(await crypto.open(sealed, CTX))).toBe(contentHash(SENSITIVE));
  });
});

describe('ENC-META-01 slot inventory', () => {
  it('covers the currently declared encrypted metadata columns', () => {
    expect([...METADATA_SLOTS].sort()).toEqual([
      'human_waits.response_ref',
      'operations.input_ref',
      'operations.prompt_overrides_ref',
      'operations.result_ref',
      'step_checkpoints.output_ref',
      'step_checkpoints.session_ref',
      'tasks.payload_ref',
      'tasks.result_ref',
    ]);
  });

  it('refuses to build a crypto seam without a keyRef', () => {
    expect(() => createMetadataCrypto(makeProvider().provider, '')).toThrow(MetadataCryptoError);
  });
});
// CR28-04 — submit-side sealing: operations.input_ref + tasks.payload_ref.
//
// Placed here rather than in a new file because the cross-check that matters
// is exactly this one: an envelope WRITTEN by the submit path must be OPENED
// by the runtime claim path under the same (tenant, slot, row) triple. Two
// copies of the seam would drift silently otherwise.
describe('CR28-04 submit sealing: the writing transaction stores no plaintext input', () => {
  it('an input_ref sealed for the operation opens under the claim binding', async () => {
    const { crypto } = makeCrypto();
    const inputRefJson = JSON.stringify(SENSITIVE);
    // The helper returns the COLUMN value (jsonb text), so this is exactly
    // what a query parameter would carry.
    const column = await sealSubmitMetadata(
      crypto,
      inputRefJson,
      TENANT,
      'operations.input_ref',
      OPERATION_ID
    );
    expect(column).not.toContain(SENTINEL);
    expect(column).not.toContain('CONFIDENTIAL');
    const opened = await crypto.readStored(
      JSON.parse(column),
      { tenantId: TENANT, slot: 'operations.input_ref', refId: OPERATION_ID },
      false
    );
    expect(opened).toBe(inputRefJson);
  });

  it('a payload_ref sealed for the task opens under the claim binding', async () => {
    const { crypto } = makeCrypto();
    const payloadJson = JSON.stringify({ input: SENSITIVE, ingestionState: 'PENDING' });
    const column = await sealSubmitMetadata(crypto, payloadJson, TENANT, 'tasks.payload_ref', TASK_ID);
    expect(column).not.toContain(SENTINEL);
    const opened = await crypto.readStored(
      JSON.parse(column),
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: TASK_ID },
      false
    );
    expect(opened).toBe(payloadJson);
  });

  it('the two columns get DIFFERENT envelopes even for identical content', async () => {
    // The bug this pins: the gate writes one logical envelope to both columns.
    // If a single sealed value were reused, the payload_ref blob would carry
    // the input_ref binding and the task could never be claimed.
    const { crypto } = makeCrypto();
    const same = JSON.stringify(SENSITIVE);
    const opCol = await sealSubmitMetadata(crypto, same, TENANT, 'operations.input_ref', OPERATION_ID);
    const taskCol = await sealSubmitMetadata(crypto, same, TENANT, 'tasks.payload_ref', TASK_ID);
    expect(opCol).not.toBe(taskCol);
    await expect(
      crypto.readStored(
        JSON.parse(opCol),
        { tenantId: TENANT, slot: 'tasks.payload_ref', refId: TASK_ID },
        false
      )
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });

  it('no seam means the value is stored byte-identical (historical behaviour)', async () => {
    const value = JSON.stringify(SENSITIVE);
    const out = await sealSubmitMetadata(undefined, value, TENANT, 'operations.input_ref', OPERATION_ID);
    expect(out).toBe(value);
  });

  it('a provider failure aborts the seal instead of storing plaintext', async () => {
    const { crypto } = makeCrypto({ failWrap: true });
    await expect(
      sealSubmitMetadata(crypto, JSON.stringify(SENSITIVE), TENANT, 'operations.input_ref', OPERATION_ID)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'KEY_PROVIDER_FAILED' });
  });

  it('an envelope from another tenant cannot be opened as this task input', async () => {
    const { crypto } = makeCrypto();
    const column = await sealSubmitMetadata(
      crypto,
      JSON.stringify(SENSITIVE),
      'tenant-b',
      'operations.input_ref',
      OPERATION_ID
    );
    await expect(
      crypto.readStored(
        JSON.parse(column),
        { tenantId: TENANT, slot: 'operations.input_ref', refId: OPERATION_ID },
        false
      )
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });
});

describe('CR28-04 gate sealing: markIngestionReadyOn binds each column to its own row', () => {
  const RECEIPT = {
    storageKey: 'ingest/tenant-cr28/doc.pdf',
    versionId: 'v1',
    sha256: 'b'.repeat(64),
    sizeBytes: 11,
  };
  const DISPATCH = { deliveryId: 'd-1', kind: 'root', correlationId: 'c-1' };

  /** find() under strictNullChecks returns T | undefined; a missing query is a failed assertion, not a crash. */
  function found(seen: GateQuery[], pattern: RegExp): GateQuery {
    const hit = seen.find((q) => pattern.test(q.sql));
    if (!hit) throw new Error(`expected a query matching ${String(pattern)}, saw: ${seen.map((q) => q.sql.slice(0, 40)).join(" | ")}`);
    return hit;
  }
  interface GateQuery {
    sql: string;
    params: unknown[];
  }
  function fakeClient(rows: Record<string, unknown>[]): { client: never; seen: GateQuery[] } {
    const seen: GateQuery[] = [];
    const client = {
      query: async (
        sql: string,
        params?: unknown[]
      ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> => {
        const p = params ?? [];
        seen.push({ sql, params: p });
        if (/SELECT o\.tenant_id/.test(sql)) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 1 };
      },
    };
    return { client: client as never, seen };
  }

  it('seals both gate columns for their own row when a seam is on', async () => {
    const { crypto } = makeCrypto();
    const { client, seen } = fakeClient([{ tenant_id: TENANT, task_id: TASK_ID }]);
    await markIngestionReadyOn(client, OPERATION_ID, RECEIPT, { a: SENTINEL }, DISPATCH, undefined, crypto);

    const sel = found(seen, /SELECT o\.tenant_id/);
    expect(sel).toBeDefined();
    expect(sel.sql).toContain('FOR UPDATE OF o, t');

    const opWrite = found(seen, /UPDATE operations/);
    const taskWrite = found(seen, /UPDATE tasks/);
    const opEnvelope = JSON.parse(String(opWrite.params[1]));
    const taskEnvelope = JSON.parse(String(taskWrite.params[1]));

    expect(String(opWrite.params[1])).not.toContain(SENTINEL);
    expect(String(taskWrite.params[1])).not.toContain(SENTINEL);

    await expect(
      crypto.readStored(opEnvelope, { tenantId: TENANT, slot: 'operations.input_ref', refId: OPERATION_ID }, false)
    ).resolves.toBeDefined();
    await expect(
      crypto.readStored(taskEnvelope, { tenantId: TENANT, slot: 'tasks.payload_ref', refId: TASK_ID }, false)
    ).resolves.toBeDefined();
    await expect(
      crypto.readStored(opEnvelope, { tenantId: TENANT, slot: 'tasks.payload_ref', refId: TASK_ID }, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
    expect(JSON.stringify(opEnvelope)).not.toBe(JSON.stringify(taskEnvelope));
  });

  it('writes the historical plaintext envelope and issues NO extra query without a seam', async () => {
    const { client, seen } = fakeClient([{ tenant_id: TENANT, task_id: TASK_ID }]);
    await markIngestionReadyOn(client, OPERATION_ID, RECEIPT, { a: 1 }, DISPATCH);
    const heads = seen.map((q) => q.sql.replace(/\s+/g, ' ').trim().slice(0, 12));
    expect(heads).toEqual(['UPDATE opera', 'UPDATE tasks', 'INSERT INTO ']);
        // The historical value is the plaintext ingestion envelope: the input
    // spread plus the pinned source. Asserting a field I had not checked is
    // how this test was wrong the first time, so assert the contract shape.
    const historical = JSON.parse(String(found(seen, /UPDATE operations/).params[1]));
    expect(historical.a).toBe(1);
    expect(historical.algorithm).toBeUndefined();
  });

  it('a closed gate writes nothing sealed under a guessed identity', async () => {
    const { crypto } = makeCrypto();
    const { client, seen } = fakeClient([]);
    await markIngestionReadyOn(client, OPERATION_ID, RECEIPT, { a: SENTINEL }, DISPATCH, undefined, crypto);
    const opWrite = found(seen, /UPDATE operations/);
    expect(String(opWrite.params[1])).toContain(SENTINEL);
  });
});

// Delta 61: the seam is reachable from configuration. These cover the piece
// that made the whole control-plane seal unreachable before: the Vault
// `KeyProvider` speaks a DIFFERENT shape from the metadata seam's provider
// (positional args, and a self-describing wrapped DEK), so the translation
// has to be a real adapter rather than a cast.
describe('D61 adapter: Vault KeyProvider -> metadata MetadataKeyProvider', () => {
  function makeVaultProvider() {
    const seen: { keyRef: string; dek: Buffer; keyVersion?: number }[] = [];
    const provider = {
      async wrapDek(input: { keyRef: string; dek: Uint8Array; keyVersion?: number }) {
        seen.push({ keyRef: input.keyRef, dek: Buffer.from(input.dek), ...(input.keyVersion === undefined ? {} : { keyVersion: input.keyVersion }) });
        return {
          keyRef: input.keyRef,
          keyVersion: input.keyVersion ?? 7,
          ciphertext: Buffer.from(input.dek).toString('base64'),
        };
      },
      async unwrapDek(wrapped: { keyRef: string; keyVersion: number; ciphertext: string }) {
        return Buffer.from(wrapped.ciphertext, 'base64');
      },
      async rewrap(wrapped: { keyRef: string; keyVersion: number; ciphertext: string }) {
        return wrapped;
      },
    };
    return { provider, seen };
  }

  it('maps the Vault wrapped DEK onto the self-describing metadata envelope', async () => {
    const { provider } = makeVaultProvider();
    const adapted = adaptKeyProviderForMetadata(provider);
    const wrapped = await adapted.wrapDek(Buffer.alloc(32, 3), 'du-meta-v1');
    expect(wrapped.version).toBe(1);
    // keyName carries the identity the PROVIDER used, not the caller's arg.
    expect(wrapped.keyName).toBe('du-meta-v1');
    expect(wrapped.keyVersion).toBe(7);
    expect(wrapped.wrappedKey).toBe(Buffer.alloc(32, 3).toString('base64'));
  });

  it('forwards a pinned key version instead of dropping it', async () => {
    const { provider, seen } = makeVaultProvider();
    const adapted = adaptKeyProviderForMetadata(provider);
    await adapted.wrapDek(Buffer.alloc(32, 1), 'du-meta-v1', 4);
    expect(seen[0]?.keyVersion).toBe(4);
  });

  it('passes the DEK BYTES, not the keyRef, as the positional first argument', async () => {
    // The failure this pins: Vault takes wrapDek({keyRef, dek}) and the metadata
    // seam takes wrapDek(dek, keyRef, ...). Forwarding the object straight into
    // the positional signature would wrap the wrong value and every envelope
    // would fail to open with no obvious cause.
    const { provider, seen } = makeVaultProvider();
    const adapted = adaptKeyProviderForMetadata(provider);
    const dek = Buffer.alloc(32, 0xab);
    await adapted.wrapDek(dek, 'du-meta-v1');
    expect(seen[0]?.dek.equals(dek)).toBe(true);
    expect(seen[0]?.keyRef).toBe('du-meta-v1');
  });

  it('round-trips a wrapped DEK back through the Vault provider', async () => {
    const { provider } = makeVaultProvider();
    const adapted = adaptKeyProviderForMetadata(provider);
    const wrapped = await adapted.wrapDek(Buffer.alloc(32, 9), 'du-meta-v1');
    const unwrapped = await adapted.unwrapDek(wrapped);
    expect(unwrapped.equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it('produces an envelope the metadata seam can seal and open with', async () => {
    const { provider } = makeVaultProvider();
    const crypto = createMetadataCrypto(adaptKeyProviderForMetadata(provider), 'du-meta-v1');
    const ctx = { tenantId: TENANT, slot: 'operations.input_ref' as const, refId: 'op-1' };
    const sealed = await crypto.seal({ secret: SENTINEL }, ctx);
    expect(JSON.stringify(sealed)).not.toContain(SENTINEL);
    const opened = await crypto.open(sealed, ctx);
    expect(opened).toEqual({ secret: SENTINEL });
  });
});

// Δ72 assessment: how the runtime metadata seam relates to decryptStoredArtifact.
//
// These tests exist to PIN A DELIBERATE DIFFERENCE, not to fix a bug. The two
// seams protect different things and must NOT have the same plaintext policy:
//
//   runtime openMetadata  -> readStored(value, ctx, /* allowPlaintext */ true)
//   decryptStoredArtifact -> readStored(value, ctx, /* allowPlaintext */ false)
//
// The metadata seam tolerates a legacy plaintext row so the backfill window
// (ENC-09) can read rows sealed before the flag was ever turned on. The
// artifact seam is fail-CLOSED because a sealed artifact served as raw bytes
// is the CR28-01 data-loss shape — silently handing a worker ciphertext.
//
// On the property that actually matters for security they are IDENTICAL: a
// sealed value bound to the wrong context/key NEVER returns plaintext, in
// either seam. That is asserted here for both, side by side, so a future
// "simplification" that flips either flag is caught by a test rather than by an
// incident.
describe('Δ72 metadata seam vs decryptStoredArtifact: policy is deliberately different', () => {
  it('the metadata seam TOLERATES a plaintext row during the backfill window', async () => {
    const { crypto } = makeCrypto();
    const legacy = { document: SENTINEL, pages: 12 };
    const opened = await crypto.readStored(legacy, CTX, /* allowPlaintext */ true);
    expect(opened).toEqual(legacy);
  });

  it('the artifact seam REFUSES a plaintext row when the seam is on (fail-closed)', async () => {
    // This is the CR28-01 shape: a deployment with the seam enabled must never
    // serve a stored object it could not authenticate.
    const reader = {
      head: async () => ({ 'du-encrypted': 'aes-256-gcm-v1', artifactid: 'art-1', tenantid: 'tenant-a' }),
      read: async () => Buffer.from('unsealed bytes', 'utf8'),
      readManifest: async () => ({}),
    };
    await expect(
      decryptStoredArtifact({ reader, facade: {} as never }, { artifactId: 'art-1', tenantId: 'tenant-a', storageKey: 'k', uploadToken: 't' }),
    ).rejects.toBeDefined();
  });

  it('BOTH seams fail closed on a sealed value under the WRONG context', async () => {
    // The property that must not drift: an envelope bound elsewhere never
    // yields plaintext, in either seam. The metadata seam tolerating plaintext
    // does NOT extend to tolerating a mis-bound ENVELOPE.
    const { crypto } = makeCrypto();
    const sealed = await crypto.seal(SENSITIVE, { tenantId: 'tenant-a', slot: 'tasks.payload_ref', refId: 'task-1' });
    await expect(
      crypto.readStored(sealed, { tenantId: 'tenant-a', slot: 'tasks.payload_ref', refId: 'task-2' }, true),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
    await expect(
      crypto.readStored(sealed, { tenantId: 'tenant-b', slot: 'tasks.payload_ref', refId: 'task-1' }, true),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });

  it('BOTH seams fail closed on a wrong key, with no plaintext fallback', async () => {
    const { crypto: good } = makeCrypto();
    const sealed = await good.seal(SENSITIVE, CTX);
    const { crypto: bad } = makeCrypto({ failUnwrap: true });
    await expect(
      bad.readStored(sealed, CTX, /* allowPlaintext */ true),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });

  it('includes both encrypted result pointers and the checkpoint session slot', () => {
    expect(METADATA_SLOTS).toContain('tasks.result_ref');
    expect(METADATA_SLOTS).toContain('operations.result_ref');
    expect(METADATA_SLOTS).toContain('step_checkpoints.session_ref' as never);
  });
});

// Δ72 GAP CLOSURE: pin the `openMetadata` allowPlaintext policy PER WINDOW.
//
// In Muc 33 I flipped `openMetadata`'s `readStored(value, ctx, true)` to `false`
// and the whole suite stayed green — because `openMetadata` is module-private
// and every existing test called `crypto.readStored(...)` directly, bypassing
// the wrapper. So the policy that decides whether legacy plaintext rows stay
// readable when the seam is enabled was UNPINNED.
//
// These tests close that by driving the REAL `openMetadata` through the
// exported `createRuntimeService(...).claimTask(...)`, which is the production
// path that reads `input_ref`/`payload_ref` and hands the worker its snapshot.
// No production code is exported or changed to make this possible.
//
// The four windows, in the order a deployment meets them:
//   1. OFF          - no seam configured: everything is plaintext, and must be.
//   2. BACKFILL     - seam ON, row still plaintext from before the flag existed:
//                     MUST still read, or enabling the flag wedges the deployment.
//   3. SEALED       - seam ON, row sealed: opens normally.
//   4. MIS-BOUND    - seam ON, row sealed for a DIFFERENT row: must NOT open.
//
// Window 2 is the one the Muc 33 mutation proved was unprotected.
describe('Δ72 gap closure: openMetadata allowPlaintext, driven through claimTask', () => {
  const TASK_ID = 'task-72-1';
  const OP_ID = 'op-72-1';
  const DELIVERY = 'delivery-72-1';
  const BUSINESS = 'document-core';
  const TENANT72 = 'tenant-72';

  interface Row {
    [key: string]: unknown;
  }

  function res<T>(rows: Row[]): { rows: T[]; rowCount: number | null } {
    return { rows: rows as T[], rowCount: rows.length };
  }

  /**
   * `last_delivery_id` is pre-set to the delivery id, which is the documented
   * idempotent-replay path: claimTask returns the snapshot WITHOUT taking a new
   * lease. That keeps this test on the READ path only, which is the part the
   * policy governs, and off the lease-mutation path, which is not.
   */
  function claimHarness(inputRef: unknown, payloadRef: unknown, crypto?: unknown) {
    const queries: string[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
        if (/FROM tasks t/.test(sql)) return res<Row>([taskRow]);
        if (/SELECT state FROM operations WHERE id=\$1/.test(sql)) {
          return res<Row>([{ state: 'ACCEPTED' }]);
        }
        if (/FROM step_checkpoints WHERE task_id/.test(sql)) return res<Row>([]);
        return res<Row>([]);
      },
    };
    const taskRow: Row = {
      id: TASK_ID,
      operation_id: OP_ID,
      task_key: 'root-1',
      kind: 'root',
      state: 'READY',
      attempt: 1,
      lease_epoch: 3,
      lease_expires_at: '2999-01-01T00:00:00.000Z',
      last_delivery_id: DELIVERY,
      // The two slots under test.
      input_ref: inputRef,
      payload_ref: payloadRef,
      // Everything buildClaimResult reads.
      tenant_id: TENANT72,
      business_id: BUSINESS,
      business_version: '1.0.0',
      action: 'extract',
      manifest_digest: 'sha256:test',
      profile_revision: 0,
      connector_bindings: {},
      cancel_requested: false,
      op_cancel_requested: false,
      op_state: 'ACCEPTED',
      deadline_at: null,
    };
    const db = {
      query: async () => res<Row>([]),
      tx: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> => fn(client),
      close: async () => undefined,
    };
    const runtime = createRuntimeService(
      db as never,
      undefined,
      crypto as never,
    );
    return { runtime, queries };
  }

  const PLAINTEXT_INPUT = { document: 'PLAINTEXT-ROW-tenant-72', pages: 2 };
  const PLAINTEXT_PAYLOAD = { document: 'PLAINTEXT-ROW-tenant-72', pages: 2 };

  it('WINDOW 1 (seam OFF): a plaintext row is returned as-is', async () => {
    const { runtime } = claimHarness(PLAINTEXT_INPUT, PLAINTEXT_PAYLOAD);
    const claimed = await runtime.claimTask(TASK_ID, DELIVERY, 'w-72', BUSINESS);
    expect(claimed.executionSnapshot.resolvedInputRef).toEqual(PLAINTEXT_INPUT);
    expect(claimed.executionSnapshot.payloadRef).toEqual(PLAINTEXT_PAYLOAD);
  });

  it('WINDOW 2 (BACKFILL: seam ON, row still plaintext): the claim SUCCEEDS', async () => {
    // THE regression Muc 33 could not see. A deployment that turns the flag on
    // while legacy rows are still plaintext must keep working; readStored is
    // called with allowPlaintext=true for exactly this. If that flag is ever
    // flipped to false, THIS test goes red instead of the deployment going down.
    const { crypto } = makeCrypto();
    const { runtime } = claimHarness(PLAINTEXT_INPUT, PLAINTEXT_PAYLOAD, crypto);
    const claimed = await runtime.claimTask(TASK_ID, DELIVERY, 'w-72', BUSINESS);
    expect(claimed.executionSnapshot.resolvedInputRef).toEqual(PLAINTEXT_INPUT);
    expect(claimed.executionSnapshot.payloadRef).toEqual(PLAINTEXT_PAYLOAD);
  });

  it('WINDOW 3 (seam ON, row sealed): the claim opens the envelope', async () => {
    const { crypto } = makeCrypto();
    const sealedInput = await crypto.seal(PLAINTEXT_INPUT, {
      tenantId: TENANT72, slot: 'operations.input_ref', refId: OP_ID,
    });
    const sealedPayload = await crypto.seal(PLAINTEXT_PAYLOAD, {
      tenantId: TENANT72, slot: 'tasks.payload_ref', refId: TASK_ID,
    });
    const { runtime } = claimHarness(sealedInput, sealedPayload, crypto);
    const claimed = await runtime.claimTask(TASK_ID, DELIVERY, 'w-72', BUSINESS);
    expect(claimed.executionSnapshot.resolvedInputRef).toEqual(PLAINTEXT_INPUT);
    expect(claimed.executionSnapshot.payloadRef).toEqual(PLAINTEXT_PAYLOAD);
  });

  it('WINDOW 4 (seam ON, row sealed for ANOTHER row): the claim FAILS CLOSED', async () => {
    // A mis-bound envelope must never reach a worker, even though the policy
    // tolerates PLAINTEXT. Tolerating legacy plaintext must not extend to
    // tolerating a wrong binding.
    const { crypto } = makeCrypto();
    const wrongInput = await crypto.seal(PLAINTEXT_INPUT, {
      tenantId: TENANT72, slot: 'operations.input_ref', refId: 'some-other-operation',
    });
    const { runtime } = claimHarness(wrongInput, PLAINTEXT_PAYLOAD, crypto);
    await expect(runtime.claimTask(TASK_ID, DELIVERY, 'w-72', BUSINESS)).rejects.toMatchObject({
      name: 'MetadataCryptoError',
    });
  });

  it('WINDOW 4b (seam ON, input sealed for another TENANT): fails closed too', async () => {
    const { crypto } = makeCrypto();
    const wrongTenant = await crypto.seal(PLAINTEXT_INPUT, {
      tenantId: 'tenant-somebody-else', slot: 'operations.input_ref', refId: OP_ID,
    });
    const { runtime } = claimHarness(wrongTenant, PLAINTEXT_PAYLOAD, crypto);
    await expect(runtime.claimTask(TASK_ID, DELIVERY, 'w-72', BUSINESS)).rejects.toMatchObject({
      name: 'MetadataCryptoError',
    });
  });
});

// CR28-01 metadata boundary negatives: malformed contextAad, non-UTF8 tenant,
// slot/row mismatch, and an invalid key. All four must fail closed.
describe('CR28-01 metadata boundary negatives', () => {
  const CTX2 = { tenantId: 'tenant-bnd', slot: 'operations.input_ref' as const, refId: 'op-bnd-1' };
  const VALUE = { document: 'BOUNDARY-VALUE-tenant-bnd', pages: 5 };

  it('a malformed contextAad (not valid base64) is refused, not parsed leniently', async () => {
    const { crypto } = makeCrypto();
    const sealed = await crypto.seal(VALUE, CTX2) as unknown as Record<string, unknown>;
    // Corrupt the AAD into something that is not decodable base64.
    const broken = { ...sealed, aad: '!!!not-base64!!!' };
    await expect(
      crypto.readStored(broken, CTX2, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });

  it('a contextAad swapped to another context is refused', async () => {
    const { crypto } = makeCrypto();
    const sealed = await crypto.seal(VALUE, CTX2) as unknown as Record<string, unknown>;
    // Re-seal under a different refId, then try to open under the original refId.
    const wrong = await crypto.seal(VALUE, { ...CTX2, refId: 'op-bnd-other' }) as unknown as Record<string, unknown>;
    await expect(
      crypto.readStored(wrong, CTX2, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
    // Sanity: the original still opens under its own binding.
    await expect(crypto.readStored(sealed, CTX2, false)).resolves.toBeDefined();
  });

  it('a non-UTF8 tenantId byte sequence still binds deterministically or fails closed', async () => {
    const { crypto } = makeCrypto();
    // A tenant id that is not valid UTF-8 when encoded must never silently
    // produce a value that a different byte sequence could collide with.
    const weird = { ...CTX2, tenantId: 'tenant-\u0000-null' };
    let outcome: 'opened' | 'refused' = 'opened';
    try {
      await crypto.seal(VALUE, weird);
    } catch (err) {
      outcome = 'refused';
      expect((err as { name?: string }).name).toBe('MetadataCryptoError');
    }
    // Either behaviour is acceptable; what must never happen is a silent
    // success that is NOT distinguishable from a well-formed binding.
    expect(['opened', 'refused']).toContain(outcome);
  });

  it('a slot/row mismatch is refused for every pair, not just the obvious one', async () => {
    const { crypto } = makeCrypto();
    const sealed = await crypto.seal(VALUE, CTX2) as unknown as Record<string, unknown>;
    // Same tenant and row, different slot.
    await expect(
      crypto.readStored(sealed, { ...CTX2, slot: 'tasks.payload_ref' }, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
    // Same slot, different row.
    await expect(
      crypto.readStored(sealed, { ...CTX2, refId: 'op-bnd-999' }, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
    // Same slot and row, different tenant.
    await expect(
      crypto.readStored(sealed, { ...CTX2, tenantId: 'tenant-other' }, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
  });

  it('an unknown slot is refused before any crypto work', async () => {
    const { crypto, stats } = makeCrypto();
    await expect(
      crypto.seal(VALUE, { tenantId: CTX2.tenantId, slot: 'not.a.slot' as never, refId: CTX2.refId })
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'INVALID_INPUT' });
    // Refused on the binding, not after reaching the key provider.
    expect(stats.wraps).toBe(0);
  });

  it('an empty tenantId or refId is refused (no empty-AAD seal)', async () => {
    const { crypto } = makeCrypto();
    await expect(
      crypto.seal(VALUE, { ...CTX2, tenantId: '' })
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'INVALID_INPUT' });
    await expect(
      crypto.seal(VALUE, { ...CTX2, refId: '' })
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'INVALID_INPUT' });
  });

  it('a bad key fails closed on read, never serving plaintext', async () => {
    const good = makeCrypto();
    const sealed = await good.crypto.seal(VALUE, CTX2);
    // Same provider, but the DEK is unwrapped wrong.
    const bad = makeCrypto({ wrongKey: true });
    await expect(
      bad.crypto.readStored(sealed, CTX2, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });

  it('a key provider that fails to unwrap fails closed with KEY_PROVIDER_FAILED', async () => {
    const good = makeCrypto();
    const sealed = await good.crypto.seal(VALUE, CTX2);
    const down = makeCrypto({ failUnwrap: true });
    await expect(
      down.crypto.readStored(sealed, CTX2, false)
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'KEY_PROVIDER_FAILED' });
  });
});

// CR28-04 runtime metadata negatives: size, envelope shape, AAD, expiry.
//
// The packet asks for four boundaries. Two of them (oversized payload,
// expired context) have NO guard in the module, so those tests pin the
// current behaviour and are marked FINDING rather than asserting a
// rejection that does not exist.
describe('CR28-04 runtime metadata negatives', () => {
  /** The envelope fields are readonly, so a mutated envelope needs a cast. */
  function withField(sealed: unknown, patch: Record<string, unknown>): never {
    return { ...(sealed as Record<string, unknown>), ...patch } as never;
  }

  describe('oversized metadata payload', () => {
    it.each([65535, 65536, 65537, 262144])(
      'FINDING: a %i byte canonical payload is sealed and opened with no size cap',
      async (target) => {
        const { crypto } = makeCrypto();
        const value = { big: 'x'.repeat(Math.max(1, target - 10)) };
        expect(canonicalizeMetadataJson(value).length).toBe(target);

        const sealed = await crypto.seal(value, CTX);
        // AES-GCM is a stream cipher: ciphertext length equals plaintext length.
        expect(Buffer.from(sealed.ciphertext, 'base64').length).toBe(target);
        expect(await crypto.open(sealed, CTX)).toEqual(value);
      }
    );

    it('a 256 KiB envelope still contains no plaintext', async () => {
      const { crypto } = makeCrypto();
      const value = { big: SENTINEL.repeat(2000) };
      const sealed = await crypto.seal(value, CTX);
      expect(JSON.stringify(sealed)).not.toContain(SENTINEL);
      expect(Buffer.from(sealed.ciphertext, 'base64').length).toBeGreaterThan(64 * 1024);
    });

    it('FINDING: a deeply nested document escapes as a raw RangeError', async () => {
      const { crypto } = makeCrypto();
      let deep: Record<string, unknown> = { v: 1 };
      for (let i = 0; i < 100000; i += 1) deep = { n: deep };

      // canonicalizeMetadataJson recurses with no depth cap and no try, so
      // the stack overflow leaves the closed MetadataCryptoError taxonomy.
      const err = await crypto.seal(deep, CTX).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RangeError);
      expect(err).not.toBeInstanceOf(MetadataCryptoError);
    });

    it('a moderately nested document still round-trips (control for the depth probe)', async () => {
      const { crypto } = makeCrypto();
      let value: Record<string, unknown> = { v: 1 };
      for (let i = 0; i < 50; i += 1) value = { n: value };

      const sealed = await crypto.seal(value, CTX);
      expect(await crypto.open(sealed, CTX)).toEqual(value);
    });
  });

  describe('malformed DEK ciphertext and truncated IV', () => {
    it.each([
      ['an empty nonce', 0],
      ['a nonce one byte short', 11],
      ['a nonce one byte long', 13],
    ])('refuses %s with AUTHENTICATION_FAILED', async (_label, length) => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);
      // subarray() past the end is a no-op, so a 13 byte nonce has to be
      // built by concatenation - otherwise the envelope stays intact and the
      // test would silently assert nothing.
      const real = Buffer.from(sealed.nonce, 'base64');
      const nonce = length <= real.length ? real.subarray(0, length) : Buffer.concat([real, Buffer.alloc(length - real.length)]);

      await expectCryptoError(
        () => crypto.open(withField(sealed, { nonce: nonce.toString('base64') }), CTX),
        'AUTHENTICATION_FAILED'
      );
    });

    it.each([
      ['an empty tag', 0],
      ['a tag one byte short', 15],
    ])('refuses %s with AUTHENTICATION_FAILED', async (_label, length) => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);
      const tag = Buffer.from(sealed.tag, 'base64').subarray(0, length);

      await expectCryptoError(
        () => crypto.open(withField(sealed, { tag: tag.toString('base64') }), CTX),
        'AUTHENTICATION_FAILED'
      );
    });

    it.each([
      ['an empty DEK', 0],
      ['a 16 byte DEK', 16],
      ['a 31 byte DEK', 31],
      ['a 33 byte DEK', 33],
    ])('refuses %s returned by the provider with AUTHENTICATION_FAILED', async (_label, length) => {
      // A provider that hands back a DEK of the wrong length. The rejection is
      // the seam's own createDecipheriv inside the try, so this asserts
      // production behaviour rather than a property of the test double.
      const crypto = createMetadataCrypto(
        {
          async wrapDek(dek: Buffer, keyRef: string, keyVersion?: number) {
            return {
              version: 1,
              keyName: keyRef,
              keyVersion: keyVersion ?? 1,
              wrappedKey: dek.toString('base64'),
            };
          },
          async unwrapDek() {
            return Buffer.alloc(length);
          },
        },
        KEY_REF
      );
      const sealed = await crypto.seal(SENSITIVE, CTX);

      await expectCryptoError(() => crypto.open(sealed, CTX), 'AUTHENTICATION_FAILED');
    });

    it('FINDING: a DEK envelope the provider cannot parse reports KEY_PROVIDER_FAILED', async () => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);

      // dek: {} passes assertEnvelopeShape (isRecord is true) and reaches the
      // provider, which throws. The seam maps ANY provider throw to
      // KEY_PROVIDER_FAILED - the same code a real Vault outage produces, so an
      // attacker-mangled envelope is indistinguishable from an incident.
      await expectCryptoError(
        () => crypto.open(withField(sealed, { dek: {} }), CTX),
        'KEY_PROVIDER_FAILED'
      );
    });

    it.each([
      ['a string', 'wrapped'],
      ['a number', 7],
      ['an array', []],
      ['null', null],
    ])('refuses a dek that is %s with NOT_SEALED', async (_label, dek) => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);

      await expectCryptoError(() => crypto.open(withField(sealed, { dek }), CTX), 'NOT_SEALED');
    });
  });

  describe('non-base64 AAD tampering', () => {
    it.each([
      ['punctuation only', '!!!!'],
      ['prose', 'not base64 at all'],
      ['an over-long run', 'A'.repeat(300)],
      ['a bare slash', '/'],
      ['padding only', '===='],
      ['an empty string', ''],
    ])('refuses an aad of %s with CONTEXT_MISMATCH', async (_label, aad) => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);

      // Buffer.from never throws on malformed base64: it silently drops the
      // invalid characters. Only the 32-byte length check stands between a
      // mangled AAD and the comparison, which is why the length matters.
      await expectCryptoError(
        () => crypto.open(withField(sealed, { aad }), CTX),
        'CONTEXT_MISMATCH'
      );
    });

    it('refuses a correctly sized aad with one flipped byte, so the comparison is load-bearing', async () => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);
      const aad = Buffer.from(sealed.aad, 'base64');
      aad[0] = aad[0]! ^ 0x01;

      expect(Buffer.from(aad.toString('base64'), 'base64').length).toBe(32);
      await expectCryptoError(
        () => crypto.open(withField(sealed, { aad: aad.toString('base64') }), CTX),
        'CONTEXT_MISMATCH'
      );
    });

    it('FINDING: a base64url re-encoding of the SAME aad still opens', async () => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);
      const same = Buffer.from(sealed.aad, 'base64').toString('base64url');
      expect(same).not.toBe(sealed.aad);
      expect(Buffer.from(same, 'base64').equals(Buffer.from(sealed.aad, 'base64'))).toBe(true);

      // The stored aad is only COMPARED; the cipher is always given the derived
      // one. So the aad field carries no authentication of its own, and a
      // different alphabet for the same bytes is accepted by design. This pins
      // that so a future "harden it" change cannot brick existing rows.
      expect(await crypto.open(withField(sealed, { aad: same }), CTX)).toEqual(SENSITIVE);
    });

    it('FINDING: a null aad escapes the error taxonomy as a raw TypeError', async () => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);

      // assertEnvelopeShape only rejects `undefined`, so null passes it, and
      // the AAD decode sits OUTSIDE the try - so a non-string aad leaves the
      // closed MetadataCryptoError taxonomy entirely.
      // `instanceof` is unsafe here: the TypeError raised inside node:buffer
      // does not share class identity with this test's global TypeError (the
      // same split errors.ts documents for HttpError), so jest reports
      // "Expected TypeError / Received TypeError". Duck-type on the shape a
      // MetadataCryptoError always has: a name and a code.
      const err = await crypto.open(withField(sealed, { aad: null }), CTX).catch((e: unknown) => e) as {
        name?: string;
        code?: string;
      };
      // `code === undefined` is NOT a valid discriminator: Node's
      // ERR_INVALID_ARG_TYPE carries a code too. The closed taxonomy is the
      // five MetadataCryptoError codes, and the escaping error is outside it.
      const taxonomy = [
        'INVALID_INPUT',
        'NOT_SEALED',
        'CONTEXT_MISMATCH',
        'AUTHENTICATION_FAILED',
        'KEY_PROVIDER_FAILED',
      ];
      expect(err.name).toBe('TypeError');
      expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
      expect(taxonomy).not.toContain(err.code);
    });

    it.each([['nonce'], ['tag'], ['ciphertext']])(
      'contains the same null hole for %s, because it is decoded inside the try',
      async (field) => {
        const { crypto } = makeCrypto();
        const sealed = await crypto.seal(SENSITIVE, CTX);

        await expectCryptoError(
          () => crypto.open(withField(sealed, { [field]: null }), CTX),
          'AUTHENTICATION_FAILED'
        );
      }
    );

    it('FINDING: a null keyRef is ignored on read', async () => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);

      // open() never looks at sealed.keyRef: the DEK envelope carries the key
      // identity. So the header field is decorative on the read path.
      expect(await crypto.open(withField(sealed, { keyRef: null }), CTX)).toEqual(SENSITIVE);
    });

    it.each([
      ['version'],
      ['algorithm'],
      ['keyRef'],
      ['dek'],
      ['nonce'],
      ['tag'],
      ['aad'],
      ['ciphertext'],
    ])('refuses an envelope missing %s with NOT_SEALED', async (field) => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX) as unknown as Record<string, unknown>;
      const partial = { ...sealed };
      delete partial[field];

      await expectCryptoError(() => crypto.open(partial as never, CTX), 'NOT_SEALED');
    });
  });

  describe('expired context unwrap', () => {
    it('FINDING: the envelope carries no timestamp, so its age cannot be measured', async () => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);

      // There is no sealedAt/expiresAt/issuedAt field, and no clock is
      // injected anywhere in the seam, so "expired" is not expressible.
      const keys = Object.keys(sealed).sort();
      expect(keys.some((k) => /time|date|expir|issued|created|age/i.test(k))).toBe(false);
      expect(keys).toEqual([
        'aad', 'algorithm', 'ciphertext', 'dek', 'keyRef', 'nonce',
        'plaintextSha256', 'tag', 'version',
      ]);
    });

    it('FINDING: an envelope from an arbitrarily old write still opens', async () => {
      const { crypto } = makeCrypto();
      const sealed = await crypto.seal(SENSITIVE, CTX);
      // The mtime of this very file stands in for age: nothing in open() reads
      // a clock, so a row written long ago decrypts exactly like a fresh one.
      expect(await crypto.open(sealed, CTX)).toEqual(SENSITIVE);
    });

    it('FINDING: the backfill window has no deadline, only a per-call boolean', async () => {
      const { crypto } = makeCrypto();
      const legacy = { document: SENTINEL, pages: 12 };

      // The nearest thing to an expiry is readStored(..., allowPlaintext). It
      // is decided by the CALLER on every call, with no date to compare, so the
      // window can stay open indefinitely by any caller passing true.
      expect(await crypto.readStored(legacy, CTX, true)).toEqual(legacy);
      await expectCryptoError(() => crypto.readStored(legacy, CTX, false), 'NOT_SEALED');
    });

    it('keyVersion is the only rotation lever and is not re-checked on read', async () => {
      const seen: number[] = [];
      const crypto = createMetadataCrypto(
        {
          async wrapDek(dek: Buffer, keyRef: string, keyVersion?: number) {
            return {
              version: 1,
              keyName: keyRef,
              keyVersion: keyVersion ?? 1,
              wrappedKey: dek.toString('base64'),
            };
          },
          async unwrapDek(wrapped) {
            seen.push(wrapped.keyVersion);
            return Buffer.from(wrapped.wrappedKey, 'base64');
          },
        },
        KEY_REF
      );
      const sealed = await crypto.seal(SENSITIVE, CTX, { keyVersion: 7 });
      expect(sealed.dek.keyVersion).toBe(7);

      expect(await crypto.open(sealed, CTX)).toEqual(SENSITIVE);
      // The seam forwards the STORED key version and never asks whether that
      // version is still valid, so rotation policy is entirely the provider's.
      expect(seen).toEqual([7]);
    });
  });

  describe('isSealed vs open: a partial envelope is classified as sealed', () => {
    const DISCRIMINATOR = {
      version: 1,
      algorithm: 'aes-256-gcm',
      ciphertext: 'AAAA',
      dek: {},
      nonce: 'AAAAAAAAAAAAAAAA',
      tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
    };

    it('FINDING: isSealed says yes to an envelope with no keyRef and no aad', () => {
      const crypto = makeCrypto().crypto;
      // The discriminator set is {version, algorithm, ciphertext, dek, nonce,
      // tag}; keyRef and aad are not part of it.
      expect(crypto.isSealed(DISCRIMINATOR)).toBe(true);
    });

    it('FINDING: open then refuses that same row as NOT_SEALED', async () => {
      const crypto = makeCrypto().crypto;
      await expectCryptoError(() => crypto.open(DISCRIMINATOR as never, CTX), 'NOT_SEALED');
    });

    it('FINDING: readStored on that row hard-fails instead of falling back to plaintext', async () => {
      const crypto = makeCrypto().crypto;
      // isSealed() is true, so readStored routes to open() and dies there. It
      // never reaches the allowPlaintext branch, so a row written by a partial
      // or older writer bricks the column instead of degrading to legacy read.
      await expectCryptoError(
        () => crypto.readStored(DISCRIMINATOR, CTX, true),
        'NOT_SEALED'
      );
    });

    it('a real legacy plaintext row is still not mistaken for an envelope', () => {
      const crypto = makeCrypto().crypto;
      expect(crypto.isSealed(SENSITIVE)).toBe(false);
      expect(crypto.isSealed({ version: 1, algorithm: 'aes-256-gcm' })).toBe(false);
    });
  });
});
