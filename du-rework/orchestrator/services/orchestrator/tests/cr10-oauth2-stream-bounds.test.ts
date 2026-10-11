import { OAuth2TokenClient, type OAuth2ClientCredentialsConfig } from '../src/modules/webhooks/oauth2-client';
import { createPinnedFetch } from '@du/egress';
import { BoundaryListener, waitFor } from '../../../../tests/harness/network-boundaries/mock-listener';

/**
 * CR10-03/04 stream-bound edge cases NOT covered by cr10-oauth2-body-and-egress.test.ts.
 *
 * Offline only: synthetic fetch/stream doubles plus loopback listeners from the
 * shared network-boundaries harness. No live DB / Redis / S3, no real IdP, no real
 * secret. The companion file is untouched; this one only adds the corners it skipped.
 *
 * Contract under test (src/modules/webhooks/oauth2-client.ts, readBoundedBody +
 * requestToken): the byte cap and the deadline both stay armed for the WHOLE
 * exchange, per chunk, against a stream that lies about its length, a stream that
 * dies mid-body, a stream that only ever trickles zero bytes, and a body with no
 * chunk-wise surface. Every bounded-refusal case has a negative control so a green
 * run cannot mean "the bound refused everything".
 *
 * NOTE on the doubles: every synthetic reader here awaits a real macrotask per
 * pull, exactly as a real transport does. A reader returning an already-resolved
 * promise in a tight loop starves the deadline timer (Node drains only microtasks
 * between macrotasks) and OOMs the process - a harness artifact, not a product
 * bound. That case is deliberately NOT asserted.
 */

const CLIENT_ID = 'client-id-public';
const CLIENT_SECRET = 'client-secret-SENTINEL-CR10-EDGE';
const ALLOW_LOOPBACK = new Set(['127.0.0.1']);

// Port band disjoint from the companion suite's 45000..45504 band.
const BASE_PORT = 46000 + (process.pid % 64) * 8;

// One origin per listener: Node's keep-alive agent keys pooled sockets by
// host:port, so reusing an origin after stop() can hand a client a dead socket.
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

const TOKEN_URL = 'https://idp.example.test/token';

/**
 * Response double that witnesses HOW the read ended. The counters are mutated in
 * place and the SAME object is handed back, so assertions read live values.
 */
interface ReaderScript {
  chunks?: Uint8Array[];
  /** Never resolves: the body stalls after the headers arrive. */
  stall?: boolean;
  /** Reject reader.read() once this many chunks have been delivered. */
  errorAfterChunks?: number;
  /** Yield zero-byte chunks forever, each after a macrotask tick. */
  zeroByteForever?: boolean;
  /** Per-chunk delay: a slow but legal stream. */
  chunkDelayMs?: number;
  /** Drop body.getReader so the text() fallback branch is taken. */
  withoutGetReader?: boolean;
  /** No body at all: the same fallback branch, via a null body. */
  nullBody?: boolean;
  /** Declare a content-length that does NOT match what is streamed. */
  declaredLength?: string | null;
  status?: number;
  contentType?: string | null;
}

interface Witness {
  response: Response;
  pulls: number;
  cancels: number;
  delivered: number;
  textCalls: number;
}

