import { documentCoreHandlers } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';
import { BusinessExecutionError } from '../src/types/results';

/**
 * FT-01 — Six-action fail-closed matrix (functional, offline, zero DB).
 * Anchor: tasks/P5-document-core.md row P5-10 [~] (negative leg of the six-action
 * E2E / facade-parity matrix) + P5-02..P5-09 acceptance promises
 * ("parser không tự gọi LLM", "custom schema reject trước inference", error taxonomy).
 *
 * Why functional-not-unit:
 *  - bounded-input.test.ts exercises InputNormalizer in isolation;
 *  - all-variants-e2e.test.ts exercises only happy paths;
 *  - this suite runs the REAL documentCoreHandlers with invalid inputs and audits
 *    pipeline side-effect boundaries: zero connector invoke + zero artifact write +
 *    zero step checkpoint for every fail-closed case.
 */

interface FailClosedCase {
  action: string;
  name: string;
  payload: Record<string, unknown>;
  code: string;
}

const INVALID_CASES: FailClosedCase[] = [
  // --- ingest (DOC-01, 4 variants) ---
  { action: 'ingest', name: 'missing mode discriminator', payload: {}, code: 'MISSING_DISCRIMINATOR' },
  { action: 'ingest', name: 'unknown mode', payload: { mode: 'scan', text: 'x' }, code: 'INVALID_DISCRIMINATOR' },
  {
    action: 'ingest',
    name: 'too many artifacts',
    payload: { mode: 'parse', artifactIds: Array.from({ length: 21 }, (_, i) => `art-${i}`) },
    code: 'TOO_MANY_ARTIFACTS',
  },
  {
    action: 'ingest',
    name: 'document too large',
    payload: { mode: 'parse', text: 'A'.repeat(100_001) },
    code: 'DOCUMENT_TOO_LARGE',
  },
  { action: 'ingest', name: 'page limit exceeded', payload: { mode: 'split', pages: '501' }, code: 'PAGE_LIMIT_EXCEEDED' },
  { action: 'ingest', name: 'invalid page range syntax', payload: { mode: 'split', pages: '1-5; rm -rf /' }, code: 'INVALID_PAGE_RANGE' },

  // --- extract (DOC-02, 5 variants) ---
  { action: 'extract', name: 'missing type discriminator', payload: {}, code: 'MISSING_DISCRIMINATOR' },
  { action: 'extract', name: 'unknown type', payload: { type: 'pdf', text: 'x' }, code: 'INVALID_DISCRIMINATOR' },
  {
    action: 'extract',
    name: 'too many artifacts',
    payload: { type: 'invoice', artifactIds: Array.from({ length: 11 }, (_, i) => `art-${i}`) },
    code: 'TOO_MANY_ARTIFACTS',
  },
  {
    action: 'extract',
    name: 'document too large',
    payload: { type: 'invoice', text: 'A'.repeat(100_001) },
    code: 'DOCUMENT_TOO_LARGE',
  },
  { action: 'extract', name: 'malformed custom schema JSON', payload: { type: 'custom', schema: '{ bad json' }, code: 'INVALID_CUSTOM_SCHEMA' },
  { action: 'extract', name: 'forbidden network $ref', payload: { type: 'custom', schema: { $ref: 'https://evil.example/schema' } }, code: 'FORBIDDEN_SCHEMA_REF' },
  {
    action: 'extract',
    name: 'schema depth exceeded',
    payload: { type: 'custom', schema: buildDeepSchema(7) },
    code: 'SCHEMA_DEPTH_EXCEEDED',
  },

  // --- analyze (DOC-03, 5 variants) ---
  { action: 'analyze', name: 'missing task discriminator', payload: {}, code: 'MISSING_DISCRIMINATOR' },
  { action: 'analyze', name: 'unknown task', payload: { task: 'chat', text: 'x' }, code: 'INVALID_DISCRIMINATOR' },
  { action: 'analyze', name: 'classify without categories', payload: { task: 'classify', text: 'x' }, code: 'MISSING_REQUIRED_PARAMETER' },
  { action: 'analyze', name: 'compliance without criteria', payload: { task: 'compliance', text: 'x' }, code: 'MISSING_REQUIRED_PARAMETER' },
  {
    action: 'analyze',
    name: 'too many artifacts',
    payload: { task: 'classify', artifactIds: Array.from({ length: 11 }, (_, i) => `art-${i}`) },
    code: 'TOO_MANY_ARTIFACTS',
  },

  // --- transform (DOC-04, 5 variants) ---
  { action: 'transform', name: 'missing variant discriminator', payload: {}, code: 'MISSING_DISCRIMINATOR' },
  { action: 'transform', name: 'unknown variant', payload: { variant: 'excel', text: 'x' }, code: 'INVALID_DISCRIMINATOR' },
  { action: 'transform', name: 'translate without targetLanguage', payload: { variant: 'translate', text: 'hello' }, code: 'MISSING_REQUIRED_PARAMETER' },
  { action: 'transform', name: 'template without template', payload: { variant: 'template', text: 'hello' }, code: 'MISSING_REQUIRED_PARAMETER' },
  {
    action: 'transform',
    name: 'too many artifacts',
    payload: { variant: 'rewrite', artifactIds: Array.from({ length: 11 }, (_, i) => `art-${i}`) },
    code: 'TOO_MANY_ARTIFACTS',
  },

  // --- generate (DOC-05, 6 variants) ---
  { action: 'generate', name: 'missing task discriminator', payload: {}, code: 'MISSING_DISCRIMINATOR' },
  { action: 'generate', name: 'unknown task', payload: { task: 'chat', text: 'x' }, code: 'INVALID_DISCRIMINATOR' },
  { action: 'generate', name: 'qa without questions', payload: { task: 'qa' }, code: 'MISSING_REQUIRED_PARAMETER' },
  { action: 'generate', name: 'maxWords must be positive', payload: { task: 'summary', text: 'x', maxWords: 0 }, code: 'INVALID_ARGUMENT' },
  { action: 'generate', name: 'maxWords exceeds limit', payload: { task: 'summary', text: 'x', maxWords: 10_001 }, code: 'INVALID_PARAMETER_RANGE' },
  {
    action: 'generate',
    name: 'too many artifacts',
    payload: { task: 'summary', artifactIds: Array.from({ length: 11 }, (_, i) => `art-${i}`) },
    code: 'TOO_MANY_ARTIFACTS',
  },

  // --- compare (DOC-06, 3 variants) ---
  { action: 'compare', name: 'missing mode discriminator', payload: {}, code: 'MISSING_DISCRIMINATOR' },
  { action: 'compare', name: 'unknown mode', payload: { mode: 'merge', source: 'a', target: 'b' }, code: 'INVALID_DISCRIMINATOR' },
  { action: 'compare', name: 'missing both sides', payload: { mode: 'diff' }, code: 'MISSING_COMPARISON_SIDE' },
  { action: 'compare', name: 'canonical and alias conflict', payload: { mode: 'diff', source: 'a', source_file: 'f' }, code: 'CONFLICTING_COMPARISON_PARAMETERS' },
  { action: 'compare', name: 'ambiguous side (artifactId + text)', payload: { mode: 'diff', source: { artifactId: 'x', text: 'y' }, target: 'b' }, code: 'AMBIGUOUS_COMPARISON_SIDE' },
  { action: 'compare', name: 'array side rejected', payload: { mode: 'diff', source: ['a'], target: 'b' }, code: 'INVALID_COMPARISON_SIDE' },
];

