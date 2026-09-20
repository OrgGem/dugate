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
      artifactIds,
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
    if (!['invoice', 'contract', 'receipt', 'table', 'custom'].includes(type)) {
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
    if (!['classify', 'sentiment', 'compliance', 'quality', 'risk'].includes(task)) {
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
      referenceData: (raw.referenceData ?? raw.reference_data) as Record<string, unknown> | string | undefined,
    };
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

    const sourceRaw = (raw.source ?? raw.source_file) as Record<string, unknown> | undefined;
    const targetRaw = (raw.target ?? raw.target_file) as Record<string, unknown> | undefined;

    if (!sourceRaw || (!sourceRaw.artifactId && !sourceRaw.text && typeof sourceRaw !== 'string')) {
      throw new ValidationError(
        'Missing required comparison side: "source"',
        'MISSING_COMPARISON_SIDE'
      );
    }
    if (!targetRaw || (!targetRaw.artifactId && !targetRaw.text && typeof targetRaw !== 'string')) {
      throw new ValidationError(
        'Missing required comparison side: "target"',
        'MISSING_COMPARISON_SIDE'
      );
    }

    return {
      mode: mode as CompareInput['mode'],
      source: typeof sourceRaw === 'string' ? { text: sourceRaw } : {
        artifactId: (sourceRaw.artifactId ?? sourceRaw.artifact_id) as string | undefined,
        text: sourceRaw.text as string | undefined,
      },
      target: typeof targetRaw === 'string' ? { text: targetRaw } : {
        artifactId: (targetRaw.artifactId ?? targetRaw.artifact_id) as string | undefined,
        text: targetRaw.text as string | undefined,
      },
      focus: typeof raw.focus === 'string' ? raw.focus : undefined,
      outputFormat: this.normalizeOutputFormat(raw.outputFormat ?? raw.output_format),
    };
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
    const lower = val.toLowerCase();
    if (['json', 'md', 'text'].includes(lower)) {
      return lower as 'json' | 'md' | 'text';
    }
    return undefined;
  }
}
