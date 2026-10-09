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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve as resolvePath, sep } from 'node:path';
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
  AdminCookieClaims,
  AdminShellRequest,
  AdminShellResponse,
} from './shell-types';
import { parseCookieHeader, parseFormBody, parseQueryString } from './shell-router';
import { verifyCookie } from './shell-auth';
import { liveSessionClaims } from './auth-dispatch';
import { SESSION_COOKIE_NAME } from '../../modules/auth/session-store';
import { handleBffRequest, isBffPath, type BffRuntimeConfig } from './bff/handle';
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
  /**
   * AWEB-01: static Admin Web mount (Vite build) behind a per-route flag.
   * Default OFF: when neither this option nor the `DU_ADMIN_WEB` env flag is
   * set the route does not exist and the legacy rendered shell is untouched.
   * Tests inject here; the platform uses the env flag
   * (`DU_ADMIN_WEB=1` → `admin`, or `DU_ADMIN_WEB=/path`).
   */
  adminWeb?: AdminWebMountOptions;
  /**
   * AWEB-02: per-tenant admin bearers (ServerConfig.tenantAdminTokens). The
   * BFF uses them for tenant_operator sessions only; a session whose tenant
   * has no entry fails closed (403 TENANT_SCOPE_UNAVAILABLE) instead of
   * borrowing the platform token.
   */
  tenantAdminTokens?: Record<string, string>;
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
// Admin Web static mount (AWEB-01) — per-route flag, default OFF
// ---------------------------------------------------------------------------
//
// The React Admin Web build (du-rework/apps/admin-web/dist, Vite) is served by
// this shell at one route prefix, after the SAME session gate the rendered
// shell uses. The flag is env-driven (DU_ADMIN_WEB) or injected by tests; when
// it is unset nothing changes for the legacy routes.
//
// Serving contract:
//   - `admin`, `admin/`, and any non-asset deep link -> index.html,
//     `cache-control: no-store`, strict CSP, and the session gate above.
//   - `admin/assets/<hashed-file>` -> immutable (max-age 1 year), a small
//     content-type allow-list; a missing asset is a 404 (never the SPA HTML).
//   - No session -> 302 to `/admin/login` (same destination as the rendered
//     shell's protected-route gate).
//   - Flag on but no bundle on disk -> 503 with a fixed message (never a
//     silent fallback to the legacy page or a fabricated app).

/** Options for the static Admin Web mount (Vite build served by this shell). */
export interface AdminWebMountOptions {
  /** URL path prefix. Default: `admin`. */
  path?: string;
  /** Absolute directory holding the Vite build (index.html + assets/). */
  distDir: string;
}

interface ResolvedAdminWebMount {
  path: string;
  distDir: string;
  bundlePresent: boolean;
  /**
   * AWEB-08-prep per-route rollout allow-list (`DU_ADMIN_WEB_ROUTES`).
   * `null` = unrestricted (absent env → today's behaviour: the whole SPA is
   * served). An array (possibly empty) restricts every non-root SPA route:
   * anything outside the list answers ONE consistent 404 document that points
   * at the legacy renderer, which stays the default surface until a route is
   * explicitly enabled.
   */
  routes: readonly string[] | null;
}

const DEFAULT_ADMIN_WEB_PATH = '/admin';

/** The SPA route names the rollout flag understands (path segment = name). */
const ADMIN_WEB_ROUTE_NAMES = [
  'overview',
  'profiles',
  // Swagger UI surface. Recognised so a deployment can opt into
  // admin/api-docs via DU_ADMIN_WEB_ROUTES without the name being
  // dropped as unknown (and the route answering the generic 404).
  'api-docs',
  'api-keys',
  'connectors',
  'operations',
  'businesses',
  'usage',
  'security',
  // SC-03: Secret catalog screen (list/create/link/rotate/disable).
  'secrets',
  'identity',
  'settings',
  'workflows',
] as const;

const ADMIN_WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const INDEX_CONTENT_TYPE = 'text/html; charset=utf-8';

const ADMIN_WEB_ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function normalizeAdminWebPath(value: string): string {
  const trimmed = value.trim();
  const withoutTrailing = trimmed.replace(/\/+$/, '');
  if (withoutTrailing === '') return '/';
  return withoutTrailing.startsWith('/') ? withoutTrailing : '/' + withoutTrailing;
}

