import { Readable } from 'node:stream';
import { handleInternalOperationsRoutes } from '../src/http/routes/internal-operations';
import type { RouteContext } from '../src/http/route-context';
import { HttpError } from '../src/http/errors';
const tenant='11111111-1111-4111-8111-111111111111', key='22222222-2222-4222-8222-222222222222', artifact='33333333-3333-4333-8333-333333333333';
function context(): RouteContext {
  return { ingressAudience:'internal', method:'POST', pathname:'/api/internal/operations/uploads',
    searchParams:new URLSearchParams({tenantId:tenant,apiKeyId:key,fileName:'test.pdf'}), headers:{authorization:'Bearer admin','content-type':'application/pdf','content-length':'4'},
    config:{adminToken:'admin',maxBlobBytes:8},bodyStream:Readable.from([Buffer.from('file')]),
    db:{query:jest.fn(async()=>({rows:[{id:key}],rowCount:1}))},audit:{record:jest.fn()},
    artifacts:{assertPublicArtifactEncryptionReady:jest.fn(),putPublicArtifact:jest.fn(async()=>({artifactId:artifact,state:'READY'})),cleanupUnlinkedPublicArtifacts:jest.fn(async()=>({deleted:1,deferred:0}))},
  } as unknown as RouteContext;
}
test('encrypted bounded fallback receives trusted selected key and publishes actual file metadata',async()=>{
  const ctx=context(); await expect(handleInternalOperationsRoutes(ctx)).resolves.toMatchObject({status:201,body:{artifactId:artifact,state:'READY',fileName:'test.pdf',sizeBytes:4}});
  expect(ctx.artifacts.putPublicArtifact).toHaveBeenCalledWith({tenantId:tenant,apiKeyId:key,fileName:'test.pdf',mimeType:'application/pdf',bytes:Buffer.from('file'),requireEncryption:true});
});
test.each(['viewer','no-csrf'])('session upload denies %s before body/key read',async(reason)=>{
  const ctx=context();ctx.headers={cookie:`du_session=${'a'.repeat(43)}`,...(reason==='viewer'?{'x-csrf-token':'csrf'}:{})};
  ctx.config.adminSessionStore={get:async()=>({role:reason==='viewer'?'viewer':'operator',tenantId:tenant,csrfToken:'csrf'})};
  await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({status:403});expect(ctx.db.query).not.toHaveBeenCalled();
});
test('tenant credential cannot select another tenant',async()=>{
  const ctx=context();ctx.headers.authorization='Bearer scoped';ctx.config.tenantAdminTokens={scoped:'foreign'};
  await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({status:403});expect(ctx.artifacts.putPublicArtifact).not.toHaveBeenCalled();
});
test('missing active key refuses upload before consuming file',async()=>{
  const ctx=context();jest.mocked(ctx.db.query).mockResolvedValue({rows:[],rowCount:0} as never);
  await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({status:404});expect(ctx.artifacts.putPublicArtifact).not.toHaveBeenCalled();
});
test.each([true,false])('oversize declared/chunked file refuses upload (%s)',async(declared)=>{
  const ctx=context();if(declared)ctx.headers['content-length']='9';else delete ctx.headers['content-length'];ctx.bodyStream=Readable.from([Buffer.alloc(9)]);
  await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({status:413});expect(ctx.artifacts.putPublicArtifact).not.toHaveBeenCalled();
});
test('missing encrypted storage fails closed',async()=>{
  const ctx=context();jest.mocked(ctx.artifacts.assertPublicArtifactEncryptionReady).mockImplementation(()=>{throw new HttpError(503,'TEMPORARY_UNAVAILABLE','unavailable');});
  await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({status:503});expect(ctx.artifacts.putPublicArtifact).not.toHaveBeenCalled();
});
test.each(['../secret.pdf','bad\nname.pdf'])('invalid filename rejected: %s',async(name)=>{
  const ctx=context();ctx.searchParams.set('fileName',name);await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({status:422});expect(ctx.db.query).not.toHaveBeenCalled();
});
test('S3 gateway binds owner before stream, preserves streaming and cleans an aborted upload',async()=>{
  const ctx=context();const order:string[]=[];jest.mocked(ctx.db.query).mockImplementation(async(sql)=>{if(String(sql).includes('upload_api_key_id'))order.push('bind');return {rows:[{id:key}],rowCount:1} as never;});
  ctx.publicUploadGateway={initSingle:jest.fn(async()=>({artifactId:artifact} as never)),upload:jest.fn(async(input)=>{order.push('upload');let count=0;for await(const chunk of input.source)count+=chunk.length;expect(count).toBe(4);throw new Error('storage aborted');}),completeReplay:jest.fn()};
  await expect(handleInternalOperationsRoutes(ctx)).rejects.toThrow('storage aborted');expect(order).toEqual(['bind','upload']);
  expect(ctx.db.query).toHaveBeenCalledWith(expect.stringContaining('upload_api_key_id=$3'),[artifact,tenant,key]);
  expect(ctx.artifacts.cleanupUnlinkedPublicArtifacts).toHaveBeenCalledWith(tenant,[artifact]);
});

test('public gateway initialization scopes replay tokens to authenticated key and binds artifact owner',async()=>{
  const {handlePublicRoutes}=await import('../src/http/routes/public');
  const ctx=context();ctx.pathname='/api/v1/uploads';ctx.headers={'x-api-key':'key-one'};ctx.body={uploadToken:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sizeBytes:4,mimeType:'text/plain'};
  ctx.publicUploadGateway={initSingle:jest.fn(async()=>({artifactId:artifact,replayed:false} as never)),upload:jest.fn(),completeReplay:jest.fn()};
  jest.mocked(ctx.db.query).mockImplementation(async(sql)=>({rows:String(sql).includes('FROM api_keys')?[{id:key,tenant_id:tenant}]:[],rowCount:1}) as never);
  await expect(handlePublicRoutes(ctx)).resolves.toMatchObject({status:201});
  const first=jest.mocked(ctx.publicUploadGateway.initSingle).mock.calls[0]![1] as {uploadToken:string};
  expect(ctx.db.query).toHaveBeenCalledWith(expect.stringContaining('upload_api_key_id=$3'),[artifact,tenant,key]);
  jest.mocked(ctx.db.query).mockImplementation(async(sql)=>({rows:String(sql).includes('FROM api_keys')?[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',tenant_id:tenant}]:[],rowCount:1}) as never);
  await handlePublicRoutes(ctx);
  const second=jest.mocked(ctx.publicUploadGateway.initSingle).mock.calls[1]![1] as {uploadToken:string};
  expect(second.uploadToken).not.toBe(first.uploadToken);
});
test('public upload content rejects an orphan owned by another key before writing bytes',async()=>{
  const {handlePublicRoutes}=await import('../src/http/routes/public');
  const ctx=context();ctx.pathname=`/api/v1/uploads/${artifact}/content`;ctx.method='PUT';ctx.headers={'x-api-key':'foreign'};
  ctx.publicUploadGateway={initSingle:jest.fn(),upload:jest.fn(),completeReplay:jest.fn()};
  jest.mocked(ctx.db.query).mockImplementation(async(sql)=>(String(sql).includes('FROM api_keys')?{rows:[{id:key,tenant_id:tenant}],rowCount:1}:{rows:[],rowCount:0}) as never);
  await expect(handlePublicRoutes(ctx)).rejects.toMatchObject({status:404});expect(ctx.publicUploadGateway.upload).not.toHaveBeenCalled();
});
