/**
 * Standalone sub-server for the Admin shell (P6-01).
 *
 * The orchestrator's `createApp` already binds one port to the JSON
 * API. The Admin shell is a separate browser-tier surface with
 * different auth (signed cookie, not bearer token). Co-hosting on the
 * same port would muddy the auth boundary, so the shell listens on a
 * dedicated port (defaults to the orchestrator's port if not
 * overridden).
 *
 * The shell is **not** mounted by `createApp` today — see
 * `coordination/reports/openclaude.md` §6.2 and §3 item 3 for the
 * one-line platform integration request. The exported
 * `attachAdminShell` is the function a platform owner calls to start
 * this sub-server alongside `createApp`.
 *
 * Pure HTTP. No DB, no Redis. Strict TypeScript, zero `any`.
 */

import {
  createServer,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@du/observability';
import { dispatchShellRequestAsync } from './shell-router';
import { parseCookieSecurePolicy } from './oidc-boot';
import type { OidcFlow } from './oidc-flow';
import type { AdminSecurityAuditSink, AdminSessionStore } from '../../modules/admin-actions/rbac';
import type { ShellRuntimeConfig } from './shell-router';
import { wrapTablesForReflow } from './shell-render';
import { errorClassOf, safeTransportErrorText } from '../../http/errors';
import type {
  AdminShellRequest,
  AdminShellResponse,
} from './shell-types';
import { parseCookieHeader, parseFormBody, parseQueryString } from './shell-router';
import { fetchBusinessVersions } from './business-section-data';
import { fetchProfileForm } from './profile-section-data';
import { fetchConnectorConfig } from './connector-section-data';

const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'admin-shell' } });
import { fetchApiKeys } from './api-key-section-data';
import { fetchOperationDetail } from './operation-section-data';
import { fetchOverview } from './overview-section-data';
import { fetchAuditEvents } from './audit-section-data';
import { normalizeCorrelationId } from '@du/observability';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Sub-server handle returned by `createAdminShellServer`. Lets the
 * caller start/stop the listener without exposing `node:http.Server`
 * internals.
 */
export interface AdminShellHandle {
  /** Start listening. Resolves when the listener is bound (port=0 → OS-assigned). */
  listen(): Promise<{ port: number; url: string }>;
  /** Stop accepting new connections; close idle sockets. */
  close(): Promise<void>;
  /** The configured base URL (`http://host:port`). Empty until listen() resolves. */
  readonly url: string;
  /** The actual bound port (0 until listen() resolves). */
  readonly port: number;
  /** Last response status by route id — useful for the in-process test only. */
  readonly lastRouteId: () => string;
}

