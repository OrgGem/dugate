import { InputNormalizer } from '../src/validation/input-normalizer';
import { SchemaValidator } from '../src/validation/schema-validator';
import { ValidationError } from '../src/types/results';

describe('Bounded Input Enforcement (WORKLOAD-REBALANCE-04, P5-05)', () => {
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
