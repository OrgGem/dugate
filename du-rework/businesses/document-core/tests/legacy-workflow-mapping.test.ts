import {
  LegacyWorkflowMappingError,
  resolveLegacySchemaSlug,
  resolveLegacyWorkflow,
  type LegacyWorkflowMappingErrorCode,
  type RegisteredSchemaWorkflow,
} from '../src';

function registeredSchema(overrides: Partial<RegisteredSchemaWorkflow> = {}): RegisteredSchemaWorkflow {
  return {
    schemaSlug: 'invoice-review',
    businessId: 'schema-invoice-review',
    businessVersion: '2.1.0',
    action: 'schema-workflow',
    profile: 'profile-invoice-review-v2',
    status: 'active',
    recipeSelectors: [
      { action: 'extract', variant: 'invoice' },
      { action: 'analyze', variant: 'risk' },
    ],
    ...overrides,
  };
}

function expectMappingError(action: () => unknown, code: LegacyWorkflowMappingErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LegacyWorkflowMappingError);
  expect(caught).toMatchObject({ code });
}

describe('legacy workflow and schema recipe mapping', () => {
  it.each([
    ['simple-extraction', 'extract', ['recipe-extract-custom-v1']],
    [
      'multi-step-analysis',
      'analyze',
      ['recipe-analyze-classify-v1', 'recipe-analyze-compliance-v1', 'recipe-analyze-risk-v1'],
    ],
    ['transform-compare', 'transform', ['recipe-transform-rewrite-v1', 'recipe-compare-diff-v1']],
  ] as const)(
    'maps legacy process %s to its business binding and executable recipe sequence',
    (process, action, recipeIds) => {
      const mapping = resolveLegacyWorkflow(process);

      expect(mapping).toMatchObject({
        process,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action,
        profile: `legacy-${process}-v1`,
      });
      expect(mapping.recipes.map((recipe) => recipe.recipeId)).toEqual(recipeIds);
      expect(mapping.recipes.map((recipe) => `${recipe.action}:${recipe.variant}`)).toEqual(
        mapping.recipeSelectors.map((selector) => `${selector.action}:${selector.variant}`)
      );
    }
  );

  it('rejects missing and unknown legacy process names instead of choosing a default recipe', () => {
    expectMappingError(() => resolveLegacyWorkflow('  '), 'WORKFLOW_PROCESS_REQUIRED');
    expectMappingError(() => resolveLegacyWorkflow('unknown-workflow'), 'WORKFLOW_NOT_REGISTERED');
    expectMappingError(() => resolveLegacyWorkflow(null), 'WORKFLOW_PROCESS_REQUIRED');
  });

  it('returns independent executable recipe descriptors on each resolution', () => {
    const first = resolveLegacyWorkflow('transform-compare');
    const originalStepKey = first.recipes[0]?.steps[0]?.stepKey;
    if (first.recipes[0]?.steps[0]) first.recipes[0].steps[0].stepKey = 'mutated-test-copy';

    const next = resolveLegacyWorkflow('transform-compare');
    expect(next.recipes[0]?.steps[0]?.stepKey).toBe(originalStepKey);
  });

  it('resolves a schemaSlug to its active registered business and executable recipes', () => {
    const mapping = resolveLegacySchemaSlug(' invoice-review ', [registeredSchema()]);

    expect(mapping).toMatchObject({
      schemaSlug: 'invoice-review',
      businessId: 'schema-invoice-review',
      businessVersion: '2.1.0',
      action: 'schema-workflow',
      profile: 'profile-invoice-review-v2',
      status: 'active',
    });
    expect(mapping.recipes.map((recipe) => recipe.recipeId)).toEqual([
      'recipe-extract-invoice-v1',
      'recipe-analyze-risk-v1',
    ]);
  });

  it('fails closed for blank, unknown, retired, or ambiguous schema slugs', () => {
    const registration = registeredSchema();

    expectMappingError(() => resolveLegacySchemaSlug(' ', [registration]), 'SCHEMA_SLUG_REQUIRED');
    expectMappingError(() => resolveLegacySchemaSlug('missing-schema', [registration]), 'SCHEMA_NOT_REGISTERED');
    expectMappingError(
      () => resolveLegacySchemaSlug('invoice-review', [registeredSchema({ status: 'retired' })]),
      'SCHEMA_NOT_ACTIVE'
    );
    expectMappingError(
      () => resolveLegacySchemaSlug('invoice-review', [registration, registration]),
      'SCHEMA_MAPPING_AMBIGUOUS'
    );
  });

  it('rejects incomplete schema business metadata and recipe selectors outside the registry', () => {
    expectMappingError(
      () => resolveLegacySchemaSlug('invoice-review', [registeredSchema({ profile: '  ' })]),
      'SCHEMA_MAPPING_INVALID'
    );

    const unavailableRecipe = registeredSchema({
      recipeSelectors: [{ action: 'analyze', variant: 'unregistered-variant' }],
    });
    expectMappingError(() => resolveLegacySchemaSlug('invoice-review', [unavailableRecipe]), 'RECIPE_NOT_EXECUTABLE');

    const missingSelectors = {
      ...registeredSchema(),
      recipeSelectors: undefined,
    } as unknown as RegisteredSchemaWorkflow;
    expectMappingError(() => resolveLegacySchemaSlug('invoice-review', [missingSelectors]), 'SCHEMA_MAPPING_INVALID');
  });

  it('rejects duplicate recipe selectors in a registered schema mapping', () => {
    const duplicateRecipes = registeredSchema({
      recipeSelectors: [
        { action: 'extract', variant: 'invoice' },
        { action: 'extract', variant: 'invoice' },
      ],
    });

    expectMappingError(() => resolveLegacySchemaSlug('invoice-review', [duplicateRecipes]), 'SCHEMA_MAPPING_INVALID');
  });
});
