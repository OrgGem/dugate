import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { CONNECTOR_ARTIFACT_MAX_BYTES, InvocationArtifactContentSchema } from '@du/contracts';
import type { InvocationArtifactContent } from '@du/contracts';
import { InputNormalizer } from '../src/validation/input-normalizer';
import { SchemaValidator } from '../src/validation/schema-validator';
import { ValidationError } from '../src/types/results';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import { IngestAction } from '../src/actions/ingest';
import { MockTaskContext } from './fixtures/mock-context';
import type { TaskContext } from '../src/types/context';
import { multipartHttpAdapter } from '../../../orchestrator/services/connector/src/adapters/http';
import type { LocalInvocationRequest } from '../../../orchestrator/services/connector/src/types';

const contractArtifact = {
  artifactId: '00000000-0000-4000-8000-000000000001',
  fileName: 'scan.png',
  mimeType: 'image/png',
  sizeBytes: 1,
  sha256: 'a'.repeat(64),
  storageVersionId: 'scan-version-1',
  contentBase64: 'YQ==',
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function streamEnabledContext(ctx: MockTaskContext): TaskContext['artifacts'] {
  const artifacts = ctx.artifacts as TaskContext['artifacts'];
  delete artifacts.readWithMetadata;
  return artifacts;
}

async function serializedMultipartFixture(): Promise<{ url: string; contentType: string; wireBody: string }> {
  const bytes = Buffer.from('bounded multipart fixture');
  const artifact: InvocationArtifactContent = {
    artifactId: '00000000-0000-4000-8000-000000000002',
    fileName: 'bounded.txt',
    mimeType: 'text/plain',
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    storageVersionId: 'bounded-version-1',
    contentBase64: bytes.toString('base64'),
  };
  const request: LocalInvocationRequest = {
    contractVersion: '1',
    invocationId: 'inv-bounded-input',
    tenantId: 'tenant-bounded-input',
    operationId: 'op-bounded-input',
    taskId: 'task-bounded-input',
    stepKey: 'ingest.ocr',
    bindingSlot: 'ocr',
    input: { artifacts: [artifact] },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const built = multipartHttpAdapter.buildRequest(request, {
    baseUrl: 'https://provider.example/',
    path: '/v1/ocr',
    timeoutMs: 1_000,
  });
  if (!(built.body instanceof FormData)) throw new Error('multipart adapter did not return FormData');
  const outgoing = new Request(built.url, {
    method: built.method,
    headers: built.headers,
    body: built.body,
  });
  const contentType = outgoing.headers.get('content-type');
  if (!contentType) throw new Error('multipart request did not declare a content type');
  return { url: built.url, contentType, wireBody: await outgoing.text() };
}

describe('Bounded Input Enforcement (WORKLOAD-REBALANCE-04, P5-05)', () => {
  describe('Byte and image payload bounds', () => {
    test('rejects a zero-byte image payload at the connector contract boundary', () => {
      const result = InvocationArtifactContentSchema.safeParse({
        ...contractArtifact,
        sizeBytes: 0,
        contentBase64: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('sizeBytes');
      }
    });

    test('accepts a buffer exactly at its configured cap and rejects one byte over', async () => {
      const ctx = new MockTaskContext();
      const limit = 8;
      const exact = Buffer.alloc(limit, 0x61);
      const over = Buffer.alloc(limit + 1, 0x61);

      const result = await ParserBudgetHelper.safeParseBuffer(ctx, exact, 'bounded.txt', {
        maxBufferSizeBytes: limit,
      });
      expect(result.text).toBe('a'.repeat(limit));

      await expect(
        ParserBudgetHelper.safeParseBuffer(ctx, over, 'bounded.txt', { maxBufferSizeBytes: limit })
      ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    });

    test('rejects image file size beyond the connector artifact contract maximum', () => {
      const result = InvocationArtifactContentSchema.safeParse({
        ...contractArtifact,
        sizeBytes: CONNECTOR_ARTIFACT_MAX_BYTES + 1,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('sizeBytes');
      }
    });

    test('rejects content whose sniffed format disagrees with the claimed PDF metadata', async () => {
      const ctx = new MockTaskContext();
      const nonPdfBytes = Buffer.from('plain text content without a PDF signature', 'utf8');
      const ref = await ctx.artifacts.write(nonPdfBytes, 'claimed-document.pdf', 'application/pdf');
      const storedMetadata = ctx.artifactFormatMetadataStore.get(ref.artifactId);
      expect(storedMetadata).toBeDefined();
      ctx.artifactFormatMetadataStore.set(ref.artifactId, {
        ...storedMetadata!,
        canonicalFormat: 'pdf',
        canonicalMimeType: 'application/pdf',
      });
      const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

      await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
        code: 'ARTIFACT_FORMAT_METADATA_MISMATCH',
      });
      expect(ctx.connectorInvocations).toHaveLength(0);
    });

    test('rejects an over-limit streamed descriptor before opening the source stream', async () => {
      const ctx = new MockTaskContext({ taskId: 'bounded-over-limit-stream' });
      const stat = jest.fn(async () => ({
        fileName: 'too-large.txt',
        mimeType: 'text/plain',
        sizeBytes: ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES + 1,
        sha256: '0'.repeat(64),
        storageVersionId: 'too-large-version',
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const readStream = jest.fn(async () => Readable.from([]));
      Object.assign(streamEnabledContext(ctx), { stat, readStream });

      await expect(ParserBudgetHelper.readArtifact(ctx, 'too-large-artifact')).rejects.toMatchObject({
        code: 'DOCUMENT_TOO_LARGE',
      });
      expect(stat).toHaveBeenCalledTimes(1);
      expect(readStream).not.toHaveBeenCalled();
    });

    test('rejects a zero-byte stream when the authorized descriptor declares payload bytes', async () => {
      const ctx = new MockTaskContext({ taskId: 'bounded-zero-byte-stream' });
      const expected = Buffer.from('x');
      const stat = jest.fn(async () => ({
        fileName: 'scan.png',
        mimeType: 'image/png',
        sizeBytes: expected.length,
        sha256: sha256(expected),
        storageVersionId: 'scan-version',
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const readStream = jest.fn(async () => Readable.from([]));
      Object.assign(streamEnabledContext(ctx), { stat, readStream });

      await expect(ParserBudgetHelper.readArtifact(ctx, 'empty-stream-artifact')).rejects.toMatchObject({
        code: 'ARTIFACT_SIZE_MISMATCH',
      });
      expect(readStream).toHaveBeenCalledTimes(1);
    });

    test('rejects a truncated artifact transfer before incomplete multipart-band bytes can be consumed', async () => {
      const ctx = new MockTaskContext({ taskId: 'bounded-truncated-transfer' });
      const completePayload = Buffer.from('multipart-band-payload');
      const stat = jest.fn(async () => ({
        fileName: 'large-input.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: completePayload.length,
        sha256: sha256(completePayload),
        storageVersionId: 'large-input-version',
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const readStream = jest.fn(async () => Readable.from([completePayload.subarray(0, 7)]));
      Object.assign(streamEnabledContext(ctx), { stat, readStream });

      await expect(ParserBudgetHelper.readArtifact(ctx, 'truncated-artifact')).rejects.toMatchObject({
        code: 'ARTIFACT_SIZE_MISMATCH',
      });
    });

    test('rejects truncated multipart bodies before accepting them as complete form data', async () => {
      const { url, contentType, wireBody } = await serializedMultipartFixture();
      const declaredBoundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean);
      expect(declaredBoundary).toBeDefined();
      const closingBoundary = `--${declaredBoundary}--`;
      const closingBoundaryOffset = wireBody.lastIndexOf(closingBoundary);
      expect(closingBoundaryOffset).toBeGreaterThanOrEqual(0);

      const truncatedRequest = new Request(url, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: wireBody.slice(0, closingBoundaryOffset),
      });
      await expect(truncatedRequest.formData()).rejects.toThrow();
    });

    test('rejects multipart framing when the declared boundary does not match its body', async () => {
      const { url, wireBody } = await serializedMultipartFixture();
      const malformedRequest = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=wrong-boundary' },
        body: wireBody,
      });

      await expect(malformedRequest.formData()).rejects.toThrow();
    });

    test('fails closed when a non-seekable source cannot provide a bounded stream', async () => {
      const ctx = new MockTaskContext({ taskId: 'bounded-non-seekable-source' });
      const stat = jest.fn(async () => ({
        fileName: 'source.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 16,
        sha256: '0'.repeat(64),
        storageVersionId: 'source-version',
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const readStream = jest.fn(async () => {
        throw new Error('non-seekable source cannot provide a bounded stream');
      });
      const readFallback = jest.spyOn(ctx.artifacts, 'read');
      Object.assign(streamEnabledContext(ctx), { stat, readStream });

      await expect(ParserBudgetHelper.readArtifact(ctx, 'non-seekable-artifact')).rejects.toThrow(
        'non-seekable source cannot provide a bounded stream'
      );
      expect(readFallback).not.toHaveBeenCalled();
    });
  });

  describe('Artifact Count Bounds', () => {
    test('Ingest allows up to 20 artifacts and rejects 21+ with TOO_MANY_ARTIFACTS', () => {
      const validArtifacts = Array.from({ length: 20 }, (_, i) => `art-${i + 1}`);
      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'parse', artifactIds: validArtifacts });
      }).not.toThrow();

      const excessiveArtifacts = Array.from({ length: 21 }, (_, i) => `art-${i + 1}`);
      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'parse', artifactIds: excessiveArtifacts });
      }).toThrow(expect.objectContaining({ code: 'TOO_MANY_ARTIFACTS' }));
    });

    test('Extract rejects >10 artifacts with TOO_MANY_ARTIFACTS', () => {
      const validArtifacts = Array.from({ length: 10 }, (_, i) => `art-${i + 1}`);
      expect(() => {
        InputNormalizer.normalizeExtract({ type: 'invoice', artifactIds: validArtifacts });
      }).not.toThrow();

      const excessiveArtifacts = Array.from({ length: 11 }, (_, i) => `art-${i + 1}`);
      expect(() => {
        InputNormalizer.normalizeExtract({ type: 'invoice', artifactIds: excessiveArtifacts });
      }).toThrow(expect.objectContaining({ code: 'TOO_MANY_ARTIFACTS' }));
    });

    test('Analyze, Transform, and Generate reject >10 artifacts with TOO_MANY_ARTIFACTS', () => {
      const excessiveArtifacts = Array.from({ length: 11 }, (_, i) => `art-${i + 1}`);

      expect(() => {
        InputNormalizer.normalizeAnalyze({ task: 'classify', artifactIds: excessiveArtifacts });
      }).toThrow(expect.objectContaining({ code: 'TOO_MANY_ARTIFACTS' }));

      expect(() => {
        InputNormalizer.normalizeTransform({ variant: 'translate', targetLanguage: 'Spanish', artifactIds: excessiveArtifacts });
      }).toThrow(expect.objectContaining({ code: 'TOO_MANY_ARTIFACTS' }));

      expect(() => {
        InputNormalizer.normalizeGenerate({ task: 'summary', artifactIds: excessiveArtifacts });
      }).toThrow(expect.objectContaining({ code: 'TOO_MANY_ARTIFACTS' }));
    });
  });

  describe('Document / Text Length Bounds', () => {
    test('Rejects document text exceeding 100,000 characters with DOCUMENT_TOO_LARGE', () => {
      const text100k = 'A'.repeat(100_000);
      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'parse', text: text100k });
      }).not.toThrow();

      const textOver100k = 'A'.repeat(100_001);
      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'parse', text: textOver100k });
      }).toThrow(expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' }));

      expect(() => {
        InputNormalizer.normalizeExtract({ type: 'invoice', text: textOver100k });
      }).toThrow(expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' }));

      expect(() => {
        InputNormalizer.normalizeAnalyze({ task: 'sentiment', text: textOver100k });
      }).toThrow(expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' }));

      expect(() => {
        InputNormalizer.normalizeTransform({ variant: 'rewrite', text: textOver100k });
      }).toThrow(expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' }));

      expect(() => {
        InputNormalizer.normalizeGenerate({ task: 'outline', text: textOver100k });
      }).toThrow(expect.objectContaining({ code: 'DOCUMENT_TOO_LARGE' }));
    });
  });

  describe('Page Selection Bounds', () => {
    test('Valid page specifications pass normalization', () => {
      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'split', pages: 'all' });
        InputNormalizer.normalizeIngest({ mode: 'split', pages: '1-5' });
        InputNormalizer.normalizeIngest({ mode: 'split', pages: '1, 3, 5-10' });
        InputNormalizer.normalizeIngest({ mode: 'split', pages: '500' });
      }).not.toThrow();
    });

    test('Invalid page range syntax throws INVALID_PAGE_RANGE', () => {
      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'split', pages: '1-5; rm -rf /' });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_RANGE' }));

      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'split', pages: 'abc' });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PAGE_RANGE' }));
    });

    test('Page number exceeding 500 throws PAGE_LIMIT_EXCEEDED', () => {
      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'split', pages: '1-501' });
      }).toThrow(expect.objectContaining({ code: 'PAGE_LIMIT_EXCEEDED' }));

      expect(() => {
        InputNormalizer.normalizeIngest({ mode: 'split', pages: '501' });
      }).toThrow(expect.objectContaining({ code: 'PAGE_LIMIT_EXCEEDED' }));
    });

    test('rejects zero and negative page numbers and range endpoints', () => {
      for (const pages of ['0', '-1', '1,-2', '0-3', '2-0']) {
        expect(() => InputNormalizer.normalizeIngest({ mode: 'split', pages })).toThrow(
          expect.objectContaining({ code: 'INVALID_PAGE_RANGE' })
        );
      }
    });

    test('rejects non-numeric and fractional page range specifications', () => {
      for (const pages of ['1-two', '1, two', '1.5', '2-3.5']) {
        expect(() => InputNormalizer.normalizeIngest({ mode: 'split', pages })).toThrow(
          expect.objectContaining({ code: 'INVALID_PAGE_RANGE' })
        );
      }
    });
  });

  describe('Custom Schema Complexity Bounds', () => {
    test('Schema with excessive depth (>5) throws SCHEMA_TOO_COMPLEX', () => {
      const deeplyNestedSchema = {
        type: 'object',
        properties: {
          level1: {
            type: 'object',
            properties: {
              level2: {
                type: 'object',
                properties: {
                  level3: {
                    type: 'object',
                    properties: {
                      level4: {
                        type: 'object',
                        properties: {
                          level5: {
                            type: 'object',
                            properties: {
                              level6: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      expect(() => {
        InputNormalizer.normalizeExtract({
          type: 'custom',
          schema: deeplyNestedSchema,
        });
      }).toThrow(expect.objectContaining({ code: 'SCHEMA_DEPTH_EXCEEDED' }));
    });

    test('Schema with excessive properties (>50) throws SCHEMA_SIZE_EXCEEDED', () => {
      const manyProps: Record<string, { type: string }> = {};
      for (let i = 0; i < 55; i++) {
        manyProps[`field_${i}`] = { type: 'string' };
      }

      const hugeSchema = {
        type: 'object',
        properties: manyProps,
      };

      expect(() => {
        InputNormalizer.normalizeExtract({
          type: 'custom',
          schema: hugeSchema,
        });
      }).toThrow(expect.objectContaining({ code: 'SCHEMA_SIZE_EXCEEDED' }));
    });

    test('Schema with remote $ref throws FORBIDDEN_SCHEMA_REF', () => {
      const remoteRefSchema = {
        type: 'object',
        properties: {
          user: { $ref: 'https://evil.example.com/schemas/user.json' },
        },
      };

      expect(() => {
        InputNormalizer.normalizeExtract({
          type: 'custom',
          schema: remoteRefSchema,
        });
      }).toThrow(expect.objectContaining({ code: 'FORBIDDEN_SCHEMA_REF' }));
    });

    test('rejects a deeply self-referential schema at the configured recursion-depth bound', () => {
      const circularSchema: Record<string, unknown> = { type: 'object' };
      circularSchema.properties = { self: circularSchema };

      expect(() => SchemaValidator.validateCustomSchema(circularSchema)).toThrow(
        expect.objectContaining({ code: 'SCHEMA_DEPTH_EXCEEDED' })
      );
    });
  });

  describe('QA Question Count Bounds', () => {
    test('Allows up to 20 questions for QA task', () => {
      const questions20 = Array.from({ length: 20 }, (_, i) => `Question #${i + 1}?`);
      expect(() => {
        InputNormalizer.normalizeGenerate({
          task: 'qa',
          questions: questions20,
        });
      }).not.toThrow();
    });

    test('Rejects >20 questions for QA task with TOO_MANY_QUESTIONS', () => {
      const questions21 = Array.from({ length: 21 }, (_, i) => `Question #${i + 1}?`);
      expect(() => {
        InputNormalizer.normalizeGenerate({
          task: 'qa',
          questions: questions21,
        });
      }).toThrow(expect.objectContaining({ code: 'TOO_MANY_QUESTIONS' }));
    });

    test('Rejects empty questions array for QA task with MISSING_REQUIRED_PARAMETER', () => {
      expect(() => {
        InputNormalizer.normalizeGenerate({
          task: 'qa',
          questions: [],
        });
      }).toThrow(expect.objectContaining({ code: 'MISSING_REQUIRED_PARAMETER' }));
    });

    test('rejects a negative numeric QA question count as a missing bounded question list', () => {
      expect(() => {
        InputNormalizer.normalizeGenerate({
          task: 'qa',
          questions: -1,
        });
      }).toThrow(expect.objectContaining({ code: 'MISSING_REQUIRED_PARAMETER' }));
    });
  });

  describe('Generation Word Limit Bounds', () => {
    test('maxWords <= 0 throws INVALID_ARGUMENT', () => {
      expect(() => {
        InputNormalizer.normalizeGenerate({ task: 'summary', maxWords: 0 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));

      expect(() => {
        InputNormalizer.normalizeGenerate({ task: 'summary', maxWords: -50 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    });

    test('maxWords > 10,000 throws INVALID_PARAMETER_RANGE', () => {
      expect(() => {
        InputNormalizer.normalizeGenerate({ task: 'summary', maxWords: 10_001 });
      }).toThrow(expect.objectContaining({ code: 'INVALID_PARAMETER_RANGE' }));
    });

    test('Valid maxWords passes', () => {
      const res = InputNormalizer.normalizeGenerate({ task: 'summary', maxWords: 500 });
      expect(res.maxWords).toBe(500);
    });
  });

  describe('Compare Input Normalization & source_file / target_file Aliases (P0-03)', () => {
    test('maps legacy source_file and target_file string aliases to artifactId objects', () => {
      const result = InputNormalizer.normalizeCompare({
        mode: 'diff',
        source_file: 'art-source-100',
        target_file: 'art-target-200',
      });

      expect(result.mode).toBe('diff');
      expect(result.source).toEqual({ artifactId: 'art-source-100' });
      expect(result.target).toEqual({ artifactId: 'art-target-200' });
    });

    test('maps object source_file with legacy artifact_id alias', () => {
      const result = InputNormalizer.normalizeCompare({
        mode: 'semantic',
        source_file: { artifact_id: 'art-source-legacy' },
        target_file: { artifact_id: 'art-target-legacy' },
      });

      expect(result.source).toEqual({ artifactId: 'art-source-legacy' });
      expect(result.target).toEqual({ artifactId: 'art-target-legacy' });
    });

    test('supports raw text comparison strings', () => {
      const result = InputNormalizer.normalizeCompare({
        mode: 'diff',
        source: 'Original contract draft',
        target: 'Revised contract draft',
      });

      expect(result.source).toEqual({ text: 'Original contract draft' });
      expect(result.target).toEqual({ text: 'Revised contract draft' });
    });

    test('rejects missing source or target comparison sides', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({ mode: 'diff', target_file: 'art-1' });
      }).toThrow(expect.objectContaining({ code: 'MISSING_COMPARISON_SIDE' }));

      expect(() => {
        InputNormalizer.normalizeCompare({ mode: 'diff', source_file: 'art-1' });
      }).toThrow(expect.objectContaining({ code: 'MISSING_COMPARISON_SIDE' }));
    });

    test('rejects conflicting canonical parameter and legacy file alias with CONFLICTING_COMPARISON_PARAMETERS', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: 'Canonical text',
          source_file: 'art-conflicting',
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'CONFLICTING_COMPARISON_PARAMETERS' }));

      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: { text: 'Source text' },
          target: { text: 'Canonical target' },
          target_file: 'art-conflicting-target',
        });
      }).toThrow(expect.objectContaining({ code: 'CONFLICTING_COMPARISON_PARAMETERS' }));
    });

    test('rejects conflicting object-form legacy aliases rather than letting them override canonical sides', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: { artifactId: 'canonical-source' },
          source_file: { artifact_id: 'legacy-source' },
          target: { text: 'Canonical target' },
          target_file: { artifact_id: 'legacy-target' },
        });
      }).toThrow(expect.objectContaining({ code: 'CONFLICTING_COMPARISON_PARAMETERS' }));
    });

    test('rejects ambiguous comparison side with both artifactId and text with AMBIGUOUS_COMPARISON_SIDE', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'semantic',
          source: { artifactId: 'art-123', text: 'ambiguous literal text' },
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_COMPARISON_SIDE' }));

      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'semantic',
          source: { text: 'Source text' },
          target_file: { artifact_id: 'art-123', text: 'ambiguous literal text' },
        });
      }).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_COMPARISON_SIDE' }));
    });

    test('rejects nonstring artifactId or text with INVALID_COMPARISON_SIDE', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: { artifactId: 12345 },
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));

      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: { text: true },
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));

      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source_file: 99999,
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));
    });

    test('rejects arrays passed as comparison parameters with INVALID_COMPARISON_SIDE', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: ['array-element-1'],
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));

      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: { text: 'Source text' },
          target_file: ['art-target-array'],
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));
    });

    test('rejects empty or whitespace-only string values with INVALID_COMPARISON_SIDE', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: '   ',
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));

      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source_file: '',
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));

      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: { artifactId: '   ' },
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' }));
    });

    test('rejects object comparison side with neither artifactId nor text with MISSING_COMPARISON_SIDE', () => {
      expect(() => {
        InputNormalizer.normalizeCompare({
          mode: 'diff',
          source: { irrelevantField: 'value' },
          target: { text: 'Target text' },
        });
      }).toThrow(expect.objectContaining({ code: 'MISSING_COMPARISON_SIDE' }));
    });
  });

  describe('JSON Schema Nesting Depth Bounds (SchemaValidator MAX_DEPTH=5)', () => {
    function buildNestedSchema(depth: number): Record<string, unknown> {
      let schema: Record<string, unknown> = { type: 'string' };
      for (let i = depth - 1; i > 0; i--) {
        schema = {
          type: 'object',
          properties: {
            [`field_${i}`]: schema,
          },
        };
      }
      return schema;
    }

    test('accepts custom extraction schema with depth up to 5', () => {
      const schemaDepth5 = buildNestedSchema(5);
      expect(() => {
        SchemaValidator.validateCustomSchema(schemaDepth5);
      }).not.toThrow();
    });

    test('rejects custom extraction schema with depth > 5 with SCHEMA_DEPTH_EXCEEDED', () => {
      const schemaDepth6 = buildNestedSchema(6);
      expect(() => {
        SchemaValidator.validateCustomSchema(schemaDepth6);
      }).toThrow(expect.objectContaining({ code: 'SCHEMA_DEPTH_EXCEEDED' }));
    });

    test('rejects schema containing network $ref keywords with FORBIDDEN_SCHEMA_REF', () => {
      const schemaWithRef = {
        type: 'object',
        properties: {
          external: { $ref: 'https://evil.example.com/schema.json' },
        },
      };
      expect(() => {
        SchemaValidator.validateCustomSchema(schemaWithRef);
      }).toThrow(expect.objectContaining({ code: 'FORBIDDEN_SCHEMA_REF' }));
    });
  });

  describe('Legacy Parameter Characterization Grounded in Legacy Registry (P0-03)', () => {
    test('normalizes legacy snake_case output_format across endpoints', () => {
      const ingestRes = InputNormalizer.normalizeIngest({
        mode: 'parse',
        text: 'Invoice test',
        output_format: 'markdown',
      });
      expect(ingestRes.outputFormat).toBe('md');

      const compareRes = InputNormalizer.normalizeCompare({
        mode: 'diff',
        source_file: 'art-1',
        target_file: 'art-2',
        output_format: 'text',
      });
      expect(compareRes.outputFormat).toBe('text');
    });

    test('normalizes legacy transform action parameter to canonical variant', () => {
      const transformRes = InputNormalizer.normalizeTransform({
        action: 'convert',
        text: 'Hello world',
      });
      expect(transformRes.variant).toBe('convert');
    });

    test('normalizes comma-separated string lists to typed arrays (fields, categories, redact_patterns)', () => {
      const extractRes = InputNormalizer.normalizeExtract({
        type: 'custom',
        text: 'Doc',
        fields: 'invoice_number, total_amount, due_date',
        schema: { type: 'object' },
      });
      expect(extractRes.fields).toEqual(['invoice_number', 'total_amount', 'due_date']);

      const analyzeRes = InputNormalizer.normalizeAnalyze({
        task: 'classify',
        text: 'Doc',
        categories: 'legal, financial, operational',
      });
      expect(analyzeRes.categories).toEqual(['legal', 'financial', 'operational']);

      const transformRes = InputNormalizer.normalizeTransform({
        variant: 'redact',
        text: 'Doc',
        redact_patterns: 'EMAIL, PHONE_NUMBER',
      });
      expect(transformRes.redactPatterns).toEqual(['EMAIL', 'PHONE_NUMBER']);
    });
  });
});