function scriptedResponse(script: ReaderScript): Witness {
  const witness = { pulls: 0, cancels: 0, delivered: 0, textCalls: 0 } as Witness;
  const chunks = script.chunks ?? [];
  let index = 0;

  const read = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    witness.pulls += 1;
    if (script.stall === true) return new Promise<never>(() => undefined);
    // Every branch below awaits a real macrotask, as a real transport would.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (script.zeroByteForever === true) return { done: false, value: new Uint8Array(0) };
    if (script.errorAfterChunks !== undefined && index >= script.errorAfterChunks) {
      throw new Error('synthetic stream failure');
    }
    if (index >= chunks.length) return { done: true };
    const value = chunks[index] as Uint8Array;
    index += 1;
    witness.delivered += value.byteLength;
    if (script.chunkDelayMs !== undefined && script.chunkDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, script.chunkDelayMs));
    }
    return { done: false, value };
  };

  const cancel = async (): Promise<void> => {
    witness.cancels += 1;
  };

  const reader = { read, cancel, releaseLock: (): void => undefined };

  witness.response = {
    status: script.status ?? 200,
    headers: {
      get: (name: string): string | null => {
        const key = name.toLowerCase();
        if (key === 'content-type') return script.contentType === undefined ? 'application/json' : script.contentType;
        if (key === 'content-length') return script.declaredLength ?? null;
        return null;
      },
    },
    body: script.nullBody === true
      ? null
      : { getReader: script.withoutGetReader === true ? undefined : () => reader, cancel },
    // Mirrors a real Response: drain the stream, THEN hand over the text.
    text: async (): Promise<string> => {
      witness.textCalls += 1;
      for (;;) {
        const next = await read();
        if (next.done) break;
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    },
  } as unknown as Response;

  return witness;
}

function clientOver(script: ReaderScript, options: Record<string, unknown> = {}): {
  client: OAuth2TokenClient;
  witness: Witness;
} {
  const witness = scriptedResponse(script);
  const client = new OAuth2TokenClient(baseConfig(TOKEN_URL), { tenantId: 't1' }, {
    fetchImpl: async () => witness.response,
    maxAttempts: 1,
    ...options,
  });
  return { client, witness };
}

/** Split bytes into fixed-size chunks, last one short. */
function chunked(bytes: Buffer, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(new Uint8Array(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength))));
  }
  return out;
}

describe('CR10-03 a stream that lies about its length is still bounded per chunk', () => {
  it('a declared content-length BELOW the real body size does not wave the body through', async () => {
    const real = new Uint8Array(Buffer.from(tokenBody('tok-liar'), 'utf8'));
    const padded = new Uint8Array(Buffer.concat([Buffer.from(real), Buffer.alloc(8192, 0x20)]));
    const { client, witness } = clientOver(
      { chunks: [padded], declaredLength: String(real.byteLength) },
      { maxResponseBytes: 1024 },
    );

    // The declared length (well under the cap) must not be trusted: the chunk
    // itself blows the cap and the read has to refuse.
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
    expect(witness.cancels).toBe(1);
  });

  it('a non-numeric content-length is ignored and the chunk cap still applies', async () => {
    const padded = new Uint8Array(Buffer.alloc(8192, 0x61));
    const { client } = clientOver({ chunks: [padded], declaredLength: 'not-a-number' }, { maxResponseBytes: 1024 });

    // Number('not-a-number') is NaN, so the header check is skipped; the body
    // must still be caught by the per-chunk cap rather than slip through.
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
  });

  it('a chunk that only crosses the cap once accumulated refuses at that chunk', async () => {
    const chunk = new Uint8Array(Buffer.from(tokenBody('tok-acc'), 'utf8'));
    // Cap is exactly two chunks: 1 and 2 fit, chunk 3 crosses it.
    const { client, witness } = clientOver(
      { chunks: [chunk, chunk, chunk] },
      { maxResponseBytes: 2 * chunk.byteLength },
    );

    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
    // Chunk 3 is the one that crosses; no fourth pull happens.
    expect(witness.pulls).toBe(3);
    expect(witness.cancels).toBe(1);
  });

  it('exactly the cap across MANY chunks is accepted: the accumulator, not the header, decides', async () => {
    const bytes = Buffer.from(tokenBody('tok-multi'), 'utf8');
    const { client } = clientOver({ chunks: chunked(bytes, 11) }, { maxResponseBytes: bytes.byteLength });

    expect(await client.getToken()).toBe('tok-multi');
  });

  it('one byte over the cap across many chunks is refused', async () => {
    const bytes = Buffer.from(tokenBody('tok-over'), 'utf8');
    // One extra byte appended so the accumulator crosses the true body size.
    const padded = Buffer.concat([bytes, Buffer.from([0x20])]);
    const { client } = clientOver({ chunks: chunked(padded, 7) }, { maxResponseBytes: bytes.byteLength });

    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
  });

  it('a multi-byte character split across chunks reassembles instead of corrupting', async () => {
    // "Thuủy Sí" carries 2- and 3-byte sequences; a naive per-chunk decode
    // would corrupt them. The cap is set at the true body size, so the bound is a
    // negative control here: acceptance proves byte-exact reassembly.
    const body = JSON.stringify({
      access_token: 'tok-utf8',
      token_type: 'Bearer',
      expires_in: 600,
      note: 'Thuủy Sí',
    });
    const bytes = Buffer.from(body, 'utf8');
    // Guard: the body really does carry multi-byte sequences, so the test cannot
    // silently degrade to ASCII-only coverage.
    expect(bytes.byteLength).toBeGreaterThan(body.length);
    const { client } = clientOver({ chunks: chunked(bytes, 5) }, { maxResponseBytes: bytes.byteLength });

    expect(await client.getToken()).toBe('tok-utf8');
  });
});

