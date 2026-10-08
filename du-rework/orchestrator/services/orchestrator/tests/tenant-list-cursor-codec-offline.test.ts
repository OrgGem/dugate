/** Offline coverage for the tenant roster cursor codec and SQL keyset fence. */
import type { QueryResult, QueryResultRow } from 'pg';
import { ADMIN_LIST_LIMIT_MAX, LIST_CURSOR_MAX_LEN } from '@du/contracts';
import type { Db } from '../src/db/db';
import {
  decodeTenantListCursor,
  encodeTenantListCursor,
  listTenantPage,
  parseTenantListQuery,
  type TenantDbRow,
} from '../src/modules/admin-read/tenant-list';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';

interface Call {
  sql: string;
  params: unknown[];
}

function pgResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  };
}

function fakeTenantDb(population: TenantDbRow[]): { db: Db; calls: Call[] } {
  const calls: Call[] = [];

  const db = {
    async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params: [...params] });

      if (/^SELECT count\(\*\)::int AS total FROM tenants/i.test(normalized)) {
        const scope = /WHERE id = \$(\d+)/.exec(normalized);
        const rows = scope
          ? population.filter((row) => row.id === String(params[Number(scope[1]) - 1]))
          : population;
        return pgResult([{ total: rows.length } as unknown as T]);
      }

      if (/^SELECT id, name, state FROM tenants/i.test(normalized)) {
        const scope = /WHERE id = \$(\d+)(?: AND|$)/.exec(normalized);
        let rows = scope
          ? population.filter((row) => row.id === String(params[Number(scope[1]) - 1]))
          : [...population];

        const boundary = /\(lower\(name\), id\) ([<>]) \(\(SELECT lower\(name\) FROM tenants WHERE id = \$(\d+)(?: AND id = \$(\d+))?\), \$(\d+)::uuid\)/.exec(normalized);
        if (boundary) {
          const boundaryId = String(params[Number(boundary[2]) - 1]).toLowerCase();
          const boundaryScope = boundary[3] === undefined
            ? null
            : String(params[Number(boundary[3]) - 1]).toLowerCase();
          const boundaryRow = population.find((row) => row.id.toLowerCase() === boundaryId
            && (boundaryScope === null || row.id.toLowerCase() === boundaryScope));
          if (!boundaryRow) {
            rows = [];
          } else {
            const boundaryName = boundaryRow.name.toLowerCase();
            const operator = boundary[1];
            rows = rows.filter((row) => {
              const name = row.name.toLowerCase();
              const comparison = name === boundaryName
                ? (row.id.toLowerCase() < boundaryId ? -1 : row.id.toLowerCase() > boundaryId ? 1 : 0)
                : name < boundaryName ? -1 : 1;
              return operator === '<' ? comparison < 0 : comparison > 0;
            });
          }
        }

        const order = /ORDER BY lower\(name\) (ASC|DESC), id (ASC|DESC) LIMIT \$(\d+)/.exec(normalized);
        if (!order) throw new Error('unparsed tenant page SQL: ' + normalized);
        const factor = order[1] === 'ASC' ? 1 : -1;
        rows.sort((left, right) => {
          const leftName = left.name.toLowerCase();
          const rightName = right.name.toLowerCase();
          if (leftName !== rightName) return leftName < rightName ? -factor : factor;
          return left.id.toLowerCase() < right.id.toLowerCase() ? -factor : factor;
        });
        const limit = Number(params[Number(order[3]) - 1]);
        return pgResult(rows.slice(0, limit) as unknown as T[]);
      }

      throw new Error('unexpected tenant-list SQL: ' + normalized);
    },
  } as unknown as Db;

  return { db, calls };
}

describe('tenant-list cursor codec and SQL fence (offline)', () => {
  it.each(['next', 'prev'] as const)('round-trips tenant id and %s direction', (direction) => {
    const cursor = encodeTenantListCursor(TENANT_A, direction);

    expect(decodeTenantListCursor(cursor)).toEqual({ id: TENANT_A, direction });
  });

  it('keeps a long tenant name out of the bounded opaque cursor', () => {
    const longTenantName = 'private-tenant-name-'.repeat(500);
    const cursor = encodeTenantListCursor(TENANT_A, 'prev');
    const decodedText = Buffer.from(cursor, 'base64url').toString('utf8');

    expect(cursor.length).toBeLessThanOrEqual(LIST_CURSOR_MAX_LEN);
    expect(cursor).not.toContain(longTenantName);
    expect(decodedText).not.toContain(longTenantName);
    expect(decodedText).toBe(`${TENANT_A}|p`);
  });

  it('reuses a cursor under a new scope while fencing rows and count to that scope', async () => {
    const population: TenantDbRow[] = [
      { id: TENANT_A, name: 'Alpha', state: 'ACTIVE' },
      { id: TENANT_B, name: 'Beta', state: 'ACTIVE' },
      { id: TENANT_C, name: 'Gamma', state: 'ACTIVE' },
    ];
    const { db, calls } = fakeTenantDb(population);
    const cursor = decodeTenantListCursor(encodeTenantListCursor(TENANT_A, 'next'));
    if (!cursor) throw new Error('fixture cursor failed to decode');

    const page = await listTenantPage(db, TENANT_B, { limit: 2, cursor });

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toMatch(/FROM tenants WHERE id = \$1 AND \(lower\(name\), id\) >/);
    expect(calls[0]!.sql).toMatch(/SELECT lower\(name\) FROM tenants WHERE id = \$2 AND id = \$1/);
    expect(calls[0]!.params).toEqual([TENANT_B, TENANT_A, 3]);

    const countCall = calls[1]!;
    expect(countCall.sql).toBe('SELECT count(*)::int AS total FROM tenants WHERE id = $1');
    expect(countCall.params).toEqual([TENANT_B]);
    expect(countCall.params).not.toContain(TENANT_A);

    // Beta is ordered before the foreign cursor tenant Gamma. Without a scope
    // predicate inside the boundary subquery, this result reveals that ordering bit.
    const foreignCursor = decodeTenantListCursor(encodeTenantListCursor(TENANT_C, 'next'));
    if (!foreignCursor) throw new Error('foreign fixture cursor failed to decode');
    const foreignScope = fakeTenantDb(population);
    const foreignPage = await listTenantPage(foreignScope.db, TENANT_B, { limit: 2, cursor: foreignCursor });

    expect(foreignPage.rows).toEqual([]);
    expect(foreignScope.calls[0]!.sql).toMatch(
      /SELECT lower\(name\) FROM tenants WHERE id = \$2 AND id = \$1/,
    );
    expect(foreignScope.calls[0]!.params).toEqual([TENANT_B, TENANT_C, 3]);
  });

  it('clamps parsed limits to 1 and ADMIN_LIST_LIMIT_MAX', () => {
    expect(parseTenantListQuery(new URLSearchParams('limit=0')).limit).toBe(1);
    expect(parseTenantListQuery(new URLSearchParams(`limit=${ADMIN_LIST_LIMIT_MAX + 1}`)).limit)
      .toBe(ADMIN_LIST_LIMIT_MAX);
  });

  it('returns null without throwing for forged non-UUID cursors', () => {
    const forged = [
      '%%%not-a-cursor',
      Buffer.from('tenant-name-is-not-a-uuid', 'utf8').toString('base64url'),
    ];

    for (const cursor of forged) {
      expect(() => decodeTenantListCursor(cursor)).not.toThrow();
      expect(decodeTenantListCursor(cursor)).toBeNull();
    }
  });
});
