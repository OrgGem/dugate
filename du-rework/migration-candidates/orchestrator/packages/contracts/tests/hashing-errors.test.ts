import {
  canonicalRequestHash,
  normalizeRouteAction,
  contentHash,
  problem,
  ProblemSchema,
  STATUS_CODES,
} from '../src';

describe('canonical request hashing (docs 06 idempotency)', () => {
  const base = {
    input: { type: 'invoice', language: 'vi' },
    artifacts: [{ role: 'source', sha256: 'a'.repeat(64) }],
    output: { format: 'json' },
    callback: { url: 'https://client.example/cb' },
  };

  it('is stable for identical parts', () => {
    expect(canonicalRequestHash(base)).toBe(canonicalRequestHash({ ...base }));
  });

  it('key order in input does not change the hash', () => {
    const reordered = {
      ...base,
      input: { language: 'vi', type: 'invoice' },
    };
    expect(canonicalRequestHash(reordered)).toBe(canonicalRequestHash(base));
  });

  it('artifact order does not change the hash (sorted by role+hash)', () => {
    const two = {
      ...base,
      artifacts: [
        { role: 'source', sha256: 'a'.repeat(64) },
        { role: 'target', sha256: 'b'.repeat(64) },
      ],
    };
    const swapped = {
      ...base,
      artifacts: [
        { role: 'target', sha256: 'b'.repeat(64) },
        { role: 'source', sha256: 'a'.repeat(64) },
      ],
    };
    expect(canonicalRequestHash(two)).toBe(canonicalRequestHash(swapped));
  });

  it('different input → different hash (409 case)', () => {
    expect(canonicalRequestHash({ ...base, input: { type: 'contract' } })).not.toBe(
      canonicalRequestHash(base)
    );
  });

  it('different callback URL → different hash', () => {
    expect(canonicalRequestHash({ ...base, callback: { url: 'https://other.example/cb' } })).not.toBe(
      canonicalRequestHash(base)
    );
  });

  it('optional parts omitted behave like nulls', () => {
    const minimal = { input: { a: 1 } };
    const explicitNulls = { input: { a: 1 }, artifacts: [], output: null, callback: null };
    expect(canonicalRequestHash(minimal)).toBe(canonicalRequestHash(explicitNulls));
  });

  it('hash format is sha256-prefixed hex', () => {
    expect(canonicalRequestHash(base)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('route action normalization', () => {
  it('folds alias routes to the canonical route action', () => {
    // legacy /docs/extract facade and generic route share the idempotency scope
    expect(normalizeRouteAction('document-core', 'extract')).toBe('document-core/extract');
    expect(normalizeRouteAction('document-core', 'docs-extract', 'extract')).toBe(
      'document-core/extract'
    );
  });
});

describe('contentHash', () => {
  it('is deterministic and order-insensitive', () => {
    expect(contentHash({ b: 2, a: 1 })).toBe(contentHash({ a: 1, b: 2 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe('problem details (RFC 9457)', () => {
  it('builds a valid problem document', () => {
    const p = problem(STATUS_CODES.CONFLICT, 'IDEMPOTENCY_CONFLICT', 'Idempotency conflict', 'key reused with different body', {
      correlationId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      errors: [{ pointer: '/input/type', message: 'unknown enum value' }],
    });
    const parsed = ProblemSchema.safeParse(p);
    expect(parsed.success).toBe(true);
    expect(p.type).toBe('urn:du:error:idempotency_conflict');
    expect(p.status).toBe(409);
  });

  it('rejects invalid status codes', () => {
    const p = { ...problem(409, 'CONFLICT', 'x'), status: 200 };
    expect(ProblemSchema.safeParse(p).success).toBe(false);
  });
});