function parseAdminWebFlag(raw: string | undefined): { enabled: boolean; path: string } {
  const value = (raw ?? '').trim();
  if (value === '') return { enabled: false, path: DEFAULT_ADMIN_WEB_PATH };
  const lowered = value.toLowerCase();
  if (lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on') {
    return { enabled: true, path: DEFAULT_ADMIN_WEB_PATH };
  }
  if (value.startsWith('/')) {
    return { enabled: true, path: normalizeAdminWebPath(value) };
  }
  logger.warn('[admin-shell] DU_ADMIN_WEB ignored (expected 1/true or an absolute path)', {
    value,
  });
  return { enabled: false, path: DEFAULT_ADMIN_WEB_PATH };
}

function resolveAdminWebDist(envValue: string | undefined): string {
  const fromEnv = (envValue ?? '').trim();
  if (fromEnv !== '') return resolvePath(fromEnv);
  const candidates = [
    resolvePath(process.cwd(), 'apps/admin-web/dist'),
    resolvePath(__dirname, '../../../../../apps/admin-web/dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  // None present: return the cwd-relative default so the 503 message and the
  // mount log point at the conventional location.
  return candidates[0] ?? resolvePath(process.cwd(), 'apps/admin-web/dist');
}

/**
 * Parse `DU_ADMIN_WEB_ROUTES` (comma-separated allow-list of SPA route names).
 * Absent/blank → `null` (unrestricted: today's behaviour). Unknown names are
 * dropped with a warning; a present list the operator emptied deliberately
 * yields an empty allow-list (everything but the shell root is gated).
 */
function parseAdminWebRoutes(raw: string | undefined): readonly string[] | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  const known = new Set<string>(ADMIN_WEB_ROUTE_NAMES);
  const allowed: string[] = [];
  const unknown: string[] = [];
  for (const token of value.split(',')) {
    const name = token.trim();
    if (name === '') continue;
    if (!known.has(name)) {
      unknown.push(name);
      continue;
    }
    if (!allowed.includes(name)) allowed.push(name);
  }
  if (unknown.length > 0) {
    logger.warn('[admin-shell] DU_ADMIN_WEB_ROUTES ignored unknown route names', { unknown });
  }
  return allowed;
}

function resolveAdminWebMount(
  options: CreateAdminShellServerOptions,
): ResolvedAdminWebMount | undefined {
  const injected = options.adminWeb;
  const envFlag = parseAdminWebFlag(process.env.DU_ADMIN_WEB);
  if (!injected && !envFlag.enabled) return undefined;
  const routePath = normalizeAdminWebPath(injected?.path ?? envFlag.path);
  const distDir = injected?.distDir
    ? resolvePath(injected.distDir)
    : resolveAdminWebDist(process.env.DU_ADMIN_WEB_DIST);
  const bundlePresent = existsSync(join(distDir, 'index.html'));
  const routes = parseAdminWebRoutes(process.env.DU_ADMIN_WEB_ROUTES);
  if (bundlePresent) {
    logger.info('[admin-shell] admin web mount enabled', {
      path: routePath,
      distDir,
      routes: routes === null ? 'all' : routes.join(',') || '(none)',
    });
  } else {
    logger.warn('[admin-shell] admin web mount enabled but bundle is missing', {
      path: routePath,
      distDir,
    });
  }
  return { path: routePath, distDir, bundlePresent, routes };
}

function isAdminWebPath(pathname: string, base: string): boolean {
  if (
    isBffPath(pathname) ||
    pathname === '/admin/login' ||
    pathname === '/admin/logout' ||
    pathname === '/admin/oidc/callback' ||
    pathname === '/admin/legacy' ||
    pathname.startsWith('/admin/legacy/')
  ) {
    return false;
  }
  return (
    pathname === base ||
    pathname.startsWith(base + '/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/admin/web' ||
    pathname.startsWith('/admin/web/') ||
    pathname === '/admin/portal' ||
    pathname.startsWith('/admin/portal/')
  );
}

/** Escape a URL-derived value before it lands in the gate's HTML document. */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setAdminWebHeaders(
  res: ServerResponse,
  cacheControl: string,
  contentType: string,
  correlationId: string,
): void {
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', cacheControl);
  res.setHeader('content-security-policy', ADMIN_WEB_CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-correlation-id', correlationId);
}

function endAdminWebText(
  res: ServerResponse,
  status: number,
  text: string,
  correlationId: string,
): void {
  setAdminWebHeaders(res, 'no-store', 'text/plain; charset=utf-8', correlationId);
  res.statusCode = status;
  res.end(text);
}

/**
 * Mirror of the rendered shell's protected-route gate (shell-router
 * `dispatchShellRequestAsync`): a live opaque session wins; a legacy du_admin
 * cookie is honored only when no du_session cookie is present at all; anything
 * else is `null` -> redirect to the login form.
 */
async function resolveAdminWebClaims(
  config: ShellRuntimeConfig,
  request: AdminShellRequest,
): Promise<AdminCookieClaims | null> {
  const now = config.nowMs ? config.nowMs() : undefined;
  if (config.oidcSessions) {
    const live = await liveSessionClaims(config, request);
    if (live) return live;
    const sessionCookie = request.cookies[SESSION_COOKIE_NAME];
    const legacy = request.cookies['du_admin'];
    const hasSessionCookie = typeof sessionCookie === 'string' && sessionCookie.length > 0;
    if (!hasSessionCookie && typeof legacy === 'string' && legacy.length > 0) {
      return verifyCookie(config.cookieSecret, legacy, now);
    }
    return null;
  }
  const legacy = request.cookies['du_admin'];
  return typeof legacy === 'string' && legacy.length > 0
    ? verifyCookie(config.cookieSecret, legacy, now)
    : null;
}

async function handleAdminWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  mount: ResolvedAdminWebMount,
  config: ShellRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    endAdminWebText(res, 405, 'Method not allowed', correlationId);
    return;
  }
  if (!mount.bundlePresent) {
    endAdminWebText(
      res,
      503,
      'Admin Web bundle is not deployed on this instance.',
      correlationId,
    );
    return;
  }

  const request = buildRequest(req, pathname, '', '');
  const claims = await resolveAdminWebClaims(config, request);
  if (!claims) {
    res.statusCode = 302;
    res.setHeader('location', '/admin/login');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', INDEX_CONTENT_TYPE);
    res.setHeader('x-correlation-id', correlationId);
    res.end();
    return;
  }

  const effectiveBase = mount.path === '/admin' ? '/admin' : mount.path;
  const cleaned = pathname
    .replace(/^\/admin\/(web|portal)/, effectiveBase)
    .replace(/^\/(web|portal)/, effectiveBase);
  const rawRelative = (cleaned.startsWith(effectiveBase) ? cleaned.slice(effectiveBase.length) : pathname.slice(mount.path.length)).replace(/^\/+/, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRelative);
  } catch {
    endAdminWebText(res, 404, 'Not found', correlationId);
    return;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) {
    endAdminWebText(res, 404, 'Not found', correlationId);
    return;
  }
  const segments = decoded === '' ? [] : decoded.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    endAdminWebText(res, 404, 'Not found', correlationId);
    return;
  }

  const isAsset = decoded.startsWith('assets/');
  if (isAsset) {
    const type = ADMIN_WEB_ASSET_TYPES[extname(decoded).toLowerCase()];
    if (!type) {
      endAdminWebText(res, 404, 'Not found', correlationId);
      return;
    }
    const target = join(mount.distDir, ...segments);
    if (!target.startsWith(mount.distDir + sep)) {
      endAdminWebText(res, 404, 'Not found', correlationId);
      return;
    }
    let file: Buffer;
    try {
      file = await readFile(target);
    } catch {
      // A missing hashed asset must fail loudly (never the SPA HTML).
      endAdminWebText(res, 404, 'Not found', correlationId);
      return;
    }
    setAdminWebHeaders(res, 'public, max-age=31536000, immutable', type, correlationId);
    res.statusCode = 200;
    if (method === 'HEAD') res.end();
    else res.end(file);
    return;
  }

  // AWEB-08-prep: per-route rollout gate. When `DU_ADMIN_WEB_ROUTES` is set,
  // every non-root SPA route outside the allow-list answers ONE consistent
  // 404 document pointing at the legacy renderer (which stays the default
  // surface until the route's cutover conditions are met). Absent env → this
  // branch never runs and behaviour is exactly the pre-AWEB-08 one.
  if (mount.routes !== null && decoded !== '') {
    const segment = decoded.split('/')[0] ?? '';
    if (segment !== '' && !mount.routes.includes(segment)) {
      setAdminWebHeaders(res, 'no-store', INDEX_CONTENT_TYPE, correlationId);
      res.statusCode = 404;
      const body =
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Route not enabled</title>' +
        '<main><h1>Route not enabled on this deployment</h1>' +
        `<p><code>${escapeHtmlText(segment)}</code> is outside this deployment's Admin Web rollout ` +
        'allow-list (<code>DU_ADMIN_WEB_ROUTES</code>).</p>' +
        '<p>The legacy renderer remains the default surface for it: ' +
        '<a href="/admin">open the legacy shell</a>.</p></main></html>';
      if (method === 'HEAD') res.end();
      else res.end(body);
      return;
    }
  }

  // Shell document (and SPA deep-link fallback): always revalidate.
  const indexPath = join(mount.distDir, 'index.html');
  let indexHtml: Buffer;
  try {
    indexHtml = await readFile(indexPath);
  } catch (err) {
    logger.error('[admin-shell] admin web index unreadable', {
      correlationId,
      errorClass: errorClassOf(err),
    });
    endAdminWebText(res, 503, 'Admin Web bundle is not readable.', correlationId);
    return;
  }
  setAdminWebHeaders(res, 'no-store', INDEX_CONTENT_TYPE, correlationId);
  res.statusCode = 200;
  if (method === 'HEAD') res.end();
  else res.end(indexHtml);
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
  // (route added by ADM-BASE-01, `server.ts`). There is no platform
  // route for creating connector bindings — connectors are registered
  // in the Connector service. When the fetch cannot resolve a
  // registered revision, the connector pane renders a `not-found`
  // discriminated result.
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

  // AWEB-01: resolve the static Admin Web mount ONCE at mount time (env flag +
  // bundle presence). Unset flag -> `undefined` -> the request path below is
  // byte-for-byte the pre-AWEB-01 behaviour.
  const adminWebMount = resolveAdminWebMount(options);
  // AWEB-02: the BFF rides the same "new admin surface" switch as the static
  // mount — flag off means `/admin/api/*` does not exist (legacy 404).
  const bffRuntime: BffRuntimeConfig = {
    adminToken: options.adminToken,
    tenantAdminTokens: options.tenantAdminTokens,
    jsonBaseUrl: options.jsonBaseUrl,
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
      if (adminWebMount && isBffPath(pathname)) {
        lastRouteId = 'admin-bff';
        const bffRequest = buildRequest(req, pathname, query, '');
        await handleBffRequest(
          req,
          res,
          bffRequest,
          new URLSearchParams(query),
          config,
          bffRuntime,
          correlationId,
        );
        return;
      }
      if (
        adminWebMount &&
        (pathname === '/portal' || pathname.startsWith('/portal/'))
      ) {
        lastRouteId = 'admin-portal-redirect';
        const sub = pathname.replace(/^\/portal\/?/, '');
        const targetUrl = sub ? `/admin/${sub}` + (query ? `?${query}` : '') : `/admin` + (query ? `?${query}` : '');
        res.statusCode = 302;
        res.setHeader('location', targetUrl);
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-correlation-id', correlationId);
        res.end();
        return;
      }
      if (adminWebMount && isAdminWebPath(pathname, adminWebMount.path)) {
        lastRouteId = 'admin-web';
        await handleAdminWebRequest(req, res, pathname, adminWebMount, config, correlationId);
        return;
      }
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
    /** AWEB-02: per-tenant admin bearers for the BFF tenant_operator path. */
    tenantAdminTokens?: Record<string, string>;
    /**
     * SHELL-RED-FIX: optional legacy-plane cookie-policy override, read ONCE
     * at mount. Absent keeps the env-derived default byte-identical; tests
     * inject `{ requireSecure: false, trustProxyProtocol: false }` instead of
     * mutating NODE_ENV/DU_ADMIN_COOKIE_SECURE.
     */
    cookiePolicy?: ShellRuntimeConfig['cookiePolicy'];
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
    cookiePolicy: input.config.cookiePolicy,
    jsonBaseUrl: input.config.jsonBaseUrl,
    oidcFlow: input.config.adminOidcFlow,
    oidcSessions: input.config.adminSessionStore,
    tenantAdminTokens: input.config.tenantAdminTokens,
  });
  await handle.listen();
  return { handle, url: handle.url };
}
