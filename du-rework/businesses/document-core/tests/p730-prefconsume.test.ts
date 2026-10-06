import {
  PROMPT_OVERRIDE_PRECEDENCE,
  pickPinnedPromptOverride,
  resolveStepPrompt,
  type PinnedPromptOverride,
  type ResolvedStepPrompt,
} from '../src/actions/prompt-precedence';

/**
 * P730-PREFCONSUME (Δ-C) — consumer-side prompt precedence, offline.
 * Vector source: P730-SDK-PREP §5 (key-4 exact→_default; null vs '' = clear;
 * Code > Profile > Connector per PROMPT_OVERRIDE_PRECEDENCE; profile policy
 * NULL distinct from empty; empty pin → never fabricate a connector default).
 */

const CONN = '11111111-1111-4111-8111-111111111111';
const OTHER_CONN = '22222222-2222-4222-8222-222222222222';
const STEP = 'extract.invoice';

const POLICY = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM' as const,
  allowedFileExtensions: '',
  connectionsOverride: [],
  fileUrlAuthConfigured: false,
  credentialRef: { tenantId: 't', profileId: 'p', profileRevision: 1 },
};

const row = (
  connectionId: string,
  stepId: string,
  promptOverride: string | null
): PinnedPromptOverride => ({ connectionId, stepId, promptOverride });

const promptOf = (r: ResolvedStepPrompt): string | null => r.prompt;
const applies = (r: ResolvedStepPrompt): boolean => r.apply;

describe('P730-PREFCONSUME — frozen precedence order', () => {
  it('the order constant is exactly code > profile > connector', () => {
    expect([...PROMPT_OVERRIDE_PRECEDENCE]).toEqual(['code', 'profile', 'connector']);
  });

  it('code wins over both profile levels and connector', () => {
    const r = resolveStepPrompt({
      codePrompt: 'CODE PROMPT',
      pinnedOverrides: [row(CONN, STEP, 'exact'), row(CONN, '_default', 'default')],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
      connectorDefaultPrompt: 'connector default',
    });
    expect(r).toEqual({ source: 'code', prompt: 'CODE PROMPT', apply: true });
  });

  it('trim-empty code prompt is ABSENT, not an override', () => {
    for (const empty of ['', '   ', '\n\t']) {
      const r = resolveStepPrompt({
        codePrompt: empty,
        pinnedOverrides: [row(CONN, STEP, 'exact')],
        connectionId: CONN,
        stepId: STEP,
        profilePolicy: POLICY,
      });
      expect(r.source).toBe('profile_exact');
    }
  });
});

describe('P730-PREFCONSUME — key-4 selection (exact → _default)', () => {
  it('exact step wins over _default', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [row(CONN, '_default', 'D'), row(CONN, STEP, 'E')],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
    });
    expect(r).toEqual({ source: 'profile_exact', prompt: 'E', apply: true, matchedStepId: STEP });
  });

  it('_default is used when the exact step has no row', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [row(CONN, '_default', 'D')],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
    });
    expect(r).toEqual({ source: 'profile_default', prompt: 'D', apply: true, matchedStepId: '_default' });
  });

  it('rows for another connection are ignored', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [row(OTHER_CONN, STEP, 'foreign')],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
      connectorDefaultPrompt: 'connector default',
    });
    expect(r.source).toBe('connector_default');
    expect(applies(r)).toBe(false);
  });

  it('missing/empty connectionId skips the profile level', () => {
    for (const conn of [undefined, null, '']) {
      const r = resolveStepPrompt({
        pinnedOverrides: [row(CONN, STEP, 'exact')],
        connectionId: conn,
        stepId: STEP,
        profilePolicy: POLICY,
        connectorDefaultPrompt: 'connector default',
      });
      expect(r.source).toBe('connector_default');
    }
  });

  it('pickPinnedPromptOverride: exact even when cleared; _default otherwise; null on empty bucket', () => {
    expect(pickPinnedPromptOverride([row(CONN, STEP, null), row(CONN, '_default', 'D')], CONN, STEP)).toEqual(
      row(CONN, STEP, null)
    );
    expect(pickPinnedPromptOverride([row(CONN, '_default', 'D')], CONN, STEP)).toEqual(row(CONN, '_default', 'D'));
    expect(pickPinnedPromptOverride([], CONN, STEP)).toBeNull();
    expect(pickPinnedPromptOverride(undefined, CONN, STEP)).toBeNull();
  });
});

