import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, type Socket } from 'node:net';

/**
 * Controllable Mock AI/Document Provider Server (P1-05 / docs 13)
 *
 * Implements a programmable HTTP server that simulates upstream AI/OCR providers
 * with controllable latency, rate limits, malformed JSON, and the critical
 * "received-but-response-lost" fault injection hook required by ADR/docs 13.
 */

export interface RecordedProviderCall {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  timestamp: number;
}

export interface MockProviderFaultOptions {
  /** Drops connection after receiving request without sending response (CON-05 fault) */
  simulateResponseLost?: boolean;
  /** Injects artificial delay in milliseconds */
  delayMs?: number;
  /** Returns 429 rate limit with optional retry-after header */
  rateLimit?: { retryAfterSeconds?: number };
  /** Returns 503 service unavailable */
  unavailable?: boolean;
  /** Returns 504 gateway timeout */
  timeout?: boolean;
  /** Returns invalid, unparseable JSON */
  malformedJson?: boolean;
}

export interface MockProviderResponseConfig {
  status?: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
}

export class MockProviderServer {
  private server?: Server;
  private port = 0;
  private readonly calls: RecordedProviderCall[] = [];
  private readonly activeSockets = new Set<Socket>();
  private inFlight = 0;

  private faultConfig: MockProviderFaultOptions = {};
  private defaultResponseConfig: MockProviderResponseConfig = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      content: 'Mock provider structured analysis result',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        costMicrousd: 250,
        measurement: 'measured',
      },
    },
  };

  public get callCount(): number {
    return this.calls.length;
  }

  public get callHistory(): readonly RecordedProviderCall[] {
    return this.calls;
  }

  public get inFlightCount(): number {
    return this.inFlight;
  }

  public get baseUrl(): string {
    if (!this.server || this.port === 0) throw new Error('Mock provider server is not running');
    return `http://127.0.0.1:${this.port}`;
  }

  public setFaults(faults: MockProviderFaultOptions): void {
    this.faultConfig = { ...faults };
  }

  public setDefaultResponse(config: MockProviderResponseConfig): void {
    this.defaultResponseConfig = { ...config };
  }

  public reset(): void {
    this.calls.length = 0;
    this.inFlight = 0;
    this.faultConfig = {};
  }

  public async start(desiredPort = 0): Promise<number> {
    if (this.server) return this.port;

    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => this.handleRequest(req, res));
      this.server = srv;

      srv.on('connection', (socket) => {
        this.activeSockets.add(socket);
        socket.once('close', () => this.activeSockets.delete(socket));
      });

      srv.listen(desiredPort, '127.0.0.1', () => {
        const addr = srv.address() as AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });

      srv.once('error', reject);
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) return;

    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
    this.port = 0;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.inFlight++;

    // Consume request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    this.calls.push({
      method: req.method ?? 'POST',
      url: req.url ?? '/',
      headers: req.headers,
      body: rawBody,
      timestamp: Date.now(),
    });

    try {
      // 1. Critical "received-but-response-lost" hook (CON-05 / docs 13 requirement)
      if (this.faultConfig.simulateResponseLost) {
        req.socket.destroy();
        return;
      }

      // 2. Artificial latency delay
      if (this.faultConfig.delayMs && this.faultConfig.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.faultConfig.delayMs));
      }

      // 3. Fault: Rate limit
      if (this.faultConfig.rateLimit) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(this.faultConfig.rateLimit.retryAfterSeconds ?? 2),
        });
        res.end(JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Quota exhausted' } }));
        return;
      }

      // 4. Fault: Unavailable / Timeout
      if (this.faultConfig.unavailable) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Downstream unavailable' } }));
        return;
      }
      if (this.faultConfig.timeout) {
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'GATEWAY_TIMEOUT', message: 'Gateway timed out' } }));
        return;
      }

      // 5. Fault: Malformed JSON
      if (this.faultConfig.malformedJson) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{ invalid_json_payload: [ truncated ...');
        return;
      }

      // 6. Normal response
      const status = this.defaultResponseConfig.status ?? 200;
      const headers = this.defaultResponseConfig.headers ?? { 'content-type': 'application/json' };
      const bodyStr = typeof this.defaultResponseConfig.body === 'string'
        ? this.defaultResponseConfig.body
        : JSON.stringify(this.defaultResponseConfig.body ?? {});

      res.writeHead(status, headers);
      res.end(bodyStr);
    } finally {
      this.inFlight--;
    }
  }
}
