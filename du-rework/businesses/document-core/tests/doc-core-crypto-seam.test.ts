/**
 * W-ENC-04-DOC-CORE: document-core honours the worker crypto seam.
 *
 * Pinned here, in the order the packet asks:
 *  1. ADAPTER - an SDK-shaped context exposing `cryptoFor` yields an internal
 *     context WITH a seam; one without yields NONE, so opt-in/fallback is real.
 *  2. TENANT BINDING - the seam is bound to the context tenant; a handler can
 *     never obtain a handle for a tenant it supplies itself.
 *  3. CHECKPOINT - with a seam, the PERSISTED payload is an envelope with no
 *     plaintext in it, the caller still gets the original value, and replay
 *     decrypts without re-executing the step.
 *  4. NO SILENT PLAINTEXT - with no seam the stored payload is exactly the old
 *     value (byte-for-byte), and a caller that REQUIRES encryption fails
 *     BEFORE the step body runs, not after something is already persisted.
 *
 * The key provider is a real reversible transform, not an echo: an echo would
 * make a broken binding look authenticated.
 */

import { createHmac } from 'node:crypto';
import {
  CryptoStorageFacade,
  bindTaskCrypto,
  type CryptoKeyProvider,
  type TaskArtifactBinding,
  type TaskArtifactCrypto,
  type WrappedDek,
} from '@du/worker-sdk';
import { toInternalContext } from '../src/worker';
import { StepCheckpointManager } from '../src/pipelines/step-checkpoint';
import type { StepCheckpointRecord, TaskContext } from '../src/types/context';

const KEY_REF = 'du-doc-core-v1';
const TENANT = 'tenant-doc-core';
const SENTINEL = 'CONFIDENTIAL-STEP-OUTPUT-9de71b';

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'doc-core-test-double').update(seed + String.fromCharCode(58) + block).digest();
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

function makeProvider(): CryptoKeyProvider {
  return {
    async wrapDek(input): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(
          Buffer.from(input.dek),
          keystream(input.keyRef + String.fromCharCode(35) + String(version), input.dek.length),
        ).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + String.fromCharCode(35) + String(wrapped.keyVersion), raw.length));
    },
  };
}

function makeCrypto(tenantId: string): TaskArtifactCrypto {
  return bindTaskCrypto({ facade: new CryptoStorageFacade(makeProvider()), keyRef: KEY_REF }, { tenantId });
}

/**
 * Does the sentinel survive ANYWHERE in a stored value, including encoded?
 *
 * A plain `JSON.stringify(x).not.toContain(sentinel)` is NOT enough: a record that
 * smuggles the plaintext as a base64 string still passes it, which is exactly
 * what a mutation probe caught during this cycle. So every string is also
 * base64-decoded and re-checked before the verdict.
 */
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
  if (Array.isArray(value)) return value.some((item) => leaksSentinel(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => leaksSentinel(item, depth + 1));
  }
  return false;
}

/** Minimal SDK-shaped context; the adapter only feature-detects cryptoFor. */
function makeSdkContext(withCrypto: boolean, tenantId = TENANT): unknown {
  const ctx: Record<string, unknown> = {
    taskId: 'task-1',
    operationId: 'op-1',
    businessId: 'document-core',
    businessVersion: '1.0.0',
    tenantId,
    signal: new AbortController().signal,
    artifacts: {
      read: async () => Buffer.alloc(0),
      write: async () => ({ artifactId: 'art-1', role: 'output' }),
    },
  };
  if (withCrypto) {
    // The SDK exposes BOTH: `cryptoSeam` reports whether encryption is on,
    // `cryptoFor` hands out the tenant-bound handle.
    ctx.cryptoSeam = () => ({ facade: new CryptoStorageFacade(makeProvider()), keyRef: KEY_REF });
    ctx.cryptoFor = (): TaskArtifactCrypto => makeCrypto(tenantId);
  }
  return ctx;
}

describe('W-ENC-04-DOC-CORE adapter: the seam follows the worker configuration', () => {
  it('exposes crypto on the internal context when the worker has a seam', () => {
    const internal = toInternalContext(makeSdkContext(true) as never);
    expect(internal.crypto).toBeDefined();
    expect(internal.crypto?.tenantId).toBe(TENANT);
  });

  it('leaves crypto undefined when the worker has none (fallback preserved)', () => {
    const internal = toInternalContext(makeSdkContext(false) as never);
    expect(internal.crypto).toBeUndefined();
  });

  it('binds the seam to the CONTEXT tenant, never a handler-supplied one', () => {
    const internal = toInternalContext(makeSdkContext(true, 'tenant-other') as never);
    expect(internal.crypto?.tenantId).toBe('tenant-other');
  });
});

interface CheckpointHarness {
  readonly ctx: TaskContext;
  readonly stored: Map<string, StepCheckpointRecord>;
  runs(): number;
}

