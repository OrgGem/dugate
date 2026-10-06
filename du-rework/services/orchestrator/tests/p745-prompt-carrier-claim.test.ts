import { createHash, createHmac } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import { createMetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import type { PinnedPromptOverride } from '@du/contracts';

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1, adjudications 1a/1b/1e) — the claim half.
 *
 * The claim opens the sealed carrier with the orchestrator-held key, delivers
 * it as `pinned.promptOverrides`, and cross-checks it against the marker pin:
 * exact row-count equality, no duplicate steps, every row's revision matching
 * its marker AND reproducing from its own content. Any drift fails the claim
 * closed (rollback: zero committed writes). Crypto-layer faults (tampered tag,
 * cross-slot replay) surface as MetadataCryptoError. NULL carrier → null.
 */

const TENANT_ID = '7c000000-0000-4000-8000-000000000001';
const OPERATION_ID = '7c000000-0000-4000-8000-000000000004';
const TASK_ID = '7c000000-0000-4000-8000-000000000005';
const BUSINESS_ID = 'document-core';
const PROFILE_ID = '7c000000-0000-4000-8000-000000000003';
const PROFILE_REVISION = 7;
const CONN_A = '7c000000-0000-4000-8000-00000000000a';
const KEY_REF = 'p745-carrier-claim-v1';
const SENTINEL = 'P745-CLAIM-CARRIER-SENTINEL-8c21';

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'p745-claim').update(seed + ':' + block).digest();
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
function makeKeyProvider(): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(Buffer.from(input.dek), keystream(input.keyRef + '#' + version, input.dek.length)).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + '#' + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}

function cryptoWith(provider: KeyProvider) {
  return createMetadataCrypto(adaptKeyProviderForMetadata(provider) as MetadataKeyProvider, KEY_REF);
}

function row(stepId: string, content: string, connectionId = CONN_A): PinnedPromptOverride {
  // Deterministic content-revision formula, mirroring the producer.
  const revision = 'sha256:' + createHash('sha256').update(`${connectionId}|${stepId}|${content}`).digest('hex');
  return { connectionId, stepId, promptOverride: content, revision };
}

type WorldOptions = {
  carrier?: unknown;
  markers?: unknown;
  crypto?: ReturnType<typeof cryptoWith>;
};

function makeRuntimeWorld(options: WorldOptions) {
  const committedWrites: string[] = [];
  const taskRow: Record<string, unknown> = {
    id: TASK_ID,
    operation_id: OPERATION_ID,
    task_key: 'root',
    kind: 'root',
    payload_ref: {},
    state: 'READY',
    attempt: 0,
    lease_epoch: 0,
    lease_expires_at: null,
    leased_by: null,
    last_delivery_id: null,
    tenant_id: TENANT_ID,
    business_id: BUSINESS_ID,
    business_version: '1.0.0',
    action: 'extract',
    input_ref: { body: 'offline' },
    deadline_at: null,
    manifest_digest: 'sha256:p745-offline',
    profile_id: PROFILE_ID,
    profile_revision: PROFILE_REVISION,
    connector_bindings: { primary: 'connector-a@3' },
    profile_policy_snapshot: null,
    prompt_revisions_pin: options.markers ?? null,
    prompt_overrides_ref: options.carrier ?? null,
    op_cancel_requested: false,
    op_state: 'ACCEPTED',
  };

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in p745 carrier claim test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const pendingWrites: string[] = [];
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<R>> => {
          if (/FROM tasks t/i.test(sql) && /JOIN operations o/i.test(sql)) {
            return queryResult<R>([taskRow]);
          }
          if (/SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([{ state: 'ACCEPTED' }]);
          }
          if (/FROM step_checkpoints/i.test(sql)) return queryResult<R>([]);
          if (/^\s*UPDATE /i.test(sql)) {
            pendingWrites.push(sql);
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }
          throw new Error(`unexpected transaction query in p745 carrier claim test: ${sql}`);
        },
      };
      const value = await fn(client as never);
      committedWrites.push(...pendingWrites);
      return value;
    },
    close: async () => undefined,
  } as unknown as Db;

  return { runtime: createRuntimeService(db, {} as never, options.crypto), committedWrites };
}

