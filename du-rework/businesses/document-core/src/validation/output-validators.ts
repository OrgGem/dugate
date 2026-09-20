import { BusinessExecutionError } from '../types/results';

/**
 * Output validators for all 6 actions and 28 variants (WORKLOAD-REBALANCE-04).
 *
 * Enforces strict semantic output validation before any result artifact is finalized:
 * - Rejects malformed / non-object responses
 * - Rejects empty objects or missing required fields
 * - Validates enums, ranges, and types
 * - Validates custom JSON schema matching
 * - Throws BusinessExecutionError with stable error codes:
 *   - 'MALFORMED_PROVIDER_OUTPUT'
 *   - 'SCHEMA_VALIDATION_ERROR'
 *   - 'EMPTY_PROVIDER_OUTPUT'
 */

export interface ValidationOutcome {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export class OutputValidator {
  /**
   * Validate raw provider output for a specific action and variant.
   */
  public static validateProviderOutput(
    action: string,
    variant: string,
    data: unknown,
    schema?: Record<string, unknown>
  ): void {
    if (data === null || data === undefined) {
      throw new BusinessExecutionError(
        `Provider returned empty or null result for ${action}:${variant}`,
        'EMPTY_PROVIDER_OUTPUT'
      );
    }

    if (typeof data !== 'object') {
      throw new BusinessExecutionError(
        `Provider returned non-object result (${typeof data}) for ${action}:${variant}`,
        'MALFORMED_PROVIDER_OUTPUT'
      );
    }

    const obj = data as Record<string, unknown>;

    // Reject empty objects
    if (Object.keys(obj).length === 0) {
      throw new BusinessExecutionError(
        `Provider returned empty object for ${action}:${variant}`,
        'EMPTY_PROVIDER_OUTPUT'
      );
    }

    switch (action) {
      case 'ingest':
        this.validateIngestOutput(variant, obj);
        break;
      case 'extract':
        this.validateExtractOutput(variant, obj, schema);
        break;
      case 'analyze':
        this.validateAnalyzeOutput(variant, obj);
        break;
      case 'transform':
        this.validateTransformOutput(variant, obj);
        break;
      case 'generate':
        this.validateGenerateOutput(variant, obj);
        break;
      case 'compare':
        this.validateCompareOutput(variant, obj);
        break;
      default:
        throw new BusinessExecutionError(`Unknown action: ${action}`, 'SCHEMA_VALIDATION_ERROR');
    }
  }

  /* ---------------- Ingest Output Validation ---------------- */

