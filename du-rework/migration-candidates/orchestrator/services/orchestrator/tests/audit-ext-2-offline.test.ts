import { handleAdminRoutes } from '../src/http/routes/admin';
import type { RouteContext } from '../src/http/route-context';
import type { AuditRecordInput, AuditService } from '../src/modules/audit/audit';

/**
 * AUDIT-EXT-2 (route plane) — the direct admin route mutations
 * (`http/routes/admin.ts`) now write the SERVER-DERIVED principal role into
 * the ledger. This plane authenticates with the platform admin bearer only
 * (`assertAdminAuth`) or the resolved admin principal, so:
 *  - `actorRole` lands ('platform' for the token plane; the resolved role for
 *    the profile-bindings route),
 *  - NO subject/issuer is invented (a bearer carries none),
 *  - the `actor` fallback ('admin') is unchanged.
 *
 * Offline: in-memory route context; the real route function under test.
 */

interface RouteWorld {
  auditRows: AuditRecordInput[];
  calls: { update: number; activate: number; deactivate: number; sweep: number; createRevision: number };
  ctx: (over: { method: string; pathname: string; body?: unknown }) => RouteContext;
}

function makeWorld(): RouteWorld {
  const auditRows: AuditRecordInput[] = [];
  const calls = { update: 0, activate: 0, deactivate: 0, sweep: 0, createRevision: 0 };

  const client = {
    query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('UPDATE business_versions')) {
        calls.update += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    tx: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    close: async () => undefined,
  };
  const audit = {
    record: async (input: AuditRecordInput) => {
      auditRows.push(input);
      return { id: 'a-' + auditRows.length };
    },
    listForTenant: async () => [],
  } as unknown as AuditService;

  const base = {
    searchParams: new URLSearchParams(),
    rawBody: Buffer.alloc(0),
    body: null as unknown,
    correlationId: 'corr-audit-ext-2',
    host: 'localhost',
    headers: { authorization: 'Bearer tok' } as Record<string, string>,
    config: { adminToken: 'tok' },
    registry: {
      activateVersion: async () => {
        calls.activate += 1;
        return { businessId: 'biz', version: '1.0.0', active: true, replayed: false };
      },
      deactivateVersion: async () => {
        calls.deactivate += 1;
        return { businessId: 'biz', version: '1.0.0', active: false, replayed: false };
      },
    },
    lifecycle: {
      sweepDeadlines: async () => {
        calls.sweep += 1;
        return 2;
      },
    },
    profiles: {
      createRevision: async () => {
        calls.createRevision += 1;
        return { profileId: 'p-1', revision: 1, tenantId: 'ten-1', apiKeyId: 'k-1' };
      },
    },
    db,
    audit,
  };

  return {
    auditRows,
    calls,
    ctx: (over) => ({ ...base, ...over } as unknown as RouteContext),
  };
}

const BIZ = 'biz';
const VER = '1.0.0';

describe('AUDIT-EXT-2: direct admin routes write the server-derived role', () => {
  it('business.enable: actorRole platform; actor fallback + absent sub/issuer', async () => {
    const w = makeWorld();
    const res = await handleAdminRoutes(
      w.ctx({ method: 'PUT', pathname: `/api/v1/admin/businesses/${BIZ}/versions/${VER}/enable` })
    );
    expect(res!.status).toBe(200);
    expect(w.auditRows[0]).toMatchObject({ actor: 'admin', actorRole: 'platform', action: 'business.enable' });
    expect(w.auditRows[0]!.actorSub).toBeUndefined();
    expect(w.auditRows[0]!.actorIssuer).toBeUndefined();
  });

  it('business.activate and business.drain: same principal fields', async () => {
    const w = makeWorld();
    await handleAdminRoutes(
      w.ctx({ method: 'PUT', pathname: `/api/v1/admin/businesses/${BIZ}/versions/${VER}/activate` })
    );
    await handleAdminRoutes(
      w.ctx({ method: 'PUT', pathname: `/api/v1/admin/businesses/${BIZ}/versions/${VER}/deactivate` })
    );
    expect(w.auditRows.map((a) => a.action)).toEqual(['business.activate', 'business.drain']);
    for (const row of w.auditRows) expect(row.actorRole).toBe('platform');
  });

  it('profile-bindings POST: actorRole from the resolved admin principal', async () => {
    const w = makeWorld();
    const res = await handleAdminRoutes(
      w.ctx({
        method: 'POST',
        pathname: '/api/v1/admin/profile-bindings',
        body: { apiKey: 'raw-key-123', businessId: BIZ, businessVersion: VER, action: 'extract' },
      })
    );
    expect(res!.status).toBe(201);
    expect(w.calls.createRevision).toBe(1);
    expect(w.auditRows[0]).toMatchObject({ actor: 'admin', actorRole: 'platform', action: 'profile_binding.bind' });
  });

  it('operations sweep-deadlines POST: actorRole platform', async () => {
    const w = makeWorld();
    const res = await handleAdminRoutes(
      w.ctx({ method: 'POST', pathname: '/api/v1/admin/operations/sweep-deadlines' })
    );
    expect(res!.status).toBe(200);
    expect(w.calls.sweep).toBe(1);
    expect(w.auditRows[0]).toMatchObject({ actorRole: 'platform', action: 'operation.deadline' });
  });
});