describe('CR10-03 a stream that dies or stalls mid-read still ends bounded', () => {
  it('a reader that rejects mid-body fails closed as a request failure, then cancels', async () => {
    const chunk = new Uint8Array(Buffer.from(tokenBody('tok-cut'), 'utf8'));
    const { client, witness } = clientOver({ chunks: [chunk], errorAfterChunks: 1 });

    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    expect(witness.pulls).toBe(2);
    expect(witness.cancels).toBe(1);
  });

  it('a body that only ever trickles zero-byte chunks is cut by the deadline', async () => {
    // Zero-byte chunks are legal in chunked transfer (heartbeats / keep-alive).
    // They never advance the byte counter, so the DEADLINE is the only bound that
    // can end this stream; the read must not spin on it.
    const { client, witness } = clientOver({ zeroByteForever: true }, { timeoutMs: 150 });

    const startedAt = Date.now();
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(witness.cancels).toBe(1);
    // The stream made no progress: the deadline, not the cap, is what ended it.
    expect(witness.delivered).toBe(0);
    expect(witness.pulls).toBeGreaterThan(1);
  });

  it('a slow but legal body still completes inside the deadline', async () => {
    const bytes = Buffer.from(tokenBody('tok-slow'), 'utf8');
    const { client, witness } = clientOver(
      { chunks: chunked(bytes, 8), chunkDelayMs: 10 },
      { timeoutMs: 10_000, maxResponseBytes: bytes.byteLength },
    );

    // Negative control for the timeout cases: a paced stream that stays inside
    // both bounds must still yield the token.
    expect(await client.getToken()).toBe('tok-slow');
    expect(witness.cancels).toBe(1);
    expect(witness.delivered).toBe(bytes.byteLength);
  });

  it('a body without a bounded reader is refused without buffering through text()', async () => {
    const { client, witness } = clientOver(
      { chunks: [new Uint8Array(Buffer.from('x'.repeat(4096), 'utf8'))], withoutGetReader: true },
      { maxResponseBytes: 512 },
    );

    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_INVALID' });
    expect(witness.textCalls).toBe(0);
    expect(witness.delivered).toBe(0);
    expect(witness.cancels).toBe(1);
  });

  it('a null body is treated as empty and never falls back to text()', async () => {
    const { client, witness } = clientOver(
      { chunks: [new Uint8Array(Buffer.from(tokenBody('tok-nobody'), 'utf8'))], nullBody: true },
    );

    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_INVALID' });
    expect(witness.textCalls).toBe(0);
  });
});

