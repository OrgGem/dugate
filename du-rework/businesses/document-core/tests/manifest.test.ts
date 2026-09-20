import { documentCoreManifest } from '../src/manifest/document-core.manifest';
import { RecipeRegistry } from '../src/recipes/recipe-definitions';
import { validateManifest, hashManifest, WIRE_CONTRACT_VERSION } from '@du/contracts';

describe('Document Core Manifest & Recipe Registry (P5-01)', () => {
  it('validates documentCoreManifest strictly against @du/contracts v1 validator', () => {
    const result = validateManifest(documentCoreManifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.digest).toBeDefined();
      expect(result.digest).toBe(hashManifest(documentCoreManifest));
      expect(result.queue).toBe('du-business-document-core-1.0.0');
    }
  });

  it('manifest specifies contractVersion 1 and exact businessId', () => {
    expect(documentCoreManifest.contractVersion).toBe(WIRE_CONTRACT_VERSION);
    expect(documentCoreManifest.businessId).toBe('document-core');
    expect(documentCoreManifest.version).toBe('1.0.0');
    expect(documentCoreManifest.imageDigest).toBeDefined();
    expect(documentCoreManifest.capabilities).toEqual({
      cancel: true,
      resume: true,
      parallel: true,
    });
  });

  it('manifest declares all 6 actions', () => {
    const actionNames = documentCoreManifest.actions.map((a) => a.name);
    expect(actionNames).toEqual([
      'ingest',
      'extract',
      'analyze',
      'transform',
      'generate',
      'compare',
    ]);
  });

  it('recipe registry contains exactly 28 unique variants', () => {
    const allRecipes = RecipeRegistry.getAllRecipes();
    expect(allRecipes.length).toBe(28);

    const counts: Record<string, number> = {};
    for (const r of allRecipes) {
      counts[r.action] = (counts[r.action] || 0) + 1;
    }

    expect(counts['ingest']).toBe(4);
    expect(counts['extract']).toBe(5);
    expect(counts['analyze']).toBe(5);
    expect(counts['transform']).toBe(5);
    expect(counts['generate']).toBe(6);
    expect(counts['compare']).toBe(3);
  });

  it('all recipes have non-empty stable step keys and valid retry budgets', () => {
    const allRecipes = RecipeRegistry.getAllRecipes();
    for (const r of allRecipes) {
      expect(r.steps.length).toBeGreaterThan(1);
      expect(r.retryBudget).toBeGreaterThanOrEqual(1);
      for (const step of r.steps) {
        expect(step.stepKey).toContain(r.action);
        expect(step.timeoutSeconds).toBeGreaterThan(0);
      }
    }
  });
});
