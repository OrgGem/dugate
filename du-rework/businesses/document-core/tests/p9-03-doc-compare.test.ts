import {
  advanceDocCompare,
  emptyDocCompareState,
  normalizeDocCompareInput,
  runChunkChildren,
  DOC_COMPARE_RESUME_VERSION,
  type DocCompareRuntime,
  type DocCompareStep,
} from '../src/pipelines/workflows/doc-compare/doc-compare';
import type {
  ChunkOutcome,
  ChunkTaskSpec,
  DocCompareContinuation,
} from '../src/pipelines/workflows/doc-compare/primitives';
import {
  alignSections,
  buildStructureClaim,
  clampChunkBudget,
  extractSections,
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  mergeChunkEvidence,
  normalizeTitle,
  planChunks,
} from '../src/pipelines/workflows/doc-compare/chunking';
import type {
  ChunkEvidence,
  DocCompareResult,
  DocCompareState,
  DocumentSideInput,
} from '../src/pipelines/workflows/doc-compare/types';

function side(sideId: 'left' | 'right', fileName: string, text: string): DocumentSideInput {
  return {
    side: sideId,
    artifactId: 'artifact-' + sideId,
    fileName,
    text,
    sections: extractSections({ side: sideId, artifactId: 'artifact-' + sideId, fileName, text, sections: [] }),
  };
}

const LEFT_TEXT = ['# Contract', 'Preamble body.', '## Clause A', 'Alpha body.', '## Clause B', 'Beta body.'].join('\n');
const RIGHT_TEXT = ['# Contract', 'Preamble body.', '## Clause A', 'Alpha body CHANGED.', '## Clause C', 'Gamma body.'].join('\n');

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    left: { artifactId: 'artifact-left', fileName: 'left.pdf', text: LEFT_TEXT },
    right: { artifactId: 'artifact-right', fileName: 'right.pdf', text: RIGHT_TEXT },
    maxChunkChars: 4000,
    maxConcurrency: 2,
    ...overrides,
  };
}

function stubRuntime(options: { fail?: (spec: ChunkTaskSpec) => boolean } = {}): {
  runtime: DocCompareRuntime;
  calls: ChunkTaskSpec[];
} {
  const calls: ChunkTaskSpec[] = [];
  const runtime: DocCompareRuntime = {
    runChunk: async (spec: ChunkTaskSpec): Promise<ChunkOutcome> => {
      calls.push(spec);
      if (options.fail?.(spec)) {
        return { chunkId: spec.chunkId, status: 'failed', error: { code: 'CHUNK_FAILED', message: 'boom' } };
      }
      const chunk = (spec.input as { chunk: { side: 'left' | 'right'; ordinal: number; charCount: number } }).chunk;
      const evidence: ChunkEvidence = {
        chunkId: spec.chunkId,
        side: chunk.side,
        ordinal: chunk.ordinal,
        charCount: chunk.charCount,
        sectionIds: [],
        structureClaims: spec.stage === 'compare-structure'
          ? [{
              claimId: 'sc-' + spec.chunkId,
              verdict: 'unchanged' as const,
              leftSectionId: null,
              rightSectionId: null,
              leftTitle: null,
              rightTitle: null,
              detail: 'stub',
              evidenceChunkIds: [spec.chunkId],
            }]
          : [],
        referenceClaims: spec.stage === 'compare-references'
          ? [{
              claimId: 'rc-' + spec.chunkId,
              verdict: 'resolved' as const,
              reference: 'Clause A',
              sectionId: 'sec-1',
              side: chunk.side,
              target: 'Clause A',
              detail: 'stub',
              evidenceChunkIds: [spec.chunkId],
            }]
          : [],
      };
      return { chunkId: spec.chunkId, status: 'succeeded', evidence };
    },
  };
  return { runtime, calls };
}

/**
 * Drive the state machine to a terminal continuation, the way a host would.
 *
 * A single advance call can BOTH absorb a join AND issue the next fan-out, so a
 * driver that keeps only `.state` from that call silently drops the fan-out it
 * just handed back. This loop keeps the continuation.
 */
