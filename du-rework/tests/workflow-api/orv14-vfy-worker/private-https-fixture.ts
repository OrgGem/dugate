import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpsServer } from 'node:https';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

export const PRIVATE_HTTPS_TARGETS = Object.freeze({
  sanMatch: Object.freeze({ host: '172-26-91-253.sslip.io', bindAddress: '172.26.91.253' }),
  sanMismatch: Object.freeze({ host: '172-31-10-238.sslip.io', bindAddress: '172.31.10.238' }),
});

type ListenerId = 'san-match' | 'san-match-alt' | 'san-mismatch';

export interface PrivateHttpsEvent {
  readonly kind: 'request' | 'tls' | 'tls-error' | 'client-close';
  readonly listener: ListenerId;
  readonly method?: string;
  readonly path?: string;
  readonly host?: string;
  readonly sni?: string | null;
  readonly bodyBytes?: number;
  readonly bodySha256?: string;
  readonly bodyRawBytes?: number;
  readonly bodySha256Recomputed?: string;
  readonly bodyRawText?: string;
  readonly bodyJson?: unknown;
  readonly errorCode?: string;
}

interface Listener {
  readonly server: HttpsServer;
  readonly listener: ListenerId;
  readonly host: string;
  readonly bindAddress: string;
  readonly port: number;
}

/**
 * Actual private-address HTTPS listener used by the Worker integration test.
 * It uses Node's ordinary DNS/TLS stack and the fixture CA; no resolver or
 * fetch override is installed. Request records contain no body text or headers
 * that can carry credentials.
 */
export class PrivateHttpsFixture {
  readonly events: PrivateHttpsEvent[] = [];
  private readonly listeners: Listener[] = [];
  private readonly slowTimers = new Set<NodeJS.Timeout>();

  async start(): Promise<void> {
    const key = readFileSync(resolve(__dirname, 'https-fixture', 'server-key.pem'));
    const cert = readFileSync(resolve(__dirname, 'https-fixture', 'server-cert.pem'));
    await this.startListener('san-match', PRIVATE_HTTPS_TARGETS.sanMatch.host, PRIVATE_HTTPS_TARGETS.sanMatch.bindAddress, key, cert);
    await this.startListener('san-match-alt', PRIVATE_HTTPS_TARGETS.sanMatch.host, PRIVATE_HTTPS_TARGETS.sanMatch.bindAddress, key, cert);
    await this.startListener('san-mismatch', PRIVATE_HTTPS_TARGETS.sanMismatch.host, PRIVATE_HTTPS_TARGETS.sanMismatch.bindAddress, key, cert);
  }

  get sanMatchOrigin(): string {
    return this.origin('san-match');
  }

  get sanMismatchOrigin(): string {
    return this.origin('san-mismatch');
  }

  get sanMatchAlternateOrigin(): string {
    return this.origin('san-match-alt');
  }

  url(listener: ListenerId, path: string): string {
    return `${this.origin(listener)}${path.startsWith('/') ? path : `/${path}`}`;
  }

  count(listener: ListenerId, kind: PrivateHttpsEvent['kind'], path?: string): number {
    return this.events.filter((event) => event.listener === listener && event.kind === kind && (path === undefined || event.path === path)).length;
  }

  async close(): Promise<void> {
    for (const timer of this.slowTimers) clearTimeout(timer);
    this.slowTimers.clear();
    await Promise.all(this.listeners.map(({ server }) => new Promise<void>((resolveClose) => {
      if (!server.listening) return resolveClose();
      server.close(() => resolveClose());
    })));
    this.listeners.length = 0;
  }

  private origin(listener: ListenerId): string {
    const found = this.listeners.find((candidate) => candidate.listener === listener);
    if (!found) throw new Error(`private HTTPS listener ${listener} is not running`);
    return `https://${found.host}:${found.port}`;
  }

  private async startListener(
    listener: ListenerId,
    host: string,
    bindAddress: string,
    key: Buffer,
    cert: Buffer,
  ): Promise<void> {
    const server = createServer({ key, cert }, (request, response) => {
      const requestUrl = new URL(request.url ?? '/', `https://${request.headers.host ?? host}`);
      if (request.method === 'POST' && requestUrl.pathname === '/callback') {
        const digest = createHash('sha256');
        let bodyBytes = 0;
        const bodyChunks: Buffer[] = [];
        request.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bodyBytes += bytes.byteLength;
          digest.update(bytes);
          bodyChunks.push(bytes);
        });
        request.on('end', () => {
          const rawBody = Buffer.concat(bodyChunks);
          let bodyJson: unknown;
          try {
            bodyJson = JSON.parse(rawBody.toString('utf8')) as unknown;
          } catch {
            bodyJson = undefined;
          }
          const bodySha256 = digest.digest('hex');
          this.events.push({
            kind: 'request', listener, method: request.method, path: requestUrl.pathname,
            host: request.headers.host, sni: (request.socket as TLSSocket).servername,
            bodyBytes,
            bodySha256,
            bodyRawBytes: rawBody.byteLength,
            bodySha256Recomputed: createHash('sha256').update(rawBody).digest('hex'),
            bodyRawText: rawBody.toString('utf8'),
            bodyJson,
          });
          response.writeHead(204).end();
        });
        return;
      }

      this.events.push({
        kind: 'request', listener, method: request.method, path: requestUrl.pathname,
        host: request.headers.host, sni: (request.socket as TLSSocket).servername,
      });
      if (requestUrl.pathname === '/file.txt' && request.method === 'GET') {
        const body = Buffer.from('ORV14 private HTTPS worker file bytes\n', 'utf8');
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="secure.txt"',
          'content-length': String(body.byteLength),
        }).end(body);
      } else if (requestUrl.pathname === '/redirect') {
        response.writeHead(302, { location: `https://${request.headers.host}/file.txt`, 'content-length': '0' }).end();
      } else if (requestUrl.pathname === '/oversize') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(5 * 1024 * 1024 + 1) });
        response.flushHeaders();
        response.end('x');
      } else if (requestUrl.pathname === '/flaky' && request.method === 'GET') {
        if (this.count(listener, 'request', '/flaky') === 1) {
          response.writeHead(503, { 'content-length': '0' }).end();
        } else {
          const body = Buffer.from('ORV14 retried private HTTPS bytes\n', 'utf8');
          response.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="retried.txt"',
            'content-length': String(body.byteLength),
          }).end(body);
        }
      } else if (requestUrl.pathname === '/slow') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '35' });
        response.flushHeaders();
        const timer = setTimeout(() => {
          this.slowTimers.delete(timer);
          if (!response.destroyed) response.end('cancelled request should close first');
        }, 20_000);
        this.slowTimers.add(timer);
        response.on('close', () => {
          if (!response.writableEnded) this.events.push({ kind: 'client-close', listener, path: requestUrl.pathname });
          clearTimeout(timer);
          this.slowTimers.delete(timer);
        });
      } else {
        response.writeHead(404, { 'content-length': '0' }).end();
      }
    });
    server.on('secureConnection', (socket) => {
      this.events.push({ kind: 'tls', listener, sni: socket.servername ?? null });
    });
    server.on('tlsClientError', (error, socket) => {
      const code = (error as NodeJS.ErrnoException).code;
      this.events.push({ kind: 'tls-error', listener, sni: socket.servername ?? null, errorCode: code ?? error.name });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, bindAddress, () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error(`private HTTPS listener ${listener} has no TCP address`);
    this.listeners.push({ server, listener, host, bindAddress, port: (address as AddressInfo).port });
  }
}
