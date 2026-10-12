import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contentHash,
  type InvocationResponse,
  type TenantDefaultsSnapshot,
} from '@du/contracts';
import type { TaskContext as SdkTaskContext } from '@du/worker-sdk';
import { parseWorkerConfig, getRedactedConfig } from '../src/config';
import { DocumentCoreProcess } from '../src/main';
import {
  createWorkflowPrivateHttpsEgressPolicy,
  parseWorkflowPrivateHttpsOrigins,
} from '../src/workflow-private-https-policy';
import {
  applyPinnedStepPrompt,
  resolveTenantPromptCategory,
  type TenantPromptCategory,
} from '../src/actions/prompt-application';
import { STEP_KEYS } from '../src/recipes/step-keys';
import { toInternalContext } from '../src/worker';
import { metadataLogRecord } from '../../../orchestrator/packages/observability/src/log-metadata';

const TENANT_ID = 'a4166304-e244-4dc3-b082-1fc209f6a5cc';
const ARTIFACT_ID = 'dc70273e-05a6-4e44-b234-0b50e3e8dbe5';

function tenantDefaults(prompts: Partial<Record<TenantPromptCategory, string | null>> = {}): TenantDefaultsSnapshot {
  const content = {
    aiRevision: null,
    promptRevision: 1,
    ai: { provider: null, model: null, connectorId: null, connectorRevision: null },
    prompts: {
      image: prompts.image ?? null,
      pdf: prompts.pdf ?? null,
      docx: prompts.docx ?? null,
      compare: prompts.compare ?? null,
      generate: prompts.generate ?? null,
    },
  };
  return { ...content, settingsDigest: contentHash(content) };
}

