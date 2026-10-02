import { validateManifest } from '@du/contracts';
import { advanceDisbursement, DISBURSEMENT_STEP_IDS } from '../src';
import { documentCoreManifest } from '../src/manifest/document-core.manifest';
import { RecipeRegistry } from '../src/recipes/recipe-definitions';
import { STEP_KEYS } from '../src/recipes/step-keys';
import { InputNormalizer } from '../src/validation/input-normalizer';

describe('P9-01 disbursement registration', () => {
  it('declares the workflow action and the connector slots used by its stages', () => {
    expect(validateManifest(documentCoreManifest).ok).toBe(true);

    const action = documentCoreManifest.actions.find((candidate) => candidate.name === 'disbursement');
    expect(action).toBeDefined();
    expect(action!.connectorSlots.map((slot) => slot.name)).toEqual([
      'classify',
      'extract',
      'crosscheck',
      'report',
    ]);
    expect(action!.connectorSlots.every((slot) => slot.required)).toBe(true);

    expect(action!.outputSchema.required).toEqual([
      'resultVersion',
      'businessId',
      'businessVersion',
      'report',
      'crosscheck',
      'evidence',
      'failedChildren',
    ]);
  });

  it('selects the five workflow stages in order with stable identifiers and matching slots', () => {
    const recipe = RecipeRegistry.getWorkflowRecipe('disbursement');
    expect(recipe).toMatchObject({ action: 'disbursement', variant: 'workflow' });
    expect(recipe.steps.map((step) => step.stepKey)).toEqual([
      STEP_KEYS.DISBURSEMENT.CLASSIFY,
      STEP_KEYS.DISBURSEMENT.EXTRACT,
      STEP_KEYS.DISBURSEMENT.APPROVAL,
      STEP_KEYS.DISBURSEMENT.CROSSCHECK,
      STEP_KEYS.DISBURSEMENT.REPORT,
    ]);
    expect(recipe.steps.map((step) => step.requiredSlot ?? null)).toEqual([
      'classify',
      'extract',
      null,
      'crosscheck',
      'report',
    ]);
    expect([
      STEP_KEYS.DISBURSEMENT.CLASSIFY,
      STEP_KEYS.DISBURSEMENT.EXTRACT,
      STEP_KEYS.DISBURSEMENT.CROSSCHECK,
      STEP_KEYS.DISBURSEMENT.REPORT,
    ]).toEqual([
      DISBURSEMENT_STEP_IDS.classify,
      DISBURSEMENT_STEP_IDS.extract,
      DISBURSEMENT_STEP_IDS.crosscheck,
      DISBURSEMENT_STEP_IDS.report,
    ]);
    expect(STEP_KEYS.DISBURSEMENT.APPROVAL).toBe('disbursement:approval:v1');
  });

  it('accepts the new extract and analyze discriminators in the normalizer', () => {
    expect(InputNormalizer.normalizeExtract({ type: 'id-card', text: 'Identity document' }).type).toBe('id-card');
    expect(
      InputNormalizer.normalizeAnalyze({ task: 'fact-check', referenceData: { amount: 42 } }).task
    ).toBe('fact-check');
    expect(InputNormalizer.normalizeAnalyze({ task: 'summarize-eval', text: 'A short document.' }).task).toBe(
      'summarize-eval'
    );
  });

  it('exports the typed workflow entry point from the package barrel', () => {
    expect(typeof advanceDisbursement).toBe('function');
  });
});
