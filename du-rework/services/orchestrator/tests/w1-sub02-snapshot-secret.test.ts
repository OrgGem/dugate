import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createSubmissionService } from '../src/modules/operations/submission';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';
import { ProfilePolicySnapshotSchema, PinnedProfilePolicySchema } from '@du/contracts';

/**
 * W1 (T-SUB-02 / PLAN04-01) — the admission-time snapshot must not carry a
 * Profile credential.
 *
 * The defect this pins: `resolveEffectiveProfile` DECRYPTS `fileUrlAuthConfig`
 * (`profiles.ts` `decodePolicy`), and the submit path used to serialize that
 * whole policy into `operations.profile_policy_snapshot`. The claim schema was
 * `.passthrough()` at BOTH levels, so the plaintext token survived into the
 * worker claim as well. Both halves are fixed; this suite fails if either
 * regresses.
 *
 * Every case here INJECTS a real sentinel into the resolved policy and then
 * asserts it is absent downstream. A `not.toContain` that never saw the
 * sentinel prove nothing (`feedback/verify-failure-reason.md`), so the positive
 * control in the first case matters as much as the negatives: if the fake
 * profile ever stopped carrying a secret, these would pass for free.
 */

const TENANT = '7a000000-0000-4000-8000-000000000001';
const KEY = '7a000000-0000-4000-8000-000000000002';
const PROFILE_ID = '7a000000-0000-4000-8000-000000000003';
const REVISION = 7;

const TOKEN_SENTINEL = 'W1-SNAPSHOT-SENTINEL-TOKEN-4b71';
const HEADER_SENTINEL = 'W1-SNAPSHOT-SENTINEL-HEADER-9c02';
const QUERY_SENTINEL = 'W1-SNAPSHOT-SENTINEL-QUERY-1f8e';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type Call = { sql: string; params: unknown[] };

/** db + registry fakes deep enough to reach the operations/outbox INSERTs. */
function makeDb() {
  const calls: Call[] = [];
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(statement: string, params: unknown[] = []) => {
      calls.push({ sql: statement, params });
      if (/business_versions/i.test(statement)) {
        return result<T>([{
          version: '1.0.0',
          digest: 'sha256:test',
          queue: 'q',
          manifest: {
            actions: [{ name: 'ingest', inputSchema: { type: 'object' } }],
            runtime: { handlerKinds: ['root'] },
          },
        }]);
      }
      if (/FROM operations/i.test(statement)) {
        return result<T>([{
          id: '7a000000-0000-4000-8000-000000000009',
          tenant_id: TENANT,
          business_id: 'demo',
          business_version: '1.0.0',
          action: 'ingest',
          state: 'ACCEPTED',
          state_version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deadline_at: null,
        }]);
      }
      return result<T>([]);
    },
    tx: async <T>(fn: (client: unknown) => Promise<T>) => fn({
      query: async (statement: string, params: unknown[] = []) => {
        calls.push({ sql: statement, params });
        return result([]);
      },
    }),
    close: async () => undefined,
  } as unknown as Db;
  return { db, calls };
}

/** A pinned profile carrying REAL secrets in every credential slot. */
function pinnedProfile(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'pinned' as const,
    profileId: PROFILE_ID,
    revision: REVISION,
    bindings: { slot: 'connector-1@2' },
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH' as const,
      allowedFileExtensions: 'pdf,docx',
      connectionsOverride: [],
      fileUrlAuthConfig: {
        type: 'bearer' as const,
        token: TOKEN_SENTINEL,
        header_name: 'X-Api-Key',
        header_value: HEADER_SENTINEL,
        query_key: 'api_key',
        query_value: QUERY_SENTINEL,
      },
      ...overrides,
    },
    effectiveParameters: {},
    passthrough: {},
    effectiveInput: {},
    bullMqPriority: 1,
  };
}

function service(db: Db, profile: unknown) {
  const profiles = {
    resolveBinding: async () => ({ mode: 'legacy' as const }),
    resolveEffectiveProfile: async () => profile,
  } as unknown as ProfileService;
  return createSubmissionService(db, {} as RegistryService, profiles, {});
}

function ctx() {
  return {
    tenantId: TENANT,
    apiKeyId: KEY,
    businessId: 'demo',
    action: 'ingest',
    submission: { input: { text: 'inline only' } },
  };
}

function mustCall(calls: Call[], pattern: RegExp): Call {
  const hit = calls.find((call) => pattern.test(call.sql));
  if (!hit) throw new Error(`no statement matched ${pattern}`);
  return hit;
}

/** Deep scan incl. base64 — a sealed/encoded copy is still a leak. */
function leaks(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') {
    if (value.includes(TOKEN_SENTINEL) || value.includes(HEADER_SENTINEL) || value.includes(QUERY_SENTINEL)) return true;
    if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        if (decoded.includes(TOKEN_SENTINEL) || decoded.includes(HEADER_SENTINEL) || decoded.includes(QUERY_SENTINEL)) return true;
      } catch {
        /* not base64 */
      }
    }
    return false;
  }
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => leaks(v, depth + 1));
  return Object.values(value as Record<string, unknown>).some((v) => leaks(v, depth + 1));
}

const ALL_SENTINELS = [TOKEN_SENTINEL, HEADER_SENTINEL, QUERY_SENTINEL];

