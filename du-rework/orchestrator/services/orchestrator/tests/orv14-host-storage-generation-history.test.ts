import { createStorageGenerationService } from '../src/modules/artifacts/storage-generations';

describe('ORV14 Host storage generation history', () => {
  it('returns immutable generations newest first with opaque pinned credential references only', async () => {
    const rows = [
      {generation_id:'22222222-2222-4222-8222-222222222222',revision:2,backend:'s3',endpoint:'https://storage.invalid',bucket:'bucket-b',region:'us-east-1',
        force_path_style:true,credential_version_ref:'33333333-3333-4333-8333-333333333333@2',credential_owner_tenant_id:'11111111-1111-4111-8111-111111111111',
        url_ttl_seconds:900,state:'STAGED',tested_at:null,test_result:null,activated_at:null,control_revision:7},
      {generation_id:'44444444-4444-4444-8444-444444444444',revision:1,backend:'postgres',endpoint:'postgres://internal',bucket:'',region:'local',
        force_path_style:false,credential_version_ref:null,credential_owner_tenant_id:null,url_ttl_seconds:null,state:'RETIRED',
        tested_at:null,test_result:null,activated_at:new Date('2026-10-01T00:00:00.000Z'),control_revision:7},
    ];
    const query = jest.fn(async () => ({rows,rowCount:rows.length}));
    const service = createStorageGenerationService({
      db:{query} as never,
      audit:{record:jest.fn()} as never,
      resolveFacade:jest.fn(() => ({} as never)),
    });

    const result = await service.listGenerations();

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY g.revision DESC,g.generation_id'));
    expect(result.map((item)=>item.generationId)).toEqual(rows.map((row)=>row.generation_id));
    expect(result.map((item)=>item.revision)).toEqual([2,1]);
    expect(result[0]).toMatchObject({state:'STAGED',secretPresent:true,controlRevision:7,
      credentialVersionRef:'33333333-3333-4333-8333-333333333333@2'});
    expect(JSON.stringify(result)).not.toContain('fake-secret-bytes');
  });

  it('fails closed when no trusted boot generation has been seeded', async () => {
    const service = createStorageGenerationService({
      db:{query:jest.fn(async () => ({rows:[],rowCount:0}))} as never,
      audit:{record:jest.fn()} as never,
      resolveFacade:jest.fn(() => ({} as never)),
    });
    await expect(service.listGenerations()).rejects.toThrow('storage generation has not been initialized');
  });
});
