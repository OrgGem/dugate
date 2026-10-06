import { AnalyzeInput } from '../../types/actions';
import { TaskContext } from '../../types/context';
import { ResultEnvelope, ProfileSnapshot, BusinessExecutionError, ValidationError } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import { ParserBudgetHelper } from '../../pipelines/parser-budget';
import { invokeWithStepSession } from '../session-seam';

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

    const task = (input as unknown as { task: string }).task;
    const extendedInput = input as unknown as {
      extractFields?: string[];
    };

    // Step 1: build-prompt
    const promptCheckpointInput =
      task === 'fact-check' || task === 'summarize-eval'
        ? {
            task,
            documentText: sources.text,
            categories: input.categories,
            criteria: input.criteria,
            extractFields: extendedInput.extractFields,
          }
        : { task: input.task, textLength: sources.text.length };
    const promptPayload = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.ANALYZE.BUILD_PROMPT,
      promptCheckpointInput,
      async () => {
        if (task === 'fact-check') {
          return {
            task,
            extractFields: extendedInput.extractFields,
            documentSnippet: sources.text,
          };
        }
        if (task === 'summarize-eval') {
          return {
            task,
            summaryRequirements: 'Write a concise summary of 3 to 4 sentences.',
            evaluationRequirements:
              'Evaluate the author’s perspective and argument; provide an overallAssessment and the authorPerspective.',
            documentSnippet: sources.text,
          };
        }
        return {
          task: input.task,
          categories: input.categories,
          criteria: input.criteria,
          referenceData: input.referenceData,
          documentSnippet: sources.text,
        };
      }
    );

    // Step 2: connector inference. Fact-check extracts claims first, then
    // verifies only those claims against caller-supplied reference data.
    let inferenceResult: unknown;
    if (task === 'fact-check') {
      const extractedClaims = await StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.ANALYZE.FACT_CHECK_EXTRACT_CLAIMS,
        { promptHash: StepCheckpointManager.computeInputHash(promptPayload) },
        async () => {
          const invocation = await invokeWithStepSession(
            ctx,
            STEP_KEYS.ANALYZE.FACT_CHECK_EXTRACT_CLAIMS,
            (sessionRef) =>
              ctx.connector.invoke(
                'reasoning',
                {
                  task: 'analyze_fact_check_extract_claims',
                  payload: promptPayload,
                  responseFormat: 'json',
                },
                {
                  promptStepId: STEP_KEYS.ANALYZE.FACT_CHECK_EXTRACT_CLAIMS,
                  ...(sessionRef !== null ? { sessionRef } : {}),
                }
              )
          );
          return this.parseProviderObject(invocation, 'Fact-check claim extraction');
        }
      );
      const verificationPayload = {
        task: 'fact-check',
        extractedClaims,
        referenceData: input.referenceData,
      };
      inferenceResult = await StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.ANALYZE.FACT_CHECK_VERIFY_CLAIMS,
        { verificationPayload },
        async () => {
          const invocation = await invokeWithStepSession(
            ctx,
            STEP_KEYS.ANALYZE.FACT_CHECK_VERIFY_CLAIMS,
            (sessionRef) =>
              ctx.connector.invoke(
                'reasoning',
                {
                  task: 'analyze_fact_check_verify_claims',
                  payload: verificationPayload,
                  responseFormat: 'json',
                },
                {
                  promptStepId: STEP_KEYS.ANALYZE.FACT_CHECK_VERIFY_CLAIMS,
                  ...(sessionRef !== null ? { sessionRef } : {}),
                }
              )
          );
          return this.parseProviderObject(invocation, 'Fact-check verification');
        }
      );
    } else {
      const stepKey =
        task === 'summarize-eval'
          ? STEP_KEYS.ANALYZE.SUMMARIZE_EVAL_INFERENCE
          : STEP_KEYS.ANALYZE.CONNECTOR_INFERENCE;
      inferenceResult = await StepCheckpointManager.executeWithCheckpoint(
        ctx,
        stepKey,
        { promptHash: StepCheckpointManager.computeInputHash(promptPayload) },
        async () => {
          const invocation = await invokeWithStepSession(
            ctx,
            stepKey,
            (sessionRef) =>
              ctx.connector.invoke(
                'reasoning',
                {
                  task: `analyze_${task}`,
                  payload: promptPayload,
                  responseFormat: 'json',
                },
                {
                  promptStepId: stepKey,
                  ...(sessionRef !== null ? { sessionRef } : {}),
                }
              )
          );
          return this.parseProviderObject(invocation, 'Analysis inference');
        }
      );
    }

    // Step 3: validate-findings
    const validatedResult = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.ANALYZE.VALIDATE_FINDINGS,
      { outputHash: StepCheckpointManager.computeInputHash(inferenceResult) },
      async () => {
        this.validateAnalysisFindings(task, inferenceResult);
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
    } else if (task === 'fact-check') {
      if (!['PASS', 'FAIL', 'WARNING'].includes(obj.verdict as string)) {
        throw new BusinessExecutionError('Fact-check result must have a valid verdict', 'SCHEMA_VALIDATION_ERROR');
      }
      if (typeof obj.summary !== 'string' || !obj.summary.trim() || !Array.isArray(obj.checks)) {
        throw new BusinessExecutionError(
          'Fact-check result must include a summary and checks array',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
      if (
        obj.checks.some(
          (check) =>
            !check ||
            typeof check !== 'object' ||
            !['PASS', 'FAIL', 'WARNING'].includes((check as Record<string, unknown>).status as string)
        )
      ) {
        throw new BusinessExecutionError(
          'Fact-check items must have a valid status',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    } else if (task === 'summarize-eval') {
      const evaluation = obj.evaluation;
      const evaluationFields =
        evaluation && typeof evaluation === 'object' && !Array.isArray(evaluation)
          ? (evaluation as Record<string, unknown>)
          : undefined;
      if (
        typeof obj.summary !== 'string' ||
        !obj.summary.trim() ||
        typeof evaluationFields?.overallAssessment !== 'string' ||
        !evaluationFields.overallAssessment.trim() ||
        typeof evaluationFields.authorPerspective !== 'string' ||
        !evaluationFields.authorPerspective.trim()
      ) {
        throw new BusinessExecutionError(
          'Summarize-eval result must include a summary and evaluation with overallAssessment and authorPerspective',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    }
  }

  private static parseProviderObject(
    invocation: Awaited<ReturnType<TaskContext['connector']['invoke']>>,
    operation: string
  ): Record<string, unknown> {
    if (invocation.status !== 'SUCCESS') {
      throw new BusinessExecutionError(
        `${operation} failed: ${invocation.error?.message || 'Unknown provider error'}`,
        invocation.error?.code || 'PROVIDER_ERROR',
        invocation.error?.retryable ?? false
      );
    }

    let parsedData = invocation.data;
    if ((parsedData === null || parsedData === undefined) && invocation.rawText) {
      try {
        const cleanText = invocation.rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        parsedData = JSON.parse(cleanText) as unknown;
      } catch {
        throw new BusinessExecutionError(
          `Provider returned malformed JSON response for ${operation.toLowerCase()}`,
          'PROVIDER_INVALID_RESPONSE'
        );
      }
    }

    if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
      throw new BusinessExecutionError(
        `Provider returned empty or non-object data for ${operation.toLowerCase()}`,
        'PROVIDER_INVALID_RESPONSE'
      );
    }
    const objectData = parsedData as Record<string, unknown>;
    if (Object.keys(objectData).length === 0) {
      throw new BusinessExecutionError(
        `Provider returned an empty object for ${operation.toLowerCase()}`,
        'EMPTY_PROVIDER_OUTPUT'
      );
    }
    return objectData;
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
