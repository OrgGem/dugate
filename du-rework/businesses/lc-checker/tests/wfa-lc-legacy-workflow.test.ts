import type { TaskContext } from '@du/worker-sdk';

import { lcCheckerManifest } from '../src/manifest';
import { legacyLcCheckerHandler } from '../src/legacy-workflow';

function makeLegacyHarness(overrides: { input?: Record<string, unknown>; missingSlot?: string } = {}) {
  const originalDocuments = new Map<string, Buffer>([
    ['artifact-invoice', Buffer.from('%PDF invoice original bytes')],
    ['artifact-bl', Buffer.from('%PDF bill of lading original bytes')],
  ]);
  const storedArtifacts = new Map<string, Buffer>();
  const steps = new Map<string, unknown>();
  const invocations: Array<{ slot: string; input: Record<string, unknown> }> = [];
  const progress: Array<{ percent: number; message?: string }> = [];
  let nextArtifact = 0;
  const checkResult = {
    verdict: 'DISCREPANT',
    total_discrepancies: 1,
    major_discrepancies: 1,
    minor_discrepancies: 0,
    advisory_count: 0,
    documents_present: ['Commercial Invoice', 'Bill of Lading'],
    documents_missing: [],
    discrepancies: [{
      id: 'D-1',
      severity: 'MAJOR',
      document: 'Bill of Lading',
      field: 'consignee',
      issue: 'Consignee differs from the LC',
      rule_reference: 'UCP 600 Article 14',
      recommendation: 'Reserve for review',
    }],
    summary: 'One major discrepancy was identified.',
    recommendation: 'RESERVE_FOR_REVIEW',
  };
  const input = overrides.input ?? {
    variables: {},
    artifactIds: ['artifact-invoice', 'artifact-bl'],
    fileNames: ['invoice.pdf', 'bill-of-lading.pdf'],
    artifacts: [
      { artifactId: 'artifact-invoice', role: 'files-1' },
      { artifactId: 'artifact-bl', role: 'files-2' },
    ],
    legacyWorkflow: { version: 'legacy-workflow-named-input-v1', process: 'lc-checker' },
  };

  const ctx = {
    taskId: 'task-1',
    operationId: 'operation-1',
    tenantId: 'tenant-1',
    businessId: 'lc-checker',
    businessVersion: '1.1.0',
    action: 'lc-checker',
    kind: 'root',
    taskKey: 'root',
    attempt: 1,
    leaseEpoch: 1,
    deadlineAt: null,
    signal: new AbortController().signal,
    cancelRequested: false,
    input,
    connectorBindings: {
      'legacy-ocr': 'ocr-provider@4',
      'legacy-compliance': 'compliance-provider@7',
      'legacy-report': 'report-provider@2',
      ...(overrides.missingSlot ? { [overrides.missingSlot]: undefined } : {}),
    },
    step: {
      async run<T>(stepKey: string, _inputHash: string, fn: () => Promise<T>): Promise<T> {
        if (steps.has(stepKey)) return steps.get(stepKey) as T;
        const result = await fn();
        steps.set(stepKey, result);
        return result;
      },
      async peek() { return null; },
    },
    spawn: { async spawnAndWait() { throw new Error('legacy LC never spawns children'); } },
    wait: { async waitForInput() { throw new Error('legacy LC has no human wait'); } },
    progress: {
      async report(percent: number, message?: string) { progress.push({ percent, message }); },
    },
    artifacts: {
      async readWithMetadata(artifactId: string) {
        const bytes = originalDocuments.get(artifactId) ?? storedArtifacts.get(artifactId);
        if (!bytes) throw new Error('artifact not found');
        return {
          buffer: bytes,
          sizeBytes: bytes.byteLength,
          sha256: 'sha256-test',
          filename: originalDocuments.has(artifactId) ? (artifactId === 'artifact-invoice' ? 'invoice.pdf' : 'bill-of-lading.pdf') : null,
          mimeType: originalDocuments.has(artifactId) ? 'application/pdf' : 'text/plain',
          storageVersionId: 'v1',
        };
      },
      async write(content: Buffer | string) {
        const artifactId = 'stored-' + (++nextArtifact);
        storedArtifacts.set(artifactId, Buffer.isBuffer(content) ? content : Buffer.from(content));
        return { artifactId, fileName: artifactId, mimeType: 'text/plain', sizeBytes: storedArtifacts.get(artifactId)!.byteLength, sha256: 'sha256-test' };
      },
    },
    connector: {
      async invoke(slot: string, rawInput: Record<string, unknown>) {
        invocations.push({ slot, input: rawInput });
        if (slot === 'legacy-ocr') {
          const artifact = (rawInput['artifacts'] as Array<{ fileName: string }>)[0]!;
          return {
            state: 'SUCCEEDED',
            result: { content: `OCR text for ${artifact.fileName}` },
            usage: { inputTokens: 3, outputTokens: 4, costMicrousd: 250, measurement: 'measured' },
          };
        }
        if (slot === 'legacy-compliance') {
          return {
            state: 'SUCCEEDED',
            result: { content: JSON.stringify(checkResult) },
            usage: { inputTokens: 10, outputTokens: 11, pages: 2, costMicrousd: 1000, measurement: 'measured' },
          };
        }
        if (slot === 'legacy-report') {
          return {
            state: 'SUCCEEDED',
            result: { content: '# Báo cáo kiểm tra LC\nMột sai lệch trọng yếu.' },
            usage: { inputTokens: 5, outputTokens: 6, costMicrousd: 500, measurement: 'measured' },
          };
        }
        throw new Error('unexpected connector slot');
      },
    },
    checkpoints() { return []; },
    async grantFor() { throw new Error('grant facade unused'); },
  } as unknown as TaskContext;

  return { ctx, invocations, progress, steps, originalDocuments, storedArtifacts, checkResult };
}

