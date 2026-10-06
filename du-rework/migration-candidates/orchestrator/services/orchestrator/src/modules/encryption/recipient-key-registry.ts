import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export type RecipientKeyAlgorithm = 'rsa-oaep-sha256' | 'hpke-x25519';

export type RecipientKeyRegistryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PUBLIC_KEY'
  | 'UNSUPPORTED_ALGORITHM'
  | 'UNSUPPORTED_PROOF_ALGORITHM'
  | 'CHALLENGE_INVALID'
  | 'PROOF_INVALID'
  | 'KEY_NOT_FOUND'
  | 'KEY_REVOKED'
  | 'KEY_ALREADY_REGISTERED'
  | 'VERSION_CONFLICT'
  | 'REGISTRY_UNAVAILABLE';

export class RecipientKeyRegistryError extends Error {
  public readonly code: RecipientKeyRegistryErrorCode;

  public constructor(code: RecipientKeyRegistryErrorCode, message: string) {
    super(message);
    this.name = 'RecipientKeyRegistryError';
    this.code = code;
  }
}

export interface RecipientPublicKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly algorithm: RecipientKeyAlgorithm;
  /** Canonical public-only SubjectPublicKeyInfo PEM. */
  readonly publicKeyPem: string;
  /** SHA-256 fingerprint of canonical SubjectPublicKeyInfo DER. */
  readonly fingerprint: string;
  readonly effectiveAt: string;
  readonly revokedAt: string | null;
}

export interface RecipientKeyProofChallenge {
  readonly id: string;
  readonly tenantId: string;
  readonly algorithm: RecipientKeyAlgorithm;
  readonly publicKeyPem: string;
  readonly fingerprint: string;
  /** Base64url-encoded challenge bytes; the client proves possession over these bytes. */
  readonly challenge: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Repository operations that must be atomic in a durable adapter:
 * - consumeProofChallenge is tenant-scoped and single-use;
 * - createKeyIfVersionMatches is a compare-and-set on the tenant's highest
 *   version, including revoked versions, so concurrent rotations cannot
 *   allocate the same version;
 * - getCurrentKey returns the highest registered version and never falls
 *   back to an older version when that row has been revoked.
 */
export interface RecipientPublicKeyRepository {
  createProofChallenge(challenge: RecipientKeyProofChallenge): Promise<void>;
  consumeProofChallenge(tenantId: string, challengeId: string): Promise<RecipientKeyProofChallenge | null>;
  getCurrentKey(tenantId: string): Promise<RecipientPublicKeyRecord | null>;
  getKeyVersion(tenantId: string, version: number): Promise<RecipientPublicKeyRecord | null>;
  listKeys(tenantId: string): Promise<readonly RecipientPublicKeyRecord[]>;
  createKeyIfVersionMatches(
    tenantId: string,
    expectedCurrentVersion: number,
    record: RecipientPublicKeyRecord,
  ): Promise<boolean>;
  revokeKey(tenantId: string, version: number, revokedAt: string): Promise<RecipientPublicKeyRecord | null>;
}

export interface RecipientProofVerificationInput {
  readonly tenantId: string;
  readonly algorithm: RecipientKeyAlgorithm;
  readonly publicKey: KeyObject;
  readonly challenge: Buffer;
  readonly proof: Buffer;
}

/** Override for a finalized suite-specific PoP profile (for example HPKE keys). */
export type RecipientProofVerifier = (
  input: RecipientProofVerificationInput,
) => boolean | Promise<boolean>;

export interface RecipientKeyRegistryOptions {
  readonly repository: RecipientPublicKeyRepository;
  /** Challenge lifetime, default 5 minutes. */
  readonly challengeTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
  /** Optional verifier for a suite-specific proof profile. */
  readonly proofVerifier?: RecipientProofVerifier;
}

export interface CreateProofChallengeInput {
  readonly tenantId: string;
  readonly algorithm: RecipientKeyAlgorithm;
  readonly publicKeyPem: string;
}

export interface CreateProofChallengeResult {
  readonly challengeId: string;
  readonly challenge: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
}

export interface CompleteRegistrationInput {
  readonly tenantId: string;
  readonly challengeId: string;
  /** Base64url-encoded proof bytes. RSA keys use RSA-PSS/SHA-256 by default. */
  readonly proof: string;
}

export interface RecipientKeyRegistry {
  createProofChallenge(input: CreateProofChallengeInput): Promise<CreateProofChallengeResult>;
  completeRegistration(input: CompleteRegistrationInput): Promise<RecipientPublicKeyRecord>;
  getCurrentKey(tenantId: string): Promise<RecipientPublicKeyRecord>;
  getKeyVersion(tenantId: string, version: number): Promise<RecipientPublicKeyRecord>;
  listKeys(tenantId: string): Promise<readonly RecipientPublicKeyRecord[]>;
  revokeKey(tenantId: string, version: number): Promise<RecipientPublicKeyRecord>;
}

const TENANT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PUBLIC_KEY_MAX_CHARS = 16 * 1024;
const PROOF_MAX_CHARS = 16 * 1024;
const MAX_KEY_VERSION = 2_147_483_647;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_TTL_MS = 15 * 60 * 1000;

function fail(code: RecipientKeyRegistryErrorCode, message: string): never {
  throw new RecipientKeyRegistryError(code, message);
}

function assertTenantId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TENANT_ID.test(value)) {
    fail('INVALID_INPUT', 'Tenant id is invalid');
  }
}

function safeTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    fail('REGISTRY_UNAVAILABLE', 'Recipient key registry clock is invalid');
  }
  return value;
}

function validateVersion(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_KEY_VERSION
  ) {
    fail('INVALID_INPUT', 'Recipient key version is invalid');
  }
  return value;
}

function parsePublicKey(algorithm: unknown, publicKeyPem: unknown): {
  algorithm: RecipientKeyAlgorithm;
  key: KeyObject;
  publicKeyPem: string;
  fingerprint: string;
} {
  if (algorithm !== 'rsa-oaep-sha256' && algorithm !== 'hpke-x25519') {
    fail('UNSUPPORTED_ALGORITHM', 'Recipient public key algorithm is unsupported');
  }
  if (
    typeof publicKeyPem !== 'string'
    || publicKeyPem.length < 1
    || publicKeyPem.length > PUBLIC_KEY_MAX_CHARS
    || !publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(publicKeyPem)
  ) {
    fail('INVALID_PUBLIC_KEY', 'A public-only SubjectPublicKeyInfo PEM is required');
  }

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return fail('INVALID_PUBLIC_KEY', 'Recipient public key could not be parsed');
  }
  if (key.type !== 'public') fail('INVALID_PUBLIC_KEY', 'Recipient public key must not contain private material');

  if (algorithm === 'rsa-oaep-sha256') {
    const details = key.asymmetricKeyDetails;
    if (
      key.asymmetricKeyType !== 'rsa'
      || !details
      || typeof details.modulusLength !== 'number'
      || details.modulusLength < 2048
      || typeof details.publicExponent !== 'bigint'
      || details.publicExponent < 65_537n
    ) {
      fail('INVALID_PUBLIC_KEY', 'RSA recipient keys require at least 2048 bits and exponent 65537 or greater');
    }
  } else if (key.asymmetricKeyType !== 'x25519') {
    fail('INVALID_PUBLIC_KEY', 'HPKE X25519 recipient keys must use X25519');
  }

  const der = key.export({ format: 'der', type: 'spki' });
  const canonicalPem = String(key.export({ format: 'pem', type: 'spki' }));
  const fingerprint = 'SHA256:' + createHash('sha256').update(der).digest('base64url');
  return { algorithm, key, publicKeyPem: canonicalPem, fingerprint };
}

function decodeBase64url(value: unknown, label: string, maxChars: number): Buffer {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxChars
    || !/^[A-Za-z0-9_-]+$/.test(value)
    || value.length % 4 === 1
  ) {
    fail('INVALID_INPUT', label + ' must be base64url');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) fail('INVALID_INPUT', label + ' must be canonical base64url');
  return decoded;
}

