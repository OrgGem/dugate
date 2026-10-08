import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { documentCoreManifest } from '../../businesses/document-core/src/manifest/document-core.manifest';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { CryptoStorageFacade } from '../../orchestrator/services/orchestrator/src/modules/encryption/crypto-storage-facade';
import {
  decryptStoredArtifact,
  ENCRYPTED_OBJECT_MARKER,
  ENCRYPTED_OBJECT_MARKER_VALUE,
  MANIFEST_KEY_METADATA,
  manifestKeyFor,
} from '../../orchestrator/services/orchestrator/src/modules/encryption/artifact-read-decrypt';
import { adaptKeyProviderForMetadata } from '../../orchestrator/services/orchestrator/src/modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../../orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto';
import { provisionLegacyWorkflowSchema } from '../../orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';

const isolation = createWorkflowApiIsolation();
const keyProvider = syntheticMetadataKeyProvider();
const metadataCrypto = createMetadataCrypto(
  adaptKeyProviderForMetadata(keyProvider),
  'du-orch-metadata-v1',
);
const baseDb = createDb(isolation.baseDatabaseUrl);
const tenantId = randomUUID();
const apiKey = `wfa-pin-${randomUUID()}`;
const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
const runtimeToken = `wfa-pin-runtime-${randomUUID()}`;
const adminToken = `wfa-pin-admin-${randomUUID()}`;
let app: App | undefined;
let baseUrl = '';
let internalUrl = '';
let isolatedSchemaCreated = false;

interface AdmissionCounts {
  operations: string;
  tasks: string;
  outbox: string;
  artifacts: string;
  artifact_blobs: string;
  submission_keys: string;
}

function multipart(fields: Record<string, string>, file?: { name: string; content: string }): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  if (file) body.append('files[]', new File([file.content], file.name, { type: 'text/plain' }));
  return body;
}

async function counts(): Promise<AdmissionCounts> {
  if (!app) throw new Error('WFA schema pin app is not running');
  const result = await app.db.query<AdmissionCounts>(
    `SELECT
       (SELECT count(*)::text FROM operations WHERE tenant_id=$1) AS operations,
       (SELECT count(*)::text FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS tasks,
       (SELECT count(*)::text FROM outbox b JOIN tasks t ON t.id=b.aggregate_id JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS outbox,
       (SELECT count(*)::text FROM artifacts WHERE tenant_id=$1) AS artifacts,
       (SELECT count(*)::text FROM artifact_blobs WHERE tenant_id=$1) AS artifact_blobs,
       (SELECT count(*)::text FROM submission_keys WHERE tenant_id=$1) AS submission_keys`,
    [tenantId],
  );
  return result.rows[0]!;
}

async function registerAndActivateDocumentCore(): Promise<void> {
  if (!app) throw new Error('WFA schema pin app is not running');
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
    const expected = action === 'enable' ? [200] : [200, 202];
    if (!expected.includes(response.status)) {
      throw new Error(`document-core ${action} returned ${response.status}: ${await response.text()}`);
    }
  }
}

function inputSchema(revision: number) {
  const key = revision === 1 ? 'reference' : 'referenceV2';
  return {
    slug: 'wfa-http-pin',
    name: `WFA HTTP pin fixture revision ${revision}`,
    nodes: [{ id: 'request_value', type: 'input', key }],
    flow: ['request_value'],
    output: { from: 'request_value' },
  };
}

