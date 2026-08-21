import { validateSchema } from '../../lib/workflow-builder/interpreter';
import schema from '../../lib/workflow-builder/examples/schema-disbursement';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';

describe('schema-disbursement example', () => {
  const s = schema as WorkflowSchema;

  it('is a valid schema', () => {
    expect(validateSchema(s)).toHaveLength(0);
  });

  it('models the disbursement flow (classify -> extract -> human -> crosscheck -> report)', () => {
    expect(s.slug).toBe('disbursement');
    expect(s.flow.length).toBeGreaterThanOrEqual(5);
    const types = s.nodes.map((n) => n.type);
    expect(types).toContain('connector');
    expect(types).toContain('human');
  });

  it('declares input_schema with resolution_data and limit', () => {
    expect(s.input_schema?.properties).toHaveProperty('resolution_data');
    expect(s.input_schema?.properties).toHaveProperty('limit_amount');
  });

  it('has an output mapping', () => {
    expect(s.output?.from).toBeTruthy();
  });
});
