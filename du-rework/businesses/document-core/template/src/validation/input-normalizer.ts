import {
  IngestInput,
  ExtractInput,
  AnalyzeInput,
  TransformInput,
  GenerateInput,
  CompareInput,
} from '../types/actions';
import { ValidationError } from '../types/results';
import { SchemaValidator } from './schema-validator';
import { resolveIngestionSource, type IngestionReceipt } from '@du/contracts';

/**
 * Normalizes and audits input payloads across all six actions (WORKLOAD-REBALANCE-04).
 * Enforces strict bounds:
 * - Artifact count bounds (max 20 for ingest, max 10 for others)
 * - Text/document length bounds (max 100,000 characters)
 * - Page selection bounds (valid range syntax, max 500 pages)
 * - Custom schema complexity bounds (depth <= 5, properties <= 50, no network $ref)
 * - Question count bounds (max 20 questions for QA)
 * - Generation output bounds (1 <= maxWords <= 10,000)
 */
export class InputNormalizer {
  private static readonly MAX_ARTIFACTS_INGEST = 20;
  private static readonly MAX_ARTIFACTS_DEFAULT = 10;
  private static readonly MAX_TEXT_LENGTH = 100_000;
  private static readonly MAX_PAGES_LIMIT = 500;
  private static readonly MAX_QA_QUESTIONS = 20;
  private static readonly MAX_WORDS_LIMIT = 10_000;

