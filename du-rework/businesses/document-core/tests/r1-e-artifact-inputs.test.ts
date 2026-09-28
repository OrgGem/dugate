import { documentCoreHandlers } from '../src/worker';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import { MockTaskContext } from './fixtures/mock-context';

type ActionName = 'ingest' | 'extract' | 'analyze' | 'transform' | 'generate' | 'compare';
type CompareSide = 'source' | 'target';
type FailureCase = {
  name: string;
  action: ActionName;
  failedSide: CompareSide;
  artifactId: string;
  payload: Record<string, unknown>;
  readStatus?: number;
};

const ACTIONS: ActionName[] = ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'];
const COMPARE_SIDES: CompareSide[] = ['source', 'target'];

function makeCase(action: ActionName, failedSide: CompareSide = 'source'): FailureCase {
  const artifactId = `${action}-${failedSide}-input`;
  let payload: Record<string, unknown>;

  switch (action) {
    case 'ingest':
      // OCR would invoke its connector after reading; parser-failure cases use parse mode below.
      payload = { mode: 'ocr', artifactIds: [artifactId] };
      break;
    case 'extract':
      payload = { type: 'invoice', artifactIds: [artifactId] };
      break;
    case 'analyze':
      payload = { task: 'classify', categories: ['finance'], artifactIds: [artifactId] };
      break;
    case 'transform':
      payload = { variant: 'rewrite', artifactIds: [artifactId] };
      break;
    case 'generate':
      payload = { task: 'summary', artifactIds: [artifactId] };
      break;
    case 'compare':
      payload = failedSide === 'source'
        ? { mode: 'semantic', source: { artifactId }, target: { text: 'Readable comparison target.' } }
        : { mode: 'semantic', source: { text: 'Readable comparison source.' }, target: { artifactId } };
      break;
  }

  return { name: `${action} ${failedSide}`, action, failedSide, artifactId, payload };
}

const READ_FAILURE_CASES: FailureCase[] = ACTIONS.flatMap((action) => {
  const sides = action === 'compare' ? COMPARE_SIDES : ['source' as const];
  return sides.flatMap((side) => [403, 404].map((status) => ({
    ...makeCase(action, side),
    name: `${action} ${side} artifact read ${status}`,
    readStatus: status,
  })));
});

const PARSE_FAILURE_CASES: FailureCase[] = ACTIONS.flatMap((action) => {
  const sides = action === 'compare' ? COMPARE_SIDES : ['source' as const];
  return sides.flatMap((side) => ['corrupt ZIP', 'unsupported binary'].map((bytesKind) => ({
    ...makeCase(action, side),
    name: `${action} ${side} artifact ${bytesKind}`,
  })));
});

function createReadError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`Synthetic artifact read failure (${statusCode})`), { statusCode });
}

function makeUnreadableBuffer(kind: 'corrupt ZIP' | 'unsupported binary'): Buffer {
  if (kind === 'corrupt ZIP') {
    // ZIP local-file signature followed by a truncated header; preflight must reject it.
    return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
  }

  // NUL-containing, non-text bytes with no supported document magic.
  return Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x00]);
}

async function invokeAndCaptureRejection(
  handler: NonNullable<(typeof documentCoreHandlers)[string]>,
  ctx: MockTaskContext,
  payload: Record<string, unknown>
): Promise<Error> {
  let captured: unknown;
  try {
    await handler(ctx, payload);
  } catch (error: unknown) {
    captured = error;
  }

  if (!(captured instanceof Error)) {
    throw new Error('Expected handler to reject before completing');
  }

  return captured;
}

describe('R1-E Layer 3: artifact reads fail closed across document-core actions', () => {
  it.each(READ_FAILURE_CASES)('$name rejects before parser, provider, or output write', async (testCase) => {
    const handler = documentCoreHandlers[testCase.action];
    if (!handler) {
      throw new Error(`No document-core handler registered for action "${testCase.action}"`);
    }

    const ctx = new MockTaskContext();
    const readError = createReadError(testCase.readStatus as number);
    const readIds: string[] = [];
    ctx.artifacts.read = async (artifactId: string) => {
      readIds.push(artifactId);
      if (artifactId === testCase.artifactId) {
        throw readError;
      }
      throw new Error(`Unexpected artifact read: ${artifactId}`);
    };

    let outputWriteCalls = 0;
    const originalWrite = ctx.artifacts.write;
    ctx.artifacts.write = async (content, fileName, mimeType) => {
      outputWriteCalls += 1;
      return originalWrite(content, fileName, mimeType);
    };
    const parserSpy = jest.spyOn(ParserBudgetHelper, 'safeParseBuffer');

    await expect(handler(ctx, testCase.payload)).rejects.toBe(readError);

    expect(readIds).toEqual([testCase.artifactId]);
    expect(parserSpy).not.toHaveBeenCalled();
    expect(ctx.connectorInvocations).toHaveLength(0);
    expect(outputWriteCalls).toBe(0);
    expect(ctx.artifactsStore.size).toBe(0);
  });

  it.each(PARSE_FAILURE_CASES)('$name rejects before provider or output write', async (testCase) => {
    const kind = testCase.name.includes('corrupt ZIP') ? 'corrupt ZIP' : 'unsupported binary';
    const handler = documentCoreHandlers[testCase.action];
    if (!handler) {
      throw new Error(`No document-core handler registered for action "${testCase.action}"`);
    }

    const ctx = new MockTaskContext();
    const readIds: string[] = [];
    ctx.artifacts.read = async (artifactId: string) => {
      readIds.push(artifactId);
      if (artifactId === testCase.artifactId) {
        return makeUnreadableBuffer(kind);
      }
      throw new Error(`Unexpected artifact read: ${artifactId}`);
    };

    // Use the native parser path for ingest so malformed bytes are not sent to the OCR connector.
    const payload = testCase.action === 'ingest'
      ? { mode: 'parse', artifactIds: [testCase.artifactId] }
      : testCase.payload;
    let outputWriteCalls = 0;
    const originalWrite = ctx.artifacts.write;
    ctx.artifacts.write = async (content, fileName, mimeType) => {
      outputWriteCalls += 1;
      return originalWrite(content, fileName, mimeType);
    };
    const parserSpy = jest.spyOn(ParserBudgetHelper, 'safeParseBuffer');

    const error = await invokeAndCaptureRejection(handler, ctx, payload);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe('DOC_PARSING_FAILED');
    expect(readIds).toEqual([testCase.artifactId]);
    expect(parserSpy).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations).toHaveLength(0);
    expect(outputWriteCalls).toBe(0);
    expect(ctx.artifactsStore.size).toBe(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
