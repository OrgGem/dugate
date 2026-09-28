import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenLoopback } from '../listen-loopback';
import { randomUUID } from 'node:crypto';

/**
 * SEC-INT-01 harness (cycle 102): in-memory MOCK Vault HTTP server — no
 * external Vault binary. Speaks just enough KV v2 + sys/leases to exercise
 * the REAL code paths of the renewal daemon and the credential workflow:
 *
 *   POST /v1/auth/token/create           client_token + lease_duration + renewable
 *   POST /v1/sys/leases/renew            extension honoring the renewable flag
 *   POST /v1/sys/leases/revoke           hard revoke
 *   GET/POST /v1/{mount}/data/{path}     KV v2 read / CAS write (412 on conflict)
 *   GET  /v1/{mount}/metadata/{path}     versions WITHOUT values
 *
 * Lease machinery: per-token lease_duration, flip-able renewable boolean
 * (drives the daemon's re-login path), and an EXPIRATION COUNTER — a lease
 * used past its expiry is marked expired EXACTLY ONCE and counted, against
 * the harness clock (advance()), so tests never sleep on real TTLs.
 * Authorization is per-token with a role path prefix, so policy denials are
 * real 403s on the wire. Request records carry route/status/path only —
 * never bodies — upholding zero-secret logging in the harness itself.
 */

export interface MockVaultOptions {
  leaseDurationMs?: number;
  renewable?: boolean;
  mount?: string;
  allowedPrefix?: string;
  initialNowMs?: number;
  /** Quiet-band port to bind first (see listen-loopback). */
  preferPort?: number;
}

interface MockToken {
  value: string;
  leaseId: string;
  expiresAt: number;
  renewable: boolean;
  revoked: boolean;
}

interface RecordedVersion {
  version: number;
  createdAt: number;
  data: Record<string, unknown>;
}

export interface MockVaultServer {
  url: string;
  now(): number;
  advance(ms: number): void;
  stop(): Promise<void>;
  counters(): { issued: number; renewCount: number; revokeCount: number; expiredLeases: number; writes: number };
  setNextTokenRenewable(renewable: boolean): void;
  failNextWrite(mode: 'server-error' | 'policy-denied'): void;
  versionsOf(path: string): number[];
  readValue(path: string, key: string): Promise<{ value: unknown; version: number } | undefined>;
  requests(): Array<{ route: string; status: number; path: string }>;
}

