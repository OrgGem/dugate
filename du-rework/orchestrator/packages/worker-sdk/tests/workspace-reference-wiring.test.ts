import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STALE_WORKSPACE_MS,
  TEMP_WORKSPACE_PREFIX,
  createWorkspaceReferenceCheck,
  sweepStaleWorkspaces,
} from '../src';
import type { WorkspaceReferenceQueryOptions } from '../src';

/**
 * W47-Q2-5 — offline wiring tests for the ART-02 remote reference hook
 * (createWorkspaceReferenceCheck -> GET /api/runtime/v1/workspace-reference,
 * contract per server.ts:711-743 as READ from code: 200 {workspacePath,
 * tenantId, referenced, activeHolders}; 401 bad bearer; 422 bad params;
 * NO 404). Zero DB, zero network: fetch is injected.
 *
 * Fail-safe contract asserted throughout: endpoint absent-answer, HTTP
 * non-2xx, timeout/abort, and malformed bodies ALL mean REFERENCED —
 * uncertainty never deletes.
 */

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fakeFetch(
  handler: (url: string) => Promise<Response> | Response,
  log: Recorded[]
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url);
  }) as typeof fetch;
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const BACKDATED = new Date(Date.now() - (DEFAULT_STALE_WORKSPACE_MS + 60_000));

