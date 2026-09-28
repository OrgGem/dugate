import { createHash } from 'node:crypto';
import IORedis, { type RedisOptions } from 'ioredis';
import type { FlowChallenge, OidcChallengeStore } from '../../app/admin/oidc-flow';
import {
  isValidSessionId,
  SessionError,
  type SessionRecord,
  type SessionRepository,
} from './session-store';

/**
 * OIDC-02 (cycle 108+/orchestrator request): the PERSISTENT session
 * repository. Sessions stop being per-process memory when the admin plane
 * goes multi-replica — a session minted on replica A must authenticate on
 * replica B, survive restarts, and (the acceptance this module exists
 * for) REVOKE on any replica must kill it on every replica.
 *
 * Key layout (namespace is isolated from BullMQ — this module never
 * shares a connection with the queue):
 *   <prefix>s:<sessionId>              STRING  JSON SessionRecord, EX = remaining absolute TTL
 *   <prefix>p:<sha256(iss\\0sub)>      SET     session ids by principal, EX refreshed on every write
 *   <chal-prefix><sha256(state)>       STRING  JSON FlowChallenge, consumed by atomic GETDEL
 *
 * TTL math: the store hands EVERY write the unchanged absolute expiresAt
 * (idle touch slides lastSeenAt only), so EX is always 'seconds left until
 * the absolute deadline' — Redis expiry can never extend a session, and a
 * lost delete degrades to 'key dies on its own TTL', never 'lives forever'.
 *
 * Fail-closed rules:
 *  - every read validates the WHOLE record (shape, role enum, id == key,
 *    finite numbers). Corrupted/hostile payloads == absent, one null path,
 *    never a partial object and never a throw from storage.
 *  - revokePrincipal DELetes ONLY ids passing the strict session-id shape
 *    gate — a poisoned index can never DELete keys outside the namespace.
 *  - delete() leaves stale index members (it only knows the id); that is
 *    safe: revoke skips dead keys, counts DEL's real result, and the index
 *    itself carries a TTL.
 */

/** The handful of Redis commands this repository needs. Structurally typed
 *  (not ioredis's 500-line interface) so tests run the REAL repository
 *  against an in-process fake and production injects ioredis. */
export interface RedisSessionGateway {
  get(key: string): Promise<string | null>;
  /** SET with expiry (seconds). Must behave like `SET key val EX n`. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** DEL: returns the number of keys actually removed. */
  del(...keys: string[]): Promise<number>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  /** Refresh a key's expiry (seconds). */
  expire(key: string, ttlSeconds: number): Promise<void>;
  /**
   * Atomic GET+DELETE (Redis >= 6.2 GETDEL). The CHALLENGE store's
   * one-shot guarantee rests on this being a single atomic command —
   * with two replicas consuming the same state, exactly one reads a
   * value. No Lua fallback is offered: an old Redis that lacks GETDEL
   * must fail the boot command surface, not silently race.
   */
  getdel(key: string): Promise<string | null>;
  /**
   * Resolve once the underlying connection can accept commands ('ready').
   * Optional: fakes have no connect phase; live harnesses MUST await this
   * before the first command when enableOfflineQueue=false (commands before
   * ready reject instantly — Tester-1, cycle 128).
   */
  ready?(): Promise<void>;
  /** Optional owned-connection teardown (production gateway). */
  close?(): Promise<void>;
}

export interface RedisSessionRepositoryOptions {
  /** Default 'du:admin:sess:'. Keep it disjoint from any queue namespace. */
  keyPrefix?: string;
  now?: () => number;
}

