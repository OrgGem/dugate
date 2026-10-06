import {
  ConnectionStepSchema,
  FileUrlAuthCipherSchema,
  FileUrlAuthConfigSchema,
  PROFILE_DISPATCHER_ACTIONS,
  PROFILE_JOB_PRIORITY_WEIGHTS,
  PROMPT_OVERRIDE_PRECEDENCE,
  ProfileDetailReadSchema,
  ProfileEndpointPolicyReadSchema,
  ProfileEndpointPolicySchema,
  ProfileJobPrioritySchema,
  ProfilePublishParamsSchema,
  ProfileRollbackParamsSchema,
  ProfileUpsertParamsSchema,
  PromptOverrideKeySchema,
  PromptOverrideUpsertParamsSchema,
  UserProfileAssignmentParamsSchema,
  parseAllowedFileExtensions,
} from '../src';

// A well-formed legacy AES-256-GCM storage string: 12-byte IV, 16-byte tag,
// 10-byte ciphertext.
const VALID_CIPHER =
  'abababababababababababab:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd:efefefefefefefefefef';

describe('profile endpoint policy (T-PROF-01)', () => {
  it('accepts a full legacy policy on write', () => {
    const result = ProfileEndpointPolicySchema.safeParse({
      enabled: false,
      parameters: { model: { value: 'gemini-2.0', isLocked: true } },
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf,.docx',
      fileUrlAuthConfig: { type: 'bearer', token: 'secret-token' },
      connectionsOverride: [{ slug: 'gemini', stepId: 'extract' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty policy (first save sends nothing but the key)', () => {
    expect(ProfileEndpointPolicySchema.safeParse({}).success).toBe(true);
  });

  it('rejects an unknown policy key (strict, fail closed)', () => {
    expect(
      ProfileEndpointPolicySchema.safeParse({ enabled: true, secretPrompt: 'leak' }).success,
    ).toBe(false);
  });

  it('rejects a priority outside LOW/MEDIUM/HIGH', () => {
    expect(ProfileJobPrioritySchema.safeParse('URGENT').success).toBe(false);
    expect(ProfileJobPrioritySchema.safeParse('low').success).toBe(false);
  });

  it('keeps the legacy priority -> BullMQ priority mapping (inverted, parity with lib/pipelines/submit.ts:26-32)', () => {
    // F-PP1: BullMQ runs the LOWER number first, so HIGH must be 1. The
    // pre-fix contract had this table reversed.
    expect(PROFILE_JOB_PRIORITY_WEIGHTS).toEqual({ LOW: 20, MEDIUM: 10, HIGH: 1 });

    // Parity pin against the legacy literals, so a future "cleanup" cannot
    // silently flip the direction again.
    const LEGACY_BULLMQ = { HIGH: 1, MEDIUM: 10, LOW: 20 };
    expect(PROFILE_JOB_PRIORITY_WEIGHTS.HIGH).toBe(LEGACY_BULLMQ.HIGH);
    expect(PROFILE_JOB_PRIORITY_WEIGHTS.MEDIUM).toBe(LEGACY_BULLMQ.MEDIUM);
    expect(PROFILE_JOB_PRIORITY_WEIGHTS.LOW).toBe(LEGACY_BULLMQ.LOW);

    // Ordering invariant: a HIGH-priority job must numerically outrank both
    // MEDIUM and LOW, or priority is inverted in the wrong direction.
    expect(PROFILE_JOB_PRIORITY_WEIGHTS.HIGH).toBeLessThan(PROFILE_JOB_PRIORITY_WEIGHTS.MEDIUM);
    expect(PROFILE_JOB_PRIORITY_WEIGHTS.MEDIUM).toBeLessThan(PROFILE_JOB_PRIORITY_WEIGHTS.LOW);
  });
});

describe('fileUrlAuthConfig write-only (T-PROF-04)', () => {
  it('WT-04 exposes invalid callback marker only on the read contract', () => {
    const read = {
      enabled: true, parameters: {}, jobPriority: 'MEDIUM', allowedFileExtensions: '',
      fileUrlAuthConfigured: false, connectionsOverride: [],
      callbackPolicy: null, callbackPolicyInvalid: true,
    };
    expect(ProfileEndpointPolicyReadSchema.safeParse(read).success).toBe(true);
    expect(ProfileEndpointPolicySchema.safeParse({ callbackPolicy: null }).success).toBe(true);
    expect(ProfileEndpointPolicySchema.safeParse({ callbackPolicy: null, callbackPolicyInvalid: true }).success).toBe(false);
  });
  it('keeps the legacy snake_case header/query field names', () => {
    const parsed = FileUrlAuthConfigSchema.parse({
      type: 'header',
      header_name: 'X-Api-Key',
      header_value: 'abc',
    });
    expect(parsed.header_name).toBe('X-Api-Key');
    expect(parsed.header_value).toBe('abc');
  });

  it('never appears on the read schema — only the boolean does', () => {
    const read = ProfileEndpointPolicyReadSchema.safeParse({
      enabled: true,
      parameters: {},
      jobPriority: 'MEDIUM',
      allowedFileExtensions: '',
      fileUrlAuthConfigured: true,
      connectionsOverride: [],
    });
    expect(read.success).toBe(true);
    expect(ProfileEndpointPolicyReadSchema.safeParse({
      enabled: true,
      parameters: {},
      jobPriority: 'MEDIUM',
      allowedFileExtensions: '',
      fileUrlAuthConfigured: true,
      fileUrlAuthConfig: { type: 'bearer', token: 'secret' },
      connectionsOverride: [],
    }).success).toBe(false);
  });
});

describe('storage cipher is iv:tag:ciphertext hex, not a JSON envelope', () => {
  it('accepts the legacy three-part form', () => {
    expect(FileUrlAuthCipherSchema.safeParse(VALID_CIPHER).success).toBe(true);
  });

  it('rejects a JSON cipher envelope (the shape the client must not send)', () => {
    expect(FileUrlAuthCipherSchema.safeParse(JSON.stringify({ iv: 'ab', tag: 'cd' })).success).toBe(false);
  });

  it('rejects a wrong IV length, tag length, and empty ciphertext', () => {
    expect(FileUrlAuthCipherSchema.safeParse('abab:cdcd:ef').success).toBe(false);
    expect(FileUrlAuthCipherSchema.safeParse('abababababababababababab:cdcd:ef').success).toBe(false);
    expect(
      FileUrlAuthCipherSchema.safeParse(
        'abababababababababababab:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd:',
      ).success,
    ).toBe(false);
  });

  it('rejects uppercase hex (legacy crypto emits lowercase)', () => {
    expect(FileUrlAuthCipherSchema.safeParse(VALID_CIPHER.toUpperCase()).success).toBe(false);
  });
});

describe('allowedFileExtensions stays a CSV string (correction #3)', () => {
  it('trims each part, drops empties, preserves order, case and duplicates', () => {
    expect(parseAllowedFileExtensions(' .pdf , , .PDF ,docx,.pdf ')).toEqual([
      '.pdf',
      '.PDF',
      'docx',
      '.pdf',
    ]);
  });

  it('returns an empty list for an empty CSV', () => {
    expect(parseAllowedFileExtensions('')).toEqual([]);
    expect(parseAllowedFileExtensions('  ,  ')).toEqual([]);
  });
});

describe('connectionsOverride is ConnectionStep[]', () => {
  it('accepts the legacy step shape', () => {
    expect(
      ConnectionStepSchema.safeParse({
        slug: 'gemini',
        stepId: 'extract',
        captureSession: null,
        injectSession: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown step key', () => {
    expect(ConnectionStepSchema.safeParse({ slug: 'gemini', retries: 3 }).success).toBe(false);
  });

  it('rejects a bare legacy string[] entry (normalized on write, not accepted here)', () => {
    expect(ConnectionStepSchema.safeParse('gemini').success).toBe(false);
  });
});

describe('profile detail read (T-API-01, fixes revision: 0)', () => {
  const detail = {
    businessId: 'document-core',
    businessVersion: '1.0.0',
    profileName: 'extract',
    revision: 3,
    currentValues: { model: 'gemini-2.0' },
    policy: {
      enabled: true,
      parameters: { model: { value: 'gemini-2.0', isLocked: true } },
      jobPriority: 'MEDIUM',
      allowedFileExtensions: '.pdf',
      fileUrlAuthConfigured: false,
      connectionsOverride: [],
    },
    manifest: { actions: [{ name: 'extract' }] },
    capabilities: [{ connectorId: 'c1', capability: 'ocr' }],
  };

  it('accepts a real revision and keeps the shell fetcher field names', () => {
    const parsed = ProfileDetailReadSchema.parse(detail);
    expect(parsed.revision).toBe(3);
    expect(parsed.currentValues.model).toBe('gemini-2.0');
  });

  it('round-trips without exposing the cipher', () => {
    const round = ProfileDetailReadSchema.parse(
      JSON.parse(JSON.stringify(ProfileDetailReadSchema.parse(detail))),
    );
    expect(round).toEqual(detail);
    expect(JSON.stringify(round)).not.toContain('fileUrlAuthCipher');
  });

  it('closure T-API-01: the write identity (apiKeyId) is optional and strictly a uuid', () => {
    // The detail read reveals ONLY the opaque key id (never the hash) so the
    // client can address profile.* commands (Δ7-A).
    const withKey = ProfileDetailReadSchema.parse({
      ...detail,
      apiKeyId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(withKey.apiKeyId).toBe('123e4567-e89b-42d3-a456-426614174000');
    // Additive: the pre-closure wire (no apiKeyId) still parses unchanged.
    expect(ProfileDetailReadSchema.parse(detail).apiKeyId).toBeUndefined();
    // Fail-closed: a malformed id or an unknown sibling key is refused (.strict()).
    expect(ProfileDetailReadSchema.safeParse({ ...detail, apiKeyId: 'not-a-uuid' }).success).toBe(false);
    expect(ProfileDetailReadSchema.safeParse({ ...detail, apiKeyHash: 'a'.repeat(64) }).success).toBe(false);
  });
});

describe('dispatcher action params mirror the frozen BFF wire (T-API-02)', () => {
  it('profile.upsert requires policy and allows a blind first save', () => {
    expect(
      ProfileUpsertParamsSchema.safeParse({
        businessId: 'b',
        businessVersion: '1.0.0',
        profileName: 'extract',
        policy: {},
      }).success,
    ).toBe(true);
    expect(
      ProfileUpsertParamsSchema.safeParse({ businessId: 'b', businessVersion: '1', profileName: 'e' }).success,
    ).toBe(false);
  });

  it('profile.publish requires expectedRevision (it is a CAS move)', () => {
    expect(
      ProfilePublishParamsSchema.safeParse({
        businessId: 'b', businessVersion: '1', profileName: 'e',
      }).success,
    ).toBe(false);
    expect(
      ProfilePublishParamsSchema.safeParse({
        businessId: 'b', businessVersion: '1', profileName: 'e', expectedRevision: 2,
      }).success,
    ).toBe(true);
  });

  it('profile.rollback requires targetRevision but not expectedRevision', () => {
    expect(
      ProfileRollbackParamsSchema.safeParse({
        businessId: 'b', businessVersion: '1', profileName: 'e',
      }).success,
    ).toBe(false);
    expect(
      ProfileRollbackParamsSchema.safeParse({
        businessId: 'b', businessVersion: '1', profileName: 'e', targetRevision: 1,
      }).success,
    ).toBe(true);
  });

  it('lists exactly the actions the plan freezes', () => {
    expect([...PROFILE_DISPATCHER_ACTIONS]).toEqual([
      'profile.upsert',
      'profile.publish',
      'profile.rollback',
      'prompt-override.upsert',
      'prompt-override.delete',
      'assignment.grant',
      'assignment.revoke',
    ]);
  });
});

describe('prompt override key-4 (PAR-13)', () => {
  const key = {
    connectionId: '11111111-1111-4111-8111-111111111111',
    apiKeyId: '22222222-2222-4222-8222-222222222222',
    endpointSlug: 'extract',
  };

  it("defaults stepId to '_default'", () => {
    expect(PromptOverrideKeySchema.parse(key).stepId).toBe('_default');
  });

  it('rejects a non-uuid connectionId (legacy ids are mapped at import, not stored)', () => {
    expect(PromptOverrideKeySchema.safeParse({ ...key, connectionId: 'conn-1' }).success).toBe(false);
  });

  it('defaults isActive to true on upsert', () => {
    expect(PromptOverrideUpsertParamsSchema.parse({ ...key, promptOverride: 'p' }).isActive).toBe(true);
  });

  it('keeps precedence Code > Profile > Connector', () => {
    expect([...PROMPT_OVERRIDE_PRECEDENCE]).toEqual(['code', 'profile', 'connector']);
  });
});

describe('scoped assignment params (T-AUTH-01, gated on T-AUTH-03)', () => {
  it('assigns by api key id, not profile id (legacy requireProfileAccess)', () => {
    expect(
      UserProfileAssignmentParamsSchema.safeParse({
        userId: '33333333-3333-4333-8333-333333333333',
        apiKeyId: '22222222-2222-4222-8222-222222222222',
      }).success,
    ).toBe(true);
    expect(
      UserProfileAssignmentParamsSchema.safeParse({
        userId: '33333333-3333-4333-8333-333333333333',
        profileId: 'anything',
      }).success,
    ).toBe(false);
  });
});
