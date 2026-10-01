import { documentCoreHandlers } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';
import { RecipeRegistry, RecipeDefinition } from '../src/recipes/recipe-definitions';
import { IngestAction } from '../src/actions/ingest';
import { ExtractAction } from '../src/actions/extract';
import { AnalyzeAction } from '../src/actions/analyze';
import { TransformAction } from '../src/actions/transform';
import { GenerateAction } from '../src/actions/generate';
import { CompareAction } from '../src/actions/compare';
import type { ProfileSnapshot, ResultEnvelope } from '../src/types/results';

/**
 * FT-03 — Execution pin & recipe determinism, business side (functional, offline, zero DB).
 * Anchor: tasks/P2-orchestrator.md row P2-02 [ ] (PRF slice), and multi-container-e2e
 * version-pinning / connector-revision-pinning live tests (offline equivalent).
 *
 * Contract under test: the executed recipe/variant is pinned by the submission input
 * discriminator at submit time. Profile state, context versions and connector bindings
 * presented to the business must NEVER re-resolve a different recipe, variant or slot
 * between runs (or mid-flight) — the runtime relies on this for deterministic replay.
 *
 * Why functional-not-unit:
 *  - profile-binding-fixture.test.ts only exercises static slot derivation of the
 *    ProfileBindingFixtureClient;
 *  - the pin is a cross-boundary property (recipe selection → slot routing → finalize)
 *    that only the full handler path can demonstrate.
 */

const PIN_PROFILES: ProfileSnapshot[] = [
  {
    profileId: 'profile-pin-a',
    revision: 1,
    parameters: { temperature: 0 },
    slots: {},
    promptOverrides: {},
  },
  {
    profileId: 'profile-pin-b',
    revision: 7,
    parameters: { temperature: 1, maxTokens: 999 },
    slots: {
      reasoning: { connectorId: 'connector-A', revision: 2, model: 'model-a' },
      ocr: { connectorId: 'connector-B', revision: 5 },
      vision: { connectorId: 'connector-C', revision: 9 },
    },
  },
  {
    profileId: 'profile-pin-c',
    revision: 42,
    parameters: {},
    slots: {
      reasoning: { connectorId: 'connector-Z', revision: 99, model: 'model-z' },
      ocr: { connectorId: 'connector-Y', revision: 88 },
      vision: { connectorId: 'connector-X', revision: 77 },
    },
    promptOverrides: { extract_invoice: 'IGNORED-BY-BUSINESS' },
  },
];

