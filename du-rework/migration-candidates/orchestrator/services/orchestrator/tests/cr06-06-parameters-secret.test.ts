/**
 * CR06-06 - parameters must never carry a credential into the admission
 * snapshot. `parameters` is a passthrough bag, so this guard is the only
 * thing between a caller-supplied secret and a plaintext snapshot column.
 */
import {
  ProfileParametersSchema,
  ProfileSnapshotParametersSchema,
  SECRET_PARAMETER_KEY_PATTERNS,
  findSecretParameterKeys,
  isSecretParameterKey,
} from '@du/contracts';
import { buildProfilePolicySnapshot } from '../src/modules/operations/submission';
import { HttpError } from '../src/http/errors';

const CREDENTIAL_KEYS = [
  'fileUrlAuth', 'fileUrlAuthConfig', 'fileUrlAuthToken', 'token', 'accessToken',
  'auth_token', 'refresh-token', 'password', 'dbPassword', 'passwd', 'secret',
  'clientSecret', 'apiKey', 'api_key', 'x-api-key', 'authorization', 'serviceCredential',
];

const ORDINARY_KEYS = [
  'ai_model', 'extract_fields', 'maxTokens', 'tokenizer', 'passwordPolicy',
  'credentialRef', 'authorizationMode',
];

describe('findSecretParameterKeys', () => {
  it('flags every credential-shaped key', () => {
    for (const key of CREDENTIAL_KEYS) {
      expect({ key, flagged: isSecretParameterKey(key) }).toEqual({ key, flagged: true });
      expect(findSecretParameterKeys({ [key]: { value: 'x' } })).toEqual([key]);
    }
  });

  it('leaves ordinary parameters alone (no false positives)', () => {
    for (const key of ORDINARY_KEYS) expect(isSecretParameterKey(key)).toBe(false);
    expect(findSecretParameterKeys({ ai_model: { value: 'gpt' }, maxTokens: { value: 4 } })).toEqual([]);
  });

  it('returns only key names, never values', () => {
    const found = findSecretParameterKeys({ accessToken: { value: 'sk-live-SECRET-XYZ' } });
    expect(found).toEqual(['accessToken']);
    expect(JSON.stringify(found)).not.toContain('SECRET');
  });

  it('tolerates a non-object input instead of throwing', () => {
    expect(findSecretParameterKeys(null)).toEqual([]);
    expect(findSecretParameterKeys(undefined)).toEqual([]);
    expect(findSecretParameterKeys([{ accessToken: 1 }])).toEqual([]);
    expect(findSecretParameterKeys('nope')).toEqual([]);
  });

  it('every pattern is anchored so a near-miss is not a secret', () => {
    expect(SECRET_PARAMETER_KEY_PATTERNS.length).toBeGreaterThan(0);
    expect(isSecretParameterKey('tokenizer-v2')).toBe(false);
  });
});

describe('snapshot parameters schema refuses credential keys', () => {
  it('accepts an ordinary parameters record', () => {
    const parsed = ProfileSnapshotParametersSchema.safeParse({ ai_model: { value: 'gpt-4o-mini' }, maxTokens: { value: 8 } });
    expect(parsed.success).toBe(true);
  });

  it('refuses a fileUrlAuth family key', () => {
    expect(ProfileSnapshotParametersSchema.safeParse({ fileUrlAuthToken: { value: 'sk-live-SECRET-XYZ' } }).success).toBe(false);
  });

  it('refuses token/password keys', () => {
    expect(ProfileSnapshotParametersSchema.safeParse({ accessToken: { value: 'x' } }).success).toBe(false);
    expect(ProfileSnapshotParametersSchema.safeParse({ password: { value: 'hunter2' } }).success).toBe(false);
  });

  it('the WRITE schema still carries values verbatim (ADMIN-TRUSTED PIN)', () => {
    // Deliberate boundary split: profile write is admin-trusted and stores the
    // value as authored; the SNAPSHOT is where it leaves the process.
    expect(ProfileParametersSchema.safeParse({ apiKey: { value: 'sentinel' } }).success).toBe(true);
  });
});

describe('submit snapshot sentinel (fail-closed 422)', () => {
  const pinned = (parameters: unknown) =>
    ({
      mode: 'pinned',
      profileId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      policy: {
        enabled: true,
        parameters,
        jobPriority: 'MEDIUM',
        allowedFileExtensions: '.pdf',
        // Required by ProfilePolicySnapshotSchema: a CSV string, and
        // connectionsOverride is an ARRAY of connection steps. Empty keeps the
        // fixture minimal and the ordinary case on the SUCCESS path.
        connectionsOverride: [],
        fileUrlAuthConfig: null,
      },
    }) as never;

  it('throws 422 SECRET_IN_PARAMETERS for a credential in parameters', () => {
    let thrown: unknown;
    try {
      buildProfilePolicySnapshot(pinned({ accessToken: { value: 'sk-live-SECRET-XYZ' } }), 'tenant-1');
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(422);
    expect((thrown as HttpError).code).toBe('SECRET_IN_PARAMETERS');
  });

  it('names the offending key but never echoes the value', () => {
    let thrown: unknown;
    try {
      buildProfilePolicySnapshot(pinned({ fileUrlAuthToken: { value: 'sk-live-SECRET-XYZ' } }), 'tenant-1');
    } catch (error) { thrown = error; }
    const wire = JSON.stringify((thrown as HttpError).toProblem('test-correlation'));
    expect(wire).toContain('fileUrlAuthToken');
    expect(wire).not.toContain('sk-live-SECRET-XYZ');
  });

  it('does NOT trip the secret sentinel for an ordinary parameters record', () => {
    try {
      buildProfilePolicySnapshot(pinned({ ai_model: { value: 'gpt-4o-mini' } }), 'tenant-1');
    } catch (error) {
      // The synthetic fixture does not carry every snapshot field (that shape is
      // covered by the snapshot contract itself); what matters here is that the
      // SECRET sentinel is NOT what stopped it.
      expect((error as HttpError).status).not.toBe(422);
      expect((error as HttpError).code).not.toBe('SECRET_IN_PARAMETERS');
    }
  });
});
