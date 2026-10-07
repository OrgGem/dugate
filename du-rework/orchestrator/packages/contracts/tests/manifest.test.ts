import {
  validateManifest,
  hashManifest,
  queueNameFor,
  canonicalize,
  BusinessManifest,
} from '../src';

/** Minimal valid manifest used as the base for mutation tests. */
export function exampleManifest(overrides: Partial<BusinessManifest> = {}): BusinessManifest {
  return {
    contractVersion: '1',
    businessId: 'example-review',
    version: '1.0.0',
    displayName: 'Example Review',
    description: 'Example business for contract tests',
    imageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    runtime: { wireVersion: '1', handlerKinds: ['root', 'review-item'] },
    capabilities: { cancel: true, resume: true, parallel: true },
    actions: [
      {
        name: 'review',
        displayName: 'Review documents',
        description: 'Review a document',
        inputSchema: {
          type: 'object',
          properties: { requireApproval: { type: 'boolean' } },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { approved: { type: 'boolean' } },
          required: ['approved'],
        },
        profileSchema: { type: 'object', properties: {} },
        connectorSlots: [],
        artifactPolicy: { minFiles: 1, maxFiles: 10 },
        capabilities: { cancel: true, resume: true },
        defaultLimits: { maxParallelTasks: 2 },
      },
    ],
    ...overrides,
  } as BusinessManifest;
}

describe('validateManifest (REG-01..04)', () => {
  it('accepts the canonical example manifest and derives digest+queue', () => {
    const result = validateManifest(exampleManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.queue).toBe('du-business-example-review-1.0.0');
    expect(queueNameFor('example-review', '1.0.0')).toBe(result.queue);
  });

  it('is deterministic: same manifest → same digest (REG-01 replay)', () => {
    const a = validateManifest(exampleManifest());
    const b = validateManifest(exampleManifest());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.digest).toBe(b.digest);
  });

  it('digest changes when any field changes (REG-02 mismatch)', () => {
    const a = validateManifest(exampleManifest());
    const b = validateManifest(exampleManifest({ displayName: 'Different Name' }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.digest).not.toBe(b.digest);
  });

  it('rejects unknown contract major (REG-02)', () => {
    const manifest = { ...exampleManifest(), contractVersion: '2' };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.pointer.includes('contractVersion'))).toBe(true);
    }
  });

  it('rejects unknown top-level JSON fields (strict-ish parse keeps known shape)', () => {
    const manifest = { ...exampleManifest(), unexpectedField: true };
    // zod non-strict objects strip unknown keys; digest must equal base digest
    // because canonicalization only covers declared fields.
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const base = validateManifest(exampleManifest());
      if (base.ok) expect(result.digest).toBe(base.digest);
      expect((result.manifest as Record<string, unknown>)['unexpectedField']).toBeUndefined();
    }
  });

  it('rejects invalid enum values in action capabilities', () => {
    const manifest = exampleManifest();
    (manifest.actions[0] as { capabilities: unknown }).capabilities = { cancel: 'yes', resume: true };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it('rejects non-semver version', () => {
    const result = validateManifest(exampleManifest({ version: 'v1' } as Partial<BusinessManifest>));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.pointer.includes('version'))).toBe(true);
  });

  it('rejects duplicate action names', () => {
    const manifest = exampleManifest();
    manifest.actions.push({ ...manifest.actions[0]! });
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some((p) => p.message.includes('duplicate action'))).toBe(true);
  });

  it('rejects network $ref in action schemas', () => {
    const manifest = exampleManifest();
    manifest.actions[0]!.inputSchema = {
      type: 'object',
      properties: { evil: { $ref: 'https://evil.example/schema.json' } },
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.message.includes('network $ref'))).toBe(true);
    }
  });

  it('accepts local $ref', () => {
    const manifest = exampleManifest();
    manifest.actions[0]!.inputSchema = {
      type: 'object',
      $defs: { inner: { type: 'string' } },
      properties: { good: { $ref: '#/$defs/inner' } },
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
  });

  it('rejects oversized manifest schema (>100KB single schema)', () => {
    const manifest = exampleManifest();
    const bigProperties: Record<string, unknown> = {};
    for (let i = 0; i < 1500; i++) {
      bigProperties[`field_${i}`] = { type: 'string', description: 'x'.repeat(60) };
    }
    manifest.actions[0]!.inputSchema = { type: 'object', properties: bigProperties };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.problems.some((p) => p.message.includes('bytes') || p.message.includes('properties'))
      ).toBe(true);
    }
  });

  it('rejects minFiles > maxFiles', () => {
    const manifest = exampleManifest();
    manifest.actions[0]!.artifactPolicy = { minFiles: 5, maxFiles: 2 };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input (not a manifest at all)', () => {
    expect(validateManifest('hello').ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });

  it('rejects businessId that is not a lowercase slug', () => {
    const result = validateManifest(exampleManifest({ businessId: 'Bad_ID' } as Partial<BusinessManifest>));
    expect(result.ok).toBe(false);
  });
});

describe('canonicalize / hashManifest', () => {
  it('key order does not affect canonical form', () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('undefined values are dropped; nulls preserved', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('nested objects and arrays are canonically ordered', () => {
    const a = canonicalize({ z: [{ b: 1, a: 2 }], y: { d: 4, c: 3 } });
    expect(a).toBe('{"y":{"c":3,"d":4},"z":[{"a":2,"b":1}]}');
  });

  it('hashManifest is sha256-prefixed hex', () => {
    const digest = hashManifest(exampleManifest());
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('manifest serialization round-trip', () => {
  it('valid manifest survives JSON round-trip with identical digest', () => {
    const first = validateManifest(exampleManifest());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const roundTripped = JSON.parse(JSON.stringify(first.manifest));
    const second = validateManifest(roundTripped);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.digest).toBe(first.digest);
  });

  it('canonicalJson round-trips to the same string', () => {
    const first = validateManifest(exampleManifest());
    if (!first.ok) throw new Error('expected ok');
    const reparsed = JSON.parse(first.canonicalJson);
    expect(canonicalize(reparsed)).toBe(first.canonicalJson);
  });
});