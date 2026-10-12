import { createHash, randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import type { Db } from '../../db/db';
import { createAdminLocalCredentialReader } from '../../modules/auth/admin-local/credential-reader';
import { normalizeLocalUsername } from '../../modules/auth/admin-local/repository';
import { authenticateLocalPassword, hashLocalPassword, type LocalCredentialRecord, type LocalLoginGuard } from '../../modules/auth/local-primitives';
import { createIoredisSessionGateway, createRedisSessionRepository } from '../../modules/auth/redis-session-repository';
import { createSessionStore, type SessionRecord } from '../../modules/auth/session-store';
import type { AdminSessionStore } from '../../modules/admin-actions/rbac';

export interface LocalAdminAuth {
  login(username: string, password: string): Promise<SessionRecord | null>;
  destroy(sessionId: string): Promise<void>;
}

/** Explicit local mode uses shared Redis for both admission and opaque sessions. */
export async function createLocalAdminAuth(options: { db: Db; redisUrl: string; redisKeyPrefix?: string }): Promise<{ localAuth: LocalAdminAuth; sessions: AdminSessionStore; close(): Promise<void> }> {
  if (!options.redisUrl) throw new Error('Local admin authentication requires Redis.');
  const prefix = options.redisKeyPrefix ?? 'du:admin:local:';
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  const gateway = createIoredisSessionGateway(options.redisUrl);
  try { await Promise.all([redis.connect(), gateway.ready?.()]); }
  catch (error) { redis.disconnect(); await gateway.close?.(); throw error; }
  const store = createSessionStore({ repo: createRedisSessionRepository(gateway, { keyPrefix: `${prefix}sessions:` }) });
  const credentials = createAdminLocalCredentialReader(options.db);
  const versionKey = (id: string) => `${prefix}version:${createHash('sha256').update(id).digest('hex')}`;
  const dummyPasswordHash = await hashLocalPassword(randomBytes(32).toString('base64url'));
  const keyFor = (username: string) => {
    let normalized: string;
    try { normalized = normalizeLocalUsername(username); } catch { normalized = '<invalid-login>'; }
    return createHash('sha256').update(normalized).digest('hex');
  };
  const guard: LocalLoginGuard = {
    async beginAttempt(subject) {
      const result = Number(await redis.eval(`
        local global=redis.call('INCR',KEYS[1]); if global==1 then redis.call('PEXPIRE',KEYS[1],60000) end
        if global>200 then return 0 end
        if redis.call('EXISTS',KEYS[3])==1 then return 0 end
        local n=redis.call('INCR',KEYS[2]); if n==1 then redis.call('PEXPIRE',KEYS[2],60000) end
        if n>20 then return 0 end return 1`, 3, `${prefix}global`, `${prefix}attempt:${subject}`, `${prefix}lock:${subject}`));
      return { allowed: result === 1, reason: result === 1 ? 'allowed' : 'rate-limited', retryAfterMs: result === 1 ? 0 : 60_000 };
    },
    async recordFailure(subject) {
      const count = Number(await redis.eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],900000) end
        if n>=5 then redis.call('SET',KEYS[2],'1','PX',900000) end return n`, 2, `${prefix}failure:${subject}`, `${prefix}lock:${subject}`));
      return { allowed: count < 5, reason: count < 5 ? 'allowed' : 'locked', retryAfterMs: count < 5 ? 0 : 900_000 };
    },
    async recordSuccess(subject) { await redis.del(`${prefix}failure:${subject}`, `${prefix}attempt:${subject}`); },
  };
  const sessions: AdminSessionStore = {
    async get(id) {
      const session = await store.get(id);
      if (!session || session.issuer !== 'du-local') return null;
      const version = await redis.get(versionKey(id));
      const row = await options.db.query<{ version: number; role: string; tenant_id: string | null }>(
        `SELECT version, role, tenant_id FROM admin_local_users WHERE id=$1 AND is_enabled=true AND is_locked=false AND legacy_password_reset_required=false`, [session.sub]);
      const current = row.rows[0];
      if (!current || String(current.version) !== version || current.role !== session.role || current.tenant_id !== session.tenantId) {
        await store.destroy(id); await redis.del(versionKey(id)); return null;
      }
      const roleVersion = Number(current.version);
      if (!Number.isSafeInteger(roleVersion) || roleVersion < 1) {
        await store.destroy(id); await redis.del(versionKey(id)); return null;
      }
      return { ...session, roleVersion };
    },
  };
  return {
    sessions,
    localAuth: {
      async login(username, password) {
        let captured: LocalCredentialRecord | null = null;
        const auth = await authenticateLocalPassword({ login: username, password }, {
          credentials: { async findByLogin(login) { captured = await credentials.findByLogin(login); return captured; } },
          loginGuard: guard, dummyPasswordHash, subjectKeyForLogin: keyFor,
        });
        if (!auth.authenticated || !captured) return null;
        const principal = auth.principal;
        if (!['admin','operator','viewer'].includes(principal.role)) return null;
        // Snapshot only the exact verifier just authenticated, closing reset/login races.
        const snapshot = await options.db.query<{ version: number }>(`SELECT version FROM admin_local_users
          WHERE id=$1 AND password_hash=$2 AND role=$3 AND is_enabled=true AND is_locked=false AND legacy_password_reset_required=false`,
          [principal.sub, (captured as LocalCredentialRecord).passwordHash, principal.role]);
        if (!snapshot.rows[0]) return null;
        const session = await store.create({ ...principal, role: principal.role as SessionRecord['role'] });
        try { await redis.set(versionKey(session.sessionId), String(snapshot.rows[0].version), 'PX', Math.max(1, session.expiresAt-Date.now())); }
        catch (error) { await store.destroy(session.sessionId); throw error; }
        return session;
      },
      async destroy(id) { await store.destroy(id); await redis.del(versionKey(id)); },
    },
    async close() { await Promise.allSettled([redis.quit(), gateway.close?.()]); redis.disconnect(); },
  };
}