async function expectStatus(response: Response, expected: number, label: string): Promise<string> {
  const body = await response.text();
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}; response body: ${body}`);
  }
  return body;
}

describe('WFA real HTTP workflow submission, schema pins, and upload cleanup', () => {
  beforeAll(async () => {
    await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
    isolatedSchemaCreated = true;
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

    await app.db.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'WFA schema pin tenant']);
    await app.db.query(
      `INSERT INTO api_keys (tenant_id, hash, prefix, status) VALUES ($1, $2, 'wfa-pin', 'ACTIVE')`,
      [tenantId, apiKeyHash],
    );
    await provisionLegacyWorkflowSchema(
      app.db,
      { tenantId, schema: inputSchema(1) },
      metadataCrypto,
    );

    // Keep a test-owned audit row after the artifact itself is compensated.
    // It proves the denial occurred after a real public artifact insert.
    await app.db.query(`
      CREATE TABLE wfa_public_upload_audit (artifact_id uuid NOT NULL);
      CREATE FUNCTION wfa_capture_public_upload() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.purpose = 'input' THEN
          INSERT INTO wfa_public_upload_audit (artifact_id) VALUES (NEW.id);
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER wfa_public_upload_audit_trigger AFTER INSERT ON artifacts
      FOR EACH ROW EXECUTE FUNCTION wfa_capture_public_upload();
    `);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (isolatedSchemaCreated) {
      await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
    }
    await baseDb.close();
    isolation.context.cleanupArtifactDir();
  }, 30_000);

  test('returns the exact legacy 202 and persists the immutable schema revision in the real task/outbox transaction', async () => {
    if (!app) throw new Error('WFA schema pin app is not running');
    const initialPin = await import('../../orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas')
      .then(({ resolveLegacyWorkflowSchema }) => resolveLegacyWorkflowSchema(
        app!.db, { tenantId, slug: 'wfa-http-pin' }, metadataCrypto,
      ));
    if (!initialPin) throw new Error('provisioned WFA schema did not resolve');

    const firstResponse = await fetch(`${baseUrl}/api/v1/docs/workflows/schema?sync=true`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'idempotency-key': 'wfa-old-contract-repeat' },
      body: multipart({
        schemaSlug: ' wfa-http-pin ',
        input: '{"schemaSlug":"body-cannot-select","reference":"admitted revision one"}',
      }),
    });
    const firstBodyText = await expectStatus(firstResponse, 202, 'first schema submit');
    expect(firstResponse.headers.get('operation-location')).toMatch(/^\/api\/v1\/operations\/[0-9a-f-]+$/i);
    const firstBody = JSON.parse(firstBodyText) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      name: expect.stringMatching(/^operations\/[0-9a-f-]+$/i),
      done: false,
      metadata: {
        state: 'RUNNING',
        workflow: 'wfa-http-pin',
        progress_percent: 0,
        progress_message: 'Initializing schema workflow...',
      },
    });
    expect(Object.keys(firstBody).sort()).toEqual(['done', 'metadata', 'name']);
    expect(Object.keys(firstBody.metadata as Record<string, unknown>).sort()).toEqual([
      'progress_message', 'progress_percent', 'state', 'workflow',
    ]);
    const firstOperationId = String(firstBody.name).replace(/^operations\//, '');

    const firstRows = await app.db.query<{
      operation_id: string;
      tenant_id: string;
      endpoint_slug: string;
      pipeline_json: unknown;
      root_task_id: string;
      task_id: string;
      task_kind: string;
      payload_ref: unknown;
      outbox_payload: unknown;
      outbox_count: string;
    }>(
      `SELECT o.id AS operation_id, o.tenant_id, o.endpoint_slug, o.pipeline_json, o.root_task_id,
              t.id AS task_id, t.kind AS task_kind, t.payload_ref,
              b.payload AS outbox_payload, count(b.delivery_id)::text AS outbox_count
       FROM operations o
       JOIN tasks t ON t.id=o.root_task_id
       LEFT JOIN outbox b ON b.aggregate_id=t.id AND b.type='task.dispatch'
       WHERE o.id=$1 AND o.tenant_id=$2
       GROUP BY o.id, t.id, b.payload`,
      [firstOperationId, tenantId],
    );
    expect(firstRows.rowCount).toBe(1);
    const first = firstRows.rows[0]!;
    expect(first.endpoint_slug).toBe('workflows:schema:wfa-http-pin');
    expect(first.task_id).toBe(first.root_task_id);
    expect(first.task_kind).toBe('root');
    expect(first.outbox_count).toBe('1');
    const pipeline = typeof first.pipeline_json === 'string'
      ? JSON.parse(first.pipeline_json) as unknown
      : first.pipeline_json;
    expect(pipeline).toEqual([{
      processor: 'ext-classifier',
      workflow: 'wfa-http-pin',
      schemaRevision: initialPin.revision,
      schemaDigest: initialPin.digest,
    }]);
    const payloadEnvelope = typeof first.payload_ref === 'string'
      ? JSON.parse(first.payload_ref) as unknown
      : first.payload_ref;
    const taskPayload = await metadataCrypto.readStored(payloadEnvelope, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: first.task_id,
    }, false) as { input: { variables: Record<string, unknown> }; legacyWorkflowSchema: unknown };
    expect(taskPayload.input.variables).toEqual({
      schemaSlug: 'body-cannot-select',
      reference: 'admitted revision one',
    });
    expect(taskPayload.legacyWorkflowSchema).toEqual(initialPin);
    const outbox = typeof first.outbox_payload === 'string'
      ? JSON.parse(first.outbox_payload) as Record<string, unknown>
      : first.outbox_payload as Record<string, unknown>;
    expect(outbox).toMatchObject({
      businessId: 'document-core',
      action: 'schema-workflow',
      kind: 'root',
      taskId: first.task_id,
      operationId: firstOperationId,
    });

    const secondPin = await provisionLegacyWorkflowSchema(
      app.db,
      { tenantId, schema: inputSchema(2), expectedRevision: initialPin.revision },
      metadataCrypto,
    );
    expect(secondPin.revision).toBe(initialPin.revision + 1);
    expect(secondPin.digest).not.toBe(initialPin.digest);

    const secondResponse = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'idempotency-key': 'wfa-old-contract-repeat' },
      body: multipart({ schemaSlug: 'wfa-http-pin', input: '{"referenceV2":"admitted revision two"}' }),
    });
    const secondBody = JSON.parse(await expectStatus(secondResponse, 202, 'repeat schema submit')) as Record<string, unknown>;
    const secondOperationId = String(secondBody.name).replace(/^operations\//, '');
    expect(secondOperationId).not.toBe(firstOperationId);
    const secondTask = await app.db.query<{ id: string; payload_ref: unknown }>(
      `SELECT t.id, t.payload_ref FROM tasks t JOIN operations o ON o.root_task_id=t.id
       WHERE o.id=$1 AND o.tenant_id=$2`,
      [secondOperationId, tenantId],
    );
    expect(secondTask.rowCount).toBe(1);
    const secondEnvelope = typeof secondTask.rows[0]!.payload_ref === 'string'
      ? JSON.parse(secondTask.rows[0]!.payload_ref as string) as unknown
      : secondTask.rows[0]!.payload_ref;
    const secondPayload = await metadataCrypto.readStored(secondEnvelope, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: secondTask.rows[0]!.id,
    }, false) as { legacyWorkflowSchema: unknown };
    expect(secondPayload.legacyWorkflowSchema).toEqual(secondPin);
    const submissionKeys = await app.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM submission_keys WHERE tenant_id=$1', [tenantId],
    );
    expect(submissionKeys.rows[0]?.count).toBe('0');

    const inputBytes = Buffer.from('WFA_SYNTHETIC_ENCRYPTED_WORKFLOW_ARTIFACT_v1', 'utf8');
    const uploaded = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: multipart(
        { schemaSlug: 'wfa-http-pin', input: '{"referenceV2":"encrypted file fixture"}' },
        { name: 'wfa-encrypted-input.txt', content: inputBytes.toString('utf8') },
      ),
    });
    const uploadedBody = JSON.parse(await expectStatus(uploaded, 202, 'encrypted file schema submit')) as Record<string, unknown>;
    const uploadedOperationId = String(uploadedBody.name).replace(/^operations\//, '');
    const artifactRows = await app.db.query<{
      id: string;
      state: string;
      storage_key: string;
      upload_token: string | null;
      storage_version_id: string | null;
      manifest_version_id: string | null;
      size_bytes: number;
      sha256: string;
      ciphertext: Buffer | null;
      sidecar: Buffer | null;
    }>(
      `SELECT a.id, a.state, a.storage_key, a.upload_token, a.storage_version_id, a.manifest_version_id,
              a.size_bytes, a.sha256, object.bytes AS ciphertext, manifest.bytes AS sidecar
       FROM operations o
       CROSS JOIN LATERAL jsonb_array_elements(o.submit_artifacts) AS submitted
       JOIN artifacts a ON a.id=(submitted->>'artifactId')::uuid AND a.tenant_id=o.tenant_id
       LEFT JOIN artifact_blobs object ON object.storage_key=a.storage_key AND object.tenant_id=a.tenant_id
       LEFT JOIN artifact_blobs manifest
         ON manifest.storage_key=a.storage_key || '.crypto-manifest.json' AND manifest.tenant_id=a.tenant_id
       WHERE o.id=$1 AND o.tenant_id=$2`,
      [uploadedOperationId, tenantId],
    );
    expect(artifactRows.rowCount).toBe(1);
    const artifact = artifactRows.rows[0]!;
    expect(artifact.state).toBe('READY');
    expect(artifact.upload_token).toBeTruthy();
    expect(artifact.storage_version_id).toBeTruthy();
    expect(artifact.manifest_version_id).toBeTruthy();
    expect(artifact.ciphertext).not.toBeNull();
    expect(artifact.sidecar).not.toBeNull();
    expect(artifact.ciphertext!.includes(inputBytes)).toBe(false);
    expect(artifact.sidecar!.includes(inputBytes)).toBe(false);
    const sidecar = JSON.parse(artifact.sidecar!.toString('utf8')) as unknown;
    const decrypted = await decryptStoredArtifact({
      reader: {
        head: async (storageKey) => ({
          [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
          [MANIFEST_KEY_METADATA]: manifestKeyFor(storageKey),
          artifactid: artifact.id,
          tenantid: tenantId,
        }),
        read: async () => Buffer.from(artifact.ciphertext!),
        readManifest: async () => sidecar,
      },
      facade: new CryptoStorageFacade(keyProvider),
      encryptionRequired: true,
    }, {
      artifactId: artifact.id,
      tenantId,
      storageKey: artifact.storage_key,
      uploadToken: artifact.upload_token,
      manifestVersionId: artifact.manifest_version_id,
    }, Buffer.from(artifact.ciphertext!));
    expect(decrypted.decrypted).toBe(true);
    expect(decrypted.bytes).toEqual(inputBytes);
  }, 120_000);

  test('cleans the real uploaded artifact after the active-version admission denial', async () => {
    if (!app) throw new Error('WFA schema pin app is not running');
    const before = await counts();
    const auditBefore = await app.db.query<{ count: string }>('SELECT count(*)::text AS count FROM wfa_public_upload_audit');
    const originalPreflight = app.submission.preflightLegacyWorkflow.bind(app.submission);
    app.submission.preflightLegacyWorkflow = async (...args) => {
      const result = await originalPreflight(...args);
      // Exercise the real TOCTOU admission guard: the active version changes
      // after preflight succeeds but before the upload is linked by submit().
      // The host must compensate the just-created artifact when submit rechecks.
      await app!.registry.deactivateVersion(documentCoreManifest.businessId, documentCoreManifest.version);
      return result;
    };

    try {
      const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
        body: multipart(
          { schemaSlug: 'wfa-http-pin', input: '{"reference":"denied after upload"}' },
          { name: 'synthetic-cleanup.txt', content: 'synthetic upload to be compensated' },
        ),
      });
      await expectStatus(response, 404, 'schema submit after active-version race');
    } finally {
      app.submission.preflightLegacyWorkflow = originalPreflight;
      await app.registry.activateVersion(documentCoreManifest.businessId, documentCoreManifest.version);
    }
    const auditAfter = await app.db.query<{ count: string }>('SELECT count(*)::text AS count FROM wfa_public_upload_audit');
    expect(Number(auditAfter.rows[0]?.count)).toBe(Number(auditBefore.rows[0]?.count) + 1);
    expect(await counts()).toEqual(before);
  }, 120_000);
});
