import { documentCoreManifest } from '../manifest/document-core.manifest';
import { RecipeRegistry, type RecipeDefinition } from '../recipes/recipe-definitions';

export type LegacyWorkflowProcess = 'simple-extraction' | 'multi-step-analysis' | 'transform-compare';
export type ExecutableAction = RecipeDefinition['action'] | 'schema-workflow';

export interface RecipeSelector {
  action: RecipeDefinition['action'];
  variant: string;
}

export interface LegacyWorkflowMapping {
  process: LegacyWorkflowProcess;
  businessId: string;
  businessVersion: string;
  action: RecipeDefinition['action'];
  profile: string;
  recipeSelectors: readonly RecipeSelector[];
  recipes: RecipeDefinition[];
}

export interface RegisteredSchemaWorkflow {
  schemaSlug: string;
  businessId: string;
  businessVersion: string;
  action: string;
  profile: string;
  status: 'active' | 'retired';
  recipeSelectors: readonly RecipeSelector[];
}

export interface ResolvedSchemaWorkflow extends RegisteredSchemaWorkflow {
  recipes: RecipeDefinition[];
}

export type LegacyWorkflowMappingErrorCode =
  | 'WORKFLOW_PROCESS_REQUIRED'
  | 'WORKFLOW_NOT_REGISTERED'
  | 'SCHEMA_SLUG_REQUIRED'
  | 'SCHEMA_NOT_REGISTERED'
  | 'SCHEMA_MAPPING_AMBIGUOUS'
  | 'SCHEMA_NOT_ACTIVE'
  | 'SCHEMA_MAPPING_INVALID'
  | 'RECIPE_NOT_EXECUTABLE';

export class LegacyWorkflowMappingError extends Error {
  public readonly code: LegacyWorkflowMappingErrorCode;

  constructor(message: string, code: LegacyWorkflowMappingErrorCode) {
    super(message);
    this.name = 'LegacyWorkflowMappingError';
    this.code = code;
  }
}

const WORKFLOW_SELECTORS: Record<LegacyWorkflowProcess, Omit<LegacyWorkflowMapping, 'recipes'>> = {
  'simple-extraction': {
    process: 'simple-extraction',
    businessId: documentCoreManifest.businessId,
    businessVersion: documentCoreManifest.version,
    action: 'extract',
    profile: 'legacy-simple-extraction-v1',
    recipeSelectors: [{ action: 'extract', variant: 'custom' }],
  },
  'multi-step-analysis': {
    process: 'multi-step-analysis',
    businessId: documentCoreManifest.businessId,
    businessVersion: documentCoreManifest.version,
    action: 'analyze',
    profile: 'legacy-multi-step-analysis-v1',
    recipeSelectors: [
      { action: 'analyze', variant: 'classify' },
      { action: 'analyze', variant: 'compliance' },
      { action: 'analyze', variant: 'risk' },
    ],
  },
  'transform-compare': {
    process: 'transform-compare',
    businessId: documentCoreManifest.businessId,
    businessVersion: documentCoreManifest.version,
    action: 'transform',
    profile: 'legacy-transform-compare-v1',
    recipeSelectors: [
      { action: 'transform', variant: 'rewrite' },
      { action: 'compare', variant: 'diff' },
    ],
  },
};

function copyRecipe(recipe: RecipeDefinition): RecipeDefinition {
  return {
    ...recipe,
    steps: recipe.steps.map((step) => ({ ...step })),
  };
}

function resolveRecipes(
  selectors: readonly RecipeSelector[],
  mappingName: string
): RecipeDefinition[] {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new LegacyWorkflowMappingError(
      `Workflow mapping "${mappingName}" has no executable recipes`,
      'SCHEMA_MAPPING_INVALID'
    );
  }

  const seen = new Set<string>();
  return selectors.map((selector) => {
    if (
      !selector ||
      typeof selector.action !== 'string' ||
      typeof selector.variant !== 'string' ||
      selector.variant.trim().length === 0
    ) {
      throw new LegacyWorkflowMappingError(
        `Workflow mapping "${mappingName}" contains an invalid recipe selector`,
        'SCHEMA_MAPPING_INVALID'
      );
    }

    const key = `${selector.action}:${selector.variant}`;
    if (seen.has(key)) {
      throw new LegacyWorkflowMappingError(
        `Workflow mapping "${mappingName}" repeats recipe "${key}"`,
        'SCHEMA_MAPPING_INVALID'
      );
    }
    seen.add(key);

    try {
      return copyRecipe(RecipeRegistry.getRecipe(selector.action, selector.variant));
    } catch {
      throw new LegacyWorkflowMappingError(
        `Workflow mapping "${mappingName}" references an unregistered recipe "${key}"`,
        'RECIPE_NOT_EXECUTABLE'
      );
    }
  });
}