const ROLES: SessionRole[] = ['admin', 'operator', 'viewer'];
type SessionRole = SessionRecord['role'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function principalKey(prefix: string, issuer: string, sub: string): string {
  // Hash instead of concatenating with a separator: issuer is a URL, sub
  // is IdP-controlled — sha256 over a length-prefixed tuple kills any
  // delimiter-collision trickery and keeps keys fixed-length.
  const digest = createHash('sha256')
    .update(String(issuer.length) + '|' + issuer + String(sub.length) + '|' + sub, 'utf8')
    .digest('hex');
  return prefix + 'p:' + digest;
}

/** Re-validate a stored JSON blob into a SessionRecord ONLY if it is
 *  structurally perfect and names the key it lives under. Any deviation
 *  is indistinguishable from absence. */
function parseSessionRecord(raw: string, expectedSessionId: string): SessionRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (!isValidSessionId(o.sessionId) || o.sessionId !== expectedSessionId) return null;
  if (!isNonEmptyString(o.issuer) || !isNonEmptyString(o.sub)) return null;
  if (o.tenantId !== null && !isNonEmptyString(o.tenantId)) return null;
  if (!ROLES.includes(o.role as SessionRole)) return null;
  if (!isValidSessionId(o.csrfToken)) return null;
  if (!isFiniteNumber(o.createdAt) || !isFiniteNumber(o.lastSeenAt) || !isFiniteNumber(o.expiresAt)) return null;
  return {
    sessionId: o.sessionId,
    issuer: o.issuer,
    sub: o.sub,
    tenantId: o.tenantId,
    role: o.role as SessionRole,
    csrfToken: o.csrfToken,
    createdAt: o.createdAt,
    lastSeenAt: o.lastSeenAt,
    expiresAt: o.expiresAt,
  };
}

export function createRedisSessionRepository(
  redis: RedisSessionGateway,
  options: RedisSessionRepositoryOptions = {}
): SessionRepository {
  const prefix = options.keyPrefix ?? 'du:admin:sess:';
  const now = options.now ?? ((): number => Date.now());
  const sessionKey = (id: string): string => prefix + 's:' + id;

  return {
    async get(sessionId) {
      // Defense in depth: the store gates hostile ids BEFORE the repo,
      // but a repo must never query `du:admin:sess:s:<garbage>` either.
      if (!isValidSessionId(sessionId)) return null;
      const raw = await redis.get(sessionKey(sessionId));
      if (raw === null) return null;
      return parseSessionRecord(raw, sessionId);
    },

    async set(session) {
      if (!isValidSessionId(session.sessionId)) {
        throw new SessionError('invalid-session-id', 'refusing to persist a malformed session id');
      }
      const ttlSec = Math.max(1, Math.ceil((session.expiresAt - now()) / 1000));
      await redis.set(sessionKey(session.sessionId), JSON.stringify(session), ttlSec);
      const pKey = principalKey(prefix, session.issuer, session.sub);
      await redis.sadd(pKey, session.sessionId);
      await redis.expire(pKey, ttlSec);
    },

    async delete(sessionId) {
      if (!isValidSessionId(sessionId)) return false;
      const removed = await redis.del(sessionKey(sessionId));
      // No SREM: the record (and its principal) is already gone by the
      // time the store deletes without context. Stale index members are
      // skipped by revokePrincipal and age out with the index TTL.
      return removed > 0;
    },

    async revokePrincipal(issuer, sub) {
      const pKey = principalKey(prefix, issuer, sub);
      const members = await redis.smembers(pKey);
      const ids = members.filter(isValidSessionId); // poisoned members can never name foreign keys
      let removed = 0;
      if (ids.length > 0) {
        removed = await redis.del(...ids.map(sessionKey));
      }
      await redis.del(pKey);
      return removed;
    },
  };
}

/**
 * Production adapter: the gateway over a DEDICATED ioredis connection.
 * Deliberately separate from the BullMQ connection (queue and admin
 * identity must not compete for one socket), with the offline queue
 * disabled: with Redis unreachable, session commands REJECT immediately
 * (fail closed: dispatcher resolves 401/500, shell gate bounces to
 * /admin/login) instead of hanging a request behind unbounded retries.
 */
