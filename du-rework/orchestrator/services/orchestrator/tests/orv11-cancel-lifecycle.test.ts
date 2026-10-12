import { createLifecycleService } from '../src/modules/lifecycle/lifecycle';
import { maybeScheduleWebhook } from '../src/modules/webhooks/webhooks';
import type { Db } from '../src/db/db';
import type { PoolClient } from 'pg';
jest.mock('../src/modules/webhooks/webhooks',()=>({maybeScheduleWebhook:jest.fn(async()=>undefined)}));
function setup(state='RUNNING',tasks:unknown[]=[{state:'RUNNING',lease_active:true}],contended=false){
  const query=jest.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT id, tenant_id'))return {rowCount:1,rows:[{tenant_id:'tenant-a',state}]};
    if(sql.includes('FROM tasks')) {if(contended)throw Object.assign(new Error('locked'),{code:'55P03'});return {rowCount:tasks.length,rows:tasks};}
    return {rowCount:1,rows:[]};
  });
  const client={query} as unknown as PoolClient;
  return {query,client,service:createLifecycleService({} as Db)};
}
beforeEach(()=>jest.clearAllMocks());
test('active provider keeps running lease until SDK cancellation acknowledgement',async()=>{
  const {query,client,service}=setup();
  await expect(service.cancelOperation('op','tenant-a',client)).resolves.toEqual({operationId:'op',state:'CANCEL_REQUESTED',replayed:false});
  expect(query).toHaveBeenCalledWith(expect.stringContaining("state='CANCEL_REQUESTED'"),['op']);
  expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE tasks'))).toBe(false);
  expect(maybeScheduleWebhook).not.toHaveBeenCalled();
});
test('repeated active cancellation does not advance state version again',async()=>{
  const {query,client,service}=setup('CANCEL_REQUESTED');
  await expect(service.cancelOperation('op','tenant-a',client)).resolves.toMatchObject({state:'CANCEL_REQUESTED',replayed:true});
  expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE operations'))).toBe(false);
});
test('paused wait with retained lease timestamp terminalizes and closes waits atomically',async()=>{
  const {query,client,service}=setup('WAITING_INPUT',[{state:'WAITING_INPUT',lease_active:true}]);
  await expect(service.cancelOperation('op','tenant-a',client)).resolves.toMatchObject({state:'CANCELLED',replayed:false});
  expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE human_waits SET status='CANCELLED'"),['op']);
  expect(maybeScheduleWebhook).toHaveBeenCalledWith(client,'op');
});
test('contended task rolls back savepoint, then signals cancellation without deadlock or losing audit transaction',async()=>{
  const {query,client,service}=setup('RUNNING',[],true);
  await expect(service.cancelOperation('op','tenant-a',client)).resolves.toMatchObject({state:'CANCEL_REQUESTED'});
  expect(query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT operation_cancel_tasks');
  expect(query).toHaveBeenCalledWith('RELEASE SAVEPOINT operation_cancel_tasks');
  expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE tasks'))).toBe(false);
});
test('foreign tenant never locks tasks or emits a cancellation',async()=>{
  const {query,client,service}=setup();await expect(service.cancelOperation('op','foreign',client)).rejects.toMatchObject({status:404});expect(query).toHaveBeenCalledTimes(1);
});

test.each(['WAITING_INPUT','RUNNING'])('recovery terminalizes requested %s once lock clears or worker lease expires',async(taskState)=>{
  let state='CANCEL_REQUESTED';let locked=true;
  const query=jest.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT id, tenant_id FROM operations'))return {rowCount:state==='CANCEL_REQUESTED'?1:0,rows:state==='CANCEL_REQUESTED'?[{id:'op',tenant_id:'tenant-a'}]:[]};
    if(sql.startsWith('SELECT id, tenant_id, state'))return {rowCount:1,rows:[{tenant_id:'tenant-a',state}]};
    if(sql.includes('FROM tasks')){if(locked)throw Object.assign(new Error('locked'),{code:'55P03'});return {rowCount:1,rows:[{state:taskState,lease_active:false}]};}
    if(sql.includes("UPDATE operations SET state='CANCELLED'"))state='CANCELLED';
    return {rowCount:1,rows:[]};
  });
  const client={query} as unknown as PoolClient;
  const service=createLifecycleService({tx:async(fn:(c:PoolClient)=>Promise<unknown>)=>fn(client)} as Db);
  expect(await service.sweepCancellations!()).toBe(0);expect(state).toBe('CANCEL_REQUESTED');
  locked=false;expect(await service.sweepCancellations!()).toBe(1);expect(state).toBe('CANCELLED');
  expect(await service.sweepCancellations!()).toBe(0);expect(maybeScheduleWebhook).toHaveBeenCalledTimes(1);
});

test('generic lease recovery rechecks cancellation committed after candidate snapshot before any retry/failure',async()=>{
  const {createRuntimeService}=await import('../src/modules/runtime/runtime');
  const query=jest.fn(async(sql:string)=>{
    if(sql.includes('FROM tasks t'))return {rows:[{id:'task',operation_id:'op',attempt:5,max_attempts:5,lease_epoch:1}],rowCount:1};
    if(sql.startsWith('SELECT state AS op_state'))return {rows:[{op_state:'CANCEL_REQUESTED',cancel_requested:true}],rowCount:1};
    throw new Error(`unexpected mutation: ${sql}`);
  });
  const client={query} as unknown as PoolClient;
  const runtime=createRuntimeService({tx:async(fn:(c:PoolClient)=>Promise<unknown>)=>fn(client)} as Db);
  expect(await runtime.sweepExpiredLeases()).toBe(0);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('NOT COALESCE(o.cancel_requested, false)'),[50]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM operations WHERE id=$1 FOR UPDATE'),['op']);
});
