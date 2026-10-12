import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMIN_AUTH_EXPIRED_EVENT, createAdminApiClient } from '../src/lib/api/client.ts';

describe('Compose client and shared expired-session latch', () => {
  it('latches once across client instances, allows explicit recovery, and fences in-flight mutations', async () => {
    const events = [];
    globalThis.window = { dispatchEvent: (event) => { events.push(event.type); return true; } };

    const calls = [];
    let health401 = false;
    let currentRole = 'admin';
    const sharedFetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init.method, headers: init.headers });
      if (url.endsWith('/health')) {
        return health401
          ? new Response(JSON.stringify({ status: 401, code: 'UNAUTHENTICATED', title: 'expired' }), { status: 401 })
          : new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (url.endsWith('/session')) {
        return new Response(JSON.stringify({
          schemaVersion: '1', plane: currentRole === 'admin' ? 'legacy' : 'oidc', role: currentRole,
          principal: currentRole === 'admin' ? { kind: 'platform', tenantId: null } : { kind: 'tenant_operator', tenantId: 'tenant-new' },
          scope: currentRole === 'admin' ? { kind: 'platform' } : { kind: 'tenant', tenantId: 'tenant-new' },
          displayName: `${currentRole}:admin`, csrfToken: 'csrf-recovered',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ configured: false }), { status: 200 });
    };

    const first = createAdminApiClient({ fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal((await first.getHealth()).status, 0, 'transport failures do not latch authentication');

    const clientA = createAdminApiClient({ fetchImpl: sharedFetch });
    const clientB = createAdminApiClient({ fetchImpl: sharedFetch });
    health401 = true;
    assert.equal((await clientA.getHealth()).status, 401);
    assert.deepEqual(events, [ADMIN_AUTH_EXPIRED_EVENT]);
    const callsAfter401 = calls.length;
    assert.equal((await clientB.getComposeCatalog()).status, 401);
    assert.equal((await clientB.getSession()).status, 401, 'ordinary session polling cannot clear the latch');
    assert.equal(calls.length, callsAfter401, 'other protected calls do not reach the network');

    const recovered = await clientB.getSession({ recoverAuth: true });
    assert.equal(recovered.ok, true);
    health401 = false;
    assert.equal((await clientB.getComposeCatalog()).ok, true, 'successful explicit verification unlocks protected calls');
    assert.equal((await clientB.createComposePreview({
      hostId: 'host-one', projectId: 'project-one', action: 'restart_service', serviceId: 'api', reason: 'Restart service',
    })).ok, true);
    assert.equal((await clientB.submitComposeJob({ previewId: 'b4aa290a-d630-4dfd-a6c0-44e30ffecad2', expectedTargetRevision: 3 }, 'compose-idem-001')).ok, true);
    assert.equal((await clientB.listComposeJobs({ hostId: 'host-one', projectId: 'project-one', limit: 20, cursor: 'abc_123' })).ok, true);
    assert.equal((await clientB.getComposeJob('b4aa290a-d630-4dfd-a6c0-44e30ffecad2')).ok, true);
    assert.deepEqual(calls.slice(-5).map(({ url, method }) => [url, method]), [
      ['/admin/api/compose/catalog', 'GET'],
      ['/admin/api/compose/previews', 'POST'],
      ['/admin/api/compose/jobs', 'POST'],
      ['/admin/api/compose/jobs?hostId=host-one&projectId=project-one&limit=20&cursor=abc_123', 'GET'],
      ['/admin/api/compose/jobs/b4aa290a-d630-4dfd-a6c0-44e30ffecad2', 'GET'],
    ]);
    assert.equal(calls.at(-4).headers['x-csrf-token'], 'csrf-recovered');
    assert.equal(calls.at(-3).headers['x-csrf-token'], 'csrf-recovered');
    assert.equal(calls.at(-3).headers['idempotency-key'], 'compose-idem-001');

    let releaseCsrf;
    let releaseRead;
    const racingCalls = [];
    const racingMutationClient = createAdminApiClient({
      fetchImpl: async (input, init) => {
        const url = String(input);
        racingCalls.push({ url, method: init.method });
        if (url.endsWith('/session')) {
          return await new Promise((resolve) => { releaseCsrf = resolve; });
        }
        return new Response(JSON.stringify({ status: 401, code: 'UNAUTHENTICATED', title: 'expired' }), { status: 401 });
      },
    });
    const delayedReader = createAdminApiClient({
      fetchImpl: async () => await new Promise((resolve) => { releaseRead = resolve; }),
    });
    const mutation = racingMutationClient.createComposePreview({
      hostId: 'local', projectId: 'platform', action: 'restart_service', serviceId: 'api', reason: 'Routine restart',
    });
    const pendingRead = delayedReader.getHealth();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof releaseCsrf, 'function');
    assert.equal(typeof releaseRead, 'function');
    health401 = true;
    assert.equal((await clientA.getHealth()).status, 401, 'a concurrent protected 401 expires the shared session');
    releaseCsrf(new Response(JSON.stringify({ csrfToken: 'stale-csrf' }), { status: 200 }));
    assert.equal((await mutation).status, 401);
    assert.deepEqual(racingCalls.map((call) => call.url), ['/admin/api/session'], 'the pending mutation is never sent after expiry');
    releaseRead(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    assert.equal((await pendingRead).status, 401, 'a late successful response cannot restore data after a concurrent 401');
    currentRole = 'operator';
    const changedScope = await clientB.getSession({ recoverAuth: true });
    assert.equal(changedScope.ok, false);
    assert.equal(changedScope.status, 409);
    assert.equal(changedScope.problem.code, 'SESSION_CHANGED');
    const callsAfterScopeChange = calls.length;
    assert.equal((await clientA.getComposeCatalog()).status, 401, 'a changed role or tenant stays latched until reload');
    assert.equal(calls.length, callsAfterScopeChange);
    assert.deepEqual(events, [ADMIN_AUTH_EXPIRED_EVENT, ADMIN_AUTH_EXPIRED_EVENT], 'each expired-session cycle emits one event');
  });
});