describe('P730-PREFCONSUME — clear semantics (null vs empty = clear, trim)', () => {
  it('a CLEARED exact row short-circuits _default and falls to the connector level', () => {
    for (const cleared of [null, '', '   ']) {
      const r = resolveStepPrompt({
        pinnedOverrides: [row(CONN, STEP, cleared), row(CONN, '_default', 'D')],
        connectionId: CONN,
        stepId: STEP,
        profilePolicy: POLICY,
        connectorDefaultPrompt: 'connector default',
      });
      expect(applies(r)).toBe(false);
      expect(r.source).toBe('connector_default');
    }
  });

  it('a CLEARED _default row falls to the connector level', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [row(CONN, '_default', null)],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
      connectorDefaultPrompt: 'connector default',
    });
    expect(applies(r)).toBe(false);
    expect(r.source).toBe('connector_default');
  });

  it('accepted content is trimmed', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [row(CONN, STEP, '  padded prompt  \n')],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
    });
    expect(promptOf(r)).toBe('padded prompt');
  });
});

describe('P730-PREFCONSUME — profile policy NULL semantics (no empty merge)', () => {
  it('profilePolicy === null skips the profile level even when matching rows exist', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [row(CONN, STEP, 'exact')],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: null,
      connectorDefaultPrompt: 'connector default',
    });
    expect(r.source).toBe('connector_default');
    expect(applies(r)).toBe(false);
  });

  it('profilePolicy undefined (pre-pin legacy) skips the profile level identically', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [row(CONN, STEP, 'exact')],
      connectionId: CONN,
      stepId: STEP,
      connectorDefaultPrompt: 'connector default',
    });
    expect(r.source).toBe('connector_default');
  });
});

describe('P730-PREFCONSUME — no fabricated connector default (PREP §5 negative)', () => {
  it('empty bucket + connector default present → labeled, NOT applied', () => {
    const r = resolveStepPrompt({
      pinnedOverrides: [],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
      connectorDefaultPrompt: 'connector default',
    });
    expect(r).toEqual({ source: 'connector_default', prompt: 'connector default', apply: false });
  });

  it('absent bucket behaves like empty; absent default → source none', () => {
    const withDefault = resolveStepPrompt({ stepId: STEP });
    expect(withDefault).toEqual({ source: 'none', prompt: null, apply: false });
    const labeled = resolveStepPrompt({ stepId: STEP, connectorDefaultPrompt: 'd' });
    expect(labeled).toEqual({ source: 'connector_default', prompt: 'd', apply: false });
  });

  it('whitespace-only connector default → none', () => {
    const r = resolveStepPrompt({ stepId: STEP, connectorDefaultPrompt: '   ' });
    expect(r).toEqual({ source: 'none', prompt: null, apply: false });
  });
});

describe('P730-PREFCONSUME — consumer call-site pattern (build-prompt substitution)', () => {
  it('applies the profile override when pinned; keeps the default byte-identical otherwise', () => {
    const defaultText = 'Extract invoice information from document.';
    const withOverride = resolveStepPrompt({
      pinnedOverrides: [row(CONN, STEP, 'Phân tích hoá đơn theo mẫu.')],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
      connectorDefaultPrompt: defaultText,
    });
    const effectiveWith = applies(withOverride) ? (promptOf(withOverride) as string) : defaultText;
    expect(effectiveWith).toBe('Phân tích hoá đơn theo mẫu.');

    const withoutOverride = resolveStepPrompt({
      pinnedOverrides: [],
      connectionId: CONN,
      stepId: STEP,
      profilePolicy: POLICY,
      connectorDefaultPrompt: defaultText,
    });
    const effectiveWithout = applies(withoutOverride) ? (promptOf(withoutOverride) as string) : defaultText;
    expect(effectiveWithout).toBe(defaultText);
  });
});
