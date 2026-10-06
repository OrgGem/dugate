import {
  dispatchWithAuth,
  createOutboundAuthSession,
  OutboundAuthError,
} from '../src/modules/webhooks/outbound-auth';
import {
  OAuth2Error,
  OAuth2TokenClient,
  oauth2CacheKey,
  type OAuth2ClientCredentialsConfig,
} from '../src/modules/webhooks/oauth2-client';

/**
 * CB-03 (PROFILE-CALLBACK-20261006) focused tests. Offline: a mocked token
 * server (injected fetch) and in-memory clocks only.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
  body: string;
  headers: Record<string, string>;
}

function makeTokenServer(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = typeof init?.body === 'string' ? init.body : '';
    const call: FetchCall = { url, init: init ?? {}, body, headers };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

const TOKEN_URL = 'https://auth.example.com/oauth2/token';
const CLIENT_ID = 'client-id-public';
const CLIENT_SECRET = 'client-secret-SENTINEL-1';

function baseConfig(overrides: Partial<OAuth2ClientCredentialsConfig> = {}): OAuth2ClientCredentialsConfig {
  return {
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    authMethod: 'client_secret_basic',
    ...overrides,
  };
}

describe('CB-03 OAuth2 client credentials client', () => {
  it('uses client_secret_basic, form body, no redirects, and caches the token', async () => {
    const { fetchImpl, calls } = makeTokenServer(() =>
      jsonResponse({ access_token: 'tok-1', token_type: 'bearer', expires_in: 3600 }));
    const client = new OAuth2TokenClient(baseConfig({ scope: 'callbacks.write', audience: 'du-callbacks' }), { tenantId: 't1' }, {
      fetchImpl,
      now: () => 1_000_000,
    });

    expect(await client.getToken()).toBe('tok-1');
    expect(await client.getToken()).toBe('tok-1');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const expectedBasic = Buffer.from(
      encodeURIComponent(CLIENT_ID) + ':' + encodeURIComponent(CLIENT_SECRET),
      'utf8',
    ).toString('base64');
    expect(call.headers.authorization).toBe('Basic ' + expectedBasic);
    const form = new URLSearchParams(call.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('callbacks.write');
    expect(form.get('audience')).toBe('du-callbacks');
    // The URL itself never carries credentials or tokens.
    expect(call.url).toBe(TOKEN_URL);
    expect(call.body).not.toContain('grant_type=x');
    expect(form.get('client_secret')).toBeNull();
  });

  it('supports client_secret_post without an Authorization header', async () => {
    const { fetchImpl, calls } = makeTokenServer(() =>
      jsonResponse({ access_token: 'tok-post', token_type: 'Bearer', expires_in: 60 }));
    const client = new OAuth2TokenClient(
      baseConfig({ authMethod: 'client_secret_post' }),
      { tenantId: 't1' },
      { fetchImpl },
    );
    await client.getToken();
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('client_secret')).toBe(CLIENT_SECRET);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('renews before expiry with the configured clock skew', async () => {
    let now = 0;
    const { fetchImpl, calls } = makeTokenServer((_call, index) =>
      jsonResponse({ access_token: `tok-${index + 1}`, token_type: 'Bearer', expires_in: 60 }));
    const client = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, {
      fetchImpl,
      now: () => now,
      renewSkewSeconds: 30,
    });

    expect(await client.getToken()).toBe('tok-1');
    now = 29_000;
    expect(await client.getToken()).toBe('tok-1');
    now = 31_000;
    expect(await client.getToken()).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  it('does not cache indefinitely when the provider omits expires_in', async () => {
    const { fetchImpl, calls } = makeTokenServer((_call, index) =>
      jsonResponse({ access_token: `tok-${index + 1}`, token_type: 'Bearer' }));
    const client = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, { fetchImpl });

    expect(await client.getToken()).toBe('tok-1');
    expect(await client.getToken()).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  it('honours an explicit assumed-lifetime policy for providers without expires_in', async () => {
    const { fetchImpl, calls } = makeTokenServer(() =>
      jsonResponse({ access_token: 'tok-assumed', token_type: 'Bearer' }));
    const client = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, {
      fetchImpl,
      now: () => 5_000,
      missingExpiresIn: { mode: 'assume-seconds', seconds: 120 },
    });

    expect(await client.getToken()).toBe('tok-assumed');
    expect(await client.getToken()).toBe('tok-assumed');
    expect(calls).toHaveLength(1);
  });

  it('single-flights concurrent acquisitions', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const { fetchImpl, calls } = makeTokenServer(() => pending);
    const client = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, { fetchImpl });

    const first = client.getToken();
    const second = client.getToken();
    release(jsonResponse({ access_token: 'tok-slow', token_type: 'Bearer', expires_in: 60 }));
    expect(await first).toBe('tok-slow');
    expect(await second).toBe('tok-slow');
    expect(calls).toHaveLength(1);
  });

  it('validates token_type, access_token and expires_in, and bounds the response', async () => {
    const cases: Array<{ body: unknown; code: string }> = [
      { body: { access_token: 't', token_type: 'mac' }, code: 'TOKEN_TYPE_INVALID' },
      { body: { token_type: 'Bearer', expires_in: 60 }, code: 'TOKEN_RESPONSE_INVALID' },
      { body: { access_token: 't', token_type: 'Bearer', expires_in: '3600' }, code: 'TOKEN_RESPONSE_INVALID' },
      { body: { access_token: 't', token_type: 'Bearer', expires_in: 0 }, code: 'TOKEN_RESPONSE_INVALID' },
    ];
    for (const entry of cases) {
      const { fetchImpl } = makeTokenServer(() => jsonResponse(entry.body));
      const client = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, { fetchImpl });
      await expect(client.getToken()).rejects.toMatchObject({ name: 'OAuth2Error', code: entry.code });
    }
    const { fetchImpl } = makeTokenServer(() => jsonResponse({ access_token: 't', token_type: 'Bearer', expires_in: 60 }));
    const tiny = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, { fetchImpl, maxResponseBytes: 8 });
    await expect(tiny.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });

    const badJson = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, {
      fetchImpl: async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(badJson.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_INVALID' });
  });

  it('retries bounded on transport/5xx failures and fails closed on 4xx', async () => {
    const retrying = makeTokenServer((_call, index) =>
      index === 0 ? jsonResponse({ error: 'temporarily_unavailable' }, 503)
        : jsonResponse({ access_token: 'tok-retry', token_type: 'Bearer', expires_in: 60 }));
    const client = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, {
      fetchImpl: retrying.fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    expect(await client.getToken()).toBe('tok-retry');
    expect(retrying.calls).toHaveLength(2);

    const alwaysFive = makeTokenServer(() => jsonResponse({ error: 'server_error' }, 500));
    const failing = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, {
      fetchImpl: alwaysFive.fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    await expect(failing.getToken()).rejects.toMatchObject({ code: 'TOKEN_HTTP_ERROR', status: 500 });
    expect(alwaysFive.calls).toHaveLength(2);

    const badRequest = makeTokenServer(() => jsonResponse({ error: 'invalid_client' }, 400));
    const denied = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, {
      fetchImpl: badRequest.fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    await expect(denied.getToken()).rejects.toMatchObject({ code: 'TOKEN_HTTP_ERROR', status: 400 });
    expect(badRequest.calls).toHaveLength(1);
  });

  it('treats a redirect refusal as a transport failure and never follows it', async () => {
    const { fetchImpl, calls } = makeTokenServer((_call, _index) => {
      const error = new TypeError('redirect mode is set to error');
      throw error;
    });
    const client = new OAuth2TokenClient(baseConfig(), { tenantId: 't1' }, { fetchImpl, maxAttempts: 1 });
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it('requires https unless the internal HTTP exception is explicit', async () => {
    const config = baseConfig({ tokenUrl: 'http://auth.internal/token' });
    const okFetch = async () => jsonResponse({ access_token: 't', token_type: 'Bearer', expires_in: 60 });
    expect(() => new OAuth2TokenClient(config, { tenantId: 't1' }, { fetchImpl: okFetch }))
      .toThrow(expect.objectContaining({ code: 'TOKEN_URL_INVALID' }));

    const allowed = makeTokenServer(() => jsonResponse({ access_token: 'tok-http', token_type: 'Bearer', expires_in: 60 }));
    const internal = new OAuth2TokenClient(config, { tenantId: 't1' }, {
      fetchImpl: allowed.fetchImpl,
      allowInsecureHttp: true,
    });
    expect(await internal.getToken()).toBe('tok-http');
  });

  it('reacquires after invalidate(), resolving a rotated client secret at fetch time', async () => {
    let secret = 'secret-generation-1';
    const { fetchImpl, calls } = makeTokenServer((_call, index) =>
      jsonResponse({ access_token: `tok-${index + 1}`, token_type: 'Bearer', expires_in: 600 }));
    const client = new OAuth2TokenClient(baseConfig({
      clientSecret: async () => secret,
    }), { tenantId: 't1' }, { fetchImpl });

    expect(await client.getToken()).toBe('tok-1');
    secret = 'secret-generation-2';
    client.invalidate();
    expect(await client.getToken()).toBe('tok-2');
    expect(calls).toHaveLength(2);
    const second = Buffer.from(calls[1]!.headers.authorization!.slice('Basic '.length), 'base64').toString('utf8');
    expect(second).toContain(encodeURIComponent('secret-generation-2'));
  });

  it('scopes cache keys by tenant/profile/revision/endpoint/generation without secrets', () => {
    const keyA = oauth2CacheKey(baseConfig(), { tenantId: 't1', profileId: 'p1', profileRevision: 2, endpointKey: 'q', credentialGeneration: 1 });
    const keyB = oauth2CacheKey(baseConfig(), { tenantId: 't1', profileId: 'p1', profileRevision: 2, endpointKey: 'q', credentialGeneration: 2 });
    const keyC = oauth2CacheKey(baseConfig(), { tenantId: 't2', profileId: 'p1', profileRevision: 2, endpointKey: 'q', credentialGeneration: 1 });
    expect(new Set([keyA, keyB, keyC]).size).toBe(3);
    expect(keyA).not.toContain(CLIENT_SECRET);
  });
});

/* ---------------- outbound auth helper ---------------- */

