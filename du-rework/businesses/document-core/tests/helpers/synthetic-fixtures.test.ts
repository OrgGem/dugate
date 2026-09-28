import {
  generateSyntheticInvoice,
  generateSyntheticContractPair,
  generateSyntheticPolicy,
  generateBoundedInput,
  generateSyntheticMarkdown,
} from './synthetic-fixtures';

describe('P1-05: Deterministic Synthetic Document Fixtures', () => {
  test('generateSyntheticInvoice produces valid, repeatable invoice data and text', () => {
    const inv1 = generateSyntheticInvoice(1001);
    const inv2 = generateSyntheticInvoice(1001);

    expect(inv1.data.invoiceNumber).toBe('INV-SYN-1001');
    expect(inv1.data.total).toBe(inv1.data.subtotal + inv1.data.tax);
    expect(inv1.rawText).toContain('INVOICE: INV-SYN-1001');
    expect(inv1.hashSha256).toBe(inv2.hashSha256); // Determinism
  });

  test('generateSyntheticContractPair generates structured diff expectations', () => {
    const pair = generateSyntheticContractPair();

    expect(pair.contractV1.clauses.length).toBe(4);
    expect(pair.contractV2.clauses.length).toBe(4);
    expect(pair.diffExpectations.addedClauses).toHaveLength(1);
    expect(pair.diffExpectations.removedClauses).toHaveLength(1);
    expect(pair.diffExpectations.modifiedClauses).toHaveLength(1);
  });

  test('generateSyntheticPolicy produces seeded risk levels', () => {
    const policy = generateSyntheticPolicy();

    expect(policy.sections.length).toBe(3);
    expect(policy.expectedRisks).toContainEqual({ section: '2. Data Retention & Destruction', level: 'HIGH' });
    expect(policy.rawText).toContain('## 1. Access Control');
  });

  test('generateBoundedInput produces exact byte lengths', () => {
    expect(Buffer.byteLength(generateBoundedInput(1000))).toBe(1000);
    expect(Buffer.byteLength(generateBoundedInput(1024 * 50))).toBe(51200);
  });

  test('generateSyntheticMarkdown generates requested paragraph count', () => {
    const md = generateSyntheticMarkdown(3, 20);
    expect(md).toContain('### Section 1');
    expect(md).toContain('### Section 2');
    expect(md).toContain('### Section 3');
  });
});
