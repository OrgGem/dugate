import { InputNormalizer } from '../src/validation/input-normalizer';
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
});
