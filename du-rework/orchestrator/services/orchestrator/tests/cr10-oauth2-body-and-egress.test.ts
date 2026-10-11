import { OAuth2TokenClient, type OAuth2ClientCredentialsConfig } from '../src/modules/webhooks/oauth2-client';
import { createPinnedFetch } from '@du/egress';
import { BoundaryListener, waitFor } from '../../../../tests/harness/network-boundaries/mock-listener';

/**
 * CR10-03 + CR10-04 (CODE-REVIEW-FOLLOWUP-2026-10-10 section 2) focused tests.
 *
 * Offline only: loopback listeners from the shared network-boundaries harness plus
 * synthetic fetch/stream doubles. No live DB / Redis / S3, no real IdP, no real secret.
 *
 * CR10-03: the token response body stays bounded for its WHOLE life - the deadline and
 * the byte cap are enforced while reading, and the stream is cancelled instead of being
 * buffered to EOF. Synthetic doubles deliberately ignore the AbortSignal, so only the
 * client's own bounds can end them; the loopback cases exercise the real socket path.
 *
 * CR10-04: the production transport (no fetchImpl injected) is the shared pinned egress
 * (@du/egress): every DNS answer adjudicated, one resolution shared by policy and
 * connect, denied before connect, redirects never followed. Cases that inject fetchImpl
 * bypass egress by construction - that is the documented test seam.
 */

const CLIENT_ID = 'client-id-public';
const CLIENT_SECRET = 'client-secret-SENTINEL-CR10';
const ALLOW_LOOPBACK = new Set(['127.0.0.1']);

// Port band disjoint from 42000-42504 / 43000-43504 / 44000-44504 (listenLoopback
// retries +24 from here on EADDRINUSE).
const BASE_PORT = 45000 + (process.pid % 64) * 8;

// Every listener takes its own 32-port window. Node's global keep-alive agent keys
// pooled sockets by host:port, so after stop() destroyed a listener's sockets the NEXT
// test at the SAME origin could be handed the dead socket (observed as flapping
// ECONNRESET). Distinct origins per test remove that race entirely.
let portCursor = 0;
function startListener(): Promise<BoundaryListener> {
  const base = BASE_PORT + portCursor;
  portCursor += 32;
  return BoundaryListener.start(base);
}

function baseConfig(tokenUrl: string): OAuth2ClientCredentialsConfig {
  return { tokenUrl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, authMethod: 'client_secret_basic' };
}

function tokenBody(accessToken: string): string {
  return JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 600 });
}

interface ScriptedBody {
  status?: number;
  contentType?: string | null;
  contentLength?: string | null;
  chunks?: Uint8Array[];
  /** true = the body never ends (headers already arrived, no further chunk, ever). */
  stall?: boolean;
}

/**
 * Hand-rolled Response double: records every pull and cancel so the assertions can
 * witness HOW the read ended, not just that it ended.
 */
function scriptedResponse(script: ScriptedBody) {
  const state = { pulls: 0, cancels: 0, delivered: 0 };
  const chunks = script.chunks ?? [];
  let index = 0;
  const reader = {
    read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
      state.pulls += 1;
      if (script.stall === true) return new Promise<never>(() => undefined);
      if (index >= chunks.length) return Promise.resolve({ done: true });
      const value = chunks[index] as Uint8Array;
      index += 1;
      state.delivered += value.byteLength;
      return Promise.resolve({ done: false, value });
    },
    cancel: async (): Promise<void> => {
      state.cancels += 1;
    },
    releaseLock: (): void => undefined,
  };
  const response = {
    status: script.status ?? 200,
    headers: {
      get: (name: string): string | null => {
        const key = name.toLowerCase();
        if (key === 'content-type') return script.contentType === undefined ? 'application/json' : script.contentType;
        if (key === 'content-length') return script.contentLength ?? null;
        return null;
      },
    },
    body: {
      getReader: () => reader,
      cancel: async (): Promise<void> => {
        await reader.cancel();
      },
    },
    // What a real Response does: pull the stream to EOF, THEN hand over the text.
    text: async (): Promise<string> => {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    },
  } as unknown as Response;
  return { response, state };
}

