import { createHash } from 'node:crypto';

/**
 * Deterministic Synthetic Document Fixture Generator (P1-05)
 *
 * Produces structured synthetic documents for all core document understanding actions
 * (extract, analyze, compare, transform, ingest, generate) without external AI costs.
 */

export interface SyntheticInvoice {
  rawText: string;
  data: {
    invoiceNumber: string;
    invoiceDate: string;
    supplier: { name: string; taxId: string };
    buyer: { name: string };
    lineItems: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
    subtotal: number;
    tax: number;
    total: number;
    currency: string;
  };
  hashSha256: string;
}

export interface SyntheticContractPair {
  contractV1: { title: string; clauses: string[]; rawText: string };
  contractV2: { title: string; clauses: string[]; rawText: string };
  diffExpectations: {
    addedClauses: string[];
    removedClauses: string[];
    modifiedClauses: Array<{ original: string; updated: string }>;
  };
}

export interface SyntheticPolicy {
  rawText: string;
  sections: Array<{ heading: string; body: string; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' }>;
  expectedRisks: Array<{ section: string; level: 'LOW' | 'MEDIUM' | 'HIGH' }>;
}

/**
 * Generates a deterministic synthetic invoice.
 */
export function generateSyntheticInvoice(seed = 1001): SyntheticInvoice {
  const invoiceNumber = `INV-SYN-${seed}`;
  const date = '2026-09-23';
  const supplierName = `Synthetic Supplier Corp #${seed % 50}`;
  const buyerName = `Enterprise Customer LLC #${(seed * 7) % 30}`;

  const lineItems = [
    { description: 'Cloud Infrastructure Hosting', quantity: 2, unitPrice: 500, amount: 1000 },
    { description: 'Document Gateway OCR Processing', quantity: 100, unitPrice: 2, amount: 200 },
    { description: 'API Maintenance Support Tier 1', quantity: 1, unitPrice: 300, amount: 300 },
  ];

  const subtotal = lineItems.reduce((acc, item) => acc + item.amount, 0);
  const tax = Math.round(subtotal * 0.1);
  const total = subtotal + tax;

  const rawText = [
    `INVOICE: ${invoiceNumber}`,
    `Date: ${date}`,
    `Supplier: ${supplierName} (Tax ID: US-${seed}-999)`,
    `Buyer: ${buyerName}`,
    'Items:',
    ...lineItems.map((item) => `- ${item.description}: ${item.quantity} x $${item.unitPrice} = $${item.amount}`),
    `Subtotal: $${subtotal}`,
    `Tax: $${tax}`,
    `Total: $${total} USD`,
  ].join('\n');

  const hashSha256 = createHash('sha256').update(rawText).digest('hex');

  return {
    rawText,
    data: {
      invoiceNumber,
      invoiceDate: date,
      supplier: { name: supplierName, taxId: `US-${seed}-999` },
      buyer: { name: buyerName },
      lineItems,
      subtotal,
      tax,
      total,
      currency: 'USD',
    },
    hashSha256,
  };
}

/**
 * Generates a deterministic contract pair with known diffs for `/compare` tests.
 */
export function generateSyntheticContractPair(): SyntheticContractPair {
  const v1Clauses = [
    'Clause 1: Scope of Services and Platform Gateway Access.',
    'Clause 2: Payment terms shall be net 30 days from invoice date.',
    'Clause 3: Standard SLA availability target is 99.5% uptime.',
    'Clause 4: Term and termination upon 30 days written notice.',
  ];

  const v2Clauses = [
    'Clause 1: Scope of Services and Platform Gateway Access.',
    'Clause 2: Payment terms shall be net 45 days from invoice date.', // Modified
    'Clause 3: Standard SLA availability target is 99.5% uptime.',
    'Clause 5: Security and Confidentiality Obligations under ISO-27001.', // Added
    // Clause 4 removed
  ];

  return {
    contractV1: {
      title: 'Master Services Agreement v1.0',
      clauses: v1Clauses,
      rawText: ['Master Services Agreement v1.0', ...v1Clauses].join('\n\n'),
    },
    contractV2: {
      title: 'Master Services Agreement v2.0',
      clauses: v2Clauses,
      rawText: ['Master Services Agreement v2.0', ...v2Clauses].join('\n\n'),
    },
    diffExpectations: {
      addedClauses: ['Clause 5: Security and Confidentiality Obligations under ISO-27001.'],
      removedClauses: ['Clause 4: Term and termination upon 30 days written notice.'],
      modifiedClauses: [
        {
          original: 'Clause 2: Payment terms shall be net 30 days from invoice date.',
          updated: 'Clause 2: Payment terms shall be net 45 days from invoice date.',
        },
      ],
    },
  };
}

/**
 * Generates synthetic policy text with known risk ratings for `/analyze` tests.
 */
export function generateSyntheticPolicy(): SyntheticPolicy {
  const sections = [
    {
      heading: '1. Access Control',
      body: 'All administrative accounts must use hardware security tokens and multifactor authentication.',
      riskLevel: 'LOW' as const,
    },
    {
      heading: '2. Data Retention & Destruction',
      body: 'Customer sensitive documents are retained indefinitely on unencrypted staging disks.',
      riskLevel: 'HIGH' as const,
    },
    {
      heading: '3. Incident Response',
      body: 'Security incidents are reviewed on a quarterly best-effort schedule.',
      riskLevel: 'MEDIUM' as const,
    },
  ];

  const rawText = sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n');
  const expectedRisks = sections.map((s) => ({ section: s.heading, level: s.riskLevel }));

  return { rawText, sections, expectedRisks };
}

/**
 * Generates bounded-length synthetic text payloads to test parser budget boundaries.
 */
export function generateBoundedInput(sizeBytes: number, fillChar = 'A'): string {
  if (sizeBytes <= 0) return '';
  return fillChar.repeat(sizeBytes);
}

/**
 * Generates deterministic structured markdown paragraphs for `/transform` tests.
 */
export function generateSyntheticMarkdown(paragraphs = 5, wordsPerParagraph = 40): string {
  const dictionary = ['document', 'understanding', 'gateway', 'pipeline', 'runtime', 'worker', 'checkpoint', 'schema', 'ledger', 'token'];
  const result: string[] = [];

  for (let p = 0; p < paragraphs; p++) {
    const words: string[] = [];
    for (let w = 0; w < wordsPerParagraph; w++) {
      words.push(dictionary[(p * wordsPerParagraph + w) % dictionary.length]!);
    }
    result.push(`### Section ${p + 1}\n\n${words.join(' ')}.`);
  }

  return result.join('\n\n');
}
