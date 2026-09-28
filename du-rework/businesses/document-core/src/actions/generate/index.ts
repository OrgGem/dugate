import { GenerateInput } from '../../types/actions';
import { TaskContext } from '../../types/context';
import { ResultEnvelope, ProfileSnapshot, BusinessExecutionError, ValidationError } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import { ParserBudgetHelper } from '../../pipelines/parser-budget';

export class GenerateAction {
  public static validateInput(raw: unknown): GenerateInput {
    const input = InputNormalizer.normalizeGenerate(raw as Record<string, unknown>);

    if (input.task === 'qa') {
      if (!input.questions || (Array.isArray(input.questions) && input.questions.length === 0)) {
        throw new ValidationError(
          'Generate task "qa" requires non-empty "questions" parameter',
          'MISSING_REQUIRED_PARAMETER'
        );
      }
      if (Array.isArray(input.questions) && input.questions.length > 20) {
        throw new ValidationError(
          'Questions list exceeds maximum allowed cap (20 questions)',
          'LIMIT_EXCEEDED'
        );
      }
    }

    return input;
  }

  public static selectRecipe(input: GenerateInput, _profile?: ProfileSnapshot): RecipeDefinition {
    return RecipeRegistry.getRecipe('generate', input.task);
  }

  public static async prepareSources(
    ctx: TaskContext,
    input: GenerateInput
  ): Promise<{ text: string; sourceArtifactIds: string[] }> {
    ParserBudgetHelper.assertActiveDeadline(ctx);
    const sourceArtifactIds: string[] = [];
    let text = input.text || '';

    if (input.artifactIds && input.artifactIds.length > 0) {
      for (const id of input.artifactIds) {
        ParserBudgetHelper.assertActiveDeadline(ctx);
        sourceArtifactIds.push(id);
        const artifact = await ParserBudgetHelper.readArtifact(ctx, id);
        const parsed = await ParserBudgetHelper.safeParseArtifact(ctx, artifact, `doc_${id}`);
        text += (text ? '\n\n' : '') + parsed.text;
      }
    }

    if (!text.trim()) {
      throw new BusinessExecutionError(
        'Generate action requires either non-empty inline "text" or readable document artifacts',
        'MISSING_DOCUMENT_SOURCE'
      );
    }

    return { text, sourceArtifactIds };
  }

  public static async executeRecipe(
    ctx: TaskContext,
    recipe: RecipeDefinition,
    input: GenerateInput,
    sources: { text: string; sourceArtifactIds: string[] }
  ): Promise<unknown> {
    if (sources.text.length > 50000) {
      throw new BusinessExecutionError(
        `Document length (${sources.text.length} chars) exceeds maximum supported size for generation (50000 characters).`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    // Step 1: build-prompt
    const promptPayload = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.GENERATE.BUILD_PROMPT,
      { task: input.task, format: input.format, maxWords: input.maxWords },
      async () => {
        return {
          task: input.task,
          format: input.format || 'paragraph',
          maxWords: input.maxWords,
          tone: input.tone,
          audience: input.audience,
          questions: input.questions,
          documentSnippet: sources.text,
        };
      }
    );

    // Step 2: connector-inference
    const inferenceResult = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.GENERATE.CONNECTOR_INFERENCE,
      { promptHash: StepCheckpointManager.computeInputHash(promptPayload) },
      async () => {
        const invocation = await ctx.connector.invoke('reasoning', {
          task: `generate_${input.task}`,
          payload: promptPayload,
          responseFormat: input.task === 'qa' || input.task === 'minutes' ? 'json' : 'text',
        });

        if (invocation.status !== 'SUCCESS') {
          throw new BusinessExecutionError(
            `Generation failed: ${invocation.error?.message || 'Unknown error'}`,
            'PROVIDER_ERROR',
            invocation.error?.retryable ?? false
          );
        }

        let resultData = invocation.data;
        if (typeof resultData === 'string') {
          resultData = { content: resultData };
        } else if (!resultData && invocation.rawText) {
          if (input.task === 'qa' || input.task === 'minutes') {
            try {
              const cleanText = invocation.rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
              resultData = JSON.parse(cleanText);
            } catch {
              resultData = { text: invocation.rawText };
            }
          } else {
            resultData = { content: invocation.rawText };
          }
        }

        return resultData;
      }
    );

    return inferenceResult;
  }

  public static validateResult(data: unknown, task?: string): unknown {
    if (!data || typeof data !== 'object') {
      throw new BusinessExecutionError('Generated content must be a non-null object', 'SCHEMA_VALIDATION_ERROR');
    }
    if (task) {
      OutputValidator.validateProviderOutput('generate', task, data);
    }
    return data;
  }

  public static formatResult(
    _ctx: TaskContext,
    resultData: unknown,
    _format: string = 'json',
    task?: string
  ): ResultEnvelope<unknown> {
    const isQa =
      task === 'qa' ||
      Boolean(
        resultData &&
          typeof resultData === 'object' &&
          'answers' in (resultData as Record<string, unknown>)
      );

    return {
      status: 'COMPLETED',
      data: resultData,
      provenance: {
        method: isQa ? 'grounded_qa' : 'llm_evaluation',
        modelSlot: 'reasoning',
      },
      warnings: [],
    };
  }
}