async function driveToTerminal(
  input: Record<string, unknown>,
  start: DocCompareState,
  runtime: DocCompareRuntime,
): Promise<{ state: DocCompareState; continuation: DocCompareContinuation<DocCompareResult> }> {
  let current = start;
  // Every advance may hand back a fan-out, INCLUDING the turn that absorbed a
  // join, so the pending join is carried explicitly instead of consumed inline.
  let pendingJoin: { joinToken: string; results: readonly ChunkOutcome[] } | null = null;
  for (let guard = 0; guard < 30; guard += 1) {
    const step: DocCompareStep = pendingJoin === null
      ? await advanceDocCompare({ input, state: current, runtime })
      : await advanceDocCompare({ input, state: current, runtime, join: pendingJoin });
    pendingJoin = null;
    if (step.continuation.kind === 'spawn-chunk-children') {
      const join = await runChunkChildren(step.continuation.children, runtime);
      pendingJoin = { joinToken: step.state.joinToken ?? '', results: join.results };
      current = step.state;
      continue;
    }
    return { state: step.state, continuation: step.continuation };
  }
  throw new Error('doc-compare did not reach a terminal continuation');
}

/** Run exactly the structure stage: fan out, join, return the state. */
async function runOneStage(input: Record<string, unknown>, runtime: DocCompareRuntime): Promise<DocCompareState> {
  const first = await advanceDocCompare({ input, state: emptyDocCompareState(normalizeDocCompareInput(input)), runtime });
  if (first.continuation.kind !== 'spawn-chunk-children') throw new Error('expected a fan-out');
  const join = await runChunkChildren(first.continuation.children, runtime);
  const next = await advanceDocCompare({
    input,
    state: first.state,
    runtime,
    join: { joinToken: first.state.joinToken ?? '', results: join.results },
  });
  return next.state;
}

