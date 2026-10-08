// WFA-VERIFY-BASELINE (OC lane) — admission-level scaffolding for the three legacy
// named processes (WFA-T01..T03).
//
// Scope decision: the full HTTP → worker → poll/result/download harness is owned by
// http-worker.integration.test.ts (qwen_2 lane). This file is the OC lane's
// independent, worker-free baseline: it boots the REAL composition, registers both
// businesses, pins the same profile connector bindings the canonical harness uses,
// and asserts the frozen legacy 202 admission envelope from
// fixtures/legacy-contract-baseline.json against fixtures/named-processes.json.
//
// Fail-first is expected at this phase (dispatch spec §1 item 3): implementation of
// named-process admission/completion is still landing. Failures are reported as
// BASELINE-FAIL (expected, pending qwen items), never as fixed product code.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { documentCoreManifest } from '../../businesses/document-core/src/manifest/document-core.manifest';
import { lcCheckerManifest } from '../../businesses/lc-checker/src/manifest';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { createProfileService } from '../../orchestrator/services/orchestrator/src/modules/profiles/profiles';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';

interface NamedCase {
  id: string;
  process: string;
  endpointSlug: string;
  apiKeyRole: 'disbursement' | 'lc' | 'named';
  files: Array<{ field: string; name: string; content: string }>;
  variables: Record<string, string>;
  expectedAdmission: {
    status: number;
    metadataRequired: Record<string, unknown>;
  };
  baselineState: string;
}

const namedCases = (
  JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'named-processes.json'), 'utf8')) as {
    cases: NamedCase[];
  }
).cases;

const isolation = createWorkflowApiIsolation();
const keyProvider = syntheticMetadataKeyProvider();
const baseDb = createDb(isolation.baseDatabaseUrl);

const tenantId = randomUUID();
const disbursementApiKey = `wfa-adm-disbursement-${randomUUID()}`;
const lcApiKey = `wfa-adm-lc-${randomUUID()}`;
const namedApiKey = `wfa-adm-named-${randomUUID()}`;
const disbursementApiKeyHash = createHash('sha256').update(disbursementApiKey).digest('hex');
const lcApiKeyHash = createHash('sha256').update(lcApiKey).digest('hex');
const namedApiKeyHash = createHash('sha256').update(namedApiKey).digest('hex');
const runtimeToken = `wfa-adm-runtime-${randomUUID()}`;
const adminToken = `wfa-adm-admin-${randomUUID()}`;

let app: App | undefined;
let baseUrl = '';
let internalUrl = '';
let isolatedSchemaCreated = false;

const apiKeyByRole: Record<NamedCase['apiKeyRole'], string> = {
  disbursement: disbursementApiKey,
  lc: lcApiKey,
  named: namedApiKey,
};

function multipart(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return body;
}

