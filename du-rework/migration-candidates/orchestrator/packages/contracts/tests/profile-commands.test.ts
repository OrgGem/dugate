import {
  ApiKeyRefSchema,
  PROFILE_MUTATION_ACTIONS,
  ProfilePublishCommandSchema,
  ProfileRollbackCommandSchema,
  ProfileUpsertCommandSchema,
  ProfileUpsertParamsSchema,
} from '../src';

const KEY = {
  businessId: 'invoice',
  businessVersion: '1.0.0',
  profileName: 'extract.invoice',
  apiKey: { apiKeyId: '22222222-2222-4222-8222-222222222222' },
};
const HASH = 'a'.repeat(64);

describe('ApiKeyRefSchema (Δ7-A write identity)', () => {
  it('accepts a uuid apiKeyId arm', () => {
    expect(ApiKeyRefSchema.safeParse(KEY.apiKey).success).toBe(true);
  });

  it('accepts a 64-hex apiKeyHash arm (legacy bind-profile shape)', () => {
    expect(ApiKeyRefSchema.safeParse({ apiKeyHash: HASH }).success).toBe(true);
  });

  it('rejects both arms at once (strict arms plus exactly-one refine)', () => {
    expect(ApiKeyRefSchema.safeParse({ apiKeyId: KEY.apiKey.apiKeyId, apiKeyHash: HASH }).success).toBe(false);
  });

  it('rejects an empty ref, a malformed hash and a non-uuid id', () => {
    expect(ApiKeyRefSchema.safeParse({}).success).toBe(false);
    expect(ApiKeyRefSchema.safeParse({ apiKeyHash: 'ABC' }).success).toBe(false);
    expect(ApiKeyRefSchema.safeParse({ apiKeyId: 'key-1' }).success).toBe(false);
  });

  it('normalizes both wires to one tagged ref (Δ7-A transform, output shape)', () => {
    expect(ApiKeyRefSchema.parse(KEY.apiKey)).toEqual({ kind: 'id', id: KEY.apiKey.apiKeyId });
    expect(ApiKeyRefSchema.parse({ apiKeyHash: HASH })).toEqual({ kind: 'hash', hash: HASH });
  });

});

describe('profile mutation commands (T-API-02 wire, Δ7-A)', () => {
  it('upsert requires policy AND apiKey; a blind first save stays legal', () => {
    expect(ProfileUpsertCommandSchema.safeParse({ ...KEY, policy: {} }).success).toBe(true);
    expect(ProfileUpsertCommandSchema.safeParse(KEY).success).toBe(false);
    const noKey = { ...KEY } as Record<string, unknown>;
    delete noKey.apiKey;
    expect(ProfileUpsertCommandSchema.safeParse({ ...noKey, policy: {} }).success).toBe(false);
  });

  it('upsert carries an optional action override and rejects unknown keys (strict)', () => {
    expect(ProfileUpsertCommandSchema.safeParse({ ...KEY, action: 'extract', policy: {} }).success).toBe(true);
    expect(ProfileUpsertCommandSchema.safeParse({ ...KEY, policy: {}, extra: 1 }).success).toBe(false);
  });

  it('publish requires expectedRevision because it is a CAS move', () => {
    expect(ProfilePublishCommandSchema.safeParse(KEY).success).toBe(false);
    expect(ProfilePublishCommandSchema.safeParse({ ...KEY, expectedRevision: 2 }).success).toBe(true);
  });

  it('rollback requires targetRevision and keeps expectedRevision optional', () => {
    expect(ProfileRollbackCommandSchema.safeParse(KEY).success).toBe(false);
    expect(ProfileRollbackCommandSchema.safeParse({ ...KEY, targetRevision: 1 }).success).toBe(true);
    expect(ProfileRollbackCommandSchema.safeParse({ ...KEY, targetRevision: 1, expectedRevision: 4 }).success).toBe(true);
  });

  it('accepts the apiKeyHash arm end-to-end', () => {
    expect(ProfilePublishCommandSchema.safeParse({ ...KEY, apiKey: { apiKeyHash: HASH }, expectedRevision: 0 }).success).toBe(true);
  });

  it('lists exactly the three dispatched actions', () => {
    expect([...PROFILE_MUTATION_ACTIONS]).toEqual(['profile.upsert', 'profile.publish', 'profile.rollback']);
  });

});

describe('additive guard: the frozen read wire stays untouched', () => {
  it('ProfileUpsertParamsSchema still parses the pre-existing key-only wire', () => {
    // The command schemas above are NEW surface. This pins that the Δ7 ruling
    // was additive: the frozen params schema keeps accepting the old wire with no apiKey.
    expect(
      ProfileUpsertParamsSchema.safeParse({ businessId: 'b', businessVersion: '1', profileName: 'e', policy: {} }).success,
    ).toBe(true);
  });

});

