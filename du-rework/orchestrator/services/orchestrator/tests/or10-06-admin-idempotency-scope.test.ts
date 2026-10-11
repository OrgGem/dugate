import {
  dispatchAdminAction,
  type AdminActionDeps,
} from '../src/modules/admin-actions/dispatcher';
import type { Db } from '../src/db/db';
import type { AdminActionAuth } from '../src/modules/admin-actions/rbac';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const OPERATION_ID = 'operation-1';
const IDEMPOTENCY_KEY = 'or10-06-idem-key-01';

interface MarkerRow {
  key: string;
  route: string;
  payload_hash: string;
  response_code: number;
  response_body: unknown;
}

function operatorAuth(tenantId: string, principalId: string): AdminActionAuth {
  return {
    kind: 'cookie',
    role: 'operator',
    csrfOk: true,
    tenantId,
    principalId,
    issuer: 'https://admin.example.test',
  };
}

function makeWorld() {
  const operationTenants = new Map([[OPERATION_ID, TENANT_A]]);
  const markers = new Map<string, MarkerRow>();
  const markerLookups: string[] = [];
  const canceled: string[] = [];

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT tenant_id FROM operations')) {
        const operationId = String(params[0]);
        const tenantId = operationTenants.get(operationId);
        if (!tenantId) return { rows: [], rowCount: 0 };
        if (/AND tenant_id\s*=\s*\$2/.test(sql) && tenantId !== params[1]) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ tenant_id: tenantId }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO admin_idempotency')) {
        const marker: MarkerRow = {
          key: String(params[0]),
          route: String(params[1]),
          payload_hash: String(params[2]),
          response_code: Number(params[3]),
          response_body: JSON.parse(String(params[4])),
        };
        markers.set(marker.key, marker);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const db = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT key, route, payload_hash')) {
        const key = String(params[0]);
        markerLookups.push(key);
        const row = markers.get(key);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    tx: async (fn: (txClient: unknown) => Promise<unknown>) => fn(client),
    close: async () => undefined,
  } as unknown as Db;

  const deps: AdminActionDeps = {
    db,
    audit: {
      record: async () => ({ id: 'audit-1' }),
      listForTenant: async () => [],
    } as unknown as AdminActionDeps['audit'],
    registry: {} as AdminActionDeps['registry'],
    profiles: {} as AdminActionDeps['profiles'],
    lifecycle: {
      cancelOperation: async (operationId: string, tenantId: string) => {
        canceled.push(`${operationId}:${tenantId}`);
        return { operationId, state: 'CANCELLED' };
      },
    } as unknown as AdminActionDeps['lifecycle'],
    runtime: {
      resumeOperation: async (operationId: string) => ({ operationId }),
    } as AdminActionDeps['runtime'],
    hashApiKey: (raw) => `hash:${raw}`,
    correlationId: 'or10-06-test',
  };

  return { deps, operationTenants, markers, markerLookups, canceled };
}

function cancel(auth: AdminActionAuth) {
  return (deps: AdminActionDeps) =>
    dispatchAdminAction(deps, auth, {
      action: 'operations.cancel',
      params: { operationId: OPERATION_ID },
      idempotencyKey: IDEMPOTENCY_KEY,
    });
}

describe('OR10-06 admin idempotency scope (offline)', () => {
  it('replays for the same principal, then fences a cross-tenant or revoked resource before marker lookup', async () => {
    const world = makeWorld();
    const tenantAOperator = operatorAuth(TENANT_A, 'user-1');

    const first = await cancel(tenantAOperator)(world.deps);
    const replay = await cancel(tenantAOperator)(world.deps);
    expect(first).toEqual(replay);
    expect(world.canceled).toEqual([`${OPERATION_ID}:${TENANT_A}`]);
    expect(world.markerLookups).toEqual([IDEMPOTENCY_KEY, IDEMPOTENCY_KEY]);

    await expect(
      cancel({
        kind: 'cookie',
        role: 'viewer',
        csrfOk: true,
        tenantId: TENANT_A,
        principalId: 'user-1',
        issuer: 'https://admin.example.test',
      })(world.deps)
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(world.markerLookups).toHaveLength(2);

    await expect(cancel(operatorAuth(TENANT_B, 'user-2'))(world.deps)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(world.markerLookups).toHaveLength(2);
    expect(world.canceled).toHaveLength(1);

    // Model a resource whose tenant access changed after the original write.
    world.operationTenants.set(OPERATION_ID, TENANT_B);
    await expect(cancel(tenantAOperator)(world.deps)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(world.markerLookups).toHaveLength(2);
    expect(world.canceled).toHaveLength(1);
  });

  it('does not return one principal’s marker to another principal in the same tenant', async () => {
    const world = makeWorld();
    await cancel(operatorAuth(TENANT_A, 'user-1'))(world.deps);

    await expect(cancel(operatorAuth(TENANT_A, 'user-2'))(world.deps)).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(world.markerLookups).toEqual([IDEMPOTENCY_KEY, IDEMPOTENCY_KEY]);
    expect(world.canceled).toEqual([`${OPERATION_ID}:${TENANT_A}`]);
    expect(world.markers.size).toBe(1);
  });
});
