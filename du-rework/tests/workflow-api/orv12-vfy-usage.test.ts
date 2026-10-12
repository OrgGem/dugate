import { EXPECTED_RESULT_CORPUS, normalizeNondeterministicFields } from '../../businesses/document-core/tests/fixtures/expected-result-corpus';
import { chromium } from '../browser/node_modules/@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signCookie } from '../../orchestrator/services/orchestrator/src/app/admin/shell-auth';
const browserCookieSecret='orv11-core-browser-synthetic-secret';
import { VARIANT_TRACEABILITY_MATRIX } from '../../businesses/document-core/src/manifest/traceability';
import { MockTaskContext } from '../../businesses/document-core/tests/fixtures/mock-context';
import { getVariantFixture } from './orv11-vfy-variant-fixtures';
let providerCost:number|undefined=725;
let matrixProviderValue: {data?:unknown;rawText?:string} | undefined;
import { HttpUsageSink } from '../../orchestrator/services/connector/src/usage-dispatcher';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { documentCoreManifest } from '../../businesses/document-core/src/manifest/document-core.manifest';
import { documentCoreHandlers, startDocumentCoreWorker, type WorkerHandle } from '../../businesses/document-core/src/worker';
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

const isolation = createWorkflowApiIsolation();
const connectorIsolationContext = createTestIsolationContext({
  runId: `${isolation.id}_connector`,
  baseArtifactPath: 'tests/workflow-api/.scratch/connector-artifacts',
});
const keyProvider = syntheticMetadataKeyProvider();
const metadataCrypto = createMetadataCrypto(
  adaptKeyProviderForMetadata(keyProvider),
  'du-orch-metadata-v1',
);
const baseDb = createDb(isolation.baseDatabaseUrl);
const tenantId = randomUUID();
const secondConnectorId=randomUUID();
const otherTenantId = randomUUID();
const apiKey = `wfa-worker-${randomUUID()}`;
const namedApiKey = `wfa-worker-named-${randomUUID()}`;
const disbursementApiKey = `wfa-worker-disbursement-${randomUUID()}`;
const lcApiKey = `wfa-worker-lc-${randomUUID()}`;
const otherApiKey = `wfa-worker-other-${randomUUID()}`;
const leafApiKey = `wfa-worker-leaf-${randomUUID()}`;
const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
const namedApiKeyHash = createHash('sha256').update(namedApiKey).digest('hex');
const disbursementApiKeyHash = createHash('sha256').update(disbursementApiKey).digest('hex');
const lcApiKeyHash = createHash('sha256').update(lcApiKey).digest('hex');
const otherApiKeyHash = createHash('sha256').update(otherApiKey).digest('hex');
const leafApiKeyHash = createHash('sha256').update(leafApiKey).digest('hex');
const runtimeToken = `wfa-worker-platform-${randomUUID()}`;
const workerIdentityToken = `wfa-worker-document-core-${randomUUID()}`;
const lcWorkerIdentityToken = `wfa-worker-lc-checker-${randomUUID()}`;
const adminToken = `wfa-worker-admin-${randomUUID()}`;
const invocationGrantSecret = `wfa-invocation-grant-${randomUUID()}`;
const connectorServiceSecret = randomBytes(32);
const connectorProviderCalls: Array<{ task: string; prompt: string; artifacts: Array<Record<string, unknown>> }> = [];
const providerAbortedCalls: string[] = [];
let providerDelayMs = 0;
let app: App | undefined;
let worker: WorkerHandle | undefined;
let lcWorker: WorkerHandle | undefined;
let connectorProviderServer: Server | undefined;
const usageToken=randomUUID();
let releaseUsage!:()=>void;
const usageGate=new Promise<void>(resolve=>{releaseUsage=resolve});
let connectorComposition: ReturnType<typeof createConnectorComposition> | undefined;
let baseUrl = '';
let internalUrl = '';
let connectorBaseUrl = '';
let connectorProviderUrl = '';
let isolatedSchemaCreated = false;
let connectorSchemaCreated = false;
let namedConnectorId = '';
const workerErrorFrames: Array<{ handler: string; taskKey: string; errorName: string; frames: string[] }> = [];

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

