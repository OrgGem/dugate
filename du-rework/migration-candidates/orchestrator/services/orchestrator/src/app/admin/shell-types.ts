/**
 * Pure browser-tier types for the rendered Admin shell (P6-01).
 *
 * Scope: types describing the shell's HTTP boundary — request shape,
 * response shape, route table, signed-cookie claims. No DB, no Redis,
 * no HTTP I/O, no framework. Strict TypeScript, zero `any`.
 *
 * The shell is renderer-agnostic. The renderer reads these types and
 * produces HTML; the server reads them to dispatch. Authorization
 * (which role can see which section) is enforced by the orchestrator's
 * `assertAdminAuth` and by `matchShellRoute`'s role guard. The cookie
 * carries the role only.
 */

import type { AdminSection } from './types';

// ---------------------------------------------------------------------------
// Cookie claims
// ---------------------------------------------------------------------------

/**
 * Claims carried by the signed `du_admin` cookie. The role decides what
 * a renderer may display; the orchestrator's bearer-token
 * `assertAdminAuth` remains authoritative for every server-to-server
 * fetch the shell makes.
 */
export interface AdminCookieClaims {
  /** Operator's role at the time the cookie was issued. */
  role: 'admin' | 'operator' | 'viewer';
  /** Issuer — currently always 'du-admin-shell'. */
  iss: string;
  /** Issued-at, ms epoch. */
  iat: number;
  /** Expires-at, ms epoch. */
  exp: number;
}

// ---------------------------------------------------------------------------
// HTTP boundary
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP request shape the shell server actually consumes. We
 * do not depend on `node:http.IncomingMessage` directly so the router
 * stays pure and unit-testable without spinning a listener.
 */
export interface AdminShellRequest {
  method: 'GET' | 'POST' | 'HEAD';
  /** Pathname only, no query string, normalized to start with `/`. */
  pathname: string;
  /** Parsed cookies as `{name: value}` (last write wins; signature is
     * verified before the cookie body is consumed). */
  cookies: Record<string, string>;
  /** Parsed `application/x-www-form-urlencoded` body for POST. Empty
     * for GET/HEAD. */
  body: Record<string, string>;
  /**
   * Parsed query string as `{name: value}` (last value wins). Added
   * in P6-02 so the Business section's picker (`?businessId=…`) can
   * carry its selection through the shell. The shell server parses
   * the raw URL; the dispatcher + tests that build `AdminShellRequest`
   * directly leave this `undefined` (the section handlers read it
   * defensively).
   */
  query?: Record<string, string>;
  /**
   * W-SEC-OIDC04-PROXY-1: raw x-forwarded-proto captured by the shell
   * server at the HTTP boundary (duplicate headers arrive joined with a
   * comma, which the strict downstream check fails closed). Optional: a
   * request built without it behaves exactly as before. Only consulted
   * when the operator set DU_ADMIN_TRUST_PROXY_PROTOCOL=true — the policy
   * itself lives in oidc-flow/oidc-boot; the shell merely transports.
   */
  forwardedProto?: string;
}

/**
 * What the shell returns to the HTTP layer. The shell server turns
 * this into a real response (status, headers, body). Pure data so it
 * is unit-testable.
 */
export interface AdminShellResponse {
  status: number;
  headers: Record<string, string>;
  /** Pre-rendered HTML string. UTF-8. */
  body: string;
  /**
   * Optional additional HTML to splice inside the shell's content
   * area, after the screen-state body. The shell server injects this
   * exactly once before `</section></main>`. When `undefined` or
   * empty, the response body is returned verbatim — preserving the
   * P6-01 contract for every existing handler and test.
   *
   * P6-02 introduces this for the Business registry/version/health
   * pane; future sections (profiles / connectors / etc.) can adopt
   * the same seam without further shell-renderer edits.
   */
  sectionExtras?: string;
  /**
   * Optional deferred async extras hook. The shell server awaits it
   * before writing the response and substitutes the resolved string
   * into the body where `sectionExtras` would land. Used by sections
   * that require an I/O fetch (e.g. the businesses section's call to
   * the orchestrator JSON API) without forcing `dispatchShellRequest`
   * to be async.
   *
   * When both `sectionExtras` and `deferredSectionExtras` are set,
   * `deferredSectionExtras` wins (it is the resolved value).
   */
  deferredSectionExtras?: () => Promise<string | undefined>;
}

/**
 * A matched route: the handler that must serve it plus the auth guard
 * the shell enforces before dispatching. The handler is pure — it
 * returns a `AdminShellResponse` for a `(request, claims)` pair.
 */
export interface AdminShellRoute {
  /** Stable route id (e.g. `'section:businesses'`). */
  id: string;
  /** The section this route resolves to (null for non-section routes). */
  section: AdminSection | null;
  /** Minimal role required to view this route. */
  requiredRole: 'admin' | 'operator' | 'viewer';
  /** Pure handler. */
  handle(
    request: AdminShellRequest,
    claims: AdminCookieClaims | null,
  ): AdminShellResponse;
}