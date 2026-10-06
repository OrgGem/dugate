import { randomBytes, timingSafeEqual } from 'node:crypto';
import { buildSetCookieHeader } from '../../app/admin/shell-auth';
import type { AdminActionAuth, AdminPrincipal, AdminSessionDeadReason } from '../admin-actions/rbac';

/**
 * OIDC-02 / SEC-02 — opaque ADMIN SESSION STORE for the orchestrator.
 *
 * Replaces the self-contained signed-role cookie (shell-auth P6-01) for
 * AUTHORIZATION state: the browser cookie carries NOTHING but an opaque,
 * unguessable session id; identity (issuer+sub, tenant, role), expiry and
 * the CSRF secret live SERVER-SIDE in a repository behind a storage seam
 * (memory today; Redis/DB repository implements the same 4-method
 * interface for the two-replica requirement — the store itself is
 * stateless so replicas are interchangeable).
 *
 * Guarantees (each pinned by tests/session-store.test.ts):
 *  - TTL: absolute expiry (never extended by activity) AND sliding idle
 *    expiry; expired/idle-dead sessions are lazily evicted on read.
 *  - Rotation after login: rotate() mints a FRESH id and deletes the old
 *    one — a pre-login (fixation) cookie is dead on arrival.
 *  - Logout/revoke: destroy(id) and revokePrincipal(iss, sub) are
 *    immediate; a restart (new store over the same repository) cannot
 *    resurrect a revoked session because revocation is a repository delete.
 *  - Hostile ids: strict shape gate BEFORE the repository is consulted;
 *    unknown == expired == invalid — one null path, no oracle.
 *  - CSRF: every session carries a server-side csrf secret; cookie-auth
 *    mutations must match it (verifySessionCsrf, constant-time). This is
 *    the real-token CSRF SEC-02 demands, replacing the derived-HMAC
 *    scheme used while cookies were self-contained.
 *  - No secret ever rides in the cookie or is logged: the module has no
 *    logger and the cookie value is the id alone.
 */

export type SessionRole = 'admin' | 'operator' | 'viewer';

