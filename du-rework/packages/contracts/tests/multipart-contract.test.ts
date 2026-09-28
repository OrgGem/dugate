import {
  ArtifactFinalizeRequestSchema,
  ArtifactUploadGrantRequestSchema,
  MULTIPART_FIXED_PART_BYTES,
  MULTIPART_MAX_TOTAL_BYTES,
  MULTIPART_MIN_TOTAL_BYTES,
  MultipartAbortAckSchema,
  MultipartAbortRequestSchema,
  MultipartCompleteAckSchema,
  MultipartCompleteRequestSchema,
  MultipartInitAckSchema,
  MultipartInitRequestSchema,
  MultipartPartGrantRequestSchema,
  MultipartPartGrantSchema,
  MultipartPartReceiptSchema,
} from '../src/runtime';

/**
 * DATA-00-M multipart contract tests (Qwen-4, cycle 138) — offline, zero DB/Redis.
 * Positive: every request/ack parses with its documented defaults.
 * Negative: lease fence, token/uuid/sha shapes, part geometry bounds, committed
 * literal, and reason enum ALL fail closed. Coverage/etags cross-checks are
 * server-side guards by design and are NOT expressible per-request — pinned here
 * as documented non-guards so the split stays reviewable.
 * Regression: the existing single-PUT schemas must keep parsing unchanged.
 */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const TOKEN = '3f0c6f1e-9a2b-4c8d-8f1a-2b3c4d5e6f70';

const VALID_INIT = {
  leaseEpoch: 1,
  uploadToken: TOKEN,
  purpose: 'output' as const,
  mimeType: 'application/pdf',
  sizeBytes: MULTIPART_MIN_TOTAL_BYTES,
};
const VALID_INIT_ACK = {
  artifactId: TOKEN,
  uploadHandle: 'mh_5f2a',
  partSizeBytes: MULTIPART_FIXED_PART_BYTES,
  partCount: 9,
  expiresAt: '2026-09-26T00:00:00.000Z',
};
const VALID_RECEIPT = { partNumber: 1, etag: '"735f3a4a"', sizeBytes: 8 * 1024 * 1024, sha256: SHA_A };

describe('MultipartInitRequestSchema', () => {
  it('parses the minimal valid request', () => {
    expect(MultipartInitRequestSchema.safeParse(VALID_INIT).success).toBe(true);
  });
  it('accepts an optional fileName and rejects an empty one', () => {
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, fileName: 'big.pdf' }).success).toBe(true);
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, fileName: '' }).success).toBe(false);
  });
  it('requires a uuid uploadToken', () => {
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, uploadToken: 'not-a-uuid' }).success).toBe(false);
    const { uploadToken, ...rest } = VALID_INIT;
    void uploadToken;
    expect(MultipartInitRequestSchema.safeParse(rest).success).toBe(false);
  });
  it('fences on leaseEpoch >= 1 like every lease-bound request', () => {
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, leaseEpoch: 0 }).success).toBe(false);
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, leaseEpoch: 1 }).success).toBe(true);
    const { leaseEpoch, ...rest } = VALID_INIT;
    void leaseEpoch;
    expect(MultipartInitRequestSchema.safeParse(rest).success).toBe(false);
  });
  it('keeps purpose inside the shared artifact enum', () => {
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, purpose: 'artifact' }).success).toBe(false);
    for (const p of ['input', 'output', 'intermediate', 'session']) {
      expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, purpose: p }).success).toBe(true);
    }
  });
  it('rejects sizes at/below the single-PUT floor and above the wire ceiling', () => {
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, sizeBytes: MULTIPART_MIN_TOTAL_BYTES - 1 }).success).toBe(false);
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, sizeBytes: MULTIPART_MIN_TOTAL_BYTES }).success).toBe(true);
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, sizeBytes: MULTIPART_MAX_TOTAL_BYTES }).success).toBe(true);
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, sizeBytes: MULTIPART_MAX_TOTAL_BYTES + 1 }).success).toBe(false);
  });
  it('rejects non-integer and negative sizeBytes', () => {
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, sizeBytes: MULTIPART_MIN_TOTAL_BYTES + 0.5 }).success).toBe(false);
    expect(MultipartInitRequestSchema.safeParse({ ...VALID_INIT, sizeBytes: -1 }).success).toBe(false);
  });
});

