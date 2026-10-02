// tests/workflow-builder/real-exec.test.ts
// Tests for the real leaf-node executor (connector via enqueueSubStep,
// file_parse via ParserFactory, callback via fetch).
import { buildExecFunc, resolvePromptOverride } from '../../lib/workflow-builder/real-exec';
import type { ConnectorNode, FileParseNode, CallbackNode } from '../../lib/workflow-builder/types';

// Mock enqueueSubStep
jest.mock('../../lib/pipelines/workflow-engine', () => ({
  enqueueSubStep: jest.fn(),
}));
import { enqueueSubStep } from '../../lib/pipelines/workflow-engine';
const mockEnqueue = enqueueSubStep as jest.Mock;

describe('resolvePromptOverride', () => {
  it('returns null when no key', () => {
    const node = { id: 'a', type: 'connector', connector: 'ext-x', inputs: { file: '$files' } } as ConnectorNode;
    expect(resolvePromptOverride(node, {})).toBeNull();
  });
  it('returns override when key present', () => {
    const node = { id: 'a', type: 'connector', connector: 'ext-x', promptOverrideKey: 'classify' } as ConnectorNode;
    expect(resolvePromptOverride(node, { classify: 'OVERRIDE' })).toBe('OVERRIDE');
  });
});

describe('buildExecFunc connector node', () => {
  const ctx = {
    promptOverrides: {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as any;

  beforeEach(() => {
    mockEnqueue.mockReset();
  });

  it('calls enqueueSubStep and maps result to content + data', async () => {
    mockEnqueue.mockResolvedValue({ content: 'C', operation: { id: 'sub1' }, extractedData: { k: 1 } });
    const exec = buildExecFunc(ctx);
    const node = { id: 'c', type: 'connector', connector: 'ext-x', inputs: { q: 'hello' } } as ConnectorNode;
    const resolve = (b: any) => b; // identity for test

    const partial = await exec(node, resolve, {});
    expect(mockEnqueue).toHaveBeenCalledWith(ctx, 'ext-x', expect.objectContaining({ q: 'hello' }), null);
    expect(partial.content).toBe('C');
    expect(partial.extractedData).toEqual({ k: 1 });
  });

  it('passes filesJson when files are present', async () => {
    mockEnqueue.mockResolvedValue({ content: 'C', operation: { id: 'sub1' }, extractedData: null });
    const file = { name: 'a.pdf', path: '/tmp/a.pdf', mime: 'application/pdf', size: 12 };
    const fileCtx = { ...ctx, filesData: [file] };
    const exec = buildExecFunc(fileCtx);
    const node = { id: 'c', type: 'connector', connector: 'ext-x', inputs: { file: '$files' } } as ConnectorNode;
    // resolve returns files array for a $files binding
    const resolve = (b: any) => (b === '$files' ? ['/tmp/a.pdf'] : b);
    await exec(node, resolve, {});
    expect(mockEnqueue).toHaveBeenCalledWith(fileCtx, 'ext-x', { file: ['/tmp/a.pdf'] }, JSON.stringify([file]));
  });
});

describe('buildExecFunc callback node', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
  });

  it('sends payload to url without auth', async () => {
    const exec = buildExecFunc({ logger: { info: () => {} } } as any);
    const node = { id: 'cb', type: 'callback', url: '$input.hook', payload: 'hello', method: 'POST' } as CallbackNode;
    const resolve = (b: any) => (b === '$input.hook' ? 'https://hook.example' : b);
    await exec(node, resolve, {});
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://hook.example');
    expect(init.method).toBe('POST');
  });

  it('adds bearer auth header', async () => {
    const exec = buildExecFunc({ logger: { info: () => {} } } as any);
    const node = {
      id: 'cb', type: 'callback', url: 'https://x', payload: 'p', method: 'POST',
      auth: { type: 'bearer', token: 'TOK' },
    } as CallbackNode;
    const resolve = (b: any) => b;
    await exec(node, resolve, {});
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer TOK');
  });
});

