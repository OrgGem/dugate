import { IngestInput, IngestResultData } from '../../types/actions';
import { TaskContext } from '../../types/context';
import { ResultEnvelope, ProfileSnapshot } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import { DocumentFormatDetector, defaultParserFactory, PdfSplitter } from '@du/document-kit';

export class IngestAction {
  public static validateInput(raw: unknown): IngestInput {
    return InputNormalizer.normalizeIngest(raw as Record<string, unknown>);
  }

  public static selectRecipe(input: IngestInput, _profile?: ProfileSnapshot): RecipeDefinition {
    return RecipeRegistry.getRecipe('ingest', input.mode);
  }

  public static async prepareSources(
    ctx: TaskContext,
    input: IngestInput
  ): Promise<{ buffers: Buffer[]; fileNames: string[]; inlineText?: string }> {
    const buffers: Buffer[] = [];
    const fileNames: string[] = [];

    if (input.artifactIds && input.artifactIds.length > 0) {
      for (let i = 0; i < input.artifactIds.length; i++) {
        const id = input.artifactIds[i];
        if (id) {
          const buf = await ctx.artifacts.read(id);
          buffers.push(buf);
          fileNames.push(`artifact_${i + 1}`);
        }
      }
    }

    return {
      buffers,
      fileNames,
      inlineText: input.text,
    };
  }

  public static async executeRecipe(
    ctx: TaskContext,
    recipe: RecipeDefinition,
    input: IngestInput,
    sources: { buffers: Buffer[]; fileNames: string[]; inlineText?: string }
  ): Promise<IngestResultData> {
    const mode = input.mode;

    // Execute step 1: prepare-source
    await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      STEP_KEYS.INGEST.PREPARE_SOURCE,
      { artifactCount: sources.buffers.length, hasInlineText: !!sources.inlineText },
      async () => ({ ready: true })
    );

    // Execute step 2: specific mode execution
    if (mode === 'parse') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.INGEST.EXECUTE_PARSE,
        { bufferSizes: sources.buffers.map((b) => b.length), inlineTextLen: sources.inlineText?.length },
        async () => {
          const buf = sources.buffers[0];
          if (buf) {
            const fileName = sources.fileNames[0] || 'document';
            const parseResult = await defaultParserFactory.parseBuffer(buf, fileName);
            return {
              text: parseResult.text,
              markdown: parseResult.markdown,
              metadata: {
                pageCount: parseResult.metadata.pageCount,
                detectedFormat: parseResult.metadata.detectedFormat,
                parser: parseResult.metadata.parser,
                provenance: 'native_parse' as const,
              },
            };
          } else if (sources.inlineText) {
            return {
              text: sources.inlineText,
              markdown: sources.inlineText,
              metadata: {
                detectedFormat: 'txt',
                parser: 'inline-text',
                provenance: 'native_parse' as const,
              },
            };
          }
          throw new Error('No input document or text provided for parse');
        }
      );
    } else if (mode === 'split') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.INGEST.EXECUTE_SPLIT,
        { pages: input.pages },
        async () => {
          if (!input.pages) {
            throw new Error('Pages parameter required for split mode');
          }
          const buf = sources.buffers[0];
          if (!buf) {
            throw new Error('PDF artifact required for split mode');
          }

          const format = DocumentFormatDetector.detect(buf, sources.fileNames[0]);
          if (format.format !== 'pdf') {
            throw new Error(`Split only supports PDF documents, received "${format.format}"`);
          }

          // Parse and slice PDF buffer into actual sliced PDF artifact
          const splitBuffer = await PdfSplitter.splitPdf(buf, input.pages);
          const pageIndices = PdfSplitter.parsePageExpression(input.pages);

          // Write sliced split artifact
          const splitRef = await ctx.artifacts.write(
            splitBuffer,
            `split_${input.pages.replace(/,/g, '_')}.pdf`,
            'application/pdf'
          );

          return {
            splitArtifacts: [
              {
                artifactId: splitRef.artifactId,
                fileName: splitRef.fileName || 'split.pdf',
                pageCount: pageIndices.length,
                pageRange: input.pages,
              },
            ],
            metadata: {
              pageCount: pageIndices.length,
              detectedFormat: 'pdf',
              parser: 'document-kit:pdf-splitter',
              provenance: 'native_parse' as const,
            },
          };
        }
      );
    } else if (mode === 'ocr') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.INGEST.EXECUTE_OCR,
        { language: input.language },
        async () => {
          const invocation = await ctx.connector.invoke('ocr', {
            language: input.language,
            hasBuffer: sources.buffers.length > 0,
          });

          if (invocation.status !== 'SUCCESS') {
            throw new Error(`OCR Connector failed: ${invocation.error?.message || 'Unknown error'}`);
          }

          const rawData = (invocation.data || {}) as Record<string, unknown>;
          const text = (rawData.text as string) || invocation.rawText || '';

          return {
            text,
            markdown: (rawData.markdown as string) || text,
            metadata: {
              detectedFormat: 'image/scan',
              parser: 'connector:ocr',
              provenance: 'ocr' as const,
            },
          };
        }
      );
    } else if (mode === 'digitize') {
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.INGEST.EXECUTE_DIGITIZE,
        {},
        async () => {
          const invocation = await ctx.connector.invoke('vision', {
            task: 'digitize_handwriting',
          });

          if (invocation.status !== 'SUCCESS') {
            throw new Error(`Vision Connector failed: ${invocation.error?.message || 'Unknown error'}`);
          }

          const rawData = (invocation.data || {}) as Record<string, unknown>;
          return {
            text: (rawData.text as string) || invocation.rawText || '',
            markdown: (rawData.markdown as string) || '',
            formFields: (rawData.formFields as Record<string, unknown>) || {},
            metadata: {
              detectedFormat: 'image/form',
              parser: 'connector:vision',
              provenance: 'vision' as const,
            },
          };
        }
      );
    }

    throw new Error(`Unsupported ingest mode: ${mode}`);
  }

  public static validateResult(data: IngestResultData, mode?: string): IngestResultData {
    if (!data.metadata || !data.metadata.parser) {
      throw new Error('Result missing mandatory metadata or parser identifier');
    }
    if (mode) {
      OutputValidator.validateProviderOutput('ingest', mode, data);
    }
    return data;
  }

  public static formatResult(
    _ctx: TaskContext,
    resultData: IngestResultData,
    _format: string = 'json'
  ): ResultEnvelope<IngestResultData> {
    const rawProv = resultData.metadata.provenance;
    const method: 'native_parse' | 'ocr' =
      rawProv === 'ocr' || rawProv === 'vision' ? 'ocr' : 'native_parse';
    const modelSlot: 'ocr' | 'vision' | undefined =
      rawProv === 'ocr' ? 'ocr' : rawProv === 'vision' ? 'vision' : undefined;

    return {
      status: 'COMPLETED',
      data: resultData,
      provenance: {
        method,
        modelSlot,
        parserUsed: resultData.metadata.parser,
      },
      warnings: [],
    };
  }
}