describe('CR10-03 one acquisition deadline covers secret resolution, retries, and body reads', () => {
  it('retry delay consumes the same deadline instead of multiplying it per attempt', async () => {
    let attemptCount = 0;
    let secondSignal: AbortSignal | undefined;
    const client = new OAuth2TokenClient(baseConfig(TOKEN_URL), { tenantId: 't1' }, {
      fetchImpl: async (_input, init) => {
        attemptCount += 1;
        if (attemptCount === 1) throw new Error('synthetic connect failure');
        secondSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          secondSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      maxAttempts: 3,
      retryDelayMs: 90,
      timeoutMs: 120,
    });

    const startedAt = Date.now();
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    const elapsed = Date.now() - startedAt;
    expect(attemptCount).toBe(2);
    expect(secondSignal?.aborted).toBe(true);
    // The 90 ms backoff is inside the 120 ms budget. A per-attempt timeout would
    // take roughly 210 ms before this second attempt failed.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(190);
  });

  it('a slow client-secret resolver is inside the deadline and cannot start a late fetch', async () => {
    let completeSecret: ((secret: string) => void) | undefined;
    let secretSignal: AbortSignal | undefined;
    let fetchCalls = 0;
    const secretPending = new Promise<string>((resolve) => { completeSecret = resolve; });
    const client = new OAuth2TokenClient({
      ...baseConfig(TOKEN_URL),
      clientSecret: (signal) => {
        secretSignal = signal;
        return secretPending;
      },
    }, { tenantId: 't1' }, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return scriptedResponse({ chunks: [new Uint8Array(Buffer.from(tokenBody('late'), 'utf8'))] }).response;
      },
      timeoutMs: 60,
      maxAttempts: 2,
    });

    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    expect(secretSignal?.aborted).toBe(true);
    completeSecret?.(CLIENT_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetchCalls).toBe(0);
  });

  it('a deadline that expires during backoff clears the delay and starts no later attempt', async () => {
    let fetchCalls = 0;
    const client = new OAuth2TokenClient(baseConfig(TOKEN_URL), { tenantId: 't1' }, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('synthetic connect failure');
      },
      maxAttempts: 3,
      retryDelayMs: 5000,
      timeoutMs: 50,
    });

    const startedAt = Date.now();
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fetchCalls).toBe(1);
  });

  it('an over-cap body is NOT retried: the refusal is terminal', async () => {
    let calls = 0;
    const client = new OAuth2TokenClient(baseConfig(TOKEN_URL), { tenantId: 't1' }, {
      fetchImpl: async () => {
        calls += 1;
        return scriptedResponse({ chunks: [new Uint8Array(Buffer.alloc(8192, 0x61))] }).response;
      },
      maxAttempts: 3,
      retryDelayMs: 0,
      maxResponseBytes: 512,
    });

    // Re-streaming an oversized body per attempt would be the wrong answer to a
    // misconfigured endpoint: one attempt, one refusal.
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
    expect(calls).toBe(1);
  });

  it('a stalled exchange stays bounded by one deadline, then stops', async () => {
    const { client } = clientOver({ stall: true }, { timeoutMs: 60, maxAttempts: 3, retryDelayMs: 0 });

    const startedAt = Date.now();
    await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(500);
  });
});

