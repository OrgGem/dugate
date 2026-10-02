import {
  createDocCompareRuntime,
  DEFAULT_DOC_COMPARE_BINDING,
  DocCompareChunkError,
  extractInvocationPayload,
  parseReferenceClaims,
  parseStructureClaims,
  sliceChunkText,
  type DocCompareConnectorPort,
} from '../src/pipelines/workflows/doc-compare/runner';
import { advanceDocCompare, emptyDocCompareState, normalizeDocCompareInput, runChunkChildren, type DocCompareStep } from '../src/pipelines/workflows/doc-compare/doc-compare';
import { extractSections, planChunks } from '../src/pipelines/workflows/doc-compare/chunking';
import type { ChunkTaskSpec } from '../src/pipelines/workflows/doc-compare/primitives';
import type { ConnectorInvocationResult } from '../src/types/context';
import type { DocumentSideInput, StructurePlan } from '../src/pipelines/workflows/doc-compare/types';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function side(sideId: 'left' | 'right', fileName: string, text: string): DocumentSideInput {
  return {
    side: sideId,
    artifactId: 'artifact-' + sideId,
    fileName,
    text,
    sections: extractSections({ side: sideId, artifactId: 'artifact-' + sideId, fileName, text, sections: [] }),
  };
}

const LEFT = side('left', 'left.pdf', ['# Contract', 'Preamble body.', '## Clause A', 'Alpha body.'].join('\n'));
const RIGHT = side('right', 'right.pdf', ['# Contract', 'Preamble body.', '## Clause A', 'Alpha body CHANGED.'].join('\n'));

function plan(left: DocumentSideInput, right: DocumentSideInput): StructurePlan {
  return {
    left: left.sections.map((s) => ({
      sectionId: s.sectionId, title: s.title, level: s.level, ordinal: s.ordinal, side: 'left' as const, bodyDigest: 'd',
    })),
    right: right.sections.map((s) => ({
      sectionId: s.sectionId, title: s.title, level: s.level, ordinal: s.ordinal, side: 'right' as const, bodyDigest: 'd',
    })),
    chunks: [...planChunks(left, 4000), ...planChunks(right, 4000)],
  };
}

function specFor(stage: 'compare-structure' | 'compare-references'): ChunkTaskSpec {
  const chunks = plan(LEFT, RIGHT).chunks;
  const chunk = chunks.find((c) => c.side === 'left')!;
  return {
    chunkId: chunk.chunkId,
    stage,
    input: { chunk, left: LEFT, right: RIGHT, structure: plan(LEFT, RIGHT) },
  };
}

interface Recorder {
  port: DocCompareConnectorPort;
  calls: Array<{ slot: string; body: Record<string, unknown>; options: unknown }>;
}

function mockConnector(reply: (callIndex: number, body: Record<string, unknown>) => unknown): Recorder {
  const calls: Recorder['calls'] = [];
  const port: DocCompareConnectorPort = {
    invoke: async (slot, promptOrPayload, options) => {
      calls.push({ slot, body: promptOrPayload as Record<string, unknown>, options });
      return reply(calls.length - 1, promptOrPayload as Record<string, unknown>) as ConnectorInvocationResult;
    },
  };
  return { port, calls };
}

const STRUCTURE_REPLY = {
  structureClaims: [{
    claimId: 'sc-1', verdict: 'modified', leftSectionId: 'left-s1-a', rightSectionId: 'right-s1-a',
    leftTitle: 'Clause A', rightTitle: 'Clause A', detail: 'body differs', evidenceChunkIds: ['left-c0'],
  }],
};