describe('W1 T-SUB-02 admission snapshot carries no Profile credential', () => {
  it('POSITIVE CONTROL: the fake profile really does carry the sentinels', () => {
    // Guards the negatives below from passing for free.
    const profile = pinnedProfile();
    expect(leaks(profile.policy.fileUrlAuthConfig)).toBe(true);
    expect(profile.policy.fileUrlAuthConfig.token).toBe(TOKEN_SENTINEL);
  });

  it('writes a snapshot with no token/header/query secret and carries the credential ref', async () => {
    const { db, calls } = makeDb();
    await service(db, pinnedProfile()).submit(ctx());

    const insert = mustCall(calls, /INSERT INTO operations/i);
    const snapshot = JSON.parse(String(insert.params[15])) as Record<string, unknown>;

    // The whole insert payload must be clean, not just the snapshot field.
    for (const call of calls) {
      expect(leaks(call.params)).toBe(false);
    }

    expect(snapshot.fileUrlAuthConfigured).toBe(true);
    expect(snapshot.credentialRef).toEqual({
      tenantId: TENANT,
      profileId: PROFILE_ID,
      profileRevision: REVISION,
    });
    expect(snapshot).not.toHaveProperty('fileUrlAuthConfig');
  });

  it('the written snapshot satisfies ProfilePolicySnapshotSchema', async () => {
    const { db, calls } = makeDb();
    await service(db, pinnedProfile()).submit(ctx());
    const insert = mustCall(calls, /INSERT INTO operations/i);
    const snapshot = JSON.parse(String(insert.params[15]));
    const parsed = ProfilePolicySnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
  });

  it('the outbox payload carries no secret either', async () => {
    const { db, calls } = makeDb();
    await service(db, pinnedProfile()).submit(ctx());
    const outbox = mustCall(calls, /INSERT INTO outbox/i);
    const payload = JSON.parse(String(outbox.params[2])) as Record<string, unknown>;
    expect(leaks(payload)).toBe(false);
    // T-SUB-03: priority still travels in the outbox row (F-PP1 direction kept).
    expect(payload.priority).toBe(1);
  });

  it('type=none config with no token is recorded as not configured', async () => {
    const { db, calls } = makeDb();
    await service(db, pinnedProfile({ fileUrlAuthConfig: { type: 'none' } })).submit(ctx());
    const insert = mustCall(calls, /INSERT INTO operations/i);
    const snapshot = JSON.parse(String(insert.params[15])) as Record<string, unknown>;
    expect(snapshot.fileUrlAuthConfigured).toBe(false);
  });

  it('null config is recorded as not configured and still carries the ref', async () => {
    const { db, calls } = makeDb();
    await service(db, pinnedProfile({ fileUrlAuthConfig: null })).submit(ctx());
    const insert = mustCall(calls, /INSERT INTO operations/i);
    const snapshot = JSON.parse(String(insert.params[15])) as Record<string, unknown>;
    expect(snapshot.fileUrlAuthConfigured).toBe(false);
    expect(snapshot.credentialRef).toEqual({
      tenantId: TENANT,
      profileId: PROFILE_ID,
      profileRevision: REVISION,
    });
  });

  it('PinnedProfilePolicySchema REJECTS a legacy snapshot that still holds a raw config', () => {
    // The claim-side fail-closed half. A row written before this fix (or by any
    // future writer that reintroduces the secret) must not parse into a claim.
    const legacy = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: 'pdf',
      connectionsOverride: [],
      fileUrlAuthConfig: { type: 'bearer', token: TOKEN_SENTINEL },
    };
    const parsed = PinnedProfilePolicySchema.safeParse(legacy);
    expect(parsed.success).toBe(false);
  });

  it('PinnedProfilePolicySchema rejects an unknown key that would previously passthrough', () => {
    // `.passthrough()` is what let an unexamined key ride into the claim.
    const polluted = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: 'pdf',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT, profileId: PROFILE_ID, profileRevision: REVISION },
      surpriseCredential: TOKEN_SENTINEL,
    };
    const parsed = PinnedProfilePolicySchema.safeParse(polluted);
    expect(parsed.success).toBe(false);
  });

  it('legacy mode still writes NULL (not an empty policy)', async () => {
    const { db, calls } = makeDb();
    const profiles = {
      resolveBinding: async () => ({ mode: 'legacy' as const }),
      resolveEffectiveProfile: async () => ({ mode: 'legacy' as const }),
    } as unknown as ProfileService;
    await createSubmissionService(db, {} as RegistryService, profiles, {}).submit(ctx());
    const insert = mustCall(calls, /INSERT INTO operations/i);
    expect(insert.params[15]).toBeNull();
  });

  it('no sentinel reaches ANY statement, across every credential type', async () => {
    for (const config of [
      { type: 'bearer', token: TOKEN_SENTINEL },
      { type: 'header', header_name: 'X-K', header_value: HEADER_SENTINEL },
      { type: 'query', query_key: 'api_key', query_value: QUERY_SENTINEL },
    ]) {
      const { db, calls } = makeDb();
      await service(db, pinnedProfile({ fileUrlAuthConfig: config })).submit(ctx());
      for (const sentinel of ALL_SENTINELS) {
        for (const call of calls) {
          expect(leaks(call.params)).toBe(false);
          expect(JSON.stringify(call.params)).not.toContain(sentinel);
        }
      }
    }
  });
});
