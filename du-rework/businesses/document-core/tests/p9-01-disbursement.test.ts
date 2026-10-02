/**
 * P9-01 disbursement — unit tests.
 *
 * Fully offline: no queue, no database, no provider, no shared infra. The four business
 * ports are fakes and the fan-out runs in-process through the host bridge, so these
 * tests exercise the workflow logic itself rather than the platform around it.
 */

import {
  DISBURSEMENT_BUSINESS_ID,
  DISBURSEMENT_BUSINESS_VERSION,
  DISBURSEMENT_INPUT_VERSION,
  DISBURSEMENT_RESUME_VERSION,
  DISBURSEMENT_STEP_IDS,
  DisbursementError,
  MAX_FANOUT_CONCURRENCY,
  advanceDisbursement,
  applyCorrections,
  buildApprovalEvidence,
  isTerminal,
  normalizeDisbursementInput,
  resolveConcurrency,
  runBoundedFanout,
  runSpawnedChildren,
  type DisbursementRuntime,
  type DisbursementState,
  type FanoutOutcome,
  type JoinSubmission,
  type LogicalDocument,
  type SpawnChildren,
} from '../src/pipelines/workflows/disbursement';
import { resolveFanoutConcurrency } from '@du/worker-sdk';
import {
  emptyDisbursementState,
  type DisbursementInput,
  type ExtractedRecord,
} from '../src/pipelines/workflows/disbursement/types';

// ─── fakes ────────────────────────────────────────────────────────────────

function logicalDoc(label: string, sourceFile: string): LogicalDocument {
  return { label, sourceFile, category: 'disbursement_packet', confidence: 0.9 };
}

function extracted(fileName: string, label: string, fields: Record<string, unknown>): ExtractedRecord {
  return { fileName, logicalDocumentLabels: [label], fields };
}

interface HarnessOptions {
  readonly files?: readonly string[];
  readonly failClassifyFor?: readonly string[];
  readonly failExtractFor?: readonly string[];
  readonly failAllClassify?: boolean;
  readonly maxConcurrency?: number;
  readonly failurePolicy?: DisbursementInput['failurePolicy'];
  readonly encryptionAvailable?: boolean;
  readonly step?: <T>(stepKey: string, inputHash: string, fn: () => Promise<T>) => Promise<T>;
  /** Corrupt a port on purpose, to prove the guard notices. */
  readonly breakPort?: 'crosscheck' | 'report';
  readonly crosscheckGarbage?: boolean;
  readonly reportEmpty?: boolean;
}

function inputFor(files: readonly string[], options: HarnessOptions = {}): Record<string, unknown> {
  return {
    inputVersion: DISBURSEMENT_INPUT_VERSION,
    artifactIds: files.map((f) => `artifact-${f}`),
    fileNames: [...files],
    referenceData: [{ key: 'total', expected: 1000 }],
    maxConcurrency: options.maxConcurrency ?? 2,
    failurePolicy: options.failurePolicy ?? 'fail-closed',
    requireEncryptedEvidence: false,
  };
}

