import { createHash } from 'node:crypto';
import { createVaultKv2HttpSecretWriter, type VaultKv2SecretWritePlan } from '../src/vault/writer';
import type { RenewalDaemon } from '../src/vault/token-renewal';

const SECRET = 'synthetic-provider-secret-01';
const HASH = createHash('sha256').update(SECRET).digest('hex');
const PLAN: VaultKv2SecretWritePlan = {
  account: 'recipe',
  mount: 'secret',
  path: 'accounts/tenant-a/connectors/openai-primary',
  key: 'api-key',
  expectedVersion: 5,
  targetVersion: 6,
  secretSha256: HASH,
};
const SCOPE = { mount: 'secret', pathPrefix: 'accounts/tenant-a/connectors' };

function daemon(): RenewalDaemon {
  return {
    start: async () => undefined,
    stop: () => undefined,
    runOnce: async () => 'authenticated',
    current: () => ({ value: 'hvs.synthetic-writer-token', expiresAtMs: Date.now() + 60_000 }),
    state: () => 'active',
    nextAttemptAtMs: () => undefined,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function writer(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, overrides: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  return createVaultKv2HttpSecretWriter({
    address: 'https://vault.synthetic.test:8200',
    namespace: 'synthetic-team',
    allowedScopes: [SCOPE],
    daemon: daemon(),
    fetchImpl,
    ...overrides,
  });
}

describe('ORV14 scoped Vault KV v2 writer plan', () => {
  it('projects a complete write plan to a strict destination ref and sends one CAS write', async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const client = writer(async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (init?.method === 'GET' && url.searchParams.get('version') === '6') {
        return new Response(null, { status: 404 });
      }
      if (init?.method === 'POST') return jsonResponse({ data: { version: 6 } });
      throw new Error('unexpected synthetic Vault request');
    });

    await expect(client.writePlanned(PLAN, SECRET)).resolves.toBe(6);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.toString()).toBe(
      'https://vault.synthetic.test:8200/v1/secret/data/accounts/tenant-a/connectors/openai-primary?version=6',
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      accept: 'application/json',
      'x-vault-token': 'hvs.synthetic-writer-token',
      'x-vault-namespace': 'synthetic-team',
    });
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[1]?.url.toString()).toBe(
      'https://vault.synthetic.test:8200/v1/secret/data/accounts/tenant-a/connectors/openai-primary',
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      options: { cas: 5 },
      data: { 'api-key': SECRET },
    });
    expect(calls[1]?.init?.redirect).toBe('error');
  });

  it('reconciles a committed write after the response is lost without issuing a second KV write', async () => {
    let stored: string | undefined;
    let posts = 0;
    const client = writer(async (_input, init) => {
      if (init?.method === 'GET') {
        return stored === undefined
          ? new Response(null, { status: 404 })
          : jsonResponse({ data: { data: { 'api-key': stored }, metadata: { version: 6 } } });
      }
      posts += 1;
      stored = SECRET; // Vault committed, but the synthetic response transport is lost.
      throw new Error('synthetic response lost after commit');
    });

    await expect(client.writePlanned(PLAN, SECRET)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', safeToRetry: true,
    });
    await expect(client.writePlanned(PLAN, SECRET)).resolves.toBe(6);
    expect(posts).toBe(1);
  });

  it.each([
    ['malformed account', { ...PLAN, account: 'Recipe' }, SECRET, 'INVALID_INPUT'],
    ['malformed mount', { ...PLAN, mount: 'secret/child' }, SECRET, 'INVALID_INPUT'],
    ['malformed path', { ...PLAN, path: 'accounts/tenant-a/../other' }, SECRET, 'INVALID_INPUT'],
    ['malformed key', { ...PLAN, key: 'bad/key' }, SECRET, 'INVALID_INPUT'],
    ['outside path scope', { ...PLAN, path: 'accounts/tenant-b/connectors/other' }, SECRET, 'BINDING_DENIED'],
    ['CAS target mismatch', { ...PLAN, targetVersion: 7 }, SECRET, 'BINDING_DENIED'],
    ['negative source and zero target version', { ...PLAN, expectedVersion: -1, targetVersion: 0 }, SECRET, 'BINDING_DENIED'],
    ['out of range version', { ...PLAN, expectedVersion: 2_147_483_647, targetVersion: 2_147_483_648 }, SECRET, 'BINDING_DENIED'],
    ['credential digest mismatch', { ...PLAN, secretSha256: '0'.repeat(64) }, SECRET, 'BINDING_DENIED'],
  ] as const)('%s fails before Vault transport', async (_label, plan, secret, code) => {
    const fetchImpl = jest.fn(async () => jsonResponse({ data: { version: 6 } }));
    await expect(writer(fetchImpl).writePlanned(plan as VaultKv2SecretWritePlan, secret))
      .rejects.toMatchObject({ code });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels a streamed response at the byte limit instead of buffering it to completion', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(128))); },
      cancel() { cancelled = true; },
    });
    const client = writer(async () => new Response(body, { status: 200 }), { maxResponseBytes: 32 });

    await expect(client.currentVersion(PLAN)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    expect(cancelled).toBe(true);
  });

  it('keeps the deadline active through body reading and cancels a stalled stream', async () => {
    let cancelled = false;
    let requestSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const client = writer(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(body, { status: 200 });
    }, { timeoutMs: 20 });

    await expect(client.currentVersion(PLAN)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', safeToRetry: true,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
});
