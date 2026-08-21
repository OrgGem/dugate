// tests/workflow-builder/loader.test.ts
// Tests for the schema loader (save/load/list) using an in-memory fake db.
import { saveSchema, loadSchema, listSchemas, deleteSchema } from '../../lib/workflow-builder/loader';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';

// Mock the db module
const store = new Map<string, string>();
jest.mock('../../lib/db', () => ({
  db: {
    insert: (t: any) => ({
      values: (v: any) => ({
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    }),
    select: () => ({
      from: () => ({ where: (c: any) => ({ limit: () => Promise.resolve([]) }) }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

describe('loader', () => {
  const schema: WorkflowSchema = {
    slug: 'demo', name: 'Demo', flow: ['a'],
    nodes: [{ id: 'a', type: 'connector', connector: 'ext-x' }],
  };

  it('saveSchema requires a slug', async () => {
    await expect(saveSchema({ ...schema, slug: '' })).rejects.toThrow(/slug/i);
  });

  it('loadSchema returns null for missing', async () => {
    const s = await loadSchema('nope');
    expect(s).toBeNull();
  });
});