/** A document-core TaskContext whose step facade persists into a Map. */
function makeCheckpointHarness(options: { withCrypto: boolean; tenantId?: string }): CheckpointHarness {
  const stored = new Map<string, StepCheckpointRecord>();
  let runs = 0;
  const crypto = options.withCrypto ? makeCrypto(options.tenantId ?? TENANT) : undefined;
  const ctx = {
    taskId: 'task-1',
    operationId: 'op-1',
    businessId: 'document-core',
    businessVersion: '1.0.0',
    tenantId: options.tenantId ?? TENANT,
    signal: new AbortController().signal,
    artifacts: {
      read: async () => Buffer.alloc(0),
      write: async () => ({ artifactId: 'art-1', role: 'intermediate' }),
    },
    connector: {
      invoke: async () => ({ invocationId: 'inv-1', status: 'SUCCESS' }),
    },
    step: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
      const value = await fn();
      runs += 1;
      stored.set(stepKey, {
        stepKey,
        inputHash,
        output: value,
        savedAt: new Date(0).toISOString(),
      });
      return value;
    },
    getCheckpoint: async (stepKey: string) => stored.get(stepKey) ?? null,
    ...(crypto ? { crypto } : {}),
  } as unknown as TaskContext;
  return { ctx, stored, runs: () => runs };
}

describe('W-ENC-04-DOC-CORE checkpoints: sealed at rest, transparent on replay', () => {
  it('persists an envelope with no plaintext when a seam is configured', async () => {
    const harness = makeCheckpointHarness({ withCrypto: true });
    const output = { body: SENTINEL, pages: 2 };
    const returned = await StepCheckpointManager.executeWithCheckpoint(
      harness.ctx,
      'extract-step',
      { input: 1 },
      async () => output,
    );
    // The caller is unaffected: it still gets the value it produced.
    expect(returned).toEqual(output);
    const record = harness.stored.get('extract-step');
    expect(record).toBeDefined();
    expect(StepCheckpointManager.isSealedRecord(record?.output)).toBe(true);
    expect(leaksSentinel(record?.output)).toBe(false);
  });

  it('replays from the sealed record without re-executing the step', async () => {
    const harness = makeCheckpointHarness({ withCrypto: true });
    const output = { body: SENTINEL, pages: 2 };
    const inputHash = StepCheckpointManager.computeInputHash({ input: 1 });
    await StepCheckpointManager.executeWithCheckpoint(harness.ctx, 'extract-step', { input: 1 }, async () => output);
    expect(harness.runs()).toBe(1);
    const replayed = await StepCheckpointManager.executeWithCheckpoint(
      harness.ctx,
      'extract-step',
      { input: 1 },
      async () => {
        throw new Error('step body must not run on replay');
      },
    );
    expect(replayed).toEqual(output);
    expect(harness.runs()).toBe(1);
    expect(inputHash).toMatch(/^hash-/);
  });

  it('stores the value unchanged when no seam is configured (byte-for-byte fallback)', async () => {
    const harness = makeCheckpointHarness({ withCrypto: false });
    const output = { body: SENTINEL, pages: 2 };
    const returned = await StepCheckpointManager.executeWithCheckpoint(
      harness.ctx,
      'plain-step',
      { input: 1 },
      async () => output,
    );
    expect(returned).toEqual(output);
    const record = harness.stored.get('plain-step');
    expect(StepCheckpointManager.isSealedRecord(record?.output)).toBe(false);
    expect(record?.output).toEqual(output);
    expect(JSON.stringify(record?.output)).toContain(SENTINEL);
  });

  it('fails BEFORE the step body when encryption is required but absent', async () => {
    const harness = makeCheckpointHarness({ withCrypto: false });
    let bodyRan = false;
    await expect(
      StepCheckpointManager.executeWithCheckpoint(
        harness.ctx,
        'required-step',
        { input: 1 },
        async () => {
          bodyRan = true;
          return { body: SENTINEL };
        },
        { requireEncryption: true },
      ),
    ).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' });
    // Nothing ran, so nothing can have been persisted in the clear.
    expect(bodyRan).toBe(false);
    expect(harness.stored.has('required-step')).toBe(false);
  });

  it('refuses to open a sealed checkpoint on a worker that lost its seam', async () => {
    const sealedRun = makeCheckpointHarness({ withCrypto: true });
    await StepCheckpointManager.executeWithCheckpoint(
      sealedRun.ctx,
      'sealed-step',
      { input: 1 },
      async () => ({ body: SENTINEL }),
    );
    const record = sealedRun.stored.get('sealed-step');
    // A worker restarted WITHOUT the seam must not silently hand back the
    // envelope as if it were the value.
    const stripped = makeCheckpointHarness({ withCrypto: false });
    stripped.stored.set('sealed-step', record as StepCheckpointRecord);
    await expect(StepCheckpointManager.executeWithCheckpoint(stripped.ctx, 'sealed-step', { input: 1 }, async () => ({ body: SENTINEL })))
      .rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' });
  });

  it('a sealed checkpoint from tenant A will not open under tenant B', async () => {
    const a = makeCheckpointHarness({ withCrypto: true, tenantId: 'tenant-a' });
    await StepCheckpointManager.executeWithCheckpoint(
      a.ctx,
      'tenant-step',
      { input: 1 },
      async () => ({ body: SENTINEL }),
    );
    const record = a.stored.get('tenant-step');
    const b = makeCheckpointHarness({ withCrypto: true, tenantId: 'tenant-b' });
    b.stored.set('tenant-step', record as StepCheckpointRecord);
    await expect(StepCheckpointManager.executeWithCheckpoint(b.ctx, 'tenant-step', { input: 1 }, async () => ({ body: SENTINEL })))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });
});