  private static validateIngestOutput(variant: string, obj: Record<string, unknown>): void {
    if (variant === 'parse' || variant === 'ocr' || variant === 'digitize') {
      const text = obj.text ?? obj.markdown;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new BusinessExecutionError(
          `Ingest ${variant} output missing non-empty "text" or "markdown" content`,
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    } else if (variant === 'split') {
      if (!Array.isArray(obj.splitArtifacts) || obj.splitArtifacts.length === 0) {
        throw new BusinessExecutionError(
          'Ingest split output missing non-empty "splitArtifacts" array',
          'SCHEMA_VALIDATION_ERROR'
        );
      }
    }
  }

  /* ---------------- Extract Output Validation ---------------- */

  private static validateExtractOutput(
    variant: string,
    obj: Record<string, unknown>,
    schema?: Record<string, unknown>
  ): void {
    switch (variant) {
      case 'invoice': {
        const hasId = typeof obj.invoiceNumber === 'string' && obj.invoiceNumber.trim().length > 0;
        const hasSupplier = typeof obj.supplier === 'string' || (typeof obj.supplier === 'object' && obj.supplier !== null);
        const hasTotal = obj.total !== undefined && obj.total !== null;
        if (!hasId && !hasSupplier && !hasTotal) {
          throw new BusinessExecutionError(
            'Extracted invoice missing essential fields (invoiceNumber, supplier, total)',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'contract': {
        const hasParties = Array.isArray(obj.parties) && obj.parties.length > 0;
        const hasDate = typeof obj.effectiveDate === 'string';
        const hasTitle = typeof obj.title === 'string';
        if (!hasParties && !hasDate && !hasTitle) {
          throw new BusinessExecutionError(
            'Extracted contract missing essential fields (parties, effectiveDate, title)',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'receipt': {
        const hasMerchant = typeof obj.merchantName === 'string' || typeof obj.merchant === 'string';
        const hasTotal = obj.totalAmount !== undefined || obj.total !== undefined;
        const hasItems = Array.isArray(obj.items);
        if (!hasMerchant && !hasTotal && !hasItems) {
          throw new BusinessExecutionError(
            'Extracted receipt missing essential fields (merchantName, totalAmount, items)',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'table': {
        const hasRows = Array.isArray(obj.rows);
        const hasColumns = Array.isArray(obj.columns);
        const hasTables = Array.isArray(obj.tables);
        if (!hasRows && !hasColumns && !hasTables) {
          throw new BusinessExecutionError(
            'Extracted table missing tabular structure (rows, columns, or tables)',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'custom': {
        if (schema && schema.required && Array.isArray(schema.required)) {
          for (const reqField of schema.required) {
            if (typeof reqField === 'string' && !(reqField in obj)) {
              throw new BusinessExecutionError(
                `Custom extraction missing required schema field "${reqField}"`,
                'SCHEMA_VALIDATION_ERROR'
              );
            }
          }
        }
        break;
      }
    }
  }

  /* ---------------- Analyze Output Validation ---------------- */

  private static validateAnalyzeOutput(variant: string, obj: Record<string, unknown>): void {
    switch (variant) {
      case 'classify': {
        if (typeof obj.category !== 'string' || obj.category.trim().length === 0) {
          throw new BusinessExecutionError(
            'Classification result must contain non-empty "category" string',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
          throw new BusinessExecutionError(
            'Classification confidence must be a number between 0 and 1',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'sentiment': {
        const validSentiments = ['positive', 'negative', 'neutral', 'mixed'];
        if (typeof obj.sentiment !== 'string' || !validSentiments.includes(obj.sentiment)) {
          throw new BusinessExecutionError(
            `Sentiment must be one of: ${validSentiments.join(', ')}`,
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'compliance': {
        const validStatuses = ['PASS', 'FAIL', 'WARNING'];
        if (typeof obj.status !== 'string' || !validStatuses.includes(obj.status)) {
          throw new BusinessExecutionError(
            `Compliance status must be one of: ${validStatuses.join(', ')}`,
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'quality': {
        const score = obj.score ?? obj.qualityScore;
        if (typeof score !== 'number' || score < 0 || score > 100) {
          throw new BusinessExecutionError(
            'Quality analysis requires numeric "score" between 0 and 100',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'risk': {
        const validLevels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        const riskLevel = typeof obj.riskLevel === 'string' ? obj.riskLevel.toUpperCase() : '';
        if (!validLevels.includes(riskLevel)) {
          throw new BusinessExecutionError(
            `Risk assessment requires "riskLevel" of ${validLevels.join(', ')}`,
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
    }
  }

  /* ---------------- Transform Output Validation ---------------- */

  private static validateTransformOutput(variant: string, obj: Record<string, unknown>): void {
    const text = obj.transformedText ?? obj.text ?? obj.content ?? obj.redactedText;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new BusinessExecutionError(
        `Transform ${variant} result missing non-empty transformed text`,
        'SCHEMA_VALIDATION_ERROR'
      );
    }
  }

  /* ---------------- Generate Output Validation ---------------- */

  private static validateGenerateOutput(variant: string, obj: Record<string, unknown>): void {
    switch (variant) {
      case 'summary':
      case 'outline':
      case 'report':
      case 'email':
      case 'minutes': {
        const content = obj.content ?? obj.text ?? obj.summary ?? obj.report ?? obj.outline;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new BusinessExecutionError(
            `Generate ${variant} output missing non-empty content string`,
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'qa': {
        const answers = obj.answers;
        if (!Array.isArray(answers) || answers.length === 0) {
          throw new BusinessExecutionError(
            'Generate qa output must contain non-empty "answers" array',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        for (let i = 0; i < answers.length; i++) {
          const a = answers[i];
          if (!a || typeof a !== 'object' || (typeof a.answer !== 'string' && typeof a.text !== 'string')) {
            throw new BusinessExecutionError(
              `QA answer at index ${i} is missing valid answer text`,
              'SCHEMA_VALIDATION_ERROR'
            );
          }
        }
        break;
      }
    }
  }

  /* ---------------- Compare Output Validation ---------------- */

  private static validateCompareOutput(variant: string, obj: Record<string, unknown>): void {
    switch (variant) {
      case 'diff': {
        if (!Array.isArray(obj.changes) && typeof obj.unifiedDiff !== 'string' && typeof obj.diff !== 'string') {
          throw new BusinessExecutionError(
            'Compare diff result missing "changes" array or "unifiedDiff" string',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'semantic': {
        const sim = obj.similarity ?? obj.similarityScore;
        const analysis = obj.analysis ?? obj.differences ?? obj.summary;
        if (sim === undefined && analysis === undefined) {
          throw new BusinessExecutionError(
            'Compare semantic result missing "similarity" score or "analysis"',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        if (sim !== undefined && (typeof sim !== 'number' || sim < 0 || sim > 1)) {
          throw new BusinessExecutionError(
            'Semantic similarity score must be a number between 0 and 1',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
      case 'version': {
        const summary = obj.versionSummary ?? obj.summary;
        const changes = obj.changes ?? obj.differences;
        if (!summary && !changes) {
          throw new BusinessExecutionError(
            'Compare version result missing "versionSummary" or "changes"',
            'SCHEMA_VALIDATION_ERROR'
          );
        }
        break;
      }
    }
  }
}
