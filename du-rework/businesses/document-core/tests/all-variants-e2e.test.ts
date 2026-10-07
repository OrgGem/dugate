import { VARIANT_TRACEABILITY_MATRIX, VariantTraceabilityEntry } from '../src/manifest/traceability';
import { documentCoreHandlers } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';
import { TestFixtures } from '../../../orchestrator/packages/document-kit/tests/fixtures/test-fixtures';
import { verifyAgainstCorpus } from './fixtures/expected-result-corpus';

/**
 * INGEST-WIRE-01: a real 1x1 PNG for the OCR/digitize variants. The previous
 * fixtures passed placeholder TEXT, so no image ever existed on the wire.
 * Base64 of a valid PNG (signature 89504e47 + IHDR/IDAT/IEND).
 */
const SCAN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function createScanPngBytes(): Buffer {
  return Buffer.from(SCAN_PNG_BASE64, 'base64');
}

describe('Deterministic 31-Variant Full-Business Local E2E Matrix (WORKLOAD-REBALANCE-04, P5-06)', () => {
  // Verifies that all 31 variants execute through documentCoreHandlers, write durable result artifacts,
  // and satisfy machine-checkable output validation contracts with controlled synthetic fixtures.
  test('VARIANT_TRACEABILITY_MATRIX contains exactly 31 variants', () => {
    expect(VARIANT_TRACEABILITY_MATRIX.length).toBe(31);
  });

  const customSchema = {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['projectId', 'status'],
  };

  function getVariantFixture(entry: VariantTraceabilityEntry, ctx: MockTaskContext): {
    input: Record<string, unknown>;
    setupMock: () => Promise<void> | void;
  } {
    switch (entry.brdCaseId) {
      // DOC-01: Ingest
      case 'DOC-01-01':
        return {
          input: { mode: 'parse', text: 'Sample document text for ingestion' },
          setupMock: () => {},
        };
      case 'DOC-01-02': {
        // INGEST-WIRE-01: OCR now receives a real scan artifact, not placeholder
        // text plus a boolean. Same shape as the split variant below.
        const ocrInput: Record<string, unknown> = { mode: 'ocr', language: 'vie' };
        return {
          input: ocrInput,
          setupMock: async () => {
            const art = await ctx.artifacts.write(createScanPngBytes(), 'scan.png', 'image/png');
            ocrInput.artifactIds = [art.artifactId];
            ctx.mockConnectorResponses.set('ocr', {
              invocationId: 'inv-ocr-e2e',
              status: 'SUCCESS',
              data: { text: 'Scanned receipt text', markdown: '# Scanned receipt' },
            });
          },
        };
      }
      case 'DOC-01-03': {
        // INGEST-WIRE-01: digitize likewise gets a real form image; a task name
        // alone never told the provider which document to read.
        const digitizeInput: Record<string, unknown> = { mode: 'digitize' };
        return {
          input: digitizeInput,
          setupMock: async () => {
            const art = await ctx.artifacts.write(createScanPngBytes(), 'form.png', 'image/png');
            digitizeInput.artifactIds = [art.artifactId];
            ctx.mockConnectorResponses.set('vision', {
              invocationId: 'inv-vis-e2e',
              status: 'SUCCESS',
              data: {
                text: 'Patient Intake Form',
                formFields: { patientName: 'John Doe', age: 35 },
              },
            });
          },
        };
      }
      case 'DOC-01-04': {
        const splitInput: Record<string, unknown> = { mode: 'split', pages: '1' };
        return {
          input: splitInput,
          setupMock: async () => {
            const pdfBuf = TestFixtures.createSamplePdf('Page 1 content');
            const art = await ctx.artifacts.write(pdfBuf, 'test.pdf', 'application/pdf');
            splitInput.artifactIds = [art.artifactId];
          },
        };
      }

      // DOC-02: Extract
      case 'DOC-02-01':
        return {
          input: { type: 'invoice', text: 'Invoice #101 for $500.00 from Acme Corp' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-ext-inv',
              status: 'SUCCESS',
              data: { invoiceNumber: 'INV-101', supplier: 'Acme Corp', total: '$500.00' },
            });
          },
        };
      case 'DOC-02-02':
        return {
          input: { type: 'contract', text: 'Agreement between Party A and Party B effective 2026-01-01' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-ext-con',
              status: 'SUCCESS',
              data: {
                title: 'Master Service Agreement',
                parties: ['Party A', 'Party B'],
                effectiveDate: '2026-01-01',
              },
            });
          },
        };
      case 'DOC-02-03':
        return {
          input: { type: 'receipt', text: 'Grocery store receipt for $25.50' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-ext-rec',
              status: 'SUCCESS',
              data: {
                merchantName: 'Corner Grocery',
                totalAmount: 25.5,
                items: [{ name: 'Milk', price: 3.5 }],
              },
            });
          },
        };
      case 'DOC-02-04':
        return {
          input: { type: 'table', text: 'Col1,Col2\nVal1,Val2' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-ext-tab',
              status: 'SUCCESS',
              data: {
                headers: ['Col1', 'Col2'],
                rows: [['Val1', 'Val2']],
              },
            });
          },
        };
      case 'DOC-02-05':
        return {
          input: {
            type: 'custom',
            text: 'Project documentation for PRJ-99',
            schema: customSchema,
          },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-ext-cus',
              status: 'SUCCESS',
              data: { projectId: 'PRJ-99', status: 'ACTIVE' },
            });
          },
        };
      case 'DOC-02-06':
        return {
          input: { type: 'id-card', text: 'Vietnamese identity card for Nguyen Minh Anh, document ID VN-2048-0007.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-ext-id-card',
              status: 'SUCCESS',
              data: {
                identityNumber: 'VN-2048-0007',
                fullName: 'Nguyen Minh Anh',
                dateOfBirth: '1990-05-12',
                nationality: 'Vietnamese',
              },
            });
          },
        };

      // DOC-03: Analyze
      case 'DOC-03-01':
        return {
          input: { task: 'classify', categories: ['Legal', 'Finance'], text: 'Quarterly financial statements' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-an-cla',
              status: 'SUCCESS',
              data: { category: 'Finance', confidence: 0.98 },
            });
          },
        };
      case 'DOC-03-02':
        return {
          input: { task: 'sentiment', text: 'Outstanding execution and wonderful collaboration!' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-an-sen',
              status: 'SUCCESS',
              data: { sentiment: 'positive', score: 0.95 },
            });
          },
        };
      case 'DOC-03-03':
        return {
          input: { task: 'compliance', criteria: ['HIPAA'], text: 'Healthcare patient privacy safeguard checklist' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-an-com',
              status: 'SUCCESS',
              data: { status: 'PASS', findings: [] },
            });
          },
        };
      case 'DOC-03-04':
        return {
          input: { task: 'quality', text: 'Code review documentation and developer guideline' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-an-qua',
              status: 'SUCCESS',
              data: { qualityScore: 92, readability: 'high', suggestions: [] },
            });
          },
        };
      case 'DOC-03-05':
        return {
          input: { task: 'risk', text: 'Contract clauses with unlimited liability provisions' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-an-ris',
              status: 'SUCCESS',
              data: { riskLevel: 'HIGH', factors: [{ name: 'liability', level: 'high' }] },
            });
          },
        };
      case 'DOC-03-06':
        return {
          input: {
            task: 'fact-check',
            text: 'The report states that Northwind revenue grew by 12% in 2025.',
            referenceData: { source: 'Annual report', revenueGrowth2025: '12%' },
          },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-an-fact-check',
              status: 'SUCCESS',
              data: {
                verdict: 'PASS',
                summary: 'The reported growth matches the supplied annual-report reference.',
                checks: [{ claim: 'Revenue grew by 12% in 2025.', status: 'PASS', reference: 'Annual report: 12% growth.' }],
              },
            });
          },
        };
      case 'DOC-03-07':
        return {
          input: { task: 'summarize-eval', text: 'The proposal prioritizes accessible transit, phased investment, and measurable service targets.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-an-summarize-eval',
              status: 'SUCCESS',
              data: {
                summary: 'The proposal improves transit access through phased investment and measurable service targets.',
                evaluation: {
                  overallAssessment: 'The argument is structured around practical, measurable outcomes.',
                  authorPerspective: 'The author favors incremental investment tied to public-service results.',
                },
              },
            });
          },
        };

      // DOC-04: Transform
      case 'DOC-04-01':
        return {
          input: { variant: 'convert', text: '# Title\n\nParagraph text.', outputFormat: 'text' },
          setupMock: () => {},
        };
      case 'DOC-04-02':
        return {
          input: { variant: 'translate', targetLanguage: 'French', text: 'Hello, welcome to our platform.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-tr-tra',
              status: 'SUCCESS',
              rawText: 'Bonjour, bienvenue sur notre plateforme.',
              data: 'Bonjour, bienvenue sur notre plateforme.',
            });
          },
        };
      case 'DOC-04-03':
        return {
          input: { variant: 'rewrite', style: 'executive', text: 'Deep technical stack trace details.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-tr-rew',
              status: 'SUCCESS',
              rawText: 'High-level operational overview.',
              data: 'High-level operational overview.',
            });
          },
        };
      case 'DOC-04-04':
        return {
          input: { variant: 'redact', text: 'Call 415-555-1212 or email admin@company.com', redactPatterns: ['email', 'phone'] },
          setupMock: () => {},
        };
      case 'DOC-04-05':
        return {
          input: { variant: 'template', text: '{"client":"Global Corp"}', template: 'Welcome {{client}} to DU Gate.' },
          setupMock: () => {},
        };

      // DOC-05: Generate
      case 'DOC-05-01':
        return {
          input: { task: 'summary', text: 'The project achieved all deliverables ahead of schedule with zero defect reports.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-gen-sum',
              status: 'SUCCESS',
              rawText: 'Project completed ahead of schedule with zero defects.',
              data: 'Project completed ahead of schedule with zero defects.',
            });
          },
        };
      case 'DOC-05-02':
        return {
          input: { task: 'outline', text: 'Document covering architecture, data flows, and security policies.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-gen-out',
              status: 'SUCCESS',
              rawText: '# System Outline\n1. Architecture\n2. Data Flows\n3. Security',
              data: '# System Outline\n1. Architecture\n2. Data Flows\n3. Security',
            });
          },
        };
      case 'DOC-05-03':
        return {
          input: { task: 'report', text: 'Audit trail results for security compliance wave 4.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-gen-rep',
              status: 'SUCCESS',
              rawText: '# Security Audit Report\nAll audit controls passed.',
              data: '# Security Audit Report\nAll audit controls passed.',
            });
          },
        };
      case 'DOC-05-04':
        return {
          input: { task: 'email', text: 'Key notes for client project delivery announcement.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-gen-ema',
              status: 'SUCCESS',
              rawText: 'Subject: Delivery Announcement\n\nDear Partner, ...',
              data: 'Subject: Delivery Announcement\n\nDear Partner, ...',
            });
          },
        };
      case 'DOC-05-05':
        return {
          input: { task: 'minutes', text: 'Transcript: Alice agreed to merge PR; Bob will deploy to staging.' },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-gen-min',
              status: 'SUCCESS',
              rawText: 'Meeting Minutes:\n- Alice: Merge PR\n- Bob: Deploy staging',
              data: 'Meeting Minutes:\n- Alice: Merge PR\n- Bob: Deploy staging',
            });
          },
        };
      case 'DOC-05-06':
        return {
          input: { task: 'qa', text: 'The return policy allows full refunds within 30 days of purchase.', questions: ['What is the refund window?'] },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-gen-qa',
              status: 'SUCCESS',
              data: {
                answers: [{ question: 'What is the refund window?', answer: 'Full refunds are permitted within 30 days.' }],
              },
            });
          },
        };

      // DOC-06: Compare
      case 'DOC-06-01':
        return {
          input: { mode: 'diff', source: { text: 'Alpha Bravo' }, target: { text: 'Alpha Charlie' } },
          setupMock: () => {},
        };
      case 'DOC-06-02':
        return {
          input: { mode: 'semantic', source: { text: 'Standard vendor SLA' }, target: { text: 'Premium vendor SLA' } },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-cmp-sem',
              status: 'SUCCESS',
              data: {
                similarityScore: 0.85,
                keyDifferences: ['Response time differs (4h vs 1h)'],
                semanticAlignment: 'high',
              },
            });
          },
        };
      case 'DOC-06-03':
        return {
          input: { mode: 'version', source: { text: 'API spec v1.0' }, target: { text: 'API spec v2.0' } },
          setupMock: () => {
            ctx.mockConnectorResponses.set('reasoning', {
              invocationId: 'inv-cmp-ver',
              status: 'SUCCESS',
              data: {
                changes: [{ type: 'added', description: 'New endpoints added' }],
                backwardCompatible: true,
              },
            });
          },
        };

      default:
        throw new Error(`Unhandled variant case in test fixture: ${entry.brdCaseId}`);
    }
  }

  // Iterate deterministically across each of the 31 variants in the traceability matrix
  for (const entry of VARIANT_TRACEABILITY_MATRIX) {
    test(`${entry.brdCaseId} (${entry.action}/${entry.variant}): executes E2E and validates output artifact`, async () => {
      const ctx = new MockTaskContext();
      const fixture = getVariantFixture(entry, ctx);

      // Setup mocks / input artifacts
      await fixture.setupMock();

      // 1. Invoke through the registered documentCoreHandlers entrypoint
      const handler = documentCoreHandlers[entry.action]!;
      expect(handler).toBeDefined();

      const disposition = await handler(ctx, fixture.input);

      // 2. Assert successful terminal disposition
      expect(disposition.kind).toBe('completed');
      expect((disposition as any).resultRef).toMatch(/^artifact:\/\//);

      // 3. Read back durable result artifact
      const artifactId = (disposition as any).resultRef.replace('artifact://', '');
      const artifactBuf = await ctx.artifacts.read(artifactId);
      expect(artifactBuf).toBeDefined();

      // 4. Validate result envelope against EXPECTED_RESULT_CORPUS
      const envelope = JSON.parse(artifactBuf.toString('utf8'));
      expect(envelope.status).toBe('COMPLETED');
      expect(envelope.data).toBeDefined();

      const corpusVerification = verifyAgainstCorpus(entry.brdCaseId, envelope);
      expect(corpusVerification.matched).toBe(true);
      expect(corpusVerification.mismatches).toEqual([]);

      // 5. Machine-check output through the variant's output validator
      expect(() => {
        entry.validateOutput(envelope.data, fixture.input.schema as Record<string, unknown> | undefined);
      }).not.toThrow();
    });
  }
});