/** Factory options. `port=0` picks an OS-assigned ephemeral port (test harness). */
export interface CreateAdminShellServerOptions {
  port?: number;
  host?: string;
  cookieSecret: string;
  adminToken: string;
  cookieMaxAgeSeconds?: number;
  /** Injectable clock — tests pass a deterministic function. */
  nowMs?: () => number;
  /** OIDC-04: mounted IdP login/callback/logout flow (see ./oidc-flow). */
  oidcFlow?: OidcFlow;
  /** OIDC-04/CYCLE-101: opaque session store behind the flow — enables
   *  the protected-route session gate (live -> claims; dead -> 302 login). */
  oidcSessions?: AdminSessionStore;
  /**
   * W-SEC-COOKIE-CONFIG-1 (delta-27/33): Secure-cookie policy for the
   * legacy du_admin plane. Default: parsed from process.env
   * (DU_ADMIN_TRUST_PROXY_PROTOCOL / DU_ADMIN_COOKIE_SECURE / NODE_ENV)
   * ONCE at mount via oidc-boot's parseCookieSecurePolicy — a garbage
   * value refuses the mount (fail closed, same rule as OIDC boot).
   * Tests inject directly instead of mutating the environment.
   */
  cookiePolicy?: ShellRuntimeConfig['cookiePolicy'];
  /**
   * W-SEC-AUDIT-TAXONOMY-1: security-event sink. Default: ONE structured
   * console line per event ([admin-shell] security event + JSON of the
   * closed AdminSecurityEvent — fixed vocabulary, never a credential, the
   * ADM-BASE-03 class-only discipline). Tests and a future ledger wiring
   * (Platform lane, server.ts) inject here instead of editing the router.
   */
  securityAudit?: AdminSecurityAuditSink;
  /**
   * Per-section data fetchers. P6-02 ships the businesses fetcher
   * (default: `fetchBusinessVersions` from `./business-section-data`).
   * Tests inject stubs to drive the response shape; the platform
   * adapter leaves this `undefined` and gets the default fetcher
   * bound to its configured `jsonBaseUrl`.
   *
   * `jsonBaseUrl` is the orchestrator's JSON API base URL
   * (`http://127.0.0.1:2023` in production). When omitted, the
   * default fetcher is *not* wired — the section renders the
   * not-found pane until the platform provides a base URL.
   */
  sectionFetchers?: ShellRuntimeConfig['sectionFetchers'];
  /** JSON API base URL for the default businesses fetcher. */
  jsonBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 16 * 1024; // generous for a login form, never a large upload.

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildRequest(
  req: IncomingMessage,
  pathname: string,
  query: string,
  bodyText: string,
): AdminShellRequest {
  const method = (req.method ?? 'GET').toUpperCase();
  const cookieHeader = req.headers['cookie'];
  const cookies = parseCookieHeader(
    Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader,
  );
  const m = method === 'POST' ? 'POST' : method === 'HEAD' ? 'HEAD' : 'GET';
  const body = m === 'POST' ? parseFormBody(bodyText) : {};
  const xfp = req.headers['x-forwarded-proto'];
  const forwardedProto = typeof xfp === 'string' ? xfp : Array.isArray(xfp) ? xfp.join(', ') : undefined;
  return {
    method: m,
    pathname,
    cookies,
    body,
    query: parseQueryString(query),
    ...(typeof forwardedProto === 'string' ? { forwardedProto } : {}),
  };
}

/** Async path: resolves deferredSectionExtras before writing. */
async function writeResponseAsync(
  res: ServerResponse,
  payload: AdminShellResponse,
  correlationId: string,
): Promise<void> {
  res.statusCode = payload.status;
  for (const [k, v] of Object.entries(payload.headers)) {
    res.setHeader(k, v);
  }
  if (res.statusCode === 204 || res.statusCode === 302 || res.statusCode === 301) {
    res.end();
    return;
  }
  let extras: string | undefined = payload.sectionExtras;
  if (payload.deferredSectionExtras) {
    try {
      extras = (await payload.deferredSectionExtras()) ?? extras;
    } catch (err) {
      // Defensive: never let a fetcher exception crash the response — and
      // (ADM-BASE-03) never let it vanish either: log the error CLASS only,
      // never err.message/String(err), so operators keep a joinable signal.
      // W-ADMBASE03-ERR-1: the degraded 200 carries a correlationId (header
      // + log) so an operator can join the wire to the class-only log line —
      // ADM-BASE-03 owes every unexpected-error surface code + correlationId.
      if (!res.headersSent) res.setHeader('x-correlation-id', correlationId);
      logger.error('[admin-shell] deferred section render error', {
        correlationId,
        errorClass: errorClassOf(err),
      });
    }
  }
  // W48-O2 (ADM-UX-01): the per-section renderers (api-key / overview /
  // operation / connector / profile / business) emit raw <table> markup
  // for their content panes. Wrap every top-level <table> in
  // `.adm-reflow-scroller` so the wrapper becomes an independent layout
  // root (overflow: clip + contain: layout paint) and the table cannot
  // leak into the page scroll chain at 320 CSS px. Mirrors the same
  // helper applied to the ready-state body in `shell-render.ts` so a
  // single regex owns the wrapper contract end-to-end. Idempotent and
  // a no-op when no <table> is present.
  if (extras) extras = wrapTablesForReflow(extras);
  let body = payload.body;
  if (extras && body.includes('</section></main>')) {
    const idx = body.indexOf('</section></main>');
    body = body.slice(0, idx) + extras + body.slice(idx);
  } else if (extras) {
    if (body.includes('</body>')) {
      const idx = body.indexOf('</body>');
      body = body.slice(0, idx) + extras + body.slice(idx);
    } else {
      body = body + extras;
    }
  }
  res.end(body);
}

function writeResponse(res: ServerResponse, payload: AdminShellResponse, correlationId: string): void {
  if (payload.deferredSectionExtras) {
    writeResponseAsync(res, payload, correlationId).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('x-correlation-id', correlationId);
      }
      // ADM-BASE-03: class-only log line; the wire gets fixed redacted text.
      logger.error('[admin-shell] deferred render error', {
        correlationId,
        errorClass: errorClassOf(err),
      });
      res.end(safeTransportErrorText('Internal error'));
    });
    return;
  }
  res.statusCode = payload.status;
  for (const [k, v] of Object.entries(payload.headers)) {
    res.setHeader(k, v);
  }
  if (res.statusCode === 204 || res.statusCode === 302 || res.statusCode === 301) {
    res.end();
    return;
  }
  let body = payload.body;
  if (payload.sectionExtras && body.includes('</section></main>')) {
    const idx = body.indexOf('</section></main>');
    body = body.slice(0, idx) + payload.sectionExtras + body.slice(idx);
  } else if (payload.sectionExtras) {
    if (body.includes('</body>')) {
      const idx = body.indexOf('</body>');
      body = body.slice(0, idx) + payload.sectionExtras + body.slice(idx);
    } else {
      body = body + payload.sectionExtras;
    }
  }
  res.end(body);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a standalone sub-server for the Admin shell. The caller is
 * responsible for `listen()` / `close()`. The factory does not touch
 * any global state (no `process`, no DB, no Redis).
 */