describe('MultipartInitAckSchema', () => {
  it('parses and defaults replayed to false', () => {
    const parsed = MultipartInitAckSchema.parse(VALID_INIT_ACK);
    expect(parsed.replayed).toBe(false);
  });
  it('surfaces replay responses verbatim', () => {
    expect(MultipartInitAckSchema.parse({ ...VALID_INIT_ACK, replayed: true }).replayed).toBe(true);
  });
  it('rejects a client-chosen smaller part geometry', () => {
    expect(MultipartInitAckSchema.safeParse({ ...VALID_INIT_ACK, partSizeBytes: MULTIPART_FIXED_PART_BYTES - 1 }).success).toBe(false);
  });
  it('rejects partCount outside 1..10000 and a non-uuid artifactId', () => {
    expect(MultipartInitAckSchema.safeParse({ ...VALID_INIT_ACK, partCount: 0 }).success).toBe(false);
    expect(MultipartInitAckSchema.safeParse({ ...VALID_INIT_ACK, partCount: 10_001 }).success).toBe(false);
    expect(MultipartInitAckSchema.safeParse({ ...VALID_INIT_ACK, artifactId: 'x' }).success).toBe(false);
  });
});

describe('MultipartPartGrantRequestSchema', () => {
  const VALID = { leaseEpoch: 2, partNumber: 1, sha256: SHA_A };
  it('parses a valid part grant request', () => {
    expect(MultipartPartGrantRequestSchema.safeParse(VALID).success).toBe(true);
  });
  it('pins sha256 to 64 lowercase hex — uppercase/partial/non-hex fail', () => {
    expect(MultipartPartGrantRequestSchema.safeParse({ ...VALID, sha256: SHA_A.toUpperCase() }).success).toBe(false);
    expect(MultipartPartGrantRequestSchema.safeParse({ ...VALID, sha256: 'a'.repeat(63) }).success).toBe(false);
    expect(MultipartPartGrantRequestSchema.safeParse({ ...VALID, sha256: 'g'.repeat(64) }).success).toBe(false);
    expect(MultipartPartGrantRequestSchema.safeParse({ partNumber: 1, leaseEpoch: 2 }).success).toBe(false);
  });
  it('holds partNumber to the S3 1..10000 integer window', () => {
    expect(MultipartPartGrantRequestSchema.safeParse({ ...VALID, partNumber: 0 }).success).toBe(false);
    expect(MultipartPartGrantRequestSchema.safeParse({ ...VALID, partNumber: 10_001 }).success).toBe(false);
    expect(MultipartPartGrantRequestSchema.safeParse({ ...VALID, partNumber: 2.5 }).success).toBe(false);
    expect(MultipartPartGrantRequestSchema.safeParse({ ...VALID, partNumber: 10_000 }).success).toBe(true);
  });
  it('requires the lease fence', () => {
    const { leaseEpoch, ...rest } = VALID;
    void leaseEpoch;
    expect(MultipartPartGrantRequestSchema.safeParse(rest).success).toBe(false);
  });
});

describe('MultipartPartGrantSchema (response)', () => {
  const VALID = {
    artifactId: TOKEN,
    partNumber: 3,
    partUrl: 'https://private-bucket.example/art-3?part=3&sig=x',
    sizeBytes: 8 * 1024 * 1024,
    requiredHeaders: { 'content-length': '8388608', 'x-amz-checksum-sha256': 'ZGVhZGJlZWY=' },
    expiresAt: '2026-09-25T06:00:00.000Z',
  };
  it('parses a server-fixed grant', () => {
    expect(MultipartPartGrantSchema.safeParse(VALID).success).toBe(true);
  });
  it('refuses a non-URL partUrl and a zero-size part', () => {
    expect(MultipartPartGrantSchema.safeParse({ ...VALID, partUrl: '/relative/only' }).success).toBe(false);
    expect(MultipartPartGrantSchema.safeParse({ ...VALID, sizeBytes: 0 }).success).toBe(false);
  });
  it('keeps requiredHeaders a flat string map (typed header values fail)', () => {
    expect(MultipartPartGrantSchema.safeParse({ ...VALID, requiredHeaders: { 'content-length': 8 } }).success).toBe(false);
  });
});

describe('MultipartPartReceiptSchema', () => {
  it('parses an etag+hash receipt', () => {
    expect(MultipartPartReceiptSchema.safeParse(VALID_RECEIPT).success).toBe(true);
  });
  it('rejects empty/oversized etag, zero size, missing hash', () => {
    expect(MultipartPartReceiptSchema.safeParse({ ...VALID_RECEIPT, etag: '' }).success).toBe(false);
    expect(MultipartPartReceiptSchema.safeParse({ ...VALID_RECEIPT, etag: 'e'.repeat(257) }).success).toBe(false);
    expect(MultipartPartReceiptSchema.safeParse({ ...VALID_RECEIPT, sizeBytes: 0 }).success).toBe(false);
    const { sha256, ...rest } = VALID_RECEIPT;
    void sha256;
    expect(MultipartPartReceiptSchema.safeParse(rest).success).toBe(false);
  });
});

