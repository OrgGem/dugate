import { createHash, createHmac } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createSubmissionService, PROMPT_CARRIER_LIMITS } from '../src/modules/operations/submission';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { PromptOverrideService } from '../src/modules/profiles/prompt-overrides';
import type { RegistryService } from '../src/modules/registry/registry';
import { createMetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import type { PinnedPromptOverride, PromptOverrideRead } from '@du/contracts';

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1, adjudications 1a/1c/1d) — the producer half.
 *
 * The pin is written in ONE submit from ONE bucket read: non-secret markers
 * (`prompt_revisions_pin`) and, when the metadata seam is configured, a SEALED
 * content carrier (`prompt_overrides_ref`) whose envelope is bound to
 * (tenant, `operations.prompt_overrides_ref`, operationId). With no seam or no
 * rows the carrier is NULL — content never falls back to plaintext — and the
 * caps fail closed as 422 before anything is sealed or written.
 */

const TENANT = '7b000000-0000-4000-8000-000000000001';
const KEY = '7b000000-0000-4000-8000-000000000002';
const PROFILE_ID = '7b000000-0000-4000-8000-000000000003';
const REVISION = 7;
const CONN_A = '7b000000-0000-4000-8000-00000000000a';
const CONN_B = '7b000000-0000-4000-8000-00000000000b';
const KEY_REF = 'p745-carrier-producer-v1';
const SENTINEL = 'P745-CARRIER-SENTINEL-3f9d';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type Call = { sql: string; params: unknown[] };

function makeDb() {
  const calls: Call[] = [];
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(statement: string, params: unknown[] = []) => {
      calls.push({ sql: statement, params });
      if (/business_versions/i.test(statement)) {
        return result<T>([{
          version: '1.0.0',
          digest: 'sha256:test',
          queue: 'q',
          manifest: {
            actions: [{ name: 'ingest', inputSchema: { type: 'object' } }],
            runtime: { handlerKinds: ['root'] },
          },
        }]);
      }
      if (/FROM operations/i.test(statement)) {
        // submit() reloads the committed view after the tx; the canned row
        // keeps that read happy without modelling the table.
        return result<T>([{
          id: String(params[0] ?? '7b000000-0000-4000-8000-000000000099'),
          tenant_id: TENANT,
          business_id: 'demo',
          business_version: '1.0.0',
          action: 'ingest',
          state: 'ACCEPTED',
          state_version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deadline_at: null,
        }]);
      }
      return result<T>([]);
    },
    tx: async <T>(fn: (client: unknown) => Promise<T>) => fn({
      query: async (statement: string, params: unknown[] = []) => {
        calls.push({ sql: statement, params });
        return result([]);
      },
    }),
    close: async () => undefined,
  } as unknown as Db;
  return { db, calls };
}

/* Reversible deterministic Vault Transit stand-in (same shape as CRX-01). */
function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'p745-carrier').update(seed + ':' + block).digest();
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
function makeKeyProvider(opts: { failWrap?: boolean } = {}): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      if (opts.failWrap) throw new Error('vault transit unavailable');
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

function pinnedProfile() {
  return {
    mode: 'pinned' as const,
    profileId: PROFILE_ID,
    revision: REVISION,
    bindings: { slot: 'connector-1@2' },
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH' as const,
      allowedFileExtensions: '',
      connectionsOverride: [],
      fileUrlAuthConfig: null,
    },
    effectiveParameters: {},
    passthrough: {},
    effectiveInput: {},
    bullMqPriority: 1,
  };
}

function overrideRow(connectionId: string, stepId: string, promptOverride: string | null): PromptOverrideRead {
  return {
    connectionId,
    apiKeyId: KEY,
    endpointSlug: 'ingest',
    stepId,
    promptOverride,
    isActive: true,
    updatedAt: new Date().toISOString(),
  };
}

function service(
  db: Db,
  profile: unknown,
  options: { promptOverrides?: PromptOverrideService; metadataCrypto?: ReturnType<typeof cryptoWith> } = {}
) {
  const profiles = {
    resolveBinding: async () => ({ mode: 'legacy' as const }),
    resolveEffectiveProfile: async () => profile,
  } as unknown as ProfileService;
  return createSubmissionService(db, {} as RegistryService, profiles, {
    ...(options.promptOverrides ? { promptOverrides: options.promptOverrides } : {}),
    ...(options.metadataCrypto ? { metadataCrypto: options.metadataCrypto } : {}),
  });
}

function ctx() {
  return {
    tenantId: TENANT,
    apiKeyId: KEY,
    businessId: 'demo',
    action: 'ingest',
    submission: { input: { text: 'inline only' } },
  };
}

function mustCall(calls: Call[], pattern: RegExp): Call {
  const hit = calls.find((call) => pattern.test(call.sql));
  if (!hit) throw new Error(`no statement matched ${pattern}`);
  return hit;
}

