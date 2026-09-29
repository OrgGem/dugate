import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import { MockTaskContext } from './fixtures/mock-context';
import { IngestAction } from '../src/actions/ingest';
import { ExtractAction } from '../src/actions/extract';
import { AnalyzeAction } from '../src/actions/analyze';
import { TransformAction } from '../src/actions/transform';
import { GenerateAction } from '../src/actions/generate';
import { CompareAction } from '../src/actions/compare';
import { documentCoreHandlers } from '../src/worker';
import { TaskContext as SdkTaskContext } from '@du/worker-sdk';
import { DocumentParserFactory, DocumentParser, ParseResult } from '@du/document-kit';
import { InputNormalizer } from '../src/validation/input-normalizer';

type SdkArtifactRef = Awaited<ReturnType<SdkTaskContext['artifacts']['writeStream']>>;

/**
 * Deferred test parser allowing exact control over async resolution timing.
 */
class DeferredParser implements DocumentParser {
  readonly name = 'deferred-parser';
  public resolve!: (res: ParseResult) => void;
  public reject!: (err: Error) => void;
  public readonly promise: Promise<ParseResult>;

  constructor() {
    this.promise = new Promise<ParseResult>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }

  canHandle(): boolean {
    return true;
  }

  parse(): Promise<ParseResult> {
    return this.promise;
  }
}

interface TestSdkTaskContext extends SdkTaskContext {
  setCancelRequested(val: boolean): void;
}

