import assert from 'node:assert/strict';
import { handlePublicRoutes } from '../../../services/orchestrator/src/http/routes/public';
import type { RouteContext } from '../../../services/orchestrator/src/http/route-context';

const OPAQUE = 'opaque-result-ref-vfy802';
const ENVELOPE_MARKER = '__sealed';
const ENVELOPE = JSON.stringify({ [ENVELOPE_MARKER]: 1, __plaintext: OPAQUE });
const bindingSeen: Array<{ tenantId: string; slot: string; refId: string; allowPlaintext: boolean }> = [];

const fakeMetadataCrypto = {
  isSealed(value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[ENVELOPE_MARKER] === 1;
  },
  async readStored(
    value: unknown,
    binding: { tenantId: string; slot: string; refId: string },
    allowPlaintext: boolean,
  ): Promise<unknown> {
    bindingSeen.push({ ...binding, allowPlaintext });
    return (value as { __plaintext?: unknown }).__plaintext;
  },
};

function context(resultRef: string, withSeam: boolean): RouteContext {
  return {
    method: 'GET',
    pathname: '/api/v1/operations/op-vfy802',
    searchParams: new URLSearchParams(),
    headers: { authorization: 'Bearer platform-admin-token' },
    rawBody: Buffer.alloc(0),
    correlationId: 'vfy802-route',
    config: { adminToken: 'platform-admin-token' },
    db: { query: async () => ({ rows: [] }) },
    runtime: {
      getOperation: async () => ({
        id: 'op-vfy802',
        tenant_id: 'tenant-vfy802',
        state: 'SUCCEEDED',
        result_ref: resultRef,
      }),
    },
    usage: { project: async () => ({}) },
    ...(withSeam ? { metadataCrypto: fakeMetadataCrypto } : {}),
  } as unknown as RouteContext;
}

async function main(): Promise<void> {
  const enabled = await handlePublicRoutes(context(ENVELOPE, true));
  assert.equal(enabled?.status, 200);
  const enabledWire = JSON.stringify(enabled?.body);
  assert.equal(
    (enabled?.body as { result: { data: { resultRef: string } } }).result.data.resultRef,
    OPAQUE,
  );
  assert.ok(!enabledWire.includes(ENVELOPE_MARKER), 'serialized metadata envelope must never reach admin wire');
  assert.deepEqual(bindingSeen, [
    { tenantId: 'tenant-vfy802', slot: 'operations.result_ref', refId: 'op-vfy802', allowPlaintext: false },
  ]);

  const disabled = await handlePublicRoutes(context('legacy-plaintext-vfy802', false));
  assert.equal(disabled?.status, 200);
  assert.equal(
    (disabled?.body as { result: { data: { resultRef: string } } }).result.data.resultRef,
    'legacy-plaintext-vfy802',
  );

  console.log('ADMIN_BEARER_GET /api/v1/operations/:id seam=ON: PASS; opaque ref returned; serialized envelope absent');
  console.log('ADMIN_BEARER_GET /api/v1/operations/:id seam=OFF: PASS; legacy value verbatim');
  console.log('OPEN_BINDING: tenant-vfy802 / operations.result_ref / op-vfy802 / allowPlaintext=false');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