function makeRuntime(options: HarnessOptions = {}): DisbursementRuntime {
  const ports = {
    classifyFile: async ({ fileName }: { fileName: string }): Promise<readonly LogicalDocument[]> => {
      if (options.failAllClassify === true || options.failClassifyFor?.includes(fileName)) {
        throw new Error(`classify boom: ${fileName}`);
      }
      return [logicalDoc(`${fileName}#1`, fileName)];
    },
    extractFile: async ({
      fileName,
      logicalDocuments,
    }: {
      fileName: string;
      logicalDocuments: readonly LogicalDocument[];
    }): Promise<readonly ExtractedRecord[]> => {
      if (options.failExtractFor?.includes(fileName)) {
        throw new Error(`extract boom: ${fileName}`);
      }
      return logicalDocuments.map((doc) => extracted(fileName, doc.label, { total: 1000, doc: doc.label }));
    },
    crosscheck: async ({
      records,
      referenceData,
    }: {
      records: readonly ExtractedRecord[];
      referenceData: readonly { key: string; expected: unknown }[];
    }) => {
      if (options.crosscheckGarbage === true) {
        return { nope: true } as never;
      }
      const findings = referenceData.map((datum) => {
        const hit = records.find((r) => r.fields[datum.key] === datum.expected);
        return {
          key: datum.key,
          status: hit ? ('match' as const) : ('mismatch' as const),
          detail: hit ? 'matched' : 'unmatched',
        };
      });
      return {
        findings,
        matchedCount: findings.filter((f) => f.status === 'match').length,
        mismatchedCount: findings.filter((f) => f.status === 'mismatch').length,
      };
    },
    report: async ({
      classifications,
      records,
      crosscheck,
    }: {
      classifications: readonly unknown[];
      records: readonly ExtractedRecord[];
      crosscheck: { mismatchedCount: number };
    }): Promise<string> => {
      if (options.reportEmpty === true) return '   ';
      return [
        '# Disbursement report',
        `files: ${classifications.length}`,
        `records: ${records.length}`,
        `mismatches: ${crosscheck.mismatchedCount}`,
      ].join('\n');
    },
  };

  if (options.breakPort === 'crosscheck') delete (ports as Record<string, unknown>).crosscheck;
  if (options.breakPort === 'report') delete (ports as Record<string, unknown>).report;

  return {
    ports: ports as DisbursementRuntime['ports'],
    encryptionAvailable: options.encryptionAvailable,
    step: options.step,
  };
}

function resumePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resumeSchemaVersion: DISBURSEMENT_RESUME_VERSION,
    approved: true,
    approvedBy: 'ops@example',
    corrections: [],
    ...overrides,
  };
}

/** Execute one fan-out outcome in-process and hand the results back with its token. */
async function runFanout(
  spawn: SpawnChildren,
  runtime: DisbursementRuntime
): Promise<JoinSubmission> {
  const results = await runSpawnedChildren(spawn, async (spec) => {
    if (spawn.stage === 'classify') {
      const c = spec.input as { artifactId: string; fileName: string };
      return { kind: 'classification', fileName: c.fileName, logicalDocuments: await runtime.ports.classifyFile(c) };
    }
    const e = spec.input as { artifactId: string; fileName: string; logicalDocuments: readonly LogicalDocument[] };
    return { kind: 'extraction', fileName: e.fileName, records: await runtime.ports.extractFile(e) };
  });
  return { joinToken: spawn.joinToken, results };
}

/** Run the workflow until it stops asking for a fan-out. Returns the last step. */
/**
 * Run the workflow until it stops asking for a fan-out.
 *
 * The loop carries the pending spawn explicitly: once a fan-out has been issued the next call
 * MUST carry its join. Calling advanceDisbursement again without one is a host bug, and the
 * workflow rejects it — which is exactly what the join token is for.
 */
async function advancePastFanout(
  input: Record<string, unknown>,
  runtime: DisbursementRuntime,
  startState: DisbursementState
): Promise<{ state: DisbursementState; kind: string }> {
  let state = startState;
  let pending: SpawnChildren | undefined;
  for (let turn = 0; turn < 6; turn += 1) {
    let step;
    if (pending) {
      const join = await runFanout(pending, runtime);
      pending = undefined;
      step = await advanceDisbursement({ input, state, runtime, join });
    } else {
      step = await advanceDisbursement({ input, state, runtime });
    }
    state = step.state;
    if (step.continuation.kind !== 'spawn-children') {
      return { state, kind: step.continuation.kind };
    }
    pending = step.continuation;
  }
  return { state, kind: 'exhausted' };
}

// ─── bounded fan-out ───────────────────────────────────────────────────────