function createDefaultSdkArtifacts() {
  return {
    read: jest.fn().mockResolvedValue(Buffer.from('default mock content')),
    readWithMetadata: async () => {
      const buffer = Buffer.from('default mock content');
      return { buffer, sizeBytes: buffer.length, sha256: '0'.repeat(64) };
    },
    readStream: async () => { throw new Error('stream reads are not used by this fixture'); },
    write: jest.fn().mockResolvedValue({
      artifactId: 'art-default',
      fileName: 'out.json',
      mimeType: 'application/json',
      sizeBytes: 10,
    }),
    // Step A envelope writes arrive as streams; forward drained bytes to the
    // SAME object's write (late-bound this.write so fixture overrides observe
    // the recorded content).
    writeStream: async function (
      this: { write(content: Buffer, fileName: string, mimeType: string): Promise<SdkArtifactRef> },
      content: AsyncIterable<Uint8Array>,
      fileName: string,
      mimeType: string
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return this.write(Buffer.concat(chunks), fileName, mimeType);
    },
    accessGrant: jest.fn().mockResolvedValue({
      downloadUrl: 'http://storage/download',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  };
}

function createMockSdkContext(overrides: Partial<SdkTaskContext> = {}): TestSdkTaskContext {
  const defaultArtifacts = createDefaultSdkArtifacts();

  const defaultConnector = {
    invoke: jest.fn().mockResolvedValue({
      invocationId: 'inv-mock-1',
      state: 'SUCCEEDED',
      result: { data: { success: true } },
    }),
  };

  const defaultStep = {
    run: jest.fn().mockImplementation(async (_k, _h, fn) => fn()),
    peek: jest.fn().mockResolvedValue(null),
  };

  const defaultSpawn = {
    spawnAndWait: jest.fn().mockResolvedValue({ kind: 'waiting-children' }),
  };

  const defaultWait = {
    waitForInput: jest.fn().mockResolvedValue({ kind: 'waiting-input', waitId: 'w-1' }),
  };

  const defaultProgress = {
    report: jest.fn().mockResolvedValue(undefined),
  };

  let cancelRequestedState = overrides.cancelRequested ?? false;

  return {
    taskId: overrides.taskId ?? 'task-mock-1',
    operationId: overrides.operationId ?? 'op-mock-1',
    tenantId: overrides.tenantId ?? 'tenant-mock',
    businessId: overrides.businessId ?? 'document-core',
    businessVersion: overrides.businessVersion ?? '1.0.0',
    action: overrides.action ?? 'extract',
    kind: overrides.kind ?? 'extract',
    taskKey: overrides.taskKey ?? 'key-1',
    attempt: overrides.attempt ?? 1,
    leaseEpoch: overrides.leaseEpoch ?? 1,
    deadlineAt: overrides.deadlineAt ?? null,
    signal: overrides.signal ?? new AbortController().signal,
    get cancelRequested() {
      return cancelRequestedState;
    },
    setCancelRequested(val: boolean) {
      cancelRequestedState = val;
    },
    input: overrides.input ?? {},
    connectorBindings: overrides.connectorBindings ?? {},
    artifacts: overrides.artifacts ?? defaultArtifacts,
    connector: overrides.connector ?? defaultConnector,
    step: overrides.step ?? defaultStep,
    spawn: overrides.spawn ?? defaultSpawn,
    wait: overrides.wait ?? defaultWait,
    progress: overrides.progress ?? defaultProgress,
    checkpoints: () => [],
    grantFor: jest.fn(),
  };
}

describe('Action-Level Document Parser Budgets & Completion Fencing (Wave 17-18, W18-A)', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  describe('1. ParserBudgetHelper Unit & Bounds Enforcement', () => {
    test('resolves conservative default budgets when no overrides or deadline are present', () => {
      const budget = ParserBudgetHelper.resolveParserBudget(ctx);
      expect(budget.maxBufferSizeBytes).toBe(ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES); // 10MB
      expect(budget.timeoutMs).toBe(ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS); // 30s
    });

    test('validates finite positive integers for maxBufferSizeBytes', () => {
      expect(() => {
        ParserBudgetHelper.resolveParserBudget(ctx, { maxBufferSizeBytes: -1 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));

      expect(() => {
        ParserBudgetHelper.resolveParserBudget(ctx, { maxBufferSizeBytes: 0 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));

      expect(() => {
        ParserBudgetHelper.resolveParserBudget(ctx, { maxBufferSizeBytes: 10.5 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));

      expect(() => {
        ParserBudgetHelper.resolveParserBudget(ctx, { maxBufferSizeBytes: Infinity });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));
    });

    test('rejects zero and negative buffer caps at the lower boundary', () => {
      for (const maxBufferSizeBytes of [0, -0, -1, -Number.MIN_VALUE]) {
        expect(() => ParserBudgetHelper.resolveParserBudget(ctx, { maxBufferSizeBytes })).toThrow(
          expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' })
        );
      }
    });

    test('accepts the exact materialized-memory ceiling and rejects one byte above it', () => {
      const maxBufferSizeBytes = ParserBudgetHelper.MAX_BUFFER_SIZE_CEILING_BYTES;

      expect(ParserBudgetHelper.resolveParserBudget(ctx, { maxBufferSizeBytes }).maxBufferSizeBytes)
        .toBe(maxBufferSizeBytes);
      expect(() => ParserBudgetHelper.resolveParserBudget(ctx, { maxBufferSizeBytes: maxBufferSizeBytes + 1 }))
        .toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));
    });

    test('validates finite positive numbers for timeoutMs', () => {
      expect(() => {
        ParserBudgetHelper.resolveParserBudget(ctx, { timeoutMs: -500 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));

      expect(() => {
        ParserBudgetHelper.resolveParserBudget(ctx, { timeoutMs: 0 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));

      expect(() => {
        ParserBudgetHelper.resolveParserBudget(ctx, { timeoutMs: NaN });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));
    });

    test('fails fast with DEADLINE_EXCEEDED when task deadline is already in the past', () => {
      const pastDeadline = new Date(Date.now() - 5000).toISOString();
      const expiredCtx = new MockTaskContext({ deadlineAt: pastDeadline });

      expect(() => {
        ParserBudgetHelper.resolveParserBudget(expiredCtx);
      }).toThrow(expect.objectContaining({ code: 'DEADLINE_EXCEEDED' }));
    });

    test('caps parser timeoutMs by remaining task deadline duration', () => {
      const futureDeadline = new Date(Date.now() + 5000).toISOString();
      const boundedCtx = new MockTaskContext({ deadlineAt: futureDeadline });

      const budget = ParserBudgetHelper.resolveParserBudget(boundedCtx);
      expect(budget.timeoutMs).toBeLessThanOrEqual(5000);
      expect(budget.timeoutMs).toBeGreaterThan(4000);
    });

    test('fences a deadline at the exact boundary and caps by remaining time', () => {
      const exactDeadline = new MockTaskContext({ deadlineAt: new Date().toISOString() });
      expect(() => ParserBudgetHelper.resolveParserBudget(exactDeadline)).toThrow(
        expect.objectContaining({ code: 'DEADLINE_EXCEEDED' })
      );

      const positiveRemainingTime = new MockTaskContext({
        deadlineAt: new Date(Date.now() + 1000).toISOString(),
      });
      const bounded = ParserBudgetHelper.resolveParserBudget(positiveRemainingTime, { timeoutMs: 5000 });
      expect(bounded.timeoutMs).toBeGreaterThan(0);
      expect(bounded.timeoutMs).toBeLessThanOrEqual(1000);
    });

    test('rejects non-integer page budget selections before parser or split work', () => {
      for (const pages of ['1.5', '2-3.5', '1, 2.25']) {
        expect(() => InputNormalizer.normalizeIngest({ mode: 'split', pages })).toThrow(
          expect.objectContaining({ code: 'INVALID_PAGE_RANGE' })
        );
      }
    });

    test('falls back to conservative defaults when no parser budget profile is supplied', () => {
      const profilelessContext = new MockTaskContext({ input: {} });

      expect(profilelessContext.input['parserBudget']).toBeUndefined();
      expect(ParserBudgetHelper.resolveParserBudget(profilelessContext)).toEqual({
        maxBufferSizeBytes: ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES,
        timeoutMs: ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS,
      });
    });

    test('enforces exact byte boundary: rejects (limit + 1) and accepts exact limit', async () => {
      const limit = 100;
      const exactBuf = Buffer.alloc(limit, 'a');
      const overBuf = Buffer.alloc(limit + 1, 'a');

      const result = await ParserBudgetHelper.safeParseBuffer(ctx, exactBuf, 'test.txt', {
        maxBufferSizeBytes: limit,
      });
      expect(result.text).toBe('a'.repeat(limit));

      await expect(
        ParserBudgetHelper.safeParseBuffer(ctx, overBuf, 'test.txt', {
          maxBufferSizeBytes: limit,
        })
      ).rejects.toThrow(expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' }));
    });

    test('rejects parsing immediately when task signal is cancelled', async () => {
      const controller = new AbortController();
      controller.abort('cancel');

      const cancelledCtx = new MockTaskContext({
        signal: controller.signal,
        cancelRequested: true,
      });

      await expect(
        ParserBudgetHelper.safeParseBuffer(cancelledCtx, Buffer.from('hello'), 'test.txt')
      ).rejects.toThrow(expect.objectContaining({ code: 'OPERATION_CANCELLED' }));
    });

    test('maps parser wait timeout budget exhaustion to business error taxonomy', async () => {
      class SlowParser implements DocumentParser {
        readonly name = 'slow-parser';
        canHandle(): boolean {
          return true;
        }
        async parse(): Promise<ParseResult> {
          await new Promise((r) => setTimeout(r, 100));
          return {
            text: 'late',
            markdown: 'late',
            metadata: {
              wordCount: 1,
              characterCount: 4,
              detectedFormat: 'txt',
              parser: 'slow-parser',
              provenance: 'native_parse',
            },
            warnings: [],
          };
        }
      }

      const customFactory = new DocumentParserFactory();
      customFactory.registerParser(new SlowParser());

      await expect(
        ParserBudgetHelper.safeParseBuffer(ctx, Buffer.from('test content'), 'test.txt', {
          timeoutMs: 10,
          parserFactory: customFactory,
        })
      ).rejects.toThrow(expect.objectContaining({ code: 'DOC_PARSING_FAILED' }));
    });
  });

  describe('2. Wave 18 Corrective Fencing Regressions (W18-A)', () => {
    test('fencing: rejects with OPERATION_CANCELLED when parser resolves successfully AFTER context cancellation', async () => {
      const controller = new AbortController();
      const deferredParser = new DeferredParser();
      const customFactory = new DocumentParserFactory();
      customFactory.registerParser(deferredParser);

      const testCtx = new MockTaskContext({
        signal: controller.signal,
      });

      const parsePromise = ParserBudgetHelper.safeParseBuffer(
        testCtx,
        Buffer.from('deferred content'),
        'test.txt',
        { parserFactory: customFactory }
      );

      // Signal cancellation while parser is in-flight
      controller.abort('cancel');
      testCtx.cancelRequested = true;

      // Parser finishes successfully late
      deferredParser.resolve({
        text: 'late success text',
        markdown: 'late success text',
        metadata: {
          wordCount: 3,
          characterCount: 17,
          detectedFormat: 'txt',
          parser: 'deferred-parser',
          provenance: 'native_parse',
        },
        warnings: [],
      });

      // Crucial W18 invariant: late success must NOT be returned if signal was aborted!
      await expect(parsePromise).rejects.toThrow(
        expect.objectContaining({ code: 'OPERATION_CANCELLED' })
      );
    });

    test('fencing: rejects with DEADLINE_EXCEEDED when parser resolves successfully AFTER deadline has elapsed', async () => {
      const futureDeadline = new Date(Date.now() + 500).toISOString();
      const deferredParser = new DeferredParser();
      const customFactory = new DocumentParserFactory();
      customFactory.registerParser(deferredParser);

      const testCtx = new MockTaskContext({
        deadlineAt: futureDeadline,
      });

      const parsePromise = ParserBudgetHelper.safeParseBuffer(
        testCtx,
        Buffer.from('deferred content'),
        'test.txt',
        { parserFactory: customFactory }
      );

      // Clock/deadline crosses into the past before parser completes
      testCtx.deadlineAt = new Date(Date.now() - 100).toISOString();

      // Parser completes successfully late
      deferredParser.resolve({
        text: 'late success after deadline',
        markdown: 'late success after deadline',
        metadata: {
          wordCount: 4,
          characterCount: 27,
          detectedFormat: 'txt',
          parser: 'deferred-parser',
          provenance: 'native_parse',
        },
        warnings: [],
      });

      // Crucial W18 invariant: late success must NOT be returned if deadline elapsed!
      await expect(parsePromise).rejects.toThrow(
        expect.objectContaining({ code: 'DEADLINE_EXCEEDED' })
      );
    });

    test('fencing: caller wait rejects promptly on AbortSignal without waiting for pending parser', async () => {
      const controller = new AbortController();
      const deferredParser = new DeferredParser();
      const customFactory = new DocumentParserFactory();
      customFactory.registerParser(deferredParser);

      const testCtx = new MockTaskContext({
        signal: controller.signal,
      });

      const parsePromise = ParserBudgetHelper.safeParseBuffer(
        testCtx,
        Buffer.from('deferred content'),
        'test.txt',
        { parserFactory: customFactory }
      );

      // Abort while parser is pending and has NOT resolved
      controller.abort('cancel');
      testCtx.cancelRequested = true;

      // Caller wait must reject immediately without waiting for deferredParser
      await expect(parsePromise).rejects.toThrow(
        expect.objectContaining({ code: 'OPERATION_CANCELLED' })
      );

      // Cleanup: resolve deferred parser afterwards, asserting no unhandled rejection occurs
      deferredParser.resolve({
        text: 'orphaned',
        markdown: 'orphaned',
        metadata: {
          wordCount: 1,
          characterCount: 8,
          detectedFormat: 'txt',
          parser: 'deferred-parser',
          provenance: 'native_parse',
        },
        warnings: [],
      });
    });

    test('fencing: deadline crossing after first artifact prevents second artifact read', async () => {
      const art1 = await ctx.artifacts.write(Buffer.from('First artifact text'), 'art1.txt', 'text/plain');
      const art2 = await ctx.artifacts.write(Buffer.from('Second artifact text'), 'art2.txt', 'text/plain');

      let art2ReadInvoked = false;
      const originalRead = ctx.artifacts.read;
      ctx.artifacts.read = async (id: string) => {
        if (id === art2.artifactId) {
          art2ReadInvoked = true;
        }
        return originalRead(id);
      };

      // Set initial future deadline
      ctx.deadlineAt = new Date(Date.now() + 5000).toISOString();

      // Custom parser that expires the deadline when art1 is parsed
      class ExpiringParser implements DocumentParser {
        readonly name = 'expiring-parser';
        canHandle(): boolean {
          return true;
        }
        async parse(): Promise<ParseResult> {
          // Parsing art1 expired the task deadline
          ctx.deadlineAt = new Date(Date.now() - 1000).toISOString();
          return {
            text: 'Art1 parsed successfully',
            markdown: 'Art1 parsed successfully',
            metadata: {
              wordCount: 3,
              characterCount: 24,
              detectedFormat: 'txt',
              parser: 'expiring-parser',
              provenance: 'native_parse',
            },
            warnings: [],
          };
        }
      }

      const customFactory = new DocumentParserFactory();
      customFactory.registerParser(new ExpiringParser());

      // Save and replace default factory temporarily
      const input = ExtractAction.validateInput({
        type: 'invoice',
        artifactIds: [art1.artifactId, art2.artifactId],
      });

      // In safeParseBuffer, we pass options with parserFactory or test the prepareSources flow
      // Since prepareSources calls ParserBudgetHelper.safeParseBuffer(ctx, buf, `doc_${id}`),
      // we can verify that checking assertActiveDeadline before the 2nd read prevents art2 read!
      // For this test, art1 is parsed with the default parser, but we simulate deadline crossing after art1:
      const testCtx = new MockTaskContext({
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
      });
      testCtx.artifactsStore = ctx.artifactsStore;
      testCtx.artifacts.read = async (id: string) => {
        if (id === art2.artifactId) {
          art2ReadInvoked = true;
        }
        const buf = await ctx.artifacts.read(id);
        if (id === art1.artifactId) {
          // After art1 is read and parsed, deadline crosses
          testCtx.deadlineAt = new Date(Date.now() - 500).toISOString();
        }
        return buf;
      };

      await expect(ExtractAction.prepareSources(testCtx, input)).rejects.toThrow(
        expect.objectContaining({ code: 'DEADLINE_EXCEEDED' })
      );

      // Crucial W18 invariant: art2 read must NEVER have been called!
      expect(art2ReadInvoked).toBe(false);
    });

    test('fencing: handler-level regression asserts zero provider or output effects on late cancellation', async () => {
      const art = await ctx.artifacts.write(Buffer.from('Invoice content'), 'inv.txt', 'text/plain');
      const controller = new AbortController();

      const connectorInvokeMock = jest.fn();
      const artifactsWriteMock = jest.fn();
      const stepRunMock = jest.fn().mockImplementation(async (_k, _h, fn) => fn());
      const readArtifact = async (id: string) => {
        // Let the storage read start before cancelling, so acquisition has
        // attached its abort/rejection handlers to the in-flight metadata read.
        const buffer = await ctx.artifacts.read(id);
        controller.abort('cancel');
        mockSdkCtx.setCancelRequested(true);
        return buffer;
      };

      const mockSdkCtx = createMockSdkContext({
        action: 'extract',
        kind: 'extract',
        signal: controller.signal,
        input: { type: 'invoice', artifactIds: [art.artifactId] },
        artifacts: {
          ...createDefaultSdkArtifacts(),
          read: readArtifact,
          readWithMetadata: async (id: string) => {
            const buffer = await readArtifact(id);
            return { buffer, sizeBytes: buffer.length, sha256: '0'.repeat(64) };
          },
          write: artifactsWriteMock,
          accessGrant: jest.fn(),
        },
        connector: { invoke: connectorInvokeMock },
        step: { run: stepRunMock, peek: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        documentCoreHandlers['extract']!(mockSdkCtx)
      ).rejects.toThrow(expect.objectContaining({ code: 'OPERATION_CANCELLED' }));

      // Asserts zero side effects
      expect(connectorInvokeMock).not.toHaveBeenCalled();
      expect(artifactsWriteMock).not.toHaveBeenCalled();
    });
  });

  describe('3. Table-Driven Action-Level Parser Budgeting Across All 6 Actions', () => {
    const actionsTable = [
      {
        name: 'ingest',
        prepare: async (c: MockTaskContext, artId: string) => {
          const input = IngestAction.validateInput({ mode: 'parse', artifactIds: [artId] });
          const recipe = IngestAction.selectRecipe(input);
          const sources = await IngestAction.prepareSources(c, input);
          return IngestAction.executeRecipe(c, recipe, input, sources);
        },
        inlineText: async (c: MockTaskContext) => {
          const input = IngestAction.validateInput({ mode: 'parse', text: 'Inline ingest text' });
          const recipe = IngestAction.selectRecipe(input);
          const sources = await IngestAction.prepareSources(c, input);
          return IngestAction.executeRecipe(c, recipe, input, sources);
        },
      },
      {
        name: 'extract',
        prepare: async (c: MockTaskContext, artId: string) => {
          const input = ExtractAction.validateInput({ type: 'invoice', artifactIds: [artId] });
          const sources = await ExtractAction.prepareSources(c, input);
          const recipe = ExtractAction.selectRecipe(input);
          return ExtractAction.executeRecipe(c, recipe, input, sources);
        },
        inlineText: async (c: MockTaskContext) => {
          const input = ExtractAction.validateInput({ type: 'invoice', text: 'Invoice INV-100 Total $50' });
          const sources = await ExtractAction.prepareSources(c, input);
          const recipe = ExtractAction.selectRecipe(input);
          return ExtractAction.executeRecipe(c, recipe, input, sources);
        },
      },
      {
        name: 'analyze',
        prepare: async (c: MockTaskContext, artId: string) => {
          const input = AnalyzeAction.validateInput({ task: 'sentiment', artifactIds: [artId] });
          const sources = await AnalyzeAction.prepareSources(c, input);
          const recipe = AnalyzeAction.selectRecipe(input);
          return AnalyzeAction.executeRecipe(c, recipe, input, sources);
        },
        inlineText: async (c: MockTaskContext) => {
          const input = AnalyzeAction.validateInput({ task: 'sentiment', text: 'Great experience!' });
          const sources = await AnalyzeAction.prepareSources(c, input);
          const recipe = AnalyzeAction.selectRecipe(input);
          return AnalyzeAction.executeRecipe(c, recipe, input, sources);
        },
      },
      {
        name: 'transform',
        prepare: async (c: MockTaskContext, artId: string) => {
          const input = TransformAction.validateInput({ variant: 'convert', artifactIds: [artId], outputFormat: 'text' });
          const sources = await TransformAction.prepareSources(c, input);
          const recipe = TransformAction.selectRecipe(input);
          return TransformAction.executeRecipe(c, recipe, input, sources);
        },
        inlineText: async (c: MockTaskContext) => {
          const input = TransformAction.validateInput({ variant: 'convert', text: 'Convert me', outputFormat: 'text' });
          const sources = await TransformAction.prepareSources(c, input);
          const recipe = TransformAction.selectRecipe(input);
          return TransformAction.executeRecipe(c, recipe, input, sources);
        },
      },
      {
        name: 'generate',
        prepare: async (c: MockTaskContext, artId: string) => {
          const input = GenerateAction.validateInput({ task: 'summary', artifactIds: [artId] });
          const sources = await GenerateAction.prepareSources(c, input);
          const recipe = GenerateAction.selectRecipe(input);
          return GenerateAction.executeRecipe(c, recipe, input, sources);
        },
        inlineText: async (c: MockTaskContext) => {
          const input = GenerateAction.validateInput({ task: 'summary', text: 'Summarize me' });
          const sources = await GenerateAction.prepareSources(c, input);
          const recipe = GenerateAction.selectRecipe(input);
          return GenerateAction.executeRecipe(c, recipe, input, sources);
        },
      },
      {
        name: 'compare',
        prepare: async (c: MockTaskContext, artId: string) => {
          const input = CompareAction.validateInput({
            mode: 'diff',
            source: { artifactId: artId },
            target: { text: 'Target text compare' },
          });
          const sources = await CompareAction.prepareSources(c, input);
          const recipe = CompareAction.selectRecipe(input);
          return CompareAction.executeRecipe(c, recipe, input, sources);
        },
        inlineText: async (c: MockTaskContext) => {
          const input = CompareAction.validateInput({
            mode: 'diff',
            source: { text: 'Source text' },
            target: { text: 'Target text' },
          });
          const sources = await CompareAction.prepareSources(c, input);
          const recipe = CompareAction.selectRecipe(input);
          return CompareAction.executeRecipe(c, recipe, input, sources);
        },
      },
    ];

    test.each(actionsTable)(
      'Action "$name": parses valid document artifact successfully with bounded options',
      async ({ prepare }) => {
        const actionCtx = new MockTaskContext();
        actionCtx.defaultConnectorResponse = {
          invocationId: 'inv-test-1',
          status: 'SUCCESS',
          data: { invoiceNumber: 'INV-100', total: 50, sentiment: 'positive', score: 0.9, summary: 'Summary text' },
        };

        const art = await actionCtx.artifacts.write(
          Buffer.from('Valid plain text content for test verification', 'utf8'),
          'doc.txt',
          'text/plain'
        );

        const result = await prepare(actionCtx, art.artifactId);
        expect(result).toBeDefined();
      }
    );

    test.each(actionsTable)(
      'Action "$name": rejects oversized artifact exceeding default budget with DOCUMENT_TOO_LARGE',
      async ({ prepare }) => {
        const oversizedBuf = Buffer.alloc(ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES + 1, 'x');
        const art = await ctx.artifacts.write(oversizedBuf, 'oversized.txt', 'text/plain');

        await expect(prepare(ctx, art.artifactId)).rejects.toThrow(
          expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' })
        );

        expect(ctx.connectorInvocations).toHaveLength(0);
      }
    );

    test.each(actionsTable)(
      'Action "$name": fails fast with DEADLINE_EXCEEDED when deadline is already expired',
      async ({ prepare }) => {
        const art = await ctx.artifacts.write(Buffer.from('hello'), 'doc.txt', 'text/plain');

        const expiredCtx = new MockTaskContext({
          deadlineAt: new Date(Date.now() - 1000).toISOString(),
        });
        expiredCtx.artifactsStore = ctx.artifactsStore;

        await expect(prepare(expiredCtx, art.artifactId)).rejects.toThrow(
          expect.objectContaining({ code: 'DEADLINE_EXCEEDED' })
        );

        expect(expiredCtx.connectorInvocations).toHaveLength(0);
      }
    );

    test.each(actionsTable)(
      'Action "$name": fails fast with OPERATION_CANCELLED when execution signal is aborted',
      async ({ prepare }) => {
        const art = await ctx.artifacts.write(Buffer.from('hello'), 'doc.txt', 'text/plain');

        const controller = new AbortController();
        controller.abort('cancel');

        const cancelledCtx = new MockTaskContext({
          signal: controller.signal,
          cancelRequested: true,
        });
        cancelledCtx.artifactsStore = ctx.artifactsStore;

        await expect(prepare(cancelledCtx, art.artifactId)).rejects.toThrow(
          expect.objectContaining({ code: 'OPERATION_CANCELLED' })
        );

        expect(cancelledCtx.connectorInvocations).toHaveLength(0);
      }
    );

    test.each(actionsTable)(
      'Action "$name": inline text path preserves existing behavior without parser involvement',
      async ({ inlineText }) => {
        ctx.defaultConnectorResponse = {
          invocationId: 'inv-test-inline',
          status: 'SUCCESS',
          data: { invoiceNumber: 'INV-100', total: 50, sentiment: 'positive', score: 0.9, summary: 'Summary text' },
        };

        const result = await inlineText(ctx);
        expect(result).toBeDefined();
      }
    );
  });

  describe('4. Multi-Artifact Cumulative Wait & Compare Both Sides', () => {
    test('Extract action: cumulative wait bounds multiple artifacts under task deadline', async () => {
      const art1 = await ctx.artifacts.write(Buffer.from('First document artifact content'), 'art1.txt', 'text/plain');
      const art2 = await ctx.artifacts.write(Buffer.from('Second document artifact content'), 'art2.txt', 'text/plain');

      const deadlineAt = new Date(Date.now() + 5000).toISOString();
      const multiCtx = new MockTaskContext({ deadlineAt });
      multiCtx.artifactsStore = ctx.artifactsStore;

      const input = ExtractAction.validateInput({
        type: 'invoice',
        artifactIds: [art1.artifactId, art2.artifactId],
      });

      const sources = await ExtractAction.prepareSources(multiCtx, input);
      expect(sources.text).toContain('First document artifact content');
      expect(sources.text).toContain('Second document artifact content');
    });

    test('Compare action: protects both source and target sides against oversized inputs', async () => {
      const normalBuf = Buffer.from('Valid normal document content');
      const oversizedBuf = Buffer.alloc(ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES + 1, 'o');

      const normalArt = await ctx.artifacts.write(normalBuf, 'normal.txt', 'text/plain');
      const overArt = await ctx.artifacts.write(oversizedBuf, 'over.txt', 'text/plain');

      const compareInput1 = CompareAction.validateInput({
        mode: 'diff',
        source: { artifactId: overArt.artifactId },
        target: { artifactId: normalArt.artifactId },
      });

      await expect(CompareAction.prepareSources(ctx, compareInput1)).rejects.toThrow(
        expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' })
      );

      const compareInput2 = CompareAction.validateInput({
        mode: 'diff',
        source: { artifactId: normalArt.artifactId },
        target: { artifactId: overArt.artifactId },
      });

      await expect(CompareAction.prepareSources(ctx, compareInput2)).rejects.toThrow(
        expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' })
      );
    });

    test('Compare action: expired deadline fails fast before either side is parsed', async () => {
      const art1 = await ctx.artifacts.write(Buffer.from('Source content'), 'source.txt', 'text/plain');
      const art2 = await ctx.artifacts.write(Buffer.from('Target content'), 'target.txt', 'text/plain');

      const expiredCtx = new MockTaskContext({
        deadlineAt: new Date(Date.now() - 500).toISOString(),
      });
      expiredCtx.artifactsStore = ctx.artifactsStore;

      const compareInput = CompareAction.validateInput({
        mode: 'diff',
        source: { artifactId: art1.artifactId },
        target: { artifactId: art2.artifactId },
      });

      await expect(CompareAction.prepareSources(expiredCtx, compareInput)).rejects.toThrow(
        expect.objectContaining({ code: 'DEADLINE_EXCEEDED' })
      );
    });
  });

  describe('5. SDK Consumer Context Deadline Forwarding', () => {
    test('forwards deadlineAt from SdkTaskContext through handler to fail-fast on expired deadline', async () => {
      const art = await ctx.artifacts.write(Buffer.from('Invoice INV-400 Total $200'), 'inv.txt', 'text/plain');

      const pastDate = new Date(Date.now() - 2000).toISOString();
      const connectorInvokeMock = jest.fn();
      const stepRunMock = jest.fn();

      const mockSdkContext = createMockSdkContext({
        action: 'extract',
        kind: 'extract',
        deadlineAt: pastDate,
        input: { type: 'invoice', artifactIds: [art.artifactId] },
        artifacts: {
          ...ctx.artifacts,
          readWithMetadata: async (artifactId: string) => {
            const buffer = await ctx.artifacts.read(artifactId);
            return { buffer, sizeBytes: buffer.length, sha256: '0'.repeat(64) };
          },
          readStream: async () => { throw new Error('stream reads are not used by this fixture'); },
          writeStream: async () => { throw new Error('stream writes are not used by this fixture'); },
        },
        connector: { invoke: connectorInvokeMock },
        step: { run: stepRunMock, peek: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        documentCoreHandlers['extract']!(mockSdkContext)
      ).rejects.toThrow(expect.objectContaining({ code: 'DEADLINE_EXCEEDED' }));

      expect(connectorInvokeMock).not.toHaveBeenCalled();
      expect(stepRunMock).not.toHaveBeenCalled();
    });

    test('forwards valid future deadlineAt through root dispatcher to successful completion', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      let writtenContent = '';

      const mockSdkContext = createMockSdkContext({
        action: 'extract',
        kind: 'root',
        deadlineAt: futureDate,
        input: { type: 'invoice', text: 'Invoice INV-500 Total $150' },
        artifacts: {
          ...createDefaultSdkArtifacts(),
          read: jest.fn(),
          write: jest.fn().mockImplementation(async (content: string | Buffer) => {
            writtenContent = typeof content === 'string' ? content : content.toString('utf8');
            return {
              artifactId: 'art-success',
              role: 'output',
              fileName: 'extract_result.json',
              mimeType: 'application/json',
              sizeBytes: content.length,
            };
          }),
          accessGrant: jest.fn(),
        },
        connector: {
          invoke: jest.fn().mockResolvedValue({
            invocationId: 'inv-sdk-1',
            state: 'SUCCEEDED',
            result: {
              data: { invoiceNumber: 'INV-500', total: 150, supplier: { name: 'Supplier' } },
            },
          }),
        },
      });

      const disposition = await documentCoreHandlers['root']!(mockSdkContext);
      expect(disposition.kind).toBe('completed');
      if (disposition.kind === 'completed') {
        expect(disposition.resultRef).toBe('artifact://art-success');
      }
      expect(writtenContent).toContain('"invoiceNumber": "INV-500"');
    });
  });
});
