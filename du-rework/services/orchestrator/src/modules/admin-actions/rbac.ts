import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseCookieHeader, verifyCookie } from '../../app/admin/shell-auth';
import { HttpError } from '../../http/errors';

/**
 * ADM-BASE-02 / cycle-84: the shared admin authorization primitives,
 * extracted from server.ts so the action dispatcher and the HTTP layer
 * consult ONE source of truth. Pure: no DB, no HTTP framework — the
 * whole RBAC surface is offline-testable.
 *
 * Principal model (R3-02): the role comes from the CREDENTIAL, never from
 * caller-chosen fields. 'platform' is the global admin bearer;
 * 'tenant_operator' is a bearer bound to exactly one tenant by platform
 * configuration (tenantAdminTokens). OIDC-03 replaces the bearer table
 * with claims later; these contracts do not change.
 */

export type AdminPrincipal =
  | { role: 'platform' }
  | { role: 'tenant_operator'; tenantId: string };

/** Historical alias (R3-02) kept for the audit-reading call sites. */
export type AdminAuditPrincipal = AdminPrincipal;

export interface AdminCredentialConfig {
  adminToken?: string;
  tenantAdminTokens?: Record<string, string>;
}

export function resolveAdminPrincipal(
  config: AdminCredentialConfig,
  authHeader: string | undefined
): AdminPrincipal | null {
  const auth = authHeader ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  if (config.adminToken && token === config.adminToken) return { role: 'platform' };
  const scopedTenantId = config.tenantAdminTokens?.[token];
  if (scopedTenantId) return { role: 'tenant_operator', tenantId: scopedTenantId };
  return null;
}

/** R3-02 name kept as a live alias — same resolver for every surface. */
export const resolveAdminAuditPrincipal = resolveAdminPrincipal;

/**
 * R3-02 / ADM-BASE-02 allow/deny for tenant selection on admin READS
 * (audit ledger, usage projection, api-keys list). Returns the tenant the
 * read may proceed with ('' → honest empty list, platform only). Throws
 * 401 on unknown credentials, 403 when a tenant-scoped principal asks for
 * a foreign tenant — message is identical for foreign and unknown tenants
 * (no existence leak).
 */
export function authorizeAuditTenantRead(
  principal: AdminPrincipal | null,
  requestedTenantId: string
): string {
  if (!principal) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
  }
  if (principal.role === 'platform') return requestedTenantId;
  if (requestedTenantId && requestedTenantId !== principal.tenantId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'admin reads are scoped to the caller tenant');
  }
  return principal.tenantId;
}

/**
 * ADM-BASE-02 fail-closed fence for read-by-id admin lookups whose row
 * carries a tenant. Cross-tenant by-id access answers the SAME 404 as a
 * missing row (R24-01 precedent: no existence leak).
 */
export function requireResourceTenant(
  principal: AdminPrincipal | null,
  resourceTenantId: string
): void {
  if (!principal) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
  }
  if (principal.role === 'tenant_operator' && resourceTenantId !== principal.tenantId) {
    throw new HttpError(404, 'NOT_FOUND', 'not found');
  }
}

/**
 * ADM-BASE-02 tenant check for admin MUTATIONS that target a tenant-owning
 * resource (profile bindings against an api key). Mutations are explicit
 * intent: foreign tenant → 403 PERMISSION_DENIED, identical wording for
 * every foreign tenant (no existence leak of the target tenant id).
 */
export function authorizeBindingTenant(
  principal: AdminPrincipal | null,
  keyTenantId: string
): void {
  if (!principal) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
  }
  if (principal.role === 'tenant_operator' && keyTenantId !== principal.tenantId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'mutations are scoped to the caller tenant');
  }
}

// ---------------------------------------------------------------------------
// Cookie-auth + CSRF (ADM-BASE-02: cookie-auth mutations require the server
// principal/role/tenant/CSRF gate before they can do anything)
// ---------------------------------------------------------------------------

/** Shell session cookie name (src/app/admin/shell-router). */
export const ADMIN_SESSION_COOKIE = 'du_admin';