async function capturedOutput<T>(run: () => Promise<T>): Promise<{ value?: T; error?: unknown; text: string }> {
  const chunks: string[] = [];
  const intercept = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(intercept as typeof process.stdout.write);
  const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(intercept as typeof process.stderr.write);
  try {
    return { value: await run(), text: chunks.join('') };
  } catch (error) {
    return { error, text: chunks.join('') };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function claim(world: ReturnType<typeof makeRuntimeWorld>) {
  return capturedOutput(() => world.runtime.claimTask(TASK_ID, 'delivery-p745c', 'worker-p745c', BUSINESS_ID));
}

describe('P745-CARRIER claim — sealed carrier opened, cross-checked, delivered', () => {
  const provider = makeKeyProvider();
  const crypto = cryptoWith(provider);
  const rows = [row('extract_invoice', 'PROMPT-A'), row('_default', 'PROMPT-DEF')];
  const markerArray = rows.map((r) => ({ connectionId: r.connectionId, stepId: r.stepId, revision: r.revision }));

  async function sealedRows(list: PinnedPromptOverride[] = rows, slot: 'operations.prompt_overrides_ref' | 'operations.input_ref' = 'operations.prompt_overrides_ref') {
    return crypto.seal(list, { tenantId: TENANT_ID, slot, refId: OPERATION_ID });
  }

  it('opens the carrier and delivers pinned.promptOverrides with the marker map intact', async () => {
    const world = makeRuntimeWorld({ carrier: await sealedRows(), markers: markerArray, crypto });
    const claimed = await claim(world);
    expect(claimed.error).toBeUndefined();

    const pinned = claimed.value!.executionSnapshot.pinned as unknown as Record<string, unknown>;
    expect(pinned.promptOverrides).toEqual(rows);
    expect(pinned.promptRevisions).toEqual({
      [`${CONN_A}::extract_invoice`]: rows[0]!.revision,
      [`${CONN_A}::_default`]: rows[1]!.revision,
    });
    expect(world.committedWrites.length).toBeGreaterThan(0); // lease update committed
  });

  it('NULL carrier → promptOverrides null even with markers present (no-seam shape); claim succeeds', async () => {
    const world = makeRuntimeWorld({ carrier: null, markers: markerArray, crypto });
    const claimed = await claim(world);
    expect(claimed.error).toBeUndefined();
    const pinned = claimed.value!.executionSnapshot.pinned as unknown as Record<string, unknown>;
    expect(pinned.promptOverrides).toBeNull();
    expect(pinned.promptRevisions).toEqual({
      [`${CONN_A}::extract_invoice`]: rows[0]!.revision,
      [`${CONN_A}::_default`]: rows[1]!.revision,
    });
  });

  it('tampered CIPHERTEXT fails closed with AUTHENTICATION_FAILED and zero committed writes', async () => {
    const envelope = (await sealedRows()) as unknown as Record<string, unknown>;
    const ciphertext = String(envelope.ciphertext);
    envelope.ciphertext = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
    const world = makeRuntimeWorld({ carrier: envelope, markers: markerArray, crypto });
    const claimed = await claim(world);
    expect((claimed.error as { code?: string } | undefined)?.code).toBe('AUTHENTICATION_FAILED');
    expect(world.committedWrites).toHaveLength(0);
  });

  it('tampered TAG (ciphertext untouched) fails closed with AUTHENTICATION_FAILED and zero writes', async () => {
    const envelope = (await sealedRows()) as unknown as Record<string, unknown>;
    const tag = String(envelope.tag);
    envelope.tag = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
    const world = makeRuntimeWorld({ carrier: envelope, markers: markerArray, crypto });
    const claimed = await claim(world);
    expect((claimed.error as { code?: string } | undefined)?.code).toBe('AUTHENTICATION_FAILED');
    expect(world.committedWrites).toHaveLength(0);
  });

  it('CAPFIX caps: oversized carrier fails PROMPT_CARRIER_TOO_LARGE before the cross-check — zero writes', async () => {
    const markersOf = (list: PinnedPromptOverride[]) =>
      list.map((r) => ({ connectionId: r.connectionId, stepId: r.stepId, revision: r.revision }));
    const buildRows = (count: number, content: string) =>
      Array.from({ length: count }, (_, i) => row(`step-${String(i).padStart(3, '0')}`, content));

    // (a) row count cap: 65 rows.
    const tooManyRows = buildRows(65, 'x');
    const worldA = makeRuntimeWorld({
      carrier: await crypto.seal(tooManyRows, { tenantId: TENANT_ID, slot: 'operations.prompt_overrides_ref', refId: OPERATION_ID }),
      markers: markersOf(tooManyRows),
      crypto,
    });
    const claimedA = await claim(worldA);
    expect((claimedA.error as { code?: string } | undefined)?.code).toBe('PROMPT_CARRIER_TOO_LARGE');
    expect(worldA.committedWrites).toHaveLength(0);

    // (b) per-row cap: 16 KiB + 1 byte.
    const oversizeRow = buildRows(1, 'y'.repeat(16 * 1024 + 1));
    const worldB = makeRuntimeWorld({
      carrier: await crypto.seal(oversizeRow, { tenantId: TENANT_ID, slot: 'operations.prompt_overrides_ref', refId: OPERATION_ID }),
      markers: markersOf(oversizeRow),
      crypto,
    });
    const claimedB = await claim(worldB);
    expect((claimedB.error as { code?: string } | undefined)?.code).toBe('PROMPT_CARRIER_TOO_LARGE');
    expect(worldB.committedWrites).toHaveLength(0);

    // (c) total cap: 17 rows at exactly the per-row cap = 272 KiB > 256 KiB.
    const oversizeTotal = buildRows(17, 'z'.repeat(16 * 1024));
    const worldC = makeRuntimeWorld({
      carrier: await crypto.seal(oversizeTotal, { tenantId: TENANT_ID, slot: 'operations.prompt_overrides_ref', refId: OPERATION_ID }),
      markers: markersOf(oversizeTotal),
      crypto,
    });
    const claimedC = await claim(worldC);
    expect((claimedC.error as { code?: string } | undefined)?.code).toBe('PROMPT_CARRIER_TOO_LARGE');
    expect(worldC.committedWrites).toHaveLength(0);

    // (d) precedence pin: caps are checked BEFORE the marker cross-check — an
    // oversized carrier with DRIFTED markers still reports the size code.
    const drifted = markersOf(tooManyRows).slice(0, 3);
    const worldD = makeRuntimeWorld({
      carrier: await crypto.seal(tooManyRows, { tenantId: TENANT_ID, slot: 'operations.prompt_overrides_ref', refId: OPERATION_ID }),
      markers: drifted,
      crypto,
    });
    const claimedD = await claim(worldD);
    expect((claimedD.error as { code?: string } | undefined)?.code).toBe('PROMPT_CARRIER_TOO_LARGE');
    expect(worldD.committedWrites).toHaveLength(0);
  });

  it('marker/carrier drift fails closed with INVALID_SCHEMA and zero committed writes', async () => {
    const drifted = [...markerArray, { connectionId: CONN_A, stepId: 'ghost-step', revision: 'sha256:' + 'a'.repeat(64) }];
    const world = makeRuntimeWorld({ carrier: await sealedRows(), markers: drifted, crypto });
    const claimed = await claim(world);
    expect((claimed.error as { code?: string } | undefined)?.code).toBe('INVALID_SCHEMA');
    expect(world.committedWrites).toHaveLength(0);
  });

  it('an envelope sealed under ANOTHER slot is refused (CONTEXT_MISMATCH) — zero writes', async () => {
    const world = makeRuntimeWorld({ carrier: await sealedRows(rows, 'operations.input_ref'), markers: markerArray, crypto });
    const claimed = await claim(world);
    expect((claimed.error as { code?: string } | undefined)?.code).toBe('CONTEXT_MISMATCH');
    expect(world.committedWrites).toHaveLength(0);
  });

  it('carrier present under a deployment WITHOUT the key seam is refused (INVALID_SCHEMA) — zero writes', async () => {
    const world = makeRuntimeWorld({ carrier: await sealedRows(), markers: markerArray, crypto: undefined });
    const claimed = await claim(world);
    expect((claimed.error as { code?: string } | undefined)?.code).toBe('INVALID_SCHEMA');
    expect(world.committedWrites).toHaveLength(0);
  });

  it('sentinel: content is delivered ONLY in promptOverrides — never in logs; other fields stay clean', async () => {
    const secretRows = [row('extract_invoice', `confidential ${SENTINEL} prompt`)];
    const world = makeRuntimeWorld({
      carrier: await crypto.seal(secretRows, { tenantId: TENANT_ID, slot: 'operations.prompt_overrides_ref', refId: OPERATION_ID }),
      markers: secretRows.map((r) => ({ connectionId: r.connectionId, stepId: r.stepId, revision: r.revision })),
      crypto,
    });
    const claimed = await claim(world);
    expect(claimed.error).toBeUndefined();

    // Positive control: the content IS delivered where it belongs.
    const pinned = claimed.value!.executionSnapshot.pinned as unknown as Record<string, unknown>;
    expect(JSON.stringify(pinned.promptOverrides)).toContain(SENTINEL);
    expect(claimed.text).not.toContain(SENTINEL);
    const withoutCarrier = JSON.parse(JSON.stringify(pinned)) as Record<string, unknown>;
    delete withoutCarrier.promptOverrides;
    expect(JSON.stringify(withoutCarrier)).not.toContain(SENTINEL);
  });
});