describe('P9-01 bounded fan-out', () => {
  it('never exceeds the requested concurrency ceiling', async () => {
    let inFlight = 0;
    let peak = 0;
    const specs = Array.from({ length: 12 }, (_, i) => ({ childId: `c${i}`, stage: 'classify' as const, input: i }));
    await runBoundedFanout(specs, 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return true;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('returns results in input order regardless of completion order', async () => {
    const specs = Array.from({ length: 6 }, (_, i) => ({ childId: `c${i}`, stage: 'classify' as const, input: i }));
    const results = await runBoundedFanout(specs, 6, async (spec) => {
      const n = spec.input as number;
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      return n;
    });
    expect(results.map((r) => r.childId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('records one child failure without cancelling its siblings', async () => {
    const specs = [0, 1, 2, 3].map((i) => ({ childId: `c${i}`, stage: 'classify' as const, input: i }));
    const results = await runBoundedFanout(specs, 4, async (spec) => {
      const n = spec.input as number;
      if (n === 1) throw new Error('boom');
      return n;
    });
    expect(results.filter((r) => r.status === 'succeeded')).toHaveLength(3);
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error?.message).toBe('boom');
  });

  it('clamps concurrency into 1..MAX_FANOUT_CONCURRENCY', () => {
    expect(resolveConcurrency(0)).toBe(1);
    expect(resolveConcurrency(-5)).toBe(1);
    expect(resolveConcurrency(1.9)).toBe(1);
    expect(resolveConcurrency(4)).toBe(4);
    expect(resolveConcurrency(999)).toBe(MAX_FANOUT_CONCURRENCY);
    expect(resolveConcurrency(Number.NaN)).toBe(1);
    expect(resolveFanoutConcurrency(999, MAX_FANOUT_CONCURRENCY)).toBe(MAX_FANOUT_CONCURRENCY);
  });
});

// ─── input normalisation ───────────────────────────────────────────────────

describe('P9-01 input normalisation', () => {
  it('accepts a well-formed input', () => {
    const input = normalizeDisbursementInput(inputFor(['a.pdf']));
    expect(input.inputVersion).toBe(DISBURSEMENT_INPUT_VERSION);
    expect(input.artifactIds).toHaveLength(1);
    expect(input.failurePolicy).toBe('fail-closed');
  });

  it('rejects an unknown input version', () => {
    const input = inputFor(['a.pdf']);
    input.inputVersion = 'disbursement-input-v2';
    expect(() => normalizeDisbursementInput(input)).toThrow(DisbursementError);
  });

  it('rejects an empty artifact list', () => {
    expect(() => normalizeDisbursementInput(inputFor([]))).toThrow(/at least one artifactId/);
  });

  it('rejects fileNames that do not line up with artifactIds', () => {
    const input = inputFor(['a.pdf', 'b.pdf']);
    input.fileNames = ['only-one.pdf'];
    expect(() => normalizeDisbursementInput(input)).toThrow(/one-to-one/);
  });

  it('rejects an unknown failurePolicy', () => {
    const input = inputFor(['a.pdf']);
    input.failurePolicy = 'whatever';
    expect(() => normalizeDisbursementInput(input)).toThrow(/failurePolicy/);
  });
});

// ─── identity: the legacy vulnerability must not come back ────────────────

describe('P9-01 refuses client-supplied identity', () => {
  it.each(['apiKeyId', 'api_key_id', 'x-api-key-id', 'xApiKeyId', 'apiKey', 'x-api-key', 'userId', 'tenantId', 'role', 'ADMIN_TOKEN'])(
    'rejects a caller-supplied identity field: %s',
    (field) => {
      const input = inputFor(['a.pdf']);
      input[field] = 'attacker-supplied';
      let caught: unknown;
      try {
        normalizeDisbursementInput(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DisbursementError);
      expect((caught as DisbursementError).code).toBe('IDENTITY_FIELD_REJECTED');
    }
  );

  it('carries no identity field on a normalised input', () => {
    const input = normalizeDisbursementInput(inputFor(['a.pdf'])) as unknown as Record<string, unknown>;
    for (const field of ['apiKeyId', 'x-api-key-id', 'tenantId', 'userId', 'role']) {
      expect(input[field]).toBeUndefined();
    }
  });
});

// ─── continuation sequence ─────────────────────────────────────────────────

describe('P9-01 continuation sequence', () => {
  it('asks for a bounded classify fan-out on the first turn', async () => {
    const files = ['a.pdf', 'b.pdf', 'c.pdf'];
    const { continuation } = await advanceDisbursement({ input: inputFor(files), runtime: makeRuntime({ files }) });
    expect(continuation.kind).toBe('spawn-children');
    if (continuation.kind !== 'spawn-children') throw new Error('unreachable');
    expect(continuation.stage).toBe('classify');
    expect(continuation.children).toHaveLength(3);
    expect(continuation.maxConcurrency).toBe(2);
    expect(continuation.joinToken).toBe(`classify@${DISBURSEMENT_INPUT_VERSION}`);
  });

  it('clamps a requested concurrency above the hard ceiling', async () => {
    const files = ['a.pdf'];
    const { continuation } = await advanceDisbursement({ input: inputFor(files, { maxConcurrency: 500 }), runtime: makeRuntime({ files }) });
    if (continuation.kind !== 'spawn-children') throw new Error('unreachable');
    expect(continuation.maxConcurrency).toBe(MAX_FANOUT_CONCURRENCY);
  });

  it('walks classify -> extract -> wait-for-input and accumulates state', async () => {
    const files = ['a.pdf', 'b.pdf'];
    const input = inputFor(files);
    const { state, kind } = await advancePastFanout(input, makeRuntime({ files }), emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    expect(kind).toBe('wait-for-input');
    expect(state.completedStages).toContain(DISBURSEMENT_STEP_IDS.classify);
    expect(state.completedStages).toContain(DISBURSEMENT_STEP_IDS.extract);
    expect(state.classifications).toHaveLength(2);
    expect(state.records).toHaveLength(2);
  });

  it('scopes each extract child to the logical documents of its own file', async () => {
    const files = ['a.pdf', 'b.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const first = await advanceDisbursement({ input, runtime });
    if (first.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    const afterClassify = await advanceDisbursement({ input, state: first.state, runtime, join: await runFanout(first.continuation, runtime) });
    if (afterClassify.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    expect(afterClassify.continuation.stage).toBe('extract');
    const scopes = afterClassify.continuation.children.map((c) => {
      const e = c.input as { fileName: string; logicalDocuments: readonly LogicalDocument[] };
      return `${e.fileName}:${e.logicalDocuments.length}`;
    });
    expect(scopes).toEqual(['a.pdf:1', 'b.pdf:1']);
  });
});

// ─── human approval ────────────────────────────────────────────────────────

describe('P9-01 human approval', () => {
  it('terminates SUCCEEDED after an explicit approval', async () => {
    const files = ['a.pdf', 'b.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    const { continuation } = await advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload() });

    expect(isTerminal(continuation)).toBe(true);
    if (continuation.kind !== 'terminate') throw new Error('unreachable');
    expect(continuation.terminal).toBe('SUCCEEDED');
    const data = continuation.data as { report: string; evidence: { extractedRecordCount: number }; businessId: string };
    expect(data.report).toContain('# Disbursement report');
    expect(data.evidence.extractedRecordCount).toBe(2);
    expect(data.businessId).toBe(DISBURSEMENT_BUSINESS_ID);
  });

  it('terminates FAILED when the approver rejects', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    const { continuation } = await advanceDisbursement({
      input,
      state: atGate,
      runtime,
      resume: resumePayload({ approved: false, approvedBy: 'auditor@example' }),
    });

    if (continuation.kind !== 'terminate') throw new Error('unreachable');
    expect(continuation.terminal).toBe('FAILED');
    expect(continuation.failure?.code).toBe('APPROVAL_REJECTED');
  });

  it('never treats a missing approval flag as consent', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));

    await expect(
      advanceDisbursement({ input, state: atGate, runtime, resume: { resumeSchemaVersion: DISBURSEMENT_RESUME_VERSION, corrections: [] } })
    ).rejects.toThrow(/explicit boolean "approved"/);
  });

  it('rejects a resume written against a different schema version', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));

    await expect(
      advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload({ resumeSchemaVersion: 'disbursement-resume-v0' }) })
    ).rejects.toThrow(/Unsupported resume schema version/);
  });

  it('applies an approver correction to the extracted record', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    const correction = { fileName: 'a.pdf', logicalDocumentLabel: 'a.pdf#1', field: 'total', value: 999 };

    const { continuation } = await advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload({ corrections: [correction] }) });
    if (continuation.kind !== 'terminate') throw new Error('unreachable');
    const data = continuation.data as { crosscheck: { mismatchedCount: number } };
    // The correction changed total away from the reference value, so the cross-check must see it.
    expect(data.crosscheck.mismatchedCount).toBe(1);
  });

  it('rejects a correction aimed at a record that was never extracted', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    const bogus = { fileName: 'ghost.pdf', logicalDocumentLabel: 'ghost#1', field: 'total', value: 1 };

    await expect(
      advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload({ corrections: [bogus] }) })
    ).rejects.toThrow(/is not an extracted record/);
  });
});