function validatedInputOf(action: string, payload: Record<string, unknown>): unknown {
  switch (action) {
    case 'ingest':
      return IngestAction.validateInput(payload);
    case 'extract':
      return ExtractAction.validateInput(payload);
    case 'analyze':
      return AnalyzeAction.validateInput(payload);
    case 'transform':
      return TransformAction.validateInput(payload);
    case 'generate':
      return GenerateAction.validateInput(payload);
    case 'compare':
      return CompareAction.validateInput(payload);
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

function selectFor(action: string, input: unknown, profile?: ProfileSnapshot): RecipeDefinition {
  switch (action) {
    case 'ingest':
      return IngestAction.selectRecipe(input as never, profile);
    case 'extract':
      return ExtractAction.selectRecipe(input as never, profile);
    case 'analyze':
      return AnalyzeAction.selectRecipe(input as never, profile);
    case 'transform':
      return TransformAction.selectRecipe(input as never, profile);
    case 'generate':
      return GenerateAction.selectRecipe(input as never, profile);
    case 'compare':
      return CompareAction.selectRecipe(input as never, profile);
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

describe('FT-03 Execution Pin & Recipe Determinism (functional, P2-02 [ ] PRF slice)', () => {
  const variantsUnderTest: Array<[string, string, Record<string, unknown>]> = [
    ['ingest', 'parse', { mode: 'parse', text: '# A' }],
    ['ingest', 'ocr', { mode: 'ocr', text: '# A' }],
    ['extract', 'invoice', { type: 'invoice', text: 'INV' }],
    ['analyze', 'classify', { task: 'classify', text: 'x', categories: ['a', 'b'] }],
    ['transform', 'translate', { variant: 'translate', text: 'hi', targetLanguage: 'es' }],
    ['generate', 'summary', { task: 'summary', text: 'x' }],
    ['compare', 'diff', { mode: 'diff', source: { text: 'a' }, target: { text: 'b' } }],
  ];

  it('recipe selection is a pure function of the input discriminator across every action (no profile re-resolution)', () => {
    for (const [action, variant, payload] of variantsUnderTest) {
      const input = validatedInputOf(action, payload);
      const baseline = selectFor(action, input);
      for (const profile of PIN_PROFILES) {
        // A different profile (different slots/connectors/params/revision) must NOT
        // re-resolve the executed recipe: the business pins to the submit discriminator.
        expect(selectFor(action, input, profile).recipeId).toBe(baseline.recipeId);
        expect(selectFor(action, input, profile).variant).toBe(variant);
      }
      // Registry agrees on the same recipe id for the same discriminator
      expect(RecipeRegistry.getRecipe(action, variant).recipeId).toBe(baseline.recipeId);
    }
  });

  it('unchanged submit input yields the same recipe even when the profile changes between runs', () => {
    const input = TransformAction.validateInput({ variant: 'translate', text: 'bonjour', targetLanguage: 'en' });
    const runWith = (profile: ProfileSnapshot) => TransformAction.selectRecipe(input, profile);
    const first = runWith(PIN_PROFILES[0]!);
    const second = runWith(PIN_PROFILES[2]!);
    expect(second.recipeId).toBe(first.recipeId);
    expect(second.steps.map((s) => s.requiredSlot ?? null)).toEqual(first.steps.map((s) => s.requiredSlot ?? null));
  });

  it('handler slot routing is pinned by the recipe, not by context bindings (extract always routes reasoning)', async () => {
    for (const version of ['1.0.0', '9.9.9']) {
      const ctx = new MockTaskContext();
      ctx.businessVersion = version;
      ctx.defaultConnectorResponse = {
        invocationId: `inv-pin-${version}`,
        status: 'SUCCESS',
        data: {
          supplier: { name: 'ACME' },
          invoiceNumber: 'INV-PIN',
          total: 100,
        },
      };
      const disposition = await documentCoreHandlers.extract!(ctx, { type: 'invoice', text: 'pin me' });
      expect(disposition.kind).toBe('completed');
      // The business routes the reasoning slot per its pinned recipe, and never issues
      // a second call or re-resolves the slot from ctx.connectorBindings.
      expect(ctx.connectorInvocations.length).toBe(1);
      expect(ctx.connectorInvocations[0]!.slot).toBe('reasoning');
    }
  });

  it('context presentation changes between runs do not change the executed variant (deterministic replay precondition)', async () => {
    const runExtract = async (version: string, mockData: Record<string, unknown>) => {
      const ctx = new MockTaskContext();
      ctx.businessVersion = version;
      ctx.connectorBindings = { reasoning: version === '1.0.0' ? 'connector-A' : 'connector-Z' };
      ctx.defaultConnectorResponse = {
        invocationId: `inv-${version}`,
        status: 'SUCCESS',
        data: mockData,
      };
      const disposition = await documentCoreHandlers.extract!(ctx, { type: 'invoice', text: 'invoice-next' });
      expect(disposition.kind).toBe('completed');
      if (disposition.kind !== 'completed') {
        throw new Error(`Expected completed disposition, got ${disposition.kind}`);
      }
      const envelope = JSON.parse(
        ctx.artifactsStore.get(disposition.resultRef.replace('artifact://', ''))!.toString('utf8')
      ) as ResultEnvelope<{ invoiceNumber: string }>;
      return { ctx, envelope };
    };

    const run1 = await runExtract('1.0.0', { supplier: { name: 'ACME' }, invoiceNumber: 'INV-PIN-1', total: 100 });
    // A different snapshot: newer businessVersion, different binding target, different model output
    const run2 = await runExtract('2.0.0', { supplier: { name: 'ACME' }, invoiceNumber: 'INV-PIN-2', total: 200 });

    // Same variant executed (invoice) — the business pins to the submit discriminator
    expect(run2.envelope.data.invoiceNumber).toBe('INV-PIN-2');
    expect(run2.envelope.data.invoiceNumber).not.toBe(run1.envelope.data.invoiceNumber);
    expect(run2.envelope.provenance).toEqual(run1.envelope.provenance);
    // Each run routes the SAME pinned slot exactly once — no re-resolution, no duplicates
    expect(run1.ctx.connectorInvocations.map((i) => i.slot)).toEqual(['reasoning']);
    expect(run2.ctx.connectorInvocations.map((i) => i.slot)).toEqual(['reasoning']);
    expect(run1.ctx.connectorInvocations.length).toBe(1);
    expect(run2.ctx.connectorInvocations.length).toBe(1);
  });

  it('unregistered variant fails closed with an explicit error and no fallback recipe exists', () => {
    // Config-boundary pin: an action/variant outside the registry is never silently
    // remapped to another variant or profile default.
    expect(() => RecipeRegistry.getRecipe('ingest', 'scan')).toThrow(/Unknown recipe/);
    expect(() => RecipeRegistry.getRecipe('extract', 'ocr')).toThrow(/Unknown recipe/);
    expect(() => RecipeRegistry.getRecipe('compare', 'merge')).toThrow(/Unknown recipe/);
  });

  it('keeps the submitted recipe pin stable when execution profile fields have invalid formats', () => {
    const input = ExtractAction.validateInput({ type: 'invoice', text: 'INV-INVALID-PROFILE' });
    const invalidProfiles: unknown[] = [
      { profileId: '', revision: -1, parameters: [], slots: null, promptOverrides: 'not-a-map' },
      { profileId: 'profile-bad-revision', revision: Number.NaN, parameters: {}, slots: { reasoning: 'not-a-slot' } },
      { profileId: 'profile-overflow', revision: Number.MAX_SAFE_INTEGER + 1, parameters: {}, slots: {}, limits: [] },
    ];

    for (const profile of invalidProfiles) {
      const selected = ExtractAction.selectRecipe(input, profile as ProfileSnapshot);
      expect(selected.recipeId).toBe('recipe-extract-invoice-v1');
      expect(selected.variant).toBe('invoice');
    }
  });

  it('does not drift a pinned recipe when the presented business tool version changes mid-run', async () => {
    const ctx = new MockTaskContext();
    ctx.businessVersion = '1.2.3';
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-version-drift-pin',
      status: 'SUCCESS',
      data: { invoiceNumber: 'INV-DRIFT', supplier: { name: 'ACME' }, total: 250 },
    };
    const payload = { type: 'invoice', text: 'Invoice pinned before tool version drift' };
    const input = ExtractAction.validateInput(payload);
    const pinnedRecipe = ExtractAction.selectRecipe(input).recipeId;

    const first = await documentCoreHandlers.extract!(ctx, payload);
    ctx.businessVersion = '999.0.0';
    const replay = await documentCoreHandlers.extract!(ctx, payload);

    expect(first.kind).toBe('completed');
    expect(replay.kind).toBe('completed');
    expect(ExtractAction.selectRecipe(input).recipeId).toBe(pinnedRecipe);
    expect(pinnedRecipe).toBe('recipe-extract-invoice-v1');
    expect(ctx.connectorInvocations).toHaveLength(1);
    expect(ctx.connectorInvocations[0]?.slot).toBe('reasoning');
  });

  it('refuses connector execution when a source artifact has no version pin', async () => {
    const ctx = new MockTaskContext();
    const artifactId = 'artifact-without-version-pin';
    ctx.storeArtifact(artifactId, Buffer.from('pinned OCR source bytes'), 'scan.png', 'image/png');
    ctx.artifactReadIdentityStore.delete(artifactId);

    await expect(
      documentCoreHandlers.ingest!(ctx, { mode: 'ocr', artifactIds: [artifactId] })
    ).rejects.toMatchObject({ code: 'ARTIFACT_GRANT_INVALID' });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('does not allow profile or payload overrides to change the pinned variant or connector slot', async () => {
    const input = ExtractAction.validateInput({
      type: 'invoice',
      text: 'Invoice protected from caller overrides',
      recipeId: 'recipe-extract-contract-v1',
      variant: 'contract',
      requiredSlot: 'vision',
      promptOverrides: { extract_invoice: 'caller supplied prompt' },
    });
    const unauthorizedProfile = {
      profileId: 'profile-attacker',
      revision: 999,
      parameters: { recipeId: 'recipe-extract-contract-v1' },
      slots: { reasoning: { connectorId: 'attacker-connector', revision: 999, model: 'attacker-model' } },
      promptOverrides: { extract_invoice: 'attacker prompt' },
    } as ProfileSnapshot;
    const selected = ExtractAction.selectRecipe(input, unauthorizedProfile);
    const ctx = new MockTaskContext();
    ctx.connectorBindings = { reasoning: 'attacker-connector', vision: 'attacker-vision' };
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-authorized-pin',
      status: 'SUCCESS',
      data: { invoiceNumber: 'INV-AUTH', supplier: { name: 'ACME' }, total: 500 },
    };

    const disposition = await documentCoreHandlers.extract!(ctx, {
      type: 'invoice',
      text: 'Invoice protected from caller overrides',
      recipeId: 'recipe-extract-contract-v1',
      variant: 'contract',
      requiredSlot: 'vision',
      promptOverrides: { extract_invoice: 'caller supplied prompt' },
    });

    expect(selected.recipeId).toBe('recipe-extract-invoice-v1');
    expect(selected.steps.find((step) => step.requiredSlot)?.requiredSlot).toBe('reasoning');
    expect(disposition.kind).toBe('completed');
    expect(ctx.connectorInvocations).toHaveLength(1);
    expect(ctx.connectorInvocations[0]?.slot).toBe('reasoning');
    expect((ctx.connectorInvocations[0]?.payload as { task?: string }).task).toBe('extract_invoice');
  });

  it('fails closed when pinned artifact digest metadata is corrupted', async () => {
    const ctx = new MockTaskContext();
    const artifactId = 'artifact-corrupt-pin-digest';
    ctx.storeArtifact(artifactId, Buffer.from('source bytes whose digest must stay pinned'), 'scan.png', 'image/png');
    const identity = ctx.artifactReadIdentityStore.get(artifactId);
    expect(identity).toBeDefined();
    identity!.sha256 = 'f'.repeat(64);

    await expect(
      documentCoreHandlers.ingest!(ctx, { mode: 'ocr', artifactIds: [artifactId] })
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_MISMATCH' });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });
});
