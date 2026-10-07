import { createHash, randomUUID } from 'node:crypto';
import {
  spawnChild,
  waitForChildren,
  uploadArtifact,
  streamResult,
  ArtifactUploadError,
  StreamResultError,
} from '../src';
import type {
  ChildHandle,
  SdkFetcher,
} from '../src';

/**
 * P4-04 — fan-out / HITL / streaming / artifact-upload SDK helpers.
 *
 * All helpers route through an injected fetcher so the wire contract is
 * testable without DB / Redis / network. Each describe block covers a
 * single helper; the mock captures the URL, method, headers and body so
 * tests assert the exact runtime contract, not just observable behavior.
 */

const RUNTIME = 'http://runtime.test';
const TOKEN = 'tok-cc-123';
const TASK_ID = randomUUID();

/* -------------------------------------------------------------------- */
/* Mock fetcher plumbing                                                */
/* -------------------------------------------------------------------- */

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockRoute {
  method: string;
  pattern: RegExp;
  handler: (match: RegExpMatchArray, init: { body: unknown }) => Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

function urlToString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function makeFetcher(routes: MockRoute[], captured: CapturedCall[]): SdkFetcher {
  return (async (input: string | URL | Request, init?: { method?: string; headers?: Record<string, string> | Headers; body?: unknown }) => {
    const url = urlToString(input);
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => { headers[k] = v; });
    } else if (init?.headers) {
      Object.assign(headers, init.headers);
    }
    captured.push({ url, method, headers, body: init?.body });
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.replace(RUNTIME, ''));
      if (m) return r.handler(m, { body: init?.body });
    }
    return jsonResponse(404, {
      type: 'urn:du:error:not_found',
      status: 404,
      code: 'NOT_FOUND',
      title: `no route for ${method} ${url}`,
    });
  }) as SdkFetcher;
}

/** Read all bytes from a `BodyInit`-shaped value the fetcher received. */
async function readBodyBytes(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (typeof (body as { getReader?: () => unknown }).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`readBodyBytes: unsupported body type ${typeof body}`);
}

/* -------------------------------------------------------------------- */
/* spawnChild                                                            */
/* -------------------------------------------------------------------- */