const TOKEN_OK = { access_token: 'access-token-SENTINEL-2', token_type: 'Bearer', expires_in: 600 };

describe('CB-03 outbound auth session', () => {
  it('none attaches nothing', async () => {
    const session = createOutboundAuthSession({ mode: 'none' }, { resolveSecret: async () => 'x' });
    expect(await session.headersForAttempt()).toEqual({});
    expect(session.canReacquireOn401).toBe(false);
  });

  it('configured_headers resolves references per attempt with validated prefixes', async () => {
    let generation = 0;
    const refs: string[] = [];
    const session = createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [
        { name: 'Authorization', secretRef: 'vault:kv/du/cb3#token', prefix: 'Bearer ' },
        { name: 'X-API-Key', secretRef: 'vault:kv/du/cb3#key' },
      ],
    }, {
      resolveSecret: async (ref) => {
        refs.push(ref);
        generation += 1;
        return `secret-generation-${generation}`;
      },
    });

    expect(await session.headersForAttempt()).toEqual({
      authorization: 'Bearer secret-generation-1',
      'x-api-key': 'secret-generation-2',
    });
    expect(await session.headersForAttempt()).toEqual({
      authorization: 'Bearer secret-generation-3',
      'x-api-key': 'secret-generation-4',
    });
    expect(refs).toEqual([
      'vault:kv/du/cb3#token',
      'vault:kv/du/cb3#key',
      'vault:kv/du/cb3#token',
      'vault:kv/du/cb3#key',
    ]);
    expect(session.canReacquireOn401).toBe(false);
  });

  it('rejects disallowed, reserved, duplicate and CRLF-bearing header metadata', async () => {
    const resolve = async () => 'value';
    expect(() => createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [{ name: 'x-custom-auth', secretRef: 'ref' }],
    }, { resolveSecret: resolve })).toThrow(expect.objectContaining({ code: 'AUTH_POLICY_INVALID' }));
    expect(() => createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [{ name: 'content-type', secretRef: 'ref' }],
    }, { resolveSecret: resolve })).toThrow(expect.objectContaining({ code: 'HEADER_CONFLICT' }));
    expect(() => createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [
        { name: 'authorization', secretRef: 'ref-a' },
        { name: 'Authorization', secretRef: 'ref-b' },
      ],
    }, { resolveSecret: resolve })).toThrow(expect.objectContaining({ code: 'HEADER_CONFLICT' }));

    const session = createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [{ name: 'authorization', secretRef: 'ref' }],
    }, { resolveSecret: resolve });
    const crlf = createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [{ name: 'authorization', secretRef: 'ref' }],
    }, { resolveSecret: async () => 'bad\r\ninjected: 1' });
    await expect(crlf.headersForAttempt()).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });

    const failing = createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [{ name: 'authorization', secretRef: 'ref' }],
    }, { resolveSecret: async () => { throw new Error(`leak-${CLIENT_SECRET}`); } });
    await expect(failing.headersForAttempt()).rejects.toMatchObject({ code: 'SECRET_RESOLVE_FAILED' });
    await expect(failing.headersForAttempt().catch((error: OutboundAuthError) => error.message))
      .resolves.not.toContain(CLIENT_SECRET);
    expect(session.canReacquireOn401).toBe(false);
  });

  it('oauth2 session mints Bearer auth and merges validated nonsecret headers', async () => {
    const { fetchImpl, calls } = makeTokenServer(() => jsonResponse(TOKEN_OK));
    const session = createOutboundAuthSession({
      mode: 'oauth2_client_credentials',
      config: baseConfig(),
      extraHeaders: [{ name: 'x-correlation-id', value: 'corr-1' }],
    }, {
      resolveSecret: async () => { throw new Error('not used for a literal secret'); },
      cacheScope: { tenantId: 't1', profileId: 'p1', profileRevision: 3, endpointKey: 'callback', credentialGeneration: 1 },
      oauth2Options: { fetchImpl },
    });

    const headers = await session.headersForAttempt();
    expect(headers.authorization).toBe('Bearer access-token-SENTINEL-2');
    expect(headers['x-correlation-id']).toBe('corr-1');
    expect(calls[0]!.url).not.toContain('access-token');
    expect(session.canReacquireOn401).toBe(true);

    expect(() => createOutboundAuthSession({
      mode: 'oauth2_client_credentials',
      config: baseConfig(),
      extraHeaders: [{ name: 'authorization', value: 'Bearer fixed' }],
    }, { resolveSecret: async () => 'x', oauth2Options: { fetchImpl } }))
      .toThrow(expect.objectContaining({ code: 'HEADER_CONFLICT' }));
    expect(() => createOutboundAuthSession({
      mode: 'oauth2_client_credentials',
      config: baseConfig(),
      extraHeaders: [{ name: 'x-du-signature', value: 'forged' }],
    }, { resolveSecret: async () => 'x', oauth2Options: { fetchImpl } }))
      .toThrow(expect.objectContaining({ code: 'HEADER_CONFLICT' }));
  });

  it('maps token failures to a secret-free typed error', async () => {
    const session = createOutboundAuthSession({
      mode: 'oauth2_client_credentials',
      config: baseConfig(),
    }, {
      resolveSecret: async () => 'x',
      oauth2Options: {
        fetchImpl: async () => jsonResponse({ error_description: `bad ${CLIENT_SECRET}` }, 400),
      },
    });
    const failure = await session.headersForAttempt().catch((error: OutboundAuthError) => error);
    expect(failure).toBeInstanceOf(OutboundAuthError);
    expect(failure.code).toBe('TOKEN_ACQUISITION_FAILED');
    expect(failure.message).not.toContain(CLIENT_SECRET);
  });

  it('dispatchWithAuth reacquires exactly once on an invalid-token 401', async () => {
    let now = 0;
    const { fetchImpl, calls } = makeTokenServer((_call, index) =>
      jsonResponse({ access_token: `tok-${index + 1}`, token_type: 'Bearer', expires_in: 60 }));
    const session = createOutboundAuthSession({
      mode: 'oauth2_client_credentials',
      config: baseConfig(),
    }, {
      resolveSecret: async () => 'x',
      cacheScope: { tenantId: 't1' },
      oauth2Options: { fetchImpl, now: () => now, maxAttempts: 1 },
    });

    const statuses = [401, 200];
    const sent: Array<Record<string, string>> = [];
    const result = await dispatchWithAuth(session, async (headers) => {
      sent.push(headers);
      return { status: statuses[sent.length - 1]! };
    });

    expect(result).toEqual({ status: 200, attempts: 2 });
    expect(sent[0]!.authorization).toBe('Bearer tok-1');
    expect(sent[1]!.authorization).toBe('Bearer tok-2');
    expect(calls).toHaveLength(2);

    // A second 401 is returned as-is: no third attempt.
    const always401 = createOutboundAuthSession({
      mode: 'oauth2_client_credentials',
      config: baseConfig(),
    }, {
      resolveSecret: async () => 'x',
      cacheScope: { tenantId: 't2' },
      oauth2Options: { fetchImpl: makeTokenServer(() => jsonResponse(TOKEN_OK)).fetchImpl, maxAttempts: 1 },
    });
    let deliveries = 0;
    const denied = await dispatchWithAuth(always401, async () => {
      deliveries += 1;
      return { status: 401 };
    });
    expect(denied).toEqual({ status: 401, attempts: 2 });
    expect(deliveries).toBe(2);

    // Generic 403 never triggers reacquisition.
    const forbiddenSession = createOutboundAuthSession({
      mode: 'oauth2_client_credentials',
      config: baseConfig(),
    }, {
      resolveSecret: async () => 'x',
      cacheScope: { tenantId: 't3' },
      oauth2Options: { fetchImpl: makeTokenServer(() => jsonResponse(TOKEN_OK)).fetchImpl, maxAttempts: 1 },
    });
    let forbiddenDeliveries = 0;
    const forbidden = await dispatchWithAuth(forbiddenSession, async () => {
      forbiddenDeliveries += 1;
      return { status: 403 };
    });
    expect(forbidden).toEqual({ status: 403, attempts: 1 });
    expect(forbiddenDeliveries).toBe(1);
  });

  it('configured_headers never reacquires on 401', async () => {
    const session = createOutboundAuthSession({
      mode: 'configured_headers',
      headers: [{ name: 'x-api-key', secretRef: 'ref' }],
    }, { resolveSecret: async () => 'key-value' });
    let deliveries = 0;
    const result = await dispatchWithAuth(session, async () => {
      deliveries += 1;
      return { status: 401 };
    });
    expect(result).toEqual({ status: 401, attempts: 1 });
    expect(deliveries).toBe(1);
  });

  it('OAuth2Error carries codes without secrets (regression guard)', () => {
    const error = new OAuth2Error('TOKEN_HTTP_ERROR', 'token endpoint answered a non-success status', 500);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });
});