async function plantStale(root: string, tag: string): Promise<string> {
  const dir = join(root, `${TEMP_WORKSPACE_PREFIX}${tag}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'bytes.bin'), 'x', 'utf8');
  await utimes(dir, BACKDATED, BACKDATED);
  return dir;
}

function check(partial: Omit<WorkspaceReferenceQueryOptions, 'baseUrl' | 'fetchImpl'> & {
  baseUrl?: string;
  fetchImpl: typeof fetch;
}): (dir: string) => Promise<boolean> {
  return createWorkspaceReferenceCheck({ baseUrl: 'http://runtime.test', ...partial });
}

describe('W47-Q2-5 createWorkspaceReferenceCheck (offline, injected fetch)', () => {
  let root: string;
  let log: Recorded[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'du-wref-test-'));
    log = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('referenced=true: hook answers true, request carries encoded workspacePath+tenantId+bearer', async () => {
    const dir = await plantStale(root, 'ref-true');
    const hook = check({
      tenantIds: [TENANT_A],
      token: 'rt_abc',
      fetchImpl: fakeFetch(() => jsonResponse(200, { workspacePath: 'x', tenantId: TENANT_A, referenced: true, activeHolders: 3 }), log),
    });

    await expect(hook(dir)).resolves.toBe(true);
    expect(log).toHaveLength(1);
    const u = new URL(log[0]!.url);
    expect(u.pathname).toBe('/api/runtime/v1/workspace-reference');
    expect(u.searchParams.get('workspacePath')).toBe(dir);
    expect(u.searchParams.get('tenantId')).toBe(TENANT_A);
    expect(log[0]!.headers.authorization).toBe('Bearer rt_abc');
  });

  it('referenced=false from EVERY tenant: hook answers false (orphan candidate)', async () => {
    const hook = check({
      tenantIds: [TENANT_A, TENANT_B],
      token: 'rt_abc',
      fetchImpl: fakeFetch(() => jsonResponse(200, { referenced: false, activeHolders: 0 }), log),
    });
    await expect(hook('/tmp/whatever')).resolves.toBe(false);
    expect(log).toHaveLength(2); // both tenants consulted
  });

  it('first tenant referenced=true short-circuits: second tenant never queried', async () => {
    const hook = check({
      tenantIds: [TENANT_A, TENANT_B],
      token: 'rt_abc',
      fetchImpl: fakeFetch((url) =>
        url.includes(TENANT_A)
          ? jsonResponse(200, { referenced: true, activeHolders: 1 })
          : jsonResponse(200, { referenced: false, activeHolders: 0 }), log),
    });
    await expect(hook('/tmp/any')).resolves.toBe(true);
    expect(log).toHaveLength(1);
  });

  it('FAIL-SAFE 5xx: answers referenced=true and reports uncertainty', async () => {
    const uncertain: string[] = [];
    const hook = check({
      tenantIds: [TENANT_A],
      token: 'rt_abc',
      timeoutMs: 250,
      fetchImpl: fakeFetch(() => jsonResponse(500, { error: 'boom' }), log),
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });
    await expect(hook('/tmp/x')).resolves.toBe(true);
    expect(uncertain).toEqual(['HTTP 500']);
  });

  it('FAIL-SAFE network rejection (endpoint unreachable): referenced=true, never delete', async () => {
    const uncertain: string[] = [];
    const hook = check({
      tenantIds: [TENANT_A],
      token: 'rt_abc',
      fetchImpl: fakeFetch(() => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5433')), log),
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });
    await expect(hook('/tmp/x')).resolves.toBe(true);
    expect(uncertain[0]).toContain('ECONNREFUSED');
  });

  it('FAIL-SAFE timeout: hanging fetch aborts at timeoutMs and answers referenced=true', async () => {
    const uncertain: string[] = [];
    const hook = check({
      tenantIds: [TENANT_A],
      token: 'rt_abc',
      timeoutMs: 30,
      fetchImpl: ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')));
        })) as unknown as typeof fetch,
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });
    await expect(hook('/tmp/x')).resolves.toBe(true);
    expect(uncertain[0]).toContain('TimeoutError');
  });

  it('FAIL-SAFE malformed body (referenced non-boolean): referenced=true', async () => {
    const uncertain: string[] = [];
    const hook = check({
      tenantIds: [TENANT_A],
      fetchImpl: fakeFetch(() => jsonResponse(200, { referenced: 'yes' }), log),
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });
    await expect(hook('/tmp/x')).resolves.toBe(true);
    expect(uncertain).toEqual(['malformed body']);
  });

  it('no token configured: request sent WITHOUT authorization header (endpoint answers 401 -> fail-safe)', async () => {
    const hook = check({
      tenantIds: [TENANT_A],
      fetchImpl: fakeFetch(() => jsonResponse(401, { error: 'unauthorized' }), log),
    });
    await expect(hook('/tmp/x')).resolves.toBe(true);
    expect(log[0]!.headers.authorization).toBeUndefined();
  });

  it('keeps traversal-looking workspace paths in one encoded query parameter and fails safe on 422', async () => {
    const traversalPath = `${root}/../../outside?tenantId=${TENANT_B}&workspacePath=/override`;
    const uncertain: string[] = [];
    const hook = check({
      tenantIds: [TENANT_A],
      fetchImpl: fakeFetch(() => jsonResponse(422, { error: 'INVALID_SCHEMA' }), log),
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });

    await expect(hook(traversalPath)).resolves.toBe(true);

    const requestUrl = new URL(log[0]!.url);
    expect(requestUrl.pathname).toBe('/api/runtime/v1/workspace-reference');
    expect(requestUrl.searchParams.getAll('workspacePath')).toEqual([traversalPath]);
    expect(requestUrl.searchParams.getAll('tenantId')).toEqual([TENANT_A]);
    expect(uncertain).toEqual(['HTTP 422']);
  });

  it.each([
    { label: 'empty', workspacePath: '' },
    { label: 'overlong', workspacePath: 'x'.repeat(1025) },
  ])('treats a malformed $label workspace path as uncertain', async ({ workspacePath }) => {
    const uncertain: string[] = [];
    const hook = check({
      tenantIds: [TENANT_A],
      fetchImpl: fakeFetch(() => jsonResponse(422, { error: 'INVALID_SCHEMA' }), log),
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });

    await expect(hook(workspacePath)).resolves.toBe(true);
    expect(new URL(log[0]!.url).searchParams.getAll('workspacePath')).toEqual([workspacePath]);
    expect(uncertain).toEqual(['HTTP 422']);
  });

  it.each(['not-a-uuid', `${TENANT_A}&tenantId=${TENANT_B}`, ''])(
    'treats malformed tenant reference ID %j as uncertain',
    async (tenantId) => {
      const uncertain: string[] = [];
      const hook = check({
        tenantIds: [tenantId],
        fetchImpl: fakeFetch(() => jsonResponse(422, { error: 'INVALID_SCHEMA' }), log),
        onUncertain: (_dir, reason) => uncertain.push(reason),
      });

      await expect(hook('/tmp/workspace')).resolves.toBe(true);
      expect(new URL(log[0]!.url).searchParams.getAll('tenantId')).toEqual([tenantId]);
      expect(uncertain).toEqual(['HTTP 422']);
    }
  );

  it('keeps a stale workspace when its reference lease expires during the query', async () => {
    const stale = await plantStale(root, 'lease-expires-in-flight');
    const uncertain: string[] = [];
    let requestSignal: AbortSignal | undefined;
    const hook = check({
      tenantIds: [TENANT_A],
      timeoutMs: 15,
      fetchImpl: ((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        const onAbort = (): void => reject(new Error('reference lease expired while wiring'));
        if (requestSignal?.aborted) onAbort();
        else requestSignal?.addEventListener('abort', onAbort, { once: true });
      })) as typeof fetch,
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });

    const result = await sweepStaleWorkspaces({ rootDir: root, olderThanMs: 0, hasActiveReference: hook });

    expect(requestSignal?.aborted).toBe(true);
    expect(uncertain[0]).toContain('reference lease expired while wiring');
    expect(result.removed).not.toContain(stale);
    expect(result.kept).toContain(stale);
    expect(existsSync(stale)).toBe(true);
  });

  it('treats a missing workspace root as an empty sweep without querying references', async () => {
    const missingRoot = join(root, 'root-that-does-not-exist');
    let referenceChecks = 0;

    const result = await sweepStaleWorkspaces({
      rootDir: missingRoot,
      olderThanMs: 0,
      hasActiveReference: async () => {
        referenceChecks += 1;
        return false;
      },
    });

    expect(result).toEqual({ removed: [], kept: [] });
    expect(referenceChecks).toBe(0);
    expect(existsSync(missingRoot)).toBe(false);
  });

  it('keeps a stale workspace when reference metadata JSON is corrupt', async () => {
    const stale = await plantStale(root, 'corrupt-reference-metadata');
    const uncertain: string[] = [];
    const hook = check({
      tenantIds: [TENANT_A],
      fetchImpl: fakeFetch(() => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('corrupt reference metadata JSON'); },
      } as unknown as Response), log),
      onUncertain: (_dir, reason) => uncertain.push(reason),
    });

    const result = await sweepStaleWorkspaces({ rootDir: root, olderThanMs: 0, hasActiveReference: hook });

    expect(uncertain[0]).toContain('corrupt reference metadata JSON');
    expect(result.removed).not.toContain(stale);
    expect(result.kept).toContain(stale);
    expect(existsSync(stale)).toBe(true);
  });

  it('sweep integration: hook-protected dir UNTOUCHED while genuine orphan reaped in same pass', async () => {
    const protectedDir = await plantStale(root, 'guarded');
    const orphan = await plantStale(root, 'garbage');
    const result = await sweepStaleWorkspaces({
      rootDir: root,
      hasActiveReference: check({
        tenantIds: [TENANT_A],
        fetchImpl: fakeFetch((url) =>
          url.includes(encodeURIComponent(protectedDir)) || url.includes(protectedDir)
            ? jsonResponse(200, { referenced: true, activeHolders: 2 })
            : jsonResponse(200, { referenced: false, activeHolders: 0 }), log),
      }),
    });
    expect(result.kept).toContain(protectedDir);
    expect(result.removed).toContain(orphan);
    expect(existsSync(protectedDir)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });
});
