import { EXPECTED_RESULT_CORPUS, normalizeNondeterministicFields } from '../../businesses/document-core/tests/fixtures/expected-result-corpus';
import { chromium } from '../browser/node_modules/@playwright/test';
import { existsSync, mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signCookie } from '../../orchestrator/services/orchestrator/src/app/admin/shell-auth';
const browserCookieSecret='orv11-core-browser-synthetic-secret';
import { VARIANT_TRACEABILITY_MATRIX } from '../../businesses/document-core/src/manifest/traceability';
import { MockTaskContext } from '../../businesses/document-core/tests/fixtures/mock-context';
import { getVariantFixture } from './orv11-vfy-variant-fixtures';
let matrixProviderValue: {data?:unknown;rawText?:string} | undefined;
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DocumentCoreProcess as DocumentCoreProcessType } from '../../businesses/document-core/src/main';
import type { WorkerHandle } from '../../businesses/document-core/src/worker';
const compiledDocumentCoreRoot = process.env.ORV14_DOCUMENT_CORE_COMPILED_ROOT;
const documentCoreModules = compiledDocumentCoreRoot ? {
  manifest: require(resolve(compiledDocumentCoreRoot, 'manifest/document-core.manifest.js')) as typeof import('../../businesses/document-core/src/manifest/document-core.manifest'),
  main: require(resolve(compiledDocumentCoreRoot, 'main.js')) as typeof import('../../businesses/document-core/src/main'),
  worker: require(resolve(compiledDocumentCoreRoot, 'worker.js')) as typeof import('../../businesses/document-core/src/worker'),
} : {
  manifest: require('../../businesses/document-core/src/manifest/document-core.manifest') as typeof import('../../businesses/document-core/src/manifest/document-core.manifest'),
  main: require('../../businesses/document-core/src/main') as typeof import('../../businesses/document-core/src/main'),
  worker: require('../../businesses/document-core/src/worker') as typeof import('../../businesses/document-core/src/worker'),
};
const { documentCoreManifest } = documentCoreModules.manifest;
const { DocumentCoreProcess } = documentCoreModules.main;
const { documentCoreHandlers, startDocumentCoreWorker } = documentCoreModules.worker;
import { lcCheckerManifest } from '../../businesses/lc-checker/src/manifest';
import { startLcCheckerWorker } from '../../businesses/lc-checker/src/worker';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { CryptoStorageFacade } from '../../orchestrator/services/orchestrator/src/modules/encryption/crypto-storage-facade';
import { adaptKeyProviderForMetadata } from '../../orchestrator/services/orchestrator/src/modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../../orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto';
import { createProfileService } from '../../orchestrator/services/orchestrator/src/modules/profiles/profiles';
import { provisionLegacyWorkflowSchema } from '../../orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  ContractSignedProviderTestGrantVerifier,
  createConnectorComposition,
  FetchProviderTransport,
  HmacServiceIdentityVerifier,
  HmacSignedGrantSource,
} from '../../orchestrator/services/connector/src';
import {
  createInvocationFieldCrypto,
  createLocalInvocationKekProvider,
  parseLocalInvocationKekConfig,
} from '../../orchestrator/services/connector/src/db/invocation-crypto';
import { createTestIsolationContext } from '../isolation/namespace';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';
import { PRIVATE_HTTPS_TARGETS, PrivateHttpsFixture, type PrivateHttpsEvent } from './orv14-vfy-worker/private-https-fixture';
import { TestFixtures } from '../../orchestrator/packages/document-kit/tests/fixtures/test-fixtures';
import { createConnectorManagementAuthorizationProvider } from '../../orchestrator/services/orchestrator/src/modules/connectors/management-service-identity';
import { GetObjectCommand } from '../../orchestrator/services/orchestrator/node_modules/@aws-sdk/client-s3';
import { startOwnedMinioFixture, type OwnedMinioFixture } from './orv14-vfy-worker/owned-minio';
import { workflowOverridesDigest, type ConnectorWorkflowOverrides } from '@du/contracts';

const isolation = createWorkflowApiIsolation();
const rawRoot = resolve(process.env.ORV14_WORKER_E2E_RAW_DIR ?? 'coordination/reports/raw/orv14-worker-e2e-verification/attempt-00');
const connectorIsolationContext = createTestIsolationContext({
  runId: `${isolation.id}_connector`,
  baseArtifactPath: 'tests/workflow-api/orv14-vfy-worker/scratch/connector-artifacts',
});
const connectorDatabaseUrlBuilder = new URL(isolation.baseDatabaseUrl);
connectorDatabaseUrlBuilder.searchParams.set('options', `-csearch_path=${connectorIsolationContext.dbSchema}`);
const connectorDatabaseUrl = connectorDatabaseUrlBuilder.toString();
mkdirSync(rawRoot, { recursive: true });
const isolatedRedisUrl = new URL(isolation.redisUrl);
const keyProvider = syntheticMetadataKeyProvider();
const metadataCrypto = createMetadataCrypto(
  adaptKeyProviderForMetadata(keyProvider),
  'du-orch-metadata-v1',
);
const baseDb = createDb(isolation.baseDatabaseUrl);
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const apiKey = `wfa-worker-${randomUUID()}`;
const namedApiKey = `wfa-worker-named-${randomUUID()}`;
const disbursementApiKey = `wfa-worker-disbursement-${randomUUID()}`;
const lcApiKey = `wfa-worker-lc-${randomUUID()}`;
const otherApiKey = `wfa-worker-other-${randomUUID()}`;
const leafApiKey = `wfa-worker-leaf-${randomUUID()}`;
const workflowOverrideApiKey = `wfa-worker-workflow-override-${randomUUID()}`;
const workflowBranchApiKey = `wfa-worker-workflow-branch-${randomUUID()}`;
const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
const namedApiKeyHash = createHash('sha256').update(namedApiKey).digest('hex');
const disbursementApiKeyHash = createHash('sha256').update(disbursementApiKey).digest('hex');
const lcApiKeyHash = createHash('sha256').update(lcApiKey).digest('hex');
const otherApiKeyHash = createHash('sha256').update(otherApiKey).digest('hex');
const leafApiKeyHash = createHash('sha256').update(leafApiKey).digest('hex');
const workflowOverrideApiKeyHash = createHash('sha256').update(workflowOverrideApiKey).digest('hex');
const workflowBranchApiKeyHash = createHash('sha256').update(workflowBranchApiKey).digest('hex');
const runtimeToken = `wfa-worker-platform-${randomUUID()}`;
const workerIdentityToken = `wfa-worker-document-core-${randomUUID()}`;
const lcWorkerIdentityToken = `wfa-worker-lc-checker-${randomUUID()}`;
const adminToken = `wfa-worker-admin-${randomUUID()}`;
const serviceRuntimeId = `wfa-vfy-${randomUUID()}`;
const serviceRuntimeControlToken = `wfa-vfy-service-control-${randomUUID()}-synthetic`;
const serviceRuntimeImageDigest = `orv14-vfy-worker@sha256:${createHash('sha256').update(randomUUID()).digest('hex')}`;
const openAiConnectorId = `orv14-vfy-openai-compatible-${randomUUID()}`;
const geminiConnectorId = `orv14-vfy-gemini-${randomUUID()}`;
const workflowConnectorId = `orv14-vfy-workflow-recipe-${randomUUID()}`;
const workflowBranchConnectorId = `orv14-vfy-workflow-branch-${randomUUID()}`;
const connectorRuntimeControl = {
  slot: 'blue' as const,
  runtimeIdentity: `wfa-connector-runtime-${randomUUID()}`,
  replicaId: `wfa-connector-replica-${randomUUID()}`,
  revision: 'wfa-vfy-1',
  imageDigest: `orv14-vfy-connector@sha256:${createHash('sha256').update(randomUUID()).digest('hex')}`,
};
const invocationGrantSecret = `wfa-invocation-grant-${randomUUID()}`;
const costControlToken = randomBytes(32).toString('base64url');
const secretCatalogKeyring = {
  activeVersion: 'orv14-vfy-worker-k1',
  keys: { 'orv14-vfy-worker-k1': randomBytes(32) },
};
const connectorServiceSecret = randomBytes(32);
const connectorProviderCalls: Array<{
  task: string;
  prompt: string;
  model?: string;
  workflowHeader?: string;
  workflowMode?: string;
  artifacts: Array<Record<string, unknown>>;
}> = [];
const providerAbortedCalls: string[] = [];
let providerDelayMs = 0;
let providerFailOnceWhenPromptIncludes: string | undefined;
let app: App | undefined;
let ownedMinio: OwnedMinioFixture | undefined;
let activeS3GenerationId = '';
let activeS3CredentialVersionRef = '';
let worker: WorkerHandle | undefined;
let managedWorkerProcess: DocumentCoreProcessType | undefined;
let lcWorker: WorkerHandle | undefined;
let connectorProviderServer: Server | undefined;
let connectorComposition: ReturnType<typeof createConnectorComposition> | undefined;
let connectorProbeDb: ReturnType<typeof createDb> | undefined;
let baseUrl = '';
let internalUrl = '';
let connectorBaseUrl = '';
let connectorProviderUrl = '';
let reservedInternalPortForCostControl: number | undefined;
let isolatedSchemaCreated = false;
let connectorSchemaCreated = false;
let namedConnectorId = '';
const workerErrorFrames: Array<{ handler: string; taskKey: string; errorName: string; frames: string[] }> = [];
const workerConnectorFailures: Array<{
  handler: string;
  taskKey: string;
  errorName: string;
  code?: string;
  status?: number;
  correlationId?: string;
  frames: string[];
}> = [];

writeFileSync(resolve(rawRoot, 'namespace.json'), JSON.stringify({
  runId: isolation.id,
  postgresSchema: isolation.context.dbSchema,
  connectorPostgresSchema: connectorIsolationContext.dbSchema,
  redis: { host: isolatedRedisUrl.hostname, port: isolatedRedisUrl.port, database: isolatedRedisUrl.pathname.slice(1), keyPrefix: isolation.context.redisPrefix, queuePrefix: isolation.context.queuePrefix },
  artifactDirectory: isolation.context.artifactDir,
  connectorArtifactDirectory: connectorIsolationContext.artifactDir,
  tenantId,
}, null, 2));

interface OperationStateRow {
  state: string;
  state_version: number;
  progress_percent: number | null;
  progress_message: string | null;
  business_id: string;
  action: string;
  error_code: string | null;
  result_ref: string | null;
  root_task_id: string;
}

function expectPrivateCallbackPayload(event: PrivateHttpsEvent | undefined, expected: Record<string, unknown>): void {
  if (!event) throw new Error('private HTTPS callback did not reach the fixture listener');
  const rawBody = event.bodyRawText;
  if (typeof rawBody !== 'string') throw new Error('private HTTPS callback fixture did not capture its synthetic body');
  const rawDigest = createHash('sha256').update(rawBody).digest('hex');
  expect(JSON.parse(rawBody)).toEqual(expected);
  expect(event.bodyJson).toEqual(expected);
  expect(event.bodyBytes).toBe(Buffer.byteLength(rawBody));
  expect(event.bodyRawBytes).toBe(Buffer.byteLength(rawBody));
  expect(event.bodySha256).toBe(rawDigest);
  expect(event.bodySha256Recomputed).toBe(rawDigest);
}

function multipart(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return body;
}

async function registerAndActivateDocumentCore(): Promise<void> {
  if (!app) throw new Error('WFA worker app is not running');
  const register = await fetch(
    `${internalUrl}/api/runtime/v1/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(documentCoreManifest),
    },
  );
  if (![200, 201].includes(register.status)) {
    throw new Error(`document-core registration returned ${register.status}: ${await register.text()}`);
  }
  for (const action of ['enable', 'activate']) {
    const response = await fetch(
      `${internalUrl}/api/v1/admin/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}/${action}`,
      { method: 'PUT', headers: { authorization: `Bearer ${adminToken}` } },
    );
    if (!(action === 'enable' ? [200] : [200, 202]).includes(response.status)) {
      throw new Error(`document-core ${action} returned ${response.status}: ${await response.text()}`);
    }
  }
}

async function registerAndActivateLcChecker(): Promise<void> {
  if (!app) throw new Error('WFA LC app is not running');
  const register = await fetch(
    `${internalUrl}/api/runtime/v1/businesses/${lcCheckerManifest.businessId}/versions/${lcCheckerManifest.version}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(lcCheckerManifest),
    },
  );
  if (![200, 201].includes(register.status)) {
    throw new Error(`lc-checker registration returned ${register.status}: ${await register.text()}`);
  }
  for (const action of ['enable', 'activate']) {
    const response = await fetch(
      `${internalUrl}/api/v1/admin/businesses/${lcCheckerManifest.businessId}/versions/${lcCheckerManifest.version}/${action}`,
      { method: 'PUT', headers: { authorization: `Bearer ${adminToken}` } },
    );
    if (!(action === 'enable' ? [200] : [200, 202]).includes(response.status)) {
      throw new Error(`lc-checker ${action} returned ${response.status}: ${await response.text()}`);
    }
  }
}

function serviceIdentityToken(scopes: readonly string[]): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({
    sub: 'wfa-local-worker',
    aud: 'connector',
    scopes,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = createHmac('sha256', connectorServiceSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve an Orchestrator internal listener port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function providerEnvelope(task: string, prompt: string, artifacts: Array<Record<string, unknown>>) {
  if(matrixProviderValue) return {content:matrixProviderValue.rawText ?? (typeof matrixProviderValue.data==='string'?matrixProviderValue.data:JSON.stringify(matrixProviderValue.data)),data:matrixProviderValue.data,usage:{inputTokens:2,outputTokens:3,costMicrousd:0,measurement:'measured'},providerRequestId:randomUUID()};
  const fileName = (artifact: Record<string, unknown> | undefined): string =>
    typeof artifact?.fileName === 'string' ? artifact.fileName : 'synthetic.pdf';
  const checkResult = {
    verdict: 'COMPLIANT',
    total_discrepancies: 0,
    major_discrepancies: 0,
    minor_discrepancies: 0,
    advisory_count: 0,
    documents_present: ['commercial-invoice.pdf', 'bill-of-lading.pdf'],
    documents_missing: [],
    discrepancies: [],
    summary: 'Synthetic offline provider result.',
    recommendation: 'ACCEPT',
  };
  let data: unknown;
  let content: string;
  if (task === 'classify_document') {
    data = {
      document_type: 'Commercial Invoice',
      confidence: 0.99,
      logical_documents: [{ label: 'Invoice', pages: 'all', confidence: 0.99, source_file: fileName(artifacts[0]) }],
    };
    content = JSON.stringify(data);
  } else if (task === 'extract_document_data') {
    data = { invoice_number: 'WFA-INV-001', amount: '10.00' };
    content = JSON.stringify(data);
  } else if (task === 'crosscheck_disbursement_documents') {
    data = { verdict: 'PASS', score: 100, summary: 'Synthetic cross-check passed.', checks: [], discrepancies: [] };
    content = JSON.stringify(data);
  } else if (task === 'generate_disbursement_report') {
    content = 'Synthetic disbursement review report.';
  } else if (task === 'extract_document_text') {
    content = `Synthetic OCR text for ${fileName(artifacts[0])}.`;
  } else if (task === 'extract_document_toc') {
    const first = /DOCUMENT 1 \(([^)]+)\):/.exec(prompt)?.[1] ?? 'compare-left.pdf';
    const second = /DOCUMENT 2 \(([^)]+)\):/.exec(prompt)?.[1] ?? 'compare-right.pdf';
    const section = [{ number: '1', title: 'Terms', level: 1, children: [] }];
    data = { doc1_name: first, doc1_toc: section, doc2_name: second, doc2_toc: section };
    content = JSON.stringify(data);
  } else if (task === 'compare_document_sections') {
    const first = /DOCUMENT 1 \(([^)]+)\):/.exec(prompt)?.[1] ?? 'compare-left.pdf';
    const second = /DOCUMENT 2 \(([^)]+)\):/.exec(prompt)?.[1] ?? 'compare-right.pdf';
    data = {
      doc1_name: first,
      doc2_name: second,
      summary: 'Synthetic documents match.',
      total_sections_doc1: 1,
      total_sections_doc2: 1,
      matched_count: 1,
      added_count: 0,
      removed_count: 0,
      modified_count: 0,
      unchanged_count: 1,
      sections: [{ section_id: '1', type: 'unchanged', changes: [], significance: 'low' }],
    };
    content = JSON.stringify(data);
  } else if (task === 'generate_document_comparison_report') {
    content = 'Synthetic document comparison report.';
  } else if (prompt.includes('high-precision Document OCR Engine')) {
    content = `Synthetic OCR text for ${fileName(artifacts[0])}.`;
  } else if (prompt.includes('senior Documentary Credit')) {
    data = checkResult;
    content = JSON.stringify(checkResult);
  } else {
    content = 'Synthetic LC checking report.';
  }
  return {
    content,
    ...(data === undefined ? {} : { data }),
    usage: { inputTokens: 2, outputTokens: 3, pages: 1, costMicrousd: 0, measurement: 'measured' as const },
    providerRequestId: `wfa-provider-${connectorProviderCalls.length + 1}`,
  };
}

async function startNamedConnectorFixture(): Promise<void> {
  if (connectorComposition && connectorProviderServer) return;
  if (reservedInternalPortForCostControl === undefined) {
    throw new Error('the Orchestrator internal listener port must be reserved before starting the real Connector cost-control client');
  }
  const providerServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', async () => {
      if (request.method !== 'POST' || request.url !== '/provider') {
        response.statusCode = 404;
        response.end();
        return;
      }
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'synthetic provider expected JSON' }));
        return;
      }
      const artifacts = Array.isArray(payload.artifacts)
        ? payload.artifacts.filter((value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value))
        : [];
      const task = typeof payload.task === 'string' ? payload.task : '';
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
      const options = typeof payload.options === 'object' && payload.options !== null && !Array.isArray(payload.options)
        ? payload.options as Record<string, unknown>
        : {};
      const observedModel = typeof payload.model === 'string'
        ? payload.model
        : typeof options.model === 'string' ? options.model : undefined;
      const workflowHeader = request.headers['x-wfa-workflow'];
      const observedWorkflowHeader = typeof workflowHeader === 'string' ? workflowHeader : undefined;
      const observedWorkflowMode = typeof payload.workflow_mode === 'string' ? payload.workflow_mode : undefined;
      connectorProviderCalls.push({
        task,
        prompt,
        ...(observedModel === undefined ? {} : { model: observedModel }),
        ...(observedWorkflowHeader === undefined ? {} : { workflowHeader: observedWorkflowHeader }),
        ...(observedWorkflowMode === undefined ? {} : { workflowMode: observedWorkflowMode }),
        artifacts,
      });
      response.on('close', () => {
        if (!response.writableEnded) providerAbortedCalls.push(task);
      });
      if (providerFailOnceWhenPromptIncludes && prompt.includes(providerFailOnceWhenPromptIncludes)) {
        providerFailOnceWhenPromptIncludes = undefined;
        response.statusCode = 503;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: 'synthetic retry fixture' }));
        return;
      }
      if (providerDelayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, providerDelayMs));
      }
      if (response.destroyed || response.writableEnded) return;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(providerEnvelope(task, prompt, artifacts)));
    });
  });
  connectorProviderServer = providerServer;
  await new Promise<void>((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', () => resolve());
  });
  const providerAddress = providerServer.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('synthetic provider did not bind');
  connectorProviderUrl = `http://127.0.0.1:${providerAddress.port}`;

  const parsedStorageKeys = parseLocalInvocationKekConfig(JSON.stringify({
    keyRef: 'wfa-connector-invocation-v1',
    activeVersion: 1,
    keys: { '1': randomBytes(32).toString('base64') },
  }));
  if (!parsedStorageKeys) throw new Error('synthetic Connector storage key configuration is missing');
  connectorComposition = createConnectorComposition({
    port: 0,
    host: '127.0.0.1',
    databaseUrl: connectorDatabaseUrl,
    redisUrl: isolation.redisUrl,
    redisKeyPrefix: `${connectorIsolationContext.redisPrefix}quota:`,
    serviceIdentityVerifier: new HmacServiceIdentityVerifier(connectorServiceSecret),
    grantVerifier: new ContractSignedGrantVerifier(
      new HmacSignedGrantSource(Buffer.from(invocationGrantSecret, 'utf8')),
    ),
    providerTestGrantVerifier: new ContractSignedProviderTestGrantVerifier(
      new HmacSignedGrantSource(Buffer.from(invocationGrantSecret, 'utf8')),
    ),
    costControl: {
      baseUrl: `http://127.0.0.1:${reservedInternalPortForCostControl}`,
      token: costControlToken,
    },
    credentialCipher: new AesCredentialCipher(randomBytes(32)),
    providerTransport: new FetchProviderTransport({ allowHosts: ['127.0.0.1'], allowPrivateNetworks: true }),
    invocationStorageCrypto: {
      fieldCrypto: createInvocationFieldCrypto(
        createLocalInvocationKekProvider(parsedStorageKeys),
        parsedStorageKeys.keyRef,
      ),
    },
    // The production entrypoint supplies this complete boot-pinned identity
    // from CONNECTOR_RUNTIME_* configuration. The isolated fixture supplies a
    // synthetic identity so normal composition installs the fail-closed
    // backup effect control; it does not inject the control port itself.
    runtimeControl: connectorRuntimeControl,
  });
  await connectorComposition.start();
  if (!connectorProbeDb) throw new Error('owned Connector schema probe is unavailable');
  const searchPath = await connectorProbeDb.query<{ search_path: string }>('SHOW search_path');
  const migrationRows = await connectorProbeDb.query<{ version: string }>(
    `SELECT version FROM connector_schema_migrations
      WHERE version = ANY($1::text[]) ORDER BY version`,
    [['012_replica_runtime_controls', '013_connector_recipe_revisions', '015_backup_effect_fences']],
  );
  const identityRows = await connectorProbeDb.query<{
    slot: string; runtime_identity: string; replica_id: string; revision: string; image_digest: string;
    control_revision: number | string; control_state: string; acknowledged_at: string | Date;
  }>(
    `SELECT slot,runtime_identity,replica_id,revision,image_digest,control_revision,control_state,acknowledged_at
       FROM connector_replica_runtime_controls WHERE replica_id=$1`,
    [connectorRuntimeControl.replicaId],
  );
  const backupGateRows = await connectorProbeDb.query<{
    singleton_id: number; state: string; fence_revision: number | string;
  }>('SELECT singleton_id,state,fence_revision FROM connector_backup_effect_gate');
  const registered = identityRows.rows[0];
  const backupGate = backupGateRows.rows[0];
  const searchPathComponents = (searchPath.rows[0]?.search_path ?? '')
    .split(',').map((part) => part.trim().replaceAll('"', '')).filter(Boolean);
  const controlEvidence = {
    schema: connectorIsolationContext.dbSchema,
    searchPath: searchPath.rows[0]?.search_path,
    searchPathComponents,
    appliedRequiredMigrations: migrationRows.rows.map((row) => row.version),
    runtimeControlIdentity: connectorRuntimeControl,
    registeredRuntimeControl: registered ? {
      slot: registered.slot,
      runtimeIdentity: registered.runtime_identity,
      replicaId: registered.replica_id,
      revision: registered.revision,
      imageDigest: registered.image_digest,
      controlRevision: Number(registered.control_revision),
      controlState: registered.control_state,
      acknowledged: Boolean(registered.acknowledged_at),
    } : null,
    backupEffectGate: backupGate ? {
      singletonId: backupGate.singleton_id,
      state: backupGate.state,
      fenceRevision: Number(backupGate.fence_revision),
    } : null,
  };
  const controlDirectory = resolve(rawRoot, 'connector-control');
  mkdirSync(controlDirectory, { recursive: true });
  writeFileSync(resolve(controlDirectory, 'normal-registration.json'), JSON.stringify(controlEvidence, null, 2));
  if (searchPathComponents.length !== 1 || searchPathComponents[0] !== connectorIsolationContext.dbSchema
      || migrationRows.rows.length !== 3
      || registered?.slot !== connectorRuntimeControl.slot
      || registered.runtime_identity !== connectorRuntimeControl.runtimeIdentity
      || registered.revision !== connectorRuntimeControl.revision
      || registered.image_digest !== connectorRuntimeControl.imageDigest
      || registered.control_state !== 'OPEN'
      || !registered.acknowledged_at
      || backupGate?.singleton_id !== 1
      || backupGate.state !== 'OPEN'
      || Number(backupGate.fence_revision) !== 0) {
    throw new Error('owned Connector schema did not register its exact runtime identity and OPEN backup effect gate');
  }
  const connectorAddress = connectorComposition.address();
  if (!connectorAddress || typeof connectorAddress === 'string') throw new Error('synthetic Connector service did not bind');
  connectorBaseUrl = `http://127.0.0.1:${connectorAddress.port}`;

  const connectorId = `wfa-${randomUUID()}`;
  const credentialRef = `wfa-${randomUUID()}`;
  const createRevision = await fetch(`${connectorBaseUrl}/connectors`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceIdentityToken(['connector:manage'])}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      connectorId,
      adapter: 'json-http',
      config: { baseUrl: connectorProviderUrl, path: '/provider', timeoutMs: 30_000 },
      credentialRef,
      state: 'ACTIVE',
    }),
  });
  if (createRevision.status !== 201) {
    throw new Error(`synthetic Connector revision returned ${createRevision.status}: ${await createRevision.text()}`);
  }
  const revisionBody = await createRevision.json() as { revision?: unknown };
  if (revisionBody.revision !== 1) throw new Error('synthetic Connector did not create revision 1');
  const rotateCredential = await fetch(`${connectorBaseUrl}/connectors/${connectorId}/credentials/rotate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceIdentityToken(['connector:manage'])}`, 'content-type': 'application/json' },
    body: JSON.stringify({ secret: `wfa-synthetic-provider-${randomUUID()}` }),
  });
  if (rotateCredential.status !== 204) {
    throw new Error(`synthetic Connector credential setup returned ${rotateCredential.status}`);
  }
  namedConnectorId = connectorId;
}

