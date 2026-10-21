import { listAdminDeliveries, retryAdminDelivery } from '../src/modules/webhooks/admin-delivery';
import { retryOperation } from '../src/modules/operations/retry';
const caps = { dispatcherConfigured: true, authResolverConfigured: false };
const row = { delivery_id:'d',status:'FAILED',attempts:5,max_attempts:5,callback_policy:null,last_error:'https://secret.invalid/token',next_at:null };
const input = { deliveryId:'d',operationId:'o',tenantId:'t',expectedAttempts:5 };
test('callback read redacts arbitrary failure text', async () => {
  const query=jest.fn().mockResolvedValueOnce({rowCount:1,rows:[{}]}).mockResolvedValueOnce({rowCount:1,rows:[row]});
  const result=await listAdminDeliveries({query} as any,'o','t',caps);
  expect(result.items[0]).toMatchObject({lastError:'DELIVERY_FAILED',canRetry:true});
});
test.each(['PENDING','DISPATCHING','DELIVERED'])('callback cannot replay %s', async status => {
  const query=jest.fn().mockResolvedValue({rowCount:1,rows:[{...row,status}]});
  await expect(retryAdminDelivery({query} as any,input,caps)).rejects.toMatchObject({code:'CALLBACK_RETRY_BLOCKED'});expect(query).toHaveBeenCalledTimes(1);
});
test('callback refuses stale attempts, invalid pin, exhausted cap and absent dispatch', async () => {
  for(const [changed, capability] of [[{attempts:6},caps],[{callback_policy:{invalid:true}},caps],[{attempts:10,max_attempts:10},caps],[{}, {...caps,dispatcherConfigured:false}]] as const) {
    const query=jest.fn().mockResolvedValue({rowCount:1,rows:[{...row,...changed}]});
    await expect(retryAdminDelivery({query} as any,{...input,expectedAttempts:changed.attempts===10?10:5},capability)).rejects.toBeDefined();expect(query).toHaveBeenCalledTimes(1);
  }
});
test('fresh operation retry blocks unknown outcome on any child before write', async () => {
  // PC-07: reauthorization runs FIRST (api key lookup + spend admission).
  // PC-R03: the unlocked coalescing read is gone, so the child scan is now the
  // very next read and an uncertain child blocks the retry before any write.
  const op = { id: 'o', tenant_id: 't', state: 'FAILED', api_key_id: 'k' };
  const query=jest.fn()
    .mockResolvedValueOnce({rowCount:1,rows:[op]})
    .mockResolvedValueOnce({rowCount:1,rows:[{id:'k',tenant_id:'t',status:'ACTIVE',key_mode:'LEGACY_STANDALONE'}]})
    // spend admission = billing row + usage-event scan (readKeySpend).
    .mockResolvedValueOnce({rowCount:1,rows:[{name:'key',spending_limit:'0',total_used:'0',tenant_id:'t'}]})
    .mockResolvedValueOnce({rowCount:0,rows:[]})
    .mockResolvedValueOnce({rowCount:1,rows:[{id:'child',error_code:'INVOCATION_UNKNOWN'}]});
  await expect(retryOperation({query} as any,'o','t')).rejects.toMatchObject({code:'INVOCATION_UNKNOWN'});
  expect(query).toHaveBeenCalledTimes(5);
  expect(query.mock.calls.some((call)=>String(call[0]).includes('INSERT INTO'))).toBe(false);
});
test('reauthorizes before the coalesced replay read (PC-07/PC-R03)', async () => {
  // Authority is rechecked BEFORE any coalesced-replay read, so a revoked key
  // can never be acknowledged as "replayed" and cannot learn whether a sibling
  // execution exists. Nothing is executed. (The success-path replay return —
  // replayed:true after the locked reauthorization — is asserted in
  // profile-control-plane-retry.test.ts, whose SQL-routing harness drives the
  // full PC-R03 lock chain; this file only owns the ordering guarantee.)
  const op = { id: 'o', tenant_id: 't', state: 'FAILED', api_key_id: 'k' };
  const query=jest.fn()
    .mockResolvedValueOnce({rowCount:1,rows:[op]})
    .mockResolvedValueOnce({rowCount:1,rows:[{id:'k',tenant_id:'t',status:'REVOKED',key_mode:'LEGACY_STANDALONE'}]});
  await expect(retryOperation({query} as any,'o','t')).rejects.toMatchObject({code:'API_KEY_REVOKED'});
  expect(query.mock.calls.some((call)=>String(call[0]).includes('retry_of'))).toBe(false);
});
