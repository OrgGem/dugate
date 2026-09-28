import { ExtractAction } from '../src/actions/extract';
import { MockTaskContext } from './fixtures/mock-context';

describe('Action: Extract (DOC-02) — 5 Variants', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  // Variant 1: invoice
  it('DOC-02-v1: extracts invoice data structure and validates envelope', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-1',
      status: 'SUCCESS',
      data: {
        supplier: { name: 'ABC Tech', taxId: 'TAX-001' },
        buyer: { name: 'XYZ Corp' },
        invoiceNumber: 'INV-2026-001',
        invoiceDate: '2026-01-15',
        lineItems: [{ description: 'Consulting Services', quantity: 1, unitPrice: 1000000, amount: 1000000 }],
        subtotal: 1000000,
        total: 1000000,
        currency: 'USD',
      },
    };

    const input = ExtractAction.validateInput({
      type: 'invoice',
      text: 'Sample invoice text',
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    const result = (await ExtractAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = ExtractAction.validateResult(result);
    const envelope = ExtractAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_extraction');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(result.invoiceNumber).toBe('INV-2026-001');
    expect(result.total).toBe(1000000);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 2: contract
  it('DOC-02-v2: extracts contract terms and parties', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-2',
      status: 'SUCCESS',
      data: {
        parties: { partyA: 'Alpha Corp', partyB: 'Beta LLC' },
        effectiveDate: '2026-01-01',
        title: 'Software Services Agreement',
        penaltyClauses: ['Clause 8.1: Late delivery penalty 1% per day'],
      },
    };

    const input = ExtractAction.validateInput({
      type: 'contract',
      text: 'Agreement between Alpha Corp and Beta LLC...',
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    const result = (await ExtractAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = ExtractAction.validateResult(result);
    const envelope = ExtractAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_extraction');
    expect((result.parties as { partyA: string }).partyA).toBe('Alpha Corp');
    expect((result.parties as { partyB: string }).partyB).toBe('Beta LLC');
    expect(result.title).toBe('Software Services Agreement');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 3: receipt
  it('DOC-02-v3: extracts receipt details', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-3',
      status: 'SUCCESS',
      data: {
        merchantName: 'Supermarket Fast Mart',
        totalAmount: 145000,
        items: [{ name: 'Milk', price: 35000 }, { name: 'Bread', price: 20000 }],
        paymentMethod: 'Credit Card',
      },
    };

    const input = ExtractAction.validateInput({
      type: 'receipt',
      text: 'Receipt from Fast Mart...',
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    const result = (await ExtractAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = ExtractAction.validateResult(result);
    const envelope = ExtractAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(result.merchantName).toBe('Supermarket Fast Mart');
    expect(result.totalAmount).toBe(145000);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 4: table
  it('DOC-02-v4: extracts tabular grid', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-4',
      status: 'SUCCESS',
      data: {
        tables: [
          {
            title: 'Q1 Revenue Summary',
            headers: ['Month', 'Revenue', 'Target'],
            rows: [
              ['Jan', '$10,000', '$9,000'],
              ['Feb', '$12,000', '$10,000'],
            ],
          },
        ],
      },
    };

    const input = ExtractAction.validateInput({
      type: 'table',
      text: '| Month | Revenue | Target |\n| Jan | $10,000 | $9,000 |',
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    const result = (await ExtractAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = ExtractAction.validateResult(result);
    const envelope = ExtractAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(Array.isArray(result.tables)).toBe(true);
    expect((result.tables as Array<{ title: string }>)[0]!.title).toBe('Q1 Revenue Summary');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 5: custom
  it('DOC-02-v5: extracts dynamic custom schema', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-5',
      status: 'SUCCESS',
      data: {
        applicantName: 'Alice Smith',
        requestedLoan: 50000,
        riskTier: 'LOW',
      },
    };

    const customSchema = {
      type: 'object',
      properties: {
        applicantName: { type: 'string' },
        requestedLoan: { type: 'number' },
        riskTier: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
      },
      required: ['applicantName'],
    };

    const input = ExtractAction.validateInput({
      type: 'custom',
      text: 'Applicant: Alice Smith, requested loan of 50000 USD',
      schema: customSchema,
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    const result = (await ExtractAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = ExtractAction.validateResult(result);
    const envelope = ExtractAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(result.applicantName).toBe('Alice Smith');
    expect(result.requestedLoan).toBe(50000);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Error cases & security
  it('rejects custom schema with forbidden network $ref', () => {
    expect(() => {
      ExtractAction.validateInput({
        type: 'custom',
        text: 'test',
        schema: {
          $ref: 'https://evil.com/schema.json',
        },
      });
    }).toThrow(/Network \$ref references are forbidden/);
  });

  it('rejects custom schema exceeding depth limit', () => {
    expect(() => {
      ExtractAction.validateInput({
        type: 'custom',
        text: 'test',
        schema: {
          properties: {
            l1: {
              properties: {
                l2: {
                  properties: {
                    l3: {
                      properties: {
                        l4: {
                          properties: {
                            l5: {
                              properties: {
                                l6: { type: 'string' },
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
        },
      });
    }).toThrow(/Schema nesting exceeds maximum allowed depth/);
  });

  it('fails if provider returns malformed JSON string', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-bad',
      status: 'SUCCESS',
      data: null,
      rawText: 'this is not valid json {{{',
    };

    const input = ExtractAction.validateInput({
      type: 'invoice',
      text: 'some invoice text',
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);

    await expect(
      ExtractAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/Provider returned malformed JSON/);
  });

  it('fails if extracted invoice data is missing mandatory properties', () => {
    expect(() => {
      ExtractAction.validateExtractedStructure('invoice', { randomField: 'nothing relevant' });
    }).toThrow(/Extracted invoice missing essential properties/);
  });

  // Tail preservation test
  it('preserves complete text beyond 4,000 chars ensuring tail content is not silently truncated', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-tail',
      status: 'SUCCESS',
      data: {
        supplier: { name: 'Acme Corp', taxId: 'TAX-999' },
        buyer: { name: 'Beta Ltd' },
        invoiceNumber: 'INV-TAIL-99',
        total: 5000,
      },
    };

    const prefix = 'Header invoice info... '.padEnd(4500, '.');
    const tail = 'TAIL_IMPORTANT_INVOICE_CLAUSE_XYZ';
    const longText = `${prefix}\n${tail}`;

    const input = ExtractAction.validateInput({
      type: 'invoice',
      text: longText,
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    await ExtractAction.executeRecipe(ctx, recipe, input, sources);

    expect(ctx.connectorInvocations.length).toBe(1);
    const payload = ctx.connectorInvocations[0]!.payload as { payload: { documentSnippet: string } };
    expect(payload.payload.documentSnippet).toContain(tail);
  });

  // Explicit size rejection test
  it('explicitly rejects oversized documents exceeding 50,000 characters', async () => {
    const hugeText = 'E'.repeat(50001);
    const input = ExtractAction.validateInput({
      type: 'invoice',
      text: hugeText,
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);

    await expect(
      ExtractAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/exceeds maximum supported size for extraction/);
  });

  // Response marker survival and artifact contract regression test (W22-A)
  it('preserves provider revision marker and custom metadata through extraction mapping into result envelope', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-marker',
      status: 'SUCCESS',
      data: {
        supplier: { name: 'Acme Revision Corp', taxId: 'TAX-REV2' },
        buyer: { name: 'Dugate Gateway Inc' },
        invoiceNumber: 'INV-2026-REV2',
        revisionMarker: 'connector-rev-2',
        total: 4200,
        subtotal: 4200,
        currency: 'USD',
      },
    };

    const input = ExtractAction.validateInput({
      type: 'invoice',
      text: 'Invoice INV-2026-REV2 Total $4200 under connector revision 2',
    });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    const result = (await ExtractAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = ExtractAction.validateResult(result, input.type);
    const envelope = ExtractAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_extraction');
    expect(envelope.provenance.modelSlot).toBe('reasoning');

    // Verify semantic fields survive mapping and validation intact
    const data = envelope.data as Record<string, unknown>;
    expect(data.invoiceNumber).toBe('INV-2026-REV2');
    expect(data.revisionMarker).toBe('connector-rev-2');
    expect(data.total).toBe(4200);
  });
});