/** Resolves one of the legacy workflow names to document-core executable recipes. */
export function resolveLegacyWorkflow(process: unknown): LegacyWorkflowMapping {
  if (typeof process !== 'string' || process.trim().length === 0) {
    throw new LegacyWorkflowMappingError(
      'A legacy workflow process name is required',
      'WORKFLOW_PROCESS_REQUIRED'
    );
  }

  const normalizedProcess = process.trim();
  if (!Object.prototype.hasOwnProperty.call(WORKFLOW_SELECTORS, normalizedProcess)) {
    throw new LegacyWorkflowMappingError(
      `Legacy workflow process "${normalizedProcess}" is not registered`,
      'WORKFLOW_NOT_REGISTERED'
    );
  }

  const mapping = WORKFLOW_SELECTORS[normalizedProcess as LegacyWorkflowProcess];
  return {
    ...mapping,
    recipeSelectors: mapping.recipeSelectors.map((selector) => ({ ...selector })),
    recipes: resolveRecipes(mapping.recipeSelectors, normalizedProcess),
  };
}

/**
 * Resolves a legacy schema slug only through the caller's registered, active schema
 * businesses. User-provided slugs never become recipe names or executable code.
 */
export function resolveLegacySchemaSlug(
  schemaSlug: unknown,
  registrations: readonly RegisteredSchemaWorkflow[]
): ResolvedSchemaWorkflow {
  if (typeof schemaSlug !== 'string' || schemaSlug.trim().length === 0) {
    throw new LegacyWorkflowMappingError('A schemaSlug is required', 'SCHEMA_SLUG_REQUIRED');
  }

  const normalizedSlug = schemaSlug.trim();
  if (!Array.isArray(registrations)) {
    throw new LegacyWorkflowMappingError(
      'Registered schema mappings must be provided as a list',
      'SCHEMA_MAPPING_INVALID'
    );
  }
  const registeredSchemas = registrations as readonly RegisteredSchemaWorkflow[];
  const matches = registeredSchemas.filter(
    (registration) => typeof registration?.schemaSlug === 'string' && registration.schemaSlug.trim() === normalizedSlug
  );
  if (matches.length === 0) {
    throw new LegacyWorkflowMappingError(
      `Schema workflow "${normalizedSlug}" is not registered`,
      'SCHEMA_NOT_REGISTERED'
    );
  }
  if (matches.length > 1) {
    throw new LegacyWorkflowMappingError(
      `Schema workflow "${normalizedSlug}" has ambiguous registrations`,
      'SCHEMA_MAPPING_AMBIGUOUS'
    );
  }

  const registration = matches[0];
  if (!registration) {
    throw new LegacyWorkflowMappingError(
      `Schema workflow "${normalizedSlug}" is not registered`,
      'SCHEMA_NOT_REGISTERED'
    );
  }
  if (registration.status !== 'active') {
    throw new LegacyWorkflowMappingError(
      `Schema workflow "${normalizedSlug}" is not active`,
      'SCHEMA_NOT_ACTIVE'
    );
  }

  const requiredFields = [
    registration.schemaSlug,
    registration.businessId,
    registration.businessVersion,
    registration.action,
    registration.profile,
  ];
  if (requiredFields.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new LegacyWorkflowMappingError(
      `Schema workflow "${normalizedSlug}" has incomplete business mapping metadata`,
      'SCHEMA_MAPPING_INVALID'
    );
  }

  const recipes = resolveRecipes(registration.recipeSelectors, normalizedSlug);

  return {
    ...registration,
    schemaSlug: normalizedSlug,
    recipeSelectors: registration.recipeSelectors.map((selector) => ({ ...selector })),
    recipes,
  };
}
