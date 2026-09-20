import { ExtractInput } from '../../types/actions';
import { TaskContext } from '../../types/context';
import { ResultEnvelope, ProfileSnapshot, BusinessExecutionError } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { SchemaValidator } from '../../validation/schema-validator';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import { defaultParserFactory } from '@du/document-kit';

export class ExtractAction {
  public static validateInput(raw: unknown): ExtractInput {
    const input = InputNormalizer.normalizeExtract(raw as Record<string, unknown>);
    if (input.type === 'custom' && input.schema) {
      SchemaValidator.validateCustomSchema(input.schema);
    }
    return input;
  }

  public static selectRecipe(input: ExtractInput, _profile?: ProfileSnapshot): RecipeDefinition {
    return RecipeRegistry.getRecipe('extract', input.type);
  }

  public static async prepareSources(
    ctx: TaskContext,
    input: ExtractInput
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
        'Extract action requires either non-empty inline "text" or readable document artifacts',
        'MISSING_DOCUMENT_SOURCE'
      );
    }

    return { text, sourceArtifactIds };
  }

  public static async executeRecipe(
    ctx: TaskContext,
    recipe: RecipeDefinition,
    input: ExtractInput,
    sources: { text: string; sourceArtifactIds: string[] }
  ): Promise<unknown> {
    if (sources.text.length > 50000) {
      throw new BusinessExecutionError(
        `Document length (${sources.text.length} chars) exceeds maximum supported size for extraction (50000 characters).`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    // Step 1: build-prompt
    const promptPayload = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.EXTRACT.BUILD_PROMPT,
      { type: input.type, textLength: sources.text.length, fields: input.fields },
      async () => {
        return {
          type: input.type,
          promptText: `Extract ${input.type} information from document.`,
          documentSnippet: sources.text,
          schema: input.schema,
        };
      }
    );

    // Step 2: connector-inference
    const inferenceResult = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE,
      { promptHash: StepCheckpointManager.computeInputHash(promptPayload) },
      async () => {
        const invocation = await ctx.connector.invoke('reasoning', {
          task: `extract_${input.type}`,
          payload: promptPayload,
          responseFormat: 'json',
          jsonSchema: input.schema,
        });

        if (invocation.status !== 'SUCCESS') {
          throw new BusinessExecutionError(
            `Extraction inference failed: ${invocation.error?.message || 'Unknown provider error'}`,
            'PROVIDER_ERROR',
            invocation.error?.retryable ?? false
          );
        }

        let parsedData = invocation.data;
        if (!parsedData && invocation.rawText) {
          try {
            // Clean optional markdown code blocks wrapping JSON
            const cleanText = invocation.rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            parsedData = JSON.parse(cleanText);
          } catch {
            throw new BusinessExecutionError(
              'Provider returned malformed JSON response for extraction',
              'PROVIDER_INVALID_RESPONSE'
            );
          }
        }

        if (!parsedData || typeof parsedData !== 'object') {
          throw new BusinessExecutionError(
            'Provider returned empty or non-object extraction data',
            'PROVIDER_INVALID_RESPONSE'
          );
        }

        return parsedData;
      }
    );

    // Step 3: validate-schema
    const validatedData = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.EXTRACT.VALIDATE_SCHEMA,
      { outputHash: StepCheckpointManager.computeInputHash(inferenceResult) },
      async () => {
        this.validateExtractedStructure(input.type, inferenceResult);
        return inferenceResult;
      }
    );

    return validatedData;
  }

  public static validateExtractedStructure(type: string, data: unknown): void {
    if (!data || typeof data !== 'object') {
      throw new BusinessExecutionError('Extracted data must be a non-null object', 'SCHEMA_VALIDATION_ERROR');
    }

    const obj = data as Record<string, unknown>;

    if (type === 'invoice') {
      if (!obj.invoiceNumber && !obj.total && !obj.supplier) {
        throw new BusinessExecutionError(
          'Extracted invoice missing essential properties (supplier, invoiceNumber, or total)',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    } else if (type === 'contract') {
      if (!obj.parties && !obj.effectiveDate && !obj.title) {
        throw new BusinessExecutionError(
          'Extracted contract missing essential properties (parties, effectiveDate, or title)',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    } else if (type === 'receipt') {
      if (!obj.merchantName && !obj.totalAmount && !obj.items) {
        throw new BusinessExecutionError(
          'Extracted receipt missing essential properties (merchantName, totalAmount, or items)',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    }
  }

  public static validateResult(data: unknown, type?: string, schema?: Record<string, unknown>): unknown {
    if (!data || typeof data !== 'object') {
      throw new BusinessExecutionError('Extracted data must be a non-null object', 'SCHEMA_VALIDATION_ERROR');
    }
    if (type) {
      this.validateExtractedStructure(type, data);
      OutputValidator.validateProviderOutput('extract', type, data, schema);
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
        method: 'llm_extraction',
        modelSlot: 'reasoning',
      },
      warnings: [],
    };
  }
}