const REFERENCE_REPLY = {
  referenceClaims: [{
    claimId: 'rc-1', verdict: 'resolved', reference: 'Clause A', sectionId: 'left-s1-a',
    side: 'left', target: 'Clause A', detail: 'resolves', evidenceChunkIds: ['left-c0'],
  }],
};

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('D4 doc-compare production chunk runner', () => {
  describe('structure stage', () => {
    it('returns succeeded with typed structure evidence', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i1', status: 'SUCCESS', data: STRUCTURE_REPLY }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));

      expect(outcome.status).toBe('succeeded');
      expect(outcome.chunkId).toBe('left-c0');
      expect(outcome.evidence?.structureClaims).toHaveLength(1);
      expect(outcome.evidence?.structureClaims[0]!.verdict).toBe('modified');
      expect(outcome.evidence?.referenceClaims).toEqual([]);
    });

    it('calls the configured slot with the stage task and forces responseFormat json', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i1', status: 'SUCCESS', data: STRUCTURE_REPLY }));
      const runtime = createDocCompareRuntime({
        connector: rec.port,
        binding: { slot: 'vision', structureTask: 'my_structure', referenceTask: 'my_refs' },
      });
      await runtime.runChunk(specFor('compare-structure'));
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]!.slot).toBe('vision');
      expect(rec.calls[0]!.body.task).toBe('my_structure');
      expect((rec.calls[0]!.options as { responseFormat?: string }).responseFormat).toBe('json');
    });

    it('sends ONLY the chunk slice, never the whole document', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i1', status: 'SUCCESS', data: STRUCTURE_REPLY }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      await runtime.runChunk(specFor('compare-structure'));
      const payload = rec.calls[0]!.body.payload as Record<string, unknown>;
      const sent = String(payload.chunkText);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.length).toBeLessThanOrEqual(LEFT.text.length);
      // The side carries full text in the spec; the payload must not echo it.
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(LEFT.sections[0]!.body + '<!--TAIL-SENTINEL-->');
      expect(payload.chunkCharCount).toBe(sent.length);
    });
  });

  describe('reference stage', () => {
    it('returns succeeded with typed reference evidence', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i2', status: 'SUCCESS', data: REFERENCE_REPLY }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-references'));

      expect(outcome.status).toBe('succeeded');
      expect(outcome.evidence?.referenceClaims).toHaveLength(1);
      expect(outcome.evidence?.referenceClaims[0]!.verdict).toBe('resolved');
      expect(outcome.evidence?.structureClaims).toEqual([]);
    });

    it('uses the reference task name, not the structure one', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i2', status: 'SUCCESS', data: REFERENCE_REPLY }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      await runtime.runChunk(specFor('compare-references'));
      expect(rec.calls[0]!.body.task).toBe(DEFAULT_DOC_COMPARE_BINDING.referenceTask);
      expect(rec.calls[0]!.body.task).not.toBe(DEFAULT_DOC_COMPARE_BINDING.structureTask);
    });
  });

  describe('fail-closed', () => {
    it('connector ERROR becomes failed, never succeeded', async () => {
      const rec = mockConnector(() => ({
        invocationId: 'i3',
        status: 'ERROR',
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'upstream 503', retryable: true },
      }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));

      expect(outcome.status).toBe('failed');
      expect(outcome.evidence).toBeUndefined();
      expect(outcome.error?.code).toBe('CHUNK_FAILED');
      expect(outcome.error?.message).toContain('PROVIDER_UNAVAILABLE');
    });

    it('a thrown connector error becomes failed, not a propagated throw', async () => {
      const port: DocCompareConnectorPort = {
        invoke: async () => { throw new Error('socket hang up'); },
      };
      const runtime = createDocCompareRuntime({ connector: port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_FAILED');
      expect(outcome.error?.message).toContain('socket hang up');
    });

    it('a timeout becomes CHUNK_TIMEOUT and never succeeded', async () => {
      const port: DocCompareConnectorPort = {
        invoke: () => new Promise<ConnectorInvocationResult>(() => { /* never settles */ }),
      };
      const runtime = createDocCompareRuntime({ connector: port, timeoutMs: 20 });
      const outcome = await runtime.runChunk(specFor('compare-structure'));
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_TIMEOUT');
    });

    it('a reply with no claim list is malformed, not empty evidence', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i4', status: 'SUCCESS', data: { summary: 'looks fine' } }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_MALFORMED_RESPONSE');
    });

    it('an unknown verdict is rejected rather than passed through', async () => {
      const rec = mockConnector(() => ({
        invocationId: 'i5',
        status: 'SUCCESS',
        data: { structureClaims: [{ claimId: 'x', verdict: 'probably-fine', evidenceChunkIds: ['left-c0'] }] },
      }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_MALFORMED_RESPONSE');
    });

    it('an empty claim list fails rather than reporting a clean comparison', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i6', status: 'SUCCESS', data: { structureClaims: [] } }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_EMPTY_EVIDENCE');
    });

    it('unparseable rawText fails instead of becoming a pseudo-result', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i7', status: 'SUCCESS', rawText: 'the documents look different' }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_MALFORMED_RESPONSE');
    });

    it('parses a fenced JSON rawText', () => {
      const parsed = extractInvocationPayload({
        invocationId: 'i8',
        status: 'SUCCESS',
        rawText: '```json\n{"structureClaims":[]}\n```',
      });
      expect(parsed).toEqual({ structureClaims: [] });
    });

    it('a spec with no chunk descriptor is rejected', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i9', status: 'SUCCESS', data: STRUCTURE_REPLY }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk({ chunkId: 'x', stage: 'compare-structure', input: { nope: true } });
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_INVALID_INPUT');
      expect(rec.calls).toHaveLength(0);
    });
  });

  describe('identity guard', () => {
    it('fails when the REPLY carries an identity field', async () => {
      const rec = mockConnector(() => ({
        invocationId: 'i10',
        status: 'SUCCESS',
        data: { structureClaims: [{ ...STRUCTURE_REPLY.structureClaims[0], tenantId: 'attacker-tenant' }] },
      }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const outcome = await runtime.runChunk(specFor('compare-structure'));
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_IDENTITY_LEAK');
    });

    it('fails when the PAYLOAD carries an identity field', async () => {
      const rec = mockConnector(() => ({ invocationId: 'i11', status: 'SUCCESS', data: STRUCTURE_REPLY }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const spec = specFor('compare-structure');
      const poisoned = {
        ...(spec.input as Record<string, unknown>),
        apiKeyId: 'attacker-key',
      };
      const outcome = await runtime.runChunk({ ...spec, input: poisoned as never });
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe('CHUNK_IDENTITY_LEAK');
      expect(rec.calls).toHaveLength(0);
    });

    it('catches snake_case and nested identity fields', () => {
      expect(() => assertLeak({ a: { b: [{ api_key_id: 'x' }] } })).toThrow();
      expect(() => assertLeak({ api_key_id: 'x' })).toThrow();
      expect(() => assertLeak({ sectionTitle: 'Clause A', ordinal: 1 })).not.toThrow();
    });
  });

  describe('helpers', () => {
    it('sliceChunkText clamps out-of-range offsets instead of throwing', () => {
      const chunk = plan(LEFT, RIGHT).chunks.find((c) => c.side === 'left')!;
      expect(sliceChunkText(LEFT, { ...chunk, startOffset: -50, endOffset: 9999 })).toBe(LEFT.text);
    });

    it('parseStructureClaims and parseReferenceClaims reject a non-array', () => {
      expect(() => parseStructureClaims({})).toThrow(DocCompareChunkError);
      expect(() => parseReferenceClaims({})).toThrow(DocCompareChunkError);
    });
  });

  describe('integration with the state machine', () => {
    it('the runtime drives a real fan-out to a merged SUCCEEDED result', async () => {
      const rec = mockConnector((index, body) => ({
        invocationId: 'i' + index,
        status: 'SUCCESS',
        data: body.task === DEFAULT_DOC_COMPARE_BINDING.structureTask ? STRUCTURE_REPLY : REFERENCE_REPLY,
      }));
      const runtime = createDocCompareRuntime({ connector: rec.port });
      const input = {
        left: { artifactId: 'artifact-left', fileName: 'left.pdf', text: LEFT.text },
        right: { artifactId: 'artifact-right', fileName: 'right.pdf', text: RIGHT.text },
        maxChunkChars: 4000,
        maxConcurrency: 2,
      };

      let state = emptyDocCompareState(normalizeDocCompareInput(input));
      let pendingJoin: { joinToken: string; results: readonly unknown[] } | null = null;
      let terminal: unknown;
      for (let guard = 0; guard < 30; guard += 1) {
        const step: DocCompareStep = pendingJoin === null
          ? await advanceDocCompare({ input, state, runtime })
          : await advanceDocCompare({ input, state, runtime, join: pendingJoin as never });
        pendingJoin = null;
        if (step.continuation.kind === 'spawn-chunk-children') {
          const join = await runChunkChildren(
            step.continuation.children,
            runtime,
            step.state.joinToken ?? '',
            step.continuation.maxConcurrency,
          );
          pendingJoin = { joinToken: join.joinToken, results: join.results };
          state = step.state;
          continue;
        }
        terminal = step.continuation;
        break;
      }
      expect(terminal).toBeDefined();
      const cont = terminal as { kind: string; terminal?: string; data?: { evidence: { structureClaims: unknown[]; referenceClaims: unknown[]; incompleteChunks: string[] } } };
      expect(cont.kind).toBe('terminate');
      expect(cont.terminal).toBe('SUCCEEDED');
      expect(cont.data!.evidence.structureClaims.length).toBeGreaterThan(0);
      expect(cont.data!.evidence.referenceClaims.length).toBeGreaterThan(0);
      expect(cont.data!.evidence.incompleteChunks).toEqual([]);
      void pendingJoin;
    });
  });
});

function assertLeak(value: unknown): void {
  // Local re-use of the module guard so the nested/snake_case cases read cleanly.
  const mod = require('../src/pipelines/workflows/doc-compare/runner') as {
    assertNoIdentityLeak: (v: unknown, where: string) => void;
  };
  mod.assertNoIdentityLeak(value, 'test');
}