  public static normalizeIngest(raw: Record<string, unknown>): IngestInput {
    const mode = raw.mode as string;
    if (!mode) {
      throw new ValidationError('Missing required discriminator: "mode"', 'MISSING_DISCRIMINATOR');
    }
    if (!['parse', 'ocr', 'digitize', 'split'].includes(mode)) {
      throw new ValidationError(`Invalid ingest mode: "${mode}"`, 'INVALID_DISCRIMINATOR');
    }

    const artifactIds = this.toStringArray(raw.artifactIds ?? raw.artifact_ids ?? raw.file_ids);
    if (artifactIds && artifactIds.length > this.MAX_ARTIFACTS_INGEST) {
      throw new ValidationError(
        `Artifact count (${artifactIds.length}) exceeds maximum allowed limit (${this.MAX_ARTIFACTS_INGEST})`,
        'TOO_MANY_ARTIFACTS'
      );
    }

    // Δ14: the READY envelope carries the pinned ingestion source under the
    // contract field `source` (legacy `__source` still readable). A missing
    // pin is the NORMAL inline case and never fails here; a present pin is
    // contract-validated, and once it names an artifact the business layer
    // reads, that reference is resolved into `artifactIds` so every downstream
    // step keeps its single source-of-truth (the artifact read path).
    let source: IngestionReceipt | null = null;
    try {
      source = resolveIngestionSource(raw);
    } catch {
      throw new ValidationError(
        'Ingestion source pin in the task payload failed contract validation',
        'INVALID_INGESTION_RECEIPT'
      );
    }
    const effectiveArtifactIds =
      artifactIds && artifactIds.length > 0
        ? artifactIds
        : source?.artifactId
        ? [source.artifactId]
        : artifactIds;

    const text = typeof raw.text === 'string' ? raw.text : undefined;
    if (text && text.length > this.MAX_TEXT_LENGTH) {
      throw new ValidationError(
        `Document text length (${text.length}) exceeds maximum allowed limit (${this.MAX_TEXT_LENGTH})`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    const pages = typeof raw.pages === 'string' ? raw.pages : undefined;
    if (pages) {
      this.validatePageRange(pages);
    }

    return {
      mode: mode as IngestInput['mode'],
      artifactIds: effectiveArtifactIds,
      source: source ?? undefined,
      text,
      pages,
      language: typeof raw.language === 'string' ? raw.language : undefined,
      outputFormat: this.normalizeOutputFormat(raw.outputFormat ?? raw.output_format),
    };
  }

  public static normalizeExtract(raw: Record<string, unknown>): ExtractInput {
    const type = raw.type as string;
    if (!type) {
      throw new ValidationError('Missing required discriminator: "type"', 'MISSING_DISCRIMINATOR');
    }
    if (!['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom'].includes(type)) {
      throw new ValidationError(`Invalid extract type: "${type}"`, 'INVALID_DISCRIMINATOR');
    }

    const artifactIds = this.toStringArray(raw.artifactIds ?? raw.artifact_ids ?? raw.file_ids);
    if (artifactIds && artifactIds.length > this.MAX_ARTIFACTS_DEFAULT) {
      throw new ValidationError(
        `Artifact count (${artifactIds.length}) exceeds maximum allowed limit (${this.MAX_ARTIFACTS_DEFAULT})`,
        'TOO_MANY_ARTIFACTS'
      );
    }

    const text = typeof raw.text === 'string' ? raw.text : undefined;
    if (text && text.length > this.MAX_TEXT_LENGTH) {
      throw new ValidationError(
        `Document text length (${text.length}) exceeds maximum allowed limit (${this.MAX_TEXT_LENGTH})`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    let schema: Record<string, unknown> | undefined;
    if (typeof raw.schema === 'string') {
      try {
        schema = JSON.parse(raw.schema);
      } catch {
        throw new ValidationError('Invalid JSON in "schema" string', 'INVALID_CUSTOM_SCHEMA');
      }
    } else if (raw.schema && typeof raw.schema === 'object') {
      schema = raw.schema as Record<string, unknown>;
    }

    if (schema) {
      SchemaValidator.validateCustomSchema(schema);
    }

    return {
      type: type as ExtractInput['type'],
      artifactIds,
      text,
      fields: this.toStringArray(raw.fields),
      schema,
      outputFormat: 'json',
    };
  }

  public static normalizeAnalyze(raw: Record<string, unknown>): AnalyzeInput {
    const task = raw.task as string;
    if (!task) {
      throw new ValidationError('Missing required discriminator: "task"', 'MISSING_DISCRIMINATOR');
    }
    if (!['classify', 'sentiment', 'compliance', 'fact-check', 'quality', 'risk', 'summarize-eval'].includes(task)) {
      throw new ValidationError(`Invalid analyze task: "${task}"`, 'INVALID_DISCRIMINATOR');
    }

    const artifactIds = this.toStringArray(raw.artifactIds ?? raw.artifact_ids ?? raw.file_ids);
    if (artifactIds && artifactIds.length > this.MAX_ARTIFACTS_DEFAULT) {
      throw new ValidationError(
        `Artifact count (${artifactIds.length}) exceeds maximum allowed limit (${this.MAX_ARTIFACTS_DEFAULT})`,
        'TOO_MANY_ARTIFACTS'
      );
    }

    const text = typeof raw.text === 'string' ? raw.text : undefined;
    if (text && text.length > this.MAX_TEXT_LENGTH) {
      throw new ValidationError(
        `Document text length (${text.length}) exceeds maximum allowed limit (${this.MAX_TEXT_LENGTH})`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    const referenceData = raw.referenceData ?? raw.reference_data;
    if (task === 'fact-check') {
      const hasReference =
        (typeof referenceData === 'string' && referenceData.trim().length > 0) ||
        (referenceData !== null &&
          typeof referenceData === 'object' &&
          !Array.isArray(referenceData) &&
          Object.keys(referenceData as Record<string, unknown>).length > 0);
      if (!hasReference) {
        throw new ValidationError(
          'Analyze task "fact-check" requires non-empty "referenceData"',
          'MISSING_REQUIRED_PARAMETER'
        );
      }
    }

    return {
      task: task as AnalyzeInput['task'],
      artifactIds,
      text,
      categories: this.toStringArray(raw.categories),
      criteria: Array.isArray(raw.criteria)
        ? (raw.criteria as string[])
        : typeof raw.criteria === 'string'
        ? raw.criteria
        : undefined,
      referenceData: referenceData as Record<string, unknown> | string | undefined,
      extractFields: this.toStringArray(raw.extractFields ?? raw.extract_fields),
    } as AnalyzeInput;
  }

  public static normalizeTransform(raw: Record<string, unknown>): TransformInput {
    const variant = (raw.variant ?? raw.action) as string;
    if (!variant) {
      throw new ValidationError(
        'Missing required discriminator: "variant" (or "action")',
        'MISSING_DISCRIMINATOR'
      );
    }
    if (!['convert', 'translate', 'rewrite', 'redact', 'template'].includes(variant)) {
      throw new ValidationError(`Invalid transform variant: "${variant}"`, 'INVALID_DISCRIMINATOR');
    }

    const artifactIds = this.toStringArray(raw.artifactIds ?? raw.artifact_ids ?? raw.file_ids);
    if (artifactIds && artifactIds.length > this.MAX_ARTIFACTS_DEFAULT) {
      throw new ValidationError(
        `Artifact count (${artifactIds.length}) exceeds maximum allowed limit (${this.MAX_ARTIFACTS_DEFAULT})`,
        'TOO_MANY_ARTIFACTS'
      );
    }

    const text = typeof raw.text === 'string' ? raw.text : undefined;
    if (text && text.length > this.MAX_TEXT_LENGTH) {
      throw new ValidationError(
        `Document text length (${text.length}) exceeds maximum allowed limit (${this.MAX_TEXT_LENGTH})`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    return {
      variant: variant as TransformInput['variant'],
      artifactIds,
      text,
      targetLanguage: typeof (raw.targetLanguage ?? raw.target_language) === 'string'
        ? (raw.targetLanguage ?? raw.target_language) as string
        : undefined,
      style: raw.style as TransformInput['style'],
      tone: raw.tone as TransformInput['tone'],
      redactPatterns: this.toStringArray(raw.redactPatterns ?? raw.redact_patterns),
      template: typeof raw.template === 'string' ? raw.template : undefined,
      outputFormat: typeof (raw.outputFormat ?? raw.output_format) === 'string'
        ? (raw.outputFormat ?? raw.output_format) as string
        : undefined,
    };
  }

  public static normalizeGenerate(raw: Record<string, unknown>): GenerateInput {
    const task = raw.task as string;
    if (!task) {
      throw new ValidationError('Missing required discriminator: "task"', 'MISSING_DISCRIMINATOR');
    }
    if (!['summary', 'outline', 'report', 'email', 'minutes', 'qa'].includes(task)) {
      throw new ValidationError(`Invalid generate task: "${task}"`, 'INVALID_DISCRIMINATOR');
    }

    const artifactIds = this.toStringArray(raw.artifactIds ?? raw.artifact_ids ?? raw.file_ids);
    if (artifactIds && artifactIds.length > this.MAX_ARTIFACTS_DEFAULT) {
      throw new ValidationError(
        `Artifact count (${artifactIds.length}) exceeds maximum allowed limit (${this.MAX_ARTIFACTS_DEFAULT})`,
        'TOO_MANY_ARTIFACTS'
      );
    }

    const text = typeof raw.text === 'string' ? raw.text : undefined;
    if (text && text.length > this.MAX_TEXT_LENGTH) {
      throw new ValidationError(
        `Document text length (${text.length}) exceeds maximum allowed limit (${this.MAX_TEXT_LENGTH})`,
        'DOCUMENT_TOO_LARGE'
      );
    }

    const maxWords = raw.maxWords ?? raw.max_words;
    let parsedMaxWords: number | undefined;
    if (maxWords !== undefined && maxWords !== null) {
      parsedMaxWords = Number(maxWords);
      if (isNaN(parsedMaxWords) || parsedMaxWords <= 0) {
        throw new ValidationError('"maxWords" must be a positive integer', 'INVALID_ARGUMENT');
      }
      if (parsedMaxWords > this.MAX_WORDS_LIMIT) {
        throw new ValidationError(
          `"maxWords" (${parsedMaxWords}) exceeds maximum allowed limit (${this.MAX_WORDS_LIMIT})`,
          'INVALID_PARAMETER_RANGE'
        );
      }
    }

    const questions = this.toStringArray(raw.questions);
    if (task === 'qa') {
      if (!questions || questions.length === 0) {
        throw new ValidationError('Generate task "qa" requires non-empty "questions" parameter', 'MISSING_REQUIRED_PARAMETER');
      }
      if (questions.length > this.MAX_QA_QUESTIONS) {
        throw new ValidationError(
          `Question count (${questions.length}) exceeds maximum allowed cap of ${this.MAX_QA_QUESTIONS} items`,
          'TOO_MANY_QUESTIONS'
        );
      }
    }

    return {
      task: task as GenerateInput['task'],
      artifactIds,
      text,
      format: raw.format as GenerateInput['format'],
      maxWords: parsedMaxWords,
      tone: raw.tone as GenerateInput['tone'],
      audience: typeof raw.audience === 'string' ? raw.audience : undefined,
      questions,
    };
  }

  public static normalizeCompare(raw: Record<string, unknown>): CompareInput {
    const mode = raw.mode as string;
    if (!mode) {
      throw new ValidationError('Missing required discriminator: "mode"', 'MISSING_DISCRIMINATOR');
    }
    if (!['diff', 'semantic', 'version'].includes(mode)) {
      throw new ValidationError(`Invalid compare mode: "${mode}"`, 'INVALID_DISCRIMINATOR');
    }

    const source = this.parseComparisonSide(raw.source, raw.source_file, 'source');
    const target = this.parseComparisonSide(raw.target, raw.target_file, 'target');

    return {
      mode: mode as CompareInput['mode'],
      source,
      target,
      focus: typeof raw.focus === 'string' ? raw.focus : undefined,
      outputFormat: this.normalizeOutputFormat(raw.outputFormat ?? raw.output_format),
    };
  }

  private static parseComparisonSide(
    direct: unknown,
    fileAlias: unknown,
    sideName: 'source' | 'target'
  ): { artifactId?: string; text?: string } {
    const hasDirect = direct !== undefined && direct !== null;
    const hasAlias = fileAlias !== undefined && fileAlias !== null;

    // 1. Conflict check: reject when both canonical parameter and legacy file alias are supplied
    if (hasDirect && hasAlias) {
      throw new ValidationError(
        `Conflicting comparison parameters: cannot specify both canonical "${sideName}" and legacy alias "${sideName}_file"`,
        'CONFLICTING_COMPARISON_PARAMETERS'
      );
    }

    // 2. Missing side check: reject when neither parameter is supplied
    if (!hasDirect && !hasAlias) {
      throw new ValidationError(
        `Missing required comparison side: "${sideName}"`,
        'MISSING_COMPARISON_SIDE'
      );
    }

    // 3. Process legacy file alias (source_file / target_file)
    if (hasAlias) {
      if (Array.isArray(fileAlias)) {
        throw new ValidationError(
          `Invalid "${sideName}_file": arrays are not supported`,
          'INVALID_COMPARISON_SIDE'
        );
      }
      if (typeof fileAlias === 'string') {
        const trimmed = fileAlias.trim();
        if (trimmed.length === 0) {
          throw new ValidationError(
            `Empty or whitespace-only value for "${sideName}_file"`,
            'INVALID_COMPARISON_SIDE'
          );
        }
        return { artifactId: trimmed };
      }
      if (typeof fileAlias === 'object') {
        return this.parseSideObject(fileAlias as Record<string, unknown>, `${sideName}_file`);
      }
      throw new ValidationError(
        `Invalid "${sideName}_file": must be a string artifact ID or object reference`,
        'INVALID_COMPARISON_SIDE'
      );
    }

    // 4. Process canonical direct parameter (source / target)
    if (Array.isArray(direct)) {
      throw new ValidationError(
        `Invalid "${sideName}": arrays are not supported`,
        'INVALID_COMPARISON_SIDE'
      );
    }
    if (typeof direct === 'string') {
      const trimmed = direct.trim();
      if (trimmed.length === 0) {
        throw new ValidationError(
          `Empty or whitespace-only value for "${sideName}"`,
          'INVALID_COMPARISON_SIDE'
        );
      }
      return { text: direct };
    }
    if (typeof direct === 'object') {
      return this.parseSideObject(direct as Record<string, unknown>, sideName);
    }

    throw new ValidationError(
      `Invalid "${sideName}": must be a string text or object reference`,
      'INVALID_COMPARISON_SIDE'
    );
  }

  private static parseSideObject(
    obj: Record<string, unknown>,
    paramName: string
  ): { artifactId?: string; text?: string } {
    const rawArtifactId = obj.artifactId ?? obj.artifact_id;
    const rawText = obj.text;

    let parsedArtifactId: string | undefined;
    if (rawArtifactId !== undefined && rawArtifactId !== null) {
      if (typeof rawArtifactId !== 'string') {
        throw new ValidationError(
          `Invalid "artifactId" in "${paramName}": must be a string`,
          'INVALID_COMPARISON_SIDE'
        );
      }
      const trimmed = rawArtifactId.trim();
      if (trimmed.length === 0) {
        throw new ValidationError(
          `Empty or whitespace-only "artifactId" in "${paramName}"`,
          'INVALID_COMPARISON_SIDE'
        );
      }
      parsedArtifactId = trimmed;
    }

    let parsedText: string | undefined;
    if (rawText !== undefined && rawText !== null) {
      if (typeof rawText !== 'string') {
        throw new ValidationError(
          `Invalid "text" in "${paramName}": must be a string`,
          'INVALID_COMPARISON_SIDE'
        );
      }
      const trimmed = rawText.trim();
      if (trimmed.length === 0) {
        throw new ValidationError(
          `Empty or whitespace-only "text" in "${paramName}"`,
          'INVALID_COMPARISON_SIDE'
        );
      }
      parsedText = rawText;
    }

    // Reject ambiguous simultaneous specification of both artifactId and text
    if (parsedArtifactId && parsedText) {
      throw new ValidationError(
        `Ambiguous comparison side in "${paramName}": cannot specify both "artifactId" and "text" simultaneously`,
        'AMBIGUOUS_COMPARISON_SIDE'
      );
    }

    // Reject object lacking both artifactId and text
    if (!parsedArtifactId && !parsedText) {
      throw new ValidationError(
        `Missing comparison reference in "${paramName}": must specify either "artifactId" or "text"`,
        'MISSING_COMPARISON_SIDE'
      );
    }

    return parsedArtifactId ? { artifactId: parsedArtifactId } : { text: parsedText! };
  }

  private static validatePageRange(pages: string): void {
    const trimmed = pages.trim();
    if (trimmed.toLowerCase() === 'all') return;

    // Check valid expression format (numbers, hyphens, commas, spaces)
    if (!/^[0-9,\-\s]+$/.test(trimmed)) {
      throw new ValidationError(
        `Invalid page range expression: "${pages}". Must contain page numbers, hyphens, or commas.`,
        'INVALID_PAGE_RANGE'
      );
    }

    const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.includes('-')) {
        const [startStr, endStr] = part.split('-').map((s) => s.trim());
        const start = Number(startStr);
        const end = endStr ? Number(endStr) : undefined;
        if (isNaN(start) || start <= 0) {
          throw new ValidationError(`Invalid page range start: "${startStr}"`, 'INVALID_PAGE_RANGE');
        }
        if (end !== undefined) {
          if (isNaN(end) || end <= 0) {
            throw new ValidationError(`Invalid page range end: "${endStr}"`, 'INVALID_PAGE_RANGE');
          }
          if (end > this.MAX_PAGES_LIMIT) {
            throw new ValidationError(
              `Page number (${end}) exceeds maximum allowed limit (${this.MAX_PAGES_LIMIT})`,
              'PAGE_LIMIT_EXCEEDED'
            );
          }
        }
      } else {
        const num = Number(part);
        if (isNaN(num) || num <= 0) {
          throw new ValidationError(`Invalid page number: "${part}"`, 'INVALID_PAGE_RANGE');
        }
        if (num > this.MAX_PAGES_LIMIT) {
          throw new ValidationError(
            `Page number (${num}) exceeds maximum allowed limit (${this.MAX_PAGES_LIMIT})`,
            'PAGE_LIMIT_EXCEEDED'
          );
        }
      }
    }
  }

  private static toStringArray(val: unknown): string[] | undefined {
    if (!val) return undefined;
    if (Array.isArray(val)) {
      return val.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof val === 'string') {
      return val
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return undefined;
  }

  private static normalizeOutputFormat(val: unknown): 'json' | 'md' | 'text' | undefined {
    if (typeof val !== 'string') return undefined;
    const lower = val.toLowerCase().trim();
    if (lower === 'markdown' || lower === 'md') return 'md';
    if (lower === 'text' || lower === 'txt') return 'text';
    if (lower === 'json') return 'json';
    return undefined;
  }
}
