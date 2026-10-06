/**
 * CONV-13 (CONV-D03): ONE audit wire projection, owned by the audit module.
 *
 * The projection body used to exist twice — `audit.ts:toWire` (private) and
 * `server.ts:toAuditWire` (marked "Mirrors audit.ts"). This suite pins the
 * consolidation three ways:
 *   1. the shared mapper is byte-for-byte the historical projection, for both
 *      a Date `created_at` (pg timestamptz) and a string one (fixtures/cursor
 *      rows), and preserves a NULL tenant;
 *   2. the service list AND the paginated route consume the same function;
 *   3. no copy survives: `server.ts` and the pagination owner both keep no
 *      local projection, and the owner imports the mapper from the module.
 *      (CONV-02 moved the pagination to src/http/routes/admin.ts +
 *      src/modules/admin-read/audit-list.ts, so the pin follows it there.)
 *
 * Offline only: fake db, no PG/Redis.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../src/db/db';
import {
  createAuditService,
  listAuthorizedAuditEvents,
  toAuditWire,
  type AuditRow,
} from '../src/modules/audit/audit';

const TENANT = 'tenant-conv13';
const ROW: AuditRow = {
  id: 'evt-0001',
  tenant_id: TENANT,
  actor: 'admin',
  action: 'business.enable',
  resource: 'business:doc@1.0.0',
  severity: 'warning',
  correlation_id: 'corr-1',
  created_at: new Date('2026-09-25T09:00:00.000Z'),
};

/**
 * Verbatim copy of the historical projection (audit.ts `toWire` and
 * server.ts `toAuditWire` were byte-identical). The shared mapper must emit
 * EXACTLY this object — this literal is the before/after deep-equal anchor.
 */
const WIRE = {
  id: 'evt-0001',
  kind: 'business.enable',
  severity: 'warning',
  occurredAt: '2026-09-25T09:00:00.000Z',
  tenantId: TENANT,
  resourceId: 'business:doc@1.0.0',
  actor: 'admin',
  message: 'business.enable business:doc@1.0.0',
};

describe('CONV-13: a single audit wire projection', () => {
  it('maps a Date created_at and a string created_at to the identical wire row', () => {
    expect(toAuditWire(ROW)).toEqual(WIRE);
    const stringRow = { ...ROW, created_at: '2026-09-25T09:00:00.000Z' } as unknown as AuditRow;
    expect(toAuditWire(stringRow)).toEqual(WIRE);
  });

  it('preserves a NULL tenant and survives a JSON round-trip unchanged', () => {
    const wire = toAuditWire({ ...ROW, tenant_id: null });
    expect(wire.tenantId).toBeNull();
    expect(JSON.parse(JSON.stringify(wire))).toEqual({ ...WIRE, tenantId: null });
  });

  it('the service list and the authorized read both project through the same function', async () => {
    const db = { query: jest.fn(async () => ({ rows: [ROW], rowCount: 1 })) };
    const audit = createAuditService(db as unknown as Db);

    await expect(audit.listForTenant(TENANT, 10)).resolves.toEqual([WIRE]);

    const authorized = await listAuthorizedAuditEvents(audit, { role: 'platform' }, TENANT, 10);
    expect(authorized).toEqual({ tenantId: TENANT, events: [WIRE] });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('no copy survives: the pagination owner imports the projection from the audit module', () => {
    const server = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
    expect(server).not.toMatch(/function toAuditWire\s*\(/);
    expect(server).not.toContain('Mirrors audit.ts');

    // CONV-02: the audit page (and its toAuditWire call) lives in the admin
    // route family now; the module that projects the rows must import the
    // shared mapper rather than re-declare it.
    const auditList = readFileSync(
      join(__dirname, '..', 'src', 'modules', 'admin-read', 'audit-list.ts'),
      'utf8',
    );
    expect(auditList).toContain("import { toAuditWire, type AuditRow } from '../audit/audit';");
    expect(auditList).not.toMatch(/function toAuditWire\s*\(/);

    // And the admin routes reach that page through the audit-read module.
    const adminRoutes = readFileSync(
      join(__dirname, '..', 'src', 'http', 'routes', 'admin.ts'),
      'utf8',
    );
    const auditImport = adminRoutes
      .split('\n')
      .find((line) => line.includes("from '../../modules/admin-read/audit-list'"));
    expect(auditImport).toBeDefined();
    expect(auditImport).toContain('listAuditEventPage');
  });
});