export interface SessionRecord {
  sessionId: string;
  issuer: string;
  sub: string;
  /** NULL only for platform-scoped identities; operator sessions MUST carry one. */
  tenantId: string | null;
  role: SessionRole;
  /** Server-side CSRF secret for cookie-authenticated mutations. */
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

/**
 * Storage seam. A distributed deployment ships a Redis (SETEX) or Postgres
 * repository with the SAME semantics; deleteByPrincipal is optional
 * (index-by-principal is a deployment decision) — revokePrincipal fails
 * closed when absent rather than scanning.
 */
export interface SessionRepository {
  get(sessionId: string): Promise<SessionRecord | null>;
  /** Upsert. Implementations MUST also set their own storage TTL (expiresAt). */
  set(session: SessionRecord): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
  revokePrincipal?(issuer: string, sub: string): Promise<number>;
}

export class SessionError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? 'session failure: ' + code);
    this.name = 'SessionError';
    this.code = code;
  }
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes base64url, unpadded
const CSRF_RE = /^[A-Za-z0-9_-]{43}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function newOpaqueId(): string {
  return randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createMemorySessionRepository(): SessionRepository & { size(): number } {
  const map = new Map<string, SessionRecord>();
  return {
    async get(id) {
      const hit = map.get(id);
      return hit ? { ...hit } : null;
    },
    async set(s) {
      map.set(s.sessionId, { ...s });
    },
    async delete(id) {
      return map.delete(id);
    },
    async revokePrincipal(issuer, sub) {
      let n = 0;
      for (const [id, rec] of map) {
        if (rec.issuer === issuer && rec.sub === sub) {
          map.delete(id);
          n += 1;
        }
      }
      return n;
    },
    size: () => map.size,
  };
}

export interface SessionIdentity {
  issuer: string;
  sub: string;
  tenantId?: string | null;
  role: SessionRole;
}

const ROLES: SessionRole[] = ['admin', 'operator', 'viewer'];
const HOUR = 3_600_000;

export interface SessionStoreOptions {
  repo: SessionRepository;
  now?: () => number;
  /** Absolute lifetime since creation; activity never extends it. Default 8h. */
  absoluteTtlMs?: number;
  /** Sliding idle window. Default 30min. */
  idleTtlMs?: number;
}

export function createSessionStore(opts: SessionStoreOptions) {
  const now = opts.now ?? ((): number => Date.now());
  const absoluteTtlMs = opts.absoluteTtlMs ?? 8 * HOUR;
  const idleTtlMs = opts.idleTtlMs ?? 30 * 60_000;
  if (absoluteTtlMs <= 0 || absoluteTtlMs > 24 * HOUR) {
    throw new SessionError('config', 'absoluteTtlMs must be within (0, 24h]');
  }
  if (idleTtlMs <= 0 || idleTtlMs > absoluteTtlMs) {
    throw new SessionError('config', 'idleTtlMs must be within (0, absoluteTtlMs]');
  }

  async function kill(id: string): Promise<null> {
    await opts.repo.delete(id);
    return null;
  }

  async function create(identity: SessionIdentity): Promise<SessionRecord> {
    if (!identity || typeof identity !== 'object') throw new SessionError('invalid-identity');
    if (!isValidNonEmpty(identity.issuer) || !isValidNonEmpty(identity.sub)) {
      throw new SessionError('invalid-identity', 'issuer and sub are required');
    }
    if (!ROLES.includes(identity.role)) throw new SessionError('invalid-role');
    if (identity.role === 'operator' && !isValidNonEmpty(identity.tenantId ?? undefined)) {
      // Default deny: an operator session without a tenant could never be
      // mapped to a principal — refuse to mint it (SEC-02 map-must-exist).
      throw new SessionError('operator-requires-tenant');
    }
    const at = now();
    const record: SessionRecord = {
      sessionId: newOpaqueId(),
      issuer: identity.issuer,
      sub: identity.sub,
      tenantId: identity.tenantId ?? null,
      role: identity.role,
      csrfToken: newOpaqueId(),
      createdAt: at,
      lastSeenAt: at,
      expiresAt: at + absoluteTtlMs,
    };
    await opts.repo.set(record);
    return { ...record };
  }

  /** Read + sliding-touch. null for unknown/invalid/expired/idle-dead —
   *  ONE indistinguishable path, with lazy eviction. */
  async function get(sessionId: string): Promise<SessionRecord | null> {
    if (!isValidSessionId(sessionId)) return null; // hostile input never reaches storage
    const rec = await opts.repo.get(sessionId);
    if (!rec) return null;
    const at = now();
    if (at >= rec.expiresAt) return kill(sessionId); // absolute TTL
    if (at - rec.lastSeenAt > idleTtlMs) return kill(sessionId); // idle expiry
    const touched: SessionRecord = { ...rec, lastSeenAt: at };
    await opts.repo.set(touched);
    return { ...touched };
  }

  /**
   * W-SEC-AUDIT-TAXONOMY-1 — READ-ONLY dead-reason for the server-side
   * security audit. Deliberately never evicts and never touches: the audit
   * must learn EXPIRED before a destructive read would erase the evidence,
   * and the wire keeps its one-null-path rule either way. A backend whose
   * own storage TTL drops rows (Redis SETEX) will report its expired
   * sessions as absent_or_revoked — the merged reason is honest about it.
   */
  async function classify(sessionId: string): Promise<AdminSessionDeadReason> {
    if (!isValidSessionId(sessionId)) return 'invalid_shape';
    const rec = await opts.repo.get(sessionId);
    if (!rec) return 'absent_or_revoked';
    const at = now();
    if (at >= rec.expiresAt) return 'expired_absolute';
    if (at - rec.lastSeenAt > idleTtlMs) return 'expired_idle';
    return 'live';
  }

  /**
   * Session-fixation defense: call IMMEDIATELY AFTER login (IdP callback)
   * so a cookie planted pre-login names nothing. Identity + csrf + absolute
   * deadline carry over; the id is fresh; the old id is deleted. Null (and
   * no mutation) when the old id is dead — a dead session cannot rotate.
   */
  async function rotate(sessionId: string): Promise<SessionRecord | null> {
    const rec = await get(sessionId);
    if (!rec) return null;
    await opts.repo.delete(sessionId);
    const next: SessionRecord = { ...rec, sessionId: newOpaqueId(), lastSeenAt: now() };
    await opts.repo.set(next);
    return { ...next };
  }

  /** Logout: immediate, idempotent. */
  async function destroy(sessionId: string): Promise<boolean> {
    if (!isValidSessionId(sessionId)) return false;
    return opts.repo.delete(sessionId);
  }

  /** Nuclear revoke (admin removed a user / credential rotation): all of a
   *  principal's sessions. Fail-closed when the repository cannot index
   *  by principal — silently returning 0 would be a lie. */
  async function revokePrincipal(issuer: string, sub: string): Promise<number> {
    if (!opts.repo.revokePrincipal) {
      throw new SessionError('revoke-principal-unsupported');
    }
    return opts.repo.revokePrincipal(issuer, sub);
  }

  return { create, get, classify, rotate, destroy, revokePrincipal, config: { absoluteTtlMs, idleTtlMs } };
}

function isValidNonEmpty(v: string | undefined | null): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------
// CSRF + cookie + principal mapping
// ---------------------------------------------------------------------------

/** Constant-time check of the mutation's x-csrf-token against the session. */
export function verifySessionCsrf(session: SessionRecord, provided: string | undefined): boolean {
  if (!isValidNonEmpty(provided) || !CSRF_RE.test(provided)) return false;
  const a = Buffer.from(session.csrfToken, 'utf8');
  const b = Buffer.from(provided as string, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SESSION_COOKIE_NAME = 'du_session';

/**
 * SEC-02 cookie posture: HttpOnly, Path=/, SameSite=Lax (IdP redirect is
 * a top-level GET navigation — Lax keeps the session alive across the
 * callback while cross-site POSTs still never carry it), Secure whenever
 * the origin is https (caller decides from request protocol). The value
 * is the opaque id ONLY: no role, no sub, no csrf secret in the wire.
 */
export function buildSessionCookie(
  session: SessionRecord,
  options: { secure: boolean; nowMs?: number }
): string {
  const remaining = Math.max(0, session.expiresAt - (options.nowMs ?? Date.now()));
  return buildSetCookieHeader(SESSION_COOKIE_NAME, session.sessionId, {
    maxAgeSeconds: Math.floor(remaining / 1000),
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: options.secure,
  });
}

/** Clear the cookie at the client (logout response pairs with destroy). */
export function buildSessionClearCookie(options: { secure: boolean }): string {
  return buildSetCookieHeader(SESSION_COOKIE_NAME, '', {
    maxAgeSeconds: 0,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: options.secure,
  });
}

/**
 * Session → dispatcher principal, DEFAULT DENY (the OIDC-03 mapper's rule
 * re-expressed over stored sessions): admin ⇒ platform, operator ⇒
 * tenant_operator bound to the STORED tenant (never a caller claim),
 * viewer ⇒ no admin principal at all (read surfaces keep their own
 * authorizeAuditTenantRead gate via the role-less viewer session).
 */
/**
 * The connection dispatch asked for: a stored session + the request's
 * x-csrf-token become exactly the AdminActionAuth shape the dispatcher
 * (cycle-84 gates) already consumes — csrfOk from constant-time
 * verification, identity from the SERVER-side record, never from a
 * browser-asserted header. Null only for a syntactically dead session
 * (caller destroys it too).
 */
export function sessionToActionAuth(
  session: SessionRecord,
  csrfProvided: string | undefined
): AdminActionAuth {
  return {
    kind: 'cookie',
    role: session.role,
    // CYCLE-108/113: the STORED tenant rides into the dispatcher context
    // so an operator session acts tenant-scoped (never a caller claim).
    tenantId: session.tenantId,
    csrfOk: verifySessionCsrf(session, csrfProvided),
    // Δ8/T-AUD-01: the STORED principal (issuer/sub) rides along the same
    // way, so ledger rows attribute the real actor instead of `shell:<role>`.
    principalId: session.sub,
    issuer: session.issuer,
  };
}

export function principalFromSession(session: SessionRecord): AdminPrincipal | null {
  if (session.role === 'admin') return { role: 'platform' };
  if (session.role === 'operator' && isValidNonEmpty(session.tenantId)) {
    return { role: 'tenant_operator', tenantId: session.tenantId };
  }
  return null;
}
