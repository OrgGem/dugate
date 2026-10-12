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
  const query=jest.fn().mockResolvedValueOnce({rowCount:1,rows:[{id:'o',tenant_id:'t',state:'FAILED'}]}).mockResolvedValueOnce({rowCount:0,rows:[]}).mockResolvedValueOnce({rowCount:1,rows:[{id:'child',error_code:'INVOCATION_UNKNOWN'}]});
  await expect(retryOperation({query} as any,'o','t')).rejects.toMatchObject({code:'INVOCATION_UNKNOWN'});expect(query).toHaveBeenCalledTimes(3);
});
test('active child retry replay does not execute or recheck spent budget', async () => {
  const query=jest.fn().mockResolvedValueOnce({rowCount:1,rows:[{id:'o',tenant_id:'t',state:'FAILED'}]}).mockResolvedValueOnce({rowCount:1,rows:[{id:'existing',state:'RUNNING'}]});
  await expect(retryOperation({query} as any,'o','t')).resolves.toMatchObject({operationId:'existing',replayed:true});expect(query).toHaveBeenCalledTimes(2);
});
