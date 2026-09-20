/**
 * Recipe descriptors for all 28 variants.
 */

export interface StepDefinition {
  stepKey: string;
  isLocalOnly: boolean;
  requiredSlot?: 'ocr' | 'reasoning' | 'vision';
  timeoutSeconds: number;
}

export interface RecipeDefinition {
  recipeId: string;
  action: 'ingest' | 'extract' | 'analyze' | 'transform' | 'generate' | 'compare';
  variant: string;
  steps: StepDefinition[];
  retryBudget: number;
}

export class RecipeRegistry {
  private static readonly RECIPES: Record<string, RecipeDefinition> = {
    // Ingest (4)
    'ingest:parse': {
      recipeId: 'recipe-ingest-parse-v1',
      action: 'ingest',
      variant: 'parse',
      steps: [
        { stepKey: 'ingest:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'ingest:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'ingest:execute-parse', isLocalOnly: true, timeoutSeconds: 120 },
        { stepKey: 'ingest:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 1,
    },
    'ingest:ocr': {
      recipeId: 'recipe-ingest-ocr-v1',
      action: 'ingest',
      variant: 'ocr',
      steps: [
        { stepKey: 'ingest:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'ingest:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'ingest:execute-ocr', isLocalOnly: false, requiredSlot: 'ocr', timeoutSeconds: 300 },
        { stepKey: 'ingest:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'ingest:digitize': {
      recipeId: 'recipe-ingest-digitize-v1',
      action: 'ingest',
      variant: 'digitize',
      steps: [
        { stepKey: 'ingest:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'ingest:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'ingest:execute-digitize', isLocalOnly: false, requiredSlot: 'vision', timeoutSeconds: 300 },
        { stepKey: 'ingest:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'ingest:split': {
      recipeId: 'recipe-ingest-split-v1',
      action: 'ingest',
      variant: 'split',
      steps: [
        { stepKey: 'ingest:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'ingest:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'ingest:execute-split', isLocalOnly: true, timeoutSeconds: 120 },
        { stepKey: 'ingest:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 1,
    },

    // Extract (5)
    'extract:invoice': {
      recipeId: 'recipe-extract-invoice-v1',
      action: 'extract',
      variant: 'invoice',
      steps: [
        { stepKey: 'extract:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'extract:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'extract:validate-schema', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'extract:contract': {
      recipeId: 'recipe-extract-contract-v1',
      action: 'extract',
      variant: 'contract',
      steps: [
        { stepKey: 'extract:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'extract:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'extract:validate-schema', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'extract:receipt': {
      recipeId: 'recipe-extract-receipt-v1',
      action: 'extract',
      variant: 'receipt',
      steps: [
        { stepKey: 'extract:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'extract:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'extract:validate-schema', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'extract:table': {
      recipeId: 'recipe-extract-table-v1',
      action: 'extract',
      variant: 'table',
      steps: [
        { stepKey: 'extract:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'extract:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'extract:validate-schema', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'extract:custom': {
      recipeId: 'recipe-extract-custom-v1',
      action: 'extract',
      variant: 'custom',
      steps: [
        { stepKey: 'extract:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'extract:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'extract:validate-schema', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'extract:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },

    // Analyze (5)
    'analyze:classify': {
      recipeId: 'recipe-analyze-classify-v1',
      action: 'analyze',
      variant: 'classify',
      steps: [
        { stepKey: 'analyze:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'analyze:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'analyze:validate-findings', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'analyze:sentiment': {
      recipeId: 'recipe-analyze-sentiment-v1',
      action: 'analyze',
      variant: 'sentiment',
      steps: [
        { stepKey: 'analyze:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'analyze:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'analyze:validate-findings', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'analyze:compliance': {
      recipeId: 'recipe-analyze-compliance-v1',
      action: 'analyze',
      variant: 'compliance',
      steps: [
        { stepKey: 'analyze:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'analyze:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'analyze:validate-findings', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'analyze:quality': {
      recipeId: 'recipe-analyze-quality-v1',
      action: 'analyze',
      variant: 'quality',
      steps: [
        { stepKey: 'analyze:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'analyze:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'analyze:validate-findings', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'analyze:risk': {
      recipeId: 'recipe-analyze-risk-v1',
      action: 'analyze',
      variant: 'risk',
      steps: [
        { stepKey: 'analyze:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'analyze:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'analyze:validate-findings', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'analyze:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },

    // Transform (5)
    'transform:convert': {
      recipeId: 'recipe-transform-convert-v1',
      action: 'transform',
      variant: 'convert',
      steps: [
        { stepKey: 'transform:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'transform:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'transform:execute-local-convert', isLocalOnly: true, timeoutSeconds: 120 },
        { stepKey: 'transform:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 1,
    },
    'transform:translate': {
      recipeId: 'recipe-transform-translate-v1',
      action: 'transform',
      variant: 'translate',
      steps: [
        { stepKey: 'transform:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'transform:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'transform:execute-translate', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'transform:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'transform:rewrite': {
      recipeId: 'recipe-transform-rewrite-v1',
      action: 'transform',
      variant: 'rewrite',
      steps: [
        { stepKey: 'transform:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'transform:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'transform:execute-rewrite', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'transform:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'transform:redact': {
      recipeId: 'recipe-transform-redact-v1',
      action: 'transform',
      variant: 'redact',
      steps: [
        { stepKey: 'transform:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'transform:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'transform:execute-redact', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'transform:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 1,
    },
    'transform:template': {
      recipeId: 'recipe-transform-template-v1',
      action: 'transform',
      variant: 'template',
      steps: [
        { stepKey: 'transform:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'transform:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'transform:execute-template', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'transform:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 1,
    },

    // Generate (6)
    'generate:summary': {
      recipeId: 'recipe-generate-summary-v1',
      action: 'generate',
      variant: 'summary',
      steps: [
        { stepKey: 'generate:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'generate:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'generate:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'generate:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'generate:outline': {
      recipeId: 'recipe-generate-outline-v1',
      action: 'generate',
      variant: 'outline',
      steps: [
        { stepKey: 'generate:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'generate:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'generate:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'generate:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'generate:report': {
      recipeId: 'recipe-generate-report-v1',
      action: 'generate',
      variant: 'report',
      steps: [
        { stepKey: 'generate:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'generate:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'generate:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'generate:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'generate:email': {
      recipeId: 'recipe-generate-email-v1',
      action: 'generate',
      variant: 'email',
      steps: [
        { stepKey: 'generate:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'generate:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'generate:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'generate:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'generate:minutes': {
      recipeId: 'recipe-generate-minutes-v1',
      action: 'generate',
      variant: 'minutes',
      steps: [
        { stepKey: 'generate:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'generate:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'generate:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'generate:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'generate:qa': {
      recipeId: 'recipe-generate-qa-v1',
      action: 'generate',
      variant: 'qa',
      steps: [
        { stepKey: 'generate:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'generate:prepare-source', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'generate:connector-inference', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'generate:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },

    // Compare (3)
    'compare:diff': {
      recipeId: 'recipe-compare-diff-v1',
      action: 'compare',
      variant: 'diff',
      steps: [
        { stepKey: 'compare:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'compare:prepare-sources', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'compare:execute-diff', isLocalOnly: true, timeoutSeconds: 120 },
        { stepKey: 'compare:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 1,
    },
    'compare:semantic': {
      recipeId: 'recipe-compare-semantic-v1',
      action: 'compare',
      variant: 'semantic',
      steps: [
        { stepKey: 'compare:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'compare:prepare-sources', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'compare:execute-semantic', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'compare:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
    'compare:version': {
      recipeId: 'recipe-compare-version-v1',
      action: 'compare',
      variant: 'version',
      steps: [
        { stepKey: 'compare:validate', isLocalOnly: true, timeoutSeconds: 30 },
        { stepKey: 'compare:prepare-sources', isLocalOnly: true, timeoutSeconds: 60 },
        { stepKey: 'compare:execute-version', isLocalOnly: false, requiredSlot: 'reasoning', timeoutSeconds: 300 },
        { stepKey: 'compare:finalize', isLocalOnly: true, timeoutSeconds: 30 },
      ],
      retryBudget: 2,
    },
  };

  public static getRecipe(action: string, variant: string): RecipeDefinition {
    const key = `${action}:${variant}`;
    const recipe = this.RECIPES[key];
    if (!recipe) {
      throw new Error(`Unknown recipe for action "${action}" and variant "${variant}"`);
    }
    return recipe;
  }

  public static getAllRecipes(): RecipeDefinition[] {
    return Object.values(this.RECIPES);
  }
}