describe('P9-03 doc-compare advanced', () => {
  describe('structure extraction + alignment', () => {
    it('splits sections deterministically and keeps content under its heading', () => {
      const left = side('left', 'l.pdf', LEFT_TEXT);
      expect(left.sections.length).toBe(3);
      expect(left.sections.map((s) => s.title)).toEqual(['Contract', 'Clause A', 'Clause B']);
      expect(left.sections[0]!.body).toContain('Preamble body.');
    });

    it('produces the same section ids for the same input (resume stability)', () => {
      const a = side('left', 'l.pdf', LEFT_TEXT);
      const b = side('left', 'l.pdf', LEFT_TEXT);
      expect(a.sections.map((s) => s.sectionId)).toEqual(b.sections.map((s) => s.sectionId));
    });

    it('pairs by exact title and reports a modified body', () => {
      const left = side('left', 'l.pdf', LEFT_TEXT);
      const right = side('right', 'r.pdf', RIGHT_TEXT);
      const pairs = alignSections(left.sections, right.sections);
      const claims = pairs.map((pair) => buildStructureClaim({ pair, chunkIds: ['c0'] }));
      expect(claims.some((c) => c.verdict === 'modified' && c.detail.includes('Body digests differ'))).toBe(true);
      expect(claims.some((c) => c.verdict === 'unchanged')).toBe(true);
      expect(pairs.find((p) => p.left?.title === 'Clause A')?.matchKind).toBe('exact');
    });

    it('reports added and removed when the unmatched sets are UNEQUAL', () => {
      const left = side('left', 'l.pdf', LEFT_TEXT);
      const right = side('right', 'r.pdf', ['# Contract', 'Preamble body.', '## Clause A', 'Alpha body CHANGED.'].join('\n'));
      const claims = alignSections(left.sections, right.sections).map((pair) =>
        buildStructureClaim({ pair, chunkIds: ['c'] }),
      );
      const removed = claims.filter((c) => c.verdict === 'removed');
      expect(removed.length).toBe(1);
      expect(removed.every((c) => c.detail.includes('only on the left'))).toBe(true);
    });

    it('reports added when the right side has sections the left lacks', () => {
      const left = side('left', 'l.pdf', ['# Contract', 'Preamble body.'].join('\n'));
      const right = side('right', 'r.pdf', RIGHT_TEXT);
      const claims = alignSections(left.sections, right.sections).map((pair) =>
        buildStructureClaim({ pair, chunkIds: ['c'] }),
      );
      const added = claims.filter((c) => c.verdict === 'added');
      expect(added.length).toBe(2);
      expect(added.every((c) => c.detail.includes('only on the right'))).toBe(true);
    });

    it('pairs positionally ONLY when both unmatched sets are the same size', () => {
      const left = side('left', 'l.pdf', ['# T', 'a', '## Old Name', 'b'].join('\n'));
      const right = side('right', 'r.pdf', ['# T', 'a', '## New Name', 'b'].join('\n'));
      const renamed = alignSections(left.sections, right.sections).find((p) => p.left?.title === 'Old Name');
      expect(renamed?.right?.title).toBe('New Name');
      expect(renamed?.matchKind).toBe('positional');
    });

    it('strips combining accents so accented titles still pair', () => {
      expect(normalizeTitle('Clause Á')).toBe(normalizeTitle('clause a'));
      expect(normalizeTitle('Điều 5:  Điều khoản')).toBe('đieu 5 đieu khoan');
    });

    it('every structure claim carries evidence chunk references', () => {
      const left = side('left', 'l.pdf', LEFT_TEXT);
      const right = side('right', 'r.pdf', RIGHT_TEXT);
      const claims = alignSections(left.sections, right.sections).map((pair) =>
        buildStructureClaim({ pair, chunkIds: ['left-c0', 'right-c0'] }),
      );
      for (const claim of claims) expect(claim.evidenceChunkIds).toEqual(['left-c0', 'right-c0']);
    });

    it('emits NO confidence field anywhere (no fabricated score)', () => {
      const left = side('left', 'l.pdf', LEFT_TEXT);
      const right = side('right', 'r.pdf', RIGHT_TEXT);
      const claims = alignSections(left.sections, right.sections).map((pair) =>
        buildStructureClaim({ pair, chunkIds: ['c'] }),
      );
      const serialized = JSON.stringify(claims);
      expect(serialized).not.toContain('confidence');
      expect(serialized).not.toContain('score');
      expect(claims.length).toBeGreaterThan(0);
    });
  });

  describe('bounded chunking', () => {
    it('never emits a chunk larger than the budget for many small sections', () => {
      const big = Array.from({ length: 12 }, (_, i) => '## S' + i + '\n' + 'x'.repeat(300)).join('\n');
      const chunks = planChunks(side('left', 'big.pdf', big), 800);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.charCount).toBeLessThanOrEqual(800);
    });

    it('splits one oversized section on size WITHOUT dropping or duplicating bytes', () => {
      const huge = '# Only\n' + 'y'.repeat(5000);
      const chunks = planChunks(side('left', 'huge.pdf', huge), 1000);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.boundaryKind === 'size')).toBe(true);
      const covered = chunks.reduce((sum, c) => sum + c.charCount, 0);
      expect(covered).toBe(5000);
      expect(chunks[chunks.length - 1]!.endOffset).toBe(5000);
    });

    it('produces one chunk for an empty document rather than none', () => {
      const chunks = planChunks(side('left', 'empty.pdf', ''), 4000);
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.charCount).toBe(0);
    });

    it('clamps an absurd budget to the ceiling', () => {
      expect(clampChunkBudget(Number.MAX_SAFE_INTEGER)).toBe(MAX_CHUNK_CHARS);
      expect(clampChunkBudget(-5)).toBe(MIN_CHUNK_CHARS);
      expect(clampChunkBudget(1.5)).toBe(MIN_CHUNK_CHARS);
    });

    it('produces byte-identical plans for identical input (resume determinism)', () => {
      const left = side('left', 'l.pdf', LEFT_TEXT);
      expect(JSON.stringify(planChunks(left, 4000))).toBe(JSON.stringify(planChunks(left, 4000)));
    });
  });

  describe('advance: typed continuations', () => {
    it('stage 1 emits a structure fan-out with a join token and bounded concurrency', async () => {
      const { runtime } = stubRuntime();
      const step = await advanceDocCompare({ input: baseInput(), runtime });
      if (step.continuation.kind !== 'spawn-chunk-children') throw new Error('unreachable');
      expect(step.continuation.stage).toBe('compare-structure');
      expect(step.continuation.children.length).toBeGreaterThan(0);
      expect(step.continuation.maxConcurrency).toBeLessThanOrEqual(8);
      expect(step.state.joinToken).toBe(step.continuation.joinToken);
    });

    it('structure and reference comparison are DISTINCT stages with typed state between', async () => {
      const { runtime, calls } = stubRuntime();
      const final = await driveToTerminal(baseInput(), emptyDocCompareState(normalizeDocCompareInput(baseInput())), runtime);
      if (final.continuation.kind !== 'terminate') throw new Error('unreachable');
      const structureCalls = calls.filter((c) => c.stage === 'compare-structure');
      const referenceCalls = calls.filter((c) => c.stage === 'compare-references');
      expect(structureCalls.length).toBeGreaterThan(0);
      expect(referenceCalls.length).toBeGreaterThan(0);
      expect(structureCalls.length).toBe(referenceCalls.length);
      const data = final.continuation.data!;
      expect(data.evidence.structureClaims.length).toBeGreaterThan(0);
      expect(data.evidence.referenceClaims.length).toBeGreaterThan(0);
    });

    it('rejects a join whose token does not match the pending stage', async () => {
      const { runtime } = stubRuntime();
      const first = await advanceDocCompare({ input: baseInput(), runtime });
      if (first.continuation.kind !== 'spawn-chunk-children') throw new Error('unreachable');
      await expect(
        advanceDocCompare({
          input: baseInput(),
          state: first.state,
          runtime,
          join: { joinToken: 'wrong-token', results: [] },
        }),
      ).rejects.toThrow(/Join token does not match/);
    });

    it('rejects a join naming a chunk that was never issued', async () => {
      const { runtime } = stubRuntime();
      const first = await advanceDocCompare({ input: baseInput(), runtime });
      if (first.continuation.kind !== 'spawn-chunk-children') throw new Error('unreachable');
      await expect(
        advanceDocCompare({
          input: baseInput(),
          state: first.state,
          runtime,
          join: { joinToken: first.state.joinToken ?? '', results: [{ chunkId: 'invented', status: 'succeeded' }] },
        }),
      ).rejects.toThrow(/not issued/);
    });

    it('refuses an identity field instead of honouring it', () => {
      expect(() => normalizeDocCompareInput(baseInput({ apiKeyId: 'attacker' }))).toThrow(/not accepted/);
      expect(() =>
        normalizeDocCompareInput({ ...baseInput(), left: { artifactId: 'a', fileName: 'l', text: 't', tenantId: 'x' } }),
      ).toThrow(/not accepted/);
    });

    it('requires an artifactId on each side', () => {
      expect(() => normalizeDocCompareInput({ ...baseInput(), left: { fileName: 'l', text: 't' } })).toThrow(/artifactId/);
    });
  });

  describe('resume from checkpoint', () => {
    it('a resumed stage re-issues ONLY the chunks missing from the ledger', async () => {
      const { runtime, calls } = stubRuntime();
      const input = baseInput();
      const afterStructure = await runOneStage(input, runtime);
      const structureCalls = calls.length;
      expect(Object.keys(afterStructure.chunkEvidence).filter((k) => k.startsWith('compare-structure:')).length)
        .toBe(structureCalls);

      const issued = await advanceDocCompare({ input, state: afterStructure, runtime });
      if (issued.continuation.kind !== 'spawn-chunk-children') throw new Error('unreachable');
      const issuedIds = issued.continuation.children.map((c) => c.chunkId).sort();
      expect(issuedIds.length).toBeGreaterThan(0);

      const callsBeforeResume = calls.length;
      const resumed = await advanceDocCompare({ input, state: issued.state, runtime });
      if (resumed.continuation.kind !== 'spawn-chunk-children') throw new Error('unreachable');
      expect(resumed.continuation.children.map((c) => c.chunkId).sort()).toEqual(issuedIds);
      expect(calls.length).toBe(callsBeforeResume);
    });

    it('a partially-evidenced stage drops the completed chunk from the ledger', async () => {
      const { runtime } = stubRuntime();
      const input = baseInput();
      const afterStructure = await runOneStage(input, runtime);
      const issued = await advanceDocCompare({ input, state: afterStructure, runtime });
      if (issued.continuation.kind !== 'spawn-chunk-children') throw new Error('unreachable');
      const children = issued.continuation.children;
      expect(children.length).toBeGreaterThanOrEqual(2);

      const firstChild = children[0]!;
      const chunk = (firstChild.input as { chunk: { side: 'left' | 'right'; ordinal: number; charCount: number } }).chunk;
      const partial = await advanceDocCompare({
        input,
        state: issued.state,
        runtime,
        join: {
          joinToken: issued.state.joinToken ?? '',
          results: [{
            chunkId: firstChild.chunkId,
            status: 'succeeded',
            evidence: {
              chunkId: firstChild.chunkId,
              side: chunk.side,
              ordinal: chunk.ordinal,
              charCount: chunk.charCount,
              sectionIds: [],
              structureClaims: [],
              referenceClaims: [],
            },
          }],
        },
      });
      expect(Object.keys(partial.state.chunkEvidence).some((k) => k.includes(firstChild.chunkId))).toBe(true);
    });
  });

  describe('merge + evidence', () => {
    it('terminates SUCCEEDED with one merged evidence record', async () => {
      const { runtime } = stubRuntime();
      const final = await driveToTerminal(baseInput(), emptyDocCompareState(normalizeDocCompareInput(baseInput())), runtime);
      if (final.continuation.kind !== 'terminate') throw new Error('unreachable');
      expect(final.continuation.terminal).toBe('SUCCEEDED');
      const data = final.continuation.data!;
      expect(data.evidence.leftFileName).toBe('left.pdf');
      expect(data.evidence.rightFileName).toBe('right.pdf');
      expect(data.evidence.incompleteChunks).toEqual([]);
    });

    it('merge counts verdicts and never invents a confidence value', () => {
      const evidence = mergeChunkEvidence({
        leftFileName: 'l',
        rightFileName: 'r',
        chunks: [{
          chunkId: 'c0',
          side: 'left',
          ordinal: 0,
          charCount: 10,
          sectionIds: [],
          structureClaims: [{
            claimId: 'a', verdict: 'modified', leftSectionId: null, rightSectionId: null,
            leftTitle: null, rightTitle: null, detail: 'd', evidenceChunkIds: ['c0'],
          }],
          referenceClaims: [],
        }],
        failedChunkIds: [],
      });
      expect(evidence.verdictCounts.modified).toBe(1);
      expect(evidence.verdictCounts.unchanged).toBe(0);
      expect(JSON.stringify(evidence)).not.toContain('confidence');
    });

    it('records failed chunks as incomplete rather than silently dropping them', () => {
      const evidence = mergeChunkEvidence({
        leftFileName: 'l',
        rightFileName: 'r',
        chunks: [],
        failedChunkIds: ['left-c2', 'left-c0'],
      });
      expect(evidence.incompleteChunks).toEqual(['left-c0', 'left-c2']);
      expect(evidence.chunkCount).toBe(0);
    });

    it('FAILS closed when a chunk failed and continueOnPartialFailure is off', async () => {
      const { runtime } = stubRuntime({ fail: () => true });
      const input = baseInput({ continueOnPartialFailure: false });
      const final = await driveToTerminal(input, emptyDocCompareState(normalizeDocCompareInput(input)), runtime);
      if (final.continuation.kind !== 'terminate') throw new Error('unreachable');
      expect(final.continuation.terminal).toBe('FAILED');
      expect(final.continuation.failure?.code).toBe('CHUNK_FAILED');
    });

    it('records partial evidence and succeeds when continueOnPartialFailure is on', async () => {
      const { runtime } = stubRuntime({ fail: (spec) => spec.chunkId === 'left-c0' });
      const input = baseInput({ continueOnPartialFailure: true });
      const final = await driveToTerminal(input, emptyDocCompareState(normalizeDocCompareInput(input)), runtime);
      if (final.continuation.kind !== 'terminate') throw new Error('unreachable');
      expect(final.continuation.terminal).toBe('SUCCEEDED');
      expect(final.continuation.data!.incompleteChunks.length).toBeGreaterThan(0);
    });

    it('never declares a cancellation as a terminal outcome', async () => {
      const { runtime } = stubRuntime();
      const input = baseInput({ requireHumanReview: true });
      const waited = await driveToTerminal(input, emptyDocCompareState(normalizeDocCompareInput(input)), runtime);
      expect(waited.continuation.kind).toBe('wait-for-review');
      expect(JSON.stringify(waited.continuation)).not.toContain('CANCELLED');
    });
  });

  describe('human review gate', () => {
    it('waits for review when required, then terminates on acceptance', async () => {
      const { runtime } = stubRuntime();
      const input = baseInput({ requireHumanReview: true });
      const waited = await driveToTerminal(input, emptyDocCompareState(normalizeDocCompareInput(input)), runtime);
      if (waited.continuation.kind !== 'wait-for-review') throw new Error('unreachable');
      expect(waited.continuation.resumeSchemaVersion).toBe(DOC_COMPARE_RESUME_VERSION);
      const accepted = await advanceDocCompare({
        input,
        state: waited.state,
        runtime,
        resume: { resumeSchemaVersion: DOC_COMPARE_RESUME_VERSION, accepted: true, acceptedBy: 'reviewer' },
      });
      if (accepted.continuation.kind !== 'terminate') throw new Error('unreachable');
      expect(accepted.continuation.terminal).toBe('SUCCEEDED');
    });

    it('FAILS when the reviewer rejects; absence of approval is never consent', async () => {
      const { runtime } = stubRuntime();
      const input = baseInput({ requireHumanReview: true });
      const waited = await driveToTerminal(input, emptyDocCompareState(normalizeDocCompareInput(input)), runtime);
      if (waited.continuation.kind !== 'wait-for-review') throw new Error('unreachable');
      const rejected = await advanceDocCompare({
        input,
        state: waited.state,
        runtime,
        resume: { resumeSchemaVersion: DOC_COMPARE_RESUME_VERSION, accepted: false, acceptedBy: 'reviewer' },
      });
      if (rejected.continuation.kind !== 'terminate') throw new Error('unreachable');
      expect(rejected.continuation.terminal).toBe('FAILED');
      expect(rejected.continuation.failure?.code).toBe('REVIEW_REJECTED');
    });

    it('rejects a resume with the wrong schema version', async () => {
      const { runtime } = stubRuntime();
      const input = baseInput({ requireHumanReview: true });
      const waited = await driveToTerminal(input, emptyDocCompareState(normalizeDocCompareInput(input)), runtime);
      await expect(
        advanceDocCompare({
          input,
          state: waited.state,
          runtime,
          resume: { resumeSchemaVersion: 'doc-compare-resume-v0', accepted: true },
        }),
      ).rejects.toThrow(/Unsupported resume schema version/);
    });
  });

  describe('fan-out executor', () => {
    it('runs every child and reports one outcome per chunk', async () => {
      const { runtime, calls } = stubRuntime();
      const specs: ChunkTaskSpec[] = ['a', 'b', 'c'].map((id) => ({
        chunkId: id,
        stage: 'compare-structure' as const,
        input: { chunk: { side: 'left' as const, ordinal: 0, charCount: 1 } },
      }));
      const join = await runChunkChildren(specs, runtime);
      expect(calls.length).toBe(3);
      expect(join.results.length).toBe(3);
      expect(join.results.every((r) => r.status === 'succeeded')).toBe(true);
    });

    it('converts a thrown child into a failed outcome rather than crashing the join', async () => {
      const runtime: DocCompareRuntime = {
        runChunk: async () => { throw new Error('provider exploded'); },
      };
      const join = await runChunkChildren([{ chunkId: 'x', stage: 'compare-references', input: {} }], runtime);
      expect(join.results[0]!.status).toBe('failed');
      expect(join.results[0]!.error?.message).toBe('provider exploded');
    });
  });
});