async function registerAndActivate(
  manifest: { businessId: string; version: string },
  label: string,
): Promise<void> {
  if (!app) throw new Error('WFA admission app is not running');
  const register = await fetch(
    `${internalUrl}/api/runtime/v1/businesses/${manifest.businessId}/versions/${manifest.version}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    },
  );
  if (![200, 201].includes(register.status)) {
    throw new Error(`${label} registration returned ${register.status}: ${await register.text()}`);
  }
  for (const action of ['enable', 'activate']) {
    const response = await fetch(
      `${internalUrl}/api/v1/admin/businesses/${manifest.businessId}/versions/${manifest.version}/${action}`,
      { method: 'PUT', headers: { authorization: `Bearer ${adminToken}` } },
    );
    if (!(action === 'enable' ? [200] : [200, 202]).includes(response.status)) {
      throw new Error(`${label} ${action} returned ${response.status}: ${await response.text()}`);
    }
  }
}

describe('WFA named-process admission baseline (WFA-T01..T03, worker-free)', () => {
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
    if (!internalAddress || typeof internalAddress === 'string') {
      throw new Error('Orchestrator internal listener did not bind a TCP port');
    }
    internalUrl = `http://127.0.0.1:${(internalAddress as AddressInfo).port}`;

    await registerAndActivate(documentCoreManifest, 'document-core');
    await registerAndActivate(lcCheckerManifest, 'lc-checker');

    await app.db.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'WFA admission baseline tenant']);
    await app.db.query(
      `INSERT INTO api_keys (tenant_id, hash, prefix, status)
       VALUES ($1, $2, 'wfa-adm-disbursement', 'ACTIVE'),
              ($1, $3, 'wfa-adm-lc', 'ACTIVE'),
              ($1, $4, 'wfa-adm-named', 'ACTIVE')`,
      [tenantId, disbursementApiKeyHash, lcApiKeyHash, namedApiKeyHash],
    );

    // Same profile connector bindings the canonical harness pins; the placeholder
    // connector id is never contacted by this worker-free suite.
    await createProfileService(app.db).createRevision({
      apiKeyHash: disbursementApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'disbursement',
      connectorBindings: {
        classify: { connectorId: 'wfa-offline-provider', revision: 1 },
        extract: { connectorId: 'wfa-offline-provider', revision: 1 },
        crosscheck: { connectorId: 'wfa-offline-provider', revision: 1 },
        report: { connectorId: 'wfa-offline-provider', revision: 1 },
      },
    });
    await createProfileService(app.db).createRevision({
      apiKeyHash: lcApiKeyHash,
      businessId: 'lc-checker',
      businessVersion: lcCheckerManifest.version,
      action: 'lc-checker',
      connectorBindings: {
        'legacy-ocr': { connectorId: 'wfa-offline-provider', revision: 1 },
        'legacy-compliance': { connectorId: 'wfa-offline-provider', revision: 1 },
        'legacy-report': { connectorId: 'wfa-offline-provider', revision: 1 },
      },
    });
    await createProfileService(app.db).createRevision({
      apiKeyHash: namedApiKeyHash,
      businessId: 'document-core',
      businessVersion: documentCoreManifest.version,
      action: 'doc-compare',
      connectorBindings: {
        'legacy-ocr': { connectorId: 'wfa-offline-provider', revision: 1 },
        'legacy-toc': { connectorId: 'wfa-offline-provider', revision: 1 },
        'legacy-compare': { connectorId: 'wfa-offline-provider', revision: 1 },
        'legacy-report': { connectorId: 'wfa-offline-provider', revision: 1 },
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (isolatedSchemaCreated) {
      await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
    }
    await baseDb.close();
    isolation.context.cleanupArtifactDir();
  }, 30_000);

  for (const entry of namedCases) {
    test(`${entry.id} — ${entry.process}: frozen legacy 202 admission envelope`, async () => {
      const form = new FormData();
      form.append('process', entry.process);
      for (const file of entry.files) {
        form.append(file.field, new File([file.content], file.name, { type: 'application/pdf' }));
      }
      for (const [name, value] of Object.entries(entry.variables)) form.append(name, value);

      const response = await fetch(`${baseUrl}/api/v1/docs/workflows`, {
        method: 'POST',
        headers: { 'x-api-key': apiKeyByRole[entry.apiKeyRole] },
        body: form,
      });
      const text = await response.text();

      if (response.status !== entry.expectedAdmission.status) {
        throw new Error(
          `${entry.id} BASELINE-FAIL (expected, pending qwen items): ${entry.process} admission ` +
            `returned HTTP ${response.status}; ${entry.baselineState}; body=${text.slice(0, 500)}`,
        );
      }

      const body = JSON.parse(text) as {
        name?: unknown;
        done?: unknown;
        metadata?: Record<string, unknown>;
      };
      if (typeof body.name !== 'string' || !/^operations\/[0-9a-f-]{36}$/.test(body.name)) {
        throw new Error(`${entry.id} BASELINE-FAIL: unexpected operation name ${JSON.stringify(body.name)}`);
      }
      const operationId = body.name.slice('operations/'.length);
      expect(response.headers.get('operation-location')).toBe(`/api/v1/operations/${operationId}`);
      expect(body.done).toBe(false);
      expect(body.metadata).toMatchObject(entry.expectedAdmission.metadataRequired);
    }, 30_000);
  }
});