export function createIoredisSessionGateway(
  url: string,
  overrides: Partial<RedisOptions> = {}
): RedisSessionGateway {
  const client = new IORedis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    ...overrides,
  });
  // ioredis re-emits reconnection failures as 'error'; with NO listener an
  // EventEmitter throws UNCAUGHT and takes the process down. Swallow here —
  // every command call site still gets its own rejection (fail closed),
  // reconnection itself is retryStrategy's job.
  client.on('error', () => undefined);
  return {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, ttlSeconds) {
      await client.set(key, value, 'EX', ttlSeconds);
    },
    async del(...keys) {
      return keys.length > 0 ? client.del(...keys) : 0;
    },
    async sadd(key, member) {
      await client.sadd(key, member);
    },
    async srem(key, member) {
      await client.srem(key, member);
    },
    async smembers(key) {
      return client.smembers(key);
    },
    async expire(key, ttlSeconds) {
      await client.expire(key, ttlSeconds);
    },
    async getdel(key) {
      return client.getdel(key);
    },
    ready() {
      if (client.status === 'ready') return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.removeListener('ready', onReady);
          reject(new Error('session redis gateway not ready within 10s'));
        }, 10_000);
        const onReady = (): void => {
          clearTimeout(timer);
          resolve();
        };
        // Deliberately NO 'error' rejection: ioredis keeps reconnecting; a
        // transient error before ready is not a terminal condition — the
        // 10s budget is.
        client.once('ready', onReady);
      });
    },
    async close() {
      // quit() against a never-connected/reconnecting client can hang or
      // reject; fall back to disconnect() so shutdown ALWAYS completes.
      try {
        if (client.status === 'ready') await client.quit();
        else client.disconnect();
      } catch {
        try { client.disconnect(); } catch { /* nothing left to close */ }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OIDC-04 LOGIN CHALLENGES (state -> verifier/nonce/returnTo), Redis-backed
// ---------------------------------------------------------------------------

/**
 * The flow's one-shot challenge store, same gateway/connection as the
 * sessions (one admin-plane dependency, one fail-closed outage behavior).
 *
 *   <chal-prefix><sha256(state)>   STRING  JSON FlowChallenge, EX = remaining TTL
 *
 * Threat notes:
 *  - state is a LOGIN SECRET: it never rides as a plaintext key on shared
 *    infrastructure — the key is its sha256. consume() is a single GETDEL,
 *    so across replicas exactly one callback wins the challenge; losers
 *    get the flow's ONE denial shape.
 *  - the stored returnTo becomes a Location header. Shared storage may be
 *    poisoned by whoever owns the Redis, so a read-back returnTo must pass
 *    the SAME allowlist the flow applied at write time (absolute-path
 *    charset, no '//', no '..'); anything else fails closed to null —
 *    an open-redirect can never be resurrected through the store.
 */
export interface RedisChallengeStoreOptions {
  /** Default 'du:admin:chal:'. */
  keyPrefix?: string;
  now?: () => number;
}

// newToken() emits 32 bytes base64url WITH '=' padding (44 chars);
// store ids/pkce values strip it (strict 43). Gates stay permissive to
// the producers' alphabets, strict to everything else.
const STATE_RE = /^[A-Za-z0-9_-]{43}=?$/;
const VERIFIER_RE = /^[A-Za-z0-9_-]{43}$/;
const RETURN_TO_RE = /^\/[A-Za-z0-9/_?=&#-]*$/;

export function createRedisChallengeStore(
  redis: RedisSessionGateway,
  options: RedisChallengeStoreOptions = {}
): OidcChallengeStore {
  const prefix = options.keyPrefix ?? 'du:admin:chal:';
  const now = options.now ?? ((): number => Date.now());
  const keyFor = (state: string): string =>
    prefix + createHash('sha256').update(state, 'ascii').digest('hex');

  return {
    async put(state, challenge) {
      if (!STATE_RE.test(state)) {
        throw new SessionError('invalid-state', 'refusing to persist a malformed challenge state');
      }
      if (!VERIFIER_RE.test(challenge.verifier) || !STATE_RE.test(challenge.nonce)) {
        throw new SessionError('invalid-challenge', 'verifier/nonce failed shape validation');
      }
      const ttlSec = Math.max(1, Math.ceil((challenge.expiresAt - now()) / 1000));
      await redis.set(keyFor(state), JSON.stringify(challenge), ttlSec);
    },

    async consume(state) {
      if (!STATE_RE.test(state)) return null; // hostile input never reaches storage
      const raw = await redis.getdel(keyFor(state));
      if (raw === null) return null;
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch {
        return null;
      }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
      const o = obj as Record<string, unknown>;
      if (!VERIFIER_RE.test(o.verifier as string)) return null;
      if (!STATE_RE.test(o.nonce as string)) return null;
      if (
        typeof o.returnTo !== 'string' ||
        !RETURN_TO_RE.test(o.returnTo) ||
        o.returnTo.startsWith('//') ||
        o.returnTo.includes('..')
      ) {
        return null;
      }
      if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null;
      const challenge: FlowChallenge = {
        verifier: o.verifier as string,
        nonce: o.nonce as string,
        returnTo: o.returnTo,
        expiresAt: o.expiresAt,
      };
      if (challenge.expiresAt <= now()) return null; // clock raced the TTL: same denial
      return challenge;
    },
  };
}
