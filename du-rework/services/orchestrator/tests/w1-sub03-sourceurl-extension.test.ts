import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createSubmissionService } from '../src/modules/operations/submission';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';

/**
 * W1 (T-SUB-03 / PLAN04-01) — the profile extension CSV must cover the
 * top-level `sourceUrl` too.
 *
 * The gap: `assertProfileExtensionAllowed` checked `artifacts` and the
 * effective input's `file_urls`, but not `submission.sourceUrl`. PLAN04-01
 * names this explicitly ("Khong bo sot top-level sourceUrl"), so a profile
 * restricted to `pdf` still admitted `sourceUrl: .../payload.exe`.
 *
 * The URL path is checked BEFORE any network call, which is what makes this an
 * admission-time policy decision on caller-supplied metadata.
 */

const TENANT = '7b000000-0000-4000-8000-000000000001';
const KEY = '7b000000-0000-4000-8000-000000000002';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type Call = { sql: string; params: unknown[] };

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
          id: '7b000000-0000-4000-8000-000000000009',
          tenant_id: TENANT,
          business_id: 'demo',
          business_version: '1.0.0',
          action: 'ingest',
          state: 'PENDING_INGESTION',
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

/**
 * The CSV carries the LEADING DOT on purpose: `extname()` output is compared
 * verbatim against the entries, and `normalizedAllowedFileExtensions` folds
 * CASE only, never dots. Legacy parity — `policy.ts` documents the absent
 * dot-normalization as deliberate, so a config typo stays visible instead of
 * being silently repaired.
 */
function pinnedProfile(csv: string) {
  return {
    mode: 'pinned' as const,
    profileId: '7b000000-0000-4000-8000-000000000003',
    revision: 1,
    bindings: {},
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'MEDIUM' as const,
      allowedFileExtensions: csv,
      connectionsOverride: [],
      fileUrlAuthConfig: null,
    },
    effectiveParameters: {},
    passthrough: {},
    effectiveInput: {},
    bullMqPriority: 10,
  };
}

function svc(db: Db, csv: string) {
  const profiles = {
    resolveBinding: async () => ({ mode: 'legacy' as const }),
    resolveEffectiveProfile: async () => pinnedProfile(csv),
  } as unknown as ProfileService;
  return createSubmissionService(db, {} as RegistryService, profiles, { storageBackend: 's3' });
}

function ctx(sourceUrl: string) {
  return {
    tenantId: TENANT,
    apiKeyId: KEY,
    businessId: 'demo',
    action: 'ingest',
    submission: { input: { text: 'x' }, sourceUrl },
  };
}

describe('W1 T-SUB-03 sourceUrl is covered by the profile extension CSV', () => {
  it('refuses a sourceUrl whose extension is outside the profile CSV', async () => {
    const { db, calls } = makeDb();
    await expect(svc(db, '.pdf,.docx').submit(ctx('https://example.com/payload.exe')))
      .rejects.toMatchObject({ status: 422, code: 'PROFILE_EXTENSION_DENIED' });
    // Fail before the write transaction: a refused submit leaves zero rows.
    expect(calls.some((c) => /INSERT INTO/i.test(c.sql))).toBe(false);
  });

  it('admits a sourceUrl whose extension is inside the profile CSV', async () => {
    const { db, calls } = makeDb();
    await expect(svc(db, '.pdf,.docx').submit(ctx('https://example.com/report.pdf')))
      .resolves.toMatchObject({ replayed: false });
    expect(calls.some((c) => /INSERT INTO operations/i.test(c.sql))).toBe(true);
  });

  it('an empty profile CSV admits every sourceUrl (no narrowing by default)', async () => {
    const { db, calls } = makeDb();
    await expect(svc(db, '').submit(ctx('https://example.com/payload.exe')))
      .resolves.toMatchObject({ replayed: false });
    expect(calls.some((c) => /INSERT INTO operations/i.test(c.sql))).toBe(true);
  });

  it('a query string does not supply the extension', async () => {
    const { db } = makeDb();
    await expect(svc(db, '.pdf').submit(ctx('https://example.com/download?file=report.exe')))
      .rejects.toMatchObject({ status: 422, code: 'PROFILE_EXTENSION_DENIED' });
  });

  it('a URL with no path segment is not judged here (Content-Disposition owns it)', async () => {
    const { db, calls } = makeDb();
    await expect(svc(db, '.pdf').submit(ctx('https://example.com/'))).resolves.toBeDefined();
    expect(calls.some((c) => /INSERT INTO operations/i.test(c.sql))).toBe(true);
  });

  it('legacy mode does not apply any extension policy', async () => {
    const { db, calls } = makeDb();
    const profiles = {
      resolveBinding: async () => ({ mode: 'legacy' as const }),
      resolveEffectiveProfile: async () => ({ mode: 'legacy' as const }),
    } as unknown as ProfileService;
    const s = createSubmissionService(db, {} as RegistryService, profiles, { storageBackend: 's3' });
    await expect(s.submit(ctx('https://example.com/payload.exe'))).resolves.toMatchObject({ replayed: false });
    expect(calls.some((c) => /INSERT INTO operations/i.test(c.sql))).toBe(true);
  });
});
