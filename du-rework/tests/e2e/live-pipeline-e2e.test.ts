/**
 * live-pipeline-e2e.test.ts — LIV-06 Live E2E Pipeline Test
 *
 * Verifies the end-to-end processing pipeline against live infrastructure:
 * Orchestrator (port 3000), Connector (port 8091), MinIO S3 (port 9003),
 * HashiCorp Vault (port 8200), PostgreSQL (port 5433), Redis (port 6380),
 * and BullMQ worker (document-core).
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://127.0.0.1:3000';
const CONNECTOR_URL = process.env.CONNECTOR_URL || 'http://127.0.0.1:8091';
const VAULT_ADDR = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
const API_KEY = process.env.DU_LIVE_API_KEY || 'du_live_test_api_key_1234567890abcdef';

describe('LIV-06: Live End-to-End Pipeline (Ingest -> Worker -> MinIO -> Vault -> Result)', () => {
  beforeAll(async () => {
    // 1. Verify Orchestrator Health
    const orchHealth = await fetch(`${ORCHESTRATOR_URL}/health`);
    expect(orchHealth.status).toBe(200);
    const orchHealthData = (await orchHealth.json()) as any;
    expect(orchHealthData.db).toBe(true);
    expect(orchHealthData.redis).toBe(true);

    // 2. Verify Connector Health
    const connHealth = await fetch(`${CONNECTOR_URL}/health/ready`);
    expect(connHealth.status).toBe(200);

    // 3. Verify Vault Health
    const vaultHealth = await fetch(`${VAULT_ADDR}/v1/sys/health`);
    expect([200, 429, 472, 473]).toContain(vaultHealth.status);
  });

  it('submits ingest operation, worker processes via BullMQ, stores to MinIO, and downloads result', async () => {
    const testDocText = '# Live E2E Document\n\nDUGate live testing with MinIO S3, Vault Transit, and BullMQ worker.';
    const idempotencyKey = `live-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Step 1: Submit Ingest Action
    const submitRes = await fetch(`${ORCHESTRATOR_URL}/api/v1/businesses/document-core/actions/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        input: {
          mode: 'parse',
          text: testDocText,
        },
      }),
    });

    expect(submitRes.status).toBe(202);
    const submitData = (await submitRes.json()) as any;
    expect(submitData.operationId).toBeDefined();
    expect(submitData.state).toBe('ACCEPTED');
    expect(submitData.links?.result).toBeDefined();

    const operationId = submitData.operationId;

    // Step 2: Poll Operation until completion (timeout: 15s)
    const startTime = Date.now();
    let finalOpData: any = null;

    while (Date.now() - startTime < 15_000) {
      await new Promise((r) => setTimeout(r, 400));
      const opRes = await fetch(`${ORCHESTRATOR_URL}/api/v1/operations/${operationId}`, {
        headers: { 'x-api-key': API_KEY },
      });
      expect(opRes.status).toBe(200);
      const opData = (await opRes.json()) as any;
      if (opData.done || opData.metadata?.state === 'SUCCEEDED' || opData.metadata?.state === 'FAILED') {
        finalOpData = opData;
        break;
      }
    }

    expect(finalOpData).not.toBeNull();
    expect(finalOpData.metadata?.state).toBe('SUCCEEDED');
    expect(finalOpData.done).toBe(true);
    expect(finalOpData.error).toBeUndefined();

    // Step 3: Fetch Operation Result
    const resultRes = await fetch(`${ORCHESTRATOR_URL}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': API_KEY },
    });
    expect(resultRes.status).toBe(200);
    const resultData = (await resultRes.json()) as any;
    expect(resultData.schemaVersion).toBe('1');
    expect(resultData.artifacts).toBeDefined();
    expect(resultData.artifacts.length).toBeGreaterThan(0);

    const outputArtifact = resultData.artifacts[0];
    expect(outputArtifact.artifactId).toBeDefined();
    expect(outputArtifact.role).toBe('output');
    expect(outputArtifact.download).toBeDefined();

    // Step 4: Download Result Artifact from MinIO S3 via Orchestrator proxy
    const downloadRes = await fetch(`${ORCHESTRATOR_URL}${outputArtifact.download}`, {
      headers: { 'x-api-key': API_KEY },
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toContain('application/json');

    const artifactContent = (await downloadRes.json()) as any;
    expect(artifactContent.status).toBe('COMPLETED');
    expect(artifactContent.data?.text).toContain(testDocText);
    expect(artifactContent.data?.markdown).toContain(testDocText);
    expect(artifactContent.data?.metadata?.parser).toBe('inline-text');

    // Step 5: Verify Idempotency Replay
    const replayRes = await fetch(`${ORCHESTRATOR_URL}/api/v1/businesses/document-core/actions/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        input: {
          mode: 'parse',
          text: testDocText,
        },
      }),
    });

    expect(replayRes.status).toBe(200);
    const replayData = (await replayRes.json()) as any;
    expect(replayData.operationId).toBe(operationId);
    expect(replayData.replayed).toBe(true);

    // Step 6: Security Assertions — Ensure zero secret leakage
    const responsePayloadStr = JSON.stringify(resultData) + JSON.stringify(artifactContent);
    expect(responsePayloadStr).not.toContain('minioadmin_secret');
    expect(responsePayloadStr).not.toContain('root-dev-token');
    expect(responsePayloadStr).not.toContain('du-live-worker-document-core-token-32b');
    expect(responsePayloadStr).not.toContain('du-live-runtime-token-secret-32b');
  }, 20_000);
});
