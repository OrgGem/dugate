import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminApiClient } from '../src/lib/api/client.ts';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('profile group and business lifecycle API client', () => {
  it('uses the same-origin BFF routes and CSRF proof for every mutation', async () => {
    const calls = [];
    const client = createAdminApiClient({
      basePath: '/admin/api',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init.method, body: init.body, headers: init.headers });
        if (url === '/admin/api/session') return jsonResponse({
          schemaVersion: '1', plane: 'oidc', role: 'admin', principal: { kind: 'platform', tenantId: null },
          scope: { kind: 'platform' }, displayName: 'Test admin', localUser: false, csrfToken: 'csrf-proof',
        });
        if (init.method === 'GET') return jsonResponse({ groups: [] });
        return jsonResponse({ accepted: true });
      },
    });

    await client.getSession();
    await client.setBusinessEnabled('document-core', { enabled: false, expectedLifecycleRevision: 8 });
    await client.getBusinessFunctionCatalog('document-core', '1.4.0');
    await client.listProfileGroups('11111111-1111-4111-8111-111111111111');
    await client.getProfileGroup('22222222-2222-4222-8222-222222222222');
    const body = {
      name: 'Documents and claims',
      apiKey: { apiKeyId: '33333333-3333-4333-8333-333333333333' },
      expectedRevision: 0,
      businesses: [{
        businessId: 'document-core', businessVersion: '1.4.0', manifestDigest: 'digest',
        functions: [{ kind: 'endpoint', functionId: 'core:extract:invoice', action: 'extract', endpointSlug: 'extract.invoice', policy: {}, connectorBindings: {} }],
      }],
    };
    await client.createProfileGroup(body);
    await client.replaceProfileGroup('22222222-2222-4222-8222-222222222222', { ...body, expectedRevision: 1 });
    await client.rollbackProfileGroup('22222222-2222-4222-8222-222222222222', { expectedRevision: 2, targetRevision: 1 });

    assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
      ['GET', '/admin/api/session'],
      ['PUT', '/admin/api/businesses/document-core/enabled'],
      ['GET', '/admin/api/profile-groups/v2/catalog?businessId=document-core&businessVersion=1.4.0'],
      ['GET', '/admin/api/profile-groups?tenantId=11111111-1111-4111-8111-111111111111'],
      ['GET', '/admin/api/profile-groups/22222222-2222-4222-8222-222222222222'],
      ['POST', '/admin/api/profile-groups'],
      ['PUT', '/admin/api/profile-groups/22222222-2222-4222-8222-222222222222'],
      ['POST', '/admin/api/profile-groups/22222222-2222-4222-8222-222222222222/rollback'],
    ]);
    assert.deepEqual(JSON.parse(calls[1].body), { enabled: false, expectedLifecycleRevision: 8 });
    for (const call of calls.filter(({ method }) => method === 'PUT' || method === 'POST')) {
      assert.equal(call.headers['x-csrf-token'], 'csrf-proof');
    }
    assert.deepEqual(JSON.parse(calls[5].body), body);
    assert.equal(JSON.parse(calls[6].body).expectedRevision, 1);
    assert.deepEqual(JSON.parse(calls[7].body), { expectedRevision: 2, targetRevision: 1 });
  });
});
