import { VARIANT_TRACEABILITY_MATRIX, VariantTraceabilityEntry } from '../src/manifest/traceability';
import { documentCoreHandlers } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';
import { TestFixtures } from '../../../packages/document-kit/tests/fixtures/test-fixtures';

/** INGEST-WIRE-01: a real 1x1 PNG so OCR/digitize variants carry a real image. */
const SCAN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function createScanPngBytes(): Buffer {
  return Buffer.from(SCAN_PNG_BASE64, 'base64');
}
import {
  EXPECTED_RESULT_CORPUS,
  getCorpusEntry,
  verifyAgainstCorpus,
  normalizeNondeterministicFields,
  type CorpusVariantEntry,
} from './fixtures/expected-result-corpus';

/**
 * RV-06 Expected Result Corpus Regression Consumer Test Suite (Wave 40 / W40-A6)
 *
 * Verifies that EXPECTED_RESULT_CORPUS is actively consumed as an immutable regression target
 * across all 28 canonical document variants.
 *
 * Enforces:
 * 1. Exact equality between actual handler result envelopes and derived expected corpus envelopes
 *    (normalizing only nondeterministic fields such as artifact UUIDs and timestamps).
 * 2. Strict partition between Native Parsers (0 token cost, 0 connector calls) and
 *    Provider-backed models (tracked tokens, verified connector invocations).
 * 3. Machine-checkable output schema validation per variant.
 */

