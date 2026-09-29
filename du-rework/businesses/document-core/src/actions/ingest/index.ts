import { IngestInput, IngestResultData } from '../../types/actions';
import { ArtifactReadResult, TaskContext } from '../../types/context';
import { BusinessExecutionError, ResultEnvelope, ProfileSnapshot } from '../../types/results';
import { InputNormalizer } from '../../validation/input-normalizer';
import { RecipeRegistry, RecipeDefinition } from '../../recipes/recipe-definitions';
import { STEP_KEYS } from '../../recipes/step-keys';
import { StepCheckpointManager } from '../../pipelines/step-checkpoint';
import { OutputValidator } from '../../validation/output-validators';
import { DocumentFormatDetector, PdfSplitter } from '@du/document-kit';
import { ParserBudgetHelper } from '../../pipelines/parser-budget';
import { createHash } from 'node:crypto';
import { CONNECTOR_ARTIFACT_MAX_BYTES, type InvocationArtifactContent } from '@du/contracts';

function connectorArtifact(ctx: TaskContext, artifactId: string, source: ArtifactReadResult): InvocationArtifactContent {
  ParserBudgetHelper.assertActiveDeadline(ctx);
  const identity = source.identity;
  if (!identity || !identity.storageVersionId || !identity.grantExpiresAt) {
    throw new BusinessExecutionError(
      'The source was read without a complete, version-pinned artifact grant',
      'ARTIFACT_GRANT_INVALID',
      false
    );
  }
  const grantExpiresAt = Date.parse(identity.grantExpiresAt);
  if (!Number.isFinite(grantExpiresAt) || grantExpiresAt <= Date.now()) {
    throw new BusinessExecutionError('Artifact read grant has expired', 'ARTIFACT_GRANT_EXPIRED', false);
  }
  const bytes = source.buffer;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const budget = ParserBudgetHelper.resolveParserBudget(ctx);
  if (bytes.length < 1 || bytes.length > Math.min(budget.maxBufferSizeBytes, CONNECTOR_ARTIFACT_MAX_BYTES)) {
    throw new BusinessExecutionError(
      'OCR source exceeds the authorized connector size limit',
      'DOCUMENT_TOO_LARGE',
      false
    );
  }
  if (identity.sizeBytes !== bytes.length || identity.sha256 !== digest) {
    throw new BusinessExecutionError('Artifact bytes do not match the authorized read grant', 'ARTIFACT_INTEGRITY_MISMATCH', false);
  }
  const fileName = source.formatMetadata.declaredFileName ?? `artifact-${artifactId}`;
  // The declared MIME is part of the artifact's authorized metadata; the
  // content-derived canonical value remains the parser's validation hint.
  const mimeType = source.formatMetadata.declaredMimeType ?? source.formatMetadata.canonicalMimeType;
  return {
    artifactId,
    fileName,
    mimeType,
    sizeBytes: bytes.length,
    sha256: digest,
    storageVersionId: identity.storageVersionId,
    contentBase64: bytes.toString('base64'),
  };
}

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
  ): Promise<{ buffers: Buffer[]; fileNames: string[]; artifactInputs: ArtifactReadResult[]; artifactIds: string[]; inlineText?: string }> {
    ParserBudgetHelper.assertActiveDeadline(ctx);
    const buffers: Buffer[] = [];
    const fileNames: string[] = [];
    const artifactInputs: ArtifactReadResult[] = [];
    // INGEST-WIRE-01: keep the ids of the artifacts actually read, in the same
    // order. The OCR/digitize branches hand ONE of these to the Connector, and
    // an id reconstructed later by index would be a guess about which document
    // the provider is about to read.
    const artifactIds: string[] = [];

    if (input.artifactIds && input.artifactIds.length > 0) {
      for (let i = 0; i < input.artifactIds.length; i++) {
        const id = input.artifactIds[i];
        if (id) {
          ParserBudgetHelper.assertActiveDeadline(ctx);
          const artifact = await ParserBudgetHelper.readArtifact(ctx, id);
          buffers.push(artifact.buffer);
          fileNames.push(artifact.formatMetadata.declaredFileName ?? `artifact_${i + 1}`);
          artifactInputs.push(artifact);
          artifactIds.push(id);
        }
      }
    }

    // DATA-03 pin binding: when the envelope carries an ingestion source pin,
    // the pinned bytes must be among the artifacts this task reads. The grant
    // already verified its own digest upstream; this closes the gap between
    // "grant honest about itself" and "artifact IS the object the ingestion
    // gate pinned".
    //
    // The check runs whenever a pin is PRESENT, not only when artifacts exist.
    // That distinction is the whole gate: a URL task whose acquisition never
    // reached READY has no materialized artifact, and must therefore be
    // refused as unresolved — otherwise a task that also carried inline text
    // would quietly parse THAT instead and report success for a source the
    // platform never fetched. Failed acquisition must never look like work done.
    const pin = input.source;
    if (pin) {
      const bound = artifactInputs.some(
        (a) =>
          a.buffer.length === pin.sizeBytes &&
          createHash('sha256').update(a.buffer).digest('hex') === pin.sha256
      );
      if (!bound) {
        if (artifactInputs.length === 0) {
          throw new BusinessExecutionError(
            'The pinned ingestion source has not been materialized as a READY artifact; this task is not runnable yet',
            'INGESTION_SOURCE_UNRESOLVED',
            false
          );
        }
        throw new BusinessExecutionError(
          'None of the read artifacts match the pinned ingestion source digest and length',
          'SOURCE_PIN_MISMATCH',
          false
        );
      }
    }

    return {
      buffers,
      fileNames,
      artifactInputs,
      artifactIds,
      // A pinned task must never be satisfiable by inline text: inline text is
      // not the object the gate pinned, so accepting it would report a result
      // for bytes the platform never acquired.
      inlineText: pin ? undefined : input.text,
    };
  }

  public static async executeRecipe(
    ctx: TaskContext,
    recipe: RecipeDefinition,
    input: IngestInput,
    sources: { buffers: Buffer[]; fileNames: string[]; artifactInputs: ArtifactReadResult[]; artifactIds: string[]; inlineText?: string }
  ): Promise<IngestResultData> {
    ParserBudgetHelper.assertActiveDeadline(ctx);
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
            const sourceArtifact = sources.artifactInputs[0];
            const parseResult = sourceArtifact
              ? await ParserBudgetHelper.safeParseArtifact(ctx, sourceArtifact, fileName)
              : await ParserBudgetHelper.safeParseBuffer(ctx, buf, fileName);
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
          if (input.source) {
            throw new BusinessExecutionError(
              'Task payload carries an ingestion source pin without a materialized artifact reference; the ingestion consumer has not registered the pinned version as a READY artifact',
              'INGESTION_SOURCE_UNRESOLVED',
              false
            );
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
      const sourceArtifactId = sources.artifactIds[0];
      if (!sourceArtifactId) {
        throw new BusinessExecutionError(
          'OCR requires a source artifact reference; nothing was transmitted to the Connector',
          'INGESTION_SOURCE_UNRESOLVED',
          false
        );
      }
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.INGEST.EXECUTE_OCR,
        { language: input.language, artifactId: sourceArtifactId },
        async () => {
          ParserBudgetHelper.assertActiveDeadline(ctx);
          const source = sources.artifactInputs[0];
          if (!source) throw new BusinessExecutionError('OCR source could not be resolved', 'INGESTION_SOURCE_UNRESOLVED', false);
          const artifact = connectorArtifact(ctx, sourceArtifactId, source);
          const invocation = await ctx.connector.invoke('ocr', {
            language: input.language,
            artifacts: [artifact],
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
      const sourceArtifactId = sources.artifactIds[0];
      if (!sourceArtifactId) {
        throw new BusinessExecutionError(
          'Digitize requires a source artifact reference; nothing was transmitted to the Connector',
          'INGESTION_SOURCE_UNRESOLVED',
          false
        );
      }
      return StepCheckpointManager.executeWithCheckpoint(
        ctx,
        STEP_KEYS.INGEST.EXECUTE_DIGITIZE,
        { artifactId: sourceArtifactId },
        async () => {
          ParserBudgetHelper.assertActiveDeadline(ctx);
          const source = sources.artifactInputs[0];
          if (!source) throw new BusinessExecutionError('Digitize source could not be resolved', 'INGESTION_SOURCE_UNRESOLVED', false);
          const artifact = connectorArtifact(ctx, sourceArtifactId, source);
          const invocation = await ctx.connector.invoke('vision', {
            task: 'digitize_handwriting',
            artifacts: [artifact],
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
