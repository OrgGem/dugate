import { LcCheckerError } from '../src/errors';
import { runBoundedFanout, resolveConcurrency } from '../src/fanout';
import {
  LC_CHECKER_STEP_IDS,
  LC_HUMAN_SIGNOFF_REQUIRED,
  MAX_LC_DOCUMENTS,
  advanceLcChecker,
  normalizeLcCheckerInput,
  outstandingVisualChecks,
} from '../src/lc-checker';
import { MAX_FANOUT_CONCURRENCY, type ChildTaskSpec } from '../src/primitives';
import { LC_DEFAULT_RULE_SET_VERSION, getRuleSet } from '../src/rules/rule-registry';
import { LC_CHECKER_INPUT_VERSION, type LcCheckerPorts, type LcCheckerState } from '../src/types';
import { compliantPayload, discrepantPayload, validInput } from './fakes';

const BL_ENDORSEMENT = {
  document_index: 1,
  purpose: 'Is the bill of lading endorsed on the reverse?',
  rule_ids: ['PROC-3.8'],
};

interface PortOptions {
  readonly screen?: unknown;
  readonly digests?: unknown[];
  readonly adjudicate?: unknown;
  readonly report?: string;
  readonly throwOnOcr?: string;
  readonly fileNames?: readonly string[];
  readonly adjudicateCalls?: Array<{ digests: number; outstanding: number }>;
}

function ports(options: PortOptions = {}): LcCheckerPorts {
  return {
    ocrFile: async ({ fileName }) => {
      if (options.throwOnOcr === fileName) throw new Error('unreadable ' + fileName);
      return 'TEXT OF ' + fileName;
    },
    screen: async () => options.screen ?? {
      notes: 'endorsement unreadable in text',
      visual_requests: [BL_ENDORSEMENT],
    },
    inspect: async () => {
      throw new LcCheckerError('PORT_MISCONFIGURED', 'inspect is only reachable through a spawned child');
    },
    adjudicate: async ({ visualDigests, outstandingChecks }) => {
      options.adjudicateCalls?.push({ digests: visualDigests.length, outstanding: outstandingChecks.length });
      return options.adjudicate ?? compliantPayload();
    },
    generateReport: async () => options.report ?? '# Bao cao kiem tra chung tu LC',
  };
}

function ocrJoin(fileNames: readonly string[], text?: (fileName: string) => string) {
  return {
    joinToken: 'ocr:' + LC_CHECKER_INPUT_VERSION,
    results: fileNames.map((fileName) => ({
      childId: 'ocr:' + fileName,
      status: 'succeeded' as const,
      payload: { kind: 'ocr' as const, fileName, text: (text ?? ((name) => 'TEXT OF ' + name))(fileName) },
    })),
  };
}

function failedJoin(fileNames: readonly string[], reasons: Record<string, string>) {
  return {
    joinToken: 'ocr:' + LC_CHECKER_INPUT_VERSION,
    results: fileNames.map((fileName) => ({
      childId: 'ocr:' + fileName,
      status: 'failed' as const,
      error: { code: 'CHILD_FAILED', message: reasons[fileName] ?? 'unreadable' },
    })),
  };
}

function visualJoin(digests: readonly unknown[]) {
  return {
    joinToken: 'visual:' + LC_CHECKER_INPUT_VERSION,
    results: digests.map((payload, index) => ({
      childId: 'visual:' + index + ':ocr:bill-of-lading.pdf',
      status: 'succeeded' as const,
      payload,
    })),
  };
}

/** A visual child that never came back. The machine counts the round, records the gap. */
function failedVisualJoin(count: number) {
  return {
    joinToken: 'visual:' + LC_CHECKER_INPUT_VERSION,
    results: Array.from({ length: count }, (_, index) => ({
      childId: 'visual:' + index + ':ocr:bill-of-lading.pdf',
      status: 'failed' as const,
      error: { code: 'CHILD_FAILED', message: 'the page could not be read' },
    })),
  };
}

const GOOD_DIGEST = {
  documentIndex: 1,
  fileName: 'bill-of-lading.pdf',
  purpose: BL_ENDORSEMENT.purpose,
  ruleIds: ['PROC-3.8'],
  observations: [{ field: 'shipper endorsement', found: true, evidence: 'page 3' }],
};

const NO_REQUEST_SCREEN = { notes: 'text settled everything', visual_requests: [] };

interface RunResult {
  readonly ocrStep: Awaited<ReturnType<typeof advanceLcChecker>>;
  readonly final: Awaited<ReturnType<typeof advanceLcChecker>>;
}

/** Drive the whole workflow the way the host does: one delivery per fan-out boundary. */
async function runToCompletion(options: {
  readonly input?: Record<string, unknown>;
  readonly portOptions?: PortOptions;
  readonly state?: LcCheckerState;
  readonly visualDigests?: readonly unknown[];
} = {}): Promise<RunResult> {
  const input = normalizeLcCheckerInput(options.input ?? validInput());
  const portOptions = options.portOptions ?? {};

  const first = await advanceLcChecker({ input, state: options.state, runtime: ports(portOptions) });
  expect(first.continuation.kind).toBe('spawn-children');
  if (first.continuation.kind !== 'spawn-children') throw new Error('unreachable');
  expect(first.continuation.stage).toBe('ocr');

  const second = await advanceLcChecker({
    input,
    state: first.state,
    runtime: ports(portOptions),
    join: portOptions.throwOnOcr
      ? failedJoin(input.fileNames, { [portOptions.throwOnOcr]: 'unreadable' })
      : ocrJoin(input.fileNames),
  });

  const digests = options.visualDigests ?? [GOOD_DIGEST];
  if (second.continuation.kind !== 'spawn-children') {
    return { ocrStep: first, final: second };
  }
  expect(second.continuation.stage).toBe('visual');
  const expected = second.continuation.children.length;
  const third = await advanceLcChecker({
    input,
    state: second.state,
    runtime: ports(portOptions),
    join: digests.length === 0 ? failedVisualJoin(expected) : visualJoin(digests),
  });
  return { ocrStep: first, final: third };
}

describe('P9-02 input normalisation', () => {
  it('accepts a well-formed input and clamps concurrency to the hard cap', () => {
    const input = normalizeLcCheckerInput(validInput({ maxConcurrency: 999 }));
    expect(input.maxConcurrency).toBe(MAX_FANOUT_CONCURRENCY);
    expect(input.ruleSetVersion).toBe(LC_DEFAULT_RULE_SET_VERSION);
  });

  it('rejects an unsupported input version', () => {
    expect(() => normalizeLcCheckerInput(validInput({ inputVersion: 'lc-checker-input-v0' }))).toThrow(
      'Unsupported LC checker input version'
    );
  });

  it('rejects a ruleset version that does not exist', () => {
    try {
      normalizeLcCheckerInput(validInput({ ruleSetVersion: 'nope' }));
      throw new Error('expected the normalisation to fail');
    } catch (error) {
      expect((error as LcCheckerError).code).toBe('RULESET_UNKNOWN');
    }
  });

  it('rejects client-supplied identity, which the legacy read from a form field', () => {
    for (const field of ['apiKeyId', 'api_key_id', 'userId', 'tenantId', 'role', 'adminToken']) {
      try {
        normalizeLcCheckerInput(validInput({ [field]: 'anything' }));
        throw new Error('expected ' + field + ' to be rejected');
      } catch (error) {
        expect((error as LcCheckerError).code).toBe('IDENTITY_FIELD_REJECTED');
      }
    }
  });

  it('rejects a document set whose ids and names disagree', () => {
    expect(() => normalizeLcCheckerInput(validInput({ fileNames: ['only-one.pdf'] }))).toThrow('must be the same length');
  });

  it('rejects an unbounded document set', () => {
    const many = Array.from({ length: MAX_LC_DOCUMENTS + 1 }, (_, index) => 'doc-' + index + '.pdf');
    expect(() => normalizeLcCheckerInput(validInput({ artifactIds: many, fileNames: many }))).toThrow(
      'limited to ' + MAX_LC_DOCUMENTS
    );
  });

  it('rejects a bad concurrency, failure policy or encryption flag', () => {
    expect(() => normalizeLcCheckerInput(validInput({ maxConcurrency: 0 }))).toThrow('positive integer');
    expect(() => normalizeLcCheckerInput(validInput({ maxConcurrency: 1.5 }))).toThrow('positive integer');
    expect(() => normalizeLcCheckerInput(validInput({ failurePolicy: 'best-effort' }))).toThrow('failurePolicy');
    expect(() => normalizeLcCheckerInput(validInput({ requireEncryptedEvidence: 'yes' }))).toThrow('boolean');
  });

  it('rejects a non-object input', () => {
    expect(() => normalizeLcCheckerInput(null)).toThrow('must be an object');
    expect(() => normalizeLcCheckerInput([])).toThrow('must be an object');
    expect(() => normalizeLcCheckerInput('x')).toThrow('must be an object');
  });
});

describe('P9-02 bounded fan-out', () => {
  const specs: ChildTaskSpec[] = Array.from({ length: 20 }, (_, index) => ({
    childId: 'ocr-' + index,
    stage: 'ocr' as const,
    input: index,
  }));

  it('clamps a requested ceiling to the hard cap', () => {
    expect(resolveConcurrency(999)).toBe(MAX_FANOUT_CONCURRENCY);
    expect(resolveConcurrency(0)).toBe(1);
    expect(resolveConcurrency(Number.NaN)).toBe(1);
    expect(resolveConcurrency(3.9)).toBe(3);
  });

  it('never runs more than the ceiling at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await runBoundedFanout(specs, 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return true;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('returns results in input order regardless of completion order', async () => {
    const outcomes = await runBoundedFanout(specs, 4, async (spec) => {
      const index = spec.input as number;
      await new Promise((resolve) => setTimeout(resolve, 20 - index));
      return index;
    });
    expect(outcomes.map((outcome) => outcome.payload)).toEqual(specs.map((spec) => spec.input));
  });

  it('records one child failure without cancelling its siblings', async () => {
    const outcomes = await runBoundedFanout(specs, 4, async (spec) => {
      if (spec.input === 7) throw Object.assign(new Error('bad page'), { code: 'OCR_FAILED' });
      return spec.input;
    });
    expect(outcomes.filter((outcome) => outcome.status === 'succeeded')).toHaveLength(19);
    const failed = outcomes.find((outcome) => outcome.status === 'failed');
    expect(failed?.error?.code).toBe('OCR_FAILED');
  });
});

describe('P9-02 workflow machine', () => {
  it('opens with a bounded spawn-children and an issued join token', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const step = await advanceLcChecker({ input, runtime: ports() });
    expect(step.continuation.kind).toBe('spawn-children');
    if (step.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    expect(step.continuation.stage).toBe('ocr');
    expect(step.continuation.children).toHaveLength(2);
    expect(step.continuation.children[0]).toMatchObject({ childId: 'ocr:invoice.pdf', stage: 'ocr' });
    expect(step.continuation.maxConcurrency).toBe(4);
    expect(step.continuation.joinToken).toBe('ocr:' + LC_CHECKER_INPUT_VERSION);
  });

  it('screens the text on the same turn that merges the OCR join, then asks for what text cannot settle', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const second = await advanceLcChecker({ input, state: first.state, runtime: ports(), join: ocrJoin(input.fileNames) });
    expect(second.continuation.kind).toBe('spawn-children');
    if (second.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    expect(second.continuation.stage).toBe('visual');
    expect(second.continuation.joinToken).toBe('visual:' + LC_CHECKER_INPUT_VERSION);
    expect(second.continuation.children).toHaveLength(1);
    expect(second.continuation.children[0]).toMatchObject({ stage: 'visual' });
    expect(second.continuation.children[0]?.input).toMatchObject({
      artifactId: 'art-bl',
      fileName: 'bill-of-lading.pdf',
      documentIndex: 1,
      purpose: BL_ENDORSEMENT.purpose,
      ruleIds: ['PROC-3.8'],
    });
    expect(second.state.screen?.visualRequests).toHaveLength(1);
  });

  it('skips the visual round entirely when the text settled everything', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const second = await advanceLcChecker({
      input,
      state: first.state,
      runtime: ports({ screen: NO_REQUEST_SCREEN }),
      join: ocrJoin(input.fileNames),
    });
    expect(second.continuation.kind).toBe('terminate');
    if (second.continuation.kind !== 'terminate') throw new Error('unreachable');
    expect(second.continuation.data?.evidence.visualVerification).toEqual({
      requested: 0,
      satisfied: 0,
      complete: true,
    });
    expect(second.continuation.data?.outstandingVisualChecks).toEqual([]);
  });

  it('examines and reports on the joined turn, and terminates SUCCEEDED', async () => {
    const calls: Array<{ digests: number; outstanding: number }> = [];
    const { final } = await runToCompletion({ portOptions: { adjudicate: discrepantPayload(), adjudicateCalls: calls } });
    expect(final.continuation.kind).toBe('terminate');
    if (final.continuation.kind !== 'terminate') throw new Error('unreachable');
    expect(final.continuation.terminal).toBe('SUCCEEDED');
    const result = final.continuation.data!;
    expect(result.verdict).toBe('DISCREPANT');
    expect(result.discrepancies[0]?.ruleId).toBe('PROC-3.2');
    expect(result.report).toContain('Bao cao');
    expect(calls).toEqual([{ digests: 1, outstanding: 0 }]);
  });

  it('always requires a human sign-off, so a run can never read as a determination', async () => {
    const { final } = await runToCompletion();
    if (final.continuation.kind !== 'terminate') throw new Error('unreachable');
    expect(LC_HUMAN_SIGNOFF_REQUIRED).toBe(true);
    expect(final.continuation.data?.humanSignOffRequired).toBe(true);
  });

  it('carries the ruleset identity and the cited rule ids into the evidence', async () => {
    const { final } = await runToCompletion({ portOptions: { adjudicate: discrepantPayload() } });
    if (final.continuation.kind !== 'terminate') throw new Error('unreachable');
    const evidence = final.continuation.data!.evidence;
    expect(evidence.ruleSetId).toBe(getRuleSet(LC_DEFAULT_RULE_SET_VERSION)?.id);
    expect(evidence.ruleSetStatus).toBe('PROVISIONAL');
    expect(evidence.citedRuleIds).toEqual(['PROC-3.2']);
    expect(evidence.visualVerification).toEqual({ requested: 1, satisfied: 1, complete: true });
  });

  it('refuses a join whose token does not match the pending fan-out', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    await expect(
      advanceLcChecker({
        input,
        state: first.state,
        runtime: ports(),
        join: { joinToken: 'ocr:someone-elses-run', results: [] },
      })
    ).rejects.toThrow('does not match the pending token');
  });

  it('refuses a join that is missing a child result', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const join = ocrJoin(input.fileNames);
    await expect(
      advanceLcChecker({
        input,
        state: first.state,
        runtime: ports(),
        join: { joinToken: join.joinToken, results: join.results.slice(0, 1) },
      })
    ).rejects.toThrow('expected 2 child results but received 1');
  });

  it('refuses a join for a round this run never issued', async () => {
    const input = normalizeLcCheckerInput(validInput());
    await expect(advanceLcChecker({ input, runtime: ports(), join: ocrJoin(input.fileNames) })).rejects.toThrow(
      'no fan-out is pending'
    );
  });

  it('refuses a visual join supplied while the OCR round is still pending', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    await expect(
      advanceLcChecker({ input, state: first.state, runtime: ports(), join: visualJoin([GOOD_DIGEST]) })
    ).rejects.toThrow('does not match the pending token');
  });

  it('refuses to examine anything when every document was unreadable and the policy is fail-closed', async () => {
    await expect(runToCompletion({ portOptions: { throwOnOcr: 'invoice.pdf' } })).rejects.toThrow(
      'No document could be read'
    );
  });

  it('records the failure and continues under continue-on-partial, as the legacy did', async () => {
    const input = normalizeLcCheckerInput(validInput({ failurePolicy: 'continue-on-partial' }));
    const first = await advanceLcChecker({ input, runtime: ports() });
    const second = await advanceLcChecker({
      input,
      state: first.state,
      runtime: ports(),
      join: failedJoin(input.fileNames, { 'invoice.pdf': 'scan is rotated' }),
    });
    if (second.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    const third = await advanceLcChecker({
      input,
      state: second.state,
      runtime: ports(),
      join: visualJoin([GOOD_DIGEST]),
    });
    if (third.continuation.kind !== 'terminate') throw new Error('unreachable');
    const result = third.continuation.data!;
    expect(result.failedChildren).toEqual([
      { childId: 'ocr:invoice.pdf', reason: 'scan is rotated' },
      { childId: 'ocr:bill-of-lading.pdf', reason: 'unreadable' },
    ]);
    expect(result.evidence.filesOcred).toBe(0);
  });

  it('refuses a COMPLIANT verdict when a screening question is still unanswered', async () => {
    await expect(
      runToCompletion({ portOptions: { screen: { ...NO_REQUEST_SCREEN, visual_requests: [BL_ENDORSEMENT] } }, visualDigests: [] })
    ).rejects.toThrow('visual checks were satisfied');
  });

  it('names the unanswered questions in the result instead of hiding them', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const second = await advanceLcChecker({
      input,
      state: first.state,
      runtime: ports({ adjudicate: discrepantPayload() }),
      join: ocrJoin(input.fileNames),
    });
    if (second.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    const third = await advanceLcChecker({
      input,
      state: second.state,
      runtime: ports({ adjudicate: discrepantPayload() }),
      join: failedVisualJoin(1),
    });
    if (third.continuation.kind !== 'terminate') throw new Error('unreachable');
    expect(third.continuation.data?.outstandingVisualChecks).toEqual([
      { fileName: 'bill-of-lading.pdf', purpose: BL_ENDORSEMENT.purpose },
    ]);
    expect(third.continuation.data?.evidence.visualVerification).toEqual({
      requested: 1,
      satisfied: 0,
      complete: false,
    });
  });

  it('still accepts a DISCREPANT verdict when a visual check is outstanding', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const second = await advanceLcChecker({
      input,
      state: first.state,
      runtime: ports({ adjudicate: discrepantPayload() }),
      join: ocrJoin(input.fileNames),
    });
    if (second.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    const third = await advanceLcChecker({
      input,
      state: second.state,
      runtime: ports({ adjudicate: discrepantPayload() }),
      join: failedVisualJoin(1),
    });
    expect(third.continuation.kind).toBe('terminate');
  });

  it('refuses to swap the ruleset mid-flight, which would orphan the evidence', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const drifted = { ...first.state, ruleSetVersion: 'ucp600-isbp821-v0' };
    await expect(advanceLcChecker({ input, state: drifted, runtime: ports() })).rejects.toThrow(
      'cannot change its rules base mid-flight'
    );
  });

  it('refuses a state written for a different input version', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const drifted = { ...first.state, inputVersion: 'lc-checker-input-v0' };
    await expect(advanceLcChecker({ input, state: drifted, runtime: ports() })).rejects.toThrow(
      'State was written for input version'
    );
  });

  it('records every completed stage in the persisted state', async () => {
    const { final } = await runToCompletion();
    expect(final.state.completedStages).toEqual([
      LC_CHECKER_STEP_IDS.ocr,
      LC_CHECKER_STEP_IDS.screen,
      LC_CHECKER_STEP_IDS.visual,
      LC_CHECKER_STEP_IDS.adjudicate,
      LC_CHECKER_STEP_IDS.report,
    ]);
    expect(final.state.pendingJoinToken).toBeUndefined();
    expect(final.state.visualDigests).toHaveLength(1);
  });

  it('refuses to run with a misconfigured port set', async () => {
    const input = normalizeLcCheckerInput(validInput());
    await expect(advanceLcChecker({ input, runtime: {} as unknown as LcCheckerPorts })).rejects.toThrow(
      'requires the ocrFile, screen, inspect, adjudicate and generateReport ports'
    );
  });

  it('refuses an empty report from the report port', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    const second = await advanceLcChecker({
      input,
      state: first.state,
      runtime: ports({ report: '   ' }),
      join: ocrJoin(input.fileNames),
    });
    if (second.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    await expect(
      advanceLcChecker({ input, state: second.state, runtime: ports({ report: '   ' }), join: visualJoin([GOOD_DIGEST]) })
    ).rejects.toThrow('returned no report text');
  });

  it('refuses a screening pass that asks for a document outside the submission', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    await expect(
      advanceLcChecker({
        input,
        state: first.state,
        runtime: ports({ screen: { notes: '', visual_requests: [{ ...BL_ENDORSEMENT, document_index: 7 }] } }),
        join: ocrJoin(input.fileNames),
      })
    ).rejects.toThrow('only 2 documents were submitted');
  });

  it('refuses a screening pass that asks for a check with no rule behind it', async () => {
    const input = normalizeLcCheckerInput(validInput());
    const first = await advanceLcChecker({ input, runtime: ports() });
    await expect(
      advanceLcChecker({
        input,
        state: first.state,
        runtime: ports({ screen: { notes: '', visual_requests: [{ ...BL_ENDORSEMENT, rule_ids: ['MADE-UP'] }] } }),
        join: ocrJoin(input.fileNames),
      })
    ).rejects.toThrow('MADE-UP');
  });

  it('lists the gaps in a state that has not adjudicated yet', () => {
    const input = normalizeLcCheckerInput(validInput());
    const state = {
      inputVersion: input.inputVersion,
      ruleSetVersion: input.ruleSetVersion,
      completedStages: [LC_CHECKER_STEP_IDS.ocr, LC_CHECKER_STEP_IDS.screen],
      ocrTexts: [],
      childResults: [],
      visualDigests: [],
      visualFailures: [],
      screen: { visualRequests: [{ documentIndex: 1, purpose: 'x', ruleIds: ['PROC-3.8'] }], notes: '', ruleSetVersion: input.ruleSetVersion },
    } satisfies LcCheckerState;
    expect(outstandingVisualChecks(state, input.fileNames)).toEqual([{ fileName: 'bill-of-lading.pdf', purpose: 'x' }]);
  });
});
