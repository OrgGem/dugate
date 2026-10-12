import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { canonicalPayloadHash } from '../idempotency/idempotency';
import type { MetadataCrypto } from '../runtime/metadata-crypto';
import { compatibilityMetadataReader, type MetadataReader } from '../encryption/metadata-read-policy';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import { openPrompt, sealPrompt } from './prompt-crypto';
import { CORE_ENDPOINTS } from './endpoints';

const PinSchema=z.object({connectorId:z.string().min(1).max(128),revision:z.number().int().positive()}).strict();
const PromptSchema=z.object({connectionId:z.string().uuid(),stepId:z.literal('_default'),promptOverride:z.string().max(32768).nullable()}).strict();
export const SettingsScopeSchema=z.object({tenantId:z.string().uuid(),apiKeyId:z.string().uuid(),endpointSlug:z.string().min(1).max(128)});
export const SettingsChangesSchema=z.object({connectorBindings:z.record(PinSchema).optional(),prompts:z.array(PromptSchema).max(32).optional()}).strict();
const CreateSchema=SettingsScopeSchema.extend({expectedActiveRevision:z.number().int().nonnegative().nullable(),changes:SettingsChangesSchema,expectedProfileRevision:z.number().int().positive().optional()}).strict();
const RevisionSchema=SettingsScopeSchema.extend({revision:z.number().int().nonnegative()}).strict();
const ApplySchema=RevisionSchema.extend({expectedActiveRevision:z.number().int().nonnegative().nullable()}).strict();
export const ValidationSchema=z.object({valid:z.boolean(),issues:z.array(z.object({code:z.string(),message:z.string()})),checks:z.array(z.string())});
const SummarySchema=z.object({revision:z.number().int().nonnegative(),state:z.enum(['DRAFT','VALIDATED','APPLIED']),baseActiveRevision:z.number().nullable(),baseProfileRevision:z.number(),createdAt:z.string(),appliedAt:z.string().nullable(),restoresRevision:z.number().nullable()});
export const SettingsRevisionDetailSchema=SummarySchema.extend({changes:SettingsChangesSchema,diff:z.array(z.object({path:z.string(),before:z.unknown(),after:z.unknown()})),validation:ValidationSchema.nullable()});
export const SettingsConfigurationSchema=z.object({activeRevision:z.number().nullable(),activeRevisionMatchesEffective:z.boolean(),historyLimit:z.literal(20),profile:z.object({profileId:z.string(),revision:z.number(),connectorBindings:z.record(PinSchema),activeKeyCount:z.number()}).nullable(),revisions:z.array(SummarySchema),selectedRevision:SettingsRevisionDetailSchema.optional()});
type Scope=z.infer<typeof SettingsScopeSchema>;
type Changes=z.infer<typeof SettingsChangesSchema>;
type Prompt=z.infer<typeof PromptSchema> & {updatedAt:string|null};
type Snapshot={profileEndpointSlug:string|null;profileId:string;profileRevision:number;connectorBindings:Record<string,z.infer<typeof PinSchema>>;prompts:Prompt[];activeKeyCount:number};
type Payload={base:Snapshot;next:Snapshot;changes:Changes};
interface RevisionRow {stream_id:string;revision:number;state:'DRAFT'|'VALIDATED'|'APPLIED';base_active_revision:number|null;base_profile_revision:number;payload_ref:unknown;content_digest:string;validation:z.infer<typeof ValidationSchema>|null;created_at:Date|string;applied_at:Date|string|null;restores_revision:number|null;applied_fingerprint:string|null}
export interface SettingsRevisionDeps {metadataCrypto?:MetadataCrypto;metadataReader?:MetadataReader;connectorManagement?:ConnectorManagementStore}
type Queryable=Pick<Db,'query'>;
function invalid(message:string):never {throw new HttpError(422,'INVALID_SCHEMA',message);}
function conflict(message:string):never {throw new HttpError(409,'STATE_CONFLICT',message);}
function parse<T>(schema:z.ZodType<T>,input:unknown):T {const result=schema.safeParse(input);if(!result.success)invalid('invalid settings revision request');return result.data;}
function scopeParams(p:Scope){return [p.tenantId,p.apiKeyId,p.endpointSlug];}
function requireCrypto(deps:SettingsRevisionDeps):MetadataCrypto {if(!deps.metadataCrypto)throw new HttpError(503,'TEMPORARY_UNAVAILABLE','settings revisions require metadata encryption');return deps.metadataCrypto;}
function context(p:Scope,streamId:string,revision:number){return {tenantId:p.tenantId,slot:'settings_revisions.payload_ref' as const,refId:`${streamId}:${revision}`};}
function fingerprint(snapshot:Snapshot){return canonicalPayloadHash(snapshot);}
function iso(value:Date|string){return value instanceof Date?value.toISOString():new Date(value).toISOString();}
function summary(row:RevisionRow){return {revision:row.revision,state:row.state,baseActiveRevision:row.base_active_revision,baseProfileRevision:row.base_profile_revision,createdAt:iso(row.created_at),appliedAt:row.applied_at?iso(row.applied_at):null,restoresRevision:row.restores_revision};}
function diffs(payload:Payload){
 const result:{path:string;before:unknown;after:unknown}[]=[];
 for(const slot of new Set([...Object.keys(payload.base.connectorBindings),...Object.keys(payload.next.connectorBindings)])){
  const before=payload.base.connectorBindings[slot]??null,after=payload.next.connectorBindings[slot]??null;
  if(canonicalPayloadHash(before)!==canonicalPayloadHash(after))result.push({path:`connectorBindings.${slot}`,before,after});
 }
 const key=(p:Prompt)=>`${p.connectionId}:${p.stepId}`;
 const before=new Map(payload.base.prompts.map(p=>[key(p),p.promptOverride]));const after=new Map(payload.next.prompts.map(p=>[key(p),p.promptOverride]));
 for(const k of new Set([...before.keys(),...after.keys()]))if(before.get(k)!==after.get(k))result.push({path:`prompts.${k}`,before:before.get(k)??null,after:after.get(k)??null});
 return result;
}
async function opened(row:RevisionRow,p:Scope,deps:SettingsRevisionDeps):Promise<Payload>{
 const value=await (deps.metadataReader??compatibilityMetadataReader(deps.metadataCrypto)).readStored(row.payload_ref,context(p,row.stream_id,row.revision));
 const payload=value as Payload;
 if(!payload||canonicalPayloadHash(payload)!==row.content_digest)throw new HttpError(503,'TEMPORARY_UNAVAILABLE','settings revision integrity check failed');
 return payload;
}
async function detail(row:RevisionRow,p:Scope,deps:SettingsRevisionDeps){const payload=await opened(row,p,deps);return {...summary(row),changes:payload.changes,diff:diffs(payload),validation:row.validation};}
async function snapshot(db:Queryable,p:Scope,deps:SettingsRevisionDeps,lock=false):Promise<Snapshot>{
 if(!CORE_ENDPOINTS.has(p.endpointSlug))invalid('settings revisions support core document endpoints; workflow definitions use workflow revisions');
 const key=await db.query(`SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'${lock?' FOR UPDATE':''}`,[p.apiKeyId,p.tenantId]);
 if(!key.rowCount)throw new HttpError(404,'NOT_FOUND','active API key not found in tenant');
 const target=await db.query(`SELECT p.profile_id,p.revision,p.connector_bindings,p.enabled,p.endpoint_slug FROM profile_active_revisions a
 JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
 JOIN profile_api_keys m ON m.profile_id=p.profile_id AND m.api_key_id=$1 AND m.state='ACTIVE' AND m.tenant_id=p.tenant_id
 JOIN business_versions b ON b.business_id=p.business_id AND b.version=p.business_version AND b.is_active=true
 WHERE p.tenant_id=$2 AND p.business_id='document-core' AND p.action=$3 AND (p.endpoint_slug IS NULL OR p.endpoint_slug=$4)
 ORDER BY (p.endpoint_slug IS NOT NULL) DESC,a.moved_at DESC,p.profile_id LIMIT 1${lock?' FOR UPDATE OF a':''}`,[p.apiKeyId,p.tenantId,p.endpointSlug.split(':')[0],p.endpointSlug]);
 const row=target.rows[0];if(!row)throw new HttpError(404,'NOT_FOUND','active profile mapping not found');if(row.enabled===false)invalid('active profile is disabled');
 const members=await db.query("SELECT api_key_id FROM profile_api_keys WHERE profile_id=$1 AND tenant_id=$2 AND state='ACTIVE'"+(lock?' FOR SHARE':''),[row.profile_id,p.tenantId]);
 const prompts=await db.query(`SELECT connection_id,step_id,prompt_override,updated_at FROM connector_prompt_overrides WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3 ORDER BY connection_id,step_id${lock?' FOR UPDATE':''}`,scopeParams(p));
 const values=await Promise.all(prompts.rows.map(async value=>({connectionId:String(value.connection_id),stepId:String(value.step_id) as '_default',promptOverride:await openPrompt(value.prompt_override as string|null,{...p,connectionId:String(value.connection_id),stepId:String(value.step_id)},deps.metadataCrypto,deps.metadataReader),updatedAt:iso(value.updated_at as Date)})));
 return {profileEndpointSlug:row.endpoint_slug??null,profileId:String(row.profile_id),profileRevision:Number(row.revision),connectorBindings:row.connector_bindings as Snapshot['connectorBindings'],activeKeyCount:members.rows.length,prompts:values};
}
async function stream(client:PoolClient,p:Scope,create=false){
 if(create)await client.query('INSERT INTO settings_streams(id,tenant_id,api_key_id,endpoint_slug) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,api_key_id,endpoint_slug) DO NOTHING',[randomUUID(),...scopeParams(p)]);
 const rows=await client.query<{id:string;active_revision:number|null;last_revision:number}>('SELECT id,active_revision,last_revision FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3 FOR UPDATE',scopeParams(p));
 if(!rows.rowCount)throw new HttpError(404,'NOT_FOUND','settings stream not found');return rows.rows[0]!;
}
async function revision(db:Queryable,streamId:string,n:number){const rows=await db.query<RevisionRow>('SELECT * FROM settings_revisions WHERE stream_id=$1 AND revision=$2',[streamId,n]);if(!rows.rowCount)throw new HttpError(404,'NOT_FOUND','settings revision not found');return rows.rows[0]!;}
async function store(client:PoolClient,p:Scope,streamId:string,n:number,payload:Payload,baseActive:number|null,deps:SettingsRevisionDeps,state:'DRAFT'|'APPLIED'='DRAFT',restores:number|null=null){
 const sealed=await requireCrypto(deps).seal(payload,context(p,streamId,n));
 await client.query(`INSERT INTO settings_revisions(stream_id,revision,state,base_active_revision,base_profile_revision,payload_ref,content_digest,restores_revision,applied_at,applied_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $3='APPLIED' THEN clock_timestamp() ELSE NULL END,$9)`,[streamId,n,state,baseActive,payload.base.profileRevision,JSON.stringify(sealed),canonicalPayloadHash(payload),restores,state==='APPLIED'?fingerprint(payload.next):null]);
 return revision(client,streamId,n);
}
export async function createSettingsRevision(client:PoolClient,input:unknown,deps:SettingsRevisionDeps){
 const p=parse(CreateSchema,input);requireCrypto(deps);
 if(!p.changes.connectorBindings&&!p.changes.prompts?.length)invalid('settings draft requires at least one change');
 const head=await stream(client,p,true);if(head.active_revision!==p.expectedActiveRevision)conflict('active settings revision changed; reload');
 const base=await snapshot(client,p,deps,true);
 if(p.expectedProfileRevision!==undefined&&p.expectedProfileRevision!==base.profileRevision)conflict('active profile revision changed; reload');
 const next:Snapshot=JSON.parse(JSON.stringify(base));
 if(p.changes.connectorBindings)next.connectorBindings=p.changes.connectorBindings;
 if(p.changes.prompts){const unique=new Set<string>();for(const prompt of p.changes.prompts){const id=`${prompt.connectionId}:${prompt.stepId}`;if(unique.has(id))invalid('duplicate prompt target');unique.add(id);const prior=next.prompts.find(v=>v.connectionId===prompt.connectionId&&v.stepId===prompt.stepId);const value=prompt.promptOverride?.trim()||null;if(prior)prior.promptOverride=value;else next.prompts.push({...prompt,promptOverride:value,updatedAt:null});}}
 next.prompts.sort((a,b)=>`${a.connectionId}:${a.stepId}`.localeCompare(`${b.connectionId}:${b.stepId}`));
 if(head.last_revision===0){const exists=await client.query('SELECT revision FROM settings_revisions WHERE stream_id=$1 AND revision=0',[head.id]);if(!exists.rowCount)await store(client,p,head.id,0,{base,next:base,changes:{}},null,deps,'APPLIED');}
 const n=head.last_revision+1;await client.query('UPDATE settings_streams SET last_revision=$2 WHERE id=$1',[head.id,n]);
 return detail(await store(client,p,head.id,n,{base,next,changes:p.changes},head.active_revision,deps),p,deps);
}
async function validate(payload:Payload,current:Snapshot,deps:SettingsRevisionDeps,p:Scope){
 const issues:{code:string;message:string}[]=[];const checks=['immutable content digest','active tenant/API key/profile','dependency fingerprint','prompt binding targets'];
 if(fingerprint(payload.base)!==fingerprint(current))issues.push({code:'DEPENDENCY_CHANGED',message:'Effective profile or prompts changed since this draft; create a new draft.'});
 const bindingsChanged=canonicalPayloadHash(payload.base.connectorBindings)!==canonicalPayloadHash(payload.next.connectorBindings);
 if(bindingsChanged&&current.profileEndpointSlug!==p.endpointSlug)issues.push({code:'SHARED_ENDPOINT_PROFILE',message:'Connector changes require a dedicated profile for this exact endpoint; generic action profiles affect other endpoint variants.'});
 if(bindingsChanged&&current.activeKeyCount!==1)issues.push({code:'SHARED_PROFILE',message:'Connector changes require a profile assigned to exactly one active API key; create a dedicated profile first.'});
 if(Object.keys(current.connectorBindings).sort().join('|')!==Object.keys(payload.next.connectorBindings).sort().join('|'))issues.push({code:'SLOT_MISMATCH',message:'Preserve all existing connector slots; manage profile schema changes in Profiles.'});
 const pinned=new Set(Object.values(payload.next.connectorBindings).map(pin=>pin.connectorId));
 for(const prompt of payload.next.prompts)if(prompt.promptOverride&&!pinned.has(prompt.connectionId))issues.push({code:'PROMPT_TARGET_UNBOUND',message:'A nonempty prompt targets a connector outside the proposed profile pins.'});
 if(bindingsChanged){
  checks.push('connector revision availability and tenant');
  if(!deps.connectorManagement)issues.push({code:'CONNECTOR_VALIDATION_UNAVAILABLE',message:'Connector management is required to validate changed provider/model revision pins.'});
  else for(const pin of Object.values(payload.next.connectorBindings)){
   const target=await deps.connectorManagement.getRevision(pin.connectorId,pin.revision);
   if(!target||target.state!=='ACTIVE')issues.push({code:'CONNECTOR_NOT_ACTIVE',message:'A proposed connector revision is unavailable or not ACTIVE.'});
   else if(target.tenantId&&target.tenantId!==p.tenantId)issues.push({code:'CONNECTOR_TENANT_MISMATCH',message:'A proposed connector belongs to another tenant.'});
  }
 }
 return {valid:issues.length===0,issues,checks};
}
export async function validateSettingsRevision(client:PoolClient,input:unknown,deps:SettingsRevisionDeps){
 const p=parse(RevisionSchema,input),head=await stream(client,p),row=await revision(client,head.id,p.revision);
 if(row.state==='APPLIED')conflict('applied settings revisions are immutable');
 const payload=await opened(row,p,deps),current=await snapshot(client,p,deps,true);
 const report=await validate(payload,current,deps,p);
 if(head.active_revision!==row.base_active_revision){report.valid=false;report.issues.push({code:'ACTIVE_REVISION_CHANGED',message:'Active revision changed; create a new draft.'});}
 await client.query('UPDATE settings_revisions SET state=$3,validation=$4 WHERE stream_id=$1 AND revision=$2',[head.id,p.revision,report.valid?'VALIDATED':'DRAFT',JSON.stringify(report)]);
 return {revision:p.revision,...report};
}
async function writeEffective(client:PoolClient,p:Scope,payload:Payload,deps:SettingsRevisionDeps){
 const current=payload.base;let profileRevision=current.profileRevision;
 if(canonicalPayloadHash(current.connectorBindings)!==canonicalPayloadHash(payload.next.connectorBindings)){
  const last=await client.query<{revision:number}>('SELECT COALESCE(max(revision),0)+1 AS revision FROM profile_bindings WHERE profile_id=$1',[current.profileId]);profileRevision=Number(last.rows[0]!.revision);
  await client.query(`INSERT INTO profile_bindings(profile_id,revision,tenant_id,api_key_id,business_id,business_version,action,connector_bindings,enabled,parameters,job_priority,allowed_file_extensions,file_url_auth_cipher,connections_override,callback_policy,request_redaction,allowed_origins,endpoint_slug)
   SELECT profile_id,$3,tenant_id,api_key_id,business_id,business_version,action,$4,enabled,parameters,job_priority,allowed_file_extensions,file_url_auth_cipher,connections_override,callback_policy,request_redaction,allowed_origins,endpoint_slug
   FROM profile_bindings WHERE profile_id=$1 AND revision=$2 AND tenant_id=$5`,[current.profileId,current.profileRevision,profileRevision,JSON.stringify(payload.next.connectorBindings),p.tenantId]);
  await client.query('UPDATE profile_active_revisions SET revision=$2,moved_at=clock_timestamp() WHERE profile_id=$1',[current.profileId,profileRevision]);
 }
 const wanted=new Set(payload.next.prompts.map(v=>`${v.connectionId}:${v.stepId}`));
 for(const old of current.prompts)if(!wanted.has(`${old.connectionId}:${old.stepId}`))await client.query('DELETE FROM connector_prompt_overrides WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3 AND connection_id=$4 AND step_id=$5',[...scopeParams(p),old.connectionId,old.stepId]);
 for(const value of payload.next.prompts){
  const old=current.prompts.find(v=>v.connectionId===value.connectionId&&v.stepId===value.stepId);if(old&&old.promptOverride===value.promptOverride)continue;
  const sealed=await sealPrompt(value.promptOverride,{...p,...value},requireCrypto(deps));
  await client.query(`INSERT INTO connector_prompt_overrides(tenant_id,connection_id,api_key_id,endpoint_slug,step_id,prompt_override,is_active)
   VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(connection_id,api_key_id,endpoint_slug,step_id)
   DO UPDATE SET prompt_override=EXCLUDED.prompt_override,is_active=true,updated_at=clock_timestamp()
   WHERE connector_prompt_overrides.tenant_id=EXCLUDED.tenant_id`,[p.tenantId,value.connectionId,p.apiKeyId,p.endpointSlug,value.stepId,sealed]);
 }
 return profileRevision;
}
export async function applySettingsRevision(client:PoolClient,input:unknown,deps:SettingsRevisionDeps,rollback=false){
 const p=parse(ApplySchema,input);requireCrypto(deps);const head=await stream(client,p);
 if(head.active_revision!==p.expectedActiveRevision)conflict('active settings revision changed; reload');
 let row=await revision(client,head.id,p.revision),payload=await opened(row,p,deps);
 const current=await snapshot(client,p,deps,true);
 if(rollback){
  if(head.active_revision===null)conflict('no settings revision has been applied; create a fresh draft instead');
  if(row.state!=='APPLIED')conflict('rollback target must be an applied revision');
  if(head.active_revision!==null){const active=await revision(client,head.id,head.active_revision);if(active.applied_fingerprint!==fingerprint(current))conflict('effective settings changed outside this revision history; create a new draft');}
  const next={...payload.next,profileId:current.profileId,profileRevision:current.profileRevision,activeKeyCount:current.activeKeyCount};
  payload={base:current,next,changes:{connectorBindings:next.connectorBindings,prompts:next.prompts.map(({connectionId,stepId,promptOverride})=>({connectionId,stepId,promptOverride}))}};
  row=await store(client,p,head.id,head.last_revision+1,payload,head.active_revision,deps,'DRAFT',p.revision);
  await client.query('UPDATE settings_streams SET last_revision=$2 WHERE id=$1',[head.id,row.revision]);
 }else if(row.state!=='VALIDATED'||!row.validation?.valid)conflict('validate this draft before applying');
 if(row.base_active_revision!==head.active_revision)conflict('draft was created against another active revision');
 const report=await validate(payload,current,deps,p);if(!report.valid)conflict(report.issues.map(i=>i.message).join(' '));
 const profileRevision=await writeEffective(client,p,payload,deps);
 const after=await snapshot(client,p,deps);
 await client.query("UPDATE settings_revisions SET state='APPLIED',validation=$3,applied_at=clock_timestamp(),applied_fingerprint=$4,applied_profile_revision=$5 WHERE stream_id=$1 AND revision=$2",[head.id,row.revision,JSON.stringify(report),fingerprint(after),profileRevision]);
 await client.query('UPDATE settings_streams SET active_revision=$2 WHERE id=$1',[head.id,row.revision]);
 return {revision:row.revision,activeRevision:row.revision,profileRevision,appliesTo:'new submissions only',...(rollback?{restoredFrom:p.revision}:{})};
}
export async function readSettingsConfiguration(db:Db,p:Scope,deps:SettingsRevisionDeps,selected?:number){
 const current=await snapshot(db,p,deps);
 const streams=await db.query<{id:string;active_revision:number|null}>('SELECT id,active_revision FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3',scopeParams(p));const head=streams.rows[0];
 const rows=head?await db.query<RevisionRow>('SELECT * FROM settings_revisions WHERE stream_id=$1 ORDER BY revision DESC LIMIT 20',[head.id]):{rows:[]};
 const activeRevisionMatchesEffective=head?.active_revision!==undefined&&head.active_revision!==null ? (await revision(db,head.id,head.active_revision)).applied_fingerprint===fingerprint(current) : false;
 return {activeRevisionMatchesEffective,activeRevision:head?.active_revision??null,historyLimit:20 as const,profile:{profileId:current.profileId,revision:current.profileRevision,connectorBindings:current.connectorBindings,activeKeyCount:current.activeKeyCount},revisions:rows.rows.map(summary),...(selected!==undefined&&head?{selectedRevision:await detail(await revision(db,head.id,selected),p,deps)}:{})};
}
