import { createHash, randomBytes } from 'node:crypto';

export const LOCAL_SESSION_ISSUER = 'du-local' as const;
export const DEFAULT_LOCAL_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
export const MAX_LOCAL_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface LocalSessionClaims {
  sub: string;
  role: string;
  tenantId: string | null;
}

export interface LocalSessionRecord extends LocalSessionClaims {
  tokenDigest: string;
  issuer: typeof LOCAL_SESSION_ISSUER;
  issuedAt: number;
  expiresAt: number;
}

export interface LocalSessionPrincipal extends LocalSessionClaims {
  issuer: typeof LOCAL_SESSION_ISSUER;
}

export type NewLocalSessionRecord = Omit<LocalSessionRecord, 'tokenDigest'>;

/** LOCAL-03/SessionStore seam. Persist only the digest key, never the raw token. */
export interface LocalSessionRepository {
  insert(tokenDigest: string, record: NewLocalSessionRecord): Promise<void>;
  findByTokenDigest(tokenDigest: string): Promise<LocalSessionRecord | null>;
}

export interface LocalSessionOptions {
  ttlMs?: number;
  now?: () => number;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validClaims(claims: LocalSessionClaims): boolean {
  return (
    typeof claims.sub === 'string' &&
    claims.sub.length > 0 &&
    typeof claims.role === 'string' &&
    claims.role.length > 0 &&
    (claims.tenantId === null || typeof claims.tenantId === 'string')
  );
}

function readTimestamp(now: (() => number) | undefined): number {
  const value = now ? now() : Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Local session clock is invalid');
  return value;
}

function resolveTtl(ttlMs: number | undefined): number {
  const value = ttlMs ?? DEFAULT_LOCAL_SESSION_TTL_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LOCAL_SESSION_TTL_MS) {
    throw new Error('Local session TTL is invalid');
  }
  return value;
}

function isStoredSession(value: LocalSessionRecord | null, digest: string, now: number): value is LocalSessionRecord {
  return (
    value !== null &&
    value.tokenDigest === digest &&
    value.issuer === LOCAL_SESSION_ISSUER &&
    validClaims(value) &&
    Number.isSafeInteger(value.issuedAt) &&
    value.issuedAt >= 0 &&
    value.issuedAt <= now &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > now &&
    value.expiresAt > value.issuedAt &&
    value.expiresAt - value.issuedAt <= MAX_LOCAL_SESSION_TTL_MS
  );
}

/** Mint a random opaque token and persist its digest with server-side claims. */
export async function mintLocalSession(
  claims: LocalSessionClaims,
  repository: LocalSessionRepository,
  options: LocalSessionOptions = {},
): Promise<{ token: string; expiresAt: number }> {
  if (!validClaims(claims)) throw new Error('Local session claims are invalid');
  const ttlMs = resolveTtl(options.ttlMs);
  const issuedAt = readTimestamp(options.now);
  const expiresAt = issuedAt + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Local session expiry is invalid');

  const token = randomBytes(32).toString('base64url');
  const tokenDigest = digestToken(token);
  const { sub, role, tenantId } = claims;
  await repository.insert(tokenDigest, {
    issuer: LOCAL_SESSION_ISSUER,
    sub,
    role,
    tenantId,
    issuedAt,
    expiresAt,
  });
  return { token, expiresAt };
}

/** Return only live du-local sessions. Every invalid, expired, or unavailable lookup fails closed. */
export async function readLocalSession(
  token: string,
  repository: LocalSessionRepository,
  options: Pick<LocalSessionOptions, 'now'> = {},
): Promise<LocalSessionPrincipal | null> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;

  let now: number;
  try {
    now = readTimestamp(options.now);
  } catch {
    return null;
  }

  const tokenDigest = digestToken(token);
  let record: LocalSessionRecord | null;
  try {
    record = await repository.findByTokenDigest(tokenDigest);
  } catch {
    return null;
  }
  if (!isStoredSession(record, tokenDigest, now)) return null;

  return {
    issuer: LOCAL_SESSION_ISSUER,
    sub: record.sub,
    role: record.role,
    tenantId: record.tenantId,
  };
}
