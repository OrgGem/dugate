import {
  defineBusiness,
  startWorker,
  TaskHandler,
  TaskContext as SdkTaskContext,
  BusinessDefinition,
  WorkerConfig,
  WorkerHandle,
  QueueConsumer,
} from '@du/worker-sdk';
import { TaskDisposition } from '@du/contracts';
import { documentCoreManifest } from './manifest/document-core.manifest';
import { TaskContext, StepCheckpointRecord } from './types/context';
import { IngestAction } from './actions/ingest';
import { ExtractAction } from './actions/extract';
import { AnalyzeAction } from './actions/analyze';
import { TransformAction } from './actions/transform';
import { GenerateAction } from './actions/generate';
import { CompareAction } from './actions/compare';

export type { TaskDisposition, TaskHandler, BusinessDefinition, WorkerConfig, WorkerHandle, QueueConsumer };
export type BusinessTaskHandler = TaskHandler;

import { LeaseLostError } from '@du/worker-sdk';
import { BusinessExecutionError } from './types/results';

/**
 * Adapter ensuring compatibility whether the handler is invoked by the SDK
 * runtime (DefaultTaskContext) or directly with a TaskContext in tests.
 * Enforces cancellation/lease-loss fencing at every side-effect boundary.
 */
function assertActive(ctx: SdkTaskContext | TaskContext): void {
  if (ctx.signal?.aborted) {
    if (ctx.signal.reason === 'cancel' || (ctx as any).cancelRequested) {
      throw new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false);
    }
    throw new LeaseLostError(ctx.taskId);
  }
}