describe('CR10-03 deadline and byte cap cover the whole token response body', () => {
  it('[CR10-03] body that never ends is aborted inside the deadline and the stream is cancelled', async () => {
    const { response, state } = scriptedResponse({ stall: true });
    const captured: { signal?: AbortSignal } = {};
    const client = new OAuth2TokenClient(baseConfig('https://idp.example.test/token'), { tenantId: 't1' }, {
      fetchImpl: async (_input, init) => {
        captured.signal = init?.signal as AbortSignal;
        return response;
      },
      timeoutMs: 80,
      maxAttempts: 1,
    });

    const startedAt = Date.now();
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(captured.signal).toBeDefined();
    expect(captured.signal?.aborted).toBe(true);
    expect(state.pulls).toBe(1);
    expect(state.cancels).toBe(1);
  });

  it('[CR10-03] a chunked body over the cap is cancelled mid-read, never buffered to EOF', async () => {
    const big = new Uint8Array(Buffer.alloc(32 * 1024, 0x61));
    const chunks = Array.from({ length: 32 }, () => big);
    const { response, state } = scriptedResponse({ chunks });
    const client = new OAuth2TokenClient(baseConfig('https://idp.example.test/token'), { tenantId: 't1' }, {
      fetchImpl: async () => response,
      maxResponseBytes: 1024,
      maxAttempts: 1,
    });

    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
    expect(state.pulls).toBeLessThanOrEqual(2);
    expect(state.delivered).toBeLessThanOrEqual(64 * 1024);
    expect(state.cancels).toBe(1);
  });

  it('[CR10-03] a body exactly at the cap is accepted and one byte over is refused', async () => {
    const padded = tokenBody('tok-exact') + ' '.repeat(64);
    const exactBytes = Buffer.byteLength(padded, 'utf8');
    const bytes = new Uint8Array(Buffer.from(padded, 'utf8'));

    const accepted = new OAuth2TokenClient(baseConfig('https://idp.example.test/token'), { tenantId: 't1' }, {
      fetchImpl: async () => scriptedResponse({ chunks: [bytes] }).response,
      maxResponseBytes: exactBytes,
      maxAttempts: 1,
    });
    expect(await accepted.getToken()).toBe('tok-exact');

    const refused = new OAuth2TokenClient(baseConfig('https://idp.example.test/token'), { tenantId: 't1' }, {
      fetchImpl: async () => scriptedResponse({ chunks: [bytes] }).response,
      maxResponseBytes: exactBytes - 1,
      maxAttempts: 1,
    });
    await expect(refused.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
  });

  it('[CR10-03] refused status / content-type / declared-length still release the body', async () => {
    const scripts: ScriptedBody[] = [
      { status: 500, contentType: 'application/json', contentLength: null },
      { status: 200, contentType: 'text/html', contentLength: null },
      { status: 200, contentType: 'application/json', contentLength: '999999' },
    ];
    for (const script of scripts) {
      const chunk = new Uint8Array(Buffer.from('x'.repeat(64), 'utf8'));
      const { response, state } = scriptedResponse({ ...script, chunks: [chunk] });
      const client = new OAuth2TokenClient(baseConfig('https://idp.example.test/token'), { tenantId: 't1' }, {
        fetchImpl: async () => response,
        maxAttempts: 1,
      });
      await expect(client.getToken()).rejects.toMatchObject({ name: 'OAuth2Error' });
      expect(state.cancels).toBe(1);
    }
  });

  it('[CR10-03] a real stalled body is torn down inside the deadline (production transport)', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({ kind: 'stallAfterHeaders', status: 200, headers: { 'content-type': 'application/json' } });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK }),
        allowInsecureHttp: true,
        timeoutMs: 250,
        maxAttempts: 1,
      });

      const startedAt = Date.now();
      await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(listener.requests).toBe(1);
      await waitFor(() => listener.closedWithoutFinish > 0, 3000);
    } finally {
      await listener.stop();
    }
  });

  it('[CR10-03] a real chunked body over the cap stops early instead of draining to EOF', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({
        kind: 'chunkedNoLength',
        chunkBytes: 16 * 1024,
        totalBytes: 1024 * 1024,
        // Paced so bytesWritten measures what the CLIENT consumed: without a gap the
        // kernel buffers absorb all 1 MiB before the cancel lands.
        chunkDelayMs: 1,
        headers: { 'content-type': 'application/json' },
      });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK }),
        allowInsecureHttp: true,
        maxResponseBytes: 1024,
        timeoutMs: 10_000,
        maxAttempts: 1,
      });

      await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
      await waitFor(() => listener.bytesWritten > 0, 3000);
      expect(listener.bytesWritten).toBeLessThan(256 * 1024);
      await waitFor(() => listener.closedWithoutFinish > 0, 3000);
    } finally {
      await listener.stop();
    }
  });

  it('[CR10-03] a well-formed token still flows through the production transport', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({ kind: 'respond', status: 200, headers: { 'content-type': 'application/json' }, body: tokenBody('tok-live') });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK }),
        allowInsecureHttp: true,
        timeoutMs: 5000,
        maxAttempts: 1,
      });

      expect(await client.getToken()).toBe('tok-live');
      expect(listener.requests).toBe(1);
      const recorded = listener.recordedRequests[0];
      expect(recorded).toBeDefined();
      expect(recorded?.method).toBe('POST');
      expect(String(recorded?.headers.authorization)).toContain('Basic ');
      expect(recorded?.bodyBytes ?? 0).toBeGreaterThan(0);
    } finally {
      await listener.stop();
    }
  });
});

