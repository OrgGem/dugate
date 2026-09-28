import {
  parseReviewInput,
  parseChildReviewInput,
  parseApprovalResponse,
} from '../src/review';

describe('Input Validation & Strict 1..10 Artifact Schema (P7-01 / A07-04)', () => {
  const validArtifact = { artifactId: 'art-1', fileName: 'doc1.pdf' };

  it('accepts valid 1..10 artifact input specifications', () => {
    // 1 artifact
    const one = parseReviewInput({
      reviewId: 'rev-01',
      artifacts: [validArtifact],
    });
    expect(one.artifacts).toHaveLength(1);
    expect(one.reviewId).toBe('rev-01');

    // 5 artifacts
    const five = parseReviewInput({
      reviewId: 'rev-05',
      artifacts: Array.from({ length: 5 }, (_, i) => ({
        artifactId: `art-${i}`,
        fileName: `file-${i}.json`,
      })),
      checks: { 'check-a': true, 'check-b': false },
      requireApproval: true,
      enableReasoning: true,
    });
    expect(five.artifacts).toHaveLength(5);
    expect(five.checks).toEqual({ 'check-a': true, 'check-b': false });
    expect(five.requireApproval).toBe(true);
    expect(five.enableReasoning).toBe(true);

    // 10 artifacts (max boundary)
    const ten = parseReviewInput({
      reviewId: 'rev-10',
      artifacts: Array.from({ length: 10 }, (_, i) => ({
        artifactId: `art-${i}`,
      })),
    });
    expect(ten.artifacts).toHaveLength(10);
  });

  it('rejects caller-supplied childReviews to prevent bypassing review (A07-01 / A07-04)', () => {
    expect(() =>
      parseReviewInput({
        reviewId: 'rev-bypass',
        artifacts: [validArtifact],
        childReviews: [{ passed: true }],
      })
    ).toThrow(/childReviews cannot be supplied by client; document review cannot be bypassed/);
  });

  it('rejects unexpected caller-supplied properties and invalid booleans (A07-04)', () => {
    // Unexpected property
    expect(() =>
      parseReviewInput({
        reviewId: 'rev-1',
        artifacts: [validArtifact],
        unknownField: 'malicious-payload',
      })
    ).toThrow(/Unexpected input property: unknownField/);

    // Malformed boolean requireApproval ('false' string or number)
    expect(() =>
      parseReviewInput({
        reviewId: 'rev-1',
        artifacts: [validArtifact],
        requireApproval: 'false' as unknown as boolean,
      })
    ).toThrow(/requireApproval must be a boolean/);

    // Malformed boolean enableReasoning
    expect(() =>
      parseReviewInput({
        reviewId: 'rev-1',
        artifacts: [validArtifact],
        enableReasoning: 1 as unknown as boolean,
      })
    ).toThrow(/enableReasoning must be a boolean/);
  });

  it('rejects missing, empty, or oversized reviewId', () => {
    expect(() => parseReviewInput({ artifacts: [validArtifact] })).toThrow(/reviewId must be a non-empty string/);
    expect(() => parseReviewInput({ reviewId: '   ', artifacts: [validArtifact] })).toThrow(/reviewId must be a non-empty string/);
    expect(() => parseReviewInput({ reviewId: 'a'.repeat(129), artifacts: [validArtifact] })).toThrow(/at most 128 characters/);
  });

  it('rejects input with empty artifacts array (min boundary violation)', () => {
    expect(() => parseReviewInput({ reviewId: 'rev-zero', artifacts: [] })).toThrow(
      /artifacts array must contain between 1 and 10 items/
    );
  });

  it('rejects input with more than 10 artifacts (max boundary violation)', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ artifactId: `art-${i}` }));
    expect(() => parseReviewInput({ reviewId: 'rev-eleven', artifacts: eleven })).toThrow(
      /artifacts array must contain between 1 and 10 items/
    );
  });

  it('rejects artifacts missing valid artifactId', () => {
    expect(() => parseReviewInput({ reviewId: 'rev-bad-art', artifacts: [{ fileName: 'no-id.txt' }] })).toThrow(
      /must have a non-empty string artifactId/
    );
    expect(() => parseReviewInput({ reviewId: 'rev-bad-art', artifacts: [{ artifactId: '' }] })).toThrow(
      /must have a non-empty string artifactId/
    );
  });

  it('rejects invalid checks structure', () => {
    expect(() =>
      parseReviewInput({
        reviewId: 'rev-bad-checks',
        artifacts: [validArtifact],
        checks: { 'check-1': 'not-a-boolean' as unknown as boolean },
      })
    ).toThrow(/checks entries must have non-empty keys and boolean values/);
  });

  describe('parseChildReviewInput strict schema validation (Wave 19 / W19-A)', () => {
    it('accepts valid child review input for review-item handler', () => {
      const child = parseChildReviewInput({
        reviewId: 'rev-1',
        itemIndex: 0,
        artifact: validArtifact,
        checks: { test: true },
        enableReasoning: true,
      });
      expect(child.reviewId).toBe('rev-1');
      expect(child.itemIndex).toBe(0);
      expect(child.artifact.artifactId).toBe('art-1');
      expect(child.artifact.fileName).toBe('doc1.pdf');
      expect(child.enableReasoning).toBe(true);
    });

    it('accepts valid child review input without optional fileName and reasoning', () => {
      const child = parseChildReviewInput({
        reviewId: 'rev-2',
        itemIndex: 9, // Max valid index for 1..10 items
        artifact: { artifactId: 'art-9' },
      });
      expect(child.itemIndex).toBe(9);
      expect(child.artifact.fileName).toBeUndefined();
      expect(child.enableReasoning).toBe(false);
    });

    // Table-driven negative test cases for itemIndex coercion & boundary errors
    const invalidItemIndices: Array<{ description: string; val: unknown }> = [
      { description: 'null (Number(null) === 0)', val: null },
      { description: 'false (Number(false) === 0)', val: false },
      { description: 'true (Number(true) === 1)', val: true },
      { description: 'numeric string "0"', val: '0' },
      { description: 'numeric string "5"', val: '5' },
      { description: 'empty string "" (Number("") === 0)', val: '' },
      { description: 'whitespace string "   "', val: '   ' },
      { description: 'fractional float 1.5', val: 1.5 },
      { description: 'fractional float 0.1', val: 0.1 },
      { description: 'nonfinite NaN', val: NaN },
      { description: 'nonfinite Infinity', val: Infinity },
      { description: 'nonfinite -Infinity', val: -Infinity },
      { description: 'negative integer -1', val: -1 },
      { description: 'negative integer -10', val: -10 },
      { description: 'out of bounds integer 10 (parent artifacts bound is 1..10)', val: 10 },
      { description: 'out of bounds integer 99', val: 99 },
    ];

    test.each(invalidItemIndices)(
      'strictly rejects itemIndex: $description without coercion',
      ({ val }) => {
        expect(() =>
          parseChildReviewInput({
            reviewId: 'rev-1',
            itemIndex: val,
            artifact: validArtifact,
          } as unknown as Record<string, unknown>)
        ).toThrow(/itemIndex must be a non-negative integer/);
      }
    );

    // Table-driven negative test cases for artifact object validation
    const invalidArtifacts: Array<{ description: string; art: unknown; errRegex: RegExp }> = [
      { description: 'array artifact []', art: [], errRegex: /artifact must be a non-null object/ },
      { description: 'array artifact with items', art: [validArtifact], errRegex: /artifact must be a non-null object/ },
      { description: 'null artifact', art: null, errRegex: /artifact must be a non-null object/ },
      { description: 'primitive string', art: 'art-1', errRegex: /artifact must be a non-null object/ },
      { description: 'primitive number', art: 42, errRegex: /artifact must be a non-null object/ },
      { description: 'missing artifactId', art: {}, errRegex: /artifact\.artifactId must be a non-empty string/ },
      { description: 'empty artifactId ""', art: { artifactId: '' }, errRegex: /artifact\.artifactId must be a non-empty string/ },
      { description: 'whitespace artifactId "   "', art: { artifactId: '   ' }, errRegex: /artifact\.artifactId must be a non-empty string/ },
      { description: 'unexpected artifact property', art: { artifactId: 'art-1', rogueField: true }, errRegex: /Unexpected artifact property: rogueField/ },
    ];

    test.each(invalidArtifacts)(
      'strictly rejects invalid artifact: $description',
      ({ art, errRegex }) => {
        expect(() =>
          parseChildReviewInput({
            reviewId: 'rev-1',
            itemIndex: 0,
            artifact: art,
          } as unknown as Record<string, unknown>)
        ).toThrow(errRegex);
      }
    );

    // Table-driven negative test cases for fileName validation
    const invalidFileNames: Array<{ description: string; fileName: unknown }> = [
      { description: 'empty string ""', fileName: '' },
      { description: 'whitespace string "   "', fileName: '   ' },
      { description: 'numeric fileName 123', fileName: 123 },
      { description: 'boolean fileName false', fileName: false },
      { description: 'object fileName {}', fileName: {} },
      { description: 'array fileName []', fileName: [] },
    ];

    test.each(invalidFileNames)(
      'strictly rejects invalid artifact fileName: $description without silent discard',
      ({ fileName }) => {
        expect(() =>
          parseChildReviewInput({
            reviewId: 'rev-1',
            itemIndex: 0,
            artifact: { artifactId: 'art-1', fileName },
          } as unknown as Record<string, unknown>)
        ).toThrow(/artifact\.fileName must be a non-empty string if provided/);
      }
    );

    it('rejects unexpected child input properties', () => {
      expect(() =>
        parseChildReviewInput({
          reviewId: 'rev-1',
          itemIndex: 0,
          artifact: validArtifact,
          unauthorizedField: 'payload',
        } as unknown as Record<string, unknown>)
      ).toThrow(/Unexpected child input property: unauthorizedField/);
    });
  });

  describe('parseApprovalResponse strict validation (A07-04)', () => {
    it('strictly rejects non-boolean approved, including string "false" and numbers', () => {
      // String 'false' must not evaluate truthy
      expect(() => parseApprovalResponse({ approved: 'false' })).toThrow(/approval.approved must be a boolean/);
      expect(() => parseApprovalResponse({ approved: 'true' })).toThrow(/approval.approved must be a boolean/);
      expect(() => parseApprovalResponse({ approved: 0 })).toThrow(/approval.approved must be a boolean/);
      expect(() => parseApprovalResponse({ approved: null })).toThrow(/approval.approved must be a boolean/);
      expect(() => parseApprovalResponse('not-an-object')).toThrow(/must be a non-null object/);
    });

    it('rejects unexpected additional properties on approval response', () => {
      expect(() =>
        parseApprovalResponse({
          approved: true,
          extraField: 'unauthorized',
        })
      ).toThrow(/Unexpected approval property: extraField/);
    });

    it('accepts valid approval and rejection decisions', () => {
      const approved = parseApprovalResponse({
        approved: true,
        note: 'All criteria satisfied',
        approver: 'admin-1',
      });
      expect(approved.approved).toBe(true);
      expect(approved.note).toBe('All criteria satisfied');
      expect(approved.approver).toBe('admin-1');

      const rejected = parseApprovalResponse({
        approved: false,
        note: 'Missing signature',
      });
      expect(rejected.approved).toBe(false);
      expect(rejected.note).toBe('Missing signature');
    });
  });
});