function toInternalContext(ctx: SdkTaskContext | TaskContext): TaskContext {
  const isInternal = typeof (ctx as any).step === 'function';
  const rawCtx = ctx as any;

  return {
    taskId: rawCtx.taskId,
    operationId: rawCtx.operationId,
    businessId: rawCtx.businessId,
    businessVersion: rawCtx.businessVersion,
    tenantId: rawCtx.tenantId,
    signal: rawCtx.signal,
    artifacts: {
      read: (id) => {
        assertActive(ctx);
        return rawCtx.artifacts.read(id);
      },
      write: (content, fileName, mimeType) => {
        assertActive(ctx);
        return rawCtx.artifacts.write(content, fileName, mimeType);
      },
    },
    connector: {
      invoke: async (slot, promptOrPayload, options?: any) => {
        assertActive(ctx);
        if (isInternal) {
          return rawCtx.connector.invoke(slot, promptOrPayload, options);
        }
        let input: { prompt?: string; text?: string; artifacts?: { artifactId: string }[]; outputSchema?: Record<string, unknown> };
        if (typeof promptOrPayload === 'string') {
          input = { prompt: promptOrPayload };
        } else {
          const obj = promptOrPayload as Record<string, unknown>;
          input = {
            prompt: typeof obj.prompt === 'string'
              ? obj.prompt
              : (typeof obj.task === 'string' ? `${obj.task}: ${JSON.stringify(obj.payload ?? '')}` : JSON.stringify(obj)),
            text: typeof obj.text === 'string' ? obj.text : undefined,
            outputSchema: (obj.outputSchema || obj.jsonSchema) && typeof (obj.outputSchema || obj.jsonSchema) === 'object'
              ? (obj.outputSchema || obj.jsonSchema) as Record<string, unknown>
              : undefined,
            artifacts: Array.isArray(obj.artifacts) ? (obj.artifacts as any) : undefined,
          };
        }
        const res = await (ctx as SdkTaskContext).connector.invoke(slot, input, options as Record<string, unknown> | undefined);
        const status: 'SUCCESS' | 'ERROR' = res.state === 'SUCCEEDED' ? 'SUCCESS' : 'ERROR';
        const data = res.result?.data;
        const rawText = res.result?.content;
        const usage = res.usage
          ? {
              promptTokens: res.usage.inputTokens,
              completionTokens: res.usage.outputTokens,
              totalTokens: res.usage.inputTokens + res.usage.outputTokens,
            }
          : undefined;
        const error = res.error
          ? {
              code: res.error.code,
              message: res.error.message,
              retryable: res.error.retryable,
            }
          : undefined;
        return {
          invocationId: res.invocationId,
          status,
          data,
          rawText,
          usage,
          error,
        };
      },
    },
    step: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
      assertActive(ctx);
      if (isInternal) {
        return rawCtx.step(stepKey, inputHash, fn);
      }
      return (ctx as SdkTaskContext).step.run(stepKey, inputHash, fn);
    },
    getCheckpoint: async (stepKey: string): Promise<StepCheckpointRecord | null> => {
      assertActive(ctx);
      if (isInternal) {
        return rawCtx.getCheckpoint(stepKey);
      }
      const peeked = await (ctx as SdkTaskContext).step.peek(stepKey);
      if (!peeked) return null;
      return {
        stepKey: peeked.stepKey,
        inputHash: peeked.inputHash,
        output: null,
        savedAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * Dual task handler type: can be invoked with just (ctx: SdkTaskContext) by the SDK runner,
 * or with (ctx, payload) by direct test callers.
 */
export type DualTaskHandler = (
  ctx: SdkTaskContext | TaskContext,
  payload?: Record<string, unknown>
) => Promise<TaskDisposition>;

/**
 * Handlers dictionary for all handler kinds declared in documentCoreManifest.
 * Manifest handlerKinds: ['root', 'ingest', 'extract', 'analyze', 'transform', 'generate', 'compare']
 */
export const documentCoreHandlers: Record<string, DualTaskHandler> = {
  // Root: entrypoint dispatcher delegating to the appropriate action handler based on ctx.action
  root: async (ctx, payload) => {
    const action = (ctx as SdkTaskContext).action || (payload as any)?.action;
    if (!action || action === 'root') {
      throw new Error(`Invalid or unspecified action for document-core root handler: "${action}"`);
    }
    const targetHandler = documentCoreHandlers[action];
    if (!targetHandler) {
      throw new Error(`No registered handler for action: "${action}"`);
    }
    return targetHandler(ctx, payload);
  },

  // 1. Ingest
  ingest: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = IngestAction.validateInput(inputPayload);
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(internalCtx, input);
    const result = await IngestAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = IngestAction.validateResult(result, input.mode);
    assertActive(ctx);
    const envelope = IngestAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await internalCtx.artifacts.write(
      JSON.stringify(envelope, null, 2),
      'ingest_result.json',
      'application/json'
    );

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 2. Extract
  extract: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = ExtractAction.validateInput(inputPayload);
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(internalCtx, input);
    const result = await ExtractAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = ExtractAction.validateResult(result, input.type, input.schema);
    assertActive(ctx);
    const envelope = ExtractAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await internalCtx.artifacts.write(
      JSON.stringify(envelope, null, 2),
      'extract_result.json',
      'application/json'
    );

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 3. Analyze
  analyze: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = AnalyzeAction.validateInput(inputPayload);
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(internalCtx, input);
    const result = await AnalyzeAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = AnalyzeAction.validateResult(result, input.task);
    assertActive(ctx);
    const envelope = AnalyzeAction.formatResult(internalCtx, validated);

    const artifact = await internalCtx.artifacts.write(
      JSON.stringify(envelope, null, 2),
      'analyze_result.json',
      'application/json'
    );

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 4. Transform
  transform: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = TransformAction.validateInput(inputPayload);
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(internalCtx, input);
    const result = await TransformAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = TransformAction.validateResult(result, input.variant);
    assertActive(ctx);
    const envelope = TransformAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await internalCtx.artifacts.write(
      JSON.stringify(envelope, null, 2),
      'transform_result.json',
      'application/json'
    );

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 5. Generate
  generate: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = GenerateAction.validateInput(inputPayload);
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(internalCtx, input);
    const result = await GenerateAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = GenerateAction.validateResult(result, input.task);
    assertActive(ctx);
    const envelope = GenerateAction.formatResult(internalCtx, validated);

    const artifact = await internalCtx.artifacts.write(
      JSON.stringify(envelope, null, 2),
      'generate_result.json',
      'application/json'
    );

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 6. Compare
  compare: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = CompareAction.validateInput(inputPayload);
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(internalCtx, input);
    const result = await CompareAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = CompareAction.validateResult(result, input.mode);
    assertActive(ctx);
    const envelope = CompareAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await internalCtx.artifacts.write(
      JSON.stringify(envelope, null, 2),
      'compare_result.json',
      'application/json'
    );

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },
};

/**
 * Validated BusinessDefinition created via worker-sdk defineBusiness().
 * Validates manifest schema and strictly cross-checks declared handler kinds (REG-04).
 */
export const documentCoreBusinessDefinition: BusinessDefinition = defineBusiness(
  documentCoreManifest,
  documentCoreHandlers as Record<string, TaskHandler>
);

export interface DocumentCoreWorkerConfig extends WorkerConfig {
  consumer?: QueueConsumer;
}

/**
 * Owned worker entrypoint starting the document-core worker.
 */
export async function startDocumentCoreWorker(
  config: DocumentCoreWorkerConfig
): Promise<WorkerHandle> {
  return startWorker(documentCoreBusinessDefinition, config);
}
