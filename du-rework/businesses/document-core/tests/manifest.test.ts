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

  it('rejects malformed manifest JSON text at the validation boundary', () => {
    const result = validateManifest('{"contractVersion":"1","actions":');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((problem) => problem.pointer === '$')).toBe(true);
  });

  it('rejects unsupported contract and runtime wire schema versions', () => {
    const unsupportedContract = validateManifest({
      ...documentCoreManifest,
      contractVersion: '2',
    });
    expect(unsupportedContract.ok).toBe(false);
    if (!unsupportedContract.ok) {
      expect(unsupportedContract.problems.some((problem) => problem.pointer.includes('contractVersion'))).toBe(true);
    }

    const unsupportedWire = validateManifest({
      ...documentCoreManifest,
      runtime: { ...documentCoreManifest.runtime, wireVersion: '2' },
    });
    expect(unsupportedWire.ok).toBe(false);
    if (!unsupportedWire.ok) {
      expect(unsupportedWire.problems.some((problem) => problem.pointer.includes('runtime.wireVersion'))).toBe(true);
    }
  });

  it('changes the manifest digest when artifact metadata hashes or policy are tampered with', () => {
    const original = validateManifest(documentCoreManifest);
    const tampered = JSON.parse(JSON.stringify(documentCoreManifest)) as typeof documentCoreManifest;
    tampered.imageDigest = `sha256:${'f'.repeat(64)}`;
    tampered.actions[0]!.artifactPolicy.maxFiles += 1;
    const result = validateManifest(tampered);

    expect(original.ok).toBe(true);
    expect(result.ok).toBe(true);
    if (original.ok && result.ok) {
      expect(result.digest).toBe(hashManifest(tampered));
      expect(result.digest).not.toBe(original.digest);
    }
  });

  it('rejects manifests missing required top-level sections', () => {
    const omit = (section: string): Record<string, unknown> => {
      const manifest = { ...documentCoreManifest } as unknown as Record<string, unknown>;
      delete manifest[section];
      return manifest;
    };

    for (const section of ['runtime', 'capabilities', 'actions']) {
      const result = validateManifest(omit(section));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems.some((problem) => problem.pointer.includes(section))).toBe(true);
      }
    }
  });

  test.failing('rejects an excessive maxFiles artifact count rather than accepting an unbounded policy', () => {
    const manifest = JSON.parse(JSON.stringify(documentCoreManifest)) as typeof documentCoreManifest;
    manifest.actions[0]!.artifactPolicy.maxFiles = Number.MAX_SAFE_INTEGER + 1;

    expect(validateManifest(manifest).ok).toBe(false);
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