export type ShellRole = 'admin' | 'operator' | 'viewer';

/**
 * A cookie-authenticated request is only as strong as its CSRF binding.
 * Token = HMAC-SHA256(cookieSecret, 'du-csrf|' + sessionCookieValue),
 * stateless: the server re-derives it from the presented cookie, the
 * browser must echo it in x-csrf-token. A cross-site page can SEND the
 * cookie but can neither READ it (to compute the header) nor forge the
 * HMAC (server-side secret). SameSite=Strict (already set by the shell)
 * stays the first layer; this is the explicit server gate the task row
 * demands.
 */
export function deriveCsrfToken(cookieSecret: string, sessionCookie: string): string {
  return createHmac('sha256', cookieSecret)
    .update('du-csrf|' + sessionCookie)
    .digest('hex');
}

export function validateCsrfToken(input: {
  secret?: string;
  sessionCookie?: string;
  provided?: string | undefined;
}): boolean {
  if (!input.secret || !input.sessionCookie || !input.provided) return false;
  if (input.provided.length > 128) return false;
  const expected = Buffer.from(deriveCsrfToken(input.secret, input.sessionCookie), 'utf8');
  const provided = Buffer.from(input.provided, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export interface AdminActionBearerAuth {
  kind: 'bearer';
  principal: AdminPrincipal;
}

export interface AdminActionCookieAuth {
  kind: 'cookie';
  role: ShellRole;
  csrfOk: boolean;
  /**
   * CYCLE-108/113 REVIEW: the server-side tenant of an opaque OIDC-02
   * session, carried INTO the dispatcher's authorization context so an
   * operator session can act tenant-scoped (cancel/resume fences).
   * Absent/null on the legacy self-contained surface — that cookie has
   * no server-held tenant, so operator actions on it fail closed.
   */
  tenantId?: string | null;
}

export type AdminActionAuth = AdminActionBearerAuth | AdminActionCookieAuth;

/**
 * W-SEC-AUDIT-TAXONOMY-1 — structured security-event vocabulary shared by
 * the browser shell plane and the dispatcher gate. CLOSED shape on purpose:
 * every field is a fixed literal, an enum reason, or a server-derived
 * request path — there is NO free-text field a credential could land in,
 * and emitters must never interpolate a submitted token, cookie value,
 * session id or CSRF secret (pinned offline with sentinel values).
 *
 *  - auth.login_failed:    credential POST rejected (invalid token).
 *  - auth.tls_required:    a VALIDATED credential denied a Secure-cookie
 *    mint because request TLS could not be proven under enforcement (503).
 *  - auth.session_expired: the store held this session and it died on its
 *    absolute deadline (expired_absolute) or idle window (expired_idle).
 *  - auth.session_revoked: a shape-valid session id has no record —
 *    destroyed by logout/rotation/admin revoke, or already evicted by a
 *    storage backend whose TTL dropped the row (absent_or_revoked).
 *  - auth.csrf_denied:     a cookie-auth mutation was blocked at the
 *    dispatcher gate for a missing or wrong CSRF proof.
 *
 * Deliberate gaps: a syntactically invalid session id logged nothing
 * (invalid_shape — a never-lived id was never terminated), and the OIDC
 * callback hostile-403 keeps its own indistinguishable shape instead of
 * masquerading as login_failed (cycle-9 design, delta-31 lineage).
 */
export type AdminSecurityEventKind =
  | 'auth.login_failed'
  | 'auth.tls_required'
  | 'auth.session_expired'
  | 'auth.session_revoked'
  | 'auth.csrf_denied';

export type AdminSecurityEventReason =
  | 'invalid_token'
  | 'tls_unproven_under_enforcement'
  | 'expired_absolute'
  | 'expired_idle'
  | 'absent_or_revoked'
  | 'invalid_shape'
  | 'csrf_missing_or_invalid';

export interface AdminSecurityEvent {
  kind: AdminSecurityEventKind;
  reason: AdminSecurityEventReason;
  /** Server-side request context only: method + fixed admin pathname.
   *  Never query strings or headers — either can carry a credential. */
  method?: string;
  pathname?: string;
  /** Table action name for auth.csrf_denied (from ADMIN_ACTIONS, never
   *  raw caller input — unknown actions 404 before the CSRF leg). */
  action?: string;
}

/** Injection seam: emitters call it synchronously on a denial; the sink
 *  performs the actual I/O (console today, ledger/Platform wiring later).
 *  Absent sink = zero behavior change (byte-for-byte legacy responses). */
export type AdminSecurityAuditSink = (event: AdminSecurityEvent) => void;

/**
 * Resolve the dispatcher's auth context. Bearer wins (server-to-server /
 * shell fetchers); otherwise a VALID signed shell session cookie is
 * accepted WITH its CSRF state recorded (the action table then decides —
 * every cookie-auth mutation requires csrfOk). A missing secret, forged,
 * expired or absent cookie resolves to null → callers 401/403 fail-closed.
 */
export function resolveAdminActionAuth(
  config: AdminCredentialConfig & { adminShellCookieSecret?: string },
  headers: Record<string, string | undefined>
): AdminActionAuth | null {
  const bearer = resolveAdminPrincipal(config, headers['authorization']);
  if (bearer) return { kind: 'bearer', principal: bearer };
  return legacyCookieAuth(config, headers, parseCookieHeader(headers['cookie'] ?? undefined));
}

/** The self-contained du_admin plane, shared by the sync and async
 *  resolvers so the legacy shape can never drift between them. */
function legacyCookieAuth(
  config: { adminShellCookieSecret?: string },
  headers: Record<string, string | undefined>,
  cookies: Record<string, string>
): AdminActionAuth | null {
  if (!config.adminShellCookieSecret) return null;
  const session = cookies[ADMIN_SESSION_COOKIE];
  if (!session) return null;
  const claims = verifyCookie(config.adminShellCookieSecret, session);
  if (!claims) return null;
  return {
    kind: 'cookie',
    role: claims.role,
    csrfOk: validateCsrfToken({
      secret: config.adminShellCookieSecret,
      sessionCookie: session,
      provided: headers['x-csrf-token'],
    }),
  };
}

/**
 * OIDC-03 seam (SEC task line 19): map verified IdP claims → a trusted
 * admin principal, DEFAULT DENY. Self-declared headers are never a
 * principal; the bearer platform token stays as the bootstrap
 * super-admin path until OIDC-01/02 land, and this mapper is the
 * replaceable step in front of the SAME dispatcher gates (AdminActionAuth
 * does not care where the AdminPrincipal came from).
 *
 * Claims contract (SEC-01/02): `sub` stable subject id, `iss` must
 * appear in the allowlist, `platformAdmin` group flag, `tenantIds` the
 * tenants this subject may act for. Deny rules: missing/empty sub, empty
 * allowlist, unlisted iss, neither flag nor tenant, MORE THAN ONE tenant
 * (a session must not carry a multi-tenant operator until per-session
 * tenant selection exists — fail closed, never guess), or a single tenant
 * that is not a non-empty string.
 *
 * That last rule and the shape table it comes from live in @du/contracts
 * (oidc-claim-shapes). The browser roleFor() in app/admin/oidc-flow.ts
 * applies the IDENTICAL rule on purpose: the two surfaces differ on exactly
 * one documented shape (multi-tenant -> read-only session here-vs-nothing
 * there) and must not differ anywhere else. Reviewer Turn 40 asked for this
 * to be machine-checked; tests/oidc-claim-shape-contract-offline.test.ts
 * binds both mappers to the same table.
 */
export interface OidcAdminClaims {
  sub: string;
  iss: string;
  platformAdmin?: boolean;
  tenantIds?: string[];
}

export function mapOidcClaimsToPrincipal(
  claims: OidcAdminClaims | null | undefined,
  allowedIssuers: readonly string[]
): AdminPrincipal | null {
  if (!claims) return null;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
  if (allowedIssuers.length === 0) return null;
  if (!allowedIssuers.includes(claims.iss)) return null;
  if (claims.platformAdmin === true) return { role: 'platform' };
  const tenants = Array.isArray(claims.tenantIds) ? claims.tenantIds : [];
  if (tenants.length !== 1) return null;
  const tenantId = tenants[0];
  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  return { role: 'tenant_operator', tenantId };
}

/**
 * OIDC-03 / SEC-02: server-side session view the dispatcher route accepts
 * INSTEAD of the legacy self-contained cookie. Implemented by
 * modules/auth/session-store (opaque ids, server-side role + CSRF
 * secret); structurally typed here so rbac stays import-light. The
 * identity fields (sub/tenantId) come from the STORE, never from a
 * browser-asserted header.
 */
export interface AdminSessionView {
  role: 'admin' | 'operator' | 'viewer';
  csrfToken: string;
  tenantId: string | null;
}

/** Honest dead-cause for the server-side audit sink (W-SEC-AUDIT-TAXONOMY-1). */
export type AdminSessionDeadReason =
  | 'live'
  | 'expired_absolute'
  | 'expired_idle'
  | 'absent_or_revoked'
  | 'invalid_shape';

export interface AdminSessionStore {
  get(sessionId: string): Promise<AdminSessionView | null>;
  /**
   * Optional READ-ONLY classifier (no eviction, no touch). The wire keeps
   * its SEC-02 one-null-path rule either way — this seam exists solely so
   * the server-side ledger can tell expired apart from revoked before
   * get() lazy eviction erases the evidence. Stores without it get the
   * merged absent_or_revoked fallback at the caller.
   */
  classify?(sessionId: string): Promise<AdminSessionDeadReason>;
}

/**
 * Async auth resolution for the dispatcher route. CYCLE-108/113 REVIEW:
 * bearer first (server-to-server, unchanged), then the OPAQUE du_session
 * BEFORE the legacy du_admin cookie. The old code resolved the sync pair
 * (bearer + legacy) FIRST, so any browser still carrying a valid legacy
 * cookie bypassed the session plane entirely — and revoking an OIDC
 * session did nothing as long as the 8h self-contained cookie lived.
 * Rule now: once a du_session rides the request and a store is wired,
 * THE SESSION PLANE DECIDES — a dead/revoked/forged session returns null
 * (401); it never silently downgrades to the legacy cookie, which would
 * make server-side revocation meaningless. The legacy plane is consulted
 * only when NO session cookie is present (mid-migration coexistence —
 * same rule the cycle-101 shell gate applies). CSRF state is computed
 * here so the dispatcher gate remains the single decision point; the
 * session's SERVER-SIDE tenant rides along in the auth context so the
 * dispatcher can fence operator sessions per tenant.
 */
export async function resolveAdminActionAuthAsync(
  config: AdminCredentialConfig & { adminShellCookieSecret?: string },
  headers: Record<string, string | undefined>,
  sessionStore?: AdminSessionStore
): Promise<AdminActionAuth | null> {
  const bearer = resolveAdminPrincipal(config, headers['authorization']);
  if (bearer) return { kind: 'bearer', principal: bearer };
  const cookies = parseCookieHeader(headers['cookie'] ?? undefined);
  const sessionId = cookies['du_session'];
  if (sessionStore && sessionId) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return null; // forged id: deny, no fallback
    const session = await sessionStore.get(sessionId);
    if (!session) return null; // expired/revoked: deny, no legacy resurrection
    return {
      kind: 'cookie',
      role: session.role,
      tenantId: session.tenantId,
      csrfOk: isNonEmptyString(headers['x-csrf-token']) &&
        constantTimeEquals(headers['x-csrf-token'], session.csrfToken),
    };
  }
  return legacyCookieAuth(config, headers, cookies);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * ADM-BASE-02: 'unsupported action 404/405, khong tra GET nhu thanh cong'.
 * The dispatcher resource is POST-only; GET/PUT/DELETE answer 405.
 */
export function adminActionsMethodGuard(method: string): void {
  if (method !== 'POST') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'the admin action dispatcher accepts POST only');
  }
}
