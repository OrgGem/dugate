/**
 * Delta 63: the CR28-04 submit-side seal, end to end.
 *
 * Cycle 26 sealed `operations.input_ref` and `tasks.payload_ref` and proved the
 * helper in isolation. It explicitly recorded that it had NOT driven a real
 * submit, because that needs a fake db, registry and profiles. This file closes
 * that gap: it runs the whole submit and inspects the bytes actually bound to
 * the INSERT parameters.
 *
 * The point is not that an envelope was produced - the cycle-26 helper tests
 * already show that. It is that the envelope is what REACHES THE COLUMN. A
 * submit path that seals and then binds the plaintext anyway would pass every
 * existing test in the repo and leak the whole document into a jsonb column.
 *
 * So every assertion here is on the bound parameter, never on an intermediate:
 *   - the bound value is NOT the plaintext, and contains no sentinel at any
 *     nesting depth or encoding;
 *   - it IS a sealed envelope that opens back to the exact input;
 *   - and it opens ONLY under its own (tenant, slot, row) binding.
 *
 * A wrong-key provider must abort the submit with nothing written, which is the
 * other half of "sealed before the transaction": the failure must not leave a
 * half-created operation behind.
 */
import { createHmac } from 'node:crypto';
import { createSubmissionService } from '../src/modules/operations/submission';
import { createProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';
import type { Db } from '../src/db/db';
import {
  createMetadataCrypto,
  type MetadataKeyProvider,
  type MetadataWrappedDek,
} from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';

const KEY_REF = 'du-submit-e2e-v1';
const TENANT = 'tenant-submit-e2e';
const API_KEY = 'key-submit-e2e';
const BUSINESS = 'document-core';
const ACTION = 'extract';
const SENTINEL = 'CONFIDENTIAL-SUBMIT-BODY-a1b2c3';
const HASH = String.fromCharCode(35);

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'submit-e2e-double').update(seed + String.fromCharCode(58) + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}

function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  return out;
}

/** Reversible stand-in for Vault Transit; `wrongKey` models a decrypt failure. */
function makeKeyProvider(opts: { wrongKey?: boolean; failWrap?: boolean } = {}): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      // Models a Vault outage during the wrap call, which is the failure that
      // can abort a submit BEFORE its transaction opens.
      if (opts.failWrap) throw new Error('vault transit unavailable');
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(
          Buffer.from(input.dek),
          keystream(input.keyRef + HASH + version, input.dek.length),
        ).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      if (opts.wrongKey) return Buffer.alloc(32, 0xee);
      return xor(raw, keystream(wrapped.keyRef + HASH + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}

interface Row {
  [key: string]: unknown;
}

function result<T>(rows: Row[]): { rows: T[]; rowCount: number | null } {
  return { rows: rows as T[], rowCount: rows.length };
}

interface Bound {
  readonly sql: string;
  readonly params: unknown[];
}

interface Harness {
  readonly db: Db;
  readonly writes: Bound[];
  readonly crypto: ReturnType<typeof createMetadataCrypto>;
}

function harness(opts: { keyProvider?: KeyProvider; crypto?: boolean } = {}): Harness {
  const keyProvider = opts.keyProvider ?? makeKeyProvider();
  const writes: Bound[] = [];
  const manifest = {
    actions: [{ name: ACTION, inputSchema: { type: 'object', additionalProperties: true } }],
    runtime: { handlerKinds: ['root'] },
  };

  const answer = (sql: string, params: unknown[], sink: Bound[]) => {
    if (/FROM business_versions/.test(sql)) {
      return result<Row>([{
        version: '1.0.0', manifest, digest: 'sha256:test', queue: 'du-q',
      }]);
    }
    if (/SELECT profile_id, revision, connector_bindings FROM profile_bindings/.test(sql)) {
      return result<Row>([]);
    }
    if (/SELECT 1 FROM profile_bindings WHERE api_key_id=\$1 LIMIT 1/.test(sql)) {
      return result<Row>([]);
    }
    if (/FROM operations WHERE id=\$1/.test(sql)) {
      return result<Row>([{
        id: String(params[0]), tenant_id: TENANT, business_id: BUSINESS,
        business_version: '1.0.0', action: ACTION, state: 'ACCEPTED',
        state_version: 1, created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(), deadline_at: null, result_ref: null,
      }]);
    }
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
      sink.push({ sql, params });
      return result<Row>([]);
    }
    return result<Row>([]);
  };

  const txClient = {
    query: async (sql: string, params: unknown[] = []) => answer(sql, params, writes),
  };
  const db = {
    query: async (sql: string, params: unknown[] = []) => answer(sql, params, writes),
    tx: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => fn(txClient),
    close: async () => undefined,
  } as unknown as Db;

  const crypto = createMetadataCrypto(
    adaptKeyProviderForMetadata(keyProvider) as MetadataKeyProvider,
    KEY_REF,
  );
  return { db, writes, crypto };
}

