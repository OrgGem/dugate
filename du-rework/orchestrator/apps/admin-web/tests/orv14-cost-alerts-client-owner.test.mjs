import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminApiClient } from '../src/lib/api/client.ts';

describe('ORV14 cost alert Admin client', () => {
  it('uses the same-origin BFF, session CSRF and idempotency transport for owner routing', async () => {
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = String(input);
      const headers = init.headers ?? {};
      calls.push({ url, method: init.method, headers, credentials: init.credentials, body: init.body });
      if (url === '/admin/api/session') {
        return new Response(JSON.stringify({
          schemaVersion: '1', plane: 'oidc', role: 'admin',
          principal: { kind: 'platform', tenantId: null },
          scope: { kind: 'platform' }, displayName: 'Local Admin', localUser: false, csrfToken: 'csrf-cost-alerts',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const client = createAdminApiClient({ fetchImpl });

    assert.equal((await client.getSession()).ok, true);
    await client.listCostAlertChannels('tenant-one');
    await client.getCostPolicyScopeCatalog('tenant-one', {
      kind: 'profiles', q: 'invoice tool', limit: 50, cursor: 'nextPageToken',
      apiKeyId: '44444444-4444-4444-8444-444444444444',
    });
    await client.getCostBudgetAlertBinding('tenant-one', '11111111-1111-4111-8111-111111111111', 7);
    await client.saveCostBudgetAlertBinding({
      tenantId: 'tenant-one', budgetId: '11111111-1111-4111-8111-111111111111', budgetRevision: 7,
      expectedBindingRevision: 0, ownerUserId: '22222222-2222-4222-8222-222222222222',
      channels: [{ channelId: 'tenant-admin-inbox-v1', channelRevision: 1 }],
    }, 'cost-alert-binding-001');
    await client.listCostAlerts({ tenantId: 'tenant-one', limit: 20, budgetId: '11111111-1111-4111-8111-111111111111', kind: 'trust_gap' });
    await client.listCostAlertRecipients({ tenantId: 'tenant-one', q: 'external', limit: 25, cursor: 'recipient-next' });
    await client.ensureCostAlertSelfRecipient();
    await client.transitionCostAlertRecipient('55555555-5555-4555-8555-555555555555', {
      expectedAuthorizationVersion: 4, action: 'disable', reason: 'Recipient access review',
    }, 'cost-alert-recipient-001');
    await client.listCostAlertInbox({ tenantId: 'tenant-one', limit: 10, unreadOnly: true });
    await client.markCostAlertInboxRead('33333333-3333-4333-8333-333333333333', 'tenant-one');

    const routeCalls = calls.filter((call) => !call.url.endsWith('/session'));
    assert.deepEqual(routeCalls.map(({ url, method }) => [url, method]), [
      ['/admin/api/cost-alerts/channels?tenantId=tenant-one', 'GET'],
      ['/admin/api/cost-alerts/scope-catalog?tenantId=tenant-one&kind=profiles&q=invoice+tool&limit=50&cursor=nextPageToken&apiKeyId=44444444-4444-4444-8444-444444444444', 'GET'],
      ['/admin/api/cost-alerts/bindings/11111111-1111-4111-8111-111111111111?tenantId=tenant-one&budgetRevision=7', 'GET'],
      ['/admin/api/cost-alerts/bindings', 'PUT'],
      ['/admin/api/cost-alerts?tenantId=tenant-one&limit=20&budgetId=11111111-1111-4111-8111-111111111111&kind=trust_gap', 'GET'],
      ['/admin/api/cost-alerts/recipients?tenantId=tenant-one&q=external&limit=25&cursor=recipient-next', 'GET'],
      ['/admin/api/cost-alerts/recipients/self', 'POST'],
      ['/admin/api/cost-alerts/recipients/55555555-5555-4555-8555-555555555555/lifecycle', 'POST'],
      ['/admin/api/cost-alerts/inbox?tenantId=tenant-one&limit=10&unreadOnly=true', 'GET'],
      ['/admin/api/cost-alerts/inbox/33333333-3333-4333-8333-333333333333/read', 'POST'],
    ]);
    for (const call of calls) {
      assert.equal(call.credentials, 'same-origin');
      assert.equal(Object.keys(call.headers).some((key) => key.toLowerCase() === 'authorization'), false);
    }
    assert.equal(routeCalls[3].headers['x-csrf-token'], 'csrf-cost-alerts');
    assert.equal(routeCalls[6].headers['x-csrf-token'], 'csrf-cost-alerts');
    assert.equal(routeCalls[3].headers['idempotency-key'], 'cost-alert-binding-001');
    assert.equal(routeCalls[3].body, JSON.stringify({
      tenantId: 'tenant-one', budgetId: '11111111-1111-4111-8111-111111111111', budgetRevision: 7,
      expectedBindingRevision: 0, ownerUserId: '22222222-2222-4222-8222-222222222222',
      channels: [{ channelId: 'tenant-admin-inbox-v1', channelRevision: 1 }],
    }));
    assert.equal(routeCalls[6].body, '{}');
    assert.equal(routeCalls[7].headers['x-csrf-token'], 'csrf-cost-alerts');
    assert.equal(routeCalls[7].headers['idempotency-key'], 'cost-alert-recipient-001');
    assert.equal(routeCalls[9].headers['x-csrf-token'], 'csrf-cost-alerts');
    assert.equal(routeCalls[9].body, JSON.stringify({ tenantId: 'tenant-one' }));
  });
});
