// tests/workflow-builder/archive-node.test.ts
// Tests for the archive plugin node dispatch via real-exec (compress + extract).
import { buildExecFunc } from '../../lib/workflow-builder/real-exec';
import { createArchiveFromEntries, archiveToBuffer } from '../../lib/archive';
import type { WorkflowContext } from '../../lib/pipelines/workflow-engine';

function makeCtx(): any {
  return {
    operationId: 'op-1',
    filesData: [],
    promptOverrides: {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

describe('archive plugin nodes (via real-exec)', () => {
  it('archive_compress produces a zip from entries', async () => {
    const exec = buildExecFunc(makeCtx());
    const node = {
      id: 'z', type: 'archive_compress' as const,
      source: [{ name: 'a.txt', content: 'hello' }],
    };
    const resolve = (b: any) => b;
    const partial = await exec(node as any, resolve as any, {});
    // output should be a Buffer (zip)
    expect(Buffer.isBuffer(partial.output)).toBe(true);
    const buf = partial.output as Buffer;
    expect(buf[0]).toBe(0x50); // PK
  });

  it('round-trips compress -> extract via two nodes', async () => {
    const ctx = makeCtx();
    const exec = buildExecFunc(ctx);
    const zipBuf = await archiveToBuffer(createArchiveFromEntries([{ name: 'f.txt', content: 'data' }]));

    const extractNode = {
      id: 'x', type: 'archive_extract' as const,
      source: zipBuf,
      destName: 'roundtrip',
    };
    const partial = await exec(extractNode as any, ((b: any) => b) as any, {});
    expect(partial.files).toBeDefined();
    expect((partial.files as string[]).length).toBe(1);
  });
});
