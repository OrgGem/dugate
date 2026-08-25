// tests/workflow-builder/interpreter.test.ts
// Tests for the schema interpreter DAG runner (linear, parallel->join, human node).
import {
  validateSchema,
  runSchemaDag,
  toNodeResults,
} from '../../lib/workflow-builder/interpreter';
import type { WorkflowSchema, ConnectorNode, ParallelNode, JoinNode, HumanNode } from '../../lib/workflow-builder/types';

describe('validateSchema', () => {
  it('accepts a valid schema', () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['a'],
      nodes: [{ id: 'a', type: 'connector', connector: 'ext-x' }],
    };
    expect(validateSchema(schema)).toHaveLength(0);
  });

  it('rejects duplicate node ids', () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['a'],
      nodes: [
        { id: 'a', type: 'connector', connector: 'x' },
        { id: 'a', type: 'connector', connector: 'y' },
      ],
    };
    expect(validateSchema(schema).join(' ')).toMatch(/duplicate/i);
  });

  it('rejects missing node referenced in flow', () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['missing'],
      nodes: [{ id: 'a', type: 'connector', connector: 'x' }],
    };
    expect(validateSchema(schema).join(' ')).toMatch(/missing/i);
  });

  it('rejects connector node without connector', () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['a'],
      nodes: [{ id: 'a', type: 'connector' } as any],
    };
    expect(validateSchema(schema).join(' ')).toMatch(/connector/i);
  });

  it('rejects unknown node type', () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['a'],
      nodes: [{ id: 'a', type: 'bogus' } as any],
    };
    expect(validateSchema(schema).join(' ')).toMatch(/unsupported/i);
  });
});

describe('runSchemaDag', () => {
  // A fake executor that maps connector slug -> output; supports fan-out via results.
  function makeExec() {
    return jest.fn(async (node: any, resolve: (b: any) => unknown, results: any) => {
      // connector node: produce content derived from inputs (resolve each input,
      // mirroring real-exec which resolves per-field, not the whole object)
      const slug = node.connector || node.id;
      const inputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.inputs || {})) {
        inputs[k] = resolve(v);
      }
      return { content: `${slug}:${JSON.stringify(inputs)}`, data: { slug } };
    });
  }

  it('runs a linear connector DAG with $path chaining', async () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['a', 'b', 'c'],
      nodes: [
        { id: 'a', type: 'connector', connector: 'ext-a', inputs: { x: 1 } },
        { id: 'b', type: 'connector', connector: 'ext-b', inputs: { prev: '$a.content' } },
        { id: 'c', type: 'connector', connector: 'ext-c', inputs: { prev2: '$b.content' } },
      ] as ConnectorNode[],
    };
    const exec = makeExec();
    const results = await runSchemaDag({ schema, input: {}, files: [], exec });
    expect(exec).toHaveBeenCalledTimes(3);
    const cResult = toNodeResults(results).c;
    // b received a.content, c received b.content
    expect(cResult.content).toContain('ext-c');
  });

  it('runs parallel branches then join', async () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['p', 'j'],
      nodes: [
        {
          id: 'p', type: 'parallel',
          branches: [
            [{ id: 'A', type: 'connector', connector: 'ext-A' }],
            [{ id: 'B', type: 'connector', connector: 'ext-B' }],
          ],
        },
        { id: 'j', type: 'join', combine: 'concat' },
      ] as (ParallelNode | JoinNode)[],
    };
    const exec = makeExec();
    const results = await runSchemaDag({ schema, input: {}, files: [], exec });
    const j = toNodeResults(results).j;
    expect(exec).toHaveBeenCalledTimes(2);
    expect(j.output).toBeTruthy();
  });


  it('resolves bindings from existingResults (cross-block binding)', async () => {
    // Block 1: node 'a'
    const block1: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['a'],
      nodes: [{ id: 'a', type: 'connector', connector: 'ext-a', inputs: { x: 1 } }],
    };
    const exec = makeExec();
    const results1 = await runSchemaDag({ schema: block1, input: {}, files: [], exec });

    // Block 2: node 'b' references $a.content — must resolve from results1
    const block2: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['b'],
      nodes: [{ id: 'b', type: 'connector', connector: 'ext-b', inputs: { prev: '$a.content' } }],
    };
    const results2 = await runSchemaDag({
      schema: block2,
      input: {},
      files: [],
      exec,
      existingResults: results1,
    });

    expect(exec).toHaveBeenCalledTimes(2);
    const bResult = toNodeResults(results2).b;
    // b.content = "ext-b:{prev:...}" — resolve('$a.content') must have hit node a's output
    expect(bResult.content).toContain('ext-a');
    expect(bResult.content).toContain('1');
  });

  it('executes human node and records it without calling exec', async () => {
    const schema: WorkflowSchema = {
      slug: 't', name: 'Test', flow: ['a', 'h'],
      nodes: [
        { id: 'a', type: 'connector', connector: 'ext-a' },
        { id: 'h', type: 'human', message: 'Approve?' },
      ] as (ConnectorNode | HumanNode)[],
    };
    const exec = makeExec();
    const results = await runSchemaDag({ schema, input: {}, files: [], exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(results.h.type).toBe('human');
  });
});