function controlSchema(slug: string, humans: number) {
  const nodes = [
    { id: 'request_value', type: 'input', key: 'reference' },
    ...Array.from({ length: humans }, (_, index) => ({
      id: `human_review_${index + 1}`,
      type: 'human',
      message: `Review checkpoint ${index + 1}`,
      resumeInputs: ['extracted_data'],
    })),
  ];
  return {
    slug,
    name: `WFA control-flow fixture ${slug}`,
    input_schema: {
      type: 'object',
      properties: { reference: { type: 'string', required: true } },
    },
    nodes,
    flow: nodes.map((node) => node.id),
    output: {
      from: 'request_value',
      ...(humans > 0 ? { extra_data_from: `human_review_${humans}` } : {}),
    },
  };
}

function parallelSchema() {
  const nodes = [
    {
      id: 'parallel_one',
      type: 'parallel',
      branches: [
        [{ id: 'first_left', type: 'input', key: 'left' }],
        [{ id: 'first_right', type: 'input', key: 'right' }],
      ],
    },
    { id: 'join_one', type: 'join', combine: 'concat' },
    {
      id: 'parallel_two',
      type: 'parallel',
      branches: [
        [{ id: 'second_left', type: 'input', key: 'left' }],
        [{ id: 'second_right', type: 'input', key: 'right' }],
      ],
    },
    { id: 'join_two', type: 'join', combine: 'first' },
  ];
  return {
    slug: 'wfa-sequential-parallel',
    name: 'WFA two parallel checkpoints with joins',
    input_schema: {
      type: 'object',
      properties: {
        left: { type: 'string', required: true },
        right: { type: 'string', required: true },
      },
    },
    nodes,
    flow: nodes.map((node) => node.id),
    output: { from: 'join_two' },
  };
}

function leafLocalSchema(slug: string) {
  const nodes = [
    { id: 'request_value', type: 'input', key: 'reference' },
    { id: 'parse_files', type: 'file_parse', source: '$files', parser: 'auto' },
    {
      id: 'generate_disbursement_report',
      type: 'connector',
      connector: 'wfa-local-mock',
      inputs: { prompt: 'Summarize the parsed source', reference: '$input.reference', files: '$files' },
    },
    { id: 'bundle_files', type: 'archive_compress', source: '$files', name: `${slug}.zip`, level: 5 },
    { id: 'unpack_bundle', type: 'archive_extract', source: '$bundle_files', destName: 'wfa-extracted', maxTotalBytes: 1048576, maxEntries: 8 },
  ];
  return {
    slug,
    name: 'WFA leaf node local execution',
    input_schema: { type: 'object', properties: { reference: { type: 'string', required: true } } },
    nodes,
    flow: nodes.map((node) => node.id),
    output: { from: 'unpack_bundle', extra_data_from: 'generate_disbursement_report' },
  };
}

function egressDeniedSchema(slug: string, nodeType: 'file_url_download' | 'callback') {
  const nodes = [
    { id: 'request_value', type: 'input', key: 'reference' },
    nodeType === 'file_url_download'
      ? { id: 'blocked_download', type: 'file_url_download', urls: '$input.target', allowedExtensions: 'txt' }
      : { id: 'blocked_callback', type: 'callback', url: '$input.target', method: 'POST' },
  ];
  return {
    slug,
    name: 'WFA egress fence fixture',
    input_schema: {
      type: 'object',
      properties: { reference: { type: 'string', required: true }, target: { type: 'string', required: true } },
    },
    nodes,
    flow: nodes.map((node) => node.id),
    output: { from: nodes[1].id },
  };
}

async function submitSchema(slug: string, reference: string): Promise<{ operationId: string; response: Response }> {
  return submitSchemaInput(slug, { reference });
}

async function submitSchemaInput(
  slug: string,
  input: Record<string, unknown>,
): Promise<{ operationId: string; response: Response }> {
  if (!baseUrl) throw new Error('WFA worker app is not listening');
  const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: multipart({ schemaSlug: slug, input: JSON.stringify(input) }),
  });
  const body = await response.json() as { name?: unknown };
  if (typeof body.name !== 'string' || !body.name.startsWith('operations/')) {
    throw new Error(`workflow submit did not return an operation name (HTTP ${response.status}): ${JSON.stringify(body)}`);
  }
  return { operationId: body.name.slice('operations/'.length), response };
}

async function submitWorkflowSchemaWithKey(
  slug: string,
  input: Record<string, unknown>,
  key: string,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  if (!baseUrl) throw new Error('WFA worker app is not listening');
  const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
    method: 'POST',
    headers: { 'x-api-key': key },
    body: multipart({ schemaSlug: slug, input: JSON.stringify(input) }),
  });
  return { response, body: await readSafeJson(response) };
}

function workflowRecipeSchema(
  slug: string,
  values: { headerName: string; headerValue: string; staticFieldName: string; staticFieldValue: string; prompt: string },
) {
  const node = {
    id: 'recipe_request',
    type: 'connector',
    connector: 'wfa-workflow-recipe',
    inputs: { prompt: values.prompt },
    overrideConnector: {
      extraHeaders: JSON.stringify([{ name: values.headerName, value: values.headerValue }]),
      staticFormFields: JSON.stringify([{ name: values.staticFieldName, value: values.staticFieldValue }]),
    },
  };
  return {
    slug,
    name: `WFA typed recipe override fixture ${slug}`,
    input_schema: { type: 'object', properties: {} },
    nodes: [node],
    flow: [node.id],
    output: { from: node.id },
  };
}

function parallelWorkflowRecipeSchema(slug: string) {
  const connectorNode = (id: string, prompt: string, headerValue: string, modeValue: string) => ({
    id,
    type: 'connector',
    connector: 'wfa-workflow-recipe',
    inputs: { prompt },
    overrideConnector: {
      extraHeaders: JSON.stringify([{ name: 'x-wfa-workflow', value: headerValue }]),
      staticFormFields: JSON.stringify([{ name: 'workflow_mode', value: modeValue }]),
    },
  });
  const nodes = [
    {
      id: 'recipe_parallel',
      type: 'parallel',
      branches: [
        [connectorNode('recipe_branch_left', 'ORV14_BRANCH_LEFT', 'branch-header-left', 'branch-mode-left')],
        [connectorNode('recipe_branch_right', 'ORV14_BRANCH_RIGHT', 'branch-header-right', 'branch-mode-right')],
      ],
    },
    { id: 'recipe_join', type: 'join', combine: 'concat' },
  ];
  return {
    slug,
    name: `WFA parallel typed recipe override fixture ${slug}`,
    input_schema: { type: 'object', properties: {} },
    nodes,
    flow: nodes.map((node) => node.id),
    output: { from: 'recipe_join' },
  };
}

async function publishWorkflowSchemaRevision(
  schema: Record<string, unknown>,
  expectedRevision: number | null,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${internalUrl}/api/v1/admin/actions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'workflow.provision', params: { tenantId, schema, expectedRevision } }),
  });
  const body = await readSafeJson(response);
  if (response.status !== 201) {
    const code = typeof body.code === 'string' ? body.code : typeof body.errorCode === 'string' ? body.errorCode : 'no-code';
    throw new Error(`workflow override fixture publication returned ${response.status} (${code})`);
  }
  const pin = body.pin;
  if (typeof pin !== 'object' || pin === null || Array.isArray(pin)) {
    throw new Error('workflow override fixture publication returned no immutable pin');
  }
  return pin as Record<string, unknown>;
}

async function publishTypedWorkflowRecipeRevision(
  connectorId: string,
  expectedHeadRevision: number,
  recipe: Record<string, unknown>,
): Promise<number> {
  const path = `/internal/admin/connector-revisions/${encodeURIComponent(connectorId)}`;
  const headers = {
    authorization: `Bearer ${serviceIdentityToken(['connector:management'])}`,
    'content-type': 'application/json',
  };
  const idempotencyKey = `orv14-vfy-workflow-recipe-${randomUUID()}`;
  const claimed = await fetch(`${connectorBaseUrl}${path}/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, expectedHeadRevision, idempotencyKey }),
  });
  if (claimed.status !== 200) throw new Error(`typed workflow recipe claim returned ${claimed.status}`);
  const drafted = await fetch(`${connectorBaseUrl}${path}/draft`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      tenantId,
      expectedHeadRevision,
      recipe,
      credentialChange: { action: 'clear', confirm: true },
      idempotencyKey,
    }),
  });
  const draftBody = await readSafeJson(drafted);
  const revisionBody = draftBody.revision;
  const revision = typeof revisionBody === 'object' && revisionBody !== null && !Array.isArray(revisionBody)
    ? (revisionBody as Record<string, unknown>).revision
    : undefined;
  const expectedRevision = expectedHeadRevision + 1;
  if (drafted.status !== 201 || revision !== expectedRevision) {
    const code = typeof draftBody.code === 'string' ? draftBody.code : 'no-code';
    throw new Error(`typed workflow recipe draft returned ${drafted.status} (${code})`);
  }
  const activated = await fetch(`${connectorBaseUrl}${path}/${expectedRevision}/activate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, expectedCurrentRevision: expectedHeadRevision }),
  });
  if (activated.status !== 200) throw new Error(`typed workflow recipe activation returned ${activated.status}`);
  return expectedRevision;
}

function typedWorkflowRecipe(revision: number): Record<string, unknown> {
  return {
    adapter: 'json-http',
    method: 'POST',
    endpointUrl: `${connectorProviderUrl}/provider`,
    auth: { kind: 'none' },
    headers: [{ name: 'x-wfa-workflow', value: `recipe-base-v${revision}` }],
    request: {
      promptField: 'prompt',
      fields: [{ name: 'workflow_mode', source: 'static', value: `recipe-default-v${revision}` }],
    },
    response: {
      contentPath: 'content',
      inputTokensPath: 'usage.inputTokens',
      outputTokensPath: 'usage.outputTokens',
    },
    session: { capture: [], inject: [] },
    timeoutMs: 30_000,
    responseBytes: 2_000_000,
  };
}

async function importAndPublishWorkflow(format: 'json' | 'xml', source: string): Promise<{
  preview: Record<string, unknown>;
  publishedPin: Record<string, unknown>;
}> {
  const previewResponse = await fetch(`${internalUrl}/api/internal/workflow-import/preview`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId, format, source }),
  });
  const preview = await previewResponse.json() as Record<string, unknown>;
  if (previewResponse.status !== 200) {
    throw new Error(`workflow ${format.toUpperCase()} import preview returned ${previewResponse.status} (${String(preview['code'] ?? 'no-code')})`);
  }
  expect(preview).toMatchObject({ tenantId, format });
  const schema = preview['schema'];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`workflow ${format.toUpperCase()} preview did not return a schema object`);
  }
  const publishResponse = await fetch(`${internalUrl}/api/v1/admin/actions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'workflow.provision',
      params: { tenantId, schema, expectedRevision: null },
    }),
  });
  const published = await publishResponse.json() as Record<string, unknown>;
  if (publishResponse.status !== 201) {
    throw new Error(`workflow ${format.toUpperCase()} publish returned ${publishResponse.status} (${String(published['code'] ?? 'no-code')})`);
  }
  const pin = published['pin'];
  if (typeof pin !== 'object' || pin === null || Array.isArray(pin)) {
    throw new Error(`workflow ${format.toUpperCase()} publish did not return an immutable schema pin`);
  }
  const publishedPin = pin as Record<string, unknown>;
  if (publishedPin['revision'] !== 1 || typeof publishedPin['digest'] !== 'string'
      || typeof publishedPin['slug'] !== 'string') {
    throw new Error(`workflow ${format.toUpperCase()} publish returned an invalid first pin`);
  }
  return { preview, publishedPin };
}

async function admittedWorkflowPin(operationId: string): Promise<{
  taskId: string;
  revision: number;
  digest: string;
  slug: string;
  schema: unknown;
  connectorSlotMap: unknown;
  connectorBindings: unknown;
  connectorRecipePins: unknown;
  pipelineDigest: string | null;
}> {
  if (!app) throw new Error('WFA worker app is not running');
  const admitted = await app.db.query<{ id: string; payload_ref: unknown; pipeline_json: unknown; connector_bindings: unknown }>(
    'SELECT t.id, t.payload_ref, o.pipeline_json, o.connector_bindings FROM tasks t JOIN operations o ON o.root_task_id=t.id WHERE o.id=$1 AND o.tenant_id=$2',
    [operationId, tenantId],
  );
  if (!admitted.rowCount || !admitted.rows[0]) throw new Error('imported workflow operation has no root task payload');
  const row = admitted.rows[0];
  const sealedPayload = typeof row.payload_ref === 'string' ? JSON.parse(row.payload_ref) as unknown : row.payload_ref;
  const payload = await metadataCrypto.readStored(sealedPayload, {
    tenantId,
    slot: 'tasks.payload_ref',
    refId: row.id,
  }, false) as { legacyWorkflowSchema?: { revision?: unknown; digest?: unknown; slug?: unknown; connectorRecipePins?: unknown } };
  const pin = payload.legacyWorkflowSchema;
  if (!pin || typeof pin.revision !== 'number' || typeof pin.digest !== 'string' || typeof pin.slug !== 'string'
      || typeof pin.schema !== 'object' || pin.schema === null) {
    throw new Error('admitted workflow task did not retain its immutable schema pin');
  }
  const pipeline = typeof row.pipeline_json === 'string' ? JSON.parse(row.pipeline_json) as unknown : row.pipeline_json;
  const marker = Array.isArray(pipeline) && typeof pipeline[0] === 'object' && pipeline[0] !== null
    ? pipeline[0] as Record<string, unknown>
    : undefined;
  const connectorBindings = typeof row.connector_bindings === 'string'
    ? JSON.parse(row.connector_bindings) as unknown
    : row.connector_bindings;
  return {
    taskId: row.id,
    revision: pin.revision,
    digest: pin.digest,
    slug: pin.slug,
    schema: pin.schema,
    connectorSlotMap: pin.connectorSlotMap ?? {},
    connectorBindings,
    connectorRecipePins: pin.connectorRecipePins ?? null,
    pipelineDigest: typeof marker?.['schemaDigest'] === 'string' ? marker['schemaDigest'] : null,
  };
}

async function publishNextWorkflowRevision(schema: Record<string, unknown>, revision: number): Promise<Record<string, unknown>> {
  const nextSchema = { ...schema, description: `post-admission revision ${revision + 1}` };
  const response = await fetch(`${internalUrl}/api/v1/admin/actions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'workflow.provision', params: { tenantId, schema: nextSchema, expectedRevision: revision } }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (response.status !== 201) {
    throw new Error(`workflow revision update returned ${response.status} (${String(body['code'] ?? 'no-code')})`);
  }
  const pin = body['pin'];
  if (typeof pin !== 'object' || pin === null || Array.isArray(pin)) throw new Error('workflow revision update returned no pin');
  const result = pin as Record<string, unknown>;
  if (result['revision'] !== revision + 1 || typeof result['digest'] !== 'string') {
    throw new Error('workflow revision update returned an invalid immutable pin');
  }
  return result;
}

async function submitNamedDocCompareWithOneFile(): Promise<{ operationId: string; response: Response }> {
  if (!baseUrl) throw new Error('WFA worker app is not listening');
  const body = new FormData();
  body.append('process', 'doc-compare');
  body.append('file', new File([Buffer.from('synthetic one-file document')], 'one.pdf', { type: 'application/pdf' }));
  const response = await fetch(`${baseUrl}/api/v1/docs/workflows`, {
    method: 'POST',
    headers: { 'x-api-key': namedApiKey },
    body,
  });
  const envelope = await response.json() as { name?: unknown };
  if (typeof envelope.name !== 'string' || !envelope.name.startsWith('operations/')) {
    throw new Error(`named workflow submit did not return an operation name (HTTP ${response.status}): ${JSON.stringify(envelope)}`);
  }
  return { operationId: envelope.name.slice('operations/'.length), response };
}

async function submitNamed(
  processName: string,
  files: readonly { name: string; content: string }[],
  variables: Record<string, string>,
  key: string,
): Promise<{ operationId: string; response: Response; body: Record<string, unknown> }> {
  if (!baseUrl) throw new Error('WFA worker app is not listening');
  const body = new FormData();
  body.append('process', processName);
  for (const [name, value] of Object.entries(variables)) body.append(name, value);
  for (const file of files) {
    body.append('file', new File([Buffer.from(file.content)], file.name, { type: 'application/pdf' }));
  }
  const response = await fetch(`${baseUrl}/api/v1/docs/workflows`, {
    method: 'POST',
    headers: { 'x-api-key': key },
    body,
  });
  const rawBody = await response.text();
  let envelope: Record<string, unknown> = {};
  try {
    envelope = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    envelope = { rawBody };
  }
  const name = envelope.name;
  if (typeof name !== 'string' || !name.startsWith('operations/')) {
    throw new Error(`named workflow submit did not return an operation name (HTTP ${response.status}): ${rawBody}`);
  }
  return { operationId: name.slice('operations/'.length), response, body: envelope };
}

async function submitSchemaWithFile(
  slug: string,
  input: Record<string, unknown>,
  file: { name: string; content: string },
): Promise<{ operationId: string; response: Response }> {
  if (!baseUrl) throw new Error('WFA worker app is not listening');
  const body = new FormData();
  body.append('schemaSlug', slug);
  body.append('input', JSON.stringify(input));
  body.append('file', new File([Buffer.from(file.content)], file.name, { type: 'text/plain' }));
  const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
    method: 'POST',
    headers: { 'x-api-key': leafApiKey },
    body,
  });
  const parsed = await response.json() as { name?: unknown };
  if (typeof parsed.name !== 'string' || !parsed.name.startsWith('operations/')) {
    throw new Error(`schema submit with file failed (HTTP ${response.status}): ${JSON.stringify(parsed)}`);
  }
  return { operationId: parsed.name.slice('operations/'.length), response };
}

async function submitLeafSchemaInput(slug: string, input: Record<string, unknown>): Promise<{ operationId: string; response: Response }> {
  if (!baseUrl) throw new Error('WFA worker app is not listening');
  const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
    method: 'POST',
    headers: { 'x-api-key': leafApiKey },
    body: multipart({ schemaSlug: slug, input: JSON.stringify(input) }),
  });
  const parsed = await response.json() as { name?: unknown };
  if (typeof parsed.name !== 'string' || !parsed.name.startsWith('operations/')) {
    throw new Error(`leaf schema submit failed (HTTP ${response.status}): ${JSON.stringify(parsed)}`);
  }
  return { operationId: parsed.name.slice('operations/'.length), response };
}

async function stateOf(operationId: string): Promise<OperationStateRow> {
  if (!app) throw new Error('WFA worker app is not running');
  const result = await app.db.query<OperationStateRow>(
    `SELECT o.state, o.state_version, o.progress_percent, o.progress_message,
            o.business_id, o.action, o.error_code, o.result_ref, o.root_task_id
     FROM operations o WHERE o.id=$1 AND o.tenant_id=$2`,
    [operationId, tenantId],
  );
  if (!result.rowCount) throw new Error('operation is absent from the isolated tenant database');
  return result.rows[0]!;
}

