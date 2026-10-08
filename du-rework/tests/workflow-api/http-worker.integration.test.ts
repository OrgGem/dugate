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

describe('WFA real schema HTTP → PostgreSQL outbox → Redis worker → legacy poll/result', () => {
  beforeAll(async () => {
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
        adminToken,
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

  test('executes the pinned input node and projects a terminal versioned result through the legacy poll/download routes', async () => {
    const { operationId, response } = await submitSchema('wfa-input-only', 'offline workflow result text');
    expect(response.status).toBe(202);
    expect(response.headers.get('operation-location')).toBe(`/api/v1/operations/${operationId}`);

    const admitted = await app!.db.query<{ id: string; payload_ref: unknown; pipeline_json: unknown }>(
      'SELECT t.id, t.payload_ref, o.pipeline_json FROM tasks t JOIN operations o ON o.root_task_id=t.id WHERE o.id=$1',
      [operationId],
    );
    expect(admitted.rowCount).toBe(1);
    const sealedPayload = typeof admitted.rows[0]!.payload_ref === 'string'
      ? JSON.parse(admitted.rows[0]!.payload_ref as string) as unknown
      : admitted.rows[0]!.payload_ref;
    const admittedPayload = await metadataCrypto.readStored(sealedPayload, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: admitted.rows[0]!.id,
    }, false) as { legacyWorkflowSchema: { revision: number; digest: string; schema: { nodes: { id: string }[] } } };
    expect(admittedPayload.legacyWorkflowSchema.revision).toBe(1);
    expect(admittedPayload.legacyWorkflowSchema.schema.nodes[0]?.id).toBe('request_value');
    const admittedPipeline = typeof admitted.rows[0]!.pipeline_json === 'string'
      ? JSON.parse(admitted.rows[0]!.pipeline_json as string) as unknown
      : admitted.rows[0]!.pipeline_json;
    expect(admittedPipeline).toEqual([{
      processor: 'ext-classifier',
      workflow: 'wfa-input-only',
      schemaRevision: 1,
      schemaDigest: admittedPayload.legacyWorkflowSchema.digest,
    }]);

    const changedSchema = controlSchema('wfa-input-only', 0);
    changedSchema.name = 'WFA newer active schema revision';
    changedSchema.nodes = [{ id: 'different_revision_node', type: 'input', key: 'different' }];
    changedSchema.flow = ['different_revision_node'];
    changedSchema.output = { from: 'different_revision_node' };
    const changedPin = await provisionLegacyWorkflowSchema(app!.db, {
      tenantId,
      schema: changedSchema,
      expectedRevision: admittedPayload.legacyWorkflowSchema.revision,
    }, metadataCrypto);
    expect(changedPin.revision).toBe(2);
    expect(changedPin.digest).not.toBe(admittedPayload.legacyWorkflowSchema.digest);

    expect(await dispatchAndWait(operationId, ['SUCCEEDED'])).toMatchObject({
      state: 'SUCCEEDED',
      business_id: 'document-core',
      action: 'schema-workflow',
      error_code: null,
      progress_percent: 100,
      progress_message: null,
    });

    const queueRow = await app!.db.query<{ state: string; result_ref: string | null }>(
      'SELECT state, result_ref FROM tasks WHERE id=$1', [(await stateOf(operationId)).root_task_id],
    );
    expect(queueRow.rows[0]?.state).toBe('SUCCEEDED');
    expect(queueRow.rows[0]?.result_ref).toBeTruthy();
    const dispatched = await app!.db.query<{ dispatched_at: Date | null; attempts: number }>(
      `SELECT b.dispatched_at, b.attempts FROM outbox b
       JOIN tasks t ON t.id=b.aggregate_id WHERE t.operation_id=$1 AND b.type='task.dispatch'`,
      [operationId],
    );
    expect(dispatched.rowCount).toBe(1);
    expect(dispatched.rows[0]?.dispatched_at).not.toBeNull();
    expect(dispatched.rows[0]?.attempts).toBeGreaterThanOrEqual(1);
    const root = await stateOf(operationId);
    const storedResult = await metadataCrypto.readStored(
      JSON.parse(root.result_ref ?? 'null') as unknown,
      { tenantId, slot: 'operations.result_ref', refId: operationId },
      false,
    );
    const resultText = storedResult as string;
    expect(JSON.parse(resultText)).toMatchObject({
      schemaVersion: 'legacy-workflow-result-v1',
      outputFormat: 'json',
      content: 'offline workflow result text',
      pipelineSteps: [{ step: 1, stepName: 'request_value', processor: 'input' }],
    });
    expect(root.progress_message).toBeNull();

    const { response: pollResponse, body } = await poll(operationId);
    expect(pollResponse.status).toBe(200);
    expect(body).toMatchObject({
      name: `operations/${operationId}`,
      done: true,
      metadata: {
        state: 'SUCCEEDED',
        workflow: 'wfa-input-only',
        schema_revision: 1,
        progress_percent: 100,
        progress_message: null,
      },
      result: {
        output_format: 'json',
        content: 'offline workflow result text',
        extracted_data: null,
        pipeline_steps: [{ step: 1, stepName: 'request_value', processor: 'input', content_preview: 'offline workflow result text', extracted_data: null }],
      },
    });
    const download = await fetch(`${baseUrl}/api/v1/operations/${operationId}/download`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('offline workflow result text');

    // This same-tenant key has an explicit profile for doc-compare only; it
    // must not inherit access to this schema-workflow's sensitive result.
    const sameTenantPoll = await poll(operationId, namedApiKey);
    expect(sameTenantPoll.response.status).toBe(404);
    const sameTenantResult = await fetch(`${baseUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': namedApiKey },
    });
    expect(sameTenantResult.status).toBe(404);
    const sameTenantDownload = await fetch(`${baseUrl}/api/v1/operations/${operationId}/download`, {
      headers: { 'x-api-key': namedApiKey },
    });
    expect(sameTenantDownload.status).toBe(404);

    const otherTenantPoll = await poll(operationId, otherApiKey);
    expect(otherTenantPoll.response.status).toBe(404);
    expect(otherTenantPoll.body).toMatchObject({ status: 404 });
  }, 90_000);

  test('preserves one-file doc-compare 202 admission and lets the real worker report its two-document failure', async () => {
    const { operationId, response } = await submitNamedDocCompareWithOneFile();
    expect(response.status).toBe(202);
    expect(response.headers.get('operation-location')).toBe(`/api/v1/operations/${operationId}`);

    const admitted = await app!.db.query<{ business_id: string; action: string; payload_ref: unknown; endpoint_slug: string }>(
      `SELECT o.business_id, o.action, t.payload_ref, o.endpoint_slug
         FROM operations o JOIN tasks t ON t.operation_id=o.id AND t.id=o.root_task_id
        WHERE o.id=$1 AND o.tenant_id=$2`,
      [operationId, tenantId],
    );
    expect(admitted.rowCount).toBe(1);
    expect(admitted.rows[0]).toMatchObject({ business_id: 'document-core', action: 'doc-compare', endpoint_slug: 'workflows:doc-compare' });
    const rawPayload = typeof admitted.rows[0]!.payload_ref === 'string'
      ? JSON.parse(admitted.rows[0]!.payload_ref as string) as unknown
      : admitted.rows[0]!.payload_ref;
    const payload = await metadataCrypto.readStored(rawPayload, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: (await stateOf(operationId)).root_task_id,
    }, false) as { legacyWorkflow: { version: string; process: string }; artifactIds: string[]; fileNames: string[] };
    expect(payload.legacyWorkflow).toEqual({ version: 'legacy-workflow-named-input-v1', process: 'doc-compare' });
    expect(payload.artifactIds).toHaveLength(1);
    expect(payload.fileNames).toEqual(['one.pdf']);

    const terminal = await dispatchAndWait(operationId, ['FAILED']);
    expect(terminal).toMatchObject({ state: 'FAILED', business_id: 'document-core', action: 'doc-compare' });
    expect(terminal.error_code).toBeTruthy();
    const pollResult = await poll(operationId, namedApiKey);
    expect(pollResult.response.status).toBe(200);
    expect(pollResult.body).toMatchObject({
      name: `operations/${operationId}`,
      done: true,
      metadata: { state: 'FAILED', workflow: 'doc-compare' },
    });
    expect(pollResult.body).not.toHaveProperty('result');
    const outbox = await app!.db.query<{ dispatched_at: Date | null }>(
      `SELECT b.dispatched_at FROM outbox b JOIN tasks t ON t.id=b.aggregate_id
        WHERE t.operation_id=$1 AND b.type='task.dispatch'`, [operationId],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0]?.dispatched_at).not.toBeNull();
  }, 90_000);

  test('executes a two-file named doc-compare to a completed legacy result (WFA-T03)', async () => {
    connectorProviderCalls.length = 0;
    const form = new FormData();
    form.append('process', 'doc-compare');
    form.append('source_file', new File([Buffer.from('left document content for comparison')], 'doc-left.pdf', { type: 'application/pdf' }));
    form.append('target_file', new File([Buffer.from('right document content for comparison')], 'doc-right.pdf', { type: 'application/pdf' }));
    const response = await fetch(`${baseUrl}/api/v1/docs/workflows`, {
      method: 'POST',
      headers: { 'x-api-key': namedApiKey },
      body: form,
    });
    expect(response.status).toBe(202);
    const initialBody = await response.json() as Record<string, unknown>;
    expect(response.headers.get('operation-location')).toBe(`/api/v1/operations/${String(initialBody.name).slice('operations/'.length)}`);
    expect(initialBody).toMatchObject({
      name: /^operations.\//,
      done: false,
      metadata: { state: 'RUNNING', workflow: 'doc-compare', progress_percent: 0 },
    });
    const operationId = String(initialBody.name).slice('operations/'.length);

    const admitted = await app!.db.query<{ business_id: string; action: string; endpoint_slug: string; payload_ref: unknown }>(
      `SELECT o.business_id, o.action, o.endpoint_slug, t.payload_ref
         FROM operations o JOIN tasks t ON t.operation_id=o.id AND t.id=o.root_task_id
        WHERE o.id=$1 AND o.tenant_id=$2`,
      [operationId, tenantId],
    );
    expect(admitted.rowCount).toBe(1);
    expect(admitted.rows[0]).toMatchObject({
      business_id: 'document-core',
      action: 'doc-compare',
      endpoint_slug: 'workflows:doc-compare',
    });
    const rawPayload = typeof admitted.rows[0]!.payload_ref === 'string'
      ? JSON.parse(admitted.rows[0]!.payload_ref as string) as unknown
      : admitted.rows[0]!.payload_ref;
    const payload = await metadataCrypto.readStored(rawPayload, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: (await stateOf(operationId)).root_task_id,
    }, false) as {
      legacyWorkflow: { version: string; process: string };
      variables: Record<string, unknown>;
      fileNames: string[];
      artifactIds: string[];
      artifacts: { role: string }[];
    };
    expect(payload.legacyWorkflow).toEqual({ version: 'legacy-workflow-named-input-v1', process: 'doc-compare' });
    expect(payload.variables).toEqual({});
    expect(payload.fileNames).toEqual(['doc-left.pdf', 'doc-right.pdf']);
    expect(payload.artifactIds).toHaveLength(2);
    expect(payload.artifacts.map((artifact) => artifact.role)).toEqual(['source', 'target']);

    const terminal = await dispatchUntilState(operationId, ['SUCCEEDED']);
    if (terminal.state !== 'SUCCEEDED') {
      throw new Error(`two-file doc-compare failed with ${terminal.error_code}; provider calls=${JSON.stringify(connectorProviderCalls.map((call) => call.task))}; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
    }
    expect(terminal).toMatchObject({
      state: 'SUCCEEDED',
      business_id: 'document-core',
      action: 'doc-compare',
      error_code: null,
      progress_percent: 100,
    });

    const completed = await poll(operationId, namedApiKey);
    expect(completed.response.status).toBe(200);
    expect(completed.body).toMatchObject({
      name: `operations/${operationId}`,
      done: true,
      metadata: { state: 'SUCCEEDED', workflow: 'doc-compare', progress_percent: 100 },
      result: {
        output_format: 'md',
        content: 'Synthetic document comparison report.',
        extracted_data: expect.objectContaining({ matched_count: 1, unchanged_count: 1 }),
        pipeline_steps: [
          { stepName: 'OCR documents', processor: 'ext-doc-layout' },
          { stepName: 'Extract both tables of contents', processor: 'ext-doc-compare' },
          { stepName: 'Compare corresponding sections', processor: 'ext-doc-compare' },
          { stepName: 'Generate comparison report', processor: 'ext-content-gen' },
        ],
      },
    });
    const download = await fetch(`${baseUrl}/api/v1/operations/${operationId}/download`, {
      headers: { 'x-api-key': namedApiKey },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('Synthetic document comparison report.');

    const providerTasks = connectorProviderCalls.map((call) => call.task);
    expect(providerTasks).toHaveLength(5);
    expect(providerTasks).toEqual(expect.arrayContaining([
      'extract_document_text',
      'extract_document_toc',
      'compare_document_sections',
      'generate_document_comparison_report',
    ]));
  }, 120_000);

  test('executes file_parse, connector, archive_compress and archive_extract through the real worker (WFA-T15/T18/T19/T22)', async () => {
    connectorProviderCalls.length = 0;
    const { operationId, response } = await submitSchemaWithFile(
      'wfa-leaf-local',
      { reference: 'leaf node reference' },
      { name: 'leaf-source.txt', content: 'synthetic leaf document text for parsing' },
    );
    expect(response.status).toBe(202);

    const terminal = await dispatchUntilState(operationId, ['SUCCEEDED']);
    if (terminal.state !== 'SUCCEEDED') {
      throw new Error(`leaf schema failed with ${terminal.error_code}; provider calls=${JSON.stringify(connectorProviderCalls.map((call) => call.task))}; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
    }
    expect(terminal).toMatchObject({
      state: 'SUCCEEDED',
      action: 'schema-workflow',
      error_code: null,
      progress_percent: 100,
    });

    const completed = await poll(operationId, leafApiKey);
    expect(completed.response.status).toBe(200);
    expect(completed.body).toMatchObject({
      done: true,
      metadata: { state: 'SUCCEEDED', schema_revision: 1 },
    });
    const steps = (completed.body.result as { pipeline_steps?: Array<Record<string, unknown>> } | undefined)?.pipeline_steps ?? [];
    // The connector node reports its configured connector name as processor.
    expect(steps.map((step) => step.processor)).toEqual([
      'input',
      'file_parse',
      'wfa-local-mock',
      'archive_compress',
      'archive_extract',
    ]);
    const rendered = JSON.stringify(completed.body.result ?? {});
    expect(rendered).toContain('wfa-extracted');
    expect(connectorProviderCalls.map((call) => call.task)).toEqual(['generate_disbursement_report']);
    const download = await fetch(`${baseUrl}/api/v1/operations/${operationId}/download`, {
      headers: { 'x-api-key': leafApiKey },
    });
    expect(download.status).toBe(200);
  }, 120_000);

  test('denies client-steered file_url_download and callback destinations (WFA-T15/T19 fences)', async () => {
    const cases = ['file_url_download', 'callback'] as const;
    const observed: Record<string, unknown> = {};
    for (const nodeType of cases) {
      const { operationId } = await submitLeafSchemaInput(
        `wfa-leaf-egress-${nodeType}`,
        { reference: 'egress fence reference', target: 'http://127.0.0.1:1/blocked.txt' },
      );
      const terminal = await dispatchUntilState(operationId, ['FAILED']);
      if (terminal.state !== 'FAILED') {
        throw new Error(`${nodeType} fence did not fail closed: ${terminal.state} (${terminal.error_code}); worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
      }
      expect(String(terminal.error_code)).toMatch(/^LEGACY_WORKFLOW_EGRESS/);
      const { body } = await poll(operationId, leafApiKey);
      expect(body).toMatchObject({ done: true, metadata: { state: 'FAILED', workflow: 'wfa-leaf-egress-' + nodeType } });
      expect(body).not.toHaveProperty('result');
      observed[nodeType] = terminal.error_code;
    }
    // Fail-closed evidence: the client cannot steer an approved-origin node to
    // an arbitrary http destination; both node types must refuse before any socket.
    expect(Object.keys(observed)).toEqual(['file_url_download', 'callback']);
  }, 120_000);

  test('recovers an expired lease without repeating the completed provider stage (WFA-T26)', async () => {
    connectorProviderCalls.length = 0;
    providerAbortedCalls.length = 0;
    providerDelayMs = 1_500;
    try {
      const { operationId, response } = await submitSchemaWithFile(
        'wfa-leaf-local',
        { reference: 'retry probe' },
        { name: 'leaf-source.txt', content: 'synthetic leaf document text for parsing' },
      );
      expect(response.status).toBe(202);
      await app!.dispatcher.dispatchOnce();
      await waitForCondition(() => connectorProviderCalls.length >= 1, 20_000, 'the connector stage to reach the provider');
      const expired = await app!.db.query(
        `UPDATE tasks SET lease_expires_at = now() - interval '1 second'
          WHERE operation_id=$1 AND state='RUNNING'`, [operationId],
      );
      expect(expired.rowCount).toBeGreaterThanOrEqual(1);
      const swept = await app!.runtime.sweepExpiredLeases();
      expect(swept).toBeGreaterThanOrEqual(1);
      const terminal = await dispatchUntilState(operationId, ['SUCCEEDED']);
      if (terminal.state !== 'SUCCEEDED') {
      const taskRows = await app!.db.query<{ task_key: string; state: string; attempt: number; lease_epoch: number; error_code: string | null }>(
        'SELECT task_key, state, attempt, lease_epoch, error_code FROM tasks WHERE operation_id=$1 ORDER BY task_key', [operationId],
      );
      throw new Error(`lease-recovered schema workflow failed with ${terminal.error_code}; provider calls=${JSON.stringify(connectorProviderCalls.map((call) => call.task))}; taskRows=${JSON.stringify(taskRows.rows)}; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
      }
      // The redelivered task must reuse the stable invocation identity: the
      // Connector ledger dedupes, so the provider is still called exactly once.
      expect(connectorProviderCalls.map((call) => call.task)).toEqual(['generate_disbursement_report']);
      const { body } = await poll(operationId, leafApiKey);
      expect(body).toMatchObject({ done: true, metadata: { state: 'SUCCEEDED' } });
    } finally {
      providerDelayMs = 0;
    }
  }, 120_000);

  test('cancels an operation while a provider stage is in flight and aborts that stage (WFA-T27)', async () => {
    connectorProviderCalls.length = 0;
    providerAbortedCalls.length = 0;
    providerDelayMs = 20_000;
    try {
      const { operationId, response } = await submitSchemaWithFile(
        'wfa-leaf-local',
        { reference: 'cancel probe' },
        { name: 'leaf-source.txt', content: 'synthetic leaf document text for parsing' },
      );
      expect(response.status).toBe(202);
      await app!.dispatcher.dispatchOnce();
      await waitForCondition(() => connectorProviderCalls.length >= 1, 20_000, 'the connector stage to start');
      const cancel = await fetch(`${baseUrl}/api/v1/operations/${operationId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': leafApiKey },
      });
      expect(cancel.status).toBe(200);
      // Cancellation must reach the in-flight provider work, not only the row.
      await waitForCondition(() => providerAbortedCalls.length >= 1, 30_000, 'the in-flight provider request to be aborted');
      const terminal = await waitForState(operationId, ['CANCELLED']);
      expect(terminal.state).toBe('CANCELLED');
      const tasks = await app!.db.query<{ state: string }>('SELECT state FROM tasks WHERE operation_id=$1', [operationId]);
      expect(tasks.rows.map((row) => row.state)).toEqual(['CANCELLED']);
      const { body } = await poll(operationId, leafApiKey);
      expect(body).toMatchObject({ done: true, metadata: { state: 'CANCELLED' } });
      expect(body).not.toHaveProperty('result');
    } finally {
      providerDelayMs = 0;
    }
  }, 120_000);

  test('runs named disbursement end to end through admission, HITL approval and connector stages to a legacy result (WFA-T01)', async () => {
    connectorProviderCalls.length = 0;
    const { operationId, response, body: initialBody } = await submitNamed(
      'disbursement',
      [{ name: 'invoice.pdf', content: 'synthetic disbursement source document' }],
      { resolution_data: 'PO-2026-001' },
      disbursementApiKey,
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('operation-location')).toBe(`/api/v1/operations/${operationId}`);
    expect(initialBody).toMatchObject({
      name: `operations/${operationId}`,
      done: false,
      metadata: { state: 'RUNNING', workflow: 'disbursement', progress_percent: 0 },
    });

    const admitted = await app!.db.query<{ business_id: string; action: string; endpoint_slug: string; payload_ref: unknown }>(
      `SELECT o.business_id, o.action, o.endpoint_slug, t.payload_ref
         FROM operations o JOIN tasks t ON t.operation_id=o.id AND t.id=o.root_task_id
        WHERE o.id=$1 AND o.tenant_id=$2`,
      [operationId, tenantId],
    );
    expect(admitted.rowCount).toBe(1);
    expect(admitted.rows[0]).toMatchObject({
      business_id: 'document-core',
      action: 'disbursement',
      endpoint_slug: 'workflows:disbursement',
    });
    const rawPayload = typeof admitted.rows[0]!.payload_ref === 'string'
      ? JSON.parse(admitted.rows[0]!.payload_ref as string) as unknown
      : admitted.rows[0]!.payload_ref;
    const payload = await metadataCrypto.readStored(rawPayload, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: (await stateOf(operationId)).root_task_id,
    }, false) as {
      legacyWorkflow: { version: string; process: string };
      variables: Record<string, unknown>;
      fileNames: string[];
      artifactIds: string[];
    };
    expect(payload.legacyWorkflow).toEqual({ version: 'legacy-workflow-named-input-v1', process: 'disbursement' });
    expect(payload.variables).toEqual({ resolution_data: 'PO-2026-001' });
    expect(payload.fileNames).toEqual(['invoice.pdf']);
    expect(payload.artifactIds).toHaveLength(1);

    await app!.dispatcher.dispatchOnce();
    const waiting = await waitForState(operationId, ['WAITING_INPUT']);
    if (waiting.state !== 'WAITING_INPUT') {
      throw new Error(`named disbursement reached ${waiting.state} (error_code=${waiting.error_code}); provider calls=${JSON.stringify(connectorProviderCalls.map((call) => ({ task: call.task, prompt: call.prompt.slice(0, 80) })))}; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
    }
    const waitingPoll = await poll(operationId, disbursementApiKey);
    expect(waitingPoll.response.status).toBe(200);
    expect(waitingPoll.body).toMatchObject({
      done: false,
      metadata: { state: 'WAITING_USER_INPUT', workflow: 'disbursement' },
    });

    const resume = await fetch(`${baseUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: { 'x-api-key': disbursementApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 1, approved: true }),
    });
    const resumeBody = await resume.json() as Record<string, unknown>;
    if (resume.status !== 200) {
      throw new Error(`legacy disbursement resume failed with HTTP ${resume.status}: ${JSON.stringify(resumeBody)}\n${recentWorkerErrorFrames()}`);
    }
    expect(resumeBody).toEqual({ success: true, message: 'Resumed successfully' });

    await app!.dispatcher.dispatchOnce();
    const terminal = await waitForState(operationId, ['SUCCEEDED']);
    if (terminal.state !== 'SUCCEEDED') {
      throw new Error(`named disbursement failed with ${terminal.error_code}; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
    }
    expect(terminal).toMatchObject({
      state: 'SUCCEEDED',
      business_id: 'document-core',
      action: 'disbursement',
      error_code: null,
      progress_percent: 100,
    });

    const completed = await poll(operationId, disbursementApiKey);
    expect(completed.response.status).toBe(200);
    expect(completed.body).toMatchObject({
      name: `operations/${operationId}`,
      done: true,
      metadata: { state: 'SUCCEEDED', workflow: 'disbursement', progress_percent: 100 },
      result: {
        output_format: 'md',
        content: 'Synthetic disbursement review report.',
        extracted_data: expect.objectContaining({ verdict: 'PASS' }),
        pipeline_steps: [
          { stepName: 'Classify 1 file(s)', processor: 'ext-classifier' },
          { stepName: 'Extract 1 file(s)', processor: 'ext-data-extractor' },
          { stepName: 'Cross-check extracted evidence', processor: 'ext-fact-verifier' },
          { stepName: 'Generate disbursement report', processor: 'ext-content-gen' },
        ],
      },
    });
    const download = await fetch(`${baseUrl}/api/v1/operations/${operationId}/download`, {
      headers: { 'x-api-key': disbursementApiKey },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('Synthetic disbursement review report.');

    const providerTasks = connectorProviderCalls.map((call) => call.task);
    expect(providerTasks).toHaveLength(4);
    expect(providerTasks).toEqual([
      'classify_document',
      'extract_document_data',
      'crosscheck_disbursement_documents',
      'generate_disbursement_report',
    ]);
  }, 120_000);

  test('runs named lc-checker end to end through admission and connector stages to a legacy result (WFA-T02)', async () => {
    connectorProviderCalls.length = 0;
    const { operationId, response, body: initialBody } = await submitNamed(
      'lc-checker',
      [{ name: 'lc-document.pdf', content: 'synthetic letter of credit document' }],
      {},
      lcApiKey,
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('operation-location')).toBe(`/api/v1/operations/${operationId}`);
    expect(initialBody).toMatchObject({
      name: `operations/${operationId}`,
      done: false,
      metadata: { state: 'RUNNING', workflow: 'lc-checker', progress_percent: 0 },
    });

    const admitted = await app!.db.query<{ business_id: string; action: string; endpoint_slug: string; payload_ref: unknown }>(
      `SELECT o.business_id, o.action, o.endpoint_slug, t.payload_ref
         FROM operations o JOIN tasks t ON t.operation_id=o.id AND t.id=o.root_task_id
        WHERE o.id=$1 AND o.tenant_id=$2`,
      [operationId, tenantId],
    );
    expect(admitted.rowCount).toBe(1);
    expect(admitted.rows[0]).toMatchObject({
      business_id: 'lc-checker',
      action: 'lc-checker',
      endpoint_slug: 'workflows:lc-checker',
    });
    const rawPayload = typeof admitted.rows[0]!.payload_ref === 'string'
      ? JSON.parse(admitted.rows[0]!.payload_ref as string) as unknown
      : admitted.rows[0]!.payload_ref;
    const payload = await metadataCrypto.readStored(rawPayload, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: (await stateOf(operationId)).root_task_id,
    }, false) as {
      legacyWorkflow: { version: string; process: string };
      variables: Record<string, unknown>;
      fileNames: string[];
      artifactIds: string[];
    };
    expect(payload.legacyWorkflow).toEqual({ version: 'legacy-workflow-named-input-v1', process: 'lc-checker' });
    expect(payload.variables).toEqual({});
    expect(payload.fileNames).toEqual(['lc-document.pdf']);
    expect(payload.artifactIds).toHaveLength(1);

    const terminal = await dispatchUntilState(operationId, ['SUCCEEDED']);
    if (terminal.state !== 'SUCCEEDED') {
      throw new Error(`named lc-checker failed with ${terminal.error_code}; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
    }
    expect(terminal).toMatchObject({
      state: 'SUCCEEDED',
      business_id: 'lc-checker',
      action: 'lc-checker',
      error_code: null,
      progress_percent: 100,
    });

    const completed = await poll(operationId, lcApiKey);
    expect(completed.response.status).toBe(200);
    expect(completed.body).toMatchObject({
      name: `operations/${operationId}`,
      done: true,
      metadata: { state: 'SUCCEEDED', workflow: 'lc-checker', progress_percent: 100 },
      result: {
        output_format: 'json',
        content: 'Synthetic LC checking report.',
        extracted_data: expect.objectContaining({ verdict: 'COMPLIANT' }),
        pipeline_steps: [
          { stepName: expect.stringContaining('OCR'), processor: 'ext-doc-layout' },
          { stepName: expect.stringContaining('UCP 600'), processor: 'ext-fact-verifier' },
          { stepName: expect.any(String), processor: 'ext-content-gen' },
        ],
      },
    });
    const download = await fetch(`${baseUrl}/api/v1/operations/${operationId}/download`, {
      headers: { 'x-api-key': lcApiKey },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('Synthetic LC checking report.');

    const prompts = connectorProviderCalls.map((call) => call.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts.filter((prompt) => prompt.includes('high-precision Document OCR Engine'))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes('senior Documentary Credit'))).toHaveLength(1);
  }, 120_000);

  test('records legacy HITL state/resume parity while proving a canonical resume completes the real worker', async () => {
    const { operationId, response } = await submitSchema('wfa-human-one', 'review this input');
    expect(response.status).toBe(202);
    await app!.dispatcher.dispatchOnce();
    const waiting = await waitForState(operationId, ['WAITING_INPUT']);
    const wait = await app!.db.query<{ wait_id: string; status: string }>(
      'SELECT wait_id, status FROM human_waits WHERE operation_id=$1 AND status=$2', [operationId, 'OPEN'],
    );
    expect(wait.rowCount).toBe(1);
    const { response: pollResponse, body: waitingBody } = await poll(operationId);
    expect(pollResponse.status).toBe(200);
    const metadata = waitingBody.metadata as Record<string, unknown>;
    expect(metadata.progress_percent).toBeGreaterThan(0);
    expect(metadata.progress_message).not.toContain('review this input');

    const legacyResume = await fetch(`${baseUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 1, extracted_data: { decision: 'approved' } }),
    });
    const legacyResumeBody = await legacyResume.json() as Record<string, unknown>;
    expect(legacyResume.status).not.toBe(500);

    if (legacyResume.status !== 200) {
      // A canonical wait envelope is a verifier-only recovery path. It
      // demonstrates the worker lifecycle even when the old public body fails.
      const answered = await app!.db.query<{ wait_id: string }>(
        'SELECT wait_id FROM human_waits WHERE operation_id=$1 AND status=$2', [operationId, 'OPEN'],
      );
      const canonicalResume = await fetch(`${baseUrl}/api/v1/operations/${operationId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          waitId: answered.rows[0]?.wait_id,
          input: { step: 1, extracted_data: { decision: 'approved' } },
          expectedStateVersion: waiting.state_version,
        }),
      });
      expect(canonicalResume.status).toBe(200);
    } else {
      expect(legacyResumeBody).toEqual({ success: true, message: 'Resumed successfully' });
    }
    await app!.dispatcher.dispatchOnce();
    const complete = await waitForState(operationId, ['SUCCEEDED']);
    if (complete.state !== 'SUCCEEDED') {
      throw new Error(`resumed schema workflow failed; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
    }
    expect(complete.state_version).toBeGreaterThan(waiting.state_version);
    expect(complete).toMatchObject({ state: 'SUCCEEDED', error_code: null });
    const { body: completedBody } = await poll(operationId);
    expect(completedBody).toMatchObject({
      done: true,
      result: { extracted_data: { decision: 'approved' } },
    });
    const waits = await app!.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE operation_id=$1', [operationId],
    );
    expect(waits.rows.map((row) => row.status)).toEqual(['ANSWERED']);
    expect({ legacyPollState: metadata.state, legacyResumeStatus: legacyResume.status, legacyResumeBody }).toEqual({
      legacyPollState: 'WAITING_USER_INPUT',
      legacyResumeStatus: 200,
      legacyResumeBody: { success: true, message: 'Resumed successfully' },
    });
  }, 90_000);

  test('runs two ordered parallel checkpoints with encrypted branch artifacts and configured joins', async () => {
    const { operationId, response } = await submitSchemaInput('wfa-sequential-parallel', {
      left: 'parallel left value',
      right: 'parallel right value',
    });
    expect(response.status).toBe(202);
    const terminal = await dispatchUntilState(operationId, ['SUCCEEDED']);
    if (terminal.state !== 'SUCCEEDED') {
      const taskRows = await app!.db.query<{ task_key: string; kind: string; state: string; error_code: string | null }>(
        `SELECT task_key, kind, state, error_code FROM tasks WHERE operation_id=$1 ORDER BY task_key`, [operationId],
      );
      throw new Error(`parallel schema workflow failed: ${JSON.stringify(taskRows.rows)}\n${recentWorkerErrorFrames()}`);
    }
    expect(terminal).toMatchObject({ state: 'SUCCEEDED', error_code: null });

    const tasks = await app!.db.query<{ task_key: string; kind: string; state: string }>(
      `SELECT task_key, kind, state FROM tasks WHERE operation_id=$1 ORDER BY task_key`, [operationId],
    );
    expect(tasks.rows.filter((task) => task.kind === 'legacy-workflow-branch')).toHaveLength(4);
    expect(tasks.rows.every((task) => task.state === 'SUCCEEDED')).toBe(true);
    const output = await poll(operationId);
    expect(output.response.status).toBe(200);
    expect(output.body).toMatchObject({
      done: true,
      metadata: { state: 'SUCCEEDED' },
      result: {
        output_format: 'json',
        content: 'parallel left value',
        pipeline_steps: [
          { stepName: 'parallel_one', processor: 'parallel' },
          { stepName: 'join_one', processor: 'join' },
          { stepName: 'parallel_two', processor: 'parallel' },
          { stepName: 'join_two', processor: 'join' },
        ],
      },
    });
  }, 120_000);

  test('keeps sequential human checkpoints distinct across resume deliveries', async () => {
    const { operationId, response } = await submitSchema('wfa-human-two', 'two approvals required');
    expect(response.status).toBe(202);
    await app!.dispatcher.dispatchOnce();
    await waitForState(operationId, ['WAITING_INPUT']);
    const firstWait = await app!.db.query<{ wait_id: string; status: string }>(
      'SELECT wait_id, status FROM human_waits WHERE operation_id=$1 AND status=$2', [operationId, 'OPEN'],
    );
    expect(firstWait.rowCount).toBe(1);
    const stateBeforeResume = await stateOf(operationId);

    const legacyFirstResume = await fetch(`${baseUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 1, extracted_data: { decision: 'first checkpoint' } }),
    });
    if (legacyFirstResume.status !== 200) {
      const canonicalFirstResume = await fetch(`${baseUrl}/api/v1/operations/${operationId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          waitId: firstWait.rows[0]?.wait_id,
          input: { step: 1, extracted_data: { decision: 'first checkpoint' } },
          expectedStateVersion: stateBeforeResume.state_version,
        }),
      });
      expect(canonicalFirstResume.status).toBe(200);
    }
    await app!.dispatcher.dispatchOnce();

    const secondState = await waitForState(operationId, ['WAITING_INPUT', 'SUCCEEDED']);
    const allWaits = await app!.db.query<{ wait_id: string; wait_key: string; status: string }>(
      'SELECT wait_id, wait_key, status FROM human_waits WHERE operation_id=$1 ORDER BY created_at, wait_id', [operationId],
    );
    if (secondState.state === 'WAITING_INPUT' && allWaits.rowCount === 2 && allWaits.rows[1]?.status === 'OPEN') {
      const secondResume = await fetch(`${baseUrl}/api/v1/operations/${operationId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ step: 2, extracted_data: { decision: 'second checkpoint' } }),
      });
      if (secondResume.status !== 200) {
        const canonicalSecondResume = await fetch(`${baseUrl}/api/v1/operations/${operationId}/resume`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            waitId: allWaits.rows[1]?.wait_id,
            input: { step: 2, extracted_data: { decision: 'second checkpoint' } },
            expectedStateVersion: secondState.state_version,
          }),
        });
        expect(canonicalSecondResume.status).toBe(200);
      }
      await app!.dispatcher.dispatchOnce();
      await waitForState(operationId, ['SUCCEEDED']);
    }
    const { body } = await poll(operationId);
    const finalState = await stateOf(operationId);
    if (finalState.state !== 'SUCCEEDED') {
      throw new Error(`sequential human workflow failed; worker frames (messages redacted):\n${recentWorkerErrorFrames()}`);
    }
    expect({
      waitCount: allWaits.rowCount,
      firstWaitId: allWaits.rows[0]?.wait_id,
      originalWaitId: firstWait.rows[0]?.wait_id,
      firstWaitState: allWaits.rows[0]?.status,
      secondWaitId: allWaits.rows[1]?.wait_id,
      secondWaitState: allWaits.rows[1]?.status,
      stateAfterFirstAnswer: secondState.state,
      firstResumeStatus: legacyFirstResume.status,
      stateAfterSecondAnswer: finalState.state,
      errorCodeAfterSecondAnswer: finalState.error_code,
      completedResult: body.done ? body.result : null,
    }).toMatchObject({
      waitCount: 2,
      firstWaitId: firstWait.rows[0]?.wait_id,
      firstWaitState: 'ANSWERED',
      secondWaitState: 'OPEN',
      stateAfterFirstAnswer: 'WAITING_INPUT',
      firstResumeStatus: 200,
      stateAfterSecondAnswer: 'SUCCEEDED',
      errorCodeAfterSecondAnswer: null,
      completedResult: { extracted_data: { decision: 'second checkpoint' } },
    });
    expect((await stateOf(operationId)).state_version).toBeGreaterThan(stateBeforeResume.state_version);
  }, 120_000);

  test('does not let an administrator credential bypass public workflow API-key authorization', async () => {
    const before = await app!.db.query<{ operations: string; tasks: string; outbox: string }>(
      `SELECT (SELECT count(*)::text FROM operations WHERE tenant_id=$1) AS operations,
              (SELECT count(*)::text FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS tasks,
              (SELECT count(*)::text FROM outbox b JOIN tasks t ON t.id=b.aggregate_id JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS outbox`,
      [tenantId],
    );
    const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: multipart({ schemaSlug: 'wfa-input-only', input: '{"reference":"admin must not be public"}' }),
    });
    expect(response.status).toBe(401);
    const after = await app!.db.query<{ operations: string; tasks: string; outbox: string }>(
      `SELECT (SELECT count(*)::text FROM operations WHERE tenant_id=$1) AS operations,
              (SELECT count(*)::text FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS tasks,
              (SELECT count(*)::text FROM outbox b JOIN tasks t ON t.id=b.aggregate_id JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS outbox`,
      [tenantId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  test('refuses file-bearing workflow upload when metadata encryption exists but artifact encryption is absent', async () => {
    const unencryptedApp = await createApp({
      host: '127.0.0.1',
      port: 0,
      internalHost: '127.0.0.1',
      internalPort: 0,
      databaseUrl: isolation.databaseUrl,
      redisUrl: isolation.redisUrl,
      runtimeToken,
      adminToken,
      autoMigrate: true,
      autoDispatch: false,
      leaseRecoveryIntervalMs: 0,
      metadataEncryption: { keyProvider, keyRef: 'du-orch-metadata-v1' },
    });
    try {
      const publicServer = await unencryptedApp.listen();
      const publicAddress = publicServer.address();
      if (!publicAddress || typeof publicAddress === 'string') throw new Error('unconfigured-upload app did not bind');
      const unencryptedBaseUrl = `http://127.0.0.1:${(publicAddress as AddressInfo).port}`;
      const before = await app!.db.query<{ artifacts: string; blobs: string; operations: string; tasks: string; outbox: string }>(
        `SELECT
           (SELECT count(*)::text FROM artifacts WHERE tenant_id=$1) AS artifacts,
           (SELECT count(*)::text FROM artifact_blobs WHERE tenant_id=$1) AS blobs,
           (SELECT count(*)::text FROM operations WHERE tenant_id=$1) AS operations,
           (SELECT count(*)::text FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS tasks,
           (SELECT count(*)::text FROM outbox b JOIN tasks t ON t.id=b.aggregate_id JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS outbox`,
        [otherTenantId],
      );
      const body = new FormData();
      body.append('schemaSlug', 'wfa-no-artifact-encryption');
      body.append('input', JSON.stringify({ reference: 'must fail before byte storage' }));
      body.append('file', new File([Buffer.from('synthetic file bytes')], 'synthetic.pdf', { type: 'application/pdf' }));
      const response = await fetch(`${unencryptedBaseUrl}/api/v1/docs/workflows/schema`, {
        method: 'POST',
        headers: { 'x-api-key': otherApiKey },
        body,
      });
      expect(response.status).toBe(503);
      const after = await app!.db.query<{ artifacts: string; blobs: string; operations: string; tasks: string; outbox: string }>(
        `SELECT
           (SELECT count(*)::text FROM artifacts WHERE tenant_id=$1) AS artifacts,
           (SELECT count(*)::text FROM artifact_blobs WHERE tenant_id=$1) AS blobs,
           (SELECT count(*)::text FROM operations WHERE tenant_id=$1) AS operations,
           (SELECT count(*)::text FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS tasks,
           (SELECT count(*)::text FROM outbox b JOIN tasks t ON t.id=b.aggregate_id JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS outbox`,
        [otherTenantId],
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      await unencryptedApp.close();
    }
  }, 60_000);

  test('cancels a paused workflow safely and closes its wait without exposing it to a same-tenant profile key', async () => {
    const { operationId, response } = await submitSchema('wfa-cancel-wait', 'cancel after human wait');
    expect(response.status).toBe(202);
    await app!.dispatcher.dispatchOnce();
    await waitForState(operationId, ['WAITING_INPUT']);
    const { root_task_id: taskId } = await stateOf(operationId);

    const sameTenantCancel = await fetch(`${baseUrl}/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': namedApiKey },
    });
    expect(sameTenantCancel.status).toBe(404);
    expect((await stateOf(operationId)).state).toBe('WAITING_INPUT');

    const cancel = await fetch(`${baseUrl}/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    });
    expect(cancel.status).toBe(200);
    const cancelBody = await cancel.json() as Record<string, unknown>;
    expect(cancelBody).toMatchObject({ name: `operations/${operationId}`, done: true, metadata: { state: 'CANCELLED' } });

    const foreignCancel = await fetch(`${baseUrl}/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': otherApiKey },
    });
    expect(foreignCancel.status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const persisted = await app!.db.query<{ operation_state: string; task_state: string; open_waits: string }>(
      `SELECT o.state AS operation_state, t.state AS task_state,
              (SELECT count(*)::text FROM human_waits w WHERE w.operation_id=o.id AND w.status='OPEN') AS open_waits
       FROM operations o JOIN tasks t ON t.id=o.root_task_id WHERE o.id=$1`,
      [operationId],
    );
    expect(persisted.rowCount).toBe(1);
    expect(persisted.rows[0]?.operation_state).toBe('CANCELLED');
    expect(persisted.rows[0]?.task_state).toBe('CANCELLED');
    expect(persisted.rows[0]?.open_waits).toBe('0');
    expect((await stateOf(operationId)).root_task_id).toBe(taskId);
  }, 90_000);
});