function providerEnvelope(task: string, prompt: string, artifacts: Array<Record<string, unknown>>) {
  if(matrixProviderValue) return {content:matrixProviderValue.rawText ?? (typeof matrixProviderValue.data==='string'?matrixProviderValue.data:JSON.stringify(matrixProviderValue.data)),data:matrixProviderValue.data,usage:{inputTokens:2,outputTokens:3,...(providerCost===undefined?{}:{costMicrousd:providerCost}),pages:3,provider:'orv12-local',model:'orv12-priced',measurement:'measured'},providerRequestId:randomUUID()};
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
    usage: { inputTokens: 2, outputTokens: 3, pages: 1, costMicrousd: 725, provider:'orv12-local', model:'orv12-priced', measurement: 'measured' as const },
    providerRequestId: `wfa-provider-${connectorProviderCalls.length + 1}`,
  };
}

async function startNamedConnectorFixture(): Promise<void> {
  if (connectorComposition && connectorProviderServer) return;
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
      connectorProviderCalls.push({ task, prompt, artifacts });
      response.on('close', () => {
        if (!response.writableEnded) providerAbortedCalls.push(task);
      });
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
    usageSink:{send:async(event,signal)=>{await usageGate;await new HttpUsageSink(`${internalUrl}/api/runtime/v1/usage-events`,usageToken).send(event,signal);}},
    usageDispatcher:{pollIntervalMs:25,baseRetryMs:25,maxRetryMs:50},
    host: '127.0.0.1',
    databaseUrl: connectorIsolationContext.getDatabaseUrlWithSchema(isolation.baseDatabaseUrl),
    redisUrl: isolation.redisUrl,
    redisKeyPrefix: `${connectorIsolationContext.redisPrefix}quota:`,
    serviceIdentityVerifier: new HmacServiceIdentityVerifier(connectorServiceSecret),
    grantVerifier: new ContractSignedGrantVerifier(
      new HmacSignedGrantSource(Buffer.from(invocationGrantSecret, 'utf8')),
    ),
    credentialCipher: new AesCredentialCipher(randomBytes(32)),
    providerTransport: new FetchProviderTransport({ allowHosts: ['127.0.0.1'], allowPrivateNetworks: true }),
    invocationStorageCrypto: {
      fieldCrypto: createInvocationFieldCrypto(
        createLocalInvocationKekProvider(parsedStorageKeys),
        parsedStorageKeys.keyRef,
      ),
    },
  });
  await connectorComposition.start();
  const connectorAddress = connectorComposition.address();
  if (!connectorAddress || typeof connectorAddress === 'string') throw new Error('synthetic Connector service did not bind');
  connectorBaseUrl = `http://127.0.0.1:${connectorAddress.port}`;

  const connectorId = randomUUID();
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
      try {
        return await original(context, payload);
      } catch (error: unknown) {
        if (error instanceof Error) {
          // A parser message can quote payload bytes, so this temporary
          // verifier trace retains stack frames only, never the message.
          const frames = (error.stack ?? '').split(/\r?\n/).slice(1, 13).map((frame) => frame.trim());
          const taskKey = String((context as unknown as { taskKey?: unknown }).taskKey ?? 'unknown');
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

async function poll(operationId: string, key = apiKey): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/v1/operations/${operationId}`, {
    headers: { 'x-api-key': key },
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe('ORV12 independent provider usage consumer', () => {
  beforeAll(async () => {
    process.env.DU_ADMIN_WEB='1';process.env.DU_ADMIN_WEB_DIST=resolve('orchestrator/apps/admin-web/dist');
    await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
    isolatedSchemaCreated = true;
    // Named disbursement/lc-checker/document-core connector stages run against
    // this loopback Connector + provider pair, so the app must be wired to it.
    await startNamedConnectorFixture();
    const priorSeed = process.env.DU_SEED_DEV_FALLBACK;
    process.env.DU_SEED_DEV_FALLBACK = 'false';
    try {
      app = await createApp({
        host: '127.0.0.1',
        port: 0,
        internalHost: '127.0.0.1',
        internalPort: 0,
        databaseUrl: isolation.databaseUrl,
        redisUrl: isolation.redisUrl,
        runtimeToken, usageToken,
        workerIdentityTokensByBusiness: {
          'document-core': workerIdentityToken,
          'lc-checker': lcWorkerIdentityToken,
        },
        connectorBaseUrls: { [namedConnectorId]: connectorBaseUrl,[secondConnectorId]:connectorBaseUrl },
        connectorManagementAuthorizationForRequest:()=>`Bearer ${serviceIdentityToken(['connector:manage'])}`, 
        connectorId: namedConnectorId,
        connectorRevision: 1,
        invocationGrantSecret,
        adminToken, adminShellCookieSecret:browserCookieSecret,adminShellHost:'127.0.0.1',adminShellPort:0,
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
    await registerAndActivateDocumentCore();
    await registerAndActivateLcChecker();

    await app.db.query('INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)', [
      tenantId, 'WFA worker tenant', otherTenantId, 'WFA other tenant',
    ]);
    await app.db.query(
      `INSERT INTO api_keys (tenant_id, hash, prefix, status)
       VALUES ($1, $2, 'wfa-worker', 'ACTIVE'), ($1, $3, 'wfa-named', 'ACTIVE'), ($1, $6, 'wfa-disbursement', 'ACTIVE'),
              ($1, $7, 'wfa-lc-checker', 'ACTIVE'), ($1, $8, 'wfa-leaf', 'ACTIVE'), ($4, $5, 'wfa-other', 'ACTIVE')`,
      [tenantId, apiKeyHash, namedApiKeyHash, otherTenantId, otherApiKeyHash, disbursementApiKeyHash, lcApiKeyHash, leafApiKeyHash],
    );
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
    worker = await startDocumentCoreWorker({
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
      concurrency: 2,
      heartbeatIntervalMs: 1_000,
    });
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
    releaseUsage();
    if (lcWorker) await lcWorker.stop(5_000);
    if (worker) await worker.stop(5_000);
    if (connectorComposition) await connectorComposition.shutdown();
    if (connectorProviderServer) await new Promise<void>((resolve) => connectorProviderServer.close(() => resolve()));
    if (app) await app.close({timeoutMs:0,pollIntervalMs:10});
    if (isolatedSchemaCreated) await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
    await baseDb.close();
    isolation.context.cleanupArtifactDir();
  }, 60_000);



  test('provider measurement persists atomically then dispatches to ledger, exact public result/billing and duplicate idempotency',async()=>{
    await createProfileService(app!.db).createRevision({apiKeyHash,businessId:'document-core',businessVersion:documentCoreManifest.version,action:'extract',connectorBindings:{reasoning:{connectorId:namedConnectorId,revision:1}}});
    matrixProviderValue={data:{invoiceNumber:'INV-101',supplier:'Acme Corp',total:'$500.00'}};
    const form=multipart({type:'invoice',text:'ORV12 deterministic measured usage'});
    const response=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':apiKey,'idempotency-key':'orv12-usage-submit'},body:form});
    const body=await response.json() as {name:string};if(response.status!==202)throw new Error(`submit ${response.status}: ${JSON.stringify(body)}`);
    const id=body.name.replace('operations/','');expect((await dispatchAndWait(id,['SUCCEEDED'])).state).toBe('SUCCEEDED');
    const cdb=createDb(connectorIsolationContext.getDatabaseUrlWithSchema(isolation.baseDatabaseUrl));
    try{
      const outbox=await cdb.query('SELECT o.payload,i.state FROM connector_usage_outbox o JOIN connector_invocations i ON i.invocation_id=o.invocation_id WHERE i.operation_id=$1',[id]);
      expect(outbox.rowCount).toBe(1);expect(outbox.rows[0].state).toBe('SUCCEEDED');
      expect((await app!.db.query('SELECT * FROM usage_events WHERE operation_id=$1',[id])).rowCount).toBe(0);
      releaseUsage();
      await waitForCondition(async()=> (await app!.db.query('SELECT * FROM usage_events WHERE operation_id=$1',[id])).rowCount===1,15000,'actual usage ledger ingestion');
      const result=await fetch(`${baseUrl}/api/v1/operations/${id}`,{headers:{'x-api-key':apiKey}});const wire=await result.json();
      const billing=await fetch(`${baseUrl}/api/v1/billing/usage`,{headers:{'x-api-key':apiKey}});const balance=await fetch(`${baseUrl}/api/v1/billing/balance`,{headers:{'x-api-key':apiKey}});
      const usageBody=await billing.json(),balanceBody=await balance.json();
      mkdirSync(resolve('reports/raw/orv12/usage'),{recursive:true});writeFileSync(resolve('reports/raw/orv12/usage/consumer.json'),JSON.stringify({wire,usageBody,balanceBody},null,2));
      expect(wire.result.usage).toMatchObject({input_tokens:2,output_tokens:3,pages_processed:3,model_used:'orv12-priced',cost_usd:0.000725});expect(usageBody).toMatchObject({total_cost_usd:0.000725,total_input_tokens:2,total_output_tokens:3,total_operations:1});expect(balanceBody.details.total_used).toBe(0.000725);
      await new HttpUsageSink(`${internalUrl}/api/runtime/v1/usage-events`,usageToken).send(outbox.rows[0].payload);
      expect((await app!.db.query('SELECT * FROM usage_events WHERE operation_id=$1',[id])).rowCount).toBe(1);
      await app!.db.query('UPDATE api_keys SET spending_limit=$1 WHERE hash=$2',['0.000700',apiKeyHash]);
      const replayForm=multipart({type:'invoice',text:'ORV12 deterministic measured usage'});
      const replay=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':apiKey,'idempotency-key':'orv12-usage-submit'},body:replayForm});expect(replay.status).toBe(200);expect((await replay.json() as {name:string}).name).toBe(`operations/${id}`);
      const countBefore=(await app!.db.query('SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1',[tenantId])).rows[0].n;
      const rejected=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':apiKey},body:multipart({type:'invoice',text:'new rejected request'})});expect(rejected.status).toBe(402);
      expect((await app!.db.query('SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1',[tenantId])).rows[0].n).toBe(countBefore);
      await app!.db.query('UPDATE api_keys SET spending_limit=$1,total_used=$2 WHERE hash=$3',['2.500700','2.500000',apiKeyHash]);
      const historical=await fetch(`${baseUrl}/api/v1/billing/balance`,{headers:{'x-api-key':apiKey}});expect((await historical.json() as any).details.total_used).toBe(2.500725);
      const isolated=await fetch(`${baseUrl}/api/v1/billing/balance`,{headers:{'x-api-key':namedApiKey}});expect((await isolated.json() as any).details.total_used).toBe(0);
      const historicalDeny=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':apiKey},body:multipart({type:'invoice',text:'historical limit reached'})});expect(historicalDeny.status).toBe(402);
      await app!.db.query('UPDATE api_keys SET spending_limit=0 WHERE hash=$1',[apiKeyHash]);
      const unlimited=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':apiKey},body:multipart({type:'invoice',text:'unlimited accepted'})});expect(unlimited.status).toBe(202);const unlimitedId=(await unlimited.json() as {name:string}).name.replace('operations/','');await fetch(`${internalUrl}/api/internal/operations/${unlimitedId}/cancel`,{method:'POST',headers:{authorization:`Bearer ${adminToken}`}});

    }finally{await cdb.close();}
  },60000);
  test.each([{name:'measured zero',cost:0,expected:0},{name:'unpriced',cost:undefined,expected:null}])('provider $name cost remains distinct in actual legacy result',async scenario=>{
    providerCost=scenario.cost;
    const response=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':apiKey},body:multipart({type:'invoice',text:`ORV12 ${scenario.name}`})});
    const body=await response.json() as {name:string};expect(response.status).toBe(202);const id=body.name.replace('operations/','');expect((await dispatchAndWait(id,['SUCCEEDED'])).state).toBe('SUCCEEDED');
    await waitForCondition(async()=> (await app!.db.query('SELECT * FROM usage_events WHERE operation_id=$1',[id])).rowCount===1,15000,'cost status ingestion');
    const responseBody=await (await fetch(`${baseUrl}/api/v1/operations/${id}`,{headers:{'x-api-key':apiKey}})).json() as any;
    expect(responseBody.result.usage.cost_usd).toBe(scenario.expected);expect(responseBody.result.usage.input_tokens).toBe(2);
    writeFileSync(resolve('reports/raw/orv12/usage',`${scenario.name.replace(' ','-')}.json`),JSON.stringify(responseBody,null,2));
  },60000);

  test('settings audited revision validation/apply/rollback changes only new encrypted admission pins',async()=>{
    const key=(await app!.db.query('SELECT id FROM api_keys WHERE hash=$1',[apiKeyHash])).rows[0].id;
    const scope={tenantId,apiKeyId:key,endpointSlug:'extract:invoice'};
    const action=async(name:string,params:unknown,expected=200)=>{const response=await fetch(`${internalUrl}/api/v1/admin/actions`,{method:'POST',headers:{authorization:`Bearer ${adminToken}`,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({action:name,params}),signal:AbortSignal.timeout(10000)});const body=await response.json() as any;if(response.status!==expected)throw new Error(`${name} ${response.status} ${JSON.stringify(body)}`);return body.data??body;};
    const profile=await action('profile.upsert',{apiKey:{apiKeyId:key},profileName:'ORV12 dedicated invoice',businessId:'document-core',businessVersion:documentCoreManifest.version,action:'extract',endpointSlug:scope.endpointSlug,connectorBindings:{reasoning:{connectorId:namedConnectorId,revision:1}},policy:{}},201);
    const cdb=createDb(connectorIsolationContext.getDatabaseUrlWithSchema(isolation.baseDatabaseUrl));
    await cdb.query(`INSERT INTO connector_revisions(connector_id,revision,adapter,config,credential_ref,state,tenant_id,credential_source) SELECT $2,1,adapter,config,credential_ref,state,tenant_id,credential_source FROM connector_revisions WHERE connector_id=$1 AND revision=1`,[namedConnectorId,secondConnectorId]);await cdb.close();
    const submit=async(label:string)=>{const response=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':apiKey},body:multipart({type:'invoice',text:label})});const body=await response.json() as {name:string};expect(response.status).toBe(202);return body.name.replace('operations/','');};
    const original=await submit('settings original');const oldRow=(await app!.db.query('SELECT connector_bindings,prompt_overrides_ref FROM operations WHERE id=$1',[original])).rows[0];
    const draft=await action('settings.revision.create',{...scope,expectedActiveRevision:null,changes:{connectorBindings:{reasoning:{connectorId:secondConnectorId,revision:1}},prompts:[{connectionId:secondConnectorId,stepId:'_default',promptOverride:'ORV12 encrypted settings prompt'}]}});
    const validation=await action('settings.revision.validate',{...scope,revision:draft.revision});if(!validation.valid)throw new Error(`settings validation ${JSON.stringify(validation)}`);
    const otherDraft=await action('settings.revision.create',{...scope,expectedActiveRevision:null,changes:{prompts:[{connectionId:namedConnectorId,stepId:'_default',promptOverride:'stale draft must not apply'}]}});
    const applied=await action('settings.revision.apply',{...scope,revision:draft.revision,expectedActiveRevision:null});expect(applied.activeRevision).toBe(draft.revision);
    await action('settings.revision.apply',{...scope,revision:otherDraft.revision,expectedActiveRevision:null},409);
    await action('settings.revision.validate',{...scope,tenantId:otherTenantId,revision:draft.revision},404);
    const changed=await submit('settings changed');const row=(await app!.db.query('SELECT connector_bindings,prompt_overrides_ref FROM operations WHERE id=$1',[changed])).rows[0];
    expect(row.connector_bindings.reasoning).toBe(`${secondConnectorId}@1`);
    expect(JSON.stringify(await metadataCrypto.open(row.prompt_overrides_ref,{tenantId,slot:'operations.prompt_overrides_ref',refId:changed}))).toContain('ORV12 encrypted settings prompt');
    expect(JSON.stringify(row.prompt_overrides_ref)).not.toContain('ORV12 encrypted settings prompt');
    expect((await app!.db.query('SELECT connector_bindings,prompt_overrides_ref FROM operations WHERE id=$1',[original])).rows[0]).toEqual(oldRow);
    const rollback=await action('settings.revision.rollback',{...scope,revision:0,expectedActiveRevision:draft.revision});expect(rollback.activeRevision).toBeGreaterThan(draft.revision);
    const restored=await submit('settings restored');expect((await app!.db.query('SELECT connector_bindings FROM operations WHERE id=$1',[restored])).rows[0].connector_bindings.reasoning).toBe(`${namedConnectorId}@1`);
    const stored=await app!.db.query('SELECT payload_ref FROM settings_revisions');expect(JSON.stringify(stored.rows)).not.toContain('ORV12 encrypted settings prompt');
    mkdirSync(resolve('reports/raw/orv12/settings'),{recursive:true});writeFileSync(resolve('reports/raw/orv12/settings/lifecycle.json'),JSON.stringify({draft,applied,rollback,oldOperation:original,newOperation:changed,restoredOperation:restored},null,2));
  },30000);


  test('browser creates dedicated native profile and drives settings draft validation apply rollback',async()=>{
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const dir=resolve('reports/raw/orv12/browser');mkdirSync(dir,{recursive:true});
    try{
      const context=await browser.newContext({viewport:{width:1440,height:1100}});const cookie=signCookie(browserCookieSecret,{iss:'du-admin-shell',role:'admin',iat:Date.now(),exp:Date.now()+300000});await context.addCookies([{name:'du_admin',value:cookie!,url:app!.adminShell!.url,httpOnly:true,sameSite:'Lax'}]);context.setDefaultTimeout(10000);const page=await context.newPage();page.on('dialog',d=>void d.accept());
      const scripts:string[]=[];page.on('response',r=>{if(/assets\/index-.*\.js/.test(r.url()))scripts.push(new URL(r.url()).pathname)});
      const keyId=(await app!.db.query('SELECT id FROM api_keys WHERE hash=$1',[namedApiKeyHash])).rows[0].id;
      await page.goto(`${app!.adminShell!.url}/admin/profiles`,{waitUntil:'networkidle'});await page.locator('#global-tenant-select').selectOption(tenantId);
      await page.getByLabel('Business',{exact:true}).selectOption('document-core');await page.getByLabel('Version',{exact:true}).selectOption(documentCoreManifest.version);await page.getByLabel('Profile Name',{exact:true}).fill('ORV12 browser invoice');await page.getByLabel('API Key',{exact:true}).selectOption(keyId);await page.getByLabel('Legacy endpoint',{exact:true}).selectOption('extract:invoice');
      await page.getByRole('button',{name:'Add connector slot',exact:true}).click();await page.getByLabel('Connector slot 1',{exact:true}).fill('reasoning');await page.getByLabel('Connector revision 1',{exact:true}).selectOption(`${namedConnectorId}@1`);
      await page.getByRole('button',{name:'Create Profile',exact:true}).click();await page.getByRole('button',{name:'Save Profile',exact:true}).waitFor();
      const saved=page.waitForResponse(r=>r.url().includes('/admin/api/profiles/')&&r.request().method()==='POST');await page.getByRole('button',{name:'Save Profile',exact:true}).click();const save=await saved;if(save.status()!==201&&save.status()!==200)throw new Error(`profile browser ${save.status()} ${await save.text()}`);await page.screenshot({path:resolve(dir,'native-profile-created.png'),fullPage:true});
      const profile=(await app!.db.query(`SELECT p.endpoint_slug,p.connector_bindings FROM profile_bindings p JOIN profile_names n ON n.profile_id=p.profile_id WHERE n.profile_name='extract' AND p.endpoint_slug='extract:invoice' AND p.tenant_id=$1`,[tenantId])).rows[0];expect(profile.endpoint_slug).toBe('extract:invoice');expect(profile.connector_bindings.reasoning).toEqual({connectorId:namedConnectorId,revision:1});
      await page.goto(`${app!.adminShell!.url}/admin/settings`,{waitUntil:'networkidle'});await page.locator('label').filter({hasText:/^API key/}).locator('select').selectOption(keyId);await page.locator('label').filter({hasText:/^Endpoint slug/}).locator('input').fill('extract:invoice');await page.getByRole('button',{name:'Load current overrides',exact:true}).click();await page.locator('label').filter({hasText:/^Profile connection/}).locator('select').selectOption(namedConnectorId);await page.locator('label').filter({hasText:/^Prompt/}).locator('textarea').fill('ORV12 browser applied prompt');
      const command=async(button:string,action:string)=>{const pending=page.waitForResponse(r=>r.url().includes('/admin/api/actions')&&r.request().postData()?.includes(action)===true);await page.getByRole('button',{name:button,exact:true}).click();const r=await pending;if(r.status()!==200)throw new Error(`browser ${action} ${r.status()} ${await r.text()}`);return r.json() as Promise<any>;};
      await command('Create configuration draft','settings.revision.create');await page.getByRole('button',{name:'Validate configuration',exact:true}).waitFor();await command('Validate configuration','settings.revision.validate');await command('Apply revision 1','settings.revision.apply');await page.getByText(/Active configuration: 1/).waitFor();await page.screenshot({path:resolve(dir,'settings-applied.png'),fullPage:true});
      const submitted=await fetch(`${baseUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':namedApiKey},body:multipart({type:'invoice',text:'ORV12 browser pin check'})});expect(submitted.status).toBe(202);const id=(await submitted.json() as {name:string}).name.replace('operations/','');const pinned=(await app!.db.query('SELECT prompt_overrides_ref FROM operations WHERE id=$1',[id])).rows[0].prompt_overrides_ref;expect(JSON.stringify(await metadataCrypto.open(pinned,{tenantId,slot:'operations.prompt_overrides_ref',refId:id}))).toContain('ORV12 browser applied prompt');
      await page.locator('label').filter({hasText:/^Revision history/}).locator('select').selectOption('0');await command('Restore revision 0','settings.revision.rollback');await page.getByText(/Active configuration: 2/).waitFor();await page.screenshot({path:resolve(dir,'settings-restored.png'),fullPage:true});
      writeFileSync(resolve(dir,'settings-browser.json'),JSON.stringify({scripts:[...new Set(scripts)],profileCreated:true,appliedRevision:1,restoredAsRevision:2,sealedSubmission:id},null,2));await context.close();
    }finally{for(const c of browser.contexts())for(const p of c.pages()){await p.screenshot({path:resolve(dir,'settings-browser-last.png'),fullPage:true}).catch(()=>{});writeFileSync(resolve(dir,'settings-browser-last.txt'),await p.locator('body').innerText().catch(()=>''));}await browser.close();}
  },90000);

  test('browser guided typed HITL validates required fields and resumes real worker; generic legacy schema preserves advanced fallback',async()=>{
    for(const row of (await app!.db.query("SELECT id FROM operations WHERE tenant_id=$1 AND state IN ('ACCEPTED','QUEUED')",[tenantId])).rows)await fetch(`${internalUrl}/api/internal/operations/${row.id}/cancel`,{method:'POST',headers:{authorization:`Bearer ${adminToken}`}});
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const dispatcher=setInterval(()=>void app!.dispatcher.dispatchOnce(),50);
    const dir=resolve('reports/raw/orv12/browser');mkdirSync(dir,{recursive:true});
    try{
      const form=multipart({schemaSlug:'wfa-human-one',input:JSON.stringify({reference:'ORV12 guided fixture'})});
      const response=await fetch(`${baseUrl}/api/v1/docs/workflows/schema`,{method:'POST',headers:{'x-api-key':leafApiKey},body:form});expect(response.status).toBe(202);const id=(await response.json() as {name:string}).name.replace('operations/','');expect((await waitForState(id,['WAITING_INPUT'])).state).toBe('WAITING_INPUT');
      const context=await browser.newContext({viewport:{width:1440,height:1100}});const cookie=signCookie(browserCookieSecret,{iss:'du-admin-shell',role:'admin',iat:Date.now(),exp:Date.now()+300000});await context.addCookies([{name:'du_admin',value:cookie!,url:app!.adminShell!.url,httpOnly:true,sameSite:'Lax'}]);
      context.setDefaultTimeout(10000);const page=await context.newPage();const scripts:string[]=[];page.on('response',r=>{if(/assets\/index-.*\.js/.test(r.url()))scripts.push(new URL(r.url()).pathname)});
      await page.goto(`${app!.adminShell!.url}/admin/operations?id=${id}`,{waitUntil:'networkidle'});await page.locator('#global-tenant-select').selectOption(tenantId);await page.getByRole('button',{name:`${id.slice(0,8)}…`,exact:true}).click();
      const wait=(await app!.db.query("SELECT wait_id FROM human_waits WHERE operation_id=$1 AND status='OPEN'",[id])).rows[0];await page.locator('label').filter({hasText:/^Pending review/}).locator('select').selectOption(wait.wait_id);
      await page.locator('label').filter({hasText:/^Review response \(JSON\)/}).locator('textarea').waitFor();await page.screenshot({path:resolve(dir,'hitl-legacy-fallback.png'),fullPage:true});
      const typedSchema={type:'object',additionalProperties:false,required:['step','extracted_data'],properties:{step:{type:'integer',minimum:1,maximum:2,title:'Review step'},extracted_data:{type:'object',title:'Decision',required:['approved','amount','comment'],additionalProperties:false,properties:{approved:{type:'boolean',title:'Approved'},amount:{type:'number',minimum:0,title:'Approved amount'},comment:{type:'string',minLength:3,title:'Review comment'}}}}};
      // Synthetic business-schema fixture, not a claim legacy human nodes emit this schema.
      await app!.db.query("UPDATE human_waits SET input_schema=$2 WHERE operation_id=$1 AND status='OPEN'",[id,JSON.stringify(typedSchema)]);
      await page.getByRole('button',{name:'Refresh detail',exact:true}).click();await page.locator('label').filter({hasText:/^Pending review/}).locator('select').selectOption(wait.wait_id);await page.getByRole('button',{name:'Add Decision',exact:true}).click();
      const submit=page.getByRole('button',{name:'Submit review and resume',exact:true});expect(await submit.isDisabled()).toBe(true);
      await page.getByLabel('Review step *',{exact:true}).fill('1');await page.getByLabel('Approved *',{exact:true}).selectOption({label:'Yes'});await page.getByLabel('Approved amount *',{exact:true}).fill('-1');await page.getByLabel('Review comment *',{exact:true}).fill('Approved after independent review');expect(await submit.isDisabled()).toBe(true);
      await page.getByLabel('Approved amount *',{exact:true}).fill('125.5');expect(await submit.isEnabled()).toBe(true);
      await page.screenshot({path:resolve(dir,'hitl-guided-ready.png'),fullPage:true});
      await page.getByLabel('Advanced JSON editor',{exact:true}).check();const advanced=await page.locator('label').filter({hasText:/^Review response \(JSON\)/}).locator('textarea').inputValue();expect(JSON.parse(advanced)).toMatchObject({step:1,extracted_data:{approved:true,amount:125.5}});await page.getByLabel('Advanced JSON editor',{exact:true}).uncheck();
      const resumed=page.waitForResponse(r=>r.url().includes('/admin/api/actions')&&r.request().method()==='POST');await submit.click();const resume=await resumed;expect(resume.status()).toBe(200);const sent=resume.request().postDataJSON();expect(sent.params.body.input.extracted_data).toMatchObject({approved:true,amount:125.5});
      expect((await waitForState(id,['SUCCEEDED'])).state).toBe('SUCCEEDED');await page.getByRole('button',{name:'Refresh detail',exact:true}).click();await page.getByText('SUCCEEDED',{exact:true}).first().waitFor();await page.screenshot({path:resolve(dir,'hitl-guided-complete.png'),fullPage:true});
      writeFileSync(resolve(dir,'guided-hitl.json'),JSON.stringify({scripts:[...new Set(scripts)],operationId:id,state:'SUCCEEDED',resumeStatus:resume.status(),typedInput:sent.params.body.input,schemaSource:'synthetic persisted business schema fixture; legacy generic fallback separately verified'},null,2));await context.close();
    }finally{clearInterval(dispatcher);for(const c of browser.contexts())for(const p of c.pages()){await p.screenshot({path:resolve(dir,'hitl-browser-last.png'),fullPage:true}).catch(()=>{});writeFileSync(resolve(dir,'hitl-browser-last.txt'),await p.locator('body').innerText().catch(()=>''));}await browser.close();}
  },90000);

});
