import { documentCoreManifest } from './document-core.manifest';
import { RecipeRegistry, RecipeDefinition } from '../recipes/recipe-definitions';
import { OutputValidator } from '../validation/output-validators';

/**
 * Machine-checkable 28-variant traceability matrix (WORKLOAD-REBALANCE-04).
 *
 * Traceability Path:
 * BRD Case ID → Manifest Action & Input Schema Discriminator → Recipe Definition → Connector Slot → Output Validator
 */

export interface VariantTraceabilityEntry {
  brdCaseId: string;
  action: 'ingest' | 'extract' | 'analyze' | 'transform' | 'generate' | 'compare';
  variant: string;
  displayName: string;
  recipeId: string;
  requiredSlot?: 'ocr' | 'vision' | 'reasoning';
  validateOutput: (data: unknown, schema?: Record<string, unknown>) => void;
}

export const VARIANT_TRACEABILITY_MATRIX: VariantTraceabilityEntry[] = [
  // DOC-01: Ingest (4)
  {
    brdCaseId: 'DOC-01-01',
    action: 'ingest',
    variant: 'parse',
    displayName: 'Native Document Parsing',
    recipeId: 'recipe-ingest-parse-v1',
    requiredSlot: undefined,
    validateOutput: (data) => OutputValidator.validateProviderOutput('ingest', 'parse', data),
  },
  {
    brdCaseId: 'DOC-01-02',
    action: 'ingest',
    variant: 'ocr',
    displayName: 'Optical Character Recognition',
    recipeId: 'recipe-ingest-ocr-v1',
    requiredSlot: 'ocr',
    validateOutput: (data) => OutputValidator.validateProviderOutput('ingest', 'ocr', data),
  },
  {
    brdCaseId: 'DOC-01-03',
    action: 'ingest',
    variant: 'digitize',
    displayName: 'Handwritten Document Digitization',
    recipeId: 'recipe-ingest-digitize-v1',
    requiredSlot: 'vision',
    validateOutput: (data) => OutputValidator.validateProviderOutput('ingest', 'digitize', data),
  },
  {
    brdCaseId: 'DOC-01-04',
    action: 'ingest',
    variant: 'split',
    displayName: 'Bounded PDF Page Splitting',
    recipeId: 'recipe-ingest-split-v1',
    requiredSlot: undefined,
    validateOutput: (data) => OutputValidator.validateProviderOutput('ingest', 'split', data),
  },

  // DOC-02: Extract (5)
  {
    brdCaseId: 'DOC-02-01',
    action: 'extract',
    variant: 'invoice',
    displayName: 'Invoice Entity & Line-item Extraction',
    recipeId: 'recipe-extract-invoice-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('extract', 'invoice', data),
  },
  {
    brdCaseId: 'DOC-02-02',
    action: 'extract',
    variant: 'contract',
    displayName: 'Contract Clause & Party Extraction',
    recipeId: 'recipe-extract-contract-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('extract', 'contract', data),
  },
  {
    brdCaseId: 'DOC-02-03',
    action: 'extract',
    variant: 'receipt',
    displayName: 'Receipt Merchant & Total Extraction',
    recipeId: 'recipe-extract-receipt-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('extract', 'receipt', data),
  },
  {
    brdCaseId: 'DOC-02-04',
    action: 'extract',
    variant: 'table',
    displayName: 'Tabular Structure Extraction',
    recipeId: 'recipe-extract-table-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('extract', 'table', data),
  },
  {
    brdCaseId: 'DOC-02-05',
    action: 'extract',
    variant: 'custom',
    displayName: 'Custom JSON-Schema Extraction',
    recipeId: 'recipe-extract-custom-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data, schema) => OutputValidator.validateProviderOutput('extract', 'custom', data, schema),
  },

  // DOC-03: Analyze (5)
  {
    brdCaseId: 'DOC-03-01',
    action: 'analyze',
    variant: 'classify',
    displayName: 'Taxonomy Document Classification',
    recipeId: 'recipe-analyze-classify-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('analyze', 'classify', data),
  },
  {
    brdCaseId: 'DOC-03-02',
    action: 'analyze',
    variant: 'sentiment',
    displayName: 'Tone & Sentiment Analysis',
    recipeId: 'recipe-analyze-sentiment-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('analyze', 'sentiment', data),
  },
  {
    brdCaseId: 'DOC-03-03',
    action: 'analyze',
    variant: 'compliance',
    displayName: 'Regulatory & Rule Compliance Audit',
    recipeId: 'recipe-analyze-compliance-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('analyze', 'compliance', data),
  },
  {
    brdCaseId: 'DOC-03-04',
    action: 'analyze',
    variant: 'quality',
    displayName: 'Document Clarity & Completeness Quality Score',
    recipeId: 'recipe-analyze-quality-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('analyze', 'quality', data),
  },
  {
    brdCaseId: 'DOC-03-05',
    action: 'analyze',
    variant: 'risk',
    displayName: 'Contractual & Operational Risk Assessment',
    recipeId: 'recipe-analyze-risk-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('analyze', 'risk', data),
  },

  // DOC-04: Transform (5)
  {
    brdCaseId: 'DOC-04-01',
    action: 'transform',
    variant: 'convert',
    displayName: 'Native In-Memory Format Conversion',
    recipeId: 'recipe-transform-convert-v1',
    requiredSlot: undefined,
    validateOutput: (data) => OutputValidator.validateProviderOutput('transform', 'convert', data),
  },
  {
    brdCaseId: 'DOC-04-02',
    action: 'transform',
    variant: 'translate',
    displayName: 'Multi-lingual Document Translation',
    recipeId: 'recipe-transform-translate-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('transform', 'translate', data),
  },
  {
    brdCaseId: 'DOC-04-03',
    action: 'transform',
    variant: 'rewrite',
    displayName: 'Style & Tone Paraphrasing / Rewriting',
    recipeId: 'recipe-transform-rewrite-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('transform', 'rewrite', data),
  },
  {
    brdCaseId: 'DOC-04-04',
    action: 'transform',
    variant: 'redact',
    displayName: 'PII Redaction & Sanitization',
    recipeId: 'recipe-transform-redact-v1',
    requiredSlot: undefined,
    validateOutput: (data) => OutputValidator.validateProviderOutput('transform', 'redact', data),
  },
  {
    brdCaseId: 'DOC-04-05',
    action: 'transform',
    variant: 'template',
    displayName: 'Variable Template Merging',
    recipeId: 'recipe-transform-template-v1',
    requiredSlot: undefined,
    validateOutput: (data) => OutputValidator.validateProviderOutput('transform', 'template', data),
  },

  // DOC-05: Generate (6)
  {
    brdCaseId: 'DOC-05-01',
    action: 'generate',
    variant: 'summary',
    displayName: 'Extractive & Abstractive Summarization',
    recipeId: 'recipe-generate-summary-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('generate', 'summary', data),
  },
  {
    brdCaseId: 'DOC-05-02',
    action: 'generate',
    variant: 'outline',
    displayName: 'Document Structural Outline Synthesis',
    recipeId: 'recipe-generate-outline-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('generate', 'outline', data),
  },
  {
    brdCaseId: 'DOC-05-03',
    action: 'generate',
    variant: 'report',
    displayName: 'Executive Report Generation',
    recipeId: 'recipe-generate-report-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('generate', 'report', data),
  },
  {
    brdCaseId: 'DOC-05-04',
    action: 'generate',
    variant: 'email',
    displayName: 'Formal Communication / Email Drafting',
    recipeId: 'recipe-generate-email-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('generate', 'email', data),
  },
  {
    brdCaseId: 'DOC-05-05',
    action: 'generate',
    variant: 'minutes',
    displayName: 'Meeting Minutes & Action Items Synthesis',
    recipeId: 'recipe-generate-minutes-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('generate', 'minutes', data),
  },
  {
    brdCaseId: 'DOC-05-06',
    action: 'generate',
    variant: 'qa',
    displayName: 'Document-Grounded Question Answering',
    recipeId: 'recipe-generate-qa-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('generate', 'qa', data),
  },

  // DOC-06: Compare (3)
  {
    brdCaseId: 'DOC-06-01',
    action: 'compare',
    variant: 'diff',
    displayName: 'Lexical Unified Line & Word Diffing',
    recipeId: 'recipe-compare-diff-v1',
    requiredSlot: undefined,
    validateOutput: (data) => OutputValidator.validateProviderOutput('compare', 'diff', data),
  },
  {
    brdCaseId: 'DOC-06-02',
    action: 'compare',
    variant: 'semantic',
    displayName: 'Semantic Similarity & Meaning Comparison',
    recipeId: 'recipe-compare-semantic-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('compare', 'semantic', data),
  },
  {
    brdCaseId: 'DOC-06-03',
    action: 'compare',
    variant: 'version',
    displayName: 'Document Revision & Changelog Tracking',
    recipeId: 'recipe-compare-version-v1',
    requiredSlot: 'reasoning',
    validateOutput: (data) => OutputValidator.validateProviderOutput('compare', 'version', data),
  },
];