describe('RV-06: Expected Result Corpus Regression Consumer (28 Canonical Variants)', () => {
  test('EXPECTED_RESULT_CORPUS covers exactly 28 canonical variants matching traceability matrix', () => {
    const matrixIds = VARIANT_TRACEABILITY_MATRIX.map((v) => v.brdCaseId).sort();
    const corpusIds = Object.keys(EXPECTED_RESULT_CORPUS).sort();
    expect(corpusIds.length).toBe(28);
    expect(matrixIds).toEqual(corpusIds);
  });

  const customSchema = {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['projectId', 'status'],
  };

  function setupFixtureMocks(caseId: string, ctx: MockTaskContext): void {
    switch (caseId) {
      case 'DOC-01-02':
        ctx.mockConnectorResponses.set('ocr', {
          invocationId: 'inv-ocr-e2e',
          status: 'SUCCESS',
          data: { text: 'Scanned receipt text', markdown: '# Scanned receipt' },
        });
        break;
      case 'DOC-01-03':
        ctx.mockConnectorResponses.set('vision', {
          invocationId: 'inv-vis-e2e',
          status: 'SUCCESS',
          data: {
            text: 'Patient Intake Form',
            formFields: { patientName: 'John Doe', age: 35 },
          },
        });
        break;
      case 'DOC-02-01':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-ext-inv',
          status: 'SUCCESS',
          data: { invoiceNumber: 'INV-101', supplier: 'Acme Corp', total: '$500.00' },
        });
        break;
      case 'DOC-02-02':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-ext-con',
          status: 'SUCCESS',
          data: {
            title: 'Master Service Agreement',
            parties: ['Party A', 'Party B'],
            effectiveDate: '2026-01-01',
          },
        });
        break;
      case 'DOC-02-03':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-ext-rec',
          status: 'SUCCESS',
          data: {
            merchantName: 'Corner Grocery',
            totalAmount: 25.5,
            items: [{ name: 'Milk', price: 3.5 }],
          },
        });
        break;
      case 'DOC-02-04':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-ext-tab',
          status: 'SUCCESS',
          data: {
            headers: ['Col1', 'Col2'],
            rows: [['Val1', 'Val2']],
          },
        });
        break;
      case 'DOC-02-05':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-ext-cus',
          status: 'SUCCESS',
          data: { projectId: 'PRJ-99', status: 'ACTIVE' },
        });
        break;
      case 'DOC-03-01':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-an-cla',
          status: 'SUCCESS',
          data: { category: 'Finance', confidence: 0.98 },
        });
        break;
      case 'DOC-03-02':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-an-sen',
          status: 'SUCCESS',
          data: { sentiment: 'positive', score: 0.95 },
        });
        break;
      case 'DOC-03-03':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-an-com',
          status: 'SUCCESS',
          data: { status: 'PASS', findings: [] },
        });
        break;
      case 'DOC-03-04':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-an-qua',
          status: 'SUCCESS',
          data: { qualityScore: 92, readability: 'high', suggestions: [] },
        });
        break;
      case 'DOC-03-05':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-an-ris',
          status: 'SUCCESS',
          data: { riskLevel: 'HIGH', factors: [{ name: 'liability', level: 'high' }] },
        });
        break;
      case 'DOC-04-02':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-tr-tra',
          status: 'SUCCESS',
          rawText: 'Bonjour, bienvenue sur notre plateforme.',
          data: 'Bonjour, bienvenue sur notre plateforme.',
        });
        break;
      case 'DOC-04-03':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-tr-rew',
          status: 'SUCCESS',
          rawText: 'High-level operational overview.',
          data: 'High-level operational overview.',
        });
        break;
      case 'DOC-05-01':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-gen-sum',
          status: 'SUCCESS',
          rawText: 'Project completed ahead of schedule with zero defects.',
          data: 'Project completed ahead of schedule with zero defects.',
        });
        break;
      case 'DOC-05-02':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-gen-out',
          status: 'SUCCESS',
          rawText: '# System Outline\n1. Architecture\n2. Data Flows\n3. Security',
          data: '# System Outline\n1. Architecture\n2. Data Flows\n3. Security',
        });
        break;
      case 'DOC-05-03':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-gen-rep',
          status: 'SUCCESS',
          rawText: '# Security Audit Report\nAll audit controls passed.',
          data: '# Security Audit Report\nAll audit controls passed.',
        });
        break;
      case 'DOC-05-04':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-gen-ema',
          status: 'SUCCESS',
          rawText: 'Subject: Delivery Announcement\n\nDear Partner, ...',
          data: 'Subject: Delivery Announcement\n\nDear Partner, ...',
        });
        break;
      case 'DOC-05-05':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-gen-min',
          status: 'SUCCESS',
          rawText: 'Meeting Minutes:\n- Alice: Merge PR\n- Bob: Deploy staging',
          data: 'Meeting Minutes:\n- Alice: Merge PR\n- Bob: Deploy staging',
        });
        break;
      case 'DOC-05-06':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-gen-qa',
          status: 'SUCCESS',
          data: {
            answers: [{ question: 'What is the refund window?', answer: 'Full refunds are permitted within 30 days.' }],
          },
        });
        break;
      case 'DOC-06-02':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-cmp-sem',
          status: 'SUCCESS',
          data: {
            similarityScore: 0.85,
            keyDifferences: ['Response time differs (4h vs 1h)'],
            semanticAlignment: 'high',
          },
        });
        break;
      case 'DOC-06-03':
        ctx.mockConnectorResponses.set('reasoning', {
          invocationId: 'inv-cmp-ver',
          status: 'SUCCESS',
          data: {
            changes: [{ type: 'added', description: 'New endpoints added' }],
            backwardCompatible: true,
          },
        });
        break;
      default:
        // Native parser variants require zero mock connector responses
        break;
    }
  }

  // Iterate deterministically across each of the 28 variants in the corpus
  for (const matrixEntry of VARIANT_TRACEABILITY_MATRIX) {
    const caseId = matrixEntry.brdCaseId;
    const corpusEntry = getCorpusEntry(caseId)!;

    test(`${caseId} (${corpusEntry.action}/${corpusEntry.variant}): matches expected corpus envelope and respects execution mode`, async () => {
      expect(corpusEntry).toBeDefined();

      const ctx = new MockTaskContext();
      setupFixtureMocks(caseId, ctx);

      // Deep clone synthetic input to avoid mutating test corpus
      const input = JSON.parse(JSON.stringify(corpusEntry.syntheticInput));

      // If variant is split (DOC-01-04), write synthetic PDF artifact
      if (caseId === 'DOC-01-04') {
        const pdfBuf = TestFixtures.createSamplePdf('Page 1 content');
        const art = await ctx.artifacts.write(pdfBuf, 'test.pdf', 'application/pdf');
        input.artifactIds = [art.artifactId];
      }
      // INGEST-WIRE-01: OCR (DOC-01-02) and digitize (DOC-01-03) now require a
      // real scan artifact on the wire; the corpus previously carried placeholder
      // text, which proved nothing was transmitted. A real PNG is attached so
      // the Connector receives an actual document reference.
      if (caseId === 'DOC-01-02' || caseId === 'DOC-01-03') {
        const scan = createScanPngBytes();
        const art = await ctx.artifacts.write(scan, 'scan.png', 'image/png');
        input.artifactIds = [art.artifactId];
      }

      // 1. Invoke action handler
      const handler = documentCoreHandlers[corpusEntry.action];
      expect(handler).toBeDefined();

      const disposition = await handler!(ctx, input);
      expect(disposition.kind).toBe('completed');
      expect((disposition as any).resultRef).toMatch(/^artifact:\/\//);

      // 2. Read durable result artifact
      const artifactId = (disposition as any).resultRef.replace('artifact://', '');
      const artifactBuf = await ctx.artifacts.read(artifactId);
      const actualEnvelope = JSON.parse(artifactBuf.toString('utf8'));

      // 3. Verify against corpus via verification helper
      const verification = verifyAgainstCorpus(caseId, actualEnvelope);
      expect(verification.matched).toBe(true);
      expect(verification.mismatches).toEqual([]);

      // 4. Assert full normalized structural and data equality
      const normalizedActual = normalizeNondeterministicFields(actualEnvelope);
      const normalizedExpected = normalizeNondeterministicFields(corpusEntry.derivedExpectedEnvelope);
      expect(normalizedActual).toEqual(normalizedExpected);

      // 5. Native Parser vs Provider execution mode boundaries
      if (corpusEntry.executionMode === 'native') {
        expect(corpusEntry.expectedTokenUsage.inputTokens).toBe(0);
        expect(corpusEntry.expectedTokenUsage.outputTokens).toBe(0);
        expect(corpusEntry.expectedTokenUsage.costMicrousd).toBe(0);
        expect(ctx.connectorInvocations.length).toBe(0); // Zero connector calls
      } else {
        expect(corpusEntry.expectedTokenUsage.costMicrousd).toBeGreaterThan(0);
        expect(ctx.connectorInvocations.length).toBeGreaterThan(0); // Provider called
      }

      // 6. Schema output validator assertion
      expect(() => {
        matrixEntry.validateOutput(actualEnvelope.data, input.schema as Record<string, unknown> | undefined);
      }).not.toThrow();
    });
  }
});
