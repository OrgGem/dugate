import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {S3Client,CreateBucketCommand,PutBucketVersioningCommand,GetObjectCommand,PutObjectCommand,ListObjectVersionsCommand,DeleteObjectCommand,DeleteBucketCommand} from '@aws-sdk/client-s3';
import {createApp,type App} from '../../orchestrator/services/orchestrator/src/server';
import {createDb} from '../../orchestrator/services/orchestrator/src/db/db';
import {createWorkflowApiIsolation,syntheticMetadataKeyProvider} from './isolation';
const isolation=createWorkflowApiIsolation(),baseDb=createDb(isolation.baseDatabaseUrl);
const tenant=randomUUID(),otherTenant=randomUUID(),token=randomUUID(),key=`orv12-${randomUUID()}`,foreignKey=`orv12-${randomUUID()}`;
const bucket=`orv12-${randomUUID()}`;
const endpoint='http://127.0.0.1:59098';
const s3=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'orv12-synthetic',secretAccessKey:'orv12-synthetic-only'}});
let app:App|undefined,internalUrl='',publicUrl='',keyId='',schema=false,createdBucket=false;
beforeAll(async()=>{
 process.env.DU_SEED_DEV_FALLBACK='false';process.env.AWS_ACCESS_KEY_ID='orv12-synthetic';process.env.AWS_SECRET_ACCESS_KEY='orv12-synthetic-only';
 await s3.send(new CreateBucketCommand({Bucket:bucket}));createdBucket=true;await s3.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}));
 await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);schema=true;
 const provider=syntheticMetadataKeyProvider();
 app=await createApp({host:'127.0.0.1',port:0,internalHost:'127.0.0.1',internalPort:0,databaseUrl:isolation.databaseUrl,redisUrl:isolation.redisUrl,autoMigrate:true,autoDispatch:false,leaseRecoveryIntervalMs:0,adminToken:token,artifactStorage:{backend:'s3',bucket,region:'us-east-1',endpoint,forcePathStyle:true},publicUploadEncryption:{keyProvider:provider,keyRef:'orv12-artifact'},metadataEncryption:{keyProvider:provider,keyRef:'orv12-metadata'}});
 const server=await app.listen();publicUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;internalUrl=`http://127.0.0.1:${(app.internalServer.address() as AddressInfo).port}`;
 await app.db.query('INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)',[tenant,'ORV12 S3',otherTenant,'ORV12 foreign']);
 for(const [raw,t] of [[key,tenant],[foreignKey,tenant]]){const r=await app.db.query('INSERT INTO api_keys(tenant_id,hash,prefix,status) VALUES($1,$2,$3,$4) RETURNING id',[t,createHash('sha256').update(raw!).digest('hex'),'orv12','ACTIVE']);if(raw===key)keyId=r.rows[0].id;}
},120000);
afterAll(async()=>{await app?.close({timeoutMs:0,pollIntervalMs:10});if(schema)await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);await baseDb.close();if(createdBucket){const versions=await s3.send(new ListObjectVersionsCommand({Bucket:bucket}));for(const obj of [...versions.Versions??[],...versions.DeleteMarkers??[]])await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:obj.Key,VersionId:obj.VersionId}));await s3.send(new DeleteBucketCommand({Bucket:bucket}));}s3.destroy();isolation.context.cleanupArtifactDir();},30000);
test('real HTTP internal upload encrypts versioned S3 object; public owned read restores bytes and other key is denied',async()=>{
 const plaintext=Buffer.from('ORV12_PRIVATE_S3_SENTINEL\n'.repeat(4096));
 const response=await fetch(`${internalUrl}/api/internal/operations/uploads?tenantId=${tenant}&apiKeyId=${keyId}&fileName=orv12.txt`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'text/plain'},body:plaintext});
 const body=await response.json() as {artifactId:string};if(response.status!==201)throw new Error(`upload ${response.status} ${JSON.stringify(body)}`);
 const result=await app!.db.query('SELECT * FROM artifacts WHERE id=$1',[body.artifactId]);const row=result.rows[0];expect(row.storage_backend).toBe('s3');expect(row.upload_api_key_id).toBe(keyId);expect(row.state).toBe('READY');expect(row.storage_version_id).toBeTruthy();expect(row.manifest_version_id).toBeTruthy();
 const stored=await s3.send(new GetObjectCommand({Bucket:bucket,Key:row.object_key??row.storage_key,VersionId:row.storage_version_id}));const ciphertext=Buffer.from(await stored.Body!.transformToByteArray());expect(ciphertext.includes(Buffer.from('ORV12_PRIVATE_S3_SENTINEL'))).toBe(false);expect(ciphertext.equals(plaintext)).toBe(false);
 const op=randomUUID();await app!.db.query(`INSERT INTO operations(id,tenant_id,api_key_id,business_id,business_version,action,state,correlation_id,submit_artifacts) VALUES($1,$2,$3,'document-core','1.0.0','extract','SUCCEEDED','orv12-s3',$4)`,[op,tenant,keyId,JSON.stringify([{artifactId:body.artifactId,role:'input'}])]);
 const read=await fetch(`${publicUrl}/api/v1/artifacts/${body.artifactId}/download`,{headers:{'x-api-key':key}});if(read.status!==200)throw new Error(`S3 read ${read.status}: ${await read.text()}`);expect(Buffer.from(await read.arrayBuffer()).equals(plaintext)).toBe(true);
 expect((await fetch(`${publicUrl}/api/v1/artifacts/${body.artifactId}/download`,{headers:{'x-api-key':foreignKey}})).status).toBe(404);
 await s3.send(new PutObjectCommand({Bucket:bucket,Key:row.storage_key,Body:Buffer.from('orv12-newest-version-not-pinned')}));
 const pinned=await fetch(`${publicUrl}/api/v1/artifacts/${body.artifactId}/download`,{headers:{'x-api-key':key}});expect(pinned.status).toBe(200);expect(Buffer.from(await pinned.arrayBuffer()).equals(plaintext)).toBe(true);
 const rejected:Record<string,{status:number;body:string}>={};
 for(const [column,badValue] of [['sha256','0'.repeat(64)],['manifest_version_id',randomUUID()],['storage_version_id',randomUUID()]]){
  await app!.db.query(`UPDATE artifacts SET ${column}=$2 WHERE id=$1`,[body.artifactId,badValue]);
  try{const denied=await fetch(`${publicUrl}/api/v1/artifacts/${body.artifactId}/download`,{headers:{'x-api-key':key}});const bodyText=await denied.text();expect(denied.status).toBe(column==='sha256'?503:column==='manifest_version_id'?500:404);expect(bodyText).not.toContain('ORV12_PRIVATE_S3_SENTINEL');expect(bodyText).not.toMatch(/NoSuchVersion|stack|orv12-synthetic-only/);rejected[column!]={status:denied.status,body:bodyText};}finally{await app!.db.query(`UPDATE artifacts SET ${column}=$2 WHERE id=$1`,[body.artifactId,row[column!]]);}
 }
 mkdirSync(resolve('reports/raw/orv12/storage'),{recursive:true});writeFileSync(resolve('reports/raw/orv12/storage/s3-receipt.json'),JSON.stringify({implementation:'Moto 5.1.12 local S3 HTTP emulator; versioning enabled, not cloud IAM',uploadStatus:201,downloadStatus:200,otherKeyStatus:404,plaintextSha256:createHash('sha256').update(plaintext).digest('hex'),ciphertextSha256:createHash('sha256').update(ciphertext).digest('hex'),pinnedObjectVersion:row.storage_version_id,pinnedManifestVersion:row.manifest_version_id,newerVersionIgnored:true,tamperedHashAndVersion:rejected},null,2));

},30000);