/**
 * Validates that the entire 28-variant traceability matrix is internally consistent,
 * matches the manifest action schemas and declared connector slots, and maps to defined recipes.
 */
export function verifyTraceabilityMatrix(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const seenCaseIds = new Set<string>();
  const seenActionVariants = new Set<string>();

  if (VARIANT_TRACEABILITY_MATRIX.length !== 28) {
    errors.push(`Expected exactly 28 variants in traceability matrix, found ${VARIANT_TRACEABILITY_MATRIX.length}`);
  }

  const manifestActionsByName = new Map(documentCoreManifest.actions.map((a) => [a.name, a]));

  for (const entry of VARIANT_TRACEABILITY_MATRIX) {
    // 1. Duplicate checks
    if (seenCaseIds.has(entry.brdCaseId)) {
      errors.push(`Duplicate BRD case ID: ${entry.brdCaseId}`);
    }
    seenCaseIds.add(entry.brdCaseId);

    const actionVariantKey = `${entry.action}:${entry.variant}`;
    if (seenActionVariants.has(actionVariantKey)) {
      errors.push(`Duplicate action:variant pair: ${actionVariantKey}`);
    }
    seenActionVariants.add(actionVariantKey);

    // 2. Manifest action match
    const manifestAction = manifestActionsByName.get(entry.action);
    if (!manifestAction) {
      errors.push(`Action "${entry.action}" not declared in manifest`);
      continue;
    }

    // 3. Recipe match
    let recipe: RecipeDefinition | undefined;
    try {
      recipe = RecipeRegistry.getRecipe(entry.action, entry.variant);
      if (recipe.recipeId !== entry.recipeId) {
        errors.push(
          `Recipe ID mismatch for ${actionVariantKey}: matrix has "${entry.recipeId}", registry has "${recipe.recipeId}"`
        );
      }
    } catch (e: any) {
      errors.push(`Missing recipe in RecipeRegistry for ${actionVariantKey}: ${e.message}`);
    }

    // 4. Connector slot match
    if (entry.requiredSlot) {
      const declaredSlot = manifestAction.connectorSlots.find((s) => s.name === entry.requiredSlot);
      if (!declaredSlot) {
        errors.push(
          `Variant ${actionVariantKey} routes to slot "${entry.requiredSlot}" but action "${entry.action}" does not declare it in manifest`
        );
      }
    }

    // 5. Output validator presence
    if (typeof entry.validateOutput !== 'function') {
      errors.push(`Variant ${actionVariantKey} lacks an output validator function`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