describe('MultipartCompleteRequestSchema', () => {
  const VALID = { leaseEpoch: 4, parts: [VALID_RECEIPT], sha256: SHA_B };
  it('parses a two-part complete', () => {
    expect(MultipartCompleteRequestSchema.safeParse({
      ...VALID,
      parts: [VALID_RECEIPT, { ...VALID_RECEIPT, partNumber: 2, sha256: SHA_B }],
    }).success).toBe(true);
  });
  it('rejects an empty parts list and a list beyond MAX_PARTS', () => {
    expect(MultipartCompleteRequestSchema.safeParse({ ...VALID, parts: [] }).success).toBe(false);
    const many = Array.from({ length: 10_001 }, (_, i) => ({
      ...VALID_RECEIPT, partNumber: (i % 10_000) + 1,
    }));
    expect(MultipartCompleteRequestSchema.safeParse({ ...VALID, parts: many }).success).toBe(false);
  });
  it('requires the whole-object sha256 and the lease fence', () => {
    const { sha256, ...rest } = VALID;
    void sha256;
    expect(MultipartCompleteRequestSchema.safeParse(rest).success).toBe(false);
    const { leaseEpoch, ...noLease } = VALID;
    void leaseEpoch;
    expect(MultipartCompleteRequestSchema.safeParse(noLease).success).toBe(false);
  });
  it('DOCUMENTED NON-GUARD: coverage 1..partCount / duplicates are server-side (409 PART_SET_MISMATCH)', () => {
    // Wire shape cannot see partCount; a duplicated/gapped list must PARSE and be
    // refused by the route after the ListParts cross-check. Pinning this split.
    expect(MultipartCompleteRequestSchema.safeParse({
      ...VALID, parts: [VALID_RECEIPT, { ...VALID_RECEIPT, etag: 'other' }],
    }).success).toBe(true);
  });
});

describe('MultipartCompleteAckSchema', () => {
  const VALID = { artifactId: TOKEN, sizeBytes: MULTIPART_MIN_TOTAL_BYTES, sha256: SHA_B, committed: true };
  it('parses and defaults replayed to false', () => {
    expect(MultipartCompleteAckSchema.parse(VALID).replayed).toBe(false);
  });
  it('committed is a literal true — false/missing fail closed', () => {
    expect(MultipartCompleteAckSchema.safeParse({ ...VALID, committed: false }).success).toBe(false);
    const { committed, ...rest } = VALID;
    void committed;
    expect(MultipartCompleteAckSchema.safeParse(rest).success).toBe(false);
  });
});

describe('MultipartAbort lifecycle', () => {
  it('applies the default reason', () => {
    expect(MultipartAbortRequestSchema.parse({ leaseEpoch: 2 }).reason).toBe('cancelled');
  });
  it('accepts every policy reason and refuses unknown ones', () => {
    for (const reason of ['cancelled', 'superseded', 'failed']) {
      expect(MultipartAbortRequestSchema.safeParse({ leaseEpoch: 2, reason }).success).toBe(true);
    }
    expect(MultipartAbortRequestSchema.safeParse({ leaseEpoch: 2, reason: 'oops' }).success).toBe(false);
  });
  it('abort ack is terminal-ABORTED only', () => {
    expect(MultipartAbortAckSchema.safeParse({ artifactId: TOKEN, state: 'ABORTED' }).success).toBe(true);
    expect(MultipartAbortAckSchema.safeParse({ artifactId: TOKEN, state: 'READY' }).success).toBe(false);
  });
});

describe('single-PUT regression — pre-existing schemas unchanged', () => {
  it('upload grant + finalize still parse with the old bounds', () => {
    expect(ArtifactUploadGrantRequestSchema.safeParse({
      leaseEpoch: 1, purpose: 'output', mimeType: 'text/markdown', sizeBytes: 1024,
    }).success).toBe(true);
    expect(ArtifactFinalizeRequestSchema.safeParse({
      leaseEpoch: 1, taskId: TOKEN, sizeBytes: 1024, sha256: SHA_A,
    }).success).toBe(true);
    // 64 MiB is still grantable on the single-PUT path — the multipart floor
    // deliberately lives ONE byte above the current single-PUT cap.
    expect(ArtifactUploadGrantRequestSchema.safeParse({
      leaseEpoch: 1, purpose: 'output', mimeType: 'application/pdf',
      sizeBytes: 64 * 1024 * 1024,
    }).success).toBe(true);
  });
  it('finalize keeps rejecting uppercase/partial hashes (no accidental loosening)', () => {
    const base = { leaseEpoch: 1, taskId: TOKEN, sizeBytes: 1024 };
    expect(ArtifactFinalizeRequestSchema.safeParse({ ...base, sha256: SHA_A.toUpperCase() }).success).toBe(false);
    expect(ArtifactFinalizeRequestSchema.safeParse({ ...base, sha256: 'a'.repeat(63) }).success).toBe(false);
  });
});