describe('CR10-03/04 real socket paths for the same bounds', () => {
  it('a DNS result that arrives after timeout cannot open a pinned connection', async () => {
    const listener = await startListener();
    try {
      let announceResolverStarted: (() => void) | undefined;
      let releaseDns: ((addresses: string[]) => void) | undefined;
      const resolverStarted = new Promise<void>((resolve) => { announceResolverStarted = resolve; });
      const dnsAnswers = new Promise<string[]>((resolve) => { releaseDns = resolve; });
      const client = new OAuth2TokenClient(
        baseConfig('http://idp.example.test:' + listener.port + '/token'),
        { tenantId: 't1' },
        {
          allowInsecureHttp: true,
          allowPrivateNetworks: true,
          resolveDns: async () => {
            announceResolverStarted?.();
            return dnsAnswers;
          },
          timeoutMs: 100,
          maxAttempts: 1,
        },
      );

      const pendingToken = client.getToken();
      await resolverStarted;
      await expect(pendingToken).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
      releaseDns?.(['127.0.0.1']);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(listener.requests).toBe(0);
    } finally {
      await listener.stop();
    }
  });

  it('a real socket that never sends headers is cut by the deadline', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({ kind: 'hangForever' });
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
    } finally {
      await listener.stop();
    }
  });

  it('a real socket destroyed mid-body fails closed instead of hanging', async () => {
    const listener = await startListener();
    try {
      listener.enqueue({
        kind: 'resetMidBody',
        status: 200,
        headers: { 'content-type': 'application/json' },
        bytesBeforeReset: 2048,
        chunkBytes: 256,
        chunkDelayMs: 1,
      });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK }),
        allowInsecureHttp: true,
        timeoutMs: 5000,
        maxAttempts: 1,
      });

      // A mid-body reset is a transport failure, not a cap breach and not a
      // success: it surfaces as TOKEN_REQUEST_FAILED, never a hang.
      await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_REQUEST_FAILED' });
      await waitFor(() => listener.abortedRequests > 0 || listener.closedWithoutFinish > 0, 3000);
    } finally {
      await listener.stop();
    }
  });

  it('a real socket carrying a body just under the cap is accepted end to end', async () => {
    const listener = await startListener();
    try {
      const body = tokenBody('tok-under-cap');
      const size = Buffer.byteLength(body, 'utf8');
      listener.enqueue({
        kind: 'respond',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
      });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK }),
        allowInsecureHttp: true,
        timeoutMs: 5000,
        maxAttempts: 1,
        // One byte of headroom: the real body must pass, proving the bound does
        // not refuse legitimate traffic on a real socket.
        maxResponseBytes: size + 1,
      });

      expect(await client.getToken()).toBe('tok-under-cap');
      expect(listener.bytesWritten).toBe(size);
    } finally {
      await listener.stop();
    }
  });

  it('a real socket carrying a body one byte over the cap is refused before parsing', async () => {
    const listener = await startListener();
    try {
      const body = tokenBody('tok-over-cap');
      const size = Buffer.byteLength(body, 'utf8');
      listener.enqueue({
        kind: 'respond',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
      });
      const client = new OAuth2TokenClient(baseConfig(listener.url('/token')), { tenantId: 't1' }, {
        fetchImpl: createPinnedFetch({ allowHosts: ALLOW_LOOPBACK }),
        allowInsecureHttp: true,
        timeoutMs: 5000,
        maxAttempts: 1,
        maxResponseBytes: size - 1,
      });

      // The declared content-length is already over the cap here, so the refusal
      // comes from the header check and the body is released, never buffered.
      await expect(client.getToken()).rejects.toMatchObject({ code: 'TOKEN_RESPONSE_TOO_LARGE' });
    } finally {
      await listener.stop();
    }
  });

  it('no stream-path refusal message carries the client secret', async () => {
    const scripts: ReaderScript[] = [
      { chunks: [new Uint8Array(Buffer.alloc(8192, 0x61))] },
      { stall: true },
      { zeroByteForever: true },
      { chunks: [new Uint8Array(Buffer.from(tokenBody('tok-x'), 'utf8'))], errorAfterChunks: 1 },
      { chunks: [new Uint8Array(Buffer.from('not json', 'utf8'))] },
    ];
    for (const script of scripts) {
      const { client } = clientOver(script, { timeoutMs: 150, maxResponseBytes: 512, maxAttempts: 1 });
      const failure = await client.getToken().then(
        () => null,
        (error: unknown) => error as Error & { code?: string },
      );
      expect(failure).not.toBeNull();
      expect(String(failure?.message)).not.toContain(CLIENT_SECRET);
      expect(String(failure?.code ?? '')).not.toContain(CLIENT_SECRET);
    }
  });
});
