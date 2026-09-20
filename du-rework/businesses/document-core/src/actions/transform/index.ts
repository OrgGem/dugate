import { TransformInput, TransformResultData } from '../../types/actions';
import { TaskContext } from '../../types/context';
import { ResultEnvelope, ProfileSnapshot, BusinessExecutionError, ValidationError } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import {
  defaultParserFactory,
  FormatConverter,
  PiiRedactor,
  TemplateEngine,
  TextChunker,
} from '@du/document-kit';

export class TransformAction {
  public static validateInput(raw: unknown): TransformInput {
    const input = InputNormalizer.normalizeTransform(raw as Record<string, unknown>);

    if (input.variant === 'translate') {
      if (!input.targetLanguage) {
        throw new ValidationError(
          'Transform variant "translate" requires "targetLanguage" parameter',
          'MISSING_REQUIRED_PARAMETER'
        );
      }
    } else if (input.variant === 'template') {
      if (!input.template) {
        throw new ValidationError(
          'Transform variant "template" requires "template" parameter',
          'MISSING_REQUIRED_PARAMETER'
        );
      }
    }

    return input;
  }

  public static selectRecipe(input: TransformInput, _profile?: ProfileSnapshot): RecipeDefinition {
    return RecipeRegistry.getRecipe('transform', input.variant);
  }

  public static async prepareSources(
    ctx: TaskContext,
    input: TransformInput
  ): Promise<{ text: string; sourceArtifactIds: string[]; detectedFormat: string }> {
    const sourceArtifactIds: string[] = [];
    let text = input.text || '';
    let detectedFormat = 'txt';

    if (input.artifactIds && input.artifactIds.length > 0) {
      for (const id of input.artifactIds) {
        sourceArtifactIds.push(id);
        const buf = await ctx.artifacts.read(id);
        const parsed = await defaultParserFactory.parseBuffer(buf, `doc_${id}`);
        text += (text ? '\n\n' : '') + parsed.text;
        detectedFormat = parsed.metadata.detectedFormat;
      }
    }

    if (!text.trim() && input.variant !== 'template') {
      throw new BusinessExecutionError(
        'Transform action requires either non-empty inline "text" or readable document artifacts',
        'MISSING_DOCUMENT_SOURCE'
      );
    }

    return { text, sourceArtifactIds, detectedFormat };
  }