function verifyRsaPossession(challenge: Buffer, proof: Buffer, key: KeyObject): boolean {
  try {
    return cryptoVerify(
      'sha256',
      challenge,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      proof,
    );
  } catch {
    return false;
  }
}

function recordForTenant(
  record: RecipientPublicKeyRecord | null,
  tenantId: string,
): RecipientPublicKeyRecord | null {
  if (record === null) return null;
  if (record.tenantId !== tenantId) fail('REGISTRY_UNAVAILABLE', 'Recipient key repository violated tenant scope');
  return record;
}

export function createRecipientKeyRegistry(options: RecipientKeyRegistryOptions): RecipientKeyRegistry {
  if (!options || !options.repository) fail('INVALID_INPUT', 'Recipient key repository is required');
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 1_000 || challengeTtlMs > MAX_CHALLENGE_TTL_MS) {
    fail('INVALID_INPUT', 'Proof challenge lifetime must be between 1000 and 900000 milliseconds');
  }
  const now = options.now ?? Date.now;
  const proofVerifier = options.proofVerifier;
  const repository = options.repository;

  const callRepository = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RecipientKeyRegistryError) throw error;
      throw new RecipientKeyRegistryError('REGISTRY_UNAVAILABLE', 'Recipient key registry storage is unavailable');
    }
  };

  return {
    async createProofChallenge(input) {
      assertTenantId(input?.tenantId);
      const parsed = parsePublicKey(input?.algorithm, input?.publicKeyPem);
      if (parsed.algorithm === 'hpke-x25519' && !proofVerifier) {
        fail('UNSUPPORTED_PROOF_ALGORITHM', 'HPKE X25519 proof verification requires the approved PoP verifier');
      }

      const createdAtMs = safeTime(now);
      const expiresAtMs = createdAtMs + challengeTtlMs;
      const challengeId = randomUUID();
      const nonce = randomBytes(32).toString('base64url');
      const challengePayload = Buffer.from(
        ['DUGATE-RECIPIENT-POP-V1', input.tenantId, parsed.fingerprint, challengeId, nonce].join('\n'),
        'utf8',
      ).toString('base64url');
      const challenge: RecipientKeyProofChallenge = {
        id: challengeId,
        tenantId: input.tenantId,
        algorithm: parsed.algorithm,
        publicKeyPem: parsed.publicKeyPem,
        fingerprint: parsed.fingerprint,
        challenge: challengePayload,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      await callRepository(() => repository.createProofChallenge(challenge));
      return {
        challengeId,
        challenge: challengePayload,
        fingerprint: parsed.fingerprint,
        expiresAt: challenge.expiresAt,
      };
    },

    async completeRegistration(input) {
      assertTenantId(input?.tenantId);
      if (typeof input.challengeId !== 'string' || input.challengeId.length < 1 || input.challengeId.length > 128) {
        fail('INVALID_INPUT', 'Proof challenge id is invalid');
      }
      const challenge = await callRepository(() => repository.consumeProofChallenge(input.tenantId, input.challengeId));
      if (!challenge || challenge.tenantId !== input.tenantId || challenge.id !== input.challengeId) {
        fail('CHALLENGE_INVALID', 'Proof challenge is missing, expired, or already used');
      }
      const nowMs = safeTime(now);
      const expiresAtMs = Date.parse(challenge.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        fail('CHALLENGE_INVALID', 'Proof challenge is missing, expired, or already used');
      }
      const parsed = parsePublicKey(challenge.algorithm, challenge.publicKeyPem);
      if (parsed.fingerprint !== challenge.fingerprint) {
        fail('CHALLENGE_INVALID', 'Proof challenge is invalid');
      }
      const challengeBytes = decodeBase64url(challenge.challenge, 'Proof challenge', 2048);
      const proofBytes = decodeBase64url(input.proof, 'Proof', PROOF_MAX_CHARS);
      let verified = false;
      try {
        if (proofVerifier) {
          verified = await proofVerifier({
            tenantId: input.tenantId,
            algorithm: parsed.algorithm,
            publicKey: parsed.key,
            challenge: Buffer.from(challengeBytes),
            proof: Buffer.from(proofBytes),
          });
        } else if (parsed.algorithm === 'rsa-oaep-sha256') {
          verified = verifyRsaPossession(challengeBytes, proofBytes, parsed.key);
        }
      } catch {
        verified = false;
      } finally {
        challengeBytes.fill(0);
        proofBytes.fill(0);
      }
      if (!verified) fail('PROOF_INVALID', 'Recipient public key proof of possession failed');

      const knownKeys = await callRepository(() => repository.listKeys(input.tenantId));
      if (knownKeys.some((key) => key.tenantId !== input.tenantId)) {
        fail('REGISTRY_UNAVAILABLE', 'Recipient key repository violated tenant scope');
      }
      if (knownKeys.some((key) => key.fingerprint === parsed.fingerprint)) {
        fail('KEY_ALREADY_REGISTERED', 'Recipient public key has already been registered for this tenant');
      }
      const current = recordForTenant(await callRepository(() => repository.getCurrentKey(input.tenantId)), input.tenantId);
      const expectedVersion = current?.version ?? 0;
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= MAX_KEY_VERSION) {
        fail('REGISTRY_UNAVAILABLE', 'Recipient key repository returned an invalid version');
      }
      const effectiveAt = new Date(nowMs).toISOString();
      const record: RecipientPublicKeyRecord = {
        id: randomUUID(),
        tenantId: input.tenantId,
        version: expectedVersion + 1,
        algorithm: parsed.algorithm,
        publicKeyPem: parsed.publicKeyPem,
        fingerprint: parsed.fingerprint,
        effectiveAt,
        revokedAt: null,
      };
      const created = await callRepository(() => repository.createKeyIfVersionMatches(
        input.tenantId,
        expectedVersion,
        record,
      ));
      if (!created) fail('VERSION_CONFLICT', 'Recipient key version changed during registration; issue a new challenge');
      return record;
    },

    async getCurrentKey(tenantId) {
      assertTenantId(tenantId);
      const current = recordForTenant(await callRepository(() => repository.getCurrentKey(tenantId)), tenantId);
      if (!current) fail('KEY_NOT_FOUND', 'No recipient public key is registered for this tenant');
      validateVersion(current.version);
      if (current.revokedAt !== null) fail('KEY_REVOKED', 'The current recipient public key has been revoked');
      return current;
    },

    async getKeyVersion(tenantId, version) {
      assertTenantId(tenantId);
      validateVersion(version);
      const key = recordForTenant(await callRepository(() => repository.getKeyVersion(tenantId, version)), tenantId);
      if (!key) fail('KEY_NOT_FOUND', 'Recipient public key version was not found for this tenant');
      if (key.version !== version) fail('REGISTRY_UNAVAILABLE', 'Recipient key repository returned an invalid version');
      if (key.revokedAt !== null) fail('KEY_REVOKED', 'Recipient public key version has been revoked');
      return key;
    },

    async listKeys(tenantId) {
      assertTenantId(tenantId);
      const keys = await callRepository(() => repository.listKeys(tenantId));
      if (keys.some((key) => key.tenantId !== tenantId)) {
        fail('REGISTRY_UNAVAILABLE', 'Recipient key repository violated tenant scope');
      }
      return [...keys].sort((left, right) => left.version - right.version);
    },

    async revokeKey(tenantId, version) {
      assertTenantId(tenantId);
      validateVersion(version);
      const revokedAt = new Date(safeTime(now)).toISOString();
      const key = recordForTenant(await callRepository(() => repository.revokeKey(tenantId, version, revokedAt)), tenantId);
      if (!key) fail('KEY_NOT_FOUND', 'Recipient public key version was not found for this tenant');
      if (key.version !== version) fail('REGISTRY_UNAVAILABLE', 'Recipient key repository returned an invalid version');
      return key;
    },
  };
}
