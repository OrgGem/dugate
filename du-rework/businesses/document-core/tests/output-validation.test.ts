import { OutputValidator } from '../src/validation/output-validators';
import { BusinessExecutionError } from '../src/types/results';

describe('Strict Provider Output Validation (WORKLOAD-REBALANCE-04, P5-05/P5-06/P5-08)', () => {
  describe('General Malformed & Empty Output Fencing', () => {
    test('rejects null and undefined provider data with EMPTY_PROVIDER_OUTPUT', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'invoice', null))
        .toThrow(expect.objectContaining({ code: 'EMPTY_PROVIDER_OUTPUT' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'classify', undefined))
        .toThrow(expect.objectContaining({ code: 'EMPTY_PROVIDER_OUTPUT' }));
    });

    test('rejects non-object primitive data with MALFORMED_PROVIDER_OUTPUT', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'invoice', 'not an object'))
        .toThrow(expect.objectContaining({ code: 'MALFORMED_PROVIDER_OUTPUT' }));

      expect(() => OutputValidator.validateProviderOutput('extract', 'table', 12345))
        .toThrow(expect.objectContaining({ code: 'MALFORMED_PROVIDER_OUTPUT' }));
    });

    test('rejects empty object provider output with EMPTY_PROVIDER_OUTPUT', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'invoice', {}))
        .toThrow(expect.objectContaining({ code: 'EMPTY_PROVIDER_OUTPUT' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'sentiment', {}))
        .toThrow(expect.objectContaining({ code: 'EMPTY_PROVIDER_OUTPUT' }));

      expect(() => OutputValidator.validateProviderOutput('generate', 'summary', {}))
        .toThrow(expect.objectContaining({ code: 'EMPTY_PROVIDER_OUTPUT' }));
    });
  });

  describe('Action: Ingest Output Validation', () => {
    test('rejects empty text or markdown for ocr/digitize/parse', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'ocr', { text: '' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('ingest', 'digitize', { text: '   ' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('accepts valid text output for ocr', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'ocr', { text: 'Valid OCR text' }))
        .not.toThrow();
    });

    test('rejects empty splitArtifacts for split', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'split', { splitArtifacts: [] }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });
  });

  describe('Action: Extract Output Validation', () => {
    test('rejects invoice without invoiceNumber, supplier, or total', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'invoice', { randomField: 'foo' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('accepts invoice with essential properties', () => {
      expect(() =>
        OutputValidator.validateProviderOutput('extract', 'invoice', {
          invoiceNumber: 'INV-2026-001',
          supplier: 'Acme Corp',
          total: 1500.0,
        })
      ).not.toThrow();
    });

    test('rejects contract without parties, effectiveDate, or title', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'contract', { notes: 'incomplete' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('rejects receipt without merchant, total, or items', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'receipt', { foo: 'bar' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('rejects table without rows, columns, or tables', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'table', { unparsed: 'text' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('validates custom schema required properties', () => {
      const customSchema = {
        type: 'object',
        required: ['employeeId', 'department'],
        properties: {
          employeeId: { type: 'string' },
          department: { type: 'string' },
        },
      };

      expect(() =>
        OutputValidator.validateProviderOutput('extract', 'custom', { employeeId: 'E-123' }, customSchema)
      ).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() =>
        OutputValidator.validateProviderOutput(
          'extract',
          'custom',
          { employeeId: 'E-123', department: 'Engineering' },
          customSchema
        )
      ).not.toThrow();
    });
  });

  describe('Action: Analyze Output Validation', () => {
    test('rejects classification missing category or invalid confidence range', () => {
      expect(() => OutputValidator.validateProviderOutput('analyze', 'classify', { category: '' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'classify', { category: 'Legal', confidence: 1.5 }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'classify', { category: 'Legal', confidence: -0.1 }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('accepts valid classification output', () => {
      expect(() =>
        OutputValidator.validateProviderOutput('analyze', 'classify', { category: 'Finance', confidence: 0.95 })
      ).not.toThrow();
    });

    test('rejects sentiment with invalid enum value', () => {
      expect(() => OutputValidator.validateProviderOutput('analyze', 'sentiment', { sentiment: 'excited' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'sentiment', { sentiment: 'positive' }))
        .not.toThrow();
    });

    test('rejects compliance with invalid status enum', () => {
      expect(() => OutputValidator.validateProviderOutput('analyze', 'compliance', { status: 'UNKNOWN' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'compliance', { status: 'PASS' }))
        .not.toThrow();
    });

    test('rejects quality score outside 0..100', () => {
      expect(() => OutputValidator.validateProviderOutput('analyze', 'quality', { score: 101 }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'quality', { score: -5 }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'quality', { score: 85 }))
        .not.toThrow();
    });

    test('rejects risk level outside standard enum', () => {
      expect(() => OutputValidator.validateProviderOutput('analyze', 'risk', { riskLevel: 'DANGEROUS' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('analyze', 'risk', { riskLevel: 'HIGH' }))
        .not.toThrow();
    });
  });

  describe('Action: Generate Output Validation', () => {
    test('rejects summary / outline / report with empty content', () => {
      expect(() => OutputValidator.validateProviderOutput('generate', 'summary', { content: '   ' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('generate', 'outline', { text: '' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('rejects qa with empty or malformed answers array', () => {
      expect(() => OutputValidator.validateProviderOutput('generate', 'qa', { answers: [] }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('generate', 'qa', { answers: [{ notAnAnswer: 123 }] }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('accepts valid qa output with answers', () => {
      expect(() =>
        OutputValidator.validateProviderOutput('generate', 'qa', {
          answers: [
            { question: 'What is the date?', answer: 'September 20, 2026' },
            { question: 'Who is the author?', answer: 'Antigravity' },
          ],
        })
      ).not.toThrow();
    });
  });

  describe('Action: Compare Output Validation', () => {
    test('rejects diff output without changes array or unifiedDiff', () => {
      expect(() => OutputValidator.validateProviderOutput('compare', 'diff', { same: true }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() => OutputValidator.validateProviderOutput('compare', 'diff', { changes: [] }))
        .not.toThrow();
    });

    test('rejects semantic comparison with invalid similarity score', () => {
      expect(() => OutputValidator.validateProviderOutput('compare', 'semantic', { similarity: 2.0 }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));

      expect(() =>
        OutputValidator.validateProviderOutput('compare', 'semantic', { similarity: 0.88, analysis: 'Minor changes' })
      ).not.toThrow();
    });
  });

  describe('Negative and boundary provider payload cases', () => {
    // These expected-failure assertions capture validation gaps without changing
    // production behavior in this test-only task; see the receipt for details.
    test.failing('rejects NaN confidence rather than treating it as an in-range number', () => {
      expect(() => OutputValidator.validateProviderOutput('analyze', 'classify', {
        category: 'Finance',
        confidence: Number.NaN,
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects NaN quality score', () => {
      expect(() => OutputValidator.validateProviderOutput('analyze', 'quality', { score: Number.NaN }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects a negative invoice total', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'invoice', {
        invoiceNumber: 'INV-NEGATIVE',
        supplier: 'Example Supplier',
        total: -0.01,
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects provider arrays that exceed the supported output item cap', () => {
      const answers = Array.from({ length: 100_001 }, (_, index) => ({
        question: `Question ${index}`,
        answer: 'bounded answer',
      }));
      expect(() => OutputValidator.validateProviderOutput('generate', 'qa', { answers }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects control characters in provider text', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'ocr', { text: 'recognized\u0000\u0001text' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects replacement characters from corrupted UTF-8 provider text', () => {
      // OutputValidator receives decoded strings; U+FFFD represents invalid byte sequences after decoding.
      expect(() => OutputValidator.validateProviderOutput('ingest', 'digitize', { text: 'scan\uFFFD\uFFFDtext' }))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects unknown provider fields on a known output variant', () => {
      expect(() => OutputValidator.validateProviderOutput('extract', 'invoice', {
        invoiceNumber: 'INV-EXTRA',
        supplier: 'Example Supplier',
        total: 1,
        providerDirective: 'unexpected-field',
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects a provider-owned __proto__ field', () => {
      const output = JSON.parse(
        '{"text":"recognized text","__proto__":{"polluted":"yes"}}'
      ) as Record<string, unknown>;
      expect(() => OutputValidator.validateProviderOutput('ingest', 'ocr', output))
        .toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test('does not mutate Object.prototype while inspecting a provider __proto__ field', () => {
      const output = JSON.parse(
        '{"text":"recognized text","__proto__":{"polluted":"yes"}}'
      ) as Record<string, unknown>;
      expect(() => OutputValidator.validateProviderOutput('ingest', 'ocr', output)).not.toThrow();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    });

    test('rejects a success envelope whose validated result is nested under an unexpected field', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'parse', {
        status: 'success',
        result: { text: 'nested content must not bypass the output contract' },
        metadata: { mimeType: 'text/plain' },
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects a malformed payload checksum', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'parse', {
        text: 'valid parsed text',
        payload: { sha256: 'sha256:not-hex' },
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects a payload checksum that does not match its content', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'parse', {
        text: 'valid parsed text',
        payload: { sha256: '0'.repeat(64) },
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects unexpected MIME types in provider output envelopes', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'ocr', {
        text: 'recognized text',
        mimeType: 'application/x-msdownload',
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects oversized payload descriptors before accepting split output', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'split', {
        splitArtifacts: [{
          artifactId: 'artifact-too-large',
          sizeBytes: Number.MAX_SAFE_INTEGER,
          mimeType: 'application/pdf',
          sha256: 'a'.repeat(64),
        }],
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });

    test.failing('rejects provider content carrying a truncated-content marker', () => {
      expect(() => OutputValidator.validateProviderOutput('ingest', 'parse', {
        text: 'partial extraction result... [truncated]',
      })).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
    });
  });
});