export async function startMockVaultServer(options: MockVaultOptions = {}): Promise<MockVaultServer> {
  let clock = options.initialNowMs ?? 1_000;
  const now = (): number => clock;
  const leaseDurationMs = options.leaseDurationMs ?? 120_000;
  let nextRenewable = options.renewable ?? true;
  const mount = options.mount ?? 'secret';
  const allowedPrefix = options.allowedPrefix ?? 'du/connector';

  const tokens = new Map<string, MockToken>();
  const secrets = new Map<string, RecordedVersion[]>();
  const counters = { issued: 0, renewCount: 0, revokeCount: 0, expiredLeases: 0, writes: 0 };
  let failNext: 'server-error' | 'policy-denied' | undefined;
  const requestLog: Array<{ route: string; status: number; path: string }> = [];

  const authorize = (rawToken: string | undefined): MockToken | null => {
    if (!rawToken) return null;
    const token = tokens.get(rawToken);
    if (!token || token.revoked) return null;
    if (now() >= token.expiresAt) {
      token.revoked = true;
      counters.expiredLeases += 1;
      return null;
    }
    return token;
  };

  const readBody = (req: { on: (ev: string, cb: (c?: Buffer) => void) => void }): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c?: Buffer) => {
        if (c) chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://mockvault');
      const path = url.pathname;
      const record = (route: string, status: number): void => {
        requestLog.push({ route, status, path });
      };
      const headerValue = (name: string): string | undefined => {
        const raw = req.headers[name];
        return Array.isArray(raw) ? raw[0] : raw;
      };

      if (method === 'POST' && path === '/v1/auth/token/create') {
        await readBody(req);
        counters.issued += 1;
        const id = randomUUID();
        const token: MockToken = {
          value: 'hvs.mock-' + id,
          leaseId: 'lease-' + id,
          expiresAt: now() + leaseDurationMs,
          renewable: nextRenewable,
          revoked: false,
        };
        nextRenewable = options.renewable ?? true; // scripted flag is one-shot
        tokens.set(token.value, token);
        record('token-create', 200);
        return json(res, 200, {
          auth: {
            client_token: token.value,
            lease_id: token.leaseId,
            lease_duration: Math.max(0, Math.round((token.expiresAt - now()) / 1000)),
            renewable: token.renewable,
            accessor: 'acc-' + id,
          },
        });
      }

      if (method === 'POST' && (path === '/v1/sys/leases/renew' || path === '/v1/sys/leases/revoke')) {
        const body = await readBody(req);
        const leaseId = typeof body.lease_id === 'string' ? body.lease_id : '';
        const token = [...tokens.values()].find((t) => t.leaseId === leaseId);
        if (!token || token.revoked) {
          record('leases-bad', 403);
          return json(res, 403, { errors: ['permission denied'] });
        }
        if (now() >= token.expiresAt) {
          token.revoked = true;
          counters.expiredLeases += 1;
          record('leases-expired', 403);
          return json(res, 403, { errors: ['permission denied: lease expired'] });
        }
        if (path.endsWith('/revoke')) {
          token.revoked = true;
          counters.revokeCount += 1;
          record('leases-revoke', 204);
          return json(res, 204, {});
        }
        if (!token.renewable) {
          record('leases-unrenewable', 400);
          return json(res, 400, { errors: ['lease is not renewable'] });
        }
        const increment = typeof body.increment === 'number' ? body.increment * 1000 : leaseDurationMs;
        token.expiresAt = now() + increment;
        counters.renewCount += 1;
        record('leases-renew', 200);
        return json(res, 200, { lease_id: token.leaseId, renewable: true, lease_duration: Math.round(increment / 1000) });
      }

      const dataMatch = /^\/v1\/([^/]+)\/data\/(.+)$/.exec(path);
      const metaMatch = /^\/v1\/([^/]+)\/metadata\/(.+)$/.exec(path);
      if (dataMatch || metaMatch) {
        const m = dataMatch ?? metaMatch!;
        const reqMount = m[1]!;
        const secretPath = m[2]!;
        const token = authorize(headerValue('x-vault-token'));
        if (!token) {
          record('auth-denied', 403);
          return json(res, 403, { errors: ['permission denied'] });
        }
        if (reqMount !== mount) {
          record('unknown-mount', 404);
          return json(res, 404, { errors: [] });
        }
        if (secretPath !== allowedPrefix && !secretPath.startsWith(allowedPrefix + '/')) {
          record('policy-denied', 403);
          return json(res, 403, { errors: ['1 error occurred:: permission denied: path outside role prefix'] });
        }
        if (metaMatch && method === 'GET') {
          const versions = secrets.get(secretPath) ?? [];
          record('metadata-read', 200);
          return json(res, 200, {
            data: {
              versions: versions.map((v) => v.version),
              current_version: versions.length > 0 ? versions[versions.length - 1]!.version : 0,
            },
          });
        }
        if (method === 'GET') {
          const versions = secrets.get(secretPath) ?? [];
          const latest = versions[versions.length - 1];
          if (!latest) {
            record('data-404', 404);
            return json(res, 404, { errors: [] });
          }
          record('data-read', 200);
          return json(res, 200, { data: { data: latest.data, metadata: { version: latest.version, created_time: latest.createdAt } } });
        }
        if (method === 'POST') {
          if (failNext === 'server-error') {
            failNext = undefined;
            record('write-500', 500);
            return json(res, 500, { errors: ['internal server error'] });
          }
          if (failNext === 'policy-denied') {
            failNext = undefined;
            record('write-403', 403);
            return json(res, 403, { errors: ['1 error occurred:: permission denied'] });
          }
          const body = await readBody(req);
          const data = (body.data ?? {}) as Record<string, unknown>;
          const writeOptions = (body.options ?? {}) as Record<string, unknown>;
          const versions = secrets.get(secretPath) ?? [];
          const current = versions.length > 0 ? versions[versions.length - 1]!.version : 0;
          if (typeof writeOptions.cas === 'number' && writeOptions.cas !== current) {
            record('write-cas-conflict', 412);
            return json(res, 412, { errors: ['Check-and-Set failed'] });
          }
          const next: RecordedVersion = {
            version: current + 1,
            createdAt: now(),
            data: { ...versions[versions.length - 1]?.data, ...data },
          };
          versions.push(next);
          secrets.set(secretPath, versions);
          counters.writes += 1;
          record('write', 200);
          return json(res, 200, { data: { version: next.version, created_time: next.createdAt } });
        }
      }
      record('not-found', 404);
      json(res, 404, { errors: [] });
    })().catch(() => {
      try {
        res.statusCode = 500;
        res.end();
      } catch {
        /* socket gone */
      }
    });
  });

  const boundPort = await listenLoopback(server, options.preferPort ?? 41300);
  void boundPort;
  server.keepAliveTimeout = 0;
  const addr = server.address() as AddressInfo;

  function json(res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    now,
    advance(ms: number) {
      clock += ms;
    },
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    counters: () => ({ ...counters }),
    setNextTokenRenewable(r: boolean) {
      nextRenewable = r;
    },
    failNextWrite(mode: 'server-error' | 'policy-denied') {
      failNext = mode;
    },
    versionsOf(secretPath: string) {
      return (secrets.get(secretPath) ?? []).map((v) => v.version);
    },
    async readValue(secretPath: string, key: string) {
      const versions = secrets.get(secretPath) ?? [];
      const latest = versions[versions.length - 1];
      if (!latest || !(key in latest.data)) return undefined;
      return { value: latest.data[key], version: latest.version };
    },
    requests: () => [...requestLog],
  };
}
