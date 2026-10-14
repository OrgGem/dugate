import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createTrustedMaintenanceBackupAdapter, readTrustedMaintenanceTargetDescriptors, type MaintenanceBackupFenceProof } from '../src/modules/maintenance/trusted-backup-adapter';
import { backupTargetPinDigest } from '../src/modules/maintenance/maintenance-service';

const ownerTenantId = '11111111-1111-4111-8111-111111111111';
const backupId = '22222222-2222-4222-8222-222222222222';
const generationId = '33333333-3333-4333-8333-333333333333';
const secretRef = `${ownerTenantId}@1`;
const recoveryKey = Buffer.alloc(32,7);
const recoveryKeySha256 = digest(recoveryKey);
const catalogKey = Buffer.alloc(32,8);
const catalogKeySha256 = digest(catalogKey);
const connectorCredentialConfig = Buffer.from(Buffer.alloc(32,9).toString('base64'),'utf8');
const connectorCredentialSha256 = digest(connectorCredentialConfig);
const rootOnly = process.getuid?.() === 0 ? it : it.skip;
const itOnPosixHost = typeof process.getuid === 'function' ? it : it.skip;

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function fixtureReplica(service: 'orchestrator' | 'connector' | 'worker', slot: 'blue' | 'green') {
  const runtimeIdentity = `${service}-${slot}`;
  return {
    service,slot,runtimeIdentity,replicaId:runtimeIdentity,revision:'r1',imageDigest:`${service}@sha256:${'a'.repeat(64)}`,
    bootId:`00000000-0000-4000-8000-${service === 'orchestrator' ? (slot === 'blue' ? '000000000001':'000000000002') : service === 'connector' ? (slot === 'blue' ? '000000000003':'000000000004') : (slot === 'blue' ? '000000000005':'000000000006')}`,
    readiness:'DRAINING' as const,observedAt:'2026-10-12T00:00:00.000Z',workObservedAt:'2026-10-12T00:00:00.000Z',
    controlRevision:1,controlState:'DRAINING' as const,controlAcknowledgedAt:'2026-10-12T00:00:00.000Z',
    work:{workerLeases:{applicable:service==='worker',count:0},sdkActiveTasks:{applicable:service==='worker',count:0},
      connectorInvocations:{applicable:service==='connector',count:0},orchestratorRequests:{applicable:service==='orchestrator',count:0},
      dispatches:{applicable:service==='orchestrator',count:0},maintenanceExecutions:{applicable:service==='orchestrator',count:0}},
  };
}

function fakeSpawn(): typeof import('node:child_process').spawn {
  return ((executable: string, args: readonly string[]) => {
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    queueMicrotask(async () => {
      let code = 0;
      try {
        if (path.basename(executable).toLowerCase() === 'pgdump') {
          const target = String(args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length));
          await writeFile(target,Buffer.from('fixture postgres dump'));
        } else if (path.basename(executable) === 'psql') {
          const output = String(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length));
          const sql = String(args.find((arg) => arg.startsWith('--command='))?.slice('--command='.length));
          const connection = String(args.find((arg) => arg.startsWith('--dbname=')) ?? '');
          let result = '0';
          if (sql.includes('current_setting')) result = connection.includes('connector-source') ? 'connector-source' : 'orchestrator-source';
          else if (sql.includes("to_regclass('public.connector_parity_credentials')")) result = 'f';
          else if (sql.includes('WITH typed_source_rows')) result = '0|0';
          else if (sql.includes('connector_usage_outbox')) result = '0|0|0|0|0|0|0|0|0';
          else if (sql.includes('WITH credential_refs')) result = '0';
          else if (sql.includes('json_agg')) result = '[]';
          else if (sql.includes('GROUP BY 1,2,3 ORDER BY 1,2,3') || sql.includes('FROM env GROUP BY slot')
            || sql.includes('session_ref IS NOT NULL')) result = '';
          await writeFile(output,Buffer.from(result));
        }
      } catch { code = 1; }
      child.emit('close',code);
    });
    return child;
  }) as typeof import('node:child_process').spawn;
}