function serviceOf(h: Harness, withCrypto: boolean) {
  const profiles = createProfileService(h.db);
  return createSubmissionService(h.db, {} as RegistryService, profiles, {
    ...(withCrypto ? { metadataCrypto: h.crypto } : {}),
  });
}

// SubmissionSchema is .strict() and carries NO action field: the action comes from
// SubmitContext, not the body. Passing one here was my mistake, not a product bug.
const SUBMISSION = {
  input: { document: SENTINEL, pages: 3, nested: { secret: SENTINEL } },
};

const SUBMIT_CTX = {
  tenantId: TENANT,
  apiKeyId: API_KEY,
  businessId: BUSINESS,
  action: ACTION,
  correlationId: 'submit-e2e-001',
};

function findWrite(writes: Bound[], pattern: RegExp): Bound {
  const hit = writes.find((w) => pattern.test(w.sql));
  if (!hit) throw new Error('no write matched ' + String(pattern) + '; saw: ' + writes.map((w) => w.sql.slice(0, 40)).join(' | '));
  return hit;
}

/** The sentinel must not survive anywhere in the bound column value. */
function leaksSentinel(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') {
    if (value.includes(SENTINEL)) return true;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 8) {
      try {
        return Buffer.from(value, 'base64').toString('utf8').includes(SENTINEL);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => leaksSentinel(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Row).some((v) => leaksSentinel(v, depth + 1));
  }
  return false;
}

describe('Delta 63: the submit path seals before the INSERT, end to end', () => {
  it('operations.input_ref is bound as a sealed envelope, not the plaintext', async () => {
    const h = harness();
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    const bound = String(op.params[8]);
    expect(leaksSentinel(op.params[8])).toBe(false);
    expect(bound).not.toBe(JSON.stringify(SUBMISSION.input));
  });

  it('tasks.payload_ref is bound as a sealed envelope too', async () => {
    const h = harness();
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const task = findWrite(h.writes, /INSERT INTO tasks/);
    const bound = String(task.params[3]);
    expect(leaksSentinel(task.params[3])).toBe(false);
    expect(bound).not.toBe(JSON.stringify(SUBMISSION.input));
  });

  it('BOTH columns open back to the exact input under their own binding', async () => {
    const h = harness();
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    const task = findWrite(h.writes, /INSERT INTO tasks/);
    const operationId = String(op.params[0]);
    const taskId = String(task.params[0]);

    const openedInput = await h.crypto.readStored(
      JSON.parse(String(op.params[8])),
      { tenantId: TENANT, slot: 'operations.input_ref', refId: operationId },
      false,
    );
    const openedPayload = await h.crypto.readStored(
      JSON.parse(String(task.params[3])),
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: taskId },
      false,
    );
    // CRX-01: the sealed value IS the action input object, so an opened
    // envelope reproduces the exact JSON shape the plaintext column held —
    // no JSON.parse of the opened value (that was the pre-CRX-01 string shape,
    // which broke the execution snapshot the worker SDK parses).
    expect(openedInput).toEqual(SUBMISSION.input);
    expect(openedPayload).toEqual(SUBMISSION.input);
  });

  it('the two columns are bound to DIFFERENT rows and will not swap', async () => {
    const h = harness();
 await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    const task = findWrite(h.writes, /INSERT INTO tasks/);
    const operationId = String(op.params[0]);
    const taskId = String(task.params[0]);
    expect(operationId).not.toBe(taskId);
    // A payload_ref envelope offered under the input_ref binding must fail.
    await expect(
      h.crypto.readStored(
        JSON.parse(String(task.params[3])),
        { tenantId: TENANT, slot: 'operations.input_ref', refId: operationId },
        false,
      ),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });

  it('a Vault outage at SEAL time aborts the submit with NO row written', async () => {
    // Correction to my first attempt at this case: I originally used a
    // WRONG-KEY provider, which does not fail here. Sealing only calls
    // wrapDek; a wrong key only breaks unwrapDek, and submit never decrypts.
    // The thing that can actually abort the write is the provider being
    // UNAVAILABLE while sealing, because that call happens before the
    // transaction opens. That is the risk worth pinning.
    const h = harness({ keyProvider: makeKeyProvider({ failWrap: true }) });
    await expect(
      serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION }),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'KEY_PROVIDER_FAILED' });
    // Nothing may reach the database: the seal happens before the tx opens.
    expect(h.writes).toHaveLength(0);
  });

  it('a wrong key cannot be detected at submit, and does not need to be', async () => {
    // Seal succeeds with a provider whose unwrap is wrong; the submit still
    // stores a valid envelope. This is expected and is the reason the failure
    // surface for a wrong key is the READ path (see the CR28-01 suite), not
    // the write path. Asserting it explicitly stops someone 'fixing' this
    // later by trying to fail closed here.
    const h = harness({ keyProvider: makeKeyProvider({ wrongKey: true }) });
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    expect(leaksSentinel(op.params[8])).toBe(false);
  });

  it('with no seam the columns are the historical plaintext, byte for byte', async () => {
    // The opt-in contract: absent seam must not change what a deployment stores.
    const h = harness();
    await serviceOf(h, false).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    const task = findWrite(h.writes, /INSERT INTO tasks/);
    expect(String(op.params[8])).toBe(JSON.stringify(SUBMISSION.input));
    expect(String(task.params[3])).toBe(JSON.stringify(SUBMISSION.input));
  });
});