describe('legacy LC workflow compatibility adapter', () => {
  it('declares a separate legacy input branch and keeps canonical requirements when the marker is absent', () => {
    const schema = lcCheckerManifest.actions[0]!.inputSchema as unknown as {
      allOf: Array<{
        if: { required: string[] };
        then: { required: string[]; not: { anyOf: Array<{ required: string[] }> } };
        else: { required: string[] };
      }>;
      properties: Record<string, { properties?: Record<string, { const?: string }> }>;
      additionalProperties: boolean;
    };
    const branch = schema.allOf[0]!;
    expect(branch.if.required).toEqual(['legacyWorkflow']);
    expect(branch.then.required).toEqual(['legacyWorkflow', 'variables', 'artifactIds', 'fileNames', 'artifacts']);
    expect(branch.then.not.anyOf).toContainEqual({ required: ['inputVersion'] });
    expect(branch.else.required).toEqual([
      'inputVersion', 'artifactIds', 'fileNames', 'ruleSetVersion', 'failurePolicy',
    ]);
    expect(schema.properties['legacyWorkflow']?.properties?.['version']?.const)
      .toBe('legacy-workflow-named-input-v1');
    expect(schema.properties['legacyWorkflow']?.properties?.['process']?.const).toBe('lc-checker');
    expect(schema.additionalProperties).toBe(false);
  });

  it('runs OCR, hybrid original-document compliance, then report through pinned legacy slots', async () => {
    const harness = makeLegacyHarness();
    const disposition = await legacyLcCheckerHandler(harness.ctx);

    expect(disposition.kind).toBe('completed');
    if (disposition.kind !== 'completed') throw new Error('unreachable');
    const result = JSON.parse(disposition.resultRef) as Record<string, unknown>;
    expect(result).toMatchObject({
      schemaVersion: 'legacy-workflow-result-v1',
      outputFormat: 'json',
      content: '# Báo cáo kiểm tra LC\nMột sai lệch trọng yếu.',
      extractedData: harness.checkResult,
    });
    expect((result['pipelineSteps'] as Array<Record<string, unknown>>).map((step) => step['processor']))
      .toEqual(['ext-doc-layout', 'ext-fact-verifier', 'ext-content-gen']);
    expect((result['pipelineSteps'] as Array<Record<string, unknown>>)[1]?.['content_preview'])
      .toBe(JSON.stringify(harness.checkResult));
    expect(result['usage']).toEqual({ inputTokens: 21, outputTokens: 25, pages: 2, costUsd: 0.002 });

    const ocrCalls = harness.invocations.filter((call) => call.slot === 'legacy-ocr');
    expect(ocrCalls).toHaveLength(2);
    for (const call of ocrCalls) {
      expect(String(call.input['prompt'])).toContain('high-precision Document OCR Engine');
      expect(call.input['artifacts']).toHaveLength(1);
    }
    const compliance = harness.invocations.find((call) => call.slot === 'legacy-compliance');
    expect(compliance).toBeDefined();
    expect(compliance?.input['artifacts']).toHaveLength(2);
    expect(String(compliance?.input['prompt'])).toContain('OCR FULL-TEXT (PRIMARY DATA SOURCE)');
    expect(String(compliance?.input['prompt'])).toContain('OCR text for invoice.pdf');
    expect(String(compliance?.input['prompt'])).toContain('UCP 600');
    const originalPayloads = (compliance?.input['artifacts'] as Array<{ contentBase64: string }>).map((artifact) =>
      Buffer.from(artifact.contentBase64, 'base64'),
    );
    expect(originalPayloads).toEqual([...harness.originalDocuments.values()]);
    const report = harness.invocations.find((call) => call.slot === 'legacy-report');
    expect(String(report?.input['prompt'])).toContain('One major discrepancy was identified.');

    // Full OCR/compliance/report content is held in artifact storage; durable
    // step checkpoint values contain only those artifact IDs and safe counts.
    expect(JSON.stringify([...harness.steps.values()])).not.toContain('OCR text for');
    expect(harness.progress.some((entry) => entry.percent === 100)).toBe(true);
  });

  it('fails closed before provider egress when a legacy slot is not pinned', async () => {
    const harness = makeLegacyHarness({ missingSlot: 'legacy-compliance' });
    await expect(legacyLcCheckerHandler(harness.ctx)).rejects.toThrow('legacy-compliance');
    expect(harness.invocations).toHaveLength(0);
  });

  it('rejects a malformed or wrong-process marker without falling through to canonical ruleset input', async () => {
    const harness = makeLegacyHarness({
      input: {
        variables: {},
        artifactIds: ['artifact-invoice'],
        fileNames: ['invoice.pdf'],
        artifacts: [{ artifactId: 'artifact-invoice', role: 'file' }],
        legacyWorkflow: { version: 'legacy-workflow-named-input-v1', process: 'doc-compare' },
      },
    });
    await expect(legacyLcCheckerHandler(harness.ctx)).rejects.toThrow('marker is missing or invalid');
    expect(harness.invocations).toHaveLength(0);
  });
});