describe('ORV14 Host trusted backup adapter', () => {
  let root: string;
  let adapter: ReturnType<typeof createTrustedMaintenanceBackupAdapter>;
  let db: { query: jest.Mock };
  let releaseFence: jest.Mock;
  let proof: MaintenanceBackupFenceProof;
  let runtimeSecretsFilePath: string;
  let manifestPath: string;
  let manifestSha256: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(),'orv14-host-backup-'));
    const bundleDirectory = path.join(root,'bundles');
    const workDirectory = path.join(root,'work');
    await mkdir(bundleDirectory,{mode:0o700});
    await mkdir(workDirectory,{mode:0o700});
    const serviceFile = path.join(root,'pg_service.conf');
    const passfile = path.join(root,'pgpass');
    const rolloutManifestFile = path.join(root,'rollout-manifest.json');
    await writeFile(serviceFile,'[unused]\nhost=localhost\n',{mode:0o400});
    await writeFile(passfile,'localhost:*:*:fixture:fixture\n',{mode:0o400});
    await writeFile(rolloutManifestFile,'{}',{mode:0o400});
    const tools: Record<string,{path:string;sha256:string}> = {};
    for (const name of ['pgDump','pgRestore','createdb','psql']) {
      const file = path.join(root,name);
      const bytes = Buffer.from(`fixture tool ${name}`);
      await writeFile(file,bytes,{mode:0o500});
      await chmod(file,0o500);
      tools[name] = { path:file,sha256:digest(bytes) };
    }
    const pinFile = async (name: string, bytes = Buffer.from(`fixture protected ${name}`), mode = 0o400, runtimeReadable = false) => {
      const file = path.join(root,name);
      await writeFile(file,bytes,{mode});
      await chmod(file,mode);
      if (runtimeReadable && process.getuid?.() === 0) await chown(file,0,1000);
      return {path:file,sha256:digest(bytes)};
    };
    const launcherTool = await pinFile('docker',Buffer.from('fixture launcher'),0o500);
    const namespaceTool = await pinFile('nsenter',Buffer.from('fixture namespace tool'),0o500);
    const nftTool = await pinFile('nft',Buffer.from('fixture nft'),0o500);
    const sourceNames = ['orchestratorSourceDb','connectorSourceDb','sourceCatalogKeyring','sourceConnectorRecoveryRegistry',
      'sourceMetadataTransit','sourceArtifactTransit','sourceVault'] as const;
    const sourceRuleIds = Object.fromEntries(sourceNames.map((name) => [name,`deny-${name}`]));
    const sourceHosts = Object.fromEntries(sourceNames.map((name,index) => [name,`192.0.2.${101 + index}`]));
    const policyRules = Buffer.from([
      'table inet du_restore {',
      ' chain output {',
      '  type filter hook output priority 0; policy drop;',
      ...sourceNames.map((name,index) => `  ip daddr ${sourceHosts[name]} tcp dport ${index < 2 ? 5432 : 443} drop comment "${sourceRuleIds[name]}"`),
      ' }',
      '}',
    ].join('\n'));
    const policyRulesFile = await pinFile('network-policy.nft',policyRules);
    const orchControlToken = await pinFile('orchestrator-control-token',undefined,0o440,true);
    const connectorControlToken = await pinFile('connector-control-token',undefined,0o440,true);
    const loginCredential = await pinFile('admin-login.json',Buffer.from(JSON.stringify({username:'restore-probe',password:'synthetic-password'})));
    const artifactApiKey = await pinFile('artifact-api-key.json',Buffer.from(JSON.stringify({apiKey:'synthetic-api-key',apiKeyId:'55555555-5555-4555-8555-555555555555'})));
    const recoveryConfig = await pinFile('recovery-reader.json');
    const recoveryKeyRegistry = await pinFile('recovery-key-registry.json');
    const objectStoreCa = await pinFile('object-store-ca');
    const objectStoreClientIdentity = await pinFile('object-store-client-identity');
    const transitCa = await pinFile('transit-ca');
    const transitToken = await pinFile('transit-token');
    const vaultCa = await pinFile('vault-ca');
    const vaultToken = await pinFile('vault-token');
    const runtimeConfig = (service: 'orchestrator'|'connector') => ({
      schemaVersion:1,service,clusterName:service === 'orchestrator' ? 'orchestrator-isolated' : 'connector-isolated',
      runtimeIdentity:service === 'orchestrator' ? 'orch-isolated' : 'connector-isolated',
      revision:'r2',imageDigest:`${service}@sha256:${service === 'orchestrator' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      ...(service === 'connector' ? {replicaId:'connector-isolated-replica',slot:'green' as const}
        : {slot:'blue' as const,internalHost:'127.0.0.1' as const,internalPort:3002,
          adminShellHost:'127.0.0.1' as const,adminShellPort:3001}),
      bindHost:'0.0.0.0',port:service === 'orchestrator' ? 3000 : 8080,
      database:{host:'192.0.2.20',port:5432,user:'restore_owner',sslMode:'disable' as const},
      redis:{host:'192.0.2.21',port:6379},
    });
    const orchRuntimeConfig = await pinFile('orchestrator-runtime-config.json',Buffer.from(JSON.stringify(runtimeConfig('orchestrator'))),0o440,true);
    const connectorRuntimeConfig = await pinFile('connector-runtime-config.json',Buffer.from(JSON.stringify(runtimeConfig('connector'))),0o440,true);
    const orchRuntimeSecrets = await pinFile('orchestrator-runtime-secrets.json',Buffer.from('{"fixture":true}'),0o440,true);
    runtimeSecretsFilePath = orchRuntimeSecrets.path;
    const connectorRuntimeSecrets = await pinFile('connector-runtime-secrets.json',Buffer.from('{"fixture":true}'),0o440,true);
    const orchPgPassword = await pinFile('orchestrator-pg-password',Buffer.from('fixture-password-orch'),0o440,true);
    const connectorPgPassword = await pinFile('connector-pg-password',Buffer.from('fixture-password-connector'),0o440,true);
    const recoveryReaderConfigBytes = Buffer.from(JSON.stringify({
      schemaVersion:1,targetStorageGenerationId:'${TARGET_STORAGE_GENERATION_ID}',recoveryKeyRegistry,
      objectStore:{endpoint:'https://s3.invalid',bucket:'restore-bucket',region:'us-east-1',forcePathStyle:true,
        credentialSource:{kind:'restored-catalog',credentialVersionRef:secretRef,ownerTenantId},caFile:objectStoreCa,clientIdentityFile:objectStoreClientIdentity},
      transit:{endpoint:'https://isolated-transit.invalid',caFile:transitCa,tokenFile:transitToken,
        keyNameByRef:{artifactTransit:{'artifact-transit/key-a':'artifact-key'},metadataTransit:{}}},
      vault:{endpoint:'https://isolated-vault.invalid',caFile:vaultCa,tokenFile:vaultToken},connectorVaultCredentialPins:[],
    }));
    await chmod(recoveryConfig.path,0o600);
    await writeFile(recoveryConfig.path,recoveryReaderConfigBytes,{mode:0o400});
    await chmod(recoveryConfig.path,0o400);
    const pinnedRecoveryConfig = {path:recoveryConfig.path,sha256:digest(recoveryReaderConfigBytes)};
    const sourceEndpoints = Object.fromEntries(sourceNames.map((name) => [name,{
      protocol:name.endsWith('Db')?'tcp':'https',host:sourceHosts[name],port:name.endsWith('Db')?5432:443,ruleId:`deny-${name}`,
    }]));
    const manifest = {
      schemaVersion:1,hostId:'host-runner-a',ownerTenantId,bundleDirectory,workDirectory,
      orchestratorSourceClusterName:'orchestrator-source',connectorSourceClusterName:'connector-source',
      orchestratorRestoreClusterName:'orchestrator-isolated',connectorRestoreClusterName:'connector-isolated',
      services:{orchestratorSource:'orch-src',connectorSource:'connector-source',orchestratorRestoreAdmin:'orch-restore',connectorRestoreAdmin:'connector-restore'},
      restoreOwnerRole:'restore_owner',libpqServiceFile:{path:serviceFile,sha256:digest(await readFile(serviceFile))},
      passfile:{path:passfile,sha256:digest(await readFile(passfile))},tools,
      rolloutManifest:{path:rolloutManifestFile,sha256:digest(await readFile(rolloutManifestFile))},
      backupRecoveryKey:{escrowRef:'file:/private/backup-recovery.key',keyVersion:'v1',fingerprintSha256:recoveryKeySha256},
      secretCatalogRecoveryKeys:[{escrowRef:'file:/private/catalog-v2.key',keyVersion:'catalog-v2',fingerprintSha256:catalogKeySha256}],
      connectorCredentialRecoveryKey:{escrowRef:'root:connector-legacy-key',keyVersion:'legacy-v1',fingerprintSha256:connectorCredentialSha256},
      connectorInvocationRecoveryKeys:[],metadataTransitKeyPins:[],connectorVaultCredentialPins:[],
      credentialVersionPins:[{reference:secretRef,ownerTenantId}],credentialVersionRefs:[secretRef],
      artifactTransitKeyPins:[{keyRef:'artifact-transit/key-a',keyVersion:1}],
      isolatedStorage:{endpoint:'https://s3.invalid',bucket:'restore-bucket',region:'us-east-1',forcePathStyle:true,credentialVersionRef:secretRef,ownerTenantId},
      sourceRuntimeIdentities:['orch-blue','connector-blue'],
      isolatedRuntime:{orchestratorRuntimeIdentity:'orch-isolated',orchestratorSlot:'blue',orchestratorRevision:'r2',orchestratorImageDigest:`orchestrator@sha256:${'a'.repeat(64)}`,
        connectorRuntimeIdentity:'connector-isolated',connectorReplicaId:'connector-isolated-replica',connectorSlot:'green',connectorRevision:'r2',connectorImageDigest:`connector@sha256:${'b'.repeat(64)}`},
      connectorReplicas:[{slot:'blue',replicaId:'connector-blue',runtimeIdentity:'connector-blue',revision:'r1',imageDigest:`connector@sha256:${'c'.repeat(64)}`}],
      isolatedHost:{
        hostRunnerIdentity:'host-runner-a',runtimeUid:1000,runtimeGid:1000,
        runtimeConfigFiles:{orchestrator:orchRuntimeConfig,connector:connectorRuntimeConfig},
        runtimeSecretsFiles:{orchestrator:orchRuntimeSecrets,connector:connectorRuntimeSecrets},
        pgPasswordFiles:{orchestrator:orchPgPassword,connector:connectorPgPassword},
        launcher:{executable:launcherTool,startArgs:{
            orchestrator:['run','--detach','--cidfile','${CID_FILE}','--name','${RUNTIME_IDENTITY}','--network','none','--user','1000:1000',
              '--mount','type=bind,src=${RUNTIME_CONFIG_FILE},dst=/run/du-restore/runtime-config.json,readonly',
              '--mount','type=bind,src=${RUNTIME_SECRETS_FILE},dst=/run/du-restore/runtime-secrets.json,readonly',
              '--mount','type=bind,src=${PG_PASSWORD_FILE},dst=/run/du-restore/pg-password,readonly',
              '--mount','type=bind,src=${CONTROL_TOKEN_FILE},dst=/run/du-restore/control-token,readonly',
              '--mount','type=bind,src=${START_GATE_DIR},dst=/run/du-restore/start-gate,readonly','${IMAGE_DIGEST}','node','dist/isolated-restore-bootstrap.js'],
            connector:['run','--detach','--cidfile','${CID_FILE}','--name','${RUNTIME_IDENTITY}','--network','none','--user','1000:1000',
              '--mount','type=bind,src=${RUNTIME_CONFIG_FILE},dst=/run/du-restore/runtime-config.json,readonly',
              '--mount','type=bind,src=${RUNTIME_SECRETS_FILE},dst=/run/du-restore/runtime-secrets.json,readonly',
              '--mount','type=bind,src=${PG_PASSWORD_FILE},dst=/run/du-restore/pg-password,readonly',
              '--mount','type=bind,src=${CONTROL_TOKEN_FILE},dst=/run/du-restore/control-token,readonly',
              '--mount','type=bind,src=${START_GATE_DIR},dst=/run/du-restore/start-gate,readonly','${IMAGE_DIGEST}','node','dist/isolated-restore-bootstrap.js'],
          },
          targetNetwork:{id:'f'.repeat(64),name:'restore-target'},attachNetworkArgs:['network','connect','${TARGET_NETWORK_ID}','${CONTAINER_ID}'],
          inspectArgs:['inspect','${CONTAINER_ID}'],execArgs:['exec','${CONTAINER_ID}','node','/opt/restore-probe.js','${SOURCE_HOST}','${SOURCE_PORT}'],
          stopArgs:['stop','--time','30','${CONTAINER_ID}']},
        networkPolicy:{revision:digest(policyRules),rulesFile:policyRulesFile,namespaceTool,nftTool,sourceRuleIds},
        sourceEndpoints,
        localRuntime:{
          orchestrator:{baseUrl:'http://127.0.0.1:3000',internalBaseUrl:'http://127.0.0.1:3002',healthPath:'/health',observationPath:'/api/internal/service-runtime/observation',tokenFile:orchControlToken},
          connector:{baseUrl:'http://127.0.0.1:8080',healthPath:'/health/live',observationPath:'/internal/admin/runtime-control/observe',tokenFile:connectorControlToken},
        },
        login:{url:'http://127.0.0.1:3000/admin/login',credentialFile:loginCredential},
        artifact:{baseUrl:'http://127.0.0.1:3000',historyPath:'/admin/api/operations',
          detailPath:'/admin/api/operations/{operationId}',downloadPath:'/api/v1/artifacts/{artifactId}/download',
          apiKeyCredentialFile:artifactApiKey},
        libpq:{serviceFile:{path:serviceFile,sha256:digest(await readFile(serviceFile))},passFile:{path:passfile,sha256:digest(await readFile(passfile))},
          orchestratorService:'orch-restore-app',connectorService:'connector-restore-app'},
        recoveryReaders:{configFile:pinnedRecoveryConfig,
          objectStore:{endpoint:'https://s3.invalid',caFile:objectStoreCa,clientIdentityFile:objectStoreClientIdentity},
          transit:{endpoint:'https://isolated-transit.invalid',caFile:transitCa,tokenFile:transitToken},
          vault:{endpoint:'https://isolated-vault.invalid',caFile:vaultCa,tokenFile:vaultToken}},
      },
      maxBundleBytes:1024*1024,maxArtifactBytes:1024*1024,
    };
    manifestPath = path.join(root,'manifest.json');
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    manifestSha256 = digest(manifestBytes);
    await writeFile(manifestPath,manifestBytes,{mode:0o400});

    db = { query:jest.fn(async (sql: string) => {
      if (sql.includes('FROM maintenance_job_items')) return {rows:[{ok:1}],rowCount:1};
      if (sql.includes('SELECT DISTINCT credential_version_ref')) return {rows:[],rowCount:0};
      if (sql.includes('SELECT (SELECT count(*) FROM operations)')) return {rows:[{
        operations:0,artifacts:1,ready_artifacts:1,secret_revisions:0,storage_generations:1,global_settings_revisions:0,secret_catalog_imports:0,
        connector_secret_imports:0,retention_revisions:1,
        budget_revisions:0,price_revisions:0,reservation_groups:0,budget_holds:0,
        financial_adjustments:0,financial_adjustment_heads:0,financial_adjustment_commands:0,
      }],rowCount:1};
      if (sql.includes('FROM artifacts WHERE state<>')) return {rows:[{
        id:'44444444-4444-4444-8444-444444444444',tenant_id:ownerTenantId,file_name:'fixture.pdf',mime_type:'application/pdf',
        size_bytes:16,sha256:'d'.repeat(64),storage_backend:'s3',storage_generation_id:generationId,storage_key:'private/k',
        storage_version_id:'object-v1',manifest_version_id:'sidecar-v1',state:'READY',
      }],rowCount:1};
      return {rows:[],rowCount:0};
    }) };
    releaseFence = jest.fn(async () => undefined);
    const evidence = {
      fenceId: '66666666-6666-4666-8666-666666666666',fenceRevision:1,priorControlStates:{},
      replicaObservations: (['orchestrator','connector','worker'] as const).flatMap((service) => [fixtureReplica(service,'blue'),fixtureReplica(service,'green')]),
      connectorFences: (['blue','green'] as const).map((slot,index) => ({
        slot,runtimeIdentity:`connector-${slot}`,replicaId:`connector-${slot}`,revision:'r1',imageDigest:`connector@sha256:${'a'.repeat(64)}`,
        fence:{fenceId:'66666666-6666-4666-8666-666666666666',fenceRevision:1,state:'HELD' as const,
          acknowledgedAt:'2026-10-12T00:00:00.000Z',bootId:`00000000-0000-4000-8000-00000000000${index+7}`},
        work:{processActiveInvocations:0,processActivePolls:0,processActiveUsageSends:0,
          effectPermits:{prepared:0,active:0,settling:0,unknown:0},unclosedEffectPermits:0,unresolvedInvocationHolds:0,unknownUsageDeliveries:0},
        observedAt:'2026-10-12T00:00:00.000Z',workObservedAt:'2026-10-12T00:00:00.000Z',
      })),
      artifactEffects:{observedAt:'2026-10-12T00:00:00.000Z',workObservedAt:'2026-10-12T00:00:00.000Z',
        owner:{runtimeIdentity:'orchestrator-blue',bootId:'00000000-0000-4000-8000-000000000001'},processActiveEffects:0,
        preparedEffects:0,activeEffects:0,settlingEffects:0,unclosedEffects:0,unresolvedCapabilities:0,unknownEffects:0},
      execution:{jobId:backupId,itemId:'platform-primary',ownerRuntimeIdentity:'runner-a',ownerBootId:'77777777-7777-4777-8777-777777777777',
        executionFence:1,executionTokenSha256:digest(Buffer.from('x'.repeat(32)))},
    };
    proof = {observedAt:'2026-10-12T00:00:00.000Z',admission:{fenced:true,inFlight:0},orchestratorDispatch:{fenced:true,inFlight:0},
      providerIssuance:{fenced:true,inFlight:0},connectorInvocationPolling:{fenced:true,inFlight:0},artifactMutation:{fenced:true,inFlight:0},
      connectorUsageDelivery:{fenced:true,inFlight:0},evidence,evidenceSha256:digest(Buffer.from(canonical(evidence)))};
    const storageGenerations = {forGeneration:jest.fn(() => ({}))} as never;
    adapter = createTrustedMaintenanceBackupAdapter({manifestPath,expectedManifestSha256:manifestSha256,db:db as never,
      storageGenerations,artifacts:{openPinnedObjectsForMaintenanceBackup:jest.fn(async () => ({
        object:Readable.from([Buffer.from('sealed artifact bytes')]),manifest:Readable.from([Buffer.from(JSON.stringify({version:1,kind:'single',artifactId:'44444444-4444-4444-8444-444444444444',tenantId:ownerTenantId,objectVersion:'object-v1',encryption:{dek:{keyRef:'artifact-transit/key-a',keyVersion:1,ciphertext:'wrapped-fixture'}}}))]),
      }))} as never,
      resolveRecoveryKey:async ({purpose}: {purpose:'backup_bundle'|'secret_catalog'|'connector_invocation'|'connector_credential'}) =>
        Buffer.from(purpose === 'connector_credential' ? connectorCredentialConfig : purpose === 'secret_catalog' ? catalogKey : recoveryKey),
      verifySecretVersion:async () => undefined,
      backupFence:{acquire:jest.fn(async () => ({fenceId:evidence.fenceId,fenceRevision:evidence.fenceRevision,proof})),release:releaseFence},
      backupArtifactEffects:{snapshotOpenCapabilities:jest.fn(async () => ({observedAt:'2026-10-12T00:00:00.000Z',openCapabilities:0,includedExactVersion:0,excludedIncomplete:0,
        evidenceSha256:digest(Buffer.from('fixture-capability-snapshot'))}))},
      isolatedRuntimeProbe:{run:jest.fn(async () => { throw new Error('probe should not run in source backup test'); })},
      spawn:fakeSpawn(),
    });
  });

  afterEach(async () => { await rm(root,{recursive:true,force:true}); });

  it('binds preview identity to manifest and immutable version inventory independent of ordering', () => {
    const base = { name:'platform-primary',kind:'postgres' as const,manifestSha256:'a'.repeat(64),
      credentialVersionRefs:['tenant@2','tenant@1'],encryptionKeyVersionRefs:['transit@3','bundle@1'] };
    expect(backupTargetPinDigest(base)).toBe(backupTargetPinDigest({
      ...base,credentialVersionRefs:['tenant@1','tenant@2'],encryptionKeyVersionRefs:['bundle@1','transit@3'],
    }));
    expect(backupTargetPinDigest(base)).not.toBe(backupTargetPinDigest({ ...base,manifestSha256:'b'.repeat(64) }));
    expect(backupTargetPinDigest(base)).not.toBe(backupTargetPinDigest({ ...base,credentialVersionRefs:['tenant@1'] }));
  });

  rootOnly('encrypts and checksums every exact artifact object and sidecar in the immutable bundle', async () => {
    const targets = await adapter.listTargets();
    expect(targets[0]!.targetPinDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(targets[0]!.manifestSha256).toBe(manifestSha256);
    const execution = {jobId:backupId,itemId:'platform-primary',ownerRuntimeIdentity:'runner-a',ownerBootId:'77777777-7777-4777-8777-777777777777',
      executionFence:1,executionToken:'x'.repeat(32)};
    const result = await adapter.createBundle({backupId,target:targets[0]!,scope:{kind:'platform'},execution});
    expect(result.verified).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(result.bundleRef,'manifest.json'),'utf8')) as {
      schemaVersion:number;backupRecoveryKey:{keyVersion:string;fingerprintSha256:string};secretCatalogRecoveryKeys:Array<{keyVersion:string;fingerprintSha256:string}>;connectorCredentialRecoveryKey:{keyVersion:string;fingerprintSha256:string};connectorTypedCredentialReferenceCount:number;artifactTransitKeyPins:Array<{keyRef:string;keyVersion:number}>;components:Array<{name:string;sha256:string}>;counts:{artifacts:number;readyArtifacts:number;artifactObjectBytes:number;artifactManifestBytes:number;connectorParityCredentials:number;secretCatalogImports:number;connectorSecretImports:number;financialAdjustments:number;financialAdjustmentHeads:number;financialAdjustmentCommands:number};
    };
    expect(bundle.schemaVersion).toBe(7);
    expect(bundle.backupRecoveryKey).toEqual({keyVersion:'v1',fingerprintSha256:recoveryKeySha256});
    expect(bundle.secretCatalogRecoveryKeys).toEqual([{keyVersion:'catalog-v2',fingerprintSha256:catalogKeySha256}]);
    expect(bundle.connectorCredentialRecoveryKey).toEqual({keyVersion:'legacy-v1',fingerprintSha256:connectorCredentialSha256});
    expect(bundle.connectorTypedCredentialReferenceCount).toBe(0);
    expect(bundle.counts.connectorParityCredentials).toBe(0);
    expect(bundle.artifactTransitKeyPins).toEqual([{keyRef:'artifact-transit/key-a',keyVersion:1}]);
    expect(JSON.stringify(bundle)).not.toContain('file:/private/backup-recovery.key');
    expect(JSON.stringify(bundle)).not.toContain(recoveryKey.toString('hex'));
    expect(bundle.counts).toMatchObject({artifacts:1,artifactObjectBytes:21,artifactManifestBytes:14,
      readyArtifacts:1,financialAdjustments:0,financialAdjustmentHeads:0,financialAdjustmentCommands:0});
    expect(bundle.components.map((component) => component.name)).toEqual(expect.arrayContaining(['orchestrator.dump','connector.dump','artifact-index.json']));
    expect(bundle.components.some((component) => component.name.startsWith('object-'))).toBe(true);
    expect(bundle.components.some((component) => component.name.startsWith('sidecar-'))).toBe(true);
    expect(releaseFence).toHaveBeenCalledTimes(1);
  });

  rootOnly('web-safe descriptor and host execution adapter freeze the same immutable target pin', async () => {
    const projection = await readTrustedMaintenanceTargetDescriptors({ manifestPath, expectedManifestSha256:manifestSha256 });
    const executable = await adapter.listTargets();
    expect(projection.backupTargets).toHaveLength(1);
    expect(projection.backupTargets[0]).toMatchObject({
      name:'platform-primary', kind:'postgres', allowlisted:true, immutable:true,
      manifestSha256, targetPinDigest:executable[0]!.targetPinDigest, supportedScopes:['platform'],
    });
    expect(projection.backupTargets[0]).not.toHaveProperty('credentialVersionRefs');
    expect(projection.backupTargets[0]).not.toHaveProperty('encryptionKeyVersionRefs');
  });

  rootOnly('fails closed before database dumps when the source fence has an in-flight dispatch', async () => {
    proof = {...proof,orchestratorDispatch:{fenced:true,inFlight:1}};
    const targets = await adapter.listTargets();
    await expect(adapter.createBundle({backupId,target:targets[0]!,scope:{kind:'platform'},
      execution:{jobId:backupId,itemId:'platform-primary',ownerRuntimeIdentity:'runner-a',ownerBootId:'77777777-7777-4777-8777-777777777777',
        executionFence:1,executionToken:'x'.repeat(32)}})).rejects.toThrow('BACKUP_FENCE_NOT_QUIESCENT');
    expect(releaseFence).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('FROM artifacts WHERE state<>'),expect.anything());
  });

  rootOnly('rejects a target-mounted runtime secret pin that is world-readable', async () => {
    await chmod(runtimeSecretsFilePath,0o444);
    await expect(adapter.listTargets()).rejects.toThrow('BACKUP_SECRET_PIN_UNTRUSTED');
    expect(db.query).not.toHaveBeenCalled();
  });

  itOnPosixHost('rejects a manifest owned by an untrusted non-root process', async () => {
    if (process.getuid?.() === 0) return;
    await expect(adapter.listTargets()).rejects.toThrow('BACKUP_MANIFEST_UNTRUSTED');
    expect(db.query).not.toHaveBeenCalled();
  });
});