function makeZipEntry(name: string, contents: Buffer): Buffer {
  // One stored entry is enough for DocumentFormatDetector to verify the
  // content-derived Word container marker; the adapter never parses it.
  const filename = Buffer.from(name, 'utf8');
  const crc = crc32(contents);
  const local = Buffer.alloc(30 + filename.length + contents.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  contents.copy(local, 30 + filename.length);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('ORV14 Worker private HTTPS configuration', () => {
  const requiredEnv = {
    RUNTIME_URL: 'https://runtime.example.test',
    RUNTIME_TOKEN: 'runtime-token',
    REDIS_URL: 'redis://127.0.0.1:6379',
  };

  it('defaults to the empty list and logs only a safe policy digest', () => {
    const config = parseWorkerConfig(requiredEnv);
    expect(config.workflowPrivateHttpsOrigins).toEqual([]);
    const redacted = getRedactedConfig(config);
    expect(redacted.workflowPrivateHttpsPolicyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(redacted)).not.toContain('private.example.test');
  });

  it('projects only the exact SHA-256 deployment digest through safe log metadata', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(metadataLogRecord({ workflowPrivateHttpsPolicyDigest: digest })).toEqual({
      workflowPrivateHttpsPolicyDigest: digest,
    });
    expect(metadataLogRecord({ workflowPrivateHttpsPolicyDigest: 'https://private.example.test' })).toEqual({});
    expect(metadataLogRecord({ workflowPrivateHttpsPolicyDigest: 'private.example.test,https://other.example' })).toEqual({});
    expect(metadataLogRecord({ workflowPrivateHttpsOrigins: ['https://private.example.test'] })).toEqual({});
    expect(metadataLogRecord({ workflowPrivateHttpsOrigin: 'https://private.example.test' })).toEqual({});
  });

  it('accepts only bounded canonical exact HTTPS origins', () => {
    expect(parseWorkflowPrivateHttpsOrigins('https://private.example.test,https://10.20.30.40:8443'))
      .toEqual(['https://private.example.test', 'https://10.20.30.40:8443']);
    expect(() => parseWorkflowPrivateHttpsOrigins('http://private.example.test')).toThrow();
    expect(() => parseWorkflowPrivateHttpsOrigins('https://private.example.test/')).toThrow();
    expect(() => parseWorkflowPrivateHttpsOrigins('https://user:secret@private.example.test')).toThrow();
    expect(() => parseWorkflowPrivateHttpsOrigins('https://private.example.test/path')).toThrow();
    expect(() => parseWorkflowPrivateHttpsOrigins('https://*.example.test')).toThrow();
    expect(() => parseWorkflowPrivateHttpsOrigins('https://private.example.test,https://private.example.test')).toThrow();
    expect(() => parseWorkflowPrivateHttpsOrigins(`https://${'a'.repeat(2_050)}.test`)).toThrow();
    expect(() => parseWorkflowPrivateHttpsOrigins(Array.from({ length: 65 }, (_, i) => `https://h${i}.example`).join(','))).toThrow();
    const oversized = Array.from({ length: 64 }, (_, i) =>
      `https://${i}.${'a'.repeat(50)}.${'b'.repeat(50)}.${'c'.repeat(50)}.example`,
    );
    expect(() => parseWorkflowPrivateHttpsOrigins(oversized.join(','))).toThrow(/8192-byte/);
    expect(() => createWorkflowPrivateHttpsEgressPolicy(oversized)).toThrow(/8192-byte/);
  });

  it('isolates immutable policies per worker and retains an empty default', () => {
    const first = createWorkflowPrivateHttpsEgressPolicy(['https://private-a.example']);
    const second = createWorkflowPrivateHttpsEgressPolicy(['https://private-b.example']);
    const empty = createWorkflowPrivateHttpsEgressPolicy();
    expect(Object.isFrozen(first.origins)).toBe(true);
    expect(first.allowsPrivateNetworksForOrigin('https://private-a.example')).toBe(true);
    expect(first.allowsPrivateNetworksForOrigin('https://private-b.example')).toBe(false);
    expect(second.allowsPrivateNetworksForOrigin('https://private-a.example')).toBe(false);
    expect(empty.allowsPrivateNetworksForOrigin('https://private-a.example')).toBe(false);
    expect(first.digest).not.toBe(second.digest);
  });

  it('rejects a malformed environment setting during worker configuration parsing', () => {
    expect(() => parseWorkerConfig({
      ...requiredEnv,
      WORKFLOW_PRIVATE_HTTPS_ORIGINS: 'http://not-https.example',
    })).toThrow(/WORKFLOW_PRIVATE_HTTPS_ORIGINS/);
  });

  it('passes configured origins to the worker start seam without logging the list', async () => {
    let startedConfig: { workflowPrivateHttpsOrigins?: readonly string[] } | undefined;
    const logs: unknown[] = [];
    const process = new DocumentCoreProcess({
      env: { ...requiredEnv, WORKFLOW_PRIVATE_HTTPS_ORIGINS: 'https://private.example.test' },
      startWorkerFn: async (config) => {
        startedConfig = config;
        return {
          workerInstanceId: 'worker-1', queueName: 'document-core', stopped: false,
          stop: async () => undefined,
        };
      },
      onExit: () => undefined,
      onLog: (_level, _message, meta) => logs.push(meta),
      registerSignalHandler: () => undefined,
    });
    await process.start();
    expect(startedConfig?.workflowPrivateHttpsOrigins).toEqual(['https://private.example.test']);
    expect(JSON.stringify(logs)).not.toContain('private.example.test');
    expect(JSON.stringify(logs)).toContain('workflowPrivateHttpsPolicyDigest');
  });
});

describe('ORV14 tenant prompt precedence and category selection', () => {
  it('uses Code, Profile exact, Profile default, tenant defaults, then the existing callsite', () => {
    const base = {
      connectorBindings: { reasoning: 'connector-a@7' },
      profilePolicy: {} as never,
      promptOverrides: [
        { connectionId: 'connector-a', stepId: STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE, promptOverride: 'profile exact', revision: '4' },
        { connectionId: 'connector-a', stepId: '_default', promptOverride: 'profile default', revision: '4' },
      ],
      tenantDefaults: tenantDefaults({ pdf: 'tenant {input_content}' }),
    };
    const input = {
      slot: 'reasoning',
      stepId: STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE,
      defaultText: 'assembled callsite',
      tenantPromptCategory: 'pdf',
      tenantPromptVariables: { input_content: 'evidence text' },
    } as const;
    expect(applyPinnedStepPrompt(base, { ...input, codePrompt: ' code prompt ' })).toBe('code prompt');
    expect(applyPinnedStepPrompt(base, input)).toBe('profile exact');
    expect(applyPinnedStepPrompt(base, { ...input, stepId: 'another-step' })).toBe('profile default');
    expect(applyPinnedStepPrompt({ ...base, promptOverrides: [] }, { ...input, stepId: 'another-step' }))
      .toBe('tenant evidence text');
    expect(applyPinnedStepPrompt({ ...base, promptOverrides: [], tenantDefaults: null }, input))
      .toBe('assembled callsite');
  });

  it('classifies only registered steps and homogeneous content-derived formats', () => {
    expect(resolveTenantPromptCategory('ingest', STEP_KEYS.INGEST.EXECUTE_OCR, ['png'])).toBe('image');
    expect(resolveTenantPromptCategory('extract', STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE, ['pdf'])).toBe('pdf');
    expect(resolveTenantPromptCategory('transform', STEP_KEYS.TRANSFORM.EXECUTE_TRANSLATE, ['docx'])).toBe('docx');
    expect(resolveTenantPromptCategory('compare', STEP_KEYS.COMPARE.EXECUTE_SEMANTIC, [])).toBe('compare');
    expect(resolveTenantPromptCategory('generate', STEP_KEYS.GENERATE.CONNECTOR_INFERENCE, [])).toBe('generate');
    expect(resolveTenantPromptCategory('extract', 'browser-selected-category', ['pdf'])).toBeNull();
    expect(resolveTenantPromptCategory('extract', STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE, ['pdf', 'png'])).toBeNull();
    expect(resolveTenantPromptCategory('extract', STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE, ['txt'])).toBeNull();
  });

  it('applies all five admitted templates at the SDK connector adapter with their variables', async () => {
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const pdf = Buffer.from('%PDF-1.7\nsource', 'utf8');
    const docx = makeZipEntry('word/document.xml', Buffer.from('<w:document/>', 'utf8'));
    const cases: Array<{
      action: string;
      stepId: string;
      category: TenantPromptCategory;
      template: string;
      input: Record<string, unknown>;
      payload: Record<string, unknown>;
      buffer?: Buffer;
      expected: string;
    }> = [
      {
        action: 'ingest', stepId: STEP_KEYS.INGEST.EXECUTE_OCR, category: 'image',
        template: 'image instructions for {language}', input: { artifactIds: [ARTIFACT_ID] }, payload: { language: 'vi' },
        buffer: png, expected: 'image instructions for vi',
      },
      {
        action: 'extract', stepId: STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE, category: 'pdf',
        template: 'pdf {input_content}', input: { artifactIds: [ARTIFACT_ID] }, payload: { documentSnippet: 'invoice facts', promptCategory: 'generate' },
        buffer: pdf, expected: 'pdf invoice facts',
      },
      {
        action: 'transform', stepId: STEP_KEYS.TRANSFORM.EXECUTE_TRANSLATE, category: 'docx',
        template: 'word {input_content}', input: { artifactIds: [ARTIFACT_ID] }, payload: { documentSnippet: 'Word source' },
        buffer: docx, expected: 'word Word source',
      },
      {
        action: 'compare', stepId: STEP_KEYS.COMPARE.EXECUTE_SEMANTIC, category: 'compare',
        template: 'compare {file1} <> {file2}', input: {}, payload: { sourceSnippet: 'old wording', targetSnippet: 'new wording' },
        expected: 'compare old wording <> new wording',
      },
      {
        action: 'generate', stepId: STEP_KEYS.GENERATE.CONNECTOR_INFERENCE, category: 'generate',
        template: 'request {user_prompt}; source {input_content}', input: {},
        payload: { task: 'report', tone: 'formal', documentSnippet: 'source facts' },
        expected: 'request task: report\ntone: formal; source source facts',
      },
    ];

    for (const testCase of cases) {
      let capturedInput: unknown;
      let capturedOptions: unknown;
      const response: InvocationResponse = {
        invocationId: 'invocation-1',
        state: 'SUCCEEDED',
        result: { content: 'provider response', data: { ok: true } },
      };
      const sdkContext = {
        taskId: 'task-1', operationId: 'operation-1', taskKey: 'task-1', tenantId: TENANT_ID,
        businessId: 'document-core', businessVersion: '1.1.0', action: testCase.action, input: testCase.input,
        tenantDefaults: tenantDefaults({ [testCase.category]: testCase.template }),
        profilePolicy: null,
        connectorBindings: { vision: 'connector-a@7', reasoning: 'connector-a@7' },
        artifacts: {
          read: async () => testCase.buffer ?? Buffer.alloc(0),
          readWithMetadata: async () => ({ buffer: testCase.buffer ?? Buffer.alloc(0), filename: 'source', mimeType: 'application/octet-stream', sizeBytes: testCase.buffer?.byteLength ?? 0, sha256: 'unused' }),
          write: async () => ({ artifactId: ARTIFACT_ID, fileName: 'unused.json' }),
        },
        connector: {
          invoke: async (_slot: unknown, input: unknown, options: unknown) => {
            capturedInput = input;
            capturedOptions = options;
            return response;
          },
        },
      } as unknown as SdkTaskContext;

      const internal = toInternalContext(sdkContext, testCase.action);
      await internal.connector.invoke(
        testCase.action === 'ingest' ? 'vision' : 'reasoning',
        { task: 'worker-step', payload: testCase.payload },
        { promptStepId: testCase.stepId },
      );
      const wire = capturedInput as { prompt?: string };
      expect(wire.prompt).toBe(testCase.expected);
      expect(capturedOptions).toBeUndefined();
      expect(Object.hasOwn(wire, 'promptCategory')).toBe(false);
    }
  });

  it('keeps legacy callsite text when the admitted defaults snapshot is missing', async () => {
    let capturedInput: unknown;
    const sdkContext = {
      taskId: 'task-1', operationId: 'operation-1', taskKey: 'task-1', tenantId: TENANT_ID,
      businessId: 'document-core', businessVersion: '1.1.0', action: 'generate', input: {},
      profilePolicy: null,
      connectorBindings: { reasoning: 'connector-a@7' },
      artifacts: { read: async () => Buffer.alloc(0), write: async () => ({ artifactId: ARTIFACT_ID, fileName: 'unused.json' }) },
      connector: {
        invoke: async (_slot: unknown, input: unknown) => {
          capturedInput = input;
          return { invocationId: 'invocation-1', state: 'SUCCEEDED', result: { content: 'ok' } };
        },
      },
    } as unknown as SdkTaskContext;
    const internal = toInternalContext(sdkContext, 'generate');
    await internal.connector.invoke('reasoning', { task: 'generate_summary', payload: { task: 'summary' } }, {
      promptStepId: STEP_KEYS.GENERATE.CONNECTOR_INFERENCE,
    });
    expect((capturedInput as { prompt: string }).prompt).toBe('generate_summary: {"task":"summary"}');
  });

  it('does not infer a PDF tenant category from caller-supplied filename or MIME', async () => {
    let capturedInput: unknown;
    const sdkContext = {
      taskId: 'task-1', operationId: 'operation-1', taskKey: 'task-1', tenantId: TENANT_ID,
      businessId: 'document-core', businessVersion: '1.1.0', action: 'extract',
      input: { artifactIds: [ARTIFACT_ID] },
      tenantDefaults: tenantDefaults({ pdf: 'tenant PDF instructions' }),
      profilePolicy: null,
      connectorBindings: { reasoning: 'connector-a@7' },
      artifacts: {
        read: async () => Buffer.from('plain invoice text', 'utf8'),
        readWithMetadata: async () => ({
          buffer: Buffer.from('plain invoice text', 'utf8'),
          filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 18, sha256: 'unused',
        }),
        write: async () => ({ artifactId: ARTIFACT_ID, fileName: 'unused.json' }),
      },
      connector: {
        invoke: async (_slot: unknown, input: unknown) => {
          capturedInput = input;
          return { invocationId: 'invocation-1', state: 'SUCCEEDED', result: { content: 'ok' } };
        },
      },
    } as unknown as SdkTaskContext;
    const internal = toInternalContext(sdkContext, 'extract');
    const payload = { documentSnippet: 'plain invoice text' };
    await internal.connector.invoke('reasoning', { task: 'extract_invoice', payload }, {
      promptStepId: STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE,
    });
    expect((capturedInput as { prompt: string }).prompt).toBe(`extract_invoice: ${JSON.stringify(payload)}`);
  });

  it('fails closed before any provider call if the pinned defaults digest is forged', () => {
    const sdkContext = {
      taskId: 'task-1', operationId: 'operation-1', taskKey: 'task-1', tenantId: TENANT_ID,
      businessId: 'document-core', businessVersion: '1.1.0', input: {},
      tenantDefaults: { ...tenantDefaults({ pdf: 'forged' }), settingsDigest: `sha256:${'0'.repeat(64)}` },
      artifacts: { read: async () => Buffer.alloc(0), write: async () => ({ artifactId: ARTIFACT_ID, fileName: 'unused.json' }) },
      connector: { invoke: async () => ({ invocationId: 'unused', state: 'SUCCEEDED' }) },
    } as unknown as SdkTaskContext;
    expect(() => toInternalContext(sdkContext, 'extract')).toThrow(/tenant defaults digest/i);
  });

  it('forwards a detached, deeply frozen admitted snapshot into the local task context', () => {
    const source = tenantDefaults({ pdf: 'snapshot prompt' });
    const sdkContext = {
      taskId: 'task-1', operationId: 'operation-1', taskKey: 'task-1', tenantId: TENANT_ID,
      businessId: 'document-core', businessVersion: '1.1.0', input: {},
      tenantDefaults: source,
      artifacts: { read: async () => Buffer.alloc(0), write: async () => ({ artifactId: ARTIFACT_ID, fileName: 'unused.json' }) },
      connector: { invoke: async () => ({ invocationId: 'unused', state: 'SUCCEEDED' }) },
    } as unknown as SdkTaskContext;
    const internal = toInternalContext(sdkContext, 'extract');
    expect(internal.tenantDefaults?.prompts.pdf).toBe('snapshot prompt');
    expect(Object.isFrozen(internal.tenantDefaults)).toBe(true);
    expect(Object.isFrozen(internal.tenantDefaults?.prompts)).toBe(true);
    expect(internal.tenantDefaults).not.toBe(source);
  });
});
