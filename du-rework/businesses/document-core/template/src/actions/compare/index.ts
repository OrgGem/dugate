import { CompareInput } from '../../types/actions';
import { TaskContext } from '../../types/context';
import { ResultEnvelope, ProfileSnapshot, BusinessExecutionError } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import { DiffEngine } from '@du/document-kit';
import { ParserBudgetHelper } from '../../pipelines/parser-budget';
import { invokeWithStepSession } from '../session-seam';

export class CompareAction {
  public static validateInput(raw: unknown): CompareInput {
    return InputNormalizer.normalizeCompare(raw as Record<string, unknown>);
  }

  public static selectRecipe(input: CompareInput, _profile?: ProfileSnapshot): RecipeDefinition {
    return RecipeRegistry.getRecipe('compare', input.mode);
  }

  public static async prepareSources(
    ctx: TaskContext,
    input: CompareInput
  ): Promise<{ sourceText: string; targetText: string }> {
    ParserBudgetHelper.assertActiveDeadline(ctx);
    let sourceText = input.source.text || '';
    if (input.source.artifactId) {
      ParserBudgetHelper.assertActiveDeadline(ctx);
      const artifact = await ParserBudgetHelper.readArtifact(ctx, input.source.artifactId);
      const parsed = await ParserBudgetHelper.safeParseArtifact(ctx, artifact, 'source_doc');
      sourceText = parsed.text;
    }

    ParserBudgetHelper.assertActiveDeadline(ctx);
    let targetText = input.target.text || '';
    if (input.target.artifactId) {
      ParserBudgetHelper.assertActiveDeadline(ctx);
      const artifact = await ParserBudgetHelper.readArtifact(ctx, input.target.artifactId);
      const parsed = await ParserBudgetHelper.safeParseArtifact(ctx, artifact, 'target_doc');
      targetText = parsed.text;
    }

    if (!sourceText.trim()) {
      throw new BusinessExecutionError('Source document has no readable text', 'EMPTY_DOCUMENT_SIDE');
    }
    if (!targetText.trim()) {
      throw new BusinessExecutionError('Target document has no readable text', 'EMPTY_DOCUMENT_SIDE');
    }

    return { sourceText, targetText };
  }

  public static async executeRecipe(
    ctx: TaskContext,
    recipe: RecipeDefinition,
    input: CompareInput,
    sources: { sourceText: string; targetText: string }
  ): Promise<unknown> {
    const mode = input.mode;

    const MAX_COMPARE_TEXT_LENGTH = 50000;
    if (
      sources.sourceText.length > MAX_COMPARE_TEXT_LENGTH ||
      sources.targetText.length > MAX_COMPARE_TEXT_LENGTH
    ) {
      throw new BusinessExecutionError(
        `Document length exceeds maximum supported size for comparison (${MAX_COMPARE_TEXT_LENGTH} characters).`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    if (mode === 'diff') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.COMPARE.EXECUTE_DIFF,
        { sourceLen: sources.sourceText.length, targetLen: sources.targetText.length },
        async () => {
          const diffResult = DiffEngine.computeDiff(sources.sourceText, sources.targetText);
          return {
            diffStats: {
              additions: diffResult.additionsCount,
              deletions: diffResult.deletionsCount,
              unmodified: diffResult.unmodifiedCount,
            },
            hunks: diffResult.hunks,
            unifiedDiff: diffResult.unifiedDiff,
            method: 'native_diff',
          };
        }
      );
    } else if (mode === 'semantic') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.COMPARE.EXECUTE_SEMANTIC,
        { focus: input.focus },
        async () => {
          const invocation = await invokeWithStepSession(
            ctx,
            STEP_KEYS.COMPARE.EXECUTE_SEMANTIC,
            (sessionRef) =>
              ctx.connector.invoke(
                'reasoning',
                {
                  task: 'compare_semantic',
                  payload: {
                    sourceSnippet: sources.sourceText,
                    targetSnippet: sources.targetText,
                    focus: input.focus,
                  },
                  responseFormat: 'json',
                },
                {
                  promptStepId: STEP_KEYS.COMPARE.EXECUTE_SEMANTIC,
                  ...(sessionRef !== null ? { sessionRef } : {}),
                }
              )
          );

          if (invocation.status !== 'SUCCESS') {
            throw new BusinessExecutionError(
              `Semantic comparison failed: ${invocation.error?.message || 'Unknown error'}`,
              'PROVIDER_ERROR'
            );
          }

          let parsed = invocation.data;
          if (!parsed && invocation.rawText) {
            try {
              const cleanText = invocation.rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
              parsed = JSON.parse(cleanText);
            } catch {
              parsed = { summary: invocation.rawText };
            }
          }

          return parsed;
        }
      );
    } else if (mode === 'version') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.COMPARE.EXECUTE_VERSION,
        {},
        async () => {
          const invocation = await invokeWithStepSession(
            ctx,
            STEP_KEYS.COMPARE.EXECUTE_VERSION,
            (sessionRef) =>
              ctx.connector.invoke(
                'reasoning',
                {
                  task: 'compare_version',
                  payload: {
                    sourceSnippet: sources.sourceText,
                    targetSnippet: sources.targetText,
                  },
                  responseFormat: 'json',
                },
                {
                  promptStepId: STEP_KEYS.COMPARE.EXECUTE_VERSION,
                  ...(sessionRef !== null ? { sessionRef } : {}),
                }
              )
          );

          if (invocation.status !== 'SUCCESS') {
            throw new BusinessExecutionError(
              `Version comparison failed: ${invocation.error?.message || 'Unknown error'}`,
              'PROVIDER_ERROR'
            );
          }

          let parsed = invocation.data;
          if (!parsed && invocation.rawText) {
            try {
              const cleanText = invocation.rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
              parsed = JSON.parse(cleanText);
            } catch {
              parsed = { versionSummary: invocation.rawText };
            }
          }

          return parsed;
        }
      );
    }

    throw new Error(`Unsupported compare mode: ${mode}`);
  }

  public static validateResult(data: unknown, mode?: string): unknown {
    if (!data || typeof data !== 'object') {
      throw new BusinessExecutionError('Comparison result must be a non-null object', 'SCHEMA_VALIDATION_ERROR');
    }
    if (mode) {
      OutputValidator.validateProviderOutput('compare', mode, data);
    }
    return data;
  }

  public static formatResult(
    _ctx: TaskContext,
    resultData: unknown,
    _format: string = 'json'
  ): ResultEnvelope<unknown> {
    const isDiff = Boolean(
      resultData &&
        typeof resultData === 'object' &&
        (resultData as Record<string, unknown>).method === 'native_diff'
    );

    return {
      status: 'COMPLETED',
      data: resultData,
      provenance: {
        method: isDiff ? 'diff' : 'llm_evaluation',
        modelSlot: isDiff ? undefined : 'reasoning',
      },
      warnings: [],
    };
  }
}