describe('spawnChild', () => {
  it('POSTs a single-child batch to /tasks/:id/children with bearer auth', async () => {
    const captured: CapturedCall[] = [];
    const childId = randomUUID();
    const fetcher = makeFetcher(
      [
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/children$/,
          handler: () => jsonResponse(202, { childTaskIds: [childId], parentState: 'WAITING_CHILDREN' }),
        },
      ],
      captured
    );

    const handle = await spawnChild(
      { taskId: TASK_ID },
      { taskKey: 'extract-page', kind: 'ocr-page', payload: { page: 1, lang: 'vi' } },
      { leaseEpoch: 5, continuationRef: 'cont-1' },
      RUNTIME,
      TOKEN,
      { fetcher }
    );

    expect(handle.childTaskId).toBe(childId);
    expect(handle.taskKey).toBe('extract-page');
    expect(handle.kind).toBe('ocr-page');
    expect(handle.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${RUNTIME}/tasks/${TASK_ID}/children`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['content-type']).toBe('application/json');

    const wireBody = JSON.parse(String(call.body));
    expect(wireBody).toMatchObject({
      leaseEpoch: 5,
      joinPolicy: 'all-success',
      continuationRef: 'cont-1',
      children: [{ taskKey: 'extract-page', kind: 'ocr-page', payloadRef: { page: 1, lang: 'vi' } }],
    });
    expect(wireBody.children[0].payloadHash).toBe(handle.payloadHash);
  });

  it('surfaces a typed error when the runtime rejects the spawn', async () => {
    const fetcher = makeFetcher(
      [
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/children$/,
          handler: () =>
            jsonResponse(409, {
              type: 'urn:du:error:state_conflict',
              status: 409,
              code: 'STATE_CONFLICT',
              title: 'parent not in RUNNING',
              detail: 'parent state WAITING_CHILDREN cannot spawn more children',
            }),
        },
      ],
      []
    );

    await expect(
      spawnChild(
        { taskId: TASK_ID },
        { taskKey: 'extract-page', kind: 'ocr-page', payload: { page: 1 } },
        { leaseEpoch: 1, continuationRef: 'cont-1' },
        RUNTIME,
        TOKEN,
        { fetcher }
      )
    ).rejects.toThrow(/state WAITING_CHILDREN/);
  });

  it('rejects when the runtime returns zero childTaskIds', async () => {
    const fetcher = makeFetcher(
      [
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/children$/,
          handler: () => jsonResponse(202, { childTaskIds: [], parentState: 'WAITING_CHILDREN' }),
        },
      ],
      []
    );

    await expect(
      spawnChild(
        { taskId: TASK_ID },
        { taskKey: 'k', kind: 'kk', payload: {} },
        { leaseEpoch: 1, continuationRef: 'c' },
        RUNTIME,
        TOKEN,
        { fetcher }
      )
    ).rejects.toThrow(/no childTaskIds/);
  });
});

/* -------------------------------------------------------------------- */
/* waitForChildren                                                       */
/* -------------------------------------------------------------------- */

describe('waitForChildren', () => {
  const handles: ChildHandle[] = [
    { childTaskId: 'c-1', taskKey: 'extract-page', kind: 'ocr-page', payloadHash: 'sha256:00' },
    { childTaskId: 'c-2', taskKey: 'extract-image', kind: 'ocr-image', payloadHash: 'sha256:01' },
  ];

  function childListRoute(stateByChild: Record<string, string>) {
    return {
      method: 'GET',
      pattern: /^\/tasks\/[^/]+\/children$/,
      handler: () =>
        jsonResponse(200, {
          children: handles.map((h) => ({
            id: h.childTaskId,
            task_key: h.taskKey,
            kind: h.kind,
            state: stateByChild[h.childTaskId] ?? 'RUNNING',
            result_ref: stateByChild[h.childTaskId] === 'SUCCEEDED' ? 'artifact://r' : null,
            error_code: null,
          })),
        }),
    } satisfies MockRoute;
  }

  it('parses the runtime GET children wire response into ChildState.resultRef', async () => {
    // Exact public shape returned by RuntimeService.getChildren and passed
    // through unchanged by the HTTP GET /api/runtime/v1/tasks/:id/children
    // route (runtime.ts:1169-1170; http/routes/runtime.ts:457-463).
    const serverChild = {
      taskId: '45000000-0000-4000-8000-000000000001',
      taskKey: 'extract-page',
      kind: 'ocr-page',
      state: 'SUCCEEDED',
      resultRef: 'artifact://runs/45000000/page/1',
      errorCode: null,
    };
    const serverResponse = { children: [serverChild] };
    const handle: ChildHandle = {
      childTaskId: serverChild.taskId,
      taskKey: serverChild.taskKey,
      kind: serverChild.kind,
      payloadHash: 'sha256:server-response-fixture',
    };
    const captured: CapturedCall[] = [];
    const fetcher = makeFetcher(
      [
        {
          method: 'GET',
          pattern: /^\/tasks\/[^/]+\/children$/,
          handler: () => jsonResponse(200, serverResponse),
        },
      ],
      captured,
    );

    const out = await waitForChildren(
      { taskId: '45000000-0000-4000-8000-000000000002' },
      [handle],
      RUNTIME,
      TOKEN,
      { fetcher, maxAttempts: 1, intervalMs: 1 },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.children).toEqual([
      {
        taskId: serverChild.taskId,
        taskKey: serverChild.taskKey,
        kind: serverChild.kind,
        state: serverChild.state,
        resultRef: serverChild.resultRef,
        errorCode: serverChild.errorCode,
      },
    ]);
    expect(out.children[0]?.resultRef).toBe('artifact://runs/45000000/page/1');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(`${RUNTIME}/tasks/45000000-0000-4000-8000-000000000002/children`);
  });

  it('polls until all children reach SUCCEEDED and reports allSucceeded=true', async () => {
    const captured: CapturedCall[] = [];
    const states: Array<Record<string, string>> = [
      { 'c-1': 'RUNNING', 'c-2': 'READY' },
      { 'c-1': 'SUCCEEDED', 'c-2': 'RUNNING' },
      { 'c-1': 'SUCCEEDED', 'c-2': 'SUCCEEDED' },
    ];
    const fetcher: SdkFetcher = async (input) => {
      const url = urlToString(input);
      captured.push({ url, method: 'GET', headers: {}, body: undefined });
      const head = url.replace(RUNTIME, '');
      const m = /^\/tasks\/[^/]+\/children$/.exec(head);
      if (!m) return jsonResponse(404, { type: 'x', status: 404, code: 'NOT_FOUND', title: 'x' });
      const next = states.shift();
      if (!next) return jsonResponse(500, { type: 'x', status: 500, code: 'BOOM', title: 'x' });
      return jsonResponse(200, {
        children: handles.map((h) => ({
          id: h.childTaskId,
          task_key: h.taskKey,
          kind: h.kind,
          state: next[h.childTaskId] ?? 'RUNNING',
          result_ref: next[h.childTaskId] === 'SUCCEEDED' ? 'artifact://r' : null,
          error_code: null,
        })),
      });
    };

    const out = await waitForChildren(
      { taskId: TASK_ID },
      handles,
      RUNTIME,
      TOKEN,
      { fetcher, maxAttempts: 10, intervalMs: 1 }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.allSucceeded).toBe(true);
    expect(out.children).toHaveLength(2);
    expect(out.children.every((c) => c.state === 'SUCCEEDED')).toBe(true);
    expect(out.children.map((child) => child.resultRef)).toEqual(['artifact://r', 'artifact://r']);
    // Polled exactly 3 times before all-terminal.
    expect(captured).toHaveLength(3);
    expect(captured.every((c) => c.url === `${RUNTIME}/tasks/${TASK_ID}/children`)).toBe(true);
  });

  it('short-circuits when any child is FAILED with a typed outcome', async () => {
    const states: Array<Record<string, string>> = [
      { 'c-1': 'RUNNING', 'c-2': 'RUNNING' },
      { 'c-1': 'FAILED', 'c-2': 'RUNNING' },
    ];
    const fetcher: SdkFetcher = async () => {
      const next = states.shift() ?? { 'c-1': 'FAILED', 'c-2': 'RUNNING' };
      return jsonResponse(200, {
        children: handles.map((h) => ({
          id: h.childTaskId,
          task_key: h.taskKey,
          kind: h.kind,
          state: next[h.childTaskId] ?? 'RUNNING',
          result_ref: null,
          error_code: next[h.childTaskId] === 'FAILED' ? 'PROVIDER_UNAVAILABLE' : null,
        })),
      });
    };

    const out = await waitForChildren(
      { taskId: TASK_ID },
      handles,
      RUNTIME,
      TOKEN,
      { fetcher, maxAttempts: 10, intervalMs: 1 }
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]!.taskKey).toBe('extract-page');
    expect(out.failed[0]!.state).toBe('FAILED');
    expect(out.detail).toMatch(/extract-page=FAILED/);
  });

  it('returns ok=false with the runtime error detail on a non-2xx response', async () => {
    const fetcher = makeFetcher(
      [
        {
          method: 'GET',
          pattern: /^\/tasks\/[^/]+\/children$/,
          handler: () =>
            jsonResponse(404, {
              type: 'urn:du:error:not_found',
              status: 404,
              code: 'NOT_FOUND',
              title: 'task not found',
              detail: 'no such task',
            }),
        },
      ],
      []
    );

    const out = await waitForChildren(
      { taskId: TASK_ID },
      handles,
      RUNTIME,
      TOKEN,
      { fetcher, maxAttempts: 3, intervalMs: 1 }
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
    expect(out.detail).toBe('no such task');
  });

  it('honors AbortSignal and returns immediately', async () => {
    const controller = new AbortController();
    const fetcher: SdkFetcher = async () => {
      controller.abort();
      return jsonResponse(200, { children: [] });
    };

    const out = await waitForChildren(
      { taskId: TASK_ID },
      handles,
      RUNTIME,
      TOKEN,
      { fetcher, maxAttempts: 50, intervalMs: 5, signal: controller.signal }
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(0);
    expect(out.detail).toMatch(/aborted/);
  });

  it('returns a 504 timeout outcome when the join never completes', async () => {
    const fetcher: SdkFetcher = async () =>
      jsonResponse(200, {
        children: handles.map((h) => ({
          id: h.childTaskId,
          task_key: h.taskKey,
          kind: h.kind,
          state: 'RUNNING',
          result_ref: null,
          error_code: null,
        })),
      });

    const out = await waitForChildren(
      { taskId: TASK_ID },
      handles,
      RUNTIME,
      TOKEN,
      { fetcher, maxAttempts: 3, intervalMs: 1 }
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(504);
    expect(out.detail).toMatch(/timed out after 3 attempts/);
  });

  it('respects concurrency=1 (one outstanding poll at a time)', async () => {
    // Concurrency is enforced by `for (let attempt = 1; ...)` — assert
    // that no overlapping fetcher calls occur when the network is slow.
    let inflight = 0;
    let peak = 0;
    const fetcher: SdkFetcher = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return jsonResponse(200, {
        children: handles.map((h) => ({
          id: h.childTaskId,
          task_key: h.taskKey,
          kind: h.kind,
          state: 'SUCCEEDED',
          result_ref: 'artifact://r',
          error_code: null,
        })),
      });
    };

    await waitForChildren(
      { taskId: TASK_ID },
      handles,
      RUNTIME,
      TOKEN,
      { fetcher, maxAttempts: 5, intervalMs: 1 }
    );
    expect(peak).toBe(1);
  });
});

/* -------------------------------------------------------------------- */
/* uploadArtifact                                                        */
/* -------------------------------------------------------------------- */

describe('uploadArtifact', () => {
  function uploadGrantRoutes(opts: {
    uploadGrant?: () => { status: number; json: unknown };
    put?: (body: Buffer) => { status: number; json?: unknown };
    finalize?: () => { status: number; json: unknown };
  }) {
    const uploadUrl = `${RUNTIME}/blob-storage/${randomUUID()}`;
    return {
      routes: [
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/artifacts$/,
          handler: () => {
            const r = opts.uploadGrant?.() ?? { status: 200, json: { artifactId: randomUUID(), uploadUrl, storageKey: 'k', expiresAt: new Date(Date.now() + 60000).toISOString() } };
            return jsonResponse(r.status, r.json);
          },
        },
        {
          method: 'PUT',
          pattern: /^\/blob-storage\/[^/]+$/,
          handler: (_m: RegExpMatchArray, init: { body: unknown }) => {
            const r = opts.put?.(init.body as Buffer) ?? { status: 200, json: {} };
            return jsonResponse(r.status, r.json ?? {});
          },
        },
        {
          method: 'POST',
          pattern: /^\/artifacts\/[^/]+\/finalize$/,
          handler: () => {
            const r = opts.finalize?.() ?? { status: 200, json: { artifactId: 'a', state: 'READY' } };
            return jsonResponse(r.status, r.json);
          },
        },
      ] satisfies MockRoute[],
      uploadUrl,
    };
  }

  it('completes a happy-path staged upload with sha256 verification and returns a typed ref', async () => {
    const captured: CapturedCall[] = [];
    // Copy the PUT body at capture time: the helper zeroes the caller's
    // buffer after finalize, so a live reference would read all zeros.
    let putBodyCopy: Buffer | null = null;
    const { routes } = uploadGrantRoutes({
      put: (body) => {
        putBodyCopy = Buffer.from(body);
        return { status: 200 };
      },
    });
    const fetcher = makeFetcher(routes, captured);
    const bytes = Buffer.from('hello world!', 'utf8');
    const expectedSha = createHash('sha256').update(bytes).digest('hex');

    const out = await uploadArtifact(
      { taskId: TASK_ID, leaseEpoch: 3 },
      bytes,
      { fileName: 'hello.txt', mimeType: 'text/plain', purpose: 'output' },
      RUNTIME,
      TOKEN,
      { fetcher }
    );

    expect(out.sizeBytes).toBe(12);
    expect(out.sha256).toBe(expectedSha);
    expect(out.fileName).toBe('hello.txt');
    expect(out.mimeType).toBe('text/plain');
    expect(out.artifactId).toMatch(/^[0-9a-f-]{36}$/);

    // Buffer zeroed after success (temp cleanup invariant).
    expect(bytes.every((b) => b === 0)).toBe(true);

    // grant body carries the correct size + purpose + mime.
    const grantCall = captured.find((c) => c.url.endsWith('/artifacts') && c.method === 'POST');
    expect(grantCall).toBeDefined();
    const grantBody = JSON.parse(String(grantCall!.body));
    expect(grantBody).toMatchObject({
      leaseEpoch: 3,
      purpose: 'output',
      fileName: 'hello.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
    });

    // PUT body equals the original bytes (snapshot taken before zeroing).
    const putCall = captured.find((c) => c.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putBodyCopy).not.toBeNull();
    expect(putBodyCopy!.toString('utf8')).toBe('hello world!');
    expect(putCall!.headers['content-type']).toBe('text/plain');

    // Finalize carries sizeBytes + sha256.
    const finCall = captured.find((c) => c.url.endsWith('/finalize'));
    expect(finCall).toBeDefined();
    const finBody = JSON.parse(String(finCall!.body));
    expect(finBody.sizeBytes).toBe(12);
    expect(finBody.sha256).toBe(expectedSha);
    expect(finCall!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('throws HASH_MISMATCH when the expected sha256 does not match', async () => {
    const { routes } = uploadGrantRoutes({});
    const fetcher = makeFetcher(routes, []);
    const bytes = Buffer.from('payload', 'utf8');

    await expect(
      uploadArtifact(
        { taskId: TASK_ID, leaseEpoch: 1 },
        bytes,
        {
          fileName: 'p.txt',
          mimeType: 'text/plain',
          expectedSha256: 'deadbeef'.repeat(8),
        },
        RUNTIME,
        TOKEN,
        { fetcher }
      )
    ).rejects.toBeInstanceOf(ArtifactUploadError);
    // Buffer zeroed on failure path.
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('throws ArtifactUploadError and zeroes the buffer when the grant fails', async () => {
    const { routes } = uploadGrantRoutes({
      uploadGrant: () => ({
        status: 409,
        json: {
          type: 'urn:du:error:state_conflict',
          status: 409,
          code: 'STATE_CONFLICT',
          title: 'wrong lease',
          detail: 'lease epoch mismatch',
        },
      }),
    });
    const fetcher = makeFetcher(routes, []);
    const bytes = Buffer.from('secret', 'utf8');

    await expect(
      uploadArtifact(
        { taskId: TASK_ID, leaseEpoch: 99 },
        bytes,
        { fileName: 's.txt', mimeType: 'text/plain' },
        RUNTIME,
        TOKEN,
        { fetcher }
      )
    ).rejects.toMatchObject({ code: 'GRANT_REJECTED', status: 409 });
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('throws UPLOAD_REJECTED and zeroes the buffer when the presigned PUT fails', async () => {
    const { routes } = uploadGrantRoutes({
      put: () => ({ status: 403, json: { detail: 'signature expired' } }),
    });
    const fetcher = makeFetcher(routes, []);
    const bytes = Buffer.from('sensitive bytes', 'utf8');

    await expect(
      uploadArtifact(
        { taskId: TASK_ID, leaseEpoch: 1 },
        bytes,
        { fileName: 's.txt', mimeType: 'application/octet-stream' },
        RUNTIME,
        TOKEN,
        { fetcher }
      )
    ).rejects.toMatchObject({ code: 'UPLOAD_REJECTED', status: 403 });
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('throws FINALIZE_REJECTED when finalize rejects (no half state)', async () => {
    const { routes } = uploadGrantRoutes({
      finalize: () => ({
        status: 422,
        json: {
          type: 'urn:du:error:invalid_schema',
          status: 422,
          code: 'INVALID_SCHEMA',
          title: 'sha256 bad',
          detail: 'sha256 not hex',
        },
      }),
    });
    const fetcher = makeFetcher(routes, []);
    const bytes = Buffer.from('whatever', 'utf8');

    await expect(
      uploadArtifact(
        { taskId: TASK_ID, leaseEpoch: 1 },
        bytes,
        { fileName: 'w.bin', mimeType: 'application/octet-stream' },
        RUNTIME,
        TOKEN,
        { fetcher }
      )
    ).rejects.toMatchObject({ code: 'FINALIZE_REJECTED', status: 422 });
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('throws TRANSPORT_FAILURE and zeroes the buffer when the fetcher rejects', async () => {
    const fetcher: SdkFetcher = async () => {
      throw new Error('ECONNRESET');
    };
    const bytes = Buffer.from('payload', 'utf8');

    await expect(
      uploadArtifact(
        { taskId: TASK_ID, leaseEpoch: 1 },
        bytes,
        { fileName: 'p.bin', mimeType: 'application/octet-stream' },
        RUNTIME,
        TOKEN,
        { fetcher }
      )
    ).rejects.toBeInstanceOf(ArtifactUploadError);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------- */
/* streamResult                                                          */
/* -------------------------------------------------------------------- */

describe('streamResult', () => {
  function asyncIterFromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          async next() {
            if (i >= chunks.length) return { value: undefined, done: true } as IteratorResult<Uint8Array>;
            const v = chunks[i++]!;
            return { value: v, done: false } as IteratorResult<Uint8Array>;
          },
          async return() {
            return { value: undefined, done: true } as IteratorResult<Uint8Array>;
          },
        };
      },
    };
  }

  it('streams chunks to the runtime /result endpoint without buffering', async () => {
    const captured: CapturedCall[] = [];
    // A real fetch drains the request body; the mock must too — otherwise
    // the passthrough is never pulled and bytesWritten stays 0.
    const drained: number[] = [];
    const fetcher: SdkFetcher = async (input, init) => {
      const url = urlToString(input);
      captured.push({
        url,
        method: init?.method ?? 'POST',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body,
      });
      const body = init?.body as ReadableStream<Uint8Array>;
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) drained.push(...value);
      }
      reader.releaseLock();
      return jsonResponse(202, { accepted: true });
    };

    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6, 7]),
      new Uint8Array([8]),
    ];
    const stream = asyncIterFromChunks(chunks);

    const out = await streamResult(
      { taskId: TASK_ID },
      stream,
      { mimeType: 'application/x-msgpack', leaseEpoch: 7 },
      { fetcher, runtimeBaseUrl: RUNTIME, token: TOKEN }
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.status).toBe(202);
    expect(out.bytesWritten).toBe(8);

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${RUNTIME}/tasks/${TASK_ID}/result`);
    expect(call.headers['content-type']).toBe('application/x-msgpack');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['x-lease-epoch']).toBe('7');

    // The consumer received the exact chunk sequence.
    expect(drained).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('skips bearer auth when given an absolute presigned url', async () => {
    const captured: CapturedCall[] = [];
    const fetcher: SdkFetcher = async (input, init) => {
      const url = urlToString(input);
      captured.push({
        url,
        method: init?.method ?? 'POST',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body,
      });
      return jsonResponse(200, { ok: true });
    };

    const url = 'https://presigned.example/upload?token=abc';
    const out = await streamResult(
      { taskId: TASK_ID },
      asyncIterFromChunks([new Uint8Array([0xff])]),
      { mimeType: 'application/octet-stream' },
      { fetcher, url }
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(captured[0]!.url).toBe(url);
    expect(captured[0]!.headers.authorization).toBeUndefined();
    const bytes = await readBodyBytes(captured[0]!.body);
    expect(bytes[0]).toBe(0xff);
  });

  it('throws StreamResultError when the runtime returns a non-2xx', async () => {
    const fetcher: SdkFetcher = async () =>
      jsonResponse(503, {
        type: 'urn:du:error:temporary_unavailable',
        status: 503,
        code: 'TEMPORARY_UNAVAILABLE',
        title: 'busy',
        detail: 'runtime overloaded',
      });

    await expect(
      streamResult(
        { taskId: TASK_ID },
        asyncIterFromChunks([new Uint8Array([1])]),
        { mimeType: 'text/plain' },
        { fetcher, runtimeBaseUrl: RUNTIME, token: TOKEN }
      )
    ).rejects.toBeInstanceOf(StreamResultError);
  });

  it('streams large payloads chunk-by-chunk (no concatenation)', async () => {
    // 200 × 8KiB chunks; if the helper concatenated in memory we'd OOM.
    const CHUNKS = 200;
    const SIZE = 8 * 1024;
    function* gen() {
      for (let i = 0; i < CHUNKS; i++) yield new Uint8Array(SIZE).fill(i & 0xff);
    }
    const iter: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        const it = gen();
        return {
          next: () => Promise.resolve(it.next() as IteratorResult<Uint8Array>),
          return: () => Promise.resolve({ value: undefined, done: true } as IteratorResult<Uint8Array>),
        };
      },
    };

    let observedChunks = 0;
    const fetcher: SdkFetcher = async (_input, init) => {
      const body = init?.body as ReadableStream<Uint8Array>;
      const reader = body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        observedChunks++;
      }
      reader.releaseLock();
      return jsonResponse(200, {});
    };

    const out = await streamResult(
      { taskId: TASK_ID },
      iter,
      { mimeType: 'application/octet-stream' },
      { fetcher, runtimeBaseUrl: RUNTIME, token: TOKEN }
    );
    expect(out.bytesWritten).toBe(CHUNKS * SIZE);
    expect(observedChunks).toBe(CHUNKS);
  });

  it('aborts cleanly when the source iterable cancels (backpressure)', async () => {
    let returnCalled = false;
    const iter: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          async next() {
            if (i++ > 5) {
              // Simulate the helper cancelling: never resolve.
              return new Promise(() => {}) as Promise<IteratorResult<Uint8Array>>;
            }
            return { value: new Uint8Array([i]), done: false } as IteratorResult<Uint8Array>;
          },
          async return() {
            returnCalled = true;
            return { value: undefined, done: true } as IteratorResult<Uint8Array>;
          },
        };
      },
    };

    const fetcher: SdkFetcher = async (_input, init) => {
      const body = init?.body as ReadableStream<Uint8Array>;
      // Read a few chunks then cancel — simulates lease loss mid-stream.
      const reader = body.getReader();
      for (let i = 0; i < 3; i++) {
        await reader.read();
      }
      await reader.cancel('lease-lost');
      return jsonResponse(202, {});
    };

    await streamResult(
      { taskId: TASK_ID },
      iter,
      { mimeType: 'application/octet-stream' },
      { fetcher, runtimeBaseUrl: RUNTIME, token: TOKEN }
    );
    // The helper should have invoked the iterable's `return()` on cancel.
    expect(returnCalled).toBe(true);
  });
});
