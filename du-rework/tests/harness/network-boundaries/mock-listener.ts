/**
 * R1-C boundary listener: a real loopback HTTP server used as the negative oracle
 * ("deny before connect" == requests === 0) and the byte/abort witness ("bounded body"
 * == bytesWritten stops at the cap, closedWithoutFinish rises on abort).
 *
 * Modeled on tests/stubs/provider/mock-provider.ts (PR-Q3-06 pending: that stub is not
 * importable from package suites) and adds what it lacks: chunked-no-content-length,
 * real 3xx responses, reset-mid-body, per-listener byte/abort counters.
 * Rule (report qwen3.md sec.6.1): never monkeypatch globalThis.fetch — either drive this
 * listener with production default fetch, or use a package's injectable fetch seam.
 * stop() destroys every open socket so a hung client promise cannot keep jest alive.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenLoopback } from '../listen-loopback';

export type ListenerScript =
  | { kind: 'respond'; status?: number; headers?: Record<string, string>; body?: string | Uint8Array }
  | { kind: 'chunkedNoLength'; chunkBytes: number; totalBytes: number; chunkDelayMs?: number; then?: 'end' | 'stall'; headers?: Record<string, string> }
  | { kind: 'stallAfterHeaders'; status?: number; headers?: Record<string, string> }
  | { kind: 'resetMidBody'; status?: number; headers?: Record<string, string>; bytesBeforeReset: number; chunkBytes?: number; chunkDelayMs?: number }
  | { kind: 'redirect'; status?: number; location: string }
  | { kind: 'hangForever' };

export interface BoundaryRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly bodyBytes: number;
  readonly headers: Record<string, string | string[] | undefined>;
}

export class BoundaryListener {
  private server: Server | undefined;
  private readonly socketSet = new Set<{ destroy: () => void }>();
  private readonly queue: ListenerScript[] = [];
  private defaultScript: ListenerScript = { kind: 'respond', status: 200, body: '' };
  private requestsSeen = 0;
  private bytesWrittenTotal = 0;
  private abortedSeen = 0;
  private closedWithoutFinishSeen = 0;
  readonly recordedRequests: BoundaryRequestRecord[] = [];

  static async start(preferPort?: number): Promise<BoundaryListener> {
    const l = new BoundaryListener();
    const srv = createServer((req, res) => {
      void l.handle(req, res);
    });
    srv.on('connection', (socket) => {
      l.socketSet.add(socket);
      socket.once('close', () => l.socketSet.delete(socket));
    });
    if (preferPort === undefined) {
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          srv.removeListener('error', reject);
          l.server = srv;
          resolve();
        });
      });
    } else {
      await listenLoopback(srv, preferPort);
      l.server = srv;
    }
    return l;
  }

  get port(): number {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error('boundary listener not started');
    return addr.port;
  }

  url(path = '/'): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** Per-request FIFO of behaviors; falls back to setDefault() once exhausted. */
  enqueue(script: ListenerScript): void {
    this.queue.push(script);
  }

  setDefault(script: ListenerScript): void {
    this.defaultScript = script;
  }

  get requests(): number {
    return this.requestsSeen;
  }

  get bytesWritten(): number {
    return this.bytesWrittenTotal;
  }

  /** req 'aborted' events (premature incoming-message close). */
  get abortedRequests(): number {
    return this.abortedSeen;
  }

  /** sockets that closed before the response finished — the client-gone witness. */
  get closedWithoutFinish(): number {
    return this.closedWithoutFinishSeen;
  }

  get openSockets(): number {
    return this.socketSet.size;
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = undefined;
    for (const s of this.socketSet) s.destroy();
    this.socketSet.clear();
    if (!srv) return;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private nextScript(): ListenerScript {
    return this.queue.shift() ?? this.defaultScript;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requestsSeen++;
    req.on('aborted', () => {
      this.abortedSeen++;
    });
    let finished = false;
    res.on('finish', () => {
      finished = true;
    });
    res.socket?.once('close', () => {
      if (!finished) this.closedWithoutFinishSeen++;
    });

    let bodyBytes = 0;
    try {
      for await (const chunk of req) {
        bodyBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk as Buffer).byteLength;
      }
    } catch {
      // client destroyed the request before the body was delivered — the payload never
      // arrived; do NOT record it, and do not reject the floating handle() promise.
      return;
    }
    this.recordedRequests.push({ method: req.method ?? 'GET', url: req.url ?? '/', bodyBytes, headers: req.headers });

    const script = this.nextScript();
    try {
      await this.run(script, res);
    } catch {
      /* socket already gone mid-script — that is the point of the abort counters */
    }
  }

  /** Flow-control-aware write: awaits 'drain' so bytesWritten witnesses what the CLIENT
   * actually consumed — without this, kernel buffers absorb everything and the
   * early-cap measurement is meaningless (padded-witness lesson, 2026-09-25). */
  private async writeCounted(res: ServerResponse, chunk: Buffer | string): Promise<void> {
    const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => res.once('drain', () => resolve()));
    }
    this.bytesWrittenTotal += n;
  }

  private async tick(ms: number | undefined): Promise<void> {
    if (ms !== undefined && ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  private async run(script: ListenerScript, res: ServerResponse): Promise<void> {
    switch (script.kind) {
      case 'respond': {
        const body = script.body ?? '';
        res.writeHead(script.status ?? 200, { 'content-type': 'text/plain', ...(script.headers ?? {}) });
        const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        this.bytesWrittenTotal += raw.byteLength;
        res.end(raw);
        return;
      }
      case 'redirect': {
        res.writeHead(script.status ?? 302, { location: script.location });
        res.end();
        return;
      }
      case 'stallAfterHeaders': {
        res.writeHead(script.status ?? 200, script.headers ?? {});
        res.flushHeaders();
        // no body ever: client must bound the wait itself
        return;
      }
      case 'hangForever': {
        // nothing at all: not even headers
        return;
      }
      case 'chunkedNoLength': {
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...(script.headers ?? {}) });
        const chunk = Buffer.alloc(script.chunkBytes, 0x61);
        let written = 0;
        try {
          while (written < script.totalBytes) {
            const n = Math.min(script.chunkBytes, script.totalBytes - written);
            await this.writeCounted(res, chunk.subarray(0, n));
            written += n;
            await this.tick(script.chunkDelayMs);
          }
          if (script.then !== 'stall') res.end();
        } catch {
          /* socket destroyed mid-stream by client cancel — stopped early: the witness */
        }
        return;
      }
      case 'resetMidBody': {
        res.writeHead(script.status ?? 200, { 'content-type': 'application/octet-stream', ...(script.headers ?? {}) });
        res.flushHeaders();
        const chunk = Buffer.alloc(script.chunkBytes ?? 512, 0x62);
        let written = 0;
        while (written < script.bytesBeforeReset) {
          const n = Math.min(chunk.byteLength, script.bytesBeforeReset - written);
          await this.writeCounted(res, chunk.subarray(0, n));
          written += n;
          await this.tick(script.chunkDelayMs);
        }
        res.socket?.destroy();
        return;
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}
