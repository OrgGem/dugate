import { lcCheckerManifest } from '../src/manifest';
import { buildRegistrationDryRun, expectedQueue, registerLcCheckerWorker } from '../src/registry-tool';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
}

function fakeFetch(statuses: readonly number[]): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method ?? 'GET', authorization: headers['authorization'] ?? '' });
    const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
    index += 1;
    return {
      status,
      json: async () => ({ queue: 'du-business-lc-checker-1.0.0' }),
      text: async () => 'detail',
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('P9-02 worker registration', () => {
  it('derives the queue from the manifest identity', () => {
    expect(expectedQueue()).toBe('du-business-lc-checker-1.0.0');
  });

  it('walks register -> enable -> activate in order, with the right token on each hop', async () => {
    const { fetchFn, calls } = fakeFetch([201, 200, 202]);
    const result = await registerLcCheckerWorker({
      orchestratorUrl: 'http://orchestrator:3000/',
      runtimeToken: 'rt-test',
      adminToken: 'adm-test',
      fetchFn,
    });
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'PUT', 'PUT']);
    expect(calls[0]?.url).toBe('http://orchestrator:3000/api/runtime/v1/businesses/lc-checker/versions/1.0.0');
    expect(calls[0]?.authorization).toBe('Bearer rt-test');
    expect(calls[1]?.authorization).toBe('Bearer adm-test');
    expect(result).toMatchObject({ registered: true, enabled: true, activated: true, queue: 'du-business-lc-checker-1.0.0' });
    expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('stops at enable when activation is refused, and does not report success', async () => {
    const { fetchFn } = fakeFetch([201, 200, 500]);
    await expect(
      registerLcCheckerWorker({
        orchestratorUrl: 'http://orchestrator:3000',
        runtimeToken: 'rt-test',
        adminToken: 'adm-test',
        fetchFn,
      })
    ).rejects.toThrow('Worker activation failed (HTTP 500): detail');
  });

  it('does not activate when activation is explicitly skipped', async () => {
    const { fetchFn, calls } = fakeFetch([200, 200]);
    const result = await registerLcCheckerWorker({
      orchestratorUrl: 'http://orchestrator:3000',
      runtimeToken: 'rt-test',
      adminToken: 'adm-test',
      activate: false,
      fetchFn,
    });
    expect(calls).toHaveLength(2);
    expect(result.activated).toBe(false);
  });

  it('fails loudly when the manifest is refused', async () => {
    const { fetchFn } = fakeFetch([409]);
    await expect(
      registerLcCheckerWorker({
        orchestratorUrl: 'http://orchestrator:3000',
        runtimeToken: 'rt-test',
        adminToken: 'adm-test',
        fetchFn,
      })
    ).rejects.toThrow('Worker manifest registration failed (HTTP 409)');
  });

  it('produces a dry run with no network I/O and no invented platform digests', () => {
    const plan = buildRegistrationDryRun();
    expect(plan.businessId).toBe('lc-checker');
    expect([...plan.connectorSlots].sort()).toEqual(['crosscheck', 'ocr', 'report', 'vision']);
    expect(plan.handlerKinds).toEqual(['lc-checker', 'lc-checker-ocr', 'lc-checker-visual', 'root']);
    expect(plan.registrationSteps.map((step) => step.step)).toEqual([1, 2, 3]);
    expect(JSON.stringify(plan)).not.toContain('frozenPlatformDigests');
    expect(plan.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.queue).toBe(expectedQueue(lcCheckerManifest));
  });
});
