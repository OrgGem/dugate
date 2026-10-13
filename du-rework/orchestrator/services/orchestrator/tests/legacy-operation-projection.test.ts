import { Readable } from 'node:stream';
import type { RouteContext } from '../src/server';
import { toLegacyEnvelope } from '../src/compat/legacy-envelope';
import { legacyCompatHost, toLegacyRow } from '../src/compat/legacy-host-adapter';

type QueryResultLike = { rowCount: number; rows: unknown[] };

const TENANT_ID = 'tenant-a';
const API_KEY_ID = 'key-a';
const OPERATION_ID = 'operation-a';

function result(rows: unknown[] = []): QueryResultLike {
  return { rowCount: rows.length, rows };
}

function coreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OPERATION_ID,
    tenant_id: TENANT_ID,
    api_key_id: API_KEY_ID,
    business_id: 'document-core',
    action: 'extract',
    state: 'QUEUED',
    deleted_at: null,
    pipeline_json: '[{"legacyCallback":true}]',
    steps_result_json: null,
    current_step: 0,
    progress_percent: 0,
    progress_message: 'Queued',
    created_at: '2026-10-13T00:00:00.000Z',
    updated_at: '2026-10-13T00:00:01.000Z',
    output_format: 'md',
    output_content: null,
    output_file_path: null,
    extracted_data: null,
    total_input_tokens: null,
    total_output_tokens: null,
    pages_processed: null,
    model_used: null,
    total_cost_usd: null,
    usage_breakdown: null,
    error_code: null,
    error_message: null,
    failed_at_step: null,
    endpoint_slug: 'extract:invoice',
    submit_artifacts: [],
    ...overrides,
  };
}

function workflowRow(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...coreRow({
      business_id: 'document-core',
      action: 'disbursement',
      state,
      pipeline_json: '[{"processor":"ext-classifier","workflow":"disbursement"}]',
      endpoint_slug: 'workflows:disbursement',
      progress_percent: 35,
      progress_message: 'Processing workflow...',
    }),
    ...overrides,
  };
}

