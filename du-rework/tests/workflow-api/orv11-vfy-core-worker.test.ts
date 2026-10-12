import { EXPECTED_RESULT_CORPUS, normalizeNondeterministicFields } from '../../businesses/document-core/tests/fixtures/expected-result-corpus';
import { chromium } from '../browser/node_modules/@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signCookie } from '../../orchestrator/services/orchestrator/src/app/admin/shell-auth';
const browserCookieSecret='orv11-core-browser-synthetic-secret';
import { VARIANT_TRACEABILITY_MATRIX } from '../../businesses/document-core/src/manifest/traceability';
import { MockTaskContext } from '../../businesses/document-core/tests/fixtures/mock-context';
import { getVariantFixture } from './orv11-vfy-variant-fixtures';
let matrixProviderValue: {data?:unknown;rawText?:string} | undefined;
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

describe('ORV11 independent core HTTP worker using established isolated WFA transport fixture', () => {
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
        runtimeToken,
        workerIdentityTokensByBusiness: {
          'document-core': workerIdentityToken,
          'lc-checker': lcWorkerIdentityToken,
        },
        connectorBaseUrls: { [namedConnectorId]: connectorBaseUrl },
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
    if (lcWorker) await lcWorker.stop(5_000);
    if (worker) await worker.stop(5_000);
    if (connectorComposition) await connectorComposition.shutdown();
    if (connectorProviderServer) await new Promise<void>((resolve) => connectorProviderServer.close(() => resolve()));
    if (app) await app.close();
    if (isolatedSchemaCreated) await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
    await baseDb.close();
    isolation.context.cleanupArtifactDir();
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
      mkdirSync(resolve('reports/raw/orv11/core31'),{recursive:true});
      writeFileSync(resolve('reports/raw/orv11/core31',`${entry.brdCaseId}.json`),JSON.stringify(result,null,2));
      matrixProviderValue=undefined;
    });
  });

  test('browser uploads a document and submits workflow.test to real worker, then polls success',async()=>{
    if(!app?.adminShell)throw new Error('shell unavailable');
    const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const dispatcher=setInterval(()=>void app!.dispatcher.dispatchOnce(),50);
    const dir=resolve('reports/raw/orv11/browser');mkdirSync(dir,{recursive:true});
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
      const submission=await submitted;const wire=await submission.json() as {data?:{operationId?:string};operationId?:string};
      if(submission.status()!==202)throw new Error(`workflow.test ${submission.status()}: ${JSON.stringify(wire)}`);
      const id=wire.data?.operationId??wire.operationId;
      if(!id)throw new Error(`operation missing ${JSON.stringify(wire)}`);
      const terminal=await waitForState(id,['SUCCEEDED']);
      if(terminal.state!=='SUCCEEDED')throw new Error(`browser workflow ${JSON.stringify(terminal)} ${recentWorkerErrorFrames()}`);
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

});
