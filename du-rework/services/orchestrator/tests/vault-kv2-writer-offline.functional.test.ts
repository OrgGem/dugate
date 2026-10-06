import { createVaultKv2CredentialWriter } from '../src/modules/connector-credentials/vault-kv2-writer';

/**
 * CREDWORKFLOW-IMPL — the production Vault KV2 writer.
 *
 * Offline: a scripted fetch stands in for Vault. Pins the wire (literal body,
 * mount/URL, header), the failure matrix as `{code, retryable}` (the exact
 * pairs `workflow.refIssue` maps to typed HTTP answers), and — load-bearing —
 * that no failure path ever carries the secret in its message.
 */

const SENTINEL = 'CREDWORKFLOW-SENTINEL-8f31';
const REF = { account: 'a1', mount: 'secret', path: 'du/tenants/t1/connectors/c1/accounts/a1', key: 'api_key' };
const VAULT = 'http://vault.test:8200';

type Call = { url: string; method: string; body?: unknown; headers?: Record<string, string> };

function scriptedFetch(handler: (url: string) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? undefined,
    });
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status }) as unknown as Response;
}

function writer(fetchImpl: typeof fetch, opts: { token?: () => string } = {}) {
  return createVaultKv2CredentialWriter({
    vaultAddress: VAULT,
    token: opts.token ?? (() => 'writer-token'),
    fetchImpl,
  });
}

describe('CREDWORKFLOW-IMPL Vault KV2 writer', () => {
  it('writeCas: exact wire — URL, token header, literal body with CAS option', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(200, { data: { version: 7 } }));
    const version = await writer(fetchImpl).writeCas(REF, SENTINEL, 3);
    expect(version).toBe(7);
    expect(calls[0]).toEqual({
      url: `${VAULT}/v1/secret/data/du/tenants/t1/connectors/c1/accounts/a1`,
      method: 'POST',
      body: { data: { api_key: SENTINEL }, options: { cas: 3 } },
      headers: { 'content-type': 'application/json', 'x-vault-token': 'writer-token' },
    });
  });

  it('writeCas without cas omits the options block entirely', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => json(200, { data: { version: 1 } }));
    await writer(fetchImpl).writeCas(REF, 'v');
    expect((calls[0]!.body as Record<string, unknown>)).toEqual({ data: { api_key: 'v' } });
  });

  it('failure matrix: {code, retryable} pairs exactly as refIssue expects — no secret in any message', async () => {
    const cases: Array<[Response, string, boolean]> = [
      [json(412, { errors: ['check-and-set parameter did not match'] }), 'CAS_CONFLICT', false],
      [json(403, { errors: ['permission denied'] }), 'CAPABILITY_DENIED', false],
      [json(401, {}), 'VAULT_NO_TOKEN', false],
      [json(500, {}), 'VAULT_SERVER_ERROR', true],
      [json(429, {}), 'VAULT_SERVER_ERROR', true],
      [json(400, {}), 'VAULT_WRITE_FAILED', false],
      [json(200, { data: {} }), 'VAULT_WRITE_FAILED', false],
    ];
    for (const [response, code, retryable] of cases) {
      const { fetchImpl } = scriptedFetch(() => response.clone());
      const err = await writer(fetchImpl)
        .writeCas(REF, SENTINEL)
        .then(
          () => undefined,
          (e: unknown) => e as { code?: string; retryable?: boolean; message?: string },
        );
      expect(err).toMatchObject({ code, retryable });
      expect(String(err?.message)).not.toContain(SENTINEL);
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(SENTINEL);
    }
  });

  it('network failure and timeout are retryable VAULT_UNAVAILABLE; missing identity is VAULT_NO_TOKEN', async () => {
    {
      const fetchImpl = (async () => {
        throw new Error('ECONNREFUSED ' + SENTINEL);
      }) as unknown as typeof fetch;
      const err = await writer(fetchImpl)
        .writeCas(REF, SENTINEL)
        .then(() => undefined, (e) => e as { code?: string; retryable?: boolean; message?: string });
      expect(err).toMatchObject({ code: 'VAULT_UNAVAILABLE', retryable: true });
      expect(String(err?.message)).not.toContain(SENTINEL);
    }
    {
      const { fetchImpl } = scriptedFetch(() => json(200, {}));
      const err = await writer(fetchImpl, { token: () => '' })
        .writeCas(REF, SENTINEL)
        .then(() => undefined, (e) => e as { code?: string });
      expect(err).toMatchObject({ code: 'VAULT_NO_TOKEN' });
    }
    {
      const { fetchImpl } = scriptedFetch(() => json(200, {}));
      const err = await writer(fetchImpl, {
        token: () => {
          throw new Error('identity backend down: ' + SENTINEL);
        },
      })
        .writeCas(REF, SENTINEL)
        .then(() => undefined, (e) => e as { code?: string; message?: string });
      expect(err).toMatchObject({ code: 'VAULT_NO_TOKEN' });
      expect(String(err?.message)).not.toContain(SENTINEL);
    }
  });

  it('real timeout: the AbortController actually fires, it is measured, and the secret never appears', async () => {
    let sawSignal = false;
    let abortFired = false;
    const started = Date.now();
    // A hanging server: it never resolves on its own, so the ONLY way this
    // promise settles is the abort. That is what makes the test prove the
    // AbortController path instead of just catching a thrown ECONNREFUSED.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        sawSignal = signal instanceof AbortSignal;
        if (signal === undefined || signal === null) {
          reject(new Error('no AbortSignal was passed: ' + SENTINEL));
          return;
        }
        signal.addEventListener('abort', () => {
          abortFired = true;
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    const err = await createVaultKv2CredentialWriter({
      vaultAddress: VAULT,
      token: () => 'writer-token',
      fetchImpl,
      requestTimeoutMs: 60,
    })
      .writeCas(REF, SENTINEL, 1)
      .then(() => undefined, (e) => e as { code?: string; retryable?: boolean; message?: string });

    const elapsed = Date.now() - started;

    // The signal really reached fetch and really fired.
    expect(sawSignal).toBe(true);
    expect(abortFired).toBe(true);
    // It fired on the configured 60ms, not on the 5s default.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
    expect(err).toMatchObject({ code: 'VAULT_UNAVAILABLE', retryable: true });
    expect(String(err?.message)).not.toContain(SENTINEL);
  });

  it('readVersions: metadata GET exact shape; policy deny and invalid bodies fail closed', async () => {
    {
      const { fetchImpl, calls } = scriptedFetch(() =>
        json(200, { data: { current_version: 3, versions: [1, 3] } }),
      );
      await expect(writer(fetchImpl).readVersions(REF)).resolves.toEqual({ current_version: 3, versions: [1, 3] });
      expect(calls[0]).toMatchObject({
        url: `${VAULT}/v1/secret/metadata/du/tenants/t1/connectors/c1/accounts/a1`,
        method: 'GET',
      });
    }
    {
      const { fetchImpl } = scriptedFetch(() => json(403, {}));
      await expect(writer(fetchImpl).readVersions(REF)).rejects.toMatchObject({ code: 'PREFIX_DENIED', retryable: false });
    }
    {
      const { fetchImpl } = scriptedFetch(() => json(200, { data: { current_version: 'nope' } }));
      await expect(writer(fetchImpl).readVersions(REF)).rejects.toMatchObject({ code: 'VAULT_METADATA_FAILED' });
    }
  });
});