async function waitForState(operationId: string, expected: readonly string[], timeoutMs = 45_000): Promise<OperationStateRow> {
  const deadline = Date.now() + timeoutMs;
  let last: OperationStateRow | undefined;
  while (Date.now() < deadline) {
    last = await stateOf(operationId);
    if (expected.includes(last.state) || ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(last.state)) return last;
    const failedChild = await app!.db.query(
      `SELECT id FROM tasks WHERE operation_id=$1 AND parent_id IS NOT NULL
        AND state IN ('FAILED','CANCELLED','TIMED_OUT') LIMIT 1`,
      [operationId],
    );
    if (failedChild.rowCount) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${expected.join('|')}; last state was ${last?.state ?? 'unknown'}`);
}

async function waitForCondition(
  probe: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function dispatchAndWait(operationId: string, expected: readonly string[]): Promise<OperationStateRow> {
  if (!app) throw new Error('WFA worker app is not running');
  await app.dispatcher.dispatchOnce();
  return waitForState(operationId, expected);
}

async function dispatchUntilState(
  operationId: string,
  expected: readonly string[],
  timeoutMs = 90_000,
): Promise<OperationStateRow> {
  if (!app) throw new Error('WFA worker app is not running');
  const deadline = Date.now() + timeoutMs;
  let last: OperationStateRow | undefined;
  while (Date.now() < deadline) {
    await app.dispatcher.dispatchOnce();
    last = await stateOf(operationId);
    if (expected.includes(last.state) || ['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(last.state)) return last;
    const failedChild = await app.db.query(
      `SELECT id FROM tasks WHERE operation_id=$1 AND parent_id IS NOT NULL
        AND state IN ('FAILED','CANCELLED','TIMED_OUT') LIMIT 1`,
      [operationId],
    );
    if (failedChild.rowCount) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out dispatching descendants while waiting for ${expected.join('|')}; last state was ${last?.state ?? 'unknown'}`);
}

function captureHandlerExceptionFrames(): void {
  for (const kind of ['schema-workflow', 'legacy-workflow-branch'] as const) {
    const original = documentCoreHandlers[kind];
    if (!original) throw new Error(`WFA production handler ${kind} is not registered`);
    documentCoreHandlers[kind] = async (context, payload) => {
      const contextRecord = context as unknown as {
        taskKey?: unknown;
        connector?: { invoke: (...args: unknown[]) => Promise<unknown> };
      };
      const taskKey = String(contextRecord.taskKey ?? 'unknown');
      const connector = contextRecord.connector;
      if (connector && typeof connector.invoke === 'function') {
        const originalInvoke = connector.invoke.bind(connector);
        connector.invoke = async (...args: unknown[]) => {
          try {
            return await originalInvoke(...args);
          } catch (error: unknown) {
            workerConnectorFailures.push({ handler: kind, taskKey, ...safeConnectorFailure(error) });
            throw error;
          }
        };
      }
      try {
        return await original(context, payload);
      } catch (error: unknown) {
        if (error instanceof Error) {
          // A parser message can quote payload bytes, so this temporary
          // verifier trace retains stack frames only, never the message.
          const frames = (error.stack ?? '').split(/\r?\n/).slice(1, 13).map((frame) => frame.trim());
          workerErrorFrames.push({ handler: kind, taskKey, errorName: error.name, frames });
        }
        throw error;
      }
    };
  }
}

function recentWorkerErrorFrames(): string {
  return workerErrorFrames.slice(-4)
    .map((entry) => `${entry.handler} task=${entry.taskKey} ${entry.errorName}\n${entry.frames.join('\n')}`)
    .join('\n');
}

function safeConnectorFailure(error: unknown): {
  errorName: string;
  code?: string;
  status?: number;
  correlationId?: string;
  frames: string[];
} {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const problem = value.problem && typeof value.problem === 'object' ? value.problem as Record<string, unknown> : {};
  const codeValue = typeof value.code === 'string' ? value.code : typeof problem.code === 'string' ? problem.code : undefined;
  const statusValue = typeof value.status === 'number' ? value.status : typeof problem.status === 'number' ? problem.status : undefined;
  const correlationValue = typeof value.correlationId === 'string' ? value.correlationId
    : typeof problem.correlationId === 'string' ? problem.correlationId : undefined;
  const frames = error instanceof Error ? (error.stack ?? '').split(/\r?\n/).slice(1, 13).map((frame) => frame.trim()) : [];
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(codeValue && /^[A-Z][A-Z0-9_]{0,63}$/.test(codeValue) ? { code: codeValue } : {}),
    ...(statusValue && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? { status: statusValue } : {}),
    ...(correlationValue && /^[A-Za-z0-9_-]{1,80}$/.test(correlationValue) ? { correlationId: correlationValue } : {}),
    frames,
  };
}

async function captureWorkflowInvocationEvidence(
  operationId: string,
  providerCallStart: number,
  admitted: Awaited<ReturnType<typeof admittedWorkflowPin>>,
): Promise<Record<string, unknown>> {
  if (!app || !connectorProbeDb) throw new Error('workflow failure diagnostics require the owned app and Connector probe');
  const [operationRows, taskRows, grantRows, connectorRows, reservationRows, holdRows] = await Promise.all([
    app.db.query<{
      id: string; state: string; error_code: string | null; root_task_id: string | null; correlation_id: string;
    }>(
      'SELECT id::text,state,error_code,root_task_id::text,correlation_id FROM operations WHERE id=$1 AND tenant_id=$2',
      [operationId, tenantId],
    ),
    app.db.query<{
      id: string; task_key: string; kind: string; state: string; attempt: number; error_code: string | null;
    }>(
      'SELECT id::text,task_key,kind,state,attempt,error_code FROM tasks WHERE operation_id=$1 ORDER BY task_key',
      [operationId],
    ),
    app.db.query<{
      task_id: string; step_key: string; invocation_id: string; input_hash: string;
      connector_id: string; connector_revision: number; binding_slot: string; grant_token: string;
    }>(
      `SELECT task_id::text,step_key,invocation_id,input_hash,connector_id,connector_revision,binding_slot,grant_token
         FROM invocation_grants WHERE operation_id=$1 ORDER BY created_at,task_id,step_key`,
      [operationId],
    ),
    connectorProbeDb.query<{
      invocation_id: string; task_id: string; step_key: string; input_hash: string; state: string; error_code: string | null;
    }>(
      `SELECT invocation_id,task_id,step_key,input_hash,state,error_code
         FROM connector_invocations WHERE operation_id=$1 ORDER BY created_at,invocation_id`,
      [operationId],
    ),
    app.db.query<{
      reservation_group_id: string; task_id: string; invocation_id: string; attempt: number; decision: string;
      state: string; confidence: string; reservation_bounded: boolean; state_reason: string | null; usage_event_id: string | null;
    }>(
      `SELECT reservation_group_id::text,task_id::text,invocation_id,attempt,decision,state,confidence,
              reservation_bounded,state_reason,usage_event_id
         FROM cost_reservation_groups WHERE operation_id=$1 ORDER BY created_at,reservation_group_id`,
      [operationId],
    ),
    app.db.query<{ reservation_group_id: string; state: string; count: string }>(
      `SELECT h.reservation_group_id::text,h.state,count(*)::text AS count
         FROM cost_budget_holds h JOIN cost_reservation_groups g USING (reservation_group_id)
        WHERE g.operation_id=$1 GROUP BY h.reservation_group_id,h.state ORDER BY h.reservation_group_id,h.state`,
      [operationId],
    ),
  ]);

  const recipePins = admitted.connectorRecipePins && typeof admitted.connectorRecipePins === 'object'
    && !Array.isArray(admitted.connectorRecipePins)
    ? admitted.connectorRecipePins as Record<string, ConnectorWorkflowOverrides>
    : {};
  const grantEvidence = grantRows.rows.map((row) => {
    let signatureValid = false;
    let signedWorkflowOverridesDigest: string | null = null;
    const parts = row.grant_token.split('.');
    if (parts.length === 3 && parts.every((part) => part.length > 0)) {
      try {
        const expectedSignature = createHmac('sha256', Buffer.from(invocationGrantSecret, 'utf8'))
          .update(`${parts[0]}.${parts[1]}`).digest();
        const actualSignature = Buffer.from(parts[2]!, 'base64url');
        signatureValid = expectedSignature.length === actualSignature.length
          && timingSafeEqual(expectedSignature, actualSignature);
        if (signatureValid) {
          const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
          signedWorkflowOverridesDigest = typeof claims.workflowOverridesDigest === 'string'
            && /^[a-f0-9]{64}$/.test(claims.workflowOverridesDigest)
            ? claims.workflowOverridesDigest : null;
        }
      } catch {
        signatureValid = false;
      }
    }
    const nodeId = row.step_key.split(':').at(-1) ?? '';
    const override = recipePins[nodeId];
    const expectedWorkflowOverridesDigest = override ? workflowOverridesDigest({
      tenantId,
      operationId,
      taskId: row.task_id,
      stepKey: row.step_key,
      invocationId: row.invocation_id,
      connectorId: row.connector_id,
      connectorRevision: row.connector_revision,
      workflowOverrides: override,
    }) : null;
    return {
      taskId: row.task_id,
      stepKey: row.step_key,
      invocationId: row.invocation_id,
      inputHash: row.input_hash,
      connectorId: row.connector_id,
      connectorRevision: row.connector_revision,
      bindingSlot: row.binding_slot,
      grantSignatureValid: signatureValid,
      signedWorkflowOverridesDigest,
      expectedWorkflowOverridesDigest,
      workflowOverridesDigestMatches: signedWorkflowOverridesDigest !== null && expectedWorkflowOverridesDigest !== null
        ? signedWorkflowOverridesDigest === expectedWorkflowOverridesDigest : null,
    };
  });

  return {
    operation: operationRows.rows.map(({ id, state, error_code, root_task_id, correlation_id }) => ({
      id, state, errorCode: error_code, rootTaskId: root_task_id, correlationId: correlation_id,
    })),
    tasks: taskRows.rows,
    grants: grantEvidence,
    connectorInvocations: connectorRows.rows,
    costReservationGroups: reservationRows.rows,
    costBudgetHoldStates: holdRows.rows,
    sdkConnectorFailures: workerConnectorFailures.slice(-8),
    workerErrorFrames: workerErrorFrames.slice(-8),
    boundedProviderCallDelta: Math.max(0, connectorProviderCalls.length - providerCallStart),
  };
}

async function startDocumentCoreWorkerWithConcurrency(concurrency: number): Promise<WorkerHandle> {
  return startDocumentCoreWorker({
    runtimeUrl: `${internalUrl}/api/runtime/v1`,
    runtimeToken: workerIdentityToken,
    connectorUrl: connectorBaseUrl,
    connectorServiceToken: () => serviceIdentityToken(['connector:invoke']),
    redis: { url: isolation.redisUrl },
    crypto: {
      facade: new CryptoStorageFacade(keyProvider),
      keyRef: 'du-wfa-synthetic-artifacts-v1',
    },
    encryptionEnabled: true,
    workerInstanceId: `wfa-schema-worker-${randomUUID()}`,
    concurrency,
    heartbeatIntervalMs: 1_000,
  });
}

async function changeDocumentCoreWorkerConcurrency(concurrency: number): Promise<void> {
  if (!worker) throw new Error('WFA document-core worker is not running');
  await worker.stop(5_000);
  worker = await startDocumentCoreWorkerWithConcurrency(concurrency);
}

async function readSafeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json() as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeProblemFields(value: Record<string, unknown>): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  for (const name of ['code', 'title', 'status', 'correlationId'] as const) {
    const item = value[name];
    if (typeof item === 'string' || typeof item === 'number') fields[name] = item;
  }
  return fields;
}

async function captureProviderTestStateEvidence(idempotencyKey: string, providerCallCountBefore: number): Promise<Record<string, unknown>> {
  if (!app) return { orchestratorRows: 'app-unavailable' };
  const idempotencyHash = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
  const runResult = await app.db.query<{
    state: string;
    state_version: number;
    operation_id: string;
    task_id: string;
    invocation_id: string;
    connector_id: string;
    connector_revision: number;
    budget_reservation_group_id: string;
    result_state: string | null;
    result_error_code: string | null;
  }>(
    `SELECT state,state_version,operation_id,task_id,invocation_id,connector_id,connector_revision,
            budget_reservation_group_id,result->>'state' AS result_state,result->>'errorCode' AS result_error_code
       FROM admin_connector_test_runs WHERE tenant_id=$1 AND idempotency_hash=$2`,
    [tenantId, idempotencyHash],
  );
  const run = runResult.rows[0];
  if (!run) {
    return {
      orchestratorRunCount: runResult.rowCount ?? 0,
      providerCallCountDelta: connectorProviderCalls.length - providerCallCountBefore,
    };
  }
  const [operationResult, taskResult, costResult] = await Promise.all([
    app.db.query<{ state: string; error_code: string | null }>(
      'SELECT state,error_code FROM operations WHERE id=$1 AND tenant_id=$2', [run.operation_id, tenantId],
    ),
    app.db.query<{ state: string; error_code: string | null }>(
      'SELECT state,error_code FROM tasks WHERE id=$1 AND operation_id=$2', [run.task_id, run.operation_id],
    ),
    app.db.query<{ state: string; confidence: string; reservation_bounded: boolean }>(
      `SELECT state,confidence,reservation_bounded FROM cost_reservation_groups
        WHERE reservation_group_id=$1 AND tenant_id=$2`, [run.budget_reservation_group_id, tenantId],
    ),
  ]);
  const query = new URLSearchParams({
    tenantId,
    operationId: run.operation_id,
    taskId: run.task_id,
    connectorId: run.connector_id,
    revision: String(run.connector_revision),
  });
  let connectorEvidence: Record<string, unknown> = { status: 'not-requested' };
  try {
    const response = await fetch(
      `${connectorBaseUrl}/internal/admin/provider-test-invocations/${encodeURIComponent(run.invocation_id)}?${query.toString()}`,
      { headers: { authorization: `Bearer ${serviceIdentityToken(['connector:provider-test'])}` } },
    );
    const body = await readSafeJson(response);
    connectorEvidence = {
      status: response.status,
      ...safeProblemFields(body),
      ...(typeof body.state === 'string' ? { state: body.state } : {}),
      ...(Number.isSafeInteger(body.stateVersion) ? { stateVersion: body.stateVersion } : {}),
      ...(typeof body.errorCode === 'string' || body.errorCode === null ? { errorCode: body.errorCode } : {}),
      ...(typeof body.recoveryReady === 'boolean' ? { recoveryReady: body.recoveryReady } : {}),
      resultPresent: body.result !== null && body.result !== undefined,
      usageEventPresent: body.usageEvent !== null && body.usageEvent !== undefined,
      ...(typeof body.evidenceDigest === 'string' ? { evidenceDigest: body.evidenceDigest } : {}),
    };
  } catch (error: unknown) {
    connectorEvidence = { status: 'request-failed', errorName: error instanceof Error ? error.name : 'UnknownError' };
  }
  return {
    providerTestRun: {
      state: run.state,
      stateVersion: run.state_version,
      resultState: run.result_state,
      resultErrorCode: run.result_error_code,
      operationId: run.operation_id,
      taskId: run.task_id,
      invocationId: run.invocation_id,
      connectorId: run.connector_id,
      connectorRevision: run.connector_revision,
      reservationGroupId: run.budget_reservation_group_id,
    },
    operation: operationResult.rows[0] ?? null,
    task: taskResult.rows[0] ?? null,
    costReservation: costResult.rows[0] ?? null,
    connectorEvidence,
    providerCallCountDelta: connectorProviderCalls.length - providerCallCountBefore,
  };
}

async function stageAndActivateEncryptedS3Generation(): Promise<void> {
  if (!app || !ownedMinio) throw new Error('owned MinIO and Orchestrator app must be ready before storage generation setup');

  // Create the immutable credential through the real write-only catalog API.
  // It remains in memory only in this request and is never written to raw output.
  // Admin routes are exposed on the internal listener; the public listener
  // intentionally returns a generic 404 for this family.
  const secretResponse = await fetch(`${internalUrl}/api/v1/admin/secrets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId,
      name: 'ORV14 worker verifier isolated S3 credential',
      purpose: 'storage.credential',
      services: ['orchestrator'],
      provider: { kind: 'managed_value' },
      value: { kind: 'literal', value: JSON.stringify({
        accessKeyId: ownedMinio.accessKeyId,
        secretAccessKey: ownedMinio.secretAccessKey,
      }) },
    }),
  });
  const secret = await readSafeJson(secretResponse);
  if (secretResponse.status !== 201 || typeof secret['secretId'] !== 'string'
      || typeof secret['revision'] !== 'number' || secret['revision'] !== 1) {
    throw new Error(`normal Secret Catalog credential creation returned ${secretResponse.status}: ${JSON.stringify(safeProblemFields(secret))}`);
  }
  const credentialVersionRef = `${secret['secretId']}@${secret['revision']}`;

  const auth = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const currentResponse = await fetch(`${internalUrl}/api/internal/maintenance/storage-generations/current`, { headers: auth });
  const current = await readSafeJson(currentResponse);
  const expectedRevision = current['controlRevision'];
  if (currentResponse.status !== 200 || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision)) {
    throw new Error(`normal storage generation current read returned ${currentResponse.status}: ${JSON.stringify(safeProblemFields(current))}`);
  }

  const stageResponse = await fetch(`${internalUrl}/api/internal/maintenance/storage-generations/stage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      expectedRevision,
      idempotencyKey: `orv14-worker-s3-stage-${randomUUID()}`,
      reason: 'ORV14 independent encrypted Worker upload verifier',
      backend: 's3',
      endpoint: ownedMinio.endpoint,
      bucket: ownedMinio.bucket,
      region: 'us-east-1',
      forcePathStyle: true,
      credentialVersionRef,
      credentialOwnerTenantId: tenantId,
      urlTtlSeconds: null,
    }),
  });
  const staged = await readSafeJson(stageResponse);
  const generationId = staged['generationId'];
  if (stageResponse.status !== 201 || typeof generationId !== 'string'
      || staged['state'] !== 'STAGED' || staged['backend'] !== 's3'
      || staged['credentialVersionRef'] !== credentialVersionRef
      || staged['credentialOwnerTenantId'] !== tenantId) {
    throw new Error(`normal storage generation stage returned ${stageResponse.status}: ${JSON.stringify(safeProblemFields(staged))}`);
  }

  const testResponse = await fetch(`${internalUrl}/api/internal/maintenance/storage-generations/${encodeURIComponent(generationId)}/test`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      idempotencyKey: `orv14-worker-s3-test-${randomUUID()}`,
      reason: 'ORV14 independent encrypted Worker upload verifier',
    }),
  });
  const storageTest = await readSafeJson(testResponse);
  const expectedPassedStages = ['write', 'read', 'checksum', 'crypto', 'delete'] as const;
  if (testResponse.status !== 200 || storageTest['status'] !== 'PASSED'
      || expectedPassedStages.some((stage) => storageTest[stage] !== 'PASSED')) {
    throw new Error(`normal storage generation test returned ${testResponse.status}: ${JSON.stringify(safeProblemFields(storageTest))}`);
  }

  const activationResponse = await fetch(`${internalUrl}/api/internal/maintenance/storage-generations/${encodeURIComponent(generationId)}/activate`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      expectedRevision,
      idempotencyKey: `orv14-worker-s3-activate-${randomUUID()}`,
      reason: 'ORV14 independent encrypted Worker upload verifier',
    }),
  });
  const activation = await readSafeJson(activationResponse);
  const active = activation['active'];
  if (activationResponse.status !== 200 || typeof active !== 'object' || active === null
      || (active as Record<string, unknown>)['generationId'] !== generationId
      || (active as Record<string, unknown>)['state'] !== 'ACTIVE'
      || (active as Record<string, unknown>)['backend'] !== 's3') {
    throw new Error(`normal storage generation activation returned ${activationResponse.status}: ${JSON.stringify(safeProblemFields(activation))}`);
  }

  const verifyCurrentResponse = await fetch(`${internalUrl}/api/internal/maintenance/storage-generations/current`, { headers: auth });
  const verifiedCurrent = await readSafeJson(verifyCurrentResponse);
  if (verifyCurrentResponse.status !== 200 || verifiedCurrent['generationId'] !== generationId
      || verifiedCurrent['credentialVersionRef'] !== credentialVersionRef
      || verifiedCurrent['credentialOwnerTenantId'] !== tenantId) {
    throw new Error(`normal storage generation current pin returned ${verifyCurrentResponse.status}: ${JSON.stringify(safeProblemFields(verifiedCurrent))}`);
  }

  activeS3GenerationId = generationId;
  activeS3CredentialVersionRef = credentialVersionRef;
  const directory = resolve(rawRoot, 'storage-generation');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'activation.json'), JSON.stringify({
    minio: {
      runId: ownedMinio.receipt.runId,
      projectLabel: ownedMinio.receipt.projectLabel,
      containerName: ownedMinio.receipt.containerName,
      image: ownedMinio.receipt.image,
      imageId: ownedMinio.receipt.imageId,
      endpoint: ownedMinio.endpoint,
      bucket: ownedMinio.bucket,
      versioning: ownedMinio.receipt.versioning,
      accessKeyIdLength: ownedMinio.receipt.accessKeyIdLength,
      secretAccessKeyLength: ownedMinio.receipt.secretAccessKeyLength,
    },
    secretCatalog: { secretId: secret['secretId'], revision: secret['revision'], credentialVersionRef, tenantId },
    storageGeneration: {
      initialControlRevision: expectedRevision,
      stagedGenerationId: generationId,
      stagedRevision: staged['revision'],
      test: storageTest,
      activeGenerationId: activeS3GenerationId,
      activeCredentialVersionRef: activeS3CredentialVersionRef,
      activeCredentialOwnerTenantId: (active as Record<string, unknown>)['credentialOwnerTenantId'],
      currentControlRevision: verifiedCurrent['controlRevision'],
    },
  }, null, 2));
}