function makeContext(options: {
  operation: Record<string, unknown>;
  readStoredText: (ref: unknown) => Promise<string | undefined>;
  resultArtifact?: { storageKey: string; bytes: Buffer };
  submittedName?: string;
}): RouteContext {
  const queries: string[] = [];
  const db = {
    query: async (sql: string): Promise<QueryResultLike> => {
      queries.push(sql);
      if (sql.startsWith('SELECT * FROM operations')) return result([options.operation]);
      if (sql.startsWith('SELECT file_name FROM artifacts')) {
        return options.submittedName ? result([{ file_name: options.submittedName }]) : result([]);
      }
      if (sql.startsWith('SELECT storage_key FROM artifacts')) {
        return options.resultArtifact ? result([{ storage_key: options.resultArtifact.storageKey }]) : result([]);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const artifacts = {
    getBlob: async (storageKey: string) => {
      if (!options.resultArtifact || storageKey !== options.resultArtifact.storageKey) {
        throw new Error(`unexpected artifact: ${storageKey}`);
      }
      return Readable.from([options.resultArtifact.bytes]);
    },
  };
  return {
    db,
    artifacts,
    metadataReader: { readStoredText: options.readStoredText },
    __queries: queries,
  } as unknown as RouteContext;
}

describe('legacy operation polling projection', () => {
  it.each([
    ['PENDING_INGESTION', 'PENDING'],
    ['ACCEPTED', 'RUNNING'],
    ['QUEUED', 'RUNNING'],
    ['RUNNING', 'RUNNING'],
    ['WAITING_CHILDREN', 'RUNNING'],
    ['RETRY_PENDING', 'RUNNING'],
    ['CANCEL_REQUESTED', 'RUNNING'],
    ['WAITING_INPUT', 'WAITING_USER_INPUT'],
    ['SUCCEEDED', 'SUCCEEDED'],
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
    ['TIMED_OUT', 'TIMED_OUT'],
  ])('maps Core %s to the legacy state %s', (state, expected) => {
    const projected = toLegacyRow(coreRow({ state }));
    const body = toLegacyEnvelope(projected);
    expect((body.metadata as Record<string, unknown>).state).toBe(expected);
    expect(body.done).toBe(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state));
  });

  it.each([
    ['ACCEPTED', 'RUNNING'],
    ['QUEUED', 'RUNNING'],
    ['RUNNING', 'RUNNING'],
    ['WAITING_CHILDREN', 'RUNNING'],
    ['RETRY_PENDING', 'RUNNING'],
    ['CANCEL_REQUESTED', 'RUNNING'],
    ['WAITING_INPUT', 'WAITING_USER_INPUT'],
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
  ])('maps Workflow %s to the legacy state %s', (state, expected) => {
    const projected = toLegacyRow(workflowRow(state));
    const body = toLegacyEnvelope(projected);
    expect((body.metadata as Record<string, unknown>).state).toBe(expected);
    expect(body.done).toBe(['FAILED', 'CANCELLED'].includes(state));
    expect((body.metadata as Record<string, unknown>).pipeline).toEqual(['ext-classifier']);
  });

  it('marks a successful Core poll complete even when the stored result is unavailable', () => {
    const row = toLegacyRow(coreRow({ state: 'SUCCEEDED' }));
    const body = toLegacyEnvelope(row);
    expect(body).toMatchObject({ done: true, metadata: {
      state: 'SUCCEEDED',
      pipeline: ['extract'],
      progress_percent: 100,
      progress_message: null,
    } });
    expect((body.metadata as Record<string, unknown>).pipeline_steps).toEqual([]);
  });

  it('projects a completed Core result into the old action-level pipeline and progress fields', async () => {
    const data = { invoiceNumber: 'INV-1', total: 42 };
    const resultBytes = Buffer.from(JSON.stringify({
      version: 'document-core-result-v1',
      status: 'COMPLETED',
      data,
      provenance: { method: 'llm_extraction', modelSlot: 'reasoning' },
    }));
    const ctx = makeContext({
      operation: coreRow({
        state: 'SUCCEEDED',
        result_ref: 'encrypted-result-ref',
        submit_artifacts: [{ artifactId: 'input-artifact', role: 'source' }],
      }),
      readStoredText: async () => 'artifact://result-artifact',
      resultArtifact: { storageKey: 'result-storage-key', bytes: resultBytes },
      submittedName: 'invoice-source.pdf',
    });

    const row = await legacyCompatHost(ctx).loadOperation(OPERATION_ID, TENANT_ID, API_KEY_ID);
    expect(row).toMatchObject({
      sourceFileName: 'invoice-source.pdf',
      pipelineJson: '[{"processor":"extract","legacyCallback":true}]',
      progressPercent: 100,
      progressMessage: null,
      currentStep: 0,
    });
    const body = toLegacyEnvelope(row!);
    const metadata = body.metadata as Record<string, unknown>;
    const expectedStep = {
      step: 0,
      processor: 'extract',
      output_format: 'md',
      content_preview: JSON.stringify(data),
      extracted_data: data,
    };
    expect(metadata).toMatchObject({
      state: 'SUCCEEDED',
      pipeline: ['extract'],
      current_step: 0,
      progress_percent: 100,
      progress_message: null,
      pipeline_steps: [expectedStep],
    });
    expect(body.result).toMatchObject({
      output_format: 'md',
      content: JSON.stringify(data),
      extracted_data: data,
      pipeline_steps: [expectedStep],
    });
    expect(body.metadata).not.toHaveProperty('sourceFileName');
    const queries = (ctx as unknown as { __queries: string[] }).__queries;
    expect(queries[1]).toContain('tenant_id = $2');
    expect(queries[1]).toContain('operation_id = $3');
    expect(queries[1]).toContain("state = 'READY'");
  });

  it('retains a persisted legacy Core pipeline and its real step results', async () => {
    const savedPipeline = '[{"processor":"ext-invoice"},{"processor":"ext-enricher"}]';
    const savedSteps = '[{"step":0,"processor":"ext-invoice","content_preview":"saved"}]';
    const resultBytes = Buffer.from(JSON.stringify({
      version: 'document-core-result-v1',
      status: 'COMPLETED',
      data: { text: 'Final output' },
      provenance: { method: 'native_parse', parserUsed: 'pdf' },
    }));
    const ctx = makeContext({
      operation: coreRow({
        state: 'SUCCEEDED',
        pipeline_json: savedPipeline,
        steps_result_json: savedSteps,
        result_ref: 'encrypted-result-ref',
      }),
      readStoredText: async () => 'artifact://result-artifact',
      resultArtifact: { storageKey: 'result-storage-key', bytes: resultBytes },
    });

    const row = await legacyCompatHost(ctx).loadOperation(OPERATION_ID, TENANT_ID, API_KEY_ID);
    expect(row?.pipelineJson).toBe(savedPipeline);
    expect(row?.stepsResultJson).toBe(savedSteps);
    expect(row?.currentStep).toBe(0);
    const metadata = toLegacyEnvelope(row!).metadata as Record<string, unknown>;
    expect(metadata.pipeline).toEqual(['ext-invoice', 'ext-enricher']);
    expect(metadata.pipeline_steps).toEqual([{ step: 0, processor: 'ext-invoice', content_preview: 'saved' }]);
  });

  it('preserves a valid Core processor entry that also selects legacy callback delivery', () => {
    const pipeline = '[{"processor":"extract","legacyCallback":true}]';
    const row = toLegacyRow(coreRow({ pipeline_json: pipeline }));
    expect(row.pipelineJson).toBe(pipeline);
    expect((toLegacyEnvelope(row).metadata as Record<string, unknown>).pipeline).toEqual(['extract']);
  });

  it('keeps Workflow worker progress and validated result steps without inventing intermediate steps', async () => {
    const pipelineSteps = [
      { step: 0, stepName: 'classify', processor: 'ext-classifier', content_preview: null, extracted_data: null },
      { step: 1, stepName: 'review', processor: 'ext-review', content_preview: 'safe preview', extracted_data: { approved: true } },
    ];
    const workflowResult = JSON.stringify({
      schemaVersion: 'legacy-workflow-result-v1',
      outputFormat: 'md',
      content: '# complete',
      extractedData: { approved: true },
      pipelineSteps,
      usage: { inputTokens: 4, outputTokens: 5 },
    });
    const ctx = makeContext({
      operation: workflowRow('SUCCEEDED', {
        result_ref: 'encrypted-workflow-result',
        progress_percent: 100,
        progress_message: null,
      }),
      readStoredText: async () => workflowResult,
    });

    const row = await legacyCompatHost(ctx).loadOperation(OPERATION_ID, TENANT_ID, API_KEY_ID);
    expect(row).toMatchObject({
      currentStep: 1,
      progressPercent: 100,
      progressMessage: null,
      stepsResultJson: JSON.stringify(pipelineSteps),
    });
    const body = toLegacyEnvelope(row!);
    expect(body.result).toMatchObject({
      content: '# complete',
      extracted_data: { approved: true },
      pipeline_steps: pipelineSteps,
    });
  });

  it('preserves failed and cancelled response blocks for old pollers', () => {
    const failed = toLegacyEnvelope(toLegacyRow(coreRow({
      state: 'FAILED', error_code: 'ACTION_FAILED', error_message: 'failed',
    })));
    expect(failed).toMatchObject({
      done: true,
      error: { code: 'ACTION_FAILED', message: 'failed', failed_step: null },
    });
    expect(failed).not.toHaveProperty('result');

    const cancelled = toLegacyEnvelope(toLegacyRow(coreRow({ state: 'CANCELLED' })));
    expect(cancelled).toMatchObject({ done: true, metadata: { state: 'CANCELLED' } });
    expect(cancelled).not.toHaveProperty('error');
    expect(cancelled).not.toHaveProperty('result');
  });
});