describe('CR10-04 the production token transport is pinned egress, not global fetch', () => {
  it('[CR10-04] a loopback IP literal without the exact allowlist is denied before connect', async () => {
    const listener = await startListener();
    try {
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        allowInsecureHttp: true,
        timeoutMs: 5000,
        maxAttempts: 1,
      });

      const failure = await client.getToken().then(() => null, (error: unknown) => error as Error & { code?: string });
      expect(failure).not.toBeNull();
      expect(failure?.code).toBe('TOKEN_ENDPOINT_DENIED');
      expect(listener.requests).toBe(0);
      expect(String(failure?.message)).not.toContain(CLIENT_SECRET);
    } finally {
      await listener.stop();
    }
  });

  const BLOCKED_LITERAL_URLS = [
    'https://10.1.2.3/token',
    'https://192.168.1.10/token',
    'https://169.254.169.254/token',
    'https://100.64.0.1/token',
    'https://[::1]/token',
    'https://[fd12:3456::9]/token',
    'https://[fe80::1]/token',
  ];

  it('[CR10-04] private / loopback / link-local / metadata literals are denied before connect', async () => {
    for (const tokenUrl of BLOCKED_LITERAL_URLS) {
      const client = new OAuth2TokenClient(baseConfig(tokenUrl), { tenantId: 't1' }, {
        timeoutMs: 500,
        maxAttempts: 1,
      });
      const failure = await client.getToken().then(() => null, (error: unknown) => error as Error & { code?: string });
      expect({ tokenUrl, code: failure?.code }).toEqual({ tokenUrl, code: 'TOKEN_ENDPOINT_DENIED' });
      expect(String(failure?.message)).not.toContain(CLIENT_SECRET);
    }
  });

  const DNS_DENY_CASES: Array<{ host: string; answers: string[]; label: string }> = [
    { host: 'idp.example.test', answers: ['93.184.216.34', '127.0.0.1'], label: 'mixed public+loopback' },
    { host: 'idp.example.test', answers: ['10.0.0.7', '93.184.216.34'], label: 'RFC1918 among public answers' },
    { host: 'idp.example.test', answers: ['169.254.169.254'], label: 'cloud metadata answer' },
    { host: 'metadata.google.internal', answers: ['169.254.169.254'], label: 'metadata hostname' },
    { host: 'idp.example.test', answers: ['fd12:3456::9'], label: 'IPv6 ULA answer' },
    { host: 'idp.example.test', answers: ['fe80::1'], label: 'IPv6 link-local answer' },
    { host: 'idp.example.test', answers: ['100.64.0.1'], label: 'CGNAT answer' },
  ];

  it('[CR10-04] every DNS answer is adjudicated: one blocked answer denies the destination', async () => {
    for (const entry of DNS_DENY_CASES) {
      const seen: string[] = [];
      const client = new OAuth2TokenClient(baseConfig('https://' + entry.host + '/token'), { tenantId: 't1' }, {
        resolveDns: async (host) => {
          seen.push(host);
          return entry.answers;
        },
        timeoutMs: 3000,
        maxAttempts: 1,
      });

      const failure = await client.getToken().then(() => null, (error: unknown) => error as Error & { code?: string });
      expect({ host: entry.host, label: entry.label, code: failure?.code }).toEqual({ host: entry.host, label: entry.label, code: 'TOKEN_ENDPOINT_DENIED' });
      expect(seen).toEqual([entry.host]);
      expect(String(failure?.message)).not.toContain(CLIENT_SECRET);
    }
  });

  it('[CR10-04] public answers connect ONCE: the adjudicated address is dialed and the name still carries Host', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({ kind: 'respond', status: 200, headers: { 'content-type': 'application/json' }, body: tokenBody('tok-pinned') });
      const seen: string[] = [];
      const client = new OAuth2TokenClient(
        baseConfig('http://idp.example.test:' + listener.port + '/token'),
        { tenantId: 't1' },
        {
          allowInsecureHttp: true,
          allowPrivateNetworks: true,
          resolveDns: async (host) => {
            seen.push(host);
            return ['127.0.0.1'];
          },
          timeoutMs: 5000,
          maxAttempts: 1,
        },
      );

      expect(await client.getToken()).toBe('tok-pinned');
      expect(seen).toEqual(['idp.example.test']);
      expect(listener.requests).toBe(1);
      const recorded = listener.recordedRequests[0];
      expect(recorded).toBeDefined();
      expect(recorded?.headers.host).toBe('idp.example.test:' + listener.port);
    } finally {
      await listener.stop();
    }
  });


  it('[CR10-04] a redirect hop to blocked space is destroyed and never followed', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({ kind: 'redirect', status: 302, location: 'http://169.254.169.254/latest/meta-data/' });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK }),
        allowInsecureHttp: true,
        timeoutMs: 5000,
        maxAttempts: 1,
      });

      const failure = await client.getToken().then(() => null, (error: unknown) => error as Error & { code?: string });
      expect(failure?.code).toBe('TOKEN_ENDPOINT_DENIED');
      expect(listener.requests).toBe(1);
      expect(String(failure?.message)).not.toContain(CLIENT_SECRET);
    } finally {
      await listener.stop();
    }
  });

  it('[CR10-04] a public redirect is never followed by the token client', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({ kind: 'redirect', status: 302, location: 'http://idp.example.test/next' });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK, resolve: async () => ['93.184.216.34'] }),
        allowInsecureHttp: true,
        timeoutMs: 5000,
        maxAttempts: 1,
      });

      const failure = await client.getToken().then(() => null, (error: unknown) => error as Error & { code?: string; status?: number });
      expect(listener.requests).toBe(1);
      expect(failure?.code).toBe('TOKEN_HTTP_ERROR');
      expect(failure?.status).toBe(302);
      expect(String(failure?.message)).not.toContain(CLIENT_SECRET);
    } finally {
      await listener.stop();
    }
  });
});