async function poll(operationId: string, key = apiKey): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1/operations/${operationId}`, {
    headers: { 'x-api-key': key },
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe('ORV14 independent public HTTP compatibility with real outbox, worker, and Connector', () => {
  beforeAll(async () => {
    process.env.DU_ADMIN_WEB='1';process.env.DU_ADMIN_WEB_DIST=resolve('orchestrator/apps/admin-web/dist');
    await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
    isolatedSchemaCreated = true;
    await baseDb.query(`CREATE SCHEMA "${connectorIsolationContext.dbSchema}"`);
    connectorSchemaCreated = true;
    connectorProbeDb = createDb(connectorDatabaseUrl);
    // Named disbursement/lc-checker/document-core connector stages run against
    // this loopback Connector + provider pair, so the app must be wired to it.
    reservedInternalPortForCostControl = await reserveLoopbackPort();
    await startNamedConnectorFixture();
    ownedMinio = await startOwnedMinioFixture(isolation.id);
    const priorSeed = process.env.DU_SEED_DEV_FALLBACK;
    process.env.DU_SEED_DEV_FALLBACK = 'false';
    try {
      app = await createApp({
        host: '127.0.0.1',
        port: 0,
        internalHost: '127.0.0.1',
        internalPort: reservedInternalPortForCostControl,
        databaseUrl: isolation.databaseUrl,
        redisUrl: isolation.redisUrl,
        runtimeToken,
        workerIdentityTokensByBusiness: {
          'document-core': workerIdentityToken,
          'lc-checker': lcWorkerIdentityToken,
        },
        connectorBaseUrls: {
          [namedConnectorId]: connectorBaseUrl,
          [openAiConnectorId]: connectorBaseUrl,
          [geminiConnectorId]: connectorBaseUrl,
          [workflowConnectorId]: connectorBaseUrl,
          [workflowBranchConnectorId]: connectorBaseUrl,
        },
        connectorId: namedConnectorId,
        connectorRevision: 1,
        connectorManagementAuthorizationForRequest: createConnectorManagementAuthorizationProvider(connectorServiceSecret),
        invocationGrantSecret,
        costControlToken,
        adminToken, adminShellCookieSecret:browserCookieSecret,adminShellHost:'127.0.0.1',adminShellPort:0,
        serviceRuntime: {
          serviceRuntimeId,
          runtimeIdentity: serviceRuntimeId,
          replicaId: serviceRuntimeId,
          slot: 'blue',
          revision: 'wfa-vfy-1',
          imageDigest: serviceRuntimeImageDigest,
          controlToken: serviceRuntimeControlToken,
        },
        secretCatalogKeyring,
        storageEndpointAllowlist: [ownedMinio.endpoint],
        autoMigrate: true,
        autoDispatch: false,
        leaseRecoveryIntervalMs: 0,
        publicUploadEncryption: { keyProvider, keyRef: 'du-wfa-synthetic-artifacts-v1' },
        metadataEncryption: { keyProvider, keyRef: 'du-orch-metadata-v1' },
      });
    } finally {
      if (priorSeed === undefined) delete process.env.DU_SEED_DEV_FALLBACK;
      else process.env.DU_SEED_DEV_FALLBACK = priorSeed;
    }
    const server = await app.listen();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Orchestrator did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
    const internalAddress = app.internalServer.address();
    if (!internalAddress || typeof internalAddress === 'string') throw new Error('Orchestrator internal listener did not bind a TCP port');
    internalUrl = `http://127.0.0.1:${(internalAddress as AddressInfo).port}`;
    if ((internalAddress as AddressInfo).port !== reservedInternalPortForCostControl) {
      throw new Error('Orchestrator internal listener did not bind the exact port reserved for the real Connector cost-control client');
    }
    await registerAndActivateDocumentCore();
    await registerAndActivateLcChecker();

    await app.db.query('INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)', [
      tenantId, 'WFA worker tenant', otherTenantId, 'WFA other tenant',
    ]);
    await app.db.query(
      `INSERT INTO api_keys (tenant_id, hash, prefix, status)
       VALUES ($1, $2, 'wfa-worker', 'ACTIVE'), ($1, $3, 'wfa-named', 'ACTIVE'), ($1, $6, 'wfa-disbursement', 'ACTIVE'),
              ($1, $7, 'wfa-lc-checker', 'ACTIVE'), ($1, $8, 'wfa-leaf', 'ACTIVE'),
              ($1, $9, 'wfa-override', 'ACTIVE'), ($1, $10, 'wfa-override-branch', 'ACTIVE'),
              ($4, $5, 'wfa-other', 'ACTIVE')`,
      [tenantId, apiKeyHash, namedApiKeyHash, otherTenantId, otherApiKeyHash, disbursementApiKeyHash, lcApiKeyHash, leafApiKeyHash, workflowOverrideApiKeyHash, workflowBranchApiKeyHash],
    );
    await stageAndActivateEncryptedS3Generation();
    // doc-compare declares a required reasoning connector. Its bindings point
    // at the loopback Connector from startNamedConnectorFixture so the
    // two-file case runs real provider stages; the one-file case still fails
    // in the worker on its document-count guard, before any provider call.
    await createProfileService(app.db).createRevision({
      apiKeyHash: namedApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'doc-compare',
      connectorBindings: {
        'legacy-ocr': { connectorId: namedConnectorId, revision: 1 },
        'legacy-toc': { connectorId: namedConnectorId, revision: 1 },
        'legacy-compare': { connectorId: namedConnectorId, revision: 1 },
        'legacy-report': { connectorId: namedConnectorId, revision: 1 },
      },
    });
    await createProfileService(app.db).createRevision({
      apiKeyHash: disbursementApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'disbursement',
      connectorBindings: {
        classify: { connectorId: namedConnectorId, revision: 1 },
        extract: { connectorId: namedConnectorId, revision: 1 },
        crosscheck: { connectorId: namedConnectorId, revision: 1 },
        report: { connectorId: namedConnectorId, revision: 1 },
      },
    });
    await createProfileService(app.db).createRevision({
      apiKeyHash: lcApiKeyHash,
      businessId: 'lc-checker',
      businessVersion: lcCheckerManifest.version,
      action: 'lc-checker',
      connectorBindings: {
        'legacy-ocr': { connectorId: namedConnectorId, revision: 1 },
        'legacy-compliance': { connectorId: namedConnectorId, revision: 1 },
        'legacy-report': { connectorId: namedConnectorId, revision: 1 },
      },
    });
    await provisionLegacyWorkflowSchema(app.db, {
      tenantId,
      schema: controlSchema('wfa-input-only', 0),
    }, metadataCrypto);
    await provisionLegacyWorkflowSchema(app.db, {
      tenantId,
      schema: controlSchema('wfa-human-one', 1),
    }, metadataCrypto);
    await provisionLegacyWorkflowSchema(app.db, {
      tenantId,
      schema: controlSchema('wfa-human-two', 2),
    }, metadataCrypto);
    await provisionLegacyWorkflowSchema(app.db, {
      tenantId,
      schema: controlSchema('wfa-cancel-wait', 1),
    }, metadataCrypto);
    await provisionLegacyWorkflowSchema(app.db, {
      tenantId,
      schema: parallelSchema(),
    }, metadataCrypto);
    // Muc 3: leaf-node coverage. file_parse/connector/archive_compress/
    // archive_extract run locally; the two egress nodes are admitted with an
    // approved origin so the client-supplied destination can be denied at run
    // time instead of at provisioning.
    const leafLocalPin = await provisionLegacyWorkflowSchema(app.db, {
      tenantId,
      schema: leafLocalSchema('wfa-leaf-local'),
    }, metadataCrypto);
    for (const nodeType of ['file_url_download', 'callback'] as const) {
      await provisionLegacyWorkflowSchema(app.db, {
        tenantId,
        schema: egressDeniedSchema(`wfa-leaf-egress-${nodeType}`, nodeType),
        approvedEgressOrigins: ['https://approved.wfa.test'],
      }, metadataCrypto);
    }
    const leafConnectorSlot = leafLocalPin.connectorSlotMap?.['wfa-local-mock'];
    if (typeof leafConnectorSlot !== 'string') {
      throw new Error('WFA leaf connector slot was not allocated by the schema catalog');
    }
    await createProfileService(app.db).createRevision({
      apiKeyHash: leafApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'schema-workflow',
      connectorBindings: {
        [leafConnectorSlot]: { connectorId: namedConnectorId, revision: 1 },
      },
    });
    await provisionLegacyWorkflowSchema(app.db, {
      tenantId: otherTenantId,
      schema: controlSchema('wfa-no-artifact-encryption', 0),
    }, metadataCrypto);

    captureHandlerExceptionFrames();
    worker = await startDocumentCoreWorkerWithConcurrency(2);
    lcWorker = await startLcCheckerWorker({
      runtimeUrl: `${internalUrl}/api/runtime/v1`,
      runtimeToken: lcWorkerIdentityToken,
      connectorUrl: connectorBaseUrl,
      connectorServiceToken: () => serviceIdentityToken(['connector:invoke']),
      redis: { url: isolation.redisUrl },
      crypto: {
        facade: new CryptoStorageFacade(keyProvider),
        keyRef: 'du-wfa-synthetic-artifacts-v1',
      },
      encryptionEnabled: true,
      workerInstanceId: `wfa-lc-worker-${randomUUID()}`,
      concurrency: 1,
      heartbeatIntervalMs: 1_000,
    });
  }, 120_000);

  afterAll(async () => {
    const cleanupFailures: string[] = [];
    let postgresSchemaAbsent = !isolatedSchemaCreated;
    let connectorPostgresSchemaAbsent = !connectorSchemaCreated;
    try { if (lcWorker) await lcWorker.stop(5_000); } catch { cleanupFailures.push('lc-worker'); }
    try {
      if (managedWorkerProcess) await managedWorkerProcess.shutdown(5_000);
      else if (worker) await worker.stop(5_000);
    } catch { cleanupFailures.push('document-core-worker'); }
    try { if (connectorComposition) await connectorComposition.shutdown(); } catch { cleanupFailures.push('connector'); }
    try {
      if (connectorProviderServer) await new Promise<void>((resolve, reject) => connectorProviderServer!.close((error) => error ? reject(error) : resolve()));
    } catch { cleanupFailures.push('connector-provider'); }
    try { if (app) await app.close(); } catch { cleanupFailures.push('orchestrator-app'); }
    try { if (connectorProbeDb) await connectorProbeDb.close(); } catch { cleanupFailures.push('connector-schema-probe'); }
    try {
      if (connectorSchemaCreated) {
        await baseDb.query(`DROP SCHEMA "${connectorIsolationContext.dbSchema}" CASCADE`);
        const schema = await baseDb.query<{ exists: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists',
          [connectorIsolationContext.dbSchema],
        );
        connectorPostgresSchemaAbsent = schema.rows[0]?.exists === false;
      }
    } catch { cleanupFailures.push('connector-postgres-schema'); }
    if (!connectorPostgresSchemaAbsent) cleanupFailures.push('connector-postgres-schema-remains');
    try {
      if (isolatedSchemaCreated) {
        await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
        const schema = await baseDb.query<{ exists: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists',
          [isolation.context.dbSchema],
        );
        postgresSchemaAbsent = schema.rows[0]?.exists === false;
      }
    } catch { cleanupFailures.push('postgres-schema'); }
    try { await baseDb.close(); } catch { cleanupFailures.push('postgres-pool'); }
    try { isolation.context.cleanupArtifactDir(); } catch { cleanupFailures.push('artifact-directory'); }
    try { connectorIsolationContext.cleanupArtifactDir(); } catch { cleanupFailures.push('connector-artifact-directory'); }
    let minioCleanup: unknown = null;
    try { if (ownedMinio) minioCleanup = await ownedMinio.cleanup(); }
    catch { cleanupFailures.push('owned-minio'); }
    const storageDirectory = resolve(rawRoot, 'storage-generation');
    mkdirSync(storageDirectory, { recursive: true });
    writeFileSync(resolve(storageDirectory, 'cleanup.json'), JSON.stringify({
      postgresSchemaAbsent,
      connectorPostgresSchemaAbsent,
      artifactDirectoryAbsent: !existsSync(isolation.context.artifactDir),
      connectorArtifactDirectoryAbsent: !existsSync(connectorIsolationContext.artifactDir),
      ownedMinioCleanup: minioCleanup,
      cleanupFailures,
    }, null, 2));
    if (cleanupFailures.length) throw new Error(`WFA owned cleanup failed for ${cleanupFailures.join(', ')}`);
  }, 60_000);


  test('legacy multipart ingest parses exact bytes, projects/downloads result and replays without duplicate blobs', async () => {
    if (!app) throw new Error('app missing');
    const makeForm = () => {
      const body = new FormData();
      body.append('mode', 'parse');
      body.append('output_format', 'text');
      body.append('file', new File(['ORV11 core file bytes'], 'core.txt', { type: 'text/plain' }));
      return body;
    };
    const headers = { 'x-api-key': apiKey, 'idempotency-key': 'orv11-stable-file' };
    const response = await fetch(`${baseUrl}/api/v1/docs/ingest`, { method: 'POST', headers, body: makeForm() });
    const initial = await response.json() as Record<string, unknown>;
    expect({ status: response.status, initial }).toMatchObject({ status: 202 });
    const id = String(initial.name).replace('operations/', '');
    const terminal = await dispatchAndWait(id, ['SUCCEEDED']);
    expect(terminal).toMatchObject({ state: 'SUCCEEDED' });
    const result = await fetch(`${baseUrl}/api/v1/operations/${id}`, { headers: { 'x-api-key': apiKey } });
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toContain('ORV11 core file bytes');
    const downloaded = await fetch(`${baseUrl}/api/v1/operations/${id}/download`, { headers: { 'x-api-key': apiKey } });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('ORV11 core file bytes');
    const counts = async () => (await app!.db.query('SELECT (SELECT count(*) FROM artifacts WHERE tenant_id=$1)::text AS artifacts, (SELECT count(*) FROM operations WHERE tenant_id=$1)::text AS operations', [tenantId])).rows[0];
    const before = await counts();
    const replay = await fetch(`${baseUrl}/api/v1/docs/ingest`, { method: 'POST', headers, body: makeForm() });
    const replayBody = await replay.json() as Record<string, unknown>;
    expect(replay.status).toBe(200);
    expect(replayBody.name).toBe(initial.name);
    expect(await counts()).toEqual(before);
    const stored = await app.db.query('SELECT id,purpose FROM artifacts WHERE operation_id=$1 OR id IN (SELECT (jsonb_array_elements(submit_artifacts)->>\'artifactId\')::uuid FROM operations WHERE id=$1)', [id]);
    expect(stored.rows.length).toBeGreaterThanOrEqual(2);
    for (const artifact of stored.rows) {
      const route = `${baseUrl}/api/v1/artifacts/${artifact.id}/download`;
      const own = await fetch(route, { headers: { 'x-api-key': apiKey } });
      const expectedStatus = ['input','output'].includes(String(artifact.purpose)) ? 200 : 404;
      if(own.status!==expectedStatus) throw new Error(`artifact ${JSON.stringify(artifact)} own status ${own.status}: ${await own.text()}`);
      expect((await fetch(route, { headers: { 'x-api-key': namedApiKey } })).status).toBe(404);
      expect((await fetch(route, { headers: { 'x-api-key': otherApiKey } })).status).toBe(404);
    }
    const deleted = await fetch(`${internalUrl}/api/internal/operations/${id}`, { method:'DELETE',headers:{authorization:`Bearer ${adminToken}`} });
    expect(deleted.status).toBe(200);
    for(const artifact of stored.rows) expect((await fetch(`${baseUrl}/api/v1/artifacts/${artifact.id}/download`,{headers:{'x-api-key':apiKey}})).status).toBe(404);

  });
  test('sync submit waits for real worker and returns terminal result within its budget', async () => {
    const dispatcher = setInterval(() => void app!.dispatcher.dispatchOnce(), 30);
    try {
      const response = await fetch(`${baseUrl}/api/v1/docs/ingest?sync=true`, {
        method: 'POST', headers: { 'x-api-key': apiKey },
        body: multipart({ mode: 'parse', text: 'ORV11 sync result' }),
      });
      const body = await response.json() as Record<string, unknown>;
      if(response.status !== 200) throw new Error(`sync response ${response.status}: ${JSON.stringify(body)}`);
      expect(body.done).toBe(true);
      expect(JSON.stringify(body)).toContain('ORV11 sync result');
    } finally { clearInterval(dispatcher); }
  });

  describe('31 public multipart variants through production outbox/Redis/worker/Connector',()=>{
    beforeAll(async()=>{
      for(const action of ['ingest','extract','analyze','transform','generate','compare']) {
        await createProfileService(app!.db).createRevision({apiKeyHash,businessId:'document-core',businessVersion:documentCoreManifest.version,action,connectorBindings: action==='ingest'?{ocr:{connectorId:namedConnectorId,revision:1},vision:{connectorId:namedConnectorId,revision:1}}:{reasoning:{connectorId:namedConnectorId,revision:1}}});
      }
    });
    test.each(VARIANT_TRACEABILITY_MATRIX)('$brdCaseId $action/$variant',async(entry)=>{
      const fixtureContext=new MockTaskContext();
      const fixture=getVariantFixture(entry,fixtureContext);
      await fixture.setupMock();
      matrixProviderValue=[...fixtureContext.mockConnectorResponses.values()][0];
      const body=new FormData();
      for(const [key,value] of Object.entries(fixture.input)) {
        if(key==='artifactIds')continue;
        const field=entry.action==='transform' && key==='variant'?'action':key==='outputFormat'?'output_format':key;
        body.append(field,typeof value==='string'?value:(key==='source'||key==='target')&&typeof value==='object'&&value!==null&&'text' in value?String(value.text):Array.isArray(value)?value.join(','):JSON.stringify(value));
      }
      for(const [id,bytes] of fixtureContext.artifactsStore){
        const metadata=fixtureContext.artifactFormatMetadataStore.get(id);
        body.append('files[]',new File([new Uint8Array(bytes)],metadata?.declaredFileName??'fixture.txt',{type:metadata?.declaredMimeType??'text/plain'}));
      }
      const response=await fetch(`${baseUrl}/api/v1/docs/${entry.action}`,{method:'POST',headers:{'x-api-key':apiKey},body});
      const initial=await response.json() as Record<string,unknown>;
      if(response.status!==202)throw new Error(`${entry.brdCaseId} admission ${response.status}: ${JSON.stringify(initial)}`);
      const id=String(initial.name).replace('operations/','');
      const terminal=await dispatchAndWait(id,['SUCCEEDED']);
      if(terminal.state!=='SUCCEEDED')throw new Error(`${entry.brdCaseId} terminal ${JSON.stringify(terminal)} ${recentWorkerErrorFrames()}`);
      const poll=await fetch(`${baseUrl}/api/v1/operations/${id}`,{headers:{'x-api-key':apiKey}});
      const result=await poll.json() as Record<string,unknown>;
      expect(poll.status).toBe(200);expect(result.done).toBe(true);
      const projected=result.result as {content?:unknown;extracted_data?:unknown};
      expect(result.name).toBe(`operations/${id}`);expect(result.metadata).toMatchObject({state:'SUCCEEDED'});
      const expected=EXPECTED_RESULT_CORPUS[entry.brdCaseId]!.derivedExpectedEnvelope.data;
      const actual=projected.extracted_data;
      if(entry.brdCaseId==='DOC-06-03'){expect(actual).toEqual(matrixProviderValue!.data);}else{expect(JSON.stringify(normalizeNondeterministicFields(actual)).replace(/\\r\\n/g,'\\n')).toBe(JSON.stringify(normalizeNondeterministicFields(expected)).replace(/\\r\\n/g,'\\n'));}
      expect(projected).toBeDefined();expect(typeof projected.content==='string' && projected.content.length>0 || projected.extracted_data!==null && projected.extracted_data!==undefined).toBe(true);
      mkdirSync(resolve(rawRoot,'variants'),{recursive:true});
      writeFileSync(resolve(rawRoot,'variants',`${entry.brdCaseId}.json`),JSON.stringify(result,null,2));
      matrixProviderValue=undefined;
    });
  });

  describe('ORV14 native tenant prompt and AI defaults observed by real Connector calls', () => {
    beforeAll(async () => {
      // The synthetic Connector fixture intentionally keeps its provider
      // credential at the production default maxInFlight=1. Keep the old/new
      // revision observations serial while the operations remain queued across
      // the publication boundary, so this test checks pinning rather than
      // manufacturing a quota collision with an over-parallel local worker.
      await changeDocumentCoreWorkerConcurrency(1);
    });

    afterAll(async () => {
      await changeDocumentCoreWorkerConcurrency(2);
    });

    type PromptSettings = { image: string; pdf: string; docx: string; compare: string; generate: string };
    type TenantSettingsRead = {
      ai: { activeRevision: number | null };
      prompts: { activeRevision: number | null };
      effective: {
        ai: { provider: string | null; model: string | null; connectorId: string | null; connectorRevision: number | null };
        prompts: PromptSettings;
        promptRevision: number | null;
        aiRevision: number | null;
        settingsDigest: string;
      };
    };
    type ProfilePin = { profileId: string; revision: number };
    type ProviderPin = { connectorId: string; revision: number };
    type UploadedFile = { name: string; mime: string; bytes: Buffer };

    async function settingsRequest(path: string, body?: Record<string, unknown>): Promise<{ response: Response; value: Record<string, unknown> }> {
      const response = await fetch(`${internalUrl}/api/internal/global-settings${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, value: await response.json() as Record<string, unknown> };
    }

    async function readTenantSettings(): Promise<TenantSettingsRead> {
      const result = await settingsRequest(`?tenantId=${encodeURIComponent(tenantId)}`);
      if (result.response.status !== 200) throw new Error(`tenant settings read returned ${result.response.status}`);
      return result.value as unknown as TenantSettingsRead;
    }

    async function publishPromptSettings(settings: PromptSettings, expectedActiveRevision: number | null): Promise<number> {
      const draft = await settingsRequest(`/tenants/${tenantId}/prompts/draft`, {
        expectedActiveRevision,
        settings,
        idempotencyKey: `orv14-vfy-prompt-draft-${randomUUID()}`,
        reason: 'Synthetic Worker provider-observation fixture',
      });
      if (draft.response.status !== 201 || typeof draft.value.revision !== 'number') {
        throw new Error(`tenant prompt draft returned ${draft.response.status}`);
      }
      const revision = Number(draft.value.revision);
      const published = await settingsRequest(`/tenants/${tenantId}/prompts/publish`, {
        draftRevision: revision,
        expectedActiveRevision,
        idempotencyKey: `orv14-vfy-prompt-publish-${randomUUID()}`,
        reason: 'Activate synthetic Worker provider-observation fixture',
      });
      if (published.response.status !== 200 || published.value.activeRevision !== revision) {
        throw new Error(`tenant prompt publish returned ${published.response.status}`);
      }
      const reloaded = await readTenantSettings();
      if (reloaded.prompts.activeRevision !== revision || reloaded.effective.promptRevision !== revision) {
        throw new Error('tenant prompt revision did not survive a read after publish');
      }
      return revision;
    }

    async function createTypedProvider(adapter: 'gemini' | 'openai-compatible'): Promise<ProviderPin> {
      const connectorId = adapter === 'gemini' ? geminiConnectorId : openAiConnectorId;
      const idempotencyKey = `orv14-vfy-typed-${randomUUID()}`;
      const headers = { authorization: `Bearer ${serviceIdentityToken(['connector:management'])}`, 'content-type': 'application/json' };
      const path = `/internal/admin/connector-revisions/${encodeURIComponent(connectorId)}`;
      const claimed = await fetch(`${connectorBaseUrl}${path}/claim`, {
        method: 'POST', headers,
        body: JSON.stringify({ tenantId, expectedHeadRevision: 0, idempotencyKey }),
      });
      if (claimed.status !== 200) throw new Error(`typed Connector claim returned ${claimed.status}`);

      const recipe = {
        adapter,
        method: 'POST',
        endpointUrl: `${connectorProviderUrl}/provider`,
        auth: { kind: 'none' },
        headers: [],
        request: { promptField: 'prompt', modelField: 'model', fields: [] },
        response: {
          contentPath: 'content',
          inputTokensPath: 'usage.inputTokens',
          outputTokensPath: 'usage.outputTokens',
        },
        session: { capture: [], inject: [] },
        timeoutMs: 30_000,
        responseBytes: 2_000_000,
      };
      const drafted = await fetch(`${connectorBaseUrl}${path}/draft`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          tenantId,
          expectedHeadRevision: 0,
          recipe,
          credentialChange: { action: 'clear', confirm: true },
          idempotencyKey,
        }),
      });
      const draftValue = await drafted.json() as { revision?: { revision?: unknown }; error?: unknown };
      if (drafted.status !== 201 || draftValue.revision?.revision !== 1) {
        const connectorError = typeof draftValue.error === 'object' && draftValue.error !== null
          ? draftValue.error as Record<string, unknown>
          : {};
        const diagnostics = {
          status: drafted.status,
          code: typeof connectorError.code === 'string' ? connectorError.code : undefined,
          retryable: typeof connectorError.retryable === 'boolean' ? connectorError.retryable : undefined,
          retryAfterMs: typeof connectorError.retryAfterMs === 'number' ? connectorError.retryAfterMs : undefined,
          correlationId: drafted.headers.get('x-correlation-id')?.slice(0, 80) ?? undefined,
        };
        throw new Error(`typed Connector draft returned ${JSON.stringify(diagnostics)}`);
      }
      const activated = await fetch(`${connectorBaseUrl}${path}/1/activate`, {
        method: 'POST', headers,
        body: JSON.stringify({ tenantId, expectedCurrentRevision: 0 }),
      });
      if (activated.status !== 200) throw new Error(`typed Connector activation returned ${activated.status}`);
      return { connectorId, revision: 1 };
    }

    async function publishAiSettings(
      settings: { provider: 'gemini' | 'openai-compatible'; model: string } & ProviderPin,
      expectedActiveRevision: number | null,
      profile: ProfilePin,
      apiKeyId: string,
    ): Promise<number> {
      const draft = await settingsRequest(`/tenants/${tenantId}/ai/draft`, {
        expectedActiveRevision,
        settings: {
          provider: settings.provider,
          model: settings.model,
          connectorId: settings.connectorId,
          connectorRevision: settings.revision,
        },
        idempotencyKey: `orv14-vfy-ai-draft-${randomUUID()}`,
        reason: 'Synthetic Worker provider-observation fixture',
      });
      if (draft.response.status !== 201 || typeof draft.value.revision !== 'number') {
        const responseError = typeof draft.value.error === 'object' && draft.value.error !== null
          ? draft.value.error as Record<string, unknown>
          : {};
        const fieldErrors = Array.isArray(draft.value.errors) ? draft.value.errors.slice(0, 8).flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
          const issue = entry as Record<string, unknown>;
          if (typeof issue.pointer !== 'string' || typeof issue.message !== 'string') return [];
          return [{ pointer: issue.pointer.slice(0, 120), message: issue.message.slice(0, 180) }];
        }) : [];
        const diagnostics = {
          stage: 'tenant-ai-draft',
          expectedConstraint: 'TenantAiDraftRequestSchema requires expectedActiveRevision, settings(provider/model/connectorId/connectorRevision), idempotencyKey, and reason; connectorId and connectorRevision must be present together',
          status: draft.response.status,
          code: typeof draft.value.errorCode === 'string' ? draft.value.errorCode
            : typeof responseError.code === 'string' ? responseError.code
              : typeof draft.value.code === 'string' ? draft.value.code : undefined,
          correlationId: draft.response.headers.get('x-correlation-id')?.slice(0, 80)
            ?? (typeof draft.value.correlationId === 'string' ? draft.value.correlationId.slice(0, 80) : undefined),
          fieldErrors,
        };
        const diagnosticsDirectory = resolve(rawRoot, 'prompt-model');
        mkdirSync(diagnosticsDirectory, { recursive: true });
        writeFileSync(resolve(diagnosticsDirectory, 'tenant-ai-draft-error.json'), JSON.stringify(diagnostics, null, 2));
        throw new Error(`tenant AI draft returned ${JSON.stringify(diagnostics)}`);
      }
      const revision = Number(draft.value.revision);
      const providerTestIdempotencyKey = `orv14-vfy-ai-test-${randomUUID()}`;
      const providerCallsBeforeTest = connectorProviderCalls.length;
      const tested = await settingsRequest(`/tenants/${tenantId}/ai/test`, {
        revision,
        apiKeyId,
        profileId: profile.profileId,
        expectedProfileRevision: profile.revision,
        businessId: 'document-core',
        businessVersion: documentCoreManifest.version,
        action: 'generate',
        endpointSlug: 'generate:summary',
        prompt: 'ORV14 synthetic tenant AI provider test',
        parameters: { task: 'summary' },
        artifactIds: [],
        timeoutMs: 30_000,
        idempotencyKey: providerTestIdempotencyKey,
      });
      if (tested.response.status !== 200 || tested.value.ok !== true) {
        const responseError = typeof tested.value.error === 'object' && tested.value.error !== null
          ? tested.value.error as Record<string, unknown>
          : {};
        const fieldErrors = Array.isArray(tested.value.errors) ? tested.value.errors.slice(0, 8).flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
          const issue = entry as Record<string, unknown>;
          if (typeof issue.pointer !== 'string' || typeof issue.message !== 'string') return [];
          return [{ pointer: issue.pointer.slice(0, 120), message: issue.message.slice(0, 180) }];
        }) : [];
        const diagnostics = {
          stage: 'tenant-ai-test',
          expectedConstraint: 'normal Connector composition verifies the signed provider-test grant, performs authenticated cost-control preflight over the Orchestrator internal HTTP listener, and resolves the exact active auth:none recipe plus key/Profile binding',
          status: tested.response.status,
          code: typeof tested.value.code === 'string' ? tested.value.code
            : typeof responseError.code === 'string' ? responseError.code
              : typeof tested.value.errorCode === 'string' ? tested.value.errorCode : undefined,
          title: typeof tested.value.title === 'string' ? tested.value.title.slice(0, 120) : undefined,
          correlationId: tested.response.headers.get('x-correlation-id')?.slice(0, 80)
            ?? (typeof tested.value.correlationId === 'string' ? tested.value.correlationId.slice(0, 80) : undefined),
          fieldErrors,
          persistedState: await captureProviderTestStateEvidence(providerTestIdempotencyKey, providerCallsBeforeTest),
        };
        const diagnosticsDirectory = resolve(rawRoot, 'prompt-model');
        mkdirSync(diagnosticsDirectory, { recursive: true });
        writeFileSync(resolve(diagnosticsDirectory, 'tenant-ai-test-error.json'), JSON.stringify(diagnostics, null, 2));
        throw new Error(`tenant AI provider test returned ${JSON.stringify(diagnostics)}`);
      }
      const published = await settingsRequest(`/tenants/${tenantId}/ai/publish`, {
        draftRevision: revision,
        expectedActiveRevision,
        idempotencyKey: `orv14-vfy-ai-publish-${randomUUID()}`,
        reason: 'Activate tested synthetic Worker AI default',
      });
      if (published.response.status !== 200 || published.value.activeRevision !== revision) {
        throw new Error(`tenant AI publish returned ${published.response.status}`);
      }
      const reloaded = await readTenantSettings();
      if (reloaded.ai.activeRevision !== revision || reloaded.effective.aiRevision !== revision
          || reloaded.effective.ai.provider !== settings.provider || reloaded.effective.ai.model !== settings.model
          || reloaded.effective.ai.connectorId !== settings.connectorId
          || reloaded.effective.ai.connectorRevision !== settings.revision) {
        throw new Error('tenant AI defaults did not survive a read after publish');
      }
      return revision;
    }

    async function createGenerateProfile(bind: ProviderPin, parameters: Record<string, unknown> = {}): Promise<ProfilePin> {
      if (!app) throw new Error('WFA worker app is not running');
      const created = await createProfileService(app.db).createRevision({
        apiKeyHash,
        businessId: 'document-core',
        businessVersion: documentCoreManifest.version,
        action: 'generate',
        endpointSlug: 'generate:summary',
        connectorBindings: { reasoning: bind },
        policy: { parameters },
      });
      return { profileId: created.profileId, revision: created.revision };
    }

    async function submitLegacyAction(action: 'ingest' | 'compare' | 'generate', fields: Record<string, string>, files: readonly UploadedFile[] = []): Promise<string> {
      const body = new FormData();
      for (const [name, value] of Object.entries(fields)) body.append(name, value);
      for (const file of files) body.append('files[]', new File([new Uint8Array(file.bytes)], file.name, { type: file.mime }));
      const response = await fetch(`${baseUrl}/api/v1/docs/${action}`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body,
      });
      const value = await response.json() as { name?: unknown };
      if (response.status !== 202 || typeof value.name !== 'string' || !value.name.startsWith('operations/')) {
        throw new Error(`${action} provider-observation submit returned ${response.status}`);
      }
      return value.name.slice('operations/'.length);
    }

    async function runAndCheck(operationId: string): Promise<void> {
      const terminal = await dispatchUntilState(operationId, ['SUCCEEDED'], 60_000);
      if (terminal.state !== 'SUCCEEDED') {
        const polled = await poll(operationId);
        throw new Error(`provider-observation operation ${operationId} ended ${terminal.state}: ${JSON.stringify(polled.body)} ${recentWorkerErrorFrames()}`);
      }
      const publicResult = await poll(operationId);
      if (publicResult.response.status !== 200 || publicResult.body.done !== true) {
        throw new Error(`provider-observation public GET failed for ${operationId}`);
      }
    }

    function promptSettings(revisionLabel: string): PromptSettings {
      return {
        image: `ORV14_${revisionLabel}_IMAGE`,
        pdf: `ORV14_${revisionLabel}_PDF`,
        docx: `ORV14_${revisionLabel}_DOCX`,
        compare: `ORV14_${revisionLabel}_COMPARE {file1}\nTARGET {file2}`,
        generate: `ORV14_${revisionLabel}_GENERATE {user_prompt}\nSOURCE {input_content}`,
      };
    }

    test('published tenant prompt revisions reach real PNG/PDF/DOCX, compare, and generate provider calls with old/new operation pins', async () => {
      const initial = await readTenantSettings();
      const firstSettings = promptSettings('PROMPT_A');
      const firstRevision = await publishPromptSettings(firstSettings, initial.prompts.activeRevision);
      const startingProviderCall = connectorProviderCalls.length;
      const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const pdf = TestFixtures.createSamplePdf('ORV14 PDF category source');
      const docx = TestFixtures.createSyntheticDocx('ORV14 DOCX category source');
      const cases = [
        { category: 'image', action: 'ingest' as const, fields: { mode: 'ocr', language: 'en' }, file: { name: 'orv14-image.png', mime: 'image/png', bytes: onePixelPng } },
        { category: 'pdf', action: 'ingest' as const, fields: { mode: 'ocr', language: 'en' }, file: { name: 'orv14-source.pdf', mime: 'application/pdf', bytes: pdf } },
        { category: 'docx', action: 'ingest' as const, fields: { mode: 'ocr', language: 'en' }, file: { name: 'orv14-source.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx } },
        { category: 'compare', action: 'compare' as const, fields: { mode: 'semantic', source: JSON.stringify({ text: 'ORV14_COMPARE_SOURCE_A' }), target: JSON.stringify({ text: 'ORV14_COMPARE_TARGET_A' }) } },
        { category: 'generate', action: 'generate' as const, fields: { task: 'summary', text: 'ORV14_GENERATE_SOURCE_A', audience: 'ORV14_GENERATE_REQUEST_A' } },
      ];
      const oldOperations: Array<{ category: string; operationId: string }> = [];
      for (const entry of cases) {
        const operationId = await submitLegacyAction(entry.action, entry.fields, 'file' in entry ? [entry.file] : []);
        oldOperations.push({ category: entry.category, operationId });
      }

      const secondSettings = promptSettings('PROMPT_B');
      const secondRevision = await publishPromptSettings(secondSettings, firstRevision);
      const newOperations: Array<{ category: string; operationId: string }> = [];
      for (const entry of cases) {
        const operationId = await submitLegacyAction(entry.action, entry.fields, 'file' in entry ? [entry.file] : []);
        newOperations.push({ category: entry.category, operationId });
      }

      for (const row of [...oldOperations, ...newOperations]) await runAndCheck(row.operationId);
      const observedCalls = connectorProviderCalls.slice(startingProviderCall);
      const evidence: Array<Record<string, unknown>> = [];
      for (const row of [...oldOperations.map((value) => ({ ...value, label: 'PROMPT_A' })), ...newOperations.map((value) => ({ ...value, label: 'PROMPT_B' }))]) {
        const marker = `ORV14_${row.label}_${row.category.toUpperCase()}`;
        const call = observedCalls.find((candidate) => candidate.prompt.includes(marker));
        expect(call).toBeDefined();
        if (row.category === 'compare') {
          const suffix = row.label === 'PROMPT_A' ? 'A' : 'A';
          expect(call!.prompt).toContain(`ORV14_COMPARE_SOURCE_${suffix}`);
          expect(call!.prompt).toContain(`ORV14_COMPARE_TARGET_${suffix}`);
        }
        if (row.category === 'generate') {
          expect(call!.prompt).toContain('task: summary');
          expect(call!.prompt).toContain('ORV14_GENERATE_SOURCE_A');
        }
        evidence.push({
          category: row.category,
          operationId: row.operationId,
          promptRevision: row.label === 'PROMPT_A' ? firstRevision : secondRevision,
          providerTask: call!.task,
          observedPromptMarker: marker,
          promptSha256: createHash('sha256').update(call!.prompt).digest('hex'),
          observedModel: call!.model ?? null,
        });
      }
      expect(evidence.filter((item) => item.category === 'image')).toHaveLength(2);
      expect(evidence.filter((item) => item.category === 'pdf')).toHaveLength(2);
      expect(evidence.filter((item) => item.category === 'docx')).toHaveLength(2);
      mkdirSync(resolve(rawRoot, 'prompt-model'), { recursive: true });
      writeFileSync(resolve(rawRoot, 'prompt-model', 'tenant-prompt-provider-observations.json'), JSON.stringify({
        tenantId,
        promptRevisions: { first: firstRevision, second: secondRevision },
        oldOperationIds: oldOperations,
        newOperationIds: newOperations,
        providerObservations: evidence,
      }, null, 2));
    }, 240_000);

    test('Gemini and OpenAI-compatible AI model defaults reach native provider tests and real Worker calls, with immutable old/new pins and Profile precedence', async () => {
      const apiKeyResult = await app!.db.query<{ id: string }>('SELECT id FROM api_keys WHERE hash=$1 AND tenant_id=$2', [apiKeyHash, tenantId]);
      if (!apiKeyResult.rowCount) throw new Error('synthetic API key id was not found');
      const apiKeyId = apiKeyResult.rows[0]!.id;
      const openAiPin = await createTypedProvider('openai-compatible');
      const openAiProfile = await createGenerateProfile(openAiPin);
      const beforeOpenAi = await readTenantSettings();
      const openAiRevisionA = await publishAiSettings({
        provider: 'openai-compatible', model: 'ORV14_OPENAI_MODEL_A', ...openAiPin,
      }, beforeOpenAi.ai.activeRevision, openAiProfile, apiKeyId);
      const providerCallsAtOpenAiA = connectorProviderCalls.length;
      const oldOperation = await submitLegacyAction('generate', {
        task: 'summary', text: 'ORV14_OPENAI_OLD_PIN_SOURCE', audience: 'ORV14_OPENAI_OLD_PIN_REQUEST',
      });

      const openAiRevisionB = await publishAiSettings({
        provider: 'openai-compatible', model: 'ORV14_OPENAI_MODEL_B', ...openAiPin,
      }, openAiRevisionA, openAiProfile, apiKeyId);
      const newOperation = await submitLegacyAction('generate', {
        task: 'summary', text: 'ORV14_OPENAI_NEW_PIN_SOURCE', audience: 'ORV14_OPENAI_NEW_PIN_REQUEST',
      });
      await runAndCheck(oldOperation);
      await runAndCheck(newOperation);
      const openAiCalls = connectorProviderCalls.slice(providerCallsAtOpenAiA);
      const oldCall = openAiCalls.find((call) => call.prompt.includes('ORV14_OPENAI_OLD_PIN_SOURCE'));
      const newCall = openAiCalls.find((call) => call.prompt.includes('ORV14_OPENAI_NEW_PIN_SOURCE'));
      expect(oldCall?.model).toBe('ORV14_OPENAI_MODEL_A');
      expect(newCall?.model).toBe('ORV14_OPENAI_MODEL_B');

      const profileModel = 'ORV14_PROFILE_MODEL_WINS';
      const profileOverride = await createGenerateProfile(openAiPin, { model: { value: profileModel, isLocked: true } });
      const profileOverrideOperation = await submitLegacyAction('generate', {
        task: 'summary', text: 'ORV14_PROFILE_MODEL_OVERRIDE_SOURCE', audience: 'ORV14_PROFILE_MODEL_REQUEST',
      });
      await runAndCheck(profileOverrideOperation);
      const profileCall = connectorProviderCalls.find((call) => call.prompt.includes('ORV14_PROFILE_MODEL_OVERRIDE_SOURCE'));
      expect(profileCall?.model).toBe(profileModel);

      const geminiPin = await createTypedProvider('gemini');
      const geminiProfile = await createGenerateProfile(geminiPin);
      const beforeGemini = await readTenantSettings();
      const geminiRevision = await publishAiSettings({
        provider: 'gemini', model: 'ORV14_GEMINI_MODEL', ...geminiPin,
      }, beforeGemini.ai.activeRevision, geminiProfile, apiKeyId);
      const geminiCallStart = connectorProviderCalls.length;
      const geminiOperation = await submitLegacyAction('generate', {
        task: 'summary', text: 'ORV14_GEMINI_DEFAULT_SOURCE', audience: 'ORV14_GEMINI_DEFAULT_REQUEST',
      });
      await runAndCheck(geminiOperation);
      const geminiCall = connectorProviderCalls.slice(geminiCallStart).find((call) => call.prompt.includes('ORV14_GEMINI_DEFAULT_SOURCE'));
      expect(geminiCall?.model).toBe('ORV14_GEMINI_MODEL');

      mkdirSync(resolve(rawRoot, 'prompt-model'), { recursive: true });
      writeFileSync(resolve(rawRoot, 'prompt-model', 'tenant-ai-model-provider-observations.json'), JSON.stringify({
        tenantId,
        revisions: { openAiA: openAiRevisionA, openAiB: openAiRevisionB, gemini: geminiRevision },
        operationIds: { oldOpenAi: oldOperation, newOpenAi: newOperation, profileOverride: profileOverrideOperation, gemini: geminiOperation },
        providerObservations: [oldCall, newCall, profileCall, geminiCall].map((call) => call && ({
          task: call.task,
          model: call.model ?? null,
          promptSha256: createHash('sha256').update(call.prompt).digest('hex'),
        })),
        profileModelWins: true,
      }, null, 2));
    }, 300_000);
  });

  test('imports and publishes XML through the normal workflow catalog, runs a real Worker workflow, and resumes HITL', async () => {
    const slug = `orv14-import-xml-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const source = `<?xml version="1.0"?>
      <workflow slug="${slug}" name="Imported XML human workflow" version="1">
        <input><property name="reference" type="string" required="true" /></input>
        <nodes>
          <node id="request_value" type="input" key="reference" />
          <node id="human_review" type="human" message="Review imported XML result" resumeInputs="extracted_data" />
        </nodes>
        <flow><step id="request_value" /><step id="human_review" /></flow>
        <output from="human_review" extra_data_from="human_review" />
      </workflow>`;
    const { preview, publishedPin } = await importAndPublishWorkflow('xml', source);
    expect(preview['sourceDigest']).toBe(`sha256:${createHash('sha256').update(source).digest('hex')}`);
    expect(preview['schema']).toMatchObject({
      slug,
      version: 1,
      flow: ['request_value', 'human_review'],
      nodes: [
        { id: 'request_value', type: 'input', key: 'reference' },
        { id: 'human_review', type: 'human', resumeInputs: ['extracted_data'] },
      ],
    });

    const submitted = await submitSchemaInput(slug, { reference: 'ORV14_XML_IMPORT_REFERENCE' });
    expect(submitted.response.status).toBe(202);
    const operationPin = await admittedWorkflowPin(submitted.operationId);
    expect(operationPin).toMatchObject({ revision: publishedPin['revision'], schema: preview['schema'], slug });
    expect(operationPin.pipelineDigest).toBe(operationPin.digest);

    const schema = preview['schema'] as Record<string, unknown>;
    const nextPin = await publishNextWorkflowRevision(schema, operationPin.revision);
    expect(nextPin['digest']).not.toBe(operationPin.digest);
    expect(await admittedWorkflowPin(submitted.operationId)).toMatchObject({
      revision: operationPin.revision,
      digest: operationPin.digest,
      schema: operationPin.schema,
    });

    const waiting = await dispatchUntilState(submitted.operationId, ['WAITING_INPUT'], 45_000);
    expect(waiting.state).toBe('WAITING_INPUT');
    const pendingWait = await app!.db.query<{ wait_id: string }>(
      "SELECT wait_id FROM human_waits WHERE operation_id=$1 AND status='OPEN' AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [submitted.operationId],
    );
    if (!pendingWait.rowCount || !pendingWait.rows[0]?.wait_id) throw new Error('imported XML operation has no open HITL wait');
    const waitingOperation = await stateOf(submitted.operationId);
    const resumeInput = { step: 1, extracted_data: { decision: 'approved', marker: 'ORV14_XML_HITL_RESUME' } };
    const resumed = await fetch(`${internalUrl}/api/internal/operations/${submitted.operationId}/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        waitId: pendingWait.rows[0].wait_id,
        expectedStateVersion: waitingOperation.state_version,
        input: resumeInput,
      }),
    });
    if (resumed.status !== 200) throw new Error(`imported XML HITL resume returned ${resumed.status}`);
    const terminal = await dispatchUntilState(submitted.operationId, ['SUCCEEDED'], 60_000);
    expect(terminal.state).toBe('SUCCEEDED');

    const publicResult = await poll(submitted.operationId);
    expect(publicResult.response.status).toBe(200);
    expect(publicResult.body).toMatchObject({ done: true, metadata: { state: 'SUCCEEDED', schema_revision: 1 } });
    expect(publicResult.body['result']).toMatchObject({ extracted_data: resumeInput.extracted_data });
    const download = await fetch(`${baseUrl}/api/v1/operations/${submitted.operationId}/download`, { headers: { 'x-api-key': apiKey } });
    expect(download.status).toBe(200);
    expect(JSON.parse(await download.text())).toEqual(resumeInput);
    const waitState = await app!.db.query<{ status: string }>('SELECT status FROM human_waits WHERE operation_id=$1', [submitted.operationId]);
    expect(waitState.rows.map((row) => row.status)).toEqual(['ANSWERED']);

    const evidenceDirectory = resolve(rawRoot, 'wfa-import');
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(resolve(evidenceDirectory, 'xml-hitl.json'), JSON.stringify({
      format: 'xml',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      previewDigest: preview['sourceDigest'],
      schemaSlug: slug,
      publishedRevision: publishedPin['revision'],
      admittedRevision: operationPin.revision,
      admittedDigest: operationPin.digest,
      laterActiveRevision: nextPin['revision'],
      laterActiveDigest: nextPin['digest'],
      operationId: submitted.operationId,
      waitingState: waiting.state,
      resumeStatus: resumed.status,
      terminalState: terminal.state,
      publicGetStatus: publicResult.response.status,
      publicDownloadStatus: download.status,
      hitlStates: waitState.rows.map((row) => row.status),
    }, null, 2));
  }, 120_000);

  test('imports and publishes JSON branch/join workflow and executes the immutable admitted pin in the real Worker', async () => {
    const slug = `orv14-import-json-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const schema = {
      slug,
      name: 'Imported JSON branch join workflow',
      version: 1,
      input_schema: {
        type: 'object',
        properties: {
          left: { type: 'string', required: true },
          right: { type: 'string', required: true },
        },
      },
      nodes: [
        {
          id: 'parallel_import',
          type: 'parallel',
          branches: [
            [{ id: 'left_value', type: 'input', key: 'left' }],
            [{ id: 'right_value', type: 'input', key: 'right' }],
          ],
        },
        { id: 'join_import', type: 'join', combine: 'first' },
      ],
      flow: ['parallel_import', 'join_import'],
      output: { from: 'join_import' },
    };
    const source = JSON.stringify(schema);
    const { preview, publishedPin } = await importAndPublishWorkflow('json', source);
    expect(preview['sourceDigest']).toBe(`sha256:${createHash('sha256').update(source).digest('hex')}`);
    expect(preview).toMatchObject({ connectorNames: [], egress: [] });
    expect(preview['schema']).toMatchObject({ slug, flow: ['parallel_import', 'join_import'] });

    const submitted = await submitSchemaInput(slug, {
      left: 'ORV14_JSON_IMPORT_LEFT',
      right: 'ORV14_JSON_IMPORT_RIGHT',
    });
    expect(submitted.response.status).toBe(202);
    const operationPin = await admittedWorkflowPin(submitted.operationId);
    expect(operationPin).toMatchObject({ revision: publishedPin['revision'], schema: preview['schema'], slug });
    expect(operationPin.pipelineDigest).toBe(operationPin.digest);
    const nextPin = await publishNextWorkflowRevision(preview['schema'] as Record<string, unknown>, operationPin.revision);
    expect(nextPin['digest']).not.toBe(operationPin.digest);
    expect(await admittedWorkflowPin(submitted.operationId)).toMatchObject({
      revision: operationPin.revision,
      digest: operationPin.digest,
      schema: operationPin.schema,
    });

    const terminal = await dispatchUntilState(submitted.operationId, ['SUCCEEDED'], 90_000);
    if (terminal.state !== 'SUCCEEDED') {
      const tasks = await app!.db.query<{ task_key: string; kind: string; state: string; error_code: string | null }>(
        'SELECT task_key,kind,state,error_code FROM tasks WHERE operation_id=$1 ORDER BY task_key',
        [submitted.operationId],
      );
      throw new Error(`imported JSON branch/join ended ${terminal.state}: ${JSON.stringify(tasks.rows)}`);
    }
    const branchTasks = await app!.db.query<{ task_key: string; state: string }>(
      "SELECT task_key,state FROM tasks WHERE operation_id=$1 AND kind='legacy-workflow-branch' ORDER BY task_key",
      [submitted.operationId],
    );
    expect(branchTasks.rows).toHaveLength(2);
    expect(branchTasks.rows.every((row) => row.state === 'SUCCEEDED')).toBe(true);
    const publicResult = await poll(submitted.operationId);
    expect(publicResult.response.status).toBe(200);
    expect(publicResult.body).toMatchObject({
      done: true,
      metadata: { state: 'SUCCEEDED', schema_revision: 1 },
      result: { content: 'ORV14_JSON_IMPORT_LEFT' },
    });
    const download = await fetch(`${baseUrl}/api/v1/operations/${submitted.operationId}/download`, { headers: { 'x-api-key': apiKey } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('ORV14_JSON_IMPORT_LEFT');

    const evidenceDirectory = resolve(rawRoot, 'wfa-import');
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(resolve(evidenceDirectory, 'json-branch-join.json'), JSON.stringify({
      format: 'json',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      previewDigest: preview['sourceDigest'],
      schemaSlug: slug,
      publishedRevision: publishedPin['revision'],
      admittedRevision: operationPin.revision,
      admittedDigest: operationPin.digest,
      laterActiveRevision: nextPin['revision'],
      laterActiveDigest: nextPin['digest'],
      operationId: submitted.operationId,
      terminalState: terminal.state,
      branchTasks: branchTasks.rows,
      publicGetStatus: publicResult.response.status,
      publicDownloadStatus: download.status,
    }, null, 2));
  }, 120_000);

  test('legacy workflow overrides are provider-observed under exact typed Connector pins and reject undeclared leaves', async () => {
    if (!app) throw new Error('WFA worker app is not running');
    const slug = `orv14-workflow-recipe-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const connectorId = workflowConnectorId;
    const connectorRevision1 = await publishTypedWorkflowRecipeRevision(connectorId, 0, typedWorkflowRecipe(1));
    const schemaRevision1 = await publishWorkflowSchemaRevision(workflowRecipeSchema(slug, {
      headerName: 'x-wfa-workflow',
      headerValue: 'schema-header-v1',
      staticFieldName: 'workflow_mode',
      staticFieldValue: 'schema-mode-v1',
      prompt: 'ORV14_WORKFLOW_RECIPE_REVISION_1',
    }), null);
    expect(schemaRevision1['revision']).toBe(1);
    const slotMap1 = schemaRevision1['connectorSlotMap'];
    if (typeof slotMap1 !== 'object' || slotMap1 === null || Array.isArray(slotMap1)) {
      throw new Error('published workflow schema has no connector slot map');
    }
    const bindingSlot = (slotMap1 as Record<string, unknown>)['wfa-workflow-recipe'];
    if (typeof bindingSlot !== 'string') throw new Error('published workflow schema has no exact typed Connector slot');

    const profileRevision1 = await createProfileService(app.db).createRevision({
      apiKeyHash: workflowOverrideApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'schema-workflow',
      connectorBindings: { [bindingSlot]: { connectorId, revision: connectorRevision1 } },
    });
    expect(profileRevision1.revision).toBe(1);
    const submitted1 = await submitWorkflowSchemaWithKey(slug, {}, workflowOverrideApiKey);
    if (submitted1.response.status !== 202) {
      const [keyRows, schemaRows, profileRows, membershipRows, operationRows, businessVersionRows] = await Promise.all([
        app.db.query<{ id: string; tenant_id: string; status: string }>(
          'SELECT id,tenant_id,status FROM api_keys WHERE hash=$1', [workflowOverrideApiKeyHash],
        ),
        app.db.query<{ tenant_id: string; slug: string; revision: number; status: string }>(
          'SELECT tenant_id,slug,revision,status FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 ORDER BY revision',
          [tenantId, slug],
        ),
        app.db.query<{ revision: number; action: string; status: string }>(
          `SELECT p.revision,p.action,CASE WHEN a.revision=p.revision THEN 'ACTIVE' ELSE 'INACTIVE' END AS status
             FROM profile_bindings p LEFT JOIN profile_active_revisions a ON a.profile_id=p.profile_id
            WHERE p.profile_id=$1 AND p.tenant_id=$2 ORDER BY p.revision`,
          [profileRevision1.profileId, tenantId],
        ),
        app.db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM profile_api_keys WHERE profile_id=$1 AND api_key_id=(SELECT id FROM api_keys WHERE hash=$2)',
          [profileRevision1.profileId, workflowOverrideApiKeyHash],
        ),
        app.db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM operations WHERE tenant_id=$1 AND api_key_id=(SELECT id FROM api_keys WHERE hash=$2)',
          [tenantId, workflowOverrideApiKeyHash],
        ),
        app.db.query<{ version: string; is_active: boolean; action_count: number; has_schema_workflow: boolean }>(
          `SELECT version,is_active,jsonb_array_length(manifest->'actions') AS action_count,
                  EXISTS (SELECT 1 FROM jsonb_array_elements(manifest->'actions') AS action(value)
                           WHERE value->>'name'='schema-workflow') AS has_schema_workflow
             FROM business_versions WHERE business_id=$1 ORDER BY version`,
          ['document-core'],
        ),
      ]);
      const responseDetail = typeof submitted1.body.detail === 'string' ? submitted1.body.detail : '';
      const responseDetailClass = /^no active version for business [a-z0-9-]+;/i.test(responseDetail)
        ? 'BUSINESS_VERSION_NOT_ACTIVE'
        : /^workflow schema '.+' is not imported\./i.test(responseDetail)
          ? 'WORKFLOW_SCHEMA_NOT_FOUND'
          : /^profile has revisions but no active revision pointer/i.test(responseDetail)
            ? 'PROFILE_ACTIVE_POINTER_MISSING'
            : /^workflow Connector revision is no longer available/i.test(responseDetail)
              ? 'WORKFLOW_CONNECTOR_REVISION_CHANGED'
              : 'UNCLASSIFIED';
      const diagnostic = {
        stage: 'first-public-workflow-submit',
        status: submitted1.response.status,
        responseProblem: {
          ...safeProblemFields(submitted1.body),
          type: typeof submitted1.body.type === 'string' ? submitted1.body.type.slice(0, 160) : null,
          detailClass: responseDetailClass,
          contentType: submitted1.response.headers.get('content-type')?.slice(0, 120) ?? null,
          ...(typeof submitted1.body.error === 'string' ? { error: submitted1.body.error.slice(0, 160) } : {}),
          ...(typeof submitted1.body.message === 'string' ? { message: submitted1.body.message.slice(0, 200) } : {}),
          correlationId: submitted1.response.headers.get('x-correlation-id')?.slice(0, 80) ?? null,
        },
        expectedIdentity: { tenantId, schemaSlug: slug, profileId: profileRevision1.profileId },
        apiKey: {
          rowCount: keyRows.rowCount,
          tenantMatches: keyRows.rows[0]?.tenant_id === tenantId,
          active: keyRows.rows[0]?.status === 'ACTIVE',
        },
        schemaCatalog: {
          rowCount: schemaRows.rowCount,
          exactTenantSlugRows: schemaRows.rows.length,
          activeRows: schemaRows.rows.filter((row) => row.status === 'active').length,
          revisions: schemaRows.rows.map(({ revision, status }) => ({ revision, status })),
        },
        profile: {
          rowCount: profileRows.rowCount,
          actions: [...new Set(profileRows.rows.map((row) => row.action))],
          activeRevisions: profileRows.rows.filter((row) => row.status === 'ACTIVE').map((row) => row.revision),
          membershipRows: Number(membershipRows.rows[0]?.count ?? 0),
        },
        businessVersions: {
          rowCount: businessVersionRows.rowCount,
          rows: businessVersionRows.rows.map((row) => ({
            version: row.version,
            active: row.is_active,
            actionCount: Number(row.action_count),
            hasSchemaWorkflow: row.has_schema_workflow,
          })),
        },
        operationRows: Number(operationRows.rows[0]?.count ?? 0),
      };
      const diagnosticDirectory = resolve(rawRoot, 'workflow-overrides');
      mkdirSync(diagnosticDirectory, { recursive: true });
      writeFileSync(resolve(diagnosticDirectory, 'first-submit-error-diagnostics.json'), JSON.stringify(diagnostic, null, 2));
      throw new Error(`workflow override submit returned ${JSON.stringify(diagnostic)}`);
    }
    expect(submitted1.response.status).toBe(202);
    const operationId1 = submitted1.body.name;
    if (typeof operationId1 !== 'string' || !operationId1.startsWith('operations/')) {
      throw new Error('first workflow override submission returned no operation ID');
    }
    const id1 = operationId1.slice('operations/'.length);
    const admitted1 = await admittedWorkflowPin(id1);
    expect(admitted1).toMatchObject({ revision: 1, slug, connectorSlotMap: { 'wfa-workflow-recipe': bindingSlot } });
    expect(admitted1.connectorBindings).toMatchObject({ [bindingSlot]: `${connectorId}@1` });
    expect(admitted1.connectorRecipePins).toMatchObject({
      recipe_request: {
        connectorId,
        connectorRevision: 1,
        staticFormFields: [{ name: 'workflow_mode', value: 'schema-mode-v1' }],
        extraHeaders: [{ name: 'x-wfa-workflow', value: 'schema-header-v1' }],
      },
    });

    const persistedPins = await app.db.query<{ connector_recipe_pins_ref: unknown }>(
      'SELECT connector_recipe_pins_ref FROM operations WHERE id=$1 AND tenant_id=$2', [id1, tenantId],
    );
    if (!persistedPins.rowCount || !persistedPins.rows[0]) throw new Error('admitted operation did not persist recipe pins');
    const rawRecipePin = persistedPins.rows[0].connector_recipe_pins_ref;
    const recipePinEnvelope = typeof rawRecipePin === 'string' ? JSON.parse(rawRecipePin) as unknown : rawRecipePin;
    expect(metadataCrypto.isSealed(recipePinEnvelope)).toBe(true);
    const serializedRecipePinEnvelope = JSON.stringify(recipePinEnvelope);
    expect(serializedRecipePinEnvelope).not.toContain('schema-header-v1');
    expect(serializedRecipePinEnvelope).not.toContain('schema-mode-v1');
    const openedRecipePins = await metadataCrypto.readStored(recipePinEnvelope, {
      tenantId,
      slot: 'operations.connector_recipe_pins_ref',
      refId: id1,
    }, false) as Record<string, unknown>;
    expect(openedRecipePins).toMatchObject({
      workflowSchemaSlug: slug,
      workflowSchemaRevision: 1,
      workflowSchemaDigest: admitted1.digest,
      connectorRecipePins: admitted1.connectorRecipePins,
    });

    const connectorRevision2 = await publishTypedWorkflowRecipeRevision(connectorId, 1, typedWorkflowRecipe(2));
    const profileRevision2 = await createProfileService(app.db).createRevision({
      profileId: profileRevision1.profileId,
      apiKeyHash: workflowOverrideApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'schema-workflow',
      connectorBindings: { [bindingSlot]: { connectorId, revision: connectorRevision2 } },
    });
    expect(profileRevision2.revision).toBe(2);
    const schemaRevision2 = await publishWorkflowSchemaRevision(workflowRecipeSchema(slug, {
      headerName: 'x-wfa-workflow',
      headerValue: 'schema-header-v2',
      staticFieldName: 'workflow_mode',
      staticFieldValue: 'schema-mode-v2',
      prompt: 'ORV14_WORKFLOW_RECIPE_REVISION_2',
    }), 1);
    expect(schemaRevision2['revision']).toBe(2);
    expect(schemaRevision2['digest']).not.toBe(schemaRevision1['digest']);

    const submitted2 = await submitWorkflowSchemaWithKey(slug, {}, workflowOverrideApiKey);
    expect(submitted2.response.status).toBe(202);
    const operationId2 = submitted2.body.name;
    if (typeof operationId2 !== 'string' || !operationId2.startsWith('operations/')) {
      throw new Error('second workflow override submission returned no operation ID');
    }
    const id2 = operationId2.slice('operations/'.length);
    const admitted2 = await admittedWorkflowPin(id2);
    expect(admitted2).toMatchObject({ revision: 2, slug, connectorSlotMap: { 'wfa-workflow-recipe': bindingSlot } });
    expect(admitted2.digest).not.toBe(admitted1.digest);
    expect(admitted2.connectorBindings).toMatchObject({ [bindingSlot]: `${connectorId}@2` });
    expect(admitted2.connectorRecipePins).toMatchObject({
      recipe_request: {
        connectorId,
        connectorRevision: 2,
        staticFormFields: [{ name: 'workflow_mode', value: 'schema-mode-v2' }],
        extraHeaders: [{ name: 'x-wfa-workflow', value: 'schema-header-v2' }],
      },
    });

    const admitted1AfterRevision = await admittedWorkflowPin(id1);
    expect(admitted1AfterRevision).toMatchObject({
      revision: 1,
      digest: admitted1.digest,
      connectorBindings: { [bindingSlot]: `${connectorId}@1` },
      connectorRecipePins: admitted1.connectorRecipePins,
    });

    const providerCallStart = connectorProviderCalls.length;
    const terminal1 = await dispatchUntilState(id1, ['SUCCEEDED'], 90_000);
    if (terminal1.state !== 'SUCCEEDED') {
      const failureEvidence = await captureWorkflowInvocationEvidence(id1, providerCallStart, admitted1);
      const diagnosticsDirectory = resolve(rawRoot, 'workflow-overrides');
      mkdirSync(diagnosticsDirectory, { recursive: true });
      writeFileSync(resolve(diagnosticsDirectory, 'old-pin-worker-failure-diagnostics.json'), JSON.stringify(failureEvidence, null, 2));
      throw new Error(`old workflow/Connector pin ended ${terminal1.state}; structured safe diagnostics saved`);
    }
    const terminal2 = await dispatchUntilState(id2, ['SUCCEEDED'], 90_000);
    if (terminal2.state !== 'SUCCEEDED') {
      const taskStates = await app.db.query<{ task_key: string; state: string; error_code: string | null }>(
        'SELECT task_key,state,error_code FROM tasks WHERE operation_id=$1 ORDER BY task_key', [id2],
      );
      throw new Error(`new workflow/Connector pin ended ${terminal2.state}: ${JSON.stringify(taskStates.rows)}`);
    }
    const providerObservations = connectorProviderCalls.slice(providerCallStart);
    const oldObservation = providerObservations.find((call) => call.prompt.includes('ORV14_WORKFLOW_RECIPE_REVISION_1'));
    const newObservation = providerObservations.find((call) => call.prompt.includes('ORV14_WORKFLOW_RECIPE_REVISION_2'));
    expect(oldObservation).toMatchObject({ workflowHeader: 'schema-header-v1', workflowMode: 'schema-mode-v1' });
    expect(newObservation).toMatchObject({ workflowHeader: 'schema-header-v2', workflowMode: 'schema-mode-v2' });
    const [public1, public2] = await Promise.all([poll(id1, workflowOverrideApiKey), poll(id2, workflowOverrideApiKey)]);
    expect(public1.response.status).toBe(200);
    expect(public1.body).toMatchObject({ done: true, metadata: { state: 'SUCCEEDED' } });
    expect(public2.response.status).toBe(200);
    expect(public2.body).toMatchObject({ done: true, metadata: { state: 'SUCCEEDED' } });
    const [download1, download2] = await Promise.all([
      fetch(`${baseUrl}/api/v1/operations/${id1}/download`, { headers: { 'x-api-key': workflowOverrideApiKey } }),
      fetch(`${baseUrl}/api/v1/operations/${id2}/download`, { headers: { 'x-api-key': workflowOverrideApiKey } }),
    ]);
    expect(download1.status).toBe(200);
    expect(download2.status).toBe(200);

    const acceptedOperationCount = async (): Promise<number> => {
      const result = await app!.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM operations o
          JOIN api_keys k ON k.id=o.api_key_id
         WHERE o.tenant_id=$1 AND k.hash=$2`,
        [tenantId, workflowOverrideApiKeyHash],
      );
      return Number(result.rows[0]?.count ?? 0);
    };
    const countBeforeRejectedLeaves = await acceptedOperationCount();
    const callsBeforeRejectedLeaves = connectorProviderCalls.length;
    const invalidHeaderPin = await publishWorkflowSchemaRevision(workflowRecipeSchema(slug, {
      headerName: 'x-wfa-unapproved',
      headerValue: 'schema-header-forged',
      staticFieldName: 'workflow_mode',
      staticFieldValue: 'schema-mode-forged-header',
      prompt: 'ORV14_WORKFLOW_RECIPE_FORGED_HEADER',
    }), 2);
    expect(invalidHeaderPin['revision']).toBe(3);
    const rejectedHeader = await submitWorkflowSchemaWithKey(slug, {}, workflowOverrideApiKey);
    expect(rejectedHeader.response.status).toBe(422);
    expect(rejectedHeader.body.code).toBe('INVALID_SCHEMA');
    expect(rejectedHeader.body.name).toBeUndefined();
    expect(await acceptedOperationCount()).toBe(countBeforeRejectedLeaves);
    expect(connectorProviderCalls).toHaveLength(callsBeforeRejectedLeaves);

    const invalidStaticPin = await publishWorkflowSchemaRevision(workflowRecipeSchema(slug, {
      headerName: 'x-wfa-workflow',
      headerValue: 'schema-header-forged-static',
      staticFieldName: 'unlisted_workflow_mode',
      staticFieldValue: 'schema-mode-forged-static',
      prompt: 'ORV14_WORKFLOW_RECIPE_FORGED_STATIC',
    }), 3);
    expect(invalidStaticPin['revision']).toBe(4);
    const rejectedStatic = await submitWorkflowSchemaWithKey(slug, {}, workflowOverrideApiKey);
    expect(rejectedStatic.response.status).toBe(422);
    expect(rejectedStatic.body.code).toBe('INVALID_SCHEMA');
    expect(rejectedStatic.body.name).toBeUndefined();
    expect(await acceptedOperationCount()).toBe(countBeforeRejectedLeaves);
    expect(connectorProviderCalls).toHaveLength(callsBeforeRejectedLeaves);

    const evidenceDirectory = resolve(rawRoot, 'workflow-overrides');
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(resolve(evidenceDirectory, 'typed-recipe-provider-observation.json'), JSON.stringify({
      schemaSlug: slug,
      connectorId,
      connectorSlot: bindingSlot,
      connectorRevisions: [connectorRevision1, connectorRevision2],
      schemaRevisions: [schemaRevision1['revision'], schemaRevision2['revision']],
      operations: [
        { operationId: id1, schemaRevision: admitted1.revision, schemaDigest: admitted1.digest, connectorBindings: admitted1.connectorBindings, state: terminal1.state },
        { operationId: id2, schemaRevision: admitted2.revision, schemaDigest: admitted2.digest, connectorBindings: admitted2.connectorBindings, state: terminal2.state },
      ],
      encryptedOperationRecipePin: { isSealed: true, openedSchemaRevision: openedRecipePins['workflowSchemaRevision'] },
      providerObservations: [oldObservation, newObservation].map((call) => call ? {
        promptMarker: call.prompt,
        workflowHeader: call.workflowHeader,
        workflowMode: call.workflowMode,
      } : null),
      rejectedLeaves: [
        { schemaRevision: invalidHeaderPin['revision'], kind: 'undeclared-header', status: rejectedHeader.response.status, code: rejectedHeader.body.code },
        { schemaRevision: invalidStaticPin['revision'], kind: 'undeclared-static-field', status: rejectedStatic.response.status, code: rejectedStatic.body.code },
      ],
      publicGetStatuses: [public1.response.status, public2.response.status],
      publicDownloadStatuses: [download1.status, download2.status],
      operationCountAfterRejectedLeaves: await acceptedOperationCount(),
    }, null, 2));
  }, 300_000);

  test('parallel legacy workflow branch Connector overrides use exact admitted checkpoint keys and reach the provider', async () => {
    if (!app) throw new Error('WFA worker app is not running');
    const slug = `orv14-workflow-branch-recipe-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const connectorId = workflowBranchConnectorId;
    const connectorRevision = await publishTypedWorkflowRecipeRevision(connectorId, 0, typedWorkflowRecipe(1));
    const schemaRevision = await publishWorkflowSchemaRevision(parallelWorkflowRecipeSchema(slug), null);
    expect(schemaRevision['revision']).toBe(1);
    const slotMap = schemaRevision['connectorSlotMap'];
    if (typeof slotMap !== 'object' || slotMap === null || Array.isArray(slotMap)) {
      throw new Error('published branch workflow schema has no connector slot map');
    }
    const bindingSlot = (slotMap as Record<string, unknown>)['wfa-workflow-recipe'];
    if (typeof bindingSlot !== 'string') throw new Error('published branch workflow has no exact typed Connector slot');
    const profile = await createProfileService(app.db).createRevision({
      apiKeyHash: workflowBranchApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'schema-workflow',
      connectorBindings: { [bindingSlot]: { connectorId, revision: connectorRevision } },
    });
    const submitted = await submitWorkflowSchemaWithKey(slug, {}, workflowBranchApiKey);
    if (submitted.response.status !== 202) {
      const detail = typeof submitted.body.detail === 'string' ? submitted.body.detail.slice(0, 180) : undefined;
      throw new Error(`parallel workflow submission returned ${submitted.response.status} (${String(submitted.body.code ?? 'no-code')})${detail ? `: ${detail}` : ''}`);
    }
    const operationName = submitted.body.name;
    if (typeof operationName !== 'string' || !operationName.startsWith('operations/')) {
      throw new Error('parallel workflow submission returned no operation ID');
    }
    const operationId = operationName.slice('operations/'.length);
    const admitted = await admittedWorkflowPin(operationId);
    expect(admitted).toMatchObject({ revision: 1, slug });
    expect(admitted.connectorBindings).toMatchObject({ [bindingSlot]: `${connectorId}@${connectorRevision}` });
    expect(admitted.connectorRecipePins).toMatchObject({
      recipe_branch_left: { connectorId, connectorRevision, extraHeaders: [{ name: 'x-wfa-workflow', value: 'branch-header-left' }], staticFormFields: [{ name: 'workflow_mode', value: 'branch-mode-left' }] },
      recipe_branch_right: { connectorId, connectorRevision, extraHeaders: [{ name: 'x-wfa-workflow', value: 'branch-header-right' }], staticFormFields: [{ name: 'workflow_mode', value: 'branch-mode-right' }] },
    });

    const providerCallStart = connectorProviderCalls.length;
    const terminal = await dispatchUntilState(operationId, ['SUCCEEDED'], 120_000);
    if (terminal.state !== 'SUCCEEDED') {
      const diagnostics = await captureWorkflowInvocationEvidence(operationId, providerCallStart, admitted);
      const evidenceDirectory = resolve(rawRoot, 'workflow-overrides');
      mkdirSync(evidenceDirectory, { recursive: true });
      writeFileSync(resolve(evidenceDirectory, 'parallel-branch-worker-failure-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
      throw new Error(`parallel workflow operation ended ${terminal.state}; structured safe diagnostics saved`);
    }

    const taskStates = await app.db.query<{
      task_key: string; kind: string; state: string; error_code: string | null;
    }>(
      'SELECT task_key,kind,state,error_code FROM tasks WHERE operation_id=$1 ORDER BY task_key', [operationId],
    );
    const expectedBranchTasks = [
      'legacy-workflow:recipe_parallel:branch:00',
      'legacy-workflow:recipe_parallel:branch:01',
    ];
    const branchTasks = taskStates.rows.filter((row) => row.kind === 'legacy-workflow-branch');
    expect(branchTasks.map((row) => row.task_key).sort()).toEqual(expectedBranchTasks);
    expect(branchTasks.every((row) => row.state === 'SUCCEEDED' && row.error_code === null)).toBe(true);

    const providerObservations = connectorProviderCalls.slice(providerCallStart);
    expect(providerObservations).toHaveLength(2);
    const leftObservation = providerObservations.find((call) => call.prompt.includes('ORV14_BRANCH_LEFT'));
    const rightObservation = providerObservations.find((call) => call.prompt.includes('ORV14_BRANCH_RIGHT'));
    expect(leftObservation).toMatchObject({ workflowHeader: 'branch-header-left', workflowMode: 'branch-mode-left' });
    expect(rightObservation).toMatchObject({ workflowHeader: 'branch-header-right', workflowMode: 'branch-mode-right' });

    const invocationEvidence = await captureWorkflowInvocationEvidence(operationId, providerCallStart, admitted);
    const grantRows = invocationEvidence['grants'] as Array<Record<string, unknown>>;
    const expectedStepKeys = [
      `legacy-workflow:node:${admitted.digest}:branch:recipe_parallel-0:recipe_branch_left`,
      `legacy-workflow:node:${admitted.digest}:branch:recipe_parallel-1:recipe_branch_right`,
    ].sort();
    expect(grantRows.map((row) => row['stepKey']).sort()).toEqual(expectedStepKeys);
    expect(grantRows).toHaveLength(2);
    expect(grantRows.every((row) => row['grantSignatureValid'] === true && row['workflowOverridesDigestMatches'] === true)).toBe(true);
    const connectorRows = invocationEvidence['connectorInvocations'] as Array<Record<string, unknown>>;
    expect(connectorRows).toHaveLength(2);
    expect(connectorRows.every((row) => row['state'] === 'SUCCEEDED' && row['error_code'] === null)).toBe(true);

    const publicResult = await poll(operationId, workflowBranchApiKey);
    expect(publicResult.response.status).toBe(200);
    expect(publicResult.body).toMatchObject({ done: true, metadata: { state: 'SUCCEEDED' } });
    const download = await fetch(`${baseUrl}/api/v1/operations/${operationId}/download`, {
      headers: { 'x-api-key': workflowBranchApiKey },
    });
    expect(download.status).toBe(200);

    const evidenceDirectory = resolve(rawRoot, 'workflow-overrides');
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(resolve(evidenceDirectory, 'parallel-branch-provider-observation.json'), JSON.stringify({
      caseId: 'ORV14-WFA-GRANT-STEP-01-BRANCH-POSITIVE',
      schemaSlug: slug,
      schemaRevision: admitted.revision,
      schemaDigest: admitted.digest,
      connectorId,
      connectorRevision,
      bindingSlot,
      profileRevision: profile.revision,
      operationId,
      terminalState: terminal.state,
      taskStates: taskStates.rows,
      providerObservations: [
        { branch: 'left', promptMarkerObserved: Boolean(leftObservation?.prompt.includes('ORV14_BRANCH_LEFT')), header: leftObservation?.workflowHeader, staticMode: leftObservation?.workflowMode },
        { branch: 'right', promptMarkerObserved: Boolean(rightObservation?.prompt.includes('ORV14_BRANCH_RIGHT')), header: rightObservation?.workflowHeader, staticMode: rightObservation?.workflowMode },
      ],
      invocations: invocationEvidence,
      publicGetStatus: publicResult.response.status,
      publicDownloadStatus: download.status,
    }, null, 2));
  }, 300_000);

  test('browser uploads a document and submits workflow.test to real worker, then polls success',async()=>{
    if(!app?.adminShell)throw new Error('shell unavailable');
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const dispatcher=setInterval(()=>void app!.dispatcher.dispatchOnce(),50);
    const dir=resolve(rawRoot,'browser');mkdirSync(dir,{recursive:true});
    try{
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      const cookie=signCookie(browserCookieSecret,{iss:'du-admin-shell',role:'admin',iat:Date.now(),exp:Date.now()+300000});
      await context.addCookies([{name:'du_admin',value:cookie!,url:app.adminShell.url,httpOnly:true,sameSite:'Lax'}]);
      const page=await context.newPage();
      await page.goto(`${app.adminShell.url}/admin/workflows`,{waitUntil:'networkidle'});
      await page.locator('#global-tenant-select').selectOption(tenantId);
      await page.getByText('WFA control-flow fixture wfa-input-only',{exact:true}).click();
      await page.getByRole('button',{name:'Test Run',exact:true}).click();
      await page.locator('label').filter({hasText:/^Input variables \(JSON/}).locator('textarea').fill(JSON.stringify({reference:'ORV11 browser real workflow result'}));
      const key=await app.db.query<{id:string}>('SELECT id FROM api_keys WHERE hash=$1',[leafApiKeyHash]);
      await page.locator('label').filter({hasText:/^Active API key ID/}).locator('select').selectOption(key.rows[0]!.id);
      await page.getByLabel('Test documents',{exact:true}).setInputFiles({name:'orv11-browser.txt',mimeType:'text/plain',buffer:Buffer.from('ORV11 uploaded from browser')});
      const uploaded=page.waitForResponse(r=>r.url().includes('/operations/uploads')&&r.request().method()==='POST');
      const submitted=page.waitForResponse(r=>r.url().includes('/admin/api/actions')&&r.request().method()==='POST');
      await page.getByRole('button',{name:'Start Test Execution',exact:true}).click();
      const upload=await uploaded; const uploadBody=await upload.text();
      if(upload.status()!==201)throw new Error(`browser upload ${upload.status()}: ${uploadBody}`);
      const uploadAck=JSON.parse(uploadBody) as {artifactId?:unknown;state?:unknown;sizeBytes?:unknown};
      if(typeof uploadAck.artifactId!=='string'||uploadAck.state!=='READY')throw new Error('browser upload acknowledgement did not pin a READY artifact');
      const submission=await submitted;const wire=await submission.json() as {data?:{operationId?:string};operationId?:string};
      if(submission.status()!==202)throw new Error(`workflow.test ${submission.status()}: ${JSON.stringify(wire)}`);
      const id=wire.data?.operationId??wire.operationId;
      if(!id)throw new Error(`operation missing ${JSON.stringify(wire)}`);
      const terminal=await waitForState(id,['SUCCEEDED']);
      if(terminal.state!=='SUCCEEDED')throw new Error(`browser workflow ${JSON.stringify(terminal)} ${recentWorkerErrorFrames()}`);
      if(!ownedMinio||!activeS3GenerationId||!activeS3CredentialVersionRef)throw new Error('owned active encrypted S3 generation is unavailable');
      const artifactResult=await app.db.query<{
        id:string;state:string;purpose:string;tenant_id:string;storage_backend:string;storage_generation_id:string|null;
        storage_key:string;storage_version_id:string|null;manifest_version_id:string|null;sha256:string|null;size_bytes:string|number|null;
      }>(
        `SELECT id::text AS id,state,purpose,tenant_id::text AS tenant_id,storage_backend,storage_generation_id::text AS storage_generation_id,
                storage_key,storage_version_id,manifest_version_id,sha256,size_bytes
           FROM artifacts WHERE id=$1 AND tenant_id=$2`,
        [uploadAck.artifactId,tenantId],
      );
      const artifact=artifactResult.rows[0];
      if(!artifact)throw new Error('browser-uploaded artifact row was not retained for its operation');
      expect(artifact).toMatchObject({
        id:uploadAck.artifactId,
        state:'READY',
        purpose:'input',
        tenant_id:tenantId,
        storage_backend:'s3',
        storage_generation_id:activeS3GenerationId,
      });
      expect(artifact.storage_version_id).toBeTruthy();
      expect(artifact.manifest_version_id).toBeTruthy();
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      const expectedUploadBytes=Buffer.from('ORV11 uploaded from browser');
      const storedObject=await ownedMinio.client.send(new GetObjectCommand({
        Bucket:ownedMinio.bucket,
        Key:artifact.storage_key,
        VersionId:artifact.storage_version_id!,
      }));
      const ciphertext=Buffer.from(await storedObject.Body!.transformToByteArray());
      expect(ciphertext.equals(expectedUploadBytes)).toBe(false);
      expect(ciphertext.includes(expectedUploadBytes)).toBe(false);
      expect(ciphertext.byteLength).toBe(Number(artifact.size_bytes));
      expect(createHash('sha256').update(ciphertext).digest('hex')).toBe(artifact.sha256);
      const ownDownload=await fetch(`${baseUrl}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`,{headers:{'x-api-key':leafApiKey}});
      expect(ownDownload.status).toBe(200);
      const restoredBytes=Buffer.from(await ownDownload.arrayBuffer());
      expect(restoredBytes.equals(expectedUploadBytes)).toBe(true);
      expect((await fetch(`${baseUrl}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`,{headers:{'x-api-key':apiKey}})).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`,{headers:{'x-api-key':otherApiKey}})).status).toBe(404);
      mkdirSync(resolve(dir,'s3'),{recursive:true});
      writeFileSync(resolve(dir,'s3','upload-verification.json'),JSON.stringify({
        operationId:id,
        artifactId:artifact.id,
        tenantId:artifact.tenant_id,
        storageBackend:artifact.storage_backend,
        storageGenerationId:artifact.storage_generation_id,
        credentialVersionRef:activeS3CredentialVersionRef,
        credentialOwnerTenantId:tenantId,
        storageVersionId:artifact.storage_version_id,
        manifestVersionId:artifact.manifest_version_id,
        plaintextBytes:restoredBytes.byteLength,
        plaintextSha256:createHash('sha256').update(restoredBytes).digest('hex'),
        storedObjectBytes:ciphertext.byteLength,
        storedObjectSha256:createHash('sha256').update(ciphertext).digest('hex'),
        storedObjectEqualsPlaintext:ciphertext.equals(expectedUploadBytes),
        tenantOwnDownloadStatus:ownDownload.status,
        otherSameTenantKeyStatus:404,
        otherTenantKeyStatus:404,
      },null,2));
      await page.getByText(`Operation ${id}: SUCCEEDED`,{exact:true}).waitFor({timeout:15000});
      await page.screenshot({path:resolve(dir,'workflow-upload-executed.png'),fullPage:true});
      const audit=await app.db.query("SELECT action FROM admin_audit_events WHERE action='workflow.test'");expect(audit.rowCount).toBe(1);
      writeFileSync(resolve(dir,'workflow-execution.json'),JSON.stringify({operationId:id,terminal:terminal.state,uploadStatus:upload.status(),submitStatus:submission.status()},null,2));

      const humanForm=multipart({schemaSlug:'wfa-human-one',input:JSON.stringify({reference:'ORV11 browser human review'})});
      const human=await fetch(`${baseUrl}/api/v1/docs/workflows/schema`,{method:'POST',headers:{'x-api-key':leafApiKey},body:humanForm});
      expect(human.status).toBe(202);
      const humanBody=await human.json() as {name:string};const humanId=humanBody.name.replace('operations/','');
      expect((await waitForState(humanId,['WAITING_INPUT'])).state).toBe('WAITING_INPUT');
      await page.goto(`${app.adminShell.url}/admin/operations?id=${humanId}`,{waitUntil:'networkidle'});
      await page.getByRole('button',{name:`${humanId.slice(0,8)}…`,exact:true}).click();
      const waits=await app.db.query<{wait_id:string}>("SELECT wait_id FROM human_waits WHERE operation_id=$1 AND status='OPEN'",[humanId]);
      await page.locator('label').filter({hasText:/^Pending review/}).locator('select').selectOption(waits.rows[0]!.wait_id);
      await page.locator('label').filter({hasText:/^Review response/}).locator('textarea').fill(JSON.stringify({extracted_data:{decision:'browser approved'}}));
      await page.screenshot({path:resolve(dir,'operation-hitl-before-resume.png'),fullPage:true});
      const resumed=page.waitForResponse(r=>r.url().includes('/admin/api/actions')&&r.request().method()==='POST');
      await page.getByRole('button',{name:'Submit review and resume',exact:true}).click();
      const resume=await resumed;if(resume.status()!==200)throw new Error(`browser resume ${resume.status()}: ${await resume.text()}`);
      const finalHuman=await waitForState(humanId,['SUCCEEDED']);expect(finalHuman.state).toBe('SUCCEEDED');
      await page.getByRole('button',{name:'Refresh detail',exact:true}).waitFor({timeout:15000});
      await page.getByRole('button',{name:'Refresh detail',exact:true}).click();
      await page.getByText(`ID: ${humanId}`,{exact:true}).waitFor();
      await page.getByText('SUCCEEDED',{exact:true}).first().waitFor();
      await page.screenshot({path:resolve(dir,'operation-hitl-resumed.png'),fullPage:true});
      expect((await app.db.query("SELECT status FROM human_waits WHERE operation_id=$1",[humanId])).rows[0]?.status).toBe('ANSWERED');
      writeFileSync(resolve(dir,'hitl-execution.json'),JSON.stringify({operationId:humanId,state:finalHuman.state,resumeStatus:resume.status()},null,2));
      await context.close();
    }finally{clearInterval(dispatcher);await browser.close();}
  },120000);

  describe('configured Worker private HTTPS', () => {
    let httpsFixture: PrivateHttpsFixture;
    const operationObservations: Array<Record<string, unknown>> = [];
    const policyLogEvidence: Array<{
      workerInstanceId: string;
      digest: string | null;
      originFieldPresent: boolean;
      mentionsFixtureHostname: boolean;
    }> = [];
    const workerExitCodes: number[] = [];

    function privateHttpsDownloadSchema(slug: string) {
      const nodes = [{
        id: 'download_file',
        type: 'file_url_download',
        urls: '$input.fileUrl',
        allowedExtensions: '.txt',
      }];
      return {
        slug,
        name: `Private HTTPS worker egress ${slug}`,
        input_schema: {
          type: 'object',
          properties: {
            reference: { type: 'string', required: true },
            fileUrl: { type: 'string', required: true },
          },
        },
        nodes,
        flow: nodes.map((node) => node.id),
        output: { from: 'download_file' },
      };
    }

    function privateHttpsCombinedSchema(slug: string) {
      const nodes = [
        { id: 'download_file', type: 'file_url_download', urls: '$input.fileUrl', allowedExtensions: '.txt' },
        { id: 'send_callback', type: 'callback', url: '$input.callbackUrl', payload: '$input.callbackPayload', method: 'POST' },
      ];
      return {
        slug,
        name: `Private HTTPS callback and download ${slug}`,
        input_schema: {
          type: 'object',
          properties: {
            reference: { type: 'string', required: true },
            fileUrl: { type: 'string', required: true },
            callbackUrl: { type: 'string', required: true },
            callbackPayload: { type: 'object', required: true },
          },
        },
        nodes,
        flow: nodes.map((node) => node.id),
        output: { from: 'send_callback', extra_data_from: 'download_file' },
      };
    }

    function privateHttpsBranchSchema(slug: string) {
      const nodes = [{
        id: 'parallel_egress',
        type: 'parallel',
        branches: [
          [{ id: 'branch_download', type: 'file_url_download', urls: '$input.fileUrl', allowedExtensions: '.txt' }],
          [{ id: 'branch_callback', type: 'callback', url: '$input.callbackUrl', payload: '$input.callbackPayload', method: 'POST' }],
        ],
      }];
      return {
        slug,
        name: `Private HTTPS branch egress ${slug}`,
        input_schema: {
          type: 'object',
          properties: {
            reference: { type: 'string', required: true },
            fileUrl: { type: 'string', required: true },
            callbackUrl: { type: 'string', required: true },
            callbackPayload: { type: 'object', required: true },
          },
        },
        nodes,
        flow: nodes.map((node) => node.id),
        output: { from: 'parallel_egress' },
      };
    }

    function privateHttpsHitlSchema(slug: string) {
      const nodes = [
        { id: 'download_file', type: 'file_url_download', urls: '$input.fileUrl', allowedExtensions: '.txt' },
        { id: 'human_review', type: 'human', message: 'Approve the private HTTPS result', resumeInputs: ['extracted_data'] },
        { id: 'send_callback', type: 'callback', url: '$input.callbackUrl', payload: '$input.callbackPayload', method: 'POST' },
      ];
      return {
        slug,
        name: `Private HTTPS HITL continuation ${slug}`,
        input_schema: {
          type: 'object',
          properties: {
            reference: { type: 'string', required: true },
            fileUrl: { type: 'string', required: true },
            callbackUrl: { type: 'string', required: true },
            callbackPayload: { type: 'object', required: true },
          },
        },
        nodes,
        flow: nodes.map((node) => node.id),
        output: { from: 'send_callback', extra_data_from: 'download_file' },
      };
    }

    async function provisionPrivateHttpsSchema(
      slug: string,
      schema: unknown,
      approvedOrigins: readonly string[],
    ): Promise<void> {
      if (!app) throw new Error('WFA worker app is not running');
      await provisionLegacyWorkflowSchema(app.db, {
        tenantId,
        schema,
        approvedEgressOrigins: approvedOrigins,
      }, metadataCrypto);
    }

    async function installConfiguredWorker(origins: readonly string[]): Promise<void> {
      if (managedWorkerProcess) {
        await managedWorkerProcess.shutdown(5_000);
        managedWorkerProcess = undefined;
        worker = undefined;
      } else if (worker) {
        await worker.stop(5_000);
        worker = undefined;
      }

      const instanceId = `wfa-private-https-${randomUUID()}`;
      const env = {
        ...process.env,
        RUNTIME_URL: `${internalUrl}/api/runtime/v1`,
        RUNTIME_TOKEN: workerIdentityToken,
        REDIS_URL: isolation.redisUrl,
        CONNECTOR_URL: connectorBaseUrl,
        CONNECTOR_SERVICE_TOKEN: serviceIdentityToken(['connector:invoke']),
        CONCURRENCY: '2',
        HEARTBEAT_INTERVAL_MS: '1000',
        WORKER_INSTANCE_ID: instanceId,
        WORKFLOW_PRIVATE_HTTPS_ORIGINS: origins.join(','),
      };
      const processLifecycle = new DocumentCoreProcess({
        env,
        startWorkerFn: (config) => startDocumentCoreWorker({
          ...config,
          connectorServiceToken: () => serviceIdentityToken(['connector:invoke']),
          crypto: { facade: new CryptoStorageFacade(keyProvider), keyRef: 'du-wfa-synthetic-artifacts-v1' },
          encryptionEnabled: true,
        }),
        onExit: (code) => workerExitCodes.push(code),
        onLog: (_level, message, meta) => {
          if (message !== 'Starting Document Core Worker service') return;
          const fields = typeof meta === 'object' && meta !== null ? meta as Record<string, unknown> : {};
          const serialized = JSON.stringify(fields);
          policyLogEvidence.push({
            workerInstanceId: String(fields.workerInstanceId ?? ''),
            digest: typeof fields.workflowPrivateHttpsPolicyDigest === 'string'
              ? fields.workflowPrivateHttpsPolicyDigest
              : null,
            originFieldPresent: Object.keys(fields).some((key) => /origin/i.test(key)),
            mentionsFixtureHostname: serialized.includes(PRIVATE_HTTPS_TARGETS.sanMatch.host)
              || serialized.includes(PRIVATE_HTTPS_TARGETS.sanMismatch.host),
          });
        },
        registerSignalHandler: () => undefined,
      });
      managedWorkerProcess = processLifecycle;
      worker = await processLifecycle.start();
      if (worker.workerInstanceId !== instanceId) {
        throw new Error('configured DocumentCoreProcess started a different worker instance');
      }
    }

    async function submitPrivateHttpsCase(
      slug: string,
      input: Record<string, unknown>,
    ): Promise<{ operationId: string; terminal: OperationStateRow; publicOperation: Record<string, unknown> }> {
      const eventOffset = httpsFixture.events.length;
      const workerErrorOffset = workerErrorFrames.length;
      const submitted = await submitLeafSchemaInput(slug, input);
      if (submitted.response.status !== 202) {
        throw new Error(`private HTTPS schema admission returned ${submitted.response.status}`);
      }
      const terminal = await dispatchUntilState(
        submitted.operationId,
        ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
        45_000,
      );
      const polled = await poll(submitted.operationId, leafApiKey);
      if (polled.response.status !== 200) {
        throw new Error(`public operation GET returned ${polled.response.status}`);
      }
      operationObservations.push({
        schemaSlug: slug,
        operationId: submitted.operationId,
        terminal: { state: terminal.state, errorCode: terminal.error_code },
        publicOperation: polled.body,
        listenerEvents: httpsFixture.events.slice(eventOffset),
        workerErrorFrames: workerErrorFrames.slice(workerErrorOffset),
      });
      return { operationId: submitted.operationId, terminal, publicOperation: polled.body };
    }

    function savePrivateHttpsCase(caseId: string, value: Record<string, unknown>): void {
      const directory = resolve(rawRoot, 'private-https');
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, `${caseId}.json`), JSON.stringify(value, null, 2));
    }

    beforeAll(async () => {
      httpsFixture = new PrivateHttpsFixture();
      await httpsFixture.start();
      await installConfiguredWorker([httpsFixture.sanMatchOrigin]);

      if (!app) throw new Error('WFA worker app is not running');
      await createProfileService(app.db).createRevision({
        apiKeyHash: leafApiKeyHash,
        businessId: 'document-core',
        businessVersion: documentCoreManifest.version,
        action: 'schema-workflow',
        connectorBindings: {},
      });
      await provisionPrivateHttpsSchema('wfa-private-https-positive', privateHttpsCombinedSchema('wfa-private-https-positive'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-branch', privateHttpsBranchSchema('wfa-private-https-branch'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-download', privateHttpsDownloadSchema('wfa-private-https-download'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-schema-only-a', privateHttpsDownloadSchema('wfa-private-https-schema-only-a'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-schema-only-b', privateHttpsDownloadSchema('wfa-private-https-schema-only-b'), [httpsFixture.sanMatchAlternateOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-schema-a-b', privateHttpsDownloadSchema('wfa-private-https-schema-a-b'), [httpsFixture.sanMatchOrigin, httpsFixture.sanMismatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-redirect', privateHttpsDownloadSchema('wfa-private-https-redirect'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-oversize', privateHttpsDownloadSchema('wfa-private-https-oversize'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-cancel', privateHttpsDownloadSchema('wfa-private-https-cancel'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-hitl', privateHttpsHitlSchema('wfa-private-https-hitl'), [httpsFixture.sanMatchOrigin]);
      await provisionPrivateHttpsSchema('wfa-private-https-retry', privateHttpsDownloadSchema('wfa-private-https-retry'), [httpsFixture.sanMatchOrigin]);
    }, 30_000);

    afterAll(async () => {
      if (httpsFixture) await httpsFixture.close();
      const directory = resolve(rawRoot, 'private-https');
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, 'listener-events.json'), JSON.stringify(httpsFixture?.events ?? [], null, 2));
      writeFileSync(resolve(directory, 'operation-observations.json'), JSON.stringify(operationObservations, null, 2));
      writeFileSync(resolve(directory, 'worker-policy-log-evidence.json'), JSON.stringify({
        policyLogEvidence,
        workerExitCodes,
      }, null, 2));
    }, 30_000);

    test('configured Worker receives exact private HTTPS policy, validates DNS/SNI/CA, executes callback and download, and exposes public result', async () => {
      const origin = httpsFixture.sanMatchOrigin;
      const callbackPayload = { syntheticRun: 'orv14-private-https', effect: 'none' };
      const startingEventIndex = httpsFixture.events.length;
      const run = await submitPrivateHttpsCase('wfa-private-https-positive', {
        reference: 'synthetic-private-https-positive',
        fileUrl: httpsFixture.url('san-match', '/file.txt'),
        callbackUrl: httpsFixture.url('san-match', '/callback'),
        callbackPayload,
      });
      expect(run.terminal.state).toBe('SUCCEEDED');
      expect(run.publicOperation.done).toBe(true);
      expect(run.publicOperation.metadata).toMatchObject({ state: 'SUCCEEDED' });
      const result = run.publicOperation.result as { content?: unknown; extracted_data?: unknown };
      expect(result.content).toBe('callback sent');
      const extractedJson = typeof result.extracted_data === 'string'
        ? result.extracted_data
        : JSON.stringify(result.extracted_data);
      expect(extractedJson).toContain('secure.txt');

      const publicDownload = await fetch(`${baseUrl}/api/v1/operations/${run.operationId}/download`, {
        headers: { 'x-api-key': leafApiKey },
      });
      const publicDownloadText = await publicDownload.text();
      expect(publicDownload.status).toBe(200);
      expect(publicDownloadText).toBe('callback sent');

      const newEvents = httpsFixture.events.slice(startingEventIndex);
      const fileEvent = newEvents.find((event) => event.kind === 'request' && event.method === 'GET' && event.path === '/file.txt');
      const callbackEvent = newEvents.find((event) => event.kind === 'request' && event.method === 'POST' && event.path === '/callback');
      expect(fileEvent).toMatchObject({
        listener: 'san-match',
        host: new URL(origin).host,
        sni: PRIVATE_HTTPS_TARGETS.sanMatch.host,
      });
      if (!callbackEvent) throw new Error('positive private HTTPS callback did not reach the fixture listener');
      expect(callbackEvent).toMatchObject({
        listener: 'san-match',
        host: new URL(origin).host,
        sni: PRIVATE_HTTPS_TARGETS.sanMatch.host,
      });
      expectPrivateCallbackPayload(callbackEvent, callbackPayload);
      expect(newEvents.filter((event) => event.kind === 'tls' && event.listener === 'san-match').length).toBeGreaterThanOrEqual(2);

      const expectedDigest = `sha256:${createHash('sha256').update(JSON.stringify([origin])).digest('hex')}`;
      const processEvidence = policyLogEvidence.at(-1);
      expect(processEvidence).toMatchObject({ digest: expectedDigest, originFieldPresent: false, mentionsFixtureHostname: false });
      savePrivateHttpsCase('positive-callback-download', {
        operationId: run.operationId,
        state: run.terminal.state,
        publicGetStatus: 200,
        publicDownloadStatus: publicDownload.status,
        publicDownloadBytes: Buffer.byteLength(publicDownloadText),
        listenerEvents: newEvents,
        workerPolicyLog: processEvidence,
      });
    }, 60_000);

    test('parallel branch children share the configured private HTTPS policy', async () => {
      await installConfiguredWorker([httpsFixture.sanMatchOrigin]);
      const payload = { syntheticRun: 'orv14-private-https-branch', branch: 'callback', effect: 'none' };
      const before = httpsFixture.events.length;
      const run = await submitPrivateHttpsCase('wfa-private-https-branch', {
        reference: 'synthetic-branch-policy',
        fileUrl: httpsFixture.url('san-match', '/file.txt'),
        callbackUrl: httpsFixture.url('san-match', '/callback'),
        callbackPayload: payload,
      });
      const events = httpsFixture.events.slice(before);
      expect(run.terminal.state).toBe('SUCCEEDED');
      expect(events.some((event) => event.kind === 'request' && event.path === '/file.txt' && event.sni === PRIVATE_HTTPS_TARGETS.sanMatch.host)).toBe(true);
      const callbackEvent = events.find((event) => event.kind === 'request' && event.method === 'POST' && event.path === '/callback');
      expectPrivateCallbackPayload(callbackEvent, payload);
      savePrivateHttpsCase('parallel-branches', { operationId: run.operationId, state: run.terminal.state, listenerEvents: events });
    }, 60_000);

    test('a resumed HITL workflow keeps the Worker policy for its later HTTPS callback', async () => {
      await installConfiguredWorker([httpsFixture.sanMatchOrigin]);
      const payload = { syntheticRun: 'orv14-private-https-hitl-resume', effect: 'none' };
      const before = httpsFixture.events.length;
      const submitted = await submitLeafSchemaInput('wfa-private-https-hitl', {
        reference: 'synthetic-hitl-policy',
        fileUrl: httpsFixture.url('san-match', '/file.txt'),
        callbackUrl: httpsFixture.url('san-match', '/callback'),
        callbackPayload: payload,
      });
      expect(submitted.response.status).toBe(202);
      operationObservations.push({ schemaSlug: 'wfa-private-https-hitl', operationId: submitted.operationId, phase: 'admitted' });
      await app!.dispatcher.dispatchOnce();
      const waiting = await waitForState(submitted.operationId, ['WAITING_INPUT'], 45_000);
      expect(waiting.state).toBe('WAITING_INPUT');
      expect(httpsFixture.events.slice(before).some((event) => event.kind === 'request' && event.path === '/file.txt')).toBe(true);
      const waitingOperation = await stateOf(submitted.operationId);
      const pendingWait = await app!.db.query<{ wait_id: string }>(
        "SELECT wait_id FROM human_waits WHERE operation_id=$1 AND status='OPEN' AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
        [submitted.operationId],
      );
      if (!pendingWait.rowCount || !pendingWait.rows[0]?.wait_id) throw new Error('HITL workflow has no open tenant wait to resume');
      const resume = await fetch(`${internalUrl}/api/internal/operations/${submitted.operationId}/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          waitId: pendingWait.rows[0].wait_id,
          expectedStateVersion: waitingOperation.state_version,
          input: { step: 2, extracted_data: { approved: true, reference: 'synthetic-review' } },
        }),
      });
      expect(resume.status).toBe(200);
      await app!.dispatcher.dispatchOnce();
      const terminal = await waitForState(submitted.operationId, ['SUCCEEDED'], 45_000);
      const polled = await poll(submitted.operationId, leafApiKey);
      const events = httpsFixture.events.slice(before);
      expect(terminal.state).toBe('SUCCEEDED');
      expect(polled.response.status).toBe(200);
      const callbackEvent = events.find((event) => event.kind === 'request' && event.method === 'POST' && event.path === '/callback');
      expectPrivateCallbackPayload(callbackEvent, payload);
      const publicDownload = await fetch(`${baseUrl}/api/v1/operations/${submitted.operationId}/download`, { headers: { 'x-api-key': leafApiKey } });
      expect(publicDownload.status).toBe(200);
      expect(await publicDownload.text()).toBe('callback sent');
      savePrivateHttpsCase('hitl-resume', { operationId: submitted.operationId, waitingState: waiting.state, resumeStatus: resume.status, terminalState: terminal.state, publicDownloadStatus: publicDownload.status, listenerEvents: events });
    }, 90_000);

    test('an explicit operation retry reuses the admitted schema pin and reaches HTTPS on the next attempt', async () => {
      await installConfiguredWorker([httpsFixture.sanMatchOrigin]);
      const before = httpsFixture.count('san-match', 'request', '/flaky');
      const first = await submitPrivateHttpsCase('wfa-private-https-retry', {
        reference: 'synthetic-retry-policy', fileUrl: httpsFixture.url('san-match', '/flaky'),
      });
      expect(first.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED' });
      expect(httpsFixture.count('san-match', 'request', '/flaky') - before).toBe(1);
      const retryResponse = await fetch(`${internalUrl}/api/v1/admin/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ action: 'operations.retry', params: { operationId: first.operationId } }),
      });
      const retryBody = await retryResponse.json() as { operationId?: unknown; retryOf?: unknown; replayed?: unknown };
      expect(retryResponse.status).toBe(200);
      expect(retryBody).toMatchObject({ retryOf: first.operationId, replayed: false });
      expect(typeof retryBody.operationId).toBe('string');
      const retryId = String(retryBody.operationId);
      const retryTerminal = await dispatchUntilState(retryId, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'], 45_000);
      expect(retryTerminal.state).toBe('SUCCEEDED');
      expect(httpsFixture.count('san-match', 'request', '/flaky') - before).toBe(2);
      const publicResult = await poll(retryId, leafApiKey);
      expect(publicResult.response.status).toBe(200);
      expect(publicResult.body.done).toBe(true);
      savePrivateHttpsCase('operation-retry', { originalOperationId: first.operationId, originalState: first.terminal.state, retryOperationId: retryId, retryState: retryTerminal.state, retryStatus: retryResponse.status, listenerRequestCount: httpsFixture.count('san-match', 'request', '/flaky') - before });
    }, 90_000);

    test('worker default deny rejects a tenant-approved private origin when the operator list is empty', async () => {
      await installConfiguredWorker([]);
      const before = httpsFixture.events.length;
      const run = await submitPrivateHttpsCase('wfa-private-https-download', {
        reference: 'synthetic-default-deny', fileUrl: httpsFixture.url('san-match', '/file.txt'),
      });
      expect(run.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED' });
      expect(httpsFixture.events.slice(before)).toHaveLength(0);
      savePrivateHttpsCase('operator-default-deny', { operationId: run.operationId, state: run.terminal.state, errorCode: run.terminal.error_code, listenerEvents: [] });
    }, 45_000);

    test('tenant schema approval blocks an origin absent from that immutable pin', async () => {
      const alternateOrigin = httpsFixture.sanMatchAlternateOrigin;
      expect(new URL(alternateOrigin).hostname).toBe(PRIVATE_HTTPS_TARGETS.sanMatch.host);
      expect(new URL(alternateOrigin).port).not.toBe(new URL(httpsFixture.sanMatchOrigin).port);
      await installConfiguredWorker([alternateOrigin]);
      const positiveStart = httpsFixture.events.length;
      const positive = await submitPrivateHttpsCase('wfa-private-https-schema-only-b', {
        reference: 'synthetic-tenant-fence-positive-control', fileUrl: httpsFixture.url('san-match-alt', '/file.txt'),
      });
      const positiveEvents = httpsFixture.events.slice(positiveStart);
      expect(positive.terminal.state).toBe('SUCCEEDED');
      expect(positiveEvents.some((event) => event.kind === 'request'
        && event.listener === 'san-match-alt'
        && event.method === 'GET'
        && event.path === '/file.txt'
        && event.host === new URL(alternateOrigin).host
        && event.sni === PRIVATE_HTTPS_TARGETS.sanMatch.host)).toBe(true);

      const before = httpsFixture.events.length;
      const run = await submitPrivateHttpsCase('wfa-private-https-schema-only-a', {
        reference: 'synthetic-tenant-origin-fence', fileUrl: httpsFixture.url('san-match-alt', '/file.txt'),
      });
      expect(run.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_EGRESS_ORIGIN_DENIED' });
      expect(httpsFixture.events.slice(before)).toHaveLength(0);
      const workerEvidence = policyLogEvidence.at(-1);
      expect(workerEvidence).toMatchObject({
        digest: `sha256:${createHash('sha256').update(JSON.stringify([alternateOrigin])).digest('hex')}`,
        originFieldPresent: false,
        mentionsFixtureHostname: false,
      });
      savePrivateHttpsCase('tenant-origin-fence', {
        positiveControl: { operationId: positive.operationId, state: positive.terminal.state, listenerEvents: positiveEvents },
        excludedTenantOrigin: alternateOrigin,
        operationId: run.operationId,
        state: run.terminal.state,
        errorCode: run.terminal.error_code,
        listenerEvents: [],
        workerPolicyLog: workerEvidence,
      });
    }, 45_000);

    test('operator list and tenant pin intersect; operator-only origin cannot be reached', async () => {
      const alternateOrigin = httpsFixture.sanMatchAlternateOrigin;
      await installConfiguredWorker([alternateOrigin]);
      const positiveStart = httpsFixture.events.length;
      const positive = await submitPrivateHttpsCase('wfa-private-https-schema-only-b', {
        reference: 'synthetic-operator-fence-positive-control', fileUrl: httpsFixture.url('san-match-alt', '/file.txt'),
      });
      const positiveEvents = httpsFixture.events.slice(positiveStart);
      expect(positive.terminal.state).toBe('SUCCEEDED');
      expect(positiveEvents.some((event) => event.kind === 'request'
        && event.listener === 'san-match-alt'
        && event.method === 'GET'
        && event.path === '/file.txt'
        && event.host === new URL(alternateOrigin).host
        && event.sni === PRIVATE_HTTPS_TARGETS.sanMatch.host)).toBe(true);

      await installConfiguredWorker([httpsFixture.sanMatchOrigin]);
      const before = httpsFixture.events.length;
      const run = await submitPrivateHttpsCase('wfa-private-https-schema-only-b', {
        reference: 'synthetic-operator-origin-fence', fileUrl: httpsFixture.url('san-match-alt', '/file.txt'),
      });
      expect(run.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED' });
      expect(httpsFixture.events.slice(before)).toHaveLength(0);
      const workerEvidence = policyLogEvidence.at(-1);
      expect(workerEvidence).toMatchObject({
        digest: `sha256:${createHash('sha256').update(JSON.stringify([httpsFixture.sanMatchOrigin])).digest('hex')}`,
        originFieldPresent: false,
        mentionsFixtureHostname: false,
      });
      // The released Worker catches non-domain failures from createPinnedFetchForOrigin
      // in legacy-schema-runtime.ts and exposes LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED.
      savePrivateHttpsCase('operator-tenant-intersection', {
        positiveControl: { operationId: positive.operationId, state: positive.terminal.state, listenerEvents: positiveEvents },
        tenantApprovedOperatorExcludedOrigin: alternateOrigin,
        operationId: run.operationId,
        state: run.terminal.state,
        errorCode: run.terminal.error_code,
        listenerEvents: [],
        workerPolicyLog: workerEvidence,
      });
    }, 45_000);

    test('verified TLS rejects a SAN mismatch while preserving the requested SNI', async () => {
      await installConfiguredWorker([httpsFixture.sanMismatchOrigin]);
      const before = httpsFixture.events.length;
      const run = await submitPrivateHttpsCase('wfa-private-https-schema-a-b', {
        reference: 'synthetic-san-mismatch', fileUrl: httpsFixture.url('san-mismatch', '/file.txt'),
      });
      const events = httpsFixture.events.slice(before);
      expect(run.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED' });
      expect(events.some((event) => event.kind === 'tls-error' && event.listener === 'san-mismatch' && event.sni === PRIVATE_HTTPS_TARGETS.sanMismatch.host)).toBe(true);
      expect(events.some((event) => event.kind === 'request' && event.listener === 'san-mismatch')).toBe(false);
      savePrivateHttpsCase('san-mismatch', { operationId: run.operationId, state: run.terminal.state, errorCode: run.terminal.error_code, listenerEvents: events });
    }, 45_000);

    test('redirects are not followed and oversized file responses fail at the worker byte limit', async () => {
      await installConfiguredWorker([httpsFixture.sanMatchOrigin]);
      const redirectStart = httpsFixture.events.length;
      const redirect = await submitPrivateHttpsCase('wfa-private-https-redirect', {
        reference: 'synthetic-redirect-no-follow', fileUrl: httpsFixture.url('san-match', '/redirect'),
      });
      const redirectEvents = httpsFixture.events.slice(redirectStart);
      expect(redirect.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED' });
      expect(redirectEvents.some((event) => event.kind === 'request' && event.path === '/redirect')).toBe(true);
      expect(redirectEvents.some((event) => event.kind === 'request' && event.path === '/file.txt')).toBe(false);
      savePrivateHttpsCase('redirect-no-follow', { operationId: redirect.operationId, state: redirect.terminal.state, errorCode: redirect.terminal.error_code, listenerEvents: redirectEvents });

      const oversizedStart = httpsFixture.events.length;
      const oversized = await submitPrivateHttpsCase('wfa-private-https-oversize', {
        reference: 'synthetic-size-limit', fileUrl: httpsFixture.url('san-match', '/oversize'),
      });
      const oversizedEvents = httpsFixture.events.slice(oversizedStart);
      expect(oversized.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_FILE_TOO_LARGE' });
      expect(oversizedEvents.some((event) => event.kind === 'request' && event.path === '/oversize')).toBe(true);
      savePrivateHttpsCase('file-size-limit', { operationId: oversized.operationId, state: oversized.terminal.state, errorCode: oversized.terminal.error_code, listenerEvents: oversizedEvents });
    }, 90_000);

    test('operation cancellation aborts the active pinned HTTPS request', async () => {
      await installConfiguredWorker([httpsFixture.sanMatchOrigin]);
      const submitted = await submitLeafSchemaInput('wfa-private-https-cancel', {
        reference: 'synthetic-cancel-egress', fileUrl: httpsFixture.url('san-match', '/slow'),
      });
      expect(submitted.response.status).toBe(202);
      operationObservations.push({ schemaSlug: 'wfa-private-https-cancel', operationId: submitted.operationId, phase: 'admitted' });
      await app!.dispatcher.dispatchOnce();
      await waitForCondition(() => httpsFixture.count('san-match', 'request', '/slow') > 0, 15_000, 'private HTTPS slow request to reach the listener');
      const cancel = await fetch(`${internalUrl}/api/internal/operations/${submitted.operationId}/cancel`, {
        method: 'POST', headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(cancel.status).toBe(200);
      const terminal = await waitForState(submitted.operationId, ['CANCELLED'], 20_000);
      await waitForCondition(() => httpsFixture.count('san-match', 'client-close', '/slow') > 0, 10_000, 'HTTPS client socket close after operation cancellation');
      const events = httpsFixture.events.filter((event) => event.path === '/slow');
      expect(terminal.state).toBe('CANCELLED');
      savePrivateHttpsCase('operation-cancellation', { operationId: submitted.operationId, state: terminal.state, cancelStatus: cancel.status, listenerEvents: events });
    }, 50_000);

    test('metadata, link-local, CGNAT, multicast, and reserved IP literals stay blocked with private opt-in', async () => {
      const blockedAddresses = [
        { label: 'metadata-link-local', address: '169.254.169.254' },
        { label: 'link-local', address: '169.254.20.10' },
        { label: 'cgnat', address: '100.64.0.1' },
        { label: 'multicast', address: '224.0.0.1' },
        { label: 'documentation-reserved', address: '192.0.2.1' },
        { label: 'future-use-reserved', address: '240.0.0.1' },
      ] as const;
      const origins = blockedAddresses.map(({ address }) => `https://${address}`);
      await installConfiguredWorker(origins);
      for (const item of blockedAddresses) {
        const origin = `https://${item.address}`;
        const slug = `wfa-private-https-block-${item.label}`;
        await provisionPrivateHttpsSchema(slug, privateHttpsDownloadSchema(slug), [origin]);
        const before = httpsFixture.events.length;
        const run = await submitPrivateHttpsCase(slug, {
          reference: `synthetic-block-${item.label}`, fileUrl: `${origin}/latest/meta-data/`,
        });
        expect(run.terminal).toMatchObject({ state: 'FAILED', error_code: 'LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED' });
        expect(httpsFixture.events.slice(before)).toHaveLength(0);
        savePrivateHttpsCase(item.label, { operationId: run.operationId, state: run.terminal.state, errorCode: run.terminal.error_code, listenerEvents: [] });
      }
    }, 180_000);
  });

});