function buildDeepSchema(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < depth; i++) {
    node = { properties: { child: node } };
  }
  return node;
}

async function runHandler(
  action: string,
  payload: Record<string, unknown>
): Promise<{ error: Error; ctx: MockTaskContext }> {
  const ctx = new MockTaskContext();
  const handler = documentCoreHandlers[action];
  if (!handler) {
    throw new Error(`No document-core handler registered for action "${action}"`);
  }
  let captured: Error | undefined;
  try {
    await handler(ctx, payload);
  } catch (err) {
    captured = err as Error;
  }
  if (!captured) {
    throw new Error(`Expected fail-closed rejection for ${action} but handler succeeded`);
  }
  return { error: captured, ctx };
}

describe('FT-01 Six-Action Fail-Closed Matrix (functional, P5-10 [~] negative leg)', () => {
  for (const action of ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare']) {
    describe(`action: ${action}`, () => {
      const cases = INVALID_CASES.filter((c) => c.action === action);
      it.each(cases.map((c) => [c.name, c.payload, c.code] as const))(
        'fail-closed %s → %s with zero side effects',
        async (_name, payload, code) => {
          const { error, ctx } = await runHandler(action, payload as Record<string, unknown>);

          // Canonical error taxonomy code
          expect((error as Error & { code?: string }).code).toBe(code as string);

          // Fail-closed: never retryable (ValidationError has no retry flag; BusinessExecutionError must be false)
          if (error.name === 'BusinessExecutionError') {
            expect((error as BusinessExecutionError).retryable).toBe(false);
          }

          // Side-effect audit: zero provider, zero artifact write, zero checkpoint
          expect(ctx.connectorInvocations.length).toBe(0);
          expect(ctx.artifactsStore.size).toBe(0);
          expect(ctx.checkpointsStore.size).toBe(0);
        }
      );
    });
  }
});