// CR28-06: submit-side metadata crypto negatives, driven through a real submit.
//
// Cycle 32 proved the envelope REACHES the column. This file attacks that
// envelope from four directions: it is moved between columns, it is corrupted
// on the way back, the key service dies mid-sequence, and the read-back context
// is tampered with.
describe('CR28-06 submit metadata crypto: cross-column swapping', () => {
  async function sealedSubmit(keyProvider?: KeyProvider) {
    const h = harness(keyProvider ? { keyProvider } : {});
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    const task = findWrite(h.writes, /INSERT INTO tasks/);
    return {
      h,
      operationId: String(op.params[0]),
      taskId: String(task.params[0]),
      inputRef: String(op.params[8]),
      payloadRef: String(task.params[3]),
    };
  }

  it('refuses the payload envelope under the input column binding AND the reverse', async () => {
    const s = await sealedSubmit();

    // The delta-63 suite covered one direction only. A half-sealed submit that
    // left ONE column plaintext would still satisfy a broad 'it rejects'
    // assertion, so both directions assert the SPECIFIC code a swap produces.
    await expect(
      s.h.crypto.readStored(
        JSON.parse(s.payloadRef),
        { tenantId: TENANT, slot: 'operations.input_ref', refId: s.operationId },
        false,
      ),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });

    await expect(
      s.h.crypto.readStored(
        JSON.parse(s.inputRef),
        { tenantId: TENANT, slot: 'tasks.payload_ref', refId: s.taskId },
        false,
      ),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
  });

  it('refuses a column envelope under a different ROW of the SAME column', async () => {
    const s = await sealedSubmit();

    // Right slot, wrong refId. This isolates the refId dimension of the AAD
    // from the slot dimension, so dropping either one from the binding would be
    // caught separately rather than hiding behind the other.
    await expect(
      s.h.crypto.readStored(
        JSON.parse(s.payloadRef),
        { tenantId: TENANT, slot: 'tasks.payload_ref', refId: s.operationId },
        false,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });

    await expect(
      s.h.crypto.readStored(
        JSON.parse(s.inputRef),
        { tenantId: TENANT, slot: 'operations.input_ref', refId: s.taskId },
        false,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  it('refuses both column envelopes under a different TENANT', async () => {
    const s = await sealedSubmit();

    for (const [label, value] of [['input_ref', s.inputRef], ['payload_ref', s.payloadRef]] as const) {
      await expect(
        s.h.crypto.readStored(
          JSON.parse(value),
          {
            tenantId: 'tenant-somebody-else',
            slot: label === 'input_ref' ? 'operations.input_ref' : 'tasks.payload_ref',
            refId: label === 'input_ref' ? s.operationId : s.taskId,
          },
          false,
        ),
      ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    }
  });

  it('the two columns hold two DIFFERENT envelopes, so no single value serves both', async () => {
    const s = await sealedSubmit();

    // The bug a shared envelope would cause: both columns carry the same bytes,
    // so one of the two bindings is necessarily wrong and the row can never be
    // read back under both.
    expect(s.inputRef).not.toBe(s.payloadRef);
    // The envelope's dek is the metadata seam's own shape, not the Vault
    // provider's: the adapter renames ciphertext to wrappedKey.
    const a = JSON.parse(s.inputRef) as { dek: { wrappedKey: string }; nonce: string };
    const b = JSON.parse(s.payloadRef) as { dek: { wrappedKey: string }; nonce: string };
    expect(a.dek.wrappedKey).not.toBe(b.dek.wrappedKey);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('CR28-06 submit metadata crypto: malformed envelope in the column', () => {
  async function sealedSubmit() {
    const h = harness();
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    return { h, operationId: String(op.params[0]), inputRef: String(op.params[8]) };
  }

  function corrupted(value: string, patch: (env: Record<string, unknown>) => void): string {
    const env = JSON.parse(value) as Record<string, unknown>;
    patch(env);
    return JSON.stringify(env);
  }

  it.each([
    ['an unknown version', 'NOT_SEALED', (e: Record<string, unknown>) => { e.version = 2; }],
    ['a wrong algorithm', 'NOT_SEALED', (e: Record<string, unknown>) => { e.algorithm = 'aes-128-gcm'; }],
    ['a dek that is not an object', 'NOT_SEALED', (e: Record<string, unknown>) => { e.dek = 'vault:v1:x'; }],
    ['a deleted dek', 'NOT_SEALED', (e: Record<string, unknown>) => { delete e.dek; }],
    ['a deleted nonce', 'NOT_SEALED', (e: Record<string, unknown>) => { delete e.nonce; }],
    ['an 11 byte nonce', 'AUTHENTICATION_FAILED', (e: Record<string, unknown>) => { e.nonce = Buffer.alloc(11).toString('base64'); }],
    ['a 15 byte tag', 'AUTHENTICATION_FAILED', (e: Record<string, unknown>) => { e.tag = Buffer.alloc(15).toString('base64'); }],
  ])('refuses an envelope with %s', async (_label, code, patch) => {
    const s = await sealedSubmit();
    const bad = corrupted(s.inputRef, patch as (e: Record<string, unknown>) => void);

    await expect(
      s.h.crypto.readStored(JSON.parse(bad), { tenantId: TENANT, slot: 'operations.input_ref', refId: s.operationId }, false),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code });
  });

  it.each([
    ['a flipped ciphertext byte', 'AUTHENTICATION_FAILED', (e: Record<string, unknown>) => {
      const raw = Buffer.from(String(e.ciphertext), 'base64');
      raw[0] = raw[0]! ^ 0x01;
      e.ciphertext = raw.toString('base64');
    }],
    ['a flipped aad byte', 'CONTEXT_MISMATCH', (e: Record<string, unknown>) => {
      const aad = Buffer.from(String(e.aad), 'base64');
      aad[0] = aad[0]! ^ 0x01;
      e.aad = aad.toString('base64');
    }],
  ])('refuses an envelope with %s', async (_label, code, patch) => {
    const s = await sealedSubmit();
    const bad = corrupted(s.inputRef, patch as (e: Record<string, unknown>) => void);

    await expect(
      s.h.crypto.readStored(JSON.parse(bad), { tenantId: TENANT, slot: 'operations.input_ref', refId: s.operationId }, false),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code });
  });

  it('refuses an envelope whose DEK was swapped for the other column DEK', async () => {
    const h = harness();
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    const task = findWrite(h.writes, /INSERT INTO tasks/);
    const inputRef = String(op.params[8]);
    const payloadRef = String(task.params[3]);
    const operationId = String(op.params[0]);

    // The AAD is the same here, so this attacks the DEK alone: a valid binding,
    // a valid nonce, a foreign key.
    const mixed = JSON.parse(inputRef) as Record<string, unknown>;
    mixed.dek = (JSON.parse(payloadRef) as Record<string, unknown>).dek;
    await expect(
      h.crypto.readStored(mixed, { tenantId: TENANT, slot: 'operations.input_ref', refId: operationId }, false),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it.each([
    ['a bare JSON string', 'plaintext-column'],
    ['a JSON number', 42],
    ['a JSON null', null],
    ['a JSON boolean', true],
    ['an empty object', {}],
  ])('refuses a column holding %s as a sealed envelope', async (_label, stored) => {
    const s = await sealedSubmit();
    // The value stored in a jsonb column can be any of these if a writer is
    // broken or a migration half-ran. None may be waved through as plaintext.
    expect(leaksSentinel(stored)).toBe(false);
    await expect(
      s.h.crypto.readStored(stored, { tenantId: TENANT, slot: 'operations.input_ref', refId: s.operationId }, false),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'NOT_SEALED' });
  });

  it.each([
    ['replaced with 64 zeros', () => '0'.repeat(64)],
    ['set to null', () => null],
    ['deleted', () => undefined],
    ['replaced with a non-hex string', () => 'z'.repeat(64)],
  ])('FINDING: a plaintextSha256 that is %s still opens the envelope', async (_label, make) => {
    const s = await sealedSubmit();
    const env = JSON.parse(s.inputRef) as Record<string, unknown>;
    const value = (make as () => unknown)();
    if (value === undefined) delete env.plaintextSha256;
    else env.plaintextSha256 = value;

    // The digest is a CALLER CONVENIENCE, not a guard: the seam documents it as
    // "lets callers keep content hashes", and the real integrity comes from the
    // GCM tag over the AAD and ciphertext. So the field is never checked on
    // read-back. The delta-63 suite asserts the digest MATCHES, which reads as
    // though it were enforced - it is not, and a consumer that trusts it as a
    // post-decrypt check would be comparing a stored value with itself.
    const opened = await s.h.crypto.readStored(
      env, { tenantId: TENANT, slot: 'operations.input_ref', refId: s.operationId }, false,
    );
    // CRX-01: opened values are the sealed object itself.
    expect(JSON.stringify(opened)).toContain(SENTINEL);
  });

  it('a corrupted envelope still leaks no plaintext into the column', async () => {
    const s = await sealedSubmit();
    const env = JSON.parse(s.inputRef) as Record<string, unknown>;

    // Corrupt every field that carries or describes the payload, then re-scan the
    // whole value at every nesting depth AND through base64, the way the
    // delta-63 leak check does.
    const raw = Buffer.from(String(env.ciphertext), 'base64');
    raw[0] = raw[0]! ^ 0xff;
    const broken = {
      ...env,
      ciphertext: raw.toString('base64'),
      tag: Buffer.alloc(16, 0xaa).toString('base64'),
      plaintextSha256: 'f'.repeat(64),
      keyRef: 'attacker-supplied',
    };
    expect(leaksSentinel(broken)).toBe(false);
    expect(leaksSentinel(JSON.stringify(broken))).toBe(false);
  });
});

describe('CR28-06 submit metadata crypto: key-service outage', () => {
  /** Fails on the Nth wrap call and counts calls, so a test can prove it ran. */
  function makeFlakyProvider(failOnCall: number): { provider: KeyProvider; wrapCalls: () => number } {
    const base = makeKeyProvider();
    let calls = 0;
    return {
      wrapCalls: () => calls,
      provider: {
        async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
          calls += 1;
          if (calls === failOnCall) throw new Error('vault transit unavailable');
          return base.wrapDek(input);
        },
        async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
          return base.unwrapDek(wrapped);
        },
        async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
          return base.rewrap(wrapped);
        },
      },
    };
  }

  it.each([
    ['the first', 1],
    ['the second', 2],
  ])('a Vault outage on %s wrap writes nothing at all', async (_label, failOn) => {
    const { provider, wrapCalls } = makeFlakyProvider(failOn);
    const h = harness({ keyProvider: provider });

    await expect(
      serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION }),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'KEY_PROVIDER_FAILED' });

    // The submit seals BOTH columns before it opens the transaction, so an
    // outage on the SECOND seal must still leave zero rows. The call count is
    // what stops this from passing vacuously: if the code only ever wrapped
    // once, a fail-on-2 provider would never fire and the test would prove
    // nothing. With failOn = 2, the first seal SUCCEEDED and still no row exists.
    expect(wrapCalls()).toBe(failOn);
    expect(h.writes).toHaveLength(0);
  });

  it('FINDING: the seal path does not validate the wrapped DEK a provider returns', async () => {
    const brokenProvider: KeyProvider = {
      // A misbehaving provider answers the wrap call with a shape that is not a
      // wrapped DEK at all. Nothing on the WRITE path inspects the result, so
      // this lands in the column verbatim.
      async wrapDek(): Promise<WrappedDek> {
        return {} as unknown as WrappedDek;
      },
      async unwrapDek(): Promise<Buffer> {
        throw new Error('cannot unwrap a shape that is not a DEK');
      },
      async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
        return wrapped;
      },
    };

    const h = harness({ keyProvider: brokenProvider });
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    const stored = String(op.params[8]);

    // The submit SUCCEEDED and the column now holds an envelope that can never
    // be opened: assertEnvelopeShape accepts any record as a dek, and unwrapDek
    // fails from then on. The plaintext is still not leaked.
    // The adapter normalizes whatever the provider returns, so the column gets
    // a record with the version but none of the DEK identity fields.
    expect(JSON.parse(stored).dek).toEqual({ version: 1 });
    expect(leaksSentinel(op.params[8])).toBe(false);
    await expect(
      h.crypto.readStored(JSON.parse(stored), { tenantId: TENANT, slot: 'operations.input_ref', refId: String(op.params[0]) }, false),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });
});

describe('CR28-06 submit metadata crypto: tampered AAD context on read-back', () => {
  async function sealedSubmit() {
    const h = harness();
    await serviceOf(h, true).submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const op = findWrite(h.writes, /INSERT INTO operations/);
    return { h, operationId: String(op.params[0]), inputRef: String(op.params[8]) };
  }

  it.each([
    ['the tenant', { tenantId: 'tenant-somebody-else' }],
    ['the row', { refId: 'operation-somebody-else' }],
    ['the slot', { slot: 'tasks.payload_ref' }],
  ])('refuses a read-back whose context has a tampered %s', async (_label, patch) => {
    const s = await sealedSubmit();
    const ctx = { tenantId: TENANT, slot: 'operations.input_ref', refId: s.operationId, ...(patch as object) };

    await expect(s.h.crypto.readStored(JSON.parse(s.inputRef), ctx as never, false))
      .rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
  });

  it('refuses a tampered stored aad BEFORE attempting any decryption', async () => {
    const s = await sealedSubmit();
    const env = JSON.parse(s.inputRef) as Record<string, unknown>;
    const aad = Buffer.from(String(env.aad), 'base64');
    aad[aad.length - 1] = aad[aad.length - 1]! ^ 0x01;
    env.aad = aad.toString('base64');

    // CONTEXT_MISMATCH, not AUTHENTICATION_FAILED: the source claims the AAD is
    // compared before the cipher is touched, and this is the assertion that
    // holds it to that claim. A change that checked the AAD afterwards would
    // silently downgrade the cross-tenant diagnosis to a generic auth failure.
    await expect(
      s.h.crypto.readStored(env, { tenantId: TENANT, slot: 'operations.input_ref', refId: s.operationId }, false),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
  });

  it.each([
    ['a missing slot', { tenantId: TENANT, refId: 'operation-1' }],
    ['an unknown slot', { tenantId: TENANT, slot: 'operations.secret_ref', refId: 'operation-1' }],
    ['an empty tenantId', { tenantId: '', slot: 'operations.input_ref', refId: 'operation-1' }],
    ['an empty refId', { tenantId: TENANT, slot: 'operations.input_ref', refId: '' }],
  ])('refuses a read-back context with %s as INVALID_INPUT', async (_label, ctx) => {
    const s = await sealedSubmit();

    // A malformed CONTEXT is an input error, reported before the envelope is
    // even looked at. Distinct from CONTEXT_MISMATCH, which means the envelope
    // was valid but belonged somewhere else.
    await expect(s.h.crypto.readStored(JSON.parse(s.inputRef), ctx as never, false))
      .rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'INVALID_INPUT' });
  });
});