export function createAdminShellServer(
  options: CreateAdminShellServerOptions,
): AdminShellHandle {
  // P6-02: when the platform passes `jsonBaseUrl` but no explicit
  // fetcher, wire the default `fetchBusinessVersions` against it.
  // The platform has no `GET /api/v1/admin/businesses/:id/versions`
  // route today; the fetcher returns a `not-found` discriminated
  // result and the renderer shows the "Business list unavailable"
  // pane (no fabricated rows). When Claude Code lands the route,
  // the same wire-up serves real data.
  //
  // P6-03: add the default `fetchProfileForm` next to it. The
  // profile fetcher falls back to the in-process `manifestCatalog`
  // when `jsonBaseUrl` is unset so the renderer can still be
  // exercised end-to-end. Either fetcher can be replaced by
  // passing a custom `sectionFetchers` map to the options.
  //
  // P6-04: add the default `fetchConnectorConfig`. Mirrors the
  // profile fetcher: falls back to the in-process catalog when
  // `jsonBaseUrl` is unset, otherwise targets
  // `GET {jsonBaseUrl}/api/v1/admin/connectors/:id/revisions/:rev`
  // (the platform exposes only `POST /api/v1/admin/connector-bindings`
  // today; the GET endpoint is requested in
  // `coordination/reports/openclaude.md`). Until the route lands,
  // the connector pane renders a `not-found` discriminated result.
  //
  // P6-05: add the default `fetchApiKeys`. Mirrors the same shape:
  // falls back to the in-process catalog when `jsonBaseUrl` is
  // unset, otherwise targets
  // `GET {jsonBaseUrl}/api/v1/admin/api-keys[/<keyId>]`. The
  // platform exposes only the create POST today; the GET endpoints
  // are requested in `coordination/reports/openclaude.md`. Until the
  // route lands, the api-keys pane renders the in-process catalog
  // rows (or the matching discriminated failure).
  const defaultSectionFetchers: ShellRuntimeConfig['sectionFetchers'] = (() => {
    if (options.sectionFetchers) return options.sectionFetchers;
    if (!options.jsonBaseUrl) {
      // No platform API configured — wire only the profile +
      // connector + api-keys + operations + overview fetchers so
      // their `ok` panes can be exercised via the in-process
      // manifest catalogs. The businesses fetcher is pointless
      // without a platform (the not-found pane is the honest
      // answer).
      return {
        profiles: (input) => fetchProfileForm({ ...input, jsonBaseUrl: '' }),
        connectors: (input) => fetchConnectorConfig({ ...input, jsonBaseUrl: '' }),
        apiKeys: (input) => fetchApiKeys({ ...input, jsonBaseUrl: '' }),
        operations: (input) => fetchOperationDetail({ ...input, jsonBaseUrl: '' }),
        overview: (input) => fetchOverview({ ...input, jsonBaseUrl: '' }),
        audit: (input) => fetchAuditEvents({ ...input, jsonBaseUrl: '' }),
      };
    }
    return {
      businesses: (input) =>
        fetchBusinessVersions({ ...input, jsonBaseUrl: options.jsonBaseUrl! }),
      profiles: (input) =>
        fetchProfileForm({ ...input, jsonBaseUrl: options.jsonBaseUrl! }),
      connectors: (input) =>
        fetchConnectorConfig({ ...input, jsonBaseUrl: options.jsonBaseUrl! }),
      apiKeys: (input) =>
        fetchApiKeys({ ...input, jsonBaseUrl: options.jsonBaseUrl! }),
      operations: (input) =>
        fetchOperationDetail({ ...input, jsonBaseUrl: options.jsonBaseUrl! }),
      overview: (input) =>
        fetchOverview({ ...input, jsonBaseUrl: options.jsonBaseUrl! }),
      audit: (input) =>
        fetchAuditEvents({ ...input, jsonBaseUrl: options.jsonBaseUrl! }),
    };
  })();

  // Read ONCE at mount: a rotated knob mid-life would leave a deployment
  // with two cookie postures at the same boundary (delta-26 rule).
  const cookiePolicy = options.cookiePolicy ?? parseCookieSecurePolicy(process.env);
  const securityAudit: AdminSecurityAuditSink =
    options.securityAudit ??
    ((event) => {
      logger.warn('[admin-shell] security event', { event });
    });
  const config: ShellRuntimeConfig = {
    cookieSecret: options.cookieSecret,
    adminToken: options.adminToken,
    cookieMaxAgeSeconds: options.cookieMaxAgeSeconds,
    nowMs: options.nowMs,
    oidcFlow: options.oidcFlow,
    oidcSessions: options.oidcSessions,
    cookiePolicy,
    securityAudit,
    sectionFetchers: defaultSectionFetchers,
    adminAction: options.jsonBaseUrl ? async (action, params) => {
      const response = await fetch(new URL('/api/v1/admin/actions', options.jsonBaseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action,
          params: action === 'apikey.issue'
            ? { ...params, apiKey: `du_${randomBytes(32).toString('base64url')}` }
            : params,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      return {
        status: response.status,
        body: payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : {},
      };
    } : undefined,
  };

  let lastRouteId = 'unknown';
  const server = createServer(async (req, res) => {
    const rawCorrelationId = req.headers['x-correlation-id'];
    const correlationId = normalizeCorrelationId(rawCorrelationId);
    res.setHeader('x-correlation-id', correlationId);
    try {
      const url = req.url ?? '/';
      const qIdx = url.indexOf('?');
      const pathname = qIdx < 0 ? url : url.slice(0, qIdx);
      const query = qIdx < 0 ? '' : url.slice(qIdx + 1);
      const bodyText =
        (req.method ?? 'GET').toUpperCase() === 'POST' ? await readBody(req) : '';
      const request = buildRequest(req, pathname, query, bodyText);
      const out = await dispatchShellRequestAsync(request, config);
      lastRouteId = out.routeId;
      writeResponse(res, out.response, correlationId);
    } catch (err) {
      lastRouteId = 'error';
      // W-ADMBASE03-ERR-1: the browser-tier boundary answers the SAME
      // contract as the JSON API (ADM-BASE-03): a stable code, fixed safe
      // copy and a correlationId — never the upstream text, the error
      // message or a stack. The id goes out in the header, on the page and
      // in the class-only log line so wire↔log stays joinable.
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('x-correlation-id', correlationId);
      logger.error('[admin-shell] unhandled request error', {
        correlationId,
        errorClass: errorClassOf(err),
        routeId: lastRouteId,
      });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Admin shell error</title>' +
          '<p>' +
          safeTransportErrorText('Internal error') +
          '</p>' +
          '<p>Code: TEMPORARY_UNAVAILABLE. Correlation ID: ' +
          correlationId +
          '</p>',
      );
    }
  });

  const host = options.host ?? '127.0.0.1';
  const desiredPort = options.port ?? 0;

  let boundPort = desiredPort;
  let baseUrl = '';

  return {
    get url(): string {
      return baseUrl;
    },
    get port(): number {
      return boundPort;
    },
    lastRouteId: () => lastRouteId,
    listen(): Promise<{ port: number; url: string }> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const addr = server.address() as AddressInfo | null;
          if (!addr) {
            reject(new Error('Server has no address after listen'));
            return;
          }
          boundPort = addr.port;
          baseUrl = `http://${addr.address}:${addr.port}`;
          resolve({ port: addr.port, url: baseUrl });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(desiredPort, host);
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Platform mount helper
// ---------------------------------------------------------------------------

/**
 * Platform helper exported from `src/app/admin` so the orchestrator's
 * `createApp` can mount the shell without editing `src/server.ts`
 * beyond a single one-line call.
 *
 * Currently a thin wrapper around `createAdminShellServer`. Future
 * additions (e.g. `ctx.db` propagation, `attachAdminShellServer` hook
 * callbacks, lifecycle integration with `ctx.shutdown`) live here.
 */
export interface AdminShellAttachInput {
  /** Platform config object passed to `createApp` — we read adminShellCookieSecret, adminShellPort, adminToken. */
  config: {
    adminShellCookieSecret?: string;
    adminShellPort?: number;
    adminShellHost?: string;
    adminToken?: string;
    /**
     * Optional JSON API base URL for the section fetchers. When
     * unset the default businesses fetcher is *not* wired; the
     * section renders the not-found pane. P6-02 default fetcher
     * (when `jsonBaseUrl` is set) calls
     * `GET {jsonBaseUrl}/api/v1/admin/businesses/:id/versions`,
     * which the platform does not yet expose — see the request
     * recorded in `coordination/reports/openclaude.md`.
     */
    jsonBaseUrl?: string;
    /** OIDC-04: opaque-session IdP flow built by the platform
     *  (modules/auth/oidc-client + session-store + app/admin/oidc-flow). */
    adminOidcFlow?: OidcFlow;
    /** OIDC-02/CYCLE-101: the session store the gate resolves du_session against. */
    adminSessionStore?: AdminSessionStore;
  };
}

export interface AdminShellAttachResult {
  handle: AdminShellHandle;
  /** URL the shell is bound to (after listen). */
  url: string;
}

export async function attachAdminShell(
  input: AdminShellAttachInput,
): Promise<AdminShellAttachResult | null> {
  const secret = input.config.adminShellCookieSecret;
  if (!secret) return null; // fail-closed: do not mount a shell with no secret
  const adminToken = input.config.adminToken;
  if (!adminToken) return null;
  const handle = createAdminShellServer({
    port: input.config.adminShellPort ?? 0,
    host: input.config.adminShellHost ?? '127.0.0.1',
    cookieSecret: secret,
    adminToken,
    jsonBaseUrl: input.config.jsonBaseUrl,
    oidcFlow: input.config.adminOidcFlow,
    oidcSessions: input.config.adminSessionStore,
  });
  await handle.listen();
  return { handle, url: handle.url };
}
