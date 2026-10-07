import { buildAdminOperationDetail, type AdminOperationDetailContext } from '../src/modules/operations/mappers';
import type { MetadataCrypto } from '../src/modules/runtime/metadata-crypto';

/**
 * FU-ENCMETA-ADMIN — the admin-bearer operation-detail projection must return
 * the SAME opaque result pointer the public R1 route returns, never the stored
 * sealed envelope.
 *
 * The seam is a faithful fake over the two members `readStoredText` actually
 * calls (`isSealed` then `readStored`), so the assertion exercises the mapper's
 * own code path — slot, tenant, refId and the projection — without re-proving
 * the crypto, which the RESULTREF suites already do.
 */

const OPAQUE = 'opaque-result-ref-abc123';
const ENVELOPE = JSON.stringify({ __sealed: 1, __plaintext: OPAQUE });

function fakeSeam(): MetadataCrypto {
  return {
    isSealed(v: unknown): boolean {
      return typeof v === 'object' && v !== null && (v as { __sealed?: unknown }).__sealed === 1;
    },
    async readStored(v: unknown): Promise<unknown> {
      return (v as { __plaintext?: unknown }).__plaintext;
    },
  } as unknown as MetadataCrypto;
}

function ctx(opts: { resultRef: string | null; seam: boolean; state?: string }): AdminOperationDetailContext {
  const op = {
    id: 'op-1',
    tenant_id: 'tenant-1',
    state: opts.state ?? 'SUCCEEDED',
    result_ref: opts.resultRef,
  };
  return {
    db: { query: async () => ({ rows: [] }) },
    runtime: { getOperation: async () => op },
    usage: { project: async () => ({}) },
    metadataCrypto: opts.seam ? fakeSeam() : undefined,
  } as unknown as AdminOperationDetailContext;
}

describe('FU-ENCMETA-ADMIN buildAdminOperationDetail result projection', () => {
  it('seam ON + sealed envelope -> returns the OPENED opaque pointer, never the envelope', async () => {
    const out = await buildAdminOperationDetail(ctx({ resultRef: ENVELOPE, seam: true }), 'op-1');
    const result = out.result as { data?: { resultRef?: string } };
    expect(result.data?.resultRef).toBe(OPAQUE);
    expect(JSON.stringify(out)).not.toContain('__sealed');
  });

  it('seam OFF -> legacy plaintext value verbatim (backfill-window convention)', async () => {
    const out = await buildAdminOperationDetail(ctx({ resultRef: 'legacy-plaintext-ref', seam: false }), 'op-1');
    const result = out.result as { data?: { resultRef?: string } };
    expect(result.data?.resultRef).toBe('legacy-plaintext-ref');
  });

  it('seam ON + legacy plaintext row -> still verbatim (allowPlaintext window)', async () => {
    const out = await buildAdminOperationDetail(ctx({ resultRef: 'legacy-plaintext-ref', seam: true }), 'op-1');
    const result = out.result as { data?: { resultRef?: string } };
    expect(result.data?.resultRef).toBe('legacy-plaintext-ref');
  });

  it('non-terminal operation -> result stays null', async () => {
    const out = await buildAdminOperationDetail(
      ctx({ resultRef: ENVELOPE, seam: true, state: 'RUNNING' }),
      'op-1',
    );
    expect(out.result).toBeNull();
  });

  it('null result_ref -> empty data object', async () => {
    const out = await buildAdminOperationDetail(ctx({ resultRef: null, seam: true }), 'op-1');
    const result = out.result as { data?: Record<string, unknown> };
    expect(result.data).toEqual({});
  });
});