  public static async executeRecipe(
    ctx: TaskContext,
    recipe: RecipeDefinition,
    input: TransformInput,
    sources: { text: string; sourceArtifactIds: string[]; detectedFormat: string }
  ): Promise<TransformResultData> {
    const variant = input.variant;

    if (variant === 'convert') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.TRANSFORM.EXECUTE_LOCAL_CONVERT,
        { targetFormat: input.outputFormat || 'md' },
        async () => {
          const targetFormat = input.outputFormat || 'md';
          const converted = FormatConverter.convertText(
            sources.text,
            sources.detectedFormat,
            targetFormat
          );
          return {
            transformedText: converted,
            outputFormat: targetFormat,
            metadata: { method: 'native_conversion' },
          };
        }
      );
    } else if (variant === 'translate') {
      if (sources.text.length > 50000) {
        throw new BusinessExecutionError(
          `Document length (${sources.text.length} chars) exceeds maximum supported size for transform (50000 characters).`,
          'DOCUMENT_TOO_LARGE'
        );
      }

      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.TRANSFORM.EXECUTE_TRANSLATE,
        { targetLanguage: input.targetLanguage, tone: input.tone },
        async () => {
          const chunks = TextChunker.splitIntoChunks(sources.text, 4000);
          const translatedChunks: string[] = [];
          for (const chunk of chunks) {
            const invocation = await ctx.connector.invoke('reasoning', {
              task: 'translate',
              payload: {
                text: chunk,
                targetLanguage: input.targetLanguage,
                tone: input.tone || 'formal',
              },
              responseFormat: 'text',
            });

            if (invocation.status !== 'SUCCESS') {
              throw new BusinessExecutionError(
                `Translation failed: ${invocation.error?.message || 'Unknown error'}`,
                'PROVIDER_ERROR'
              );
            }

            translatedChunks.push(invocation.rawText || (invocation.data as string) || '');
          }

          return {
            transformedText: translatedChunks.join('\n\n'),
            outputFormat: input.outputFormat || 'md',
            metadata: {
              targetLanguage: input.targetLanguage,
              method: 'llm_translation',
              chunksCount: chunks.length,
            },
          };
        }
      );
    } else if (variant === 'rewrite') {
      if (sources.text.length > 50000) {
        throw new BusinessExecutionError(
          `Document length (${sources.text.length} chars) exceeds maximum supported size for transform (50000 characters).`,
          'DOCUMENT_TOO_LARGE'
        );
      }

      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.TRANSFORM.EXECUTE_REWRITE,
        { style: input.style, tone: input.tone },
        async () => {
          const chunks = TextChunker.splitIntoChunks(sources.text, 4000);
          const rewrittenChunks: string[] = [];
          for (const chunk of chunks) {
            const invocation = await ctx.connector.invoke('reasoning', {
              task: 'rewrite',
              payload: {
                text: chunk,
                style: input.style || 'executive',
                tone: input.tone || 'business',
              },
              responseFormat: 'text',
            });

            if (invocation.status !== 'SUCCESS') {
              throw new BusinessExecutionError(
                `Rewrite failed: ${invocation.error?.message || 'Unknown error'}`,
                'PROVIDER_ERROR'
              );
            }

            rewrittenChunks.push(invocation.rawText || (invocation.data as string) || '');
          }

          return {
            transformedText: rewrittenChunks.join('\n\n'),
            outputFormat: input.outputFormat || 'md',
            metadata: {
              style: input.style,
              tone: input.tone,
              method: 'llm_rewrite',
              chunksCount: chunks.length,
            },
          };
        }
      );
    } else if (variant === 'redact') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.TRANSFORM.EXECUTE_REDACT,
        { patterns: input.redactPatterns },
        async () => {
          const redaction = PiiRedactor.redact(sources.text, input.redactPatterns);
          return {
            transformedText: redaction.redactedText,
            outputFormat: 'text',
            metadata: {
              redactionsCount: redaction.redactionsCount,
              countsByPattern: redaction.countsByPattern,
              method: 'local_pii_redactor',
            },
          };
        }
      );
    } else if (variant === 'template') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.TRANSFORM.EXECUTE_TEMPLATE,
        {},
        async () => {
          let variables: Record<string, unknown> = {};
          if (sources.text) {
            try {
              variables = JSON.parse(sources.text);
            } catch {
              variables = { input: sources.text };
            }
          }

          const rendered = TemplateEngine.render(input.template || '', variables);
          return {
            transformedText: rendered.rendered,
            outputFormat: 'text',
            metadata: {
              missingVariables: rendered.missingVariables,
              method: 'local_template_engine',
            },
          };
        }
      );
    }

    throw new Error(`Unsupported transform variant: ${variant}`);
  }

  public static validateResult(data: TransformResultData, variant?: string): TransformResultData {
    if (!data || typeof data !== 'object' || typeof data.transformedText !== 'string') {
      throw new BusinessExecutionError('Transform result missing transformedText string', 'SCHEMA_VALIDATION_ERROR');
    }
    if (variant) {
      OutputValidator.validateProviderOutput('transform', variant, data);
    }
    return data;
  }

  public static formatResult(
    _ctx: TaskContext,
    resultData: TransformResultData,
    _format: string = 'json'
  ): ResultEnvelope<TransformResultData> {
    const rawMethod = resultData.metadata?.method;
    let method: 'native_parse' | 'llm_translation' | 'llm_evaluation' = 'native_parse';
    let modelSlot: 'reasoning' | undefined = undefined;

    if (rawMethod === 'llm_translation') {
      method = 'llm_translation';
      modelSlot = 'reasoning';
    } else if (rawMethod === 'llm_rewrite') {
      method = 'llm_evaluation';
      modelSlot = 'reasoning';
    }

    return {
      status: 'COMPLETED',
      data: resultData,
      provenance: {
        method,
        modelSlot,
      },
      warnings: [],
    };
  }
}