// ─── failure policy ────────────────────────────────────────────────────────

describe('P9-01 failure policy', () => {
  it('fails when every classify child fails', async () => {
    const files = ['a.pdf', 'b.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files, failAllClassify: true });
    const first = await advanceDisbursement({ input, runtime });
    if (first.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    const join = await runFanout(first.continuation, runtime);
    let caught: unknown;
    try {
      await advanceDisbursement({ input, state: first.state, runtime, join });
    } catch (err) {
      caught = err;
    }
    expect((caught as DisbursementError).code).toBe('ALL_CHILDREN_FAILED');
  });

  it('fails closed on a PARTIAL classify failure by default', async () => {
    const files = ['a.pdf', 'b.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files, failClassifyFor: ['b.pdf'] });
    const first = await advanceDisbursement({ input, runtime });
    if (first.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    const join = await runFanout(first.continuation, runtime);
    let caught: unknown;
    try {
      await advanceDisbursement({ input, state: first.state, runtime, join });
    } catch (err) {
      caught = err;
    }
    expect((caught as DisbursementError).code).toBe('CHILD_RESULT_MISMATCH');
  });

  it('continues on a partial failure when allowed, and records the loss', async () => {
    const files = ['a.pdf', 'b.pdf'];
    const input = inputFor(files, { failurePolicy: 'continue-on-partial' });
    const runtime = makeRuntime({ files, failClassifyFor: ['b.pdf'], failurePolicy: 'continue-on-partial' });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    const { continuation } = await advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload() });
    if (continuation.kind !== 'terminate') throw new Error('unreachable');
    expect(continuation.terminal).toBe('SUCCEEDED');
    const data = continuation.data as { failedChildren: readonly { childId: string }[]; evidence: { filesAnalyzed: number } };
    expect(data.failedChildren).toHaveLength(1);
    expect(data.failedChildren[0]?.childId).toContain('b.pdf');
    expect(data.evidence.filesAnalyzed).toBe(1);
  });

  it('rejects a join whose length does not match the fan-out', async () => {
    const files = ['a.pdf', 'b.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const first = await advanceDisbursement({ input, runtime });
    if (first.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    await expect(
      advanceDisbursement({ input, state: first.state, runtime, join: { joinToken: first.continuation.joinToken, results: [] } })
    ).rejects.toThrow(/Expected 2 child results but received 0/);
  });

  it('refuses to merge a child payload of the wrong kind', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files, { failurePolicy: 'continue-on-partial' });
    const runtime = makeRuntime({ files, failurePolicy: 'continue-on-partial' });
    const first = await advanceDisbursement({ input, runtime });
    if (first.continuation.kind !== 'spawn-children') throw new Error('unreachable');
    const wrongKind: JoinSubmission = {
      joinToken: first.continuation.joinToken,
      results: [
        { childId: 'classify:a.pdf', status: 'succeeded', payload: { kind: 'extraction', fileName: 'a.pdf', records: [] } },
      ],
    };
    let caught: unknown;
    try {
      await advanceDisbursement({ input, state: first.state, runtime, join: wrongKind });
    } catch (err) {
      caught = err;
    }
    expect((caught as DisbursementError).code).toBe('ALL_CHILDREN_FAILED');
  });
});

// ─── host misconfiguration and fail-closed guards ─────────────────────────

describe('P9-01 refuses to run half-configured', () => {
  it('rejects a runtime with a missing port', async () => {
    const files = ['a.pdf'];
    await expect(
      advanceDisbursement({ input: inputFor(files), runtime: makeRuntime({ files, breakPort: 'report' }) })
    ).rejects.toThrow(/port "report" is not implemented/);
  });

  it('rejects a crosscheck port that resolves to the wrong shape', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files, crosscheckGarbage: true });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    await expect(
      advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload() })
    ).rejects.toThrow(/findings array/);
  });

  it('rejects a report port that resolves to blank', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files, reportEmpty: true });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    await expect(
      advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload() })
    ).rejects.toThrow(/non-empty string/);
  });

  it('refuses to ask for approval when sealed evidence is required but unavailable', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    input.requireEncryptedEvidence = true;
    const runtime = makeRuntime({ files, encryptionAvailable: false });
    let caught: unknown;
    try {
      await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    } catch (err) {
      caught = err;
    }
    expect((caught as DisbursementError).code).toBe('PORT_MISCONFIGURED');
    expect((caught as DisbursementError).retryable).toBe(true);
  });

  it('proceeds to the approval gate when the encryption seam is present', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    input.requireEncryptedEvidence = true;
    const runtime = makeRuntime({ files, encryptionAvailable: true });
    const { kind } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    expect(kind).toBe('wait-for-input');
  });
});