function expectedRevision(connectionId: string, stepId: string, content: string): string {
  return 'sha256:' + createHash('sha256').update(`${connectionId}|${stepId}|${content}`).digest('hex');
}

function markersParam(calls: Call[]): unknown {
  return mustCall(calls, /INSERT INTO operations/i).params[16];
}

function carrierParam(calls: Call[]): unknown {
  return mustCall(calls, /INSERT INTO operations/i).params[17];
}

/** Deep scan incl. base64 — a sealed/encoded copy is still a leak. */
function leaks(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') {
    if (value.includes(SENTINEL)) return true;
    if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) {
      try {
        if (Buffer.from(value, 'base64').toString('utf8').includes(SENTINEL)) return true;
      } catch {
        /* not base64 */
      }
    }
    return false;
  }
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => leaks(v, depth + 1));
  return Object.values(value as Record<string, unknown>).some((v) => leaks(v, depth + 1));
}

describe('P745-CARRIER producer — sealed content carrier at submit', () => {
  it('writes markers AND a sealed carrier from the same bucket, openable under the carrier slot', async () => {
    const provider = makeKeyProvider();
    const rows = [
      overrideRow(CONN_B, 'step-2', 'PROMPT-B2'),
      overrideRow(CONN_A, 'extract_invoice', 'PROMPT-A'),
      overrideRow(CONN_A, '_default', 'PROMPT-DEFAULT'),
      overrideRow(CONN_A, 'cleared', null),
    ];
    const listFor = jest.fn(async () => rows);
    const { db, calls } = makeDb();
    await service(db, pinnedProfile(), {
      promptOverrides: { listFor } as unknown as PromptOverrideService,
      metadataCrypto: cryptoWith(provider),
    }).submit(ctx());

    expect(listFor).toHaveBeenCalledTimes(1);
    const markers = JSON.parse(String(markersParam(calls))) as Array<Record<string, string>>;
    expect(markers).toEqual([
      { connectionId: CONN_A, stepId: '_default', revision: expectedRevision(CONN_A, '_default', 'PROMPT-DEFAULT') },
      { connectionId: CONN_A, stepId: 'extract_invoice', revision: expectedRevision(CONN_A, 'extract_invoice', 'PROMPT-A') },
      { connectionId: CONN_B, stepId: 'step-2', revision: expectedRevision(CONN_B, 'step-2', 'PROMPT-B2') },
    ]);

    const envelope = JSON.parse(String(carrierParam(calls))) as Record<string, unknown>;
    expect(envelope.version).toBe(1);
    expect(envelope.algorithm).toBe('aes-256-gcm');

    // Positive control: the sentinel-bearing content is really IN the carrier.
    const opened = (await cryptoWith(provider).open(
      envelope as never,
      { tenantId: TENANT, slot: 'operations.prompt_overrides_ref', refId: String(mustCall(calls, /INSERT INTO operations/i).params[0]) }
    )) as PinnedPromptOverride[];
    expect(opened).toEqual([
      { connectionId: CONN_A, stepId: '_default', promptOverride: 'PROMPT-DEFAULT', revision: expectedRevision(CONN_A, '_default', 'PROMPT-DEFAULT') },
      { connectionId: CONN_A, stepId: 'extract_invoice', promptOverride: 'PROMPT-A', revision: expectedRevision(CONN_A, 'extract_invoice', 'PROMPT-A') },
      { connectionId: CONN_B, stepId: 'step-2', promptOverride: 'PROMPT-B2', revision: expectedRevision(CONN_B, 'step-2', 'PROMPT-B2') },
    ]);
    // Cleared rows pin nothing in either shape.
    expect(opened.some((row) => row.stepId === 'cleared')).toBe(false);
  });

  it('plants a sentinel in the content: it survives nowhere in any bound value (incl. base64)', async () => {
    const provider = makeKeyProvider();
    const rows = [overrideRow(CONN_A, 'step', `confidential ${SENTINEL} instructions`)];
    const { db, calls } = makeDb();
    await service(db, pinnedProfile(), {
      promptOverrides: { listFor: async () => rows } as unknown as PromptOverrideService,
      metadataCrypto: cryptoWith(provider),
    }).submit(ctx());

    for (const call of calls) {
      expect(leaks(call.params)).toBe(false);
    }
  });

  it('legacy-mode submit keeps BOTH pins NULL', async () => {
    const listFor = jest.fn(async () => [overrideRow(CONN_A, 'step', 'x')]);
    const { db, calls } = makeDb();
    await service(db, { mode: 'legacy' }, {
      promptOverrides: { listFor } as unknown as PromptOverrideService,
      metadataCrypto: cryptoWith(makeKeyProvider()),
    }).submit(ctx());
    expect(markersParam(calls)).toBeNull();
    expect(carrierParam(calls)).toBeNull();
    expect(listFor).not.toHaveBeenCalled();
  });

  it('no-seam deployment (adjudication 1c): markers written, carrier NULL — never plaintext', async () => {
    const rows = [overrideRow(CONN_A, 'step', 'content-that-must-not-be-plaintext')];
    const { db, calls } = makeDb();
    await service(db, pinnedProfile(), {
      promptOverrides: { listFor: async () => rows } as unknown as PromptOverrideService,
    }).submit(ctx());
    expect(typeof markersParam(calls)).toBe('string');
    expect(carrierParam(calls)).toBeNull();
    // No INSERT anywhere may carry the prompt content in the clear.
    expect(leaks(calls.map((c) => c.params))).toBe(false);
  });

  it('key-provider failure aborts the submit with ZERO writes (seal runs before the tx)', async () => {
    const { db, calls } = makeDb();
    await expect(
      service(db, pinnedProfile(), {
        promptOverrides: { listFor: async () => [overrideRow(CONN_A, 'step', 'x')] } as unknown as PromptOverrideService,
        metadataCrypto: cryptoWith(makeKeyProvider({ failWrap: true })),
      }).submit(ctx())
    ).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
    expect(calls.some((call) => /INSERT INTO (operations|tasks|outbox)/i.test(call.sql))).toBe(false);
  });

  it('caps (adjudication 1d): too many rows / oversized row / oversized total fail 422 with zero writes', async () => {
    const base = (count: number, content: string) =>
      Array.from({ length: count }, (_, i) => overrideRow(CONN_A, `step-${String(i).padStart(3, '0')}`, content));

    const tooMany = makeDb();
    await expect(
      service(tooMany.db, pinnedProfile(), {
        promptOverrides: { listFor: async () => base(PROMPT_CARRIER_LIMITS.maxRows + 1, 'x') } as unknown as PromptOverrideService,
        metadataCrypto: cryptoWith(makeKeyProvider()),
      }).submit(ctx())
    ).rejects.toMatchObject({ code: 'PROMPT_CARRIER_TOO_LARGE' });
    expect(tooMany.calls.some((call) => /INSERT INTO (operations|tasks|outbox)/i.test(call.sql))).toBe(false);

    const oversizedRow = makeDb();
    await expect(
      service(oversizedRow.db, pinnedProfile(), {
        promptOverrides: { listFor: async () => base(1, 'y'.repeat(PROMPT_CARRIER_LIMITS.maxRowBytes + 1)) } as unknown as PromptOverrideService,
        metadataCrypto: cryptoWith(makeKeyProvider()),
      }).submit(ctx())
    ).rejects.toMatchObject({ code: 'PROMPT_CARRIER_TOO_LARGE' });

    // Each row is at the per-row cap, but the total exceeds the bucket cap.
    const oversizeTotal = makeDb();
    await expect(
      service(oversizeTotal.db, pinnedProfile(), {
        promptOverrides: { listFor: async () => base(17, 'z'.repeat(PROMPT_CARRIER_LIMITS.maxRowBytes)) } as unknown as PromptOverrideService,
        metadataCrypto: cryptoWith(makeKeyProvider()),
      }).submit(ctx())
    ).rejects.toMatchObject({ code: 'PROMPT_CARRIER_TOO_LARGE' });
    expect(oversizeTotal.calls.some((call) => /INSERT INTO (operations|tasks|outbox)/i.test(call.sql))).toBe(false);
  });

  it('immutability: a later bucket edit changes NEW submits, the captured old carrier stays byte-identical', async () => {
    const provider = makeKeyProvider();
    const before = [overrideRow(CONN_A, 'step', 'BEFORE')];
    const first = makeDb();
    await service(first.db, pinnedProfile(), {
      promptOverrides: { listFor: async () => before } as unknown as PromptOverrideService,
      metadataCrypto: cryptoWith(provider),
    }).submit(ctx());
    const oldCarrier = String(carrierParam(first.calls));

    const after = [overrideRow(CONN_A, 'step', 'AFTER')];
    const second = makeDb();
    await service(second.db, pinnedProfile(), {
      promptOverrides: { listFor: async () => after } as unknown as PromptOverrideService,
      metadataCrypto: cryptoWith(provider),
    }).submit(ctx());
    const newCarrier = String(carrierParam(second.calls));

    expect(newCarrier).not.toBe(oldCarrier);
    const openedOld = (await cryptoWith(provider).open(
      JSON.parse(oldCarrier) as never,
      { tenantId: TENANT, slot: 'operations.prompt_overrides_ref', refId: String(mustCall(first.calls, /INSERT INTO operations/i).params[0]) }
    )) as PinnedPromptOverride[];
    expect(openedOld[0]?.promptOverride).toBe('BEFORE');
  });
});
