import { randomUUID } from 'node:crypto';
import { waitForTerminal, isTerminal } from '../src/modules/operations/facade';
import { HttpError } from '../src/http/errors';

/**
 * R24-01 offline functional proof (Qwen-2 lane, zero DB/Redis, in-memory only).
 *
 * Complements services/orchestrator/tests/operation-tenant-fence.test.ts (real-HTTP,
 * Claudes' suite, needs the DB window and is unrun). This suite pins the SAME four
 * acceptance invariants at the seam level — waitForTerminal(getOp, id, wait) where
 * getOp is exactly the tenant-scoped reader the public route injects
 * (server.ts:674-679 → getTenantOperation WHERE id=$1 AND tenant_id=$2):
 *
 *   1. foreign TERMINAL id + ?wait=30 → prompt 404, no 30 s poll;
 *   2. foreign ACTIVE id + ?wait=10 → prompt 404, no timing leak;
 *   3. ownership flip mid-poll → fence re-checked per iteration → 404;
 *   4. authorized long-poll still reaches terminal view (owner sees SUCCEEDED).
 *
 * Run offline: npx jest tests/r24-01-poll-fence-offline.functional.test.ts --runInBand
 */

class TenantedOps {
  readonly ops = new Map<string, { id: string; tenantId: string; state: string }>();

  seed(tenantId: string, state: string): string {
    const id = randomUUID();
    this.ops.set(id, { id, tenantId, state });
    return id;
  }

  setState(id: string, state: string): void {
    const op = this.ops.get(id);
    if (op) op.state = state;
  }

  /** Exactly the route's getOp: WHERE id=$1 AND tenant_id=$2 → foreign id is indistinguishable from missing. */
  async scopedRead(id: string, tenantId: string): Promise<Record<string, unknown>> {
    const op = this.ops.get(id);
    if (!op || op.tenantId !== tenantId) {
      throw new HttpError(404, 'NOT_FOUND', `operation ${id} not found`);
    }
    return { ...op };
  }
}

describe('R24-01 long-poll tenant fence (offline functional, Qwen-2)', () => {
  it('foreign TERMINAL id with wait=30 → prompt 404, no poll', async () => {
    const store = new TenantedOps();
    const foreignId = store.seed('tenant-b', 'SUCCEEDED');
    const getOp = (id: string) => store.scopedRead(id, 'tenant-a');

    const t0 = Date.now();
    await expect(waitForTerminal(getOp, foreignId, 30)).rejects.toMatchObject({
      name: 'HttpError',
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(Date.now() - t0).toBeLessThan(5000); // pre-fix this took the full 30 s
  });

  it('foreign ACTIVE id with wait=10 → prompt 404, no timing leak', async () => {
    const store = new TenantedOps();
    const foreignId = store.seed('tenant-b', 'RUNNING');
    const getOp = (id: string) => store.scopedRead(id, 'tenant-a');

    const t0 = Date.now();
    await expect(waitForTerminal(getOp, foreignId, 10)).rejects.toMatchObject({
      name: 'HttpError',
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('ownership flip mid-poll → fence re-checked per iteration → 404', async () => {
    const store = new TenantedOps();
    const ownId = store.seed('tenant-a', 'RUNNING');
    const getOp = (id: string) => store.scopedRead(id, 'tenant-a');

    const pending = waitForTerminal(getOp, ownId, 10);
    await new Promise((r) => setTimeout(r, 600));
    // Operation changes hands on tenant-a → tenant-b; next 500 ms re-read must re-fence.
    store.ops.get(ownId)!.tenantId = 'tenant-b';

    const t0 = Date.now();
    await expect(pending).rejects.toMatchObject({ name: 'HttpError', code: 'NOT_FOUND', status: 404 });
    expect(Date.now() - t0).toBeLessThan(8000); // flip + one iteration, not the full 10 s
  });

  it('authorized long-poll still reaches terminal view (owner sees SUCCEEDED)', async () => {
    const store = new TenantedOps();
    const ownId = store.seed('tenant-a', 'RUNNING');
    const getOp = (id: string) => store.scopedRead(id, 'tenant-a');

    const pending = waitForTerminal(getOp, ownId, 10);
    await new Promise((r) => setTimeout(r, 600));
    store.setState(ownId, 'SUCCEEDED');

    const op = await pending;
    expect(op.state).toBe('SUCCEEDED');
    expect(op.id).toBe(ownId);
    expect(isTerminal(op.state as string)).toBe(true);
  });

  it('wait=0 returns the current view without polling (clamp floor)', async () => {
    const store = new TenantedOps();
    const id = store.seed('tenant-a', 'RUNNING');
    const getOp = (id2: string) => store.scopedRead(id2, 'tenant-a');
    const op = await waitForTerminal(getOp, id, 0);
    expect(op.state).toBe('RUNNING');
  });
});