// ─── durability and terminal-state honesty ─────────────────────────────────

describe('P9-01 durability and terminal state', () => {
  it('checkpoints the sequential stages under stable step ids', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const seen: string[] = [];
    const runtime = makeRuntime({
      files,
      step: async <T,>(stepKey: string, _hash: string, fn: () => Promise<T>): Promise<T> => {
        seen.push(stepKey);
        return fn();
      },
    });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    await advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload() });
    expect(seen).toEqual([DISBURSEMENT_STEP_IDS.crosscheck, DISBURSEMENT_STEP_IDS.report]);
  });

  it('only ever terminates as SUCCEEDED or FAILED, never CANCELLED', async () => {
    const files = ['a.pdf'];
    const input = inputFor(files);
    const runtime = makeRuntime({ files });
    const { state: atGate } = await advancePastFanout(input, runtime, emptyDisbursementState(DISBURSEMENT_INPUT_VERSION));
    const approved = await advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload() });
    const rejected = await advanceDisbursement({ input, state: atGate, runtime, resume: resumePayload({ approved: false }) });
    for (const step of [approved, rejected]) {
      if (step.continuation.kind !== 'terminate') throw new Error('unreachable');
      expect(['SUCCEEDED', 'FAILED']).toContain(step.continuation.terminal);
      expect(step.continuation.terminal).not.toBe('CANCELLED');
    }
  });

  it('refuses a state written for a different input version', async () => {
    const files = ['a.pdf'];
    await expect(
      advanceDisbursement({
        input: inputFor(files),
        state: emptyDisbursementState('some-other-version'),
        runtime: makeRuntime({ files }),
      })
    ).rejects.toThrow(/State was written for input version/);
  });
});

// ─── pure helpers ──────────────────────────────────────────────────────────

describe('P9-01 evidence and corrections', () => {
  it('builds approval evidence that counts per file', () => {
    const evidence = buildApprovalEvidence({
      inputVersion: DISBURSEMENT_INPUT_VERSION,
      completedStages: [],
      classifications: [
        { fileName: 'a.pdf', logicalDocuments: [logicalDoc('a#1', 'a.pdf')] },
        { fileName: 'b.pdf', logicalDocuments: [logicalDoc('b#1', 'b.pdf'), logicalDoc('b#2', 'b.pdf')] },
      ],
      records: [extracted('a.pdf', 'a#1', { x: 1 }), extracted('b.pdf', 'b#1', { x: 2 })],
      childResults: [],
    });
    expect(evidence.filesAnalyzed).toBe(2);
    expect(evidence.logicalDocumentCount).toBe(3);
    expect(evidence.extractedRecordCount).toBe(2);
    expect(evidence.perFile[1]?.logicalDocumentCount).toBe(2);
  });

  it('leaves records untouched when there are no corrections', () => {
    const records = [extracted('a.pdf', 'a#1', { total: 1 })];
    const out = applyCorrections(records, { resumeSchemaVersion: DISBURSEMENT_RESUME_VERSION, approved: true, corrections: [] });
    expect(out).toBe(records);
  });
});
