import { validateManifest } from '@du/contracts';
import {
  advanceDocCompare,
  createDocCompareRuntime,
  DEFAULT_DOC_COMPARE_BINDING,
  DOC_COMPARE_STEP_IDS,
} from '../src';
import { documentCoreManifest } from '../src/manifest/document-core.manifest';
import { RecipeRegistry } from '../src/recipes/recipe-definitions';
import { STEP_KEYS } from '../src/recipes/step-keys';
import { documentCoreHandlers } from '../src/worker';

describe('P9-03 doc-compare registration', () => {
  it('declares the workflow action with the single reasoning slot the runner binds', () => {
    expect(validateManifest(documentCoreManifest).ok).toBe(true);

    const action = documentCoreManifest.actions.find((candidate) => candidate.name === 'doc-compare');
    expect(action).toBeDefined();
    // One slot, not two: DEFAULT_DOC_COMPARE_BINDING drives both stages through
    // `reasoning` and switches the provider task per stage instead.
    expect(action!.connectorSlots.map((slot) => slot.name)).toEqual(['reasoning']);
    expect(action!.connectorSlots.every((slot) => slot.required)).toBe(true);
    expect(DEFAULT_DOC_COMPARE_BINDING.slot).toBe('reasoning');

    expect((action!.inputSchema as { required: string[] }).required).toEqual([
      'inputVersion',
      'left',
      'right',
    ]);
    expect(action!.outputSchema.required).toEqual([
      'resultVersion',
      'businessId',
      'businessVersion',
      'evidence',
      'incompleteChunks',
    ]);
  });

  it('registers the handler kind in the manifest and in the handler map', () => {
    expect(documentCoreManifest.runtime.handlerKinds).toContain('doc-compare');
    expect(typeof documentCoreHandlers['doc-compare']).toBe('function');
  });

  it('selects the four workflow stages with stable identifiers matching the module step ids', () => {
    const recipe = RecipeRegistry.getWorkflowRecipe('doc-compare');
    expect(recipe).toMatchObject({ action: 'doc-compare', variant: 'workflow' });
    expect(recipe.steps.map((step) => step.stepKey)).toEqual([
      STEP_KEYS.DOC_COMPARE.EXTRACT_STRUCTURE,
      STEP_KEYS.DOC_COMPARE.COMPARE_STRUCTURE,
      STEP_KEYS.DOC_COMPARE.COMPARE_REFERENCES,
      STEP_KEYS.DOC_COMPARE.MERGE_EVIDENCE,
    ]);
    expect(recipe.steps.map((step) => step.requiredSlot ?? null)).toEqual([
      null,
      'reasoning',
      'reasoning',
      null,
    ]);
    expect(Object.values(STEP_KEYS.DOC_COMPARE)).toEqual([
      DOC_COMPARE_STEP_IDS.extractStructure,
      DOC_COMPARE_STEP_IDS.compareStructure,
      DOC_COMPARE_STEP_IDS.compareReferences,
      DOC_COMPARE_STEP_IDS.mergeEvidence,
    ]);
  });

  it('keeps the workflow recipe out of the 31 document variants', () => {
    const variants = RecipeRegistry.getAllRecipes();
    expect(variants).toHaveLength(31);
    expect(variants.some((recipe) => recipe.action === 'doc-compare')).toBe(false);
  });

  it('exports the typed entry points from the package barrel', () => {
    // The runner used to be reachable only by importing ./runner deep; the
    // barrel re-export is what lets a host adopt the workflow without it.
    expect(typeof advanceDocCompare).toBe('function');
    expect(typeof createDocCompareRuntime).toBe('function');
  });

  it('treats the provider task names as overridable defaults, not as wire', () => {
    expect(DEFAULT_DOC_COMPARE_BINDING.structureTask).toBe('doc_compare_structure');
    expect(DEFAULT_DOC_COMPARE_BINDING.referenceTask).toBe('doc_compare_references');
  });
});
