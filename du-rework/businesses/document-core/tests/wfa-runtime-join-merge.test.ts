/**
 * WFA 6d (fail-first) — legacy schema `join.combine = 'merge'` must merge
 * object outputs, not concatenate them.
 *
 * Reference semantics (legacy `docs/workflow-schema-guide.md` §3.3):
 *   concat → array of every output
 *   first  → first branch output
 *   merge  → "Merge object (nếu là object)"
 *
 * Before the fix the runtime returned the raw output array for BOTH `concat`
 * and `merge` (`legacy-schema-runtime.ts` join branch), so a schema that asked
 * for an object merge silently produced an array.
 */
import { createHash } from 'node:crypto';
import {
  canonicalLegacyWorkflowPinBytes,
  parseLegacyWorkflowSchema,
  type LegacyWorkflowSchemaPin,
} from '@du/contracts';
import type { TaskContext as SdkTaskContext } from '@du/worker-sdk';
import { handleLegacyWorkflowSchema } from '../src/pipelines/workflows/schema/legacy-schema-runtime';

const TENANT = 'tenant-a';

type Combine = 'concat' | 'first' | 'merge';
type InputType = 'string' | 'object';

/** Build an admitted pin for `[input left, input right, join combine]`. */
function pinFor(combine: Combine, leftType: InputType = 'object', rightType: InputType = 'object'): LegacyWorkflowSchemaPin {
  const schema = parseLegacyWorkflowSchema({
    slug: `wfa-join-${combine}`,
    name: `WFA join ${combine}`,
    input_schema: {
      type: 'object',
      properties: {
        left: { type: leftType },
        right: { type: rightType },
      },
    },
    nodes: [
      { id: 'left_value', type: 'input', key: 'left' },
      { id: 'right_value', type: 'input', key: 'right' },
      { id: 'merge_join', type: 'join', combine },
    ],
    flow: ['left_value', 'right_value', 'merge_join'],
    output: { from: 'merge_join' },
  });
  const connectorSlotMap: Record<string, string> = {};
  const approvedEgressOrigins: string[] = [];
  const digest = `sha256:${createHash('sha256')
    .update(canonicalLegacyWorkflowPinBytes(schema, connectorSlotMap, approvedEgressOrigins))
    .digest('hex')}`;
  return { tenantId: TENANT, slug: schema.slug, revision: 1, digest, schema, connectorSlotMap, approvedEgressOrigins };
}

/** Minimal SDK context: checkpoints execute inline; no parallel/human nodes here. */
function makeContext(): SdkTaskContext {
  return {
    taskKey: 'root',
    tenantId: TENANT,
    input: {},
    cancelRequested: false,
    signal: new AbortController().signal,
    step: {
      peek: async () => null,
      run: async (_stepKey: string, _inputHash: string, fn: () => Promise<unknown>) => fn(),
    },
    spawn: { spawnAndWait: async () => ({ kind: 'waiting-children' }) },
    wait: { waitForInput: async () => ({ kind: 'waiting-input' }) },
    progress: { report: async () => undefined },
    artifacts: {
      read: async () => { throw new Error('unused in this fixture'); },
      write: async () => { throw new Error('unused in this fixture'); },
    },
    connector: { invoke: async () => { throw new Error('unused in this fixture'); } },
  } as unknown as SdkTaskContext;
}

async function runJoin(
  pin: LegacyWorkflowSchemaPin,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const disposition = await handleLegacyWorkflowSchema(makeContext(), {
    input: { variables },
    legacyWorkflowSchema: pin,
  });
  expect(disposition.kind).toBe('completed');
  const resultRef = (disposition as { kind: 'completed'; resultRef: string }).resultRef;
  const result = JSON.parse(resultRef) as { content: string | null };
  return result.content === null ? null : JSON.parse(result.content);
}

describe('WFA 6d legacy schema join combine semantics', () => {
  it('combine=merge merges two object outputs into one object', async () => {
    const content = await runJoin(pinFor('merge'), {
      left: { alpha: 1 },
      right: { beta: 2 },
    });
    expect(content).toEqual({ alpha: 1, beta: 2 });
    expect(Array.isArray(content)).toBe(false);
  });

  it('combine=merge keeps the documented fallback (array) for non-object outputs', async () => {
    const content = await runJoin(pinFor('merge', 'string', 'string'), { left: 'a', right: 'b' });
    expect(content).toEqual(['a', 'b']);
  });

  it('combine=concat still returns the array of outputs', async () => {
    const content = await runJoin(pinFor('concat'), {
      left: { alpha: 1 },
      right: { beta: 2 },
    });
    expect(content).toEqual([{ alpha: 1 }, { beta: 2 }]);
  });

  it('combine=first still returns the first output', async () => {
    const content = await runJoin(pinFor('first'), {
      left: { alpha: 1 },
      right: { beta: 2 },
    });
    expect(content).toEqual({ alpha: 1 });
  });
});
