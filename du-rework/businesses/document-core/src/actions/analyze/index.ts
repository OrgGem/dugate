import { AnalyzeInput } from '../../types/actions';
import { TaskContext } from '../../types/context';
import { ResultEnvelope, ProfileSnapshot, BusinessExecutionError, ValidationError } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import { defaultParserFactory } from '@du/document-kit';

export class AnalyzeAction {
  public static validateInput(raw: unknown): AnalyzeInput {
    const input = InputNormalizer.normalizeAnalyze(raw as Record<string, unknown>);

    if (input.task === 'classify') {
      if (!input.categories || (Array.isArray(input.categories) && input.categories.length === 0)) {
        throw new ValidationError(
          'Analyze task "classify" requires non-empty "categories" parameter',
          'MISSING_REQUIRED_PARAMETER'
        );
      }
    } else if (input.task === 'compliance') {
      if (!input.criteria || (Array.isArray(input.criteria) && input.criteria.length === 0)) {
        throw new ValidationError(
          'Analyze task "compliance" requires non-empty "criteria" parameter',
          'MISSING_REQUIRED_PARAMETER'
        );
      }
    }

    return input;
  }

  public static selectRecipe(input: AnalyzeInput, _profile?: ProfileSnapshot): RecipeDefinition {
    return RecipeRegistry.getRecipe('analyze', input.task);
  }

  public static async prepareSources(
    ctx: TaskContext,
    input: AnalyzeInput
  ): Promise<{ text: string; sourceArtifactIds: string[] }> {
    const sourceArtifactIds: string[] = [];
    let text = input.text || '';

    if (input.artifactIds && input.artifactIds.length > 0) {
      for (const id of input.artifactIds) {
        sourceArtifactIds.push(id);
        const buf = await ctx.artifacts.read(id);
        const parsed = await defaultParserFactory.parseBuffer(buf, `doc_${id}`);
        text += (text ? '\n\n' : '') + parsed.text;
      }
    }

    if (!text.trim()) {
      throw new BusinessExecutionError(
        'Analyze action requires either non-empty inline "text" or readable document artifacts',
        'MISSING_DOCUMENT_SOURCE'
      );
    }

    return { text, sourceArtifactIds };
  }

  public static async executeRecipe(
    ctx: TaskContext,
    recipe: RecipeDefinition,
    input: AnalyzeInput,
    sources: { text: string; sourceArtifactIds: string[] }
  ): Promise<unknown> {
    if (sources.text.length > 50000) {
      throw new BusinessExecutionError(
        `Document length (${sources.text.length} chars) exceeds maximum supported size for analysis (50000 characters).`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    // Step 1: build-prompt
    const promptPayload = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.ANALYZE.BUILD_PROMPT,
      { task: input.task, textLength: sources.text.length },
      async () => {
        return {
          task: input.task,
          categories: input.categories,
          criteria: input.criteria,
          referenceData: input.referenceData,
          documentSnippet: sources.text,
        };
      }
    );

    // Step 2: connector-inference
    const inferenceResult = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.ANALYZE.CONNECTOR_INFERENCE,
      { promptHash: StepCheckpointManager.computeInputHash(promptPayload) },
      async () => {
        const invocation = await ctx.connector.invoke('reasoning', {
          task: `analyze_${input.task}`,
          payload: promptPayload,
          responseFormat: 'json',
        });

        if (invocation.status !== 'SUCCESS') {
          throw new BusinessExecutionError(
            `Analysis inference failed: ${invocation.error?.message || 'Unknown error'}`,
            'PROVIDER_ERROR',
            invocation.error?.retryable ?? false
          );
        }

        let parsedData = invocation.data;
        if (!parsedData && invocation.rawText) {
          try {
            const cleanText = invocation.rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            parsedData = JSON.parse(cleanText);
          } catch {
            throw new BusinessExecutionError(
              'Provider returned malformed JSON response for analysis',
              'PROVIDER_INVALID_RESPONSE'
            );
          }
        }

        return parsedData;
      }
    );

    // Step 3: validate-findings
    const validatedResult = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.ANALYZE.VALIDATE_FINDINGS,
      { outputHash: StepCheckpointManager.computeInputHash(inferenceResult) },
      async () => {
        this.validateAnalysisFindings(input.task, inferenceResult);
        return inferenceResult;
      }
    );

    return validatedResult;
  }

  public static validateAnalysisFindings(task: string, data: unknown): void {
    if (!data || typeof data !== 'object') {
      throw new BusinessExecutionError('Analysis findings must be an object', 'SCHEMA_VALIDATION_ERROR');
    }

    const obj = data as Record<string, unknown>;

    if (task === 'classify') {
      if (typeof obj.category !== 'string' || typeof obj.confidence !== 'number') {
        throw new BusinessExecutionError(
          'Classification result must have "category" and numeric "confidence"',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    } else if (task === 'sentiment') {
      if (!['positive', 'negative', 'neutral', 'mixed'].includes(obj.sentiment as string)) {
        throw new BusinessExecutionError(
          'Sentiment result must have valid "sentiment" enum value',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    } else if (task === 'compliance') {
      if (!['PASS', 'FAIL'].includes(obj.status as string)) {
        throw new BusinessExecutionError(
          'Compliance result must have "status" of "PASS" or "FAIL"',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    }
  }

  public static validateResult(data: unknown, task?: string): unknown {
    if (!data || typeof data !== 'object') {
      throw new BusinessExecutionError('Analysis findings must be an object', 'SCHEMA_VALIDATION_ERROR');
    }
    if (task) {
      this.validateAnalysisFindings(task, data);
      OutputValidator.validateProviderOutput('analyze', task, data);
    }
    return data;
  }

  public static formatResult(
    _ctx: TaskContext,
    resultData: unknown,
    _format: string = 'json'
  ): ResultEnvelope<unknown> {
    return {
      status: 'COMPLETED',
      data: resultData,
      provenance: {
        method: 'llm_evaluation',
        modelSlot: 'reasoning',
      },
      warnings: [],
    };
  }
}
