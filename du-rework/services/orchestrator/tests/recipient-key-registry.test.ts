import {
  constants,
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  createRecipientKeyRegistry,
  RecipientKeyRegistryError,
  type RecipientKeyProofChallenge,
  type RecipientPublicKeyRecord,
  type RecipientPublicKeyRepository,
} from '../src/modules/encryption/recipient-key-registry';

class MemoryRecipientKeyRepository implements RecipientPublicKeyRepository {
  public readonly challenges = new Map<string, RecipientKeyProofChallenge>();
  public readonly keys = new Map<string, Map<number, RecipientPublicKeyRecord>>();
  public beforeGetCurrent: (() => Promise<void>) | undefined;
  public forceCreateConflict = false;
  public failReads = false;

  public async createProofChallenge(challenge: RecipientKeyProofChallenge): Promise<void> {
    this.challenges.set(challenge.id, challenge);
  }

  public async consumeProofChallenge(tenantId: string, challengeId: string): Promise<RecipientKeyProofChallenge | null> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.tenantId !== tenantId) return null;
    this.challenges.delete(challengeId);
    return challenge;
  }

  public async getCurrentKey(tenantId: string): Promise<RecipientPublicKeyRecord | null> {
    if (this.failReads) throw new Error('injected repository failure');
    const keys = this.keys.get(tenantId);
    const current = keys ? [...keys.values()].sort((left, right) => right.version - left.version)[0] ?? null : null;
    await this.beforeGetCurrent?.();
    return current;
  }

  public async getKeyVersion(tenantId: string, version: number): Promise<RecipientPublicKeyRecord | null> {
    if (this.failReads) throw new Error('injected repository failure');
    return this.keys.get(tenantId)?.get(version) ?? null;
  }

  public async listKeys(tenantId: string): Promise<readonly RecipientPublicKeyRecord[]> {
    if (this.failReads) throw new Error('injected repository failure');
    return [...(this.keys.get(tenantId)?.values() ?? [])];
  }

  public async createKeyIfVersionMatches(
    tenantId: string,
    expectedCurrentVersion: number,
    record: RecipientPublicKeyRecord,
  ): Promise<boolean> {
    if (this.forceCreateConflict) return false;
    const current = this.getCurrentKeyWithoutHook(tenantId);
    if ((current?.version ?? 0) !== expectedCurrentVersion) return false;
    const tenantKeys = this.keys.get(tenantId) ?? new Map<number, RecipientPublicKeyRecord>();
    tenantKeys.set(record.version, record);
    this.keys.set(tenantId, tenantKeys);
    return true;
  }

  public async revokeKey(tenantId: string, version: number, revokedAt: string): Promise<RecipientPublicKeyRecord | null> {
    const tenantKeys = this.keys.get(tenantId);
    const current = tenantKeys?.get(version);
    if (!tenantKeys || !current) return null;
    if (current.revokedAt !== null) return current;
    const updated = { ...current, revokedAt };
    tenantKeys.set(version, updated);
    return updated;
  }

  private getCurrentKeyWithoutHook(tenantId: string): RecipientPublicKeyRecord | null {
    const keys = this.keys.get(tenantId);
    return keys ? [...keys.values()].sort((left, right) => right.version - left.version)[0] ?? null : null;
  }
}

function rsaPair(modulusLength = 2048): { publicPem: string; privateKey: KeyObject; publicKey: KeyObject } {
  const pair = generateKeyPairSync('rsa', { modulusLength, publicExponent: 0x10001 });
  return {
    publicPem: String(pair.publicKey.export({ format: 'pem', type: 'spki' })),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

function rsaProof(challenge: string, privateKey: KeyObject): string {
  return sign(
    'sha256',
    Buffer.from(challenge, 'base64url'),
    { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
  ).toString('base64url');
}

async function registerRsa(
  registry: ReturnType<typeof createRecipientKeyRegistry>,
  tenantId: string,
  pair = rsaPair(),
): Promise<RecipientPublicKeyRecord> {
  const challenge = await registry.createProofChallenge({
    tenantId,
    algorithm: 'rsa-oaep-sha256',
    publicKeyPem: pair.publicPem,
  });
  return registry.completeRegistration({
    tenantId,
    challengeId: challenge.challengeId,
    proof: rsaProof(challenge.challenge, pair.privateKey),
  });
}

function testClock(initial = Date.parse('2026-09-27T12:00:00.000Z')): { now: () => number; advance: (ms: number) => void } {
  let time = initial;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

describe('recipient public key registry', () => {
  test('issues a tenant-bound PoP challenge and registers a canonical RSA public key after a valid proof', async () => {
    const repository = new MemoryRecipientKeyRepository();
    const clock = testClock();
    const registry = createRecipientKeyRegistry({ repository, now: clock.now });
    const pair = rsaPair();
    const challenge = await registry.createProofChallenge({
      tenantId: 'tenant-a',
      algorithm: 'rsa-oaep-sha256',
      publicKeyPem: pair.publicPem,
    });
    const rawDer = pair.publicKey.export({ format: 'der', type: 'spki' });

    expect(challenge.fingerprint).toBe('SHA256:' + createHash('sha256').update(rawDer).digest('base64url'));
    expect(challenge.expiresAt).toBe('2026-09-27T12:05:00.000Z');
    expect(Buffer.from(challenge.challenge, 'base64url').toString('utf8')).toContain('tenant-a');

    const record = await registry.completeRegistration({
      tenantId: 'tenant-a',
      challengeId: challenge.challengeId,
      proof: rsaProof(challenge.challenge, pair.privateKey),
    });
    expect(record).toMatchObject({
      tenantId: 'tenant-a',
      version: 1,
      algorithm: 'rsa-oaep-sha256',
      fingerprint: challenge.fingerprint,
      effectiveAt: '2026-09-27T12:00:00.000Z',
      revokedAt: null,
    });
    expect(record.publicKeyPem).toBe(pair.publicPem);
    expect(record.publicKeyPem).not.toContain('PRIVATE KEY');
    await expect(registry.getCurrentKey('tenant-a')).resolves.toEqual(record);
    await expect(registry.getCurrentKey('tenant-b')).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
    await expect(registry.getKeyVersion('tenant-b', record.version)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
  });

  test('consumes a failed proof and rejects replay', async () => {
    const repository = new MemoryRecipientKeyRepository();
    const registry = createRecipientKeyRegistry({ repository, now: testClock().now });
    const pair = rsaPair();
    const challenge = await registry.createProofChallenge({
      tenantId: 'tenant-a',
      algorithm: 'rsa-oaep-sha256',
      publicKeyPem: pair.publicPem,
    });

    await expect(registry.completeRegistration({
      tenantId: 'tenant-a',
      challengeId: challenge.challengeId,
      proof: Buffer.alloc(256, 7).toString('base64url'),
    })).rejects.toMatchObject({ code: 'PROOF_INVALID' });
    await expect(registry.completeRegistration({
      tenantId: 'tenant-a',
      challengeId: challenge.challengeId,
      proof: rsaProof(challenge.challenge, pair.privateKey),
    })).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    await expect(registry.listKeys('tenant-a')).resolves.toHaveLength(0);
  });

  test('does not let another tenant consume a challenge and rejects an expired challenge', async () => {
    const repository = new MemoryRecipientKeyRepository();
    const clock = testClock();
    const registry = createRecipientKeyRegistry({ repository, now: clock.now, challengeTtlMs: 1_000 });
    const pair = rsaPair();
    const challenge = await registry.createProofChallenge({
      tenantId: 'tenant-a',
      algorithm: 'rsa-oaep-sha256',
      publicKeyPem: pair.publicPem,
    });

    await expect(registry.completeRegistration({
      tenantId: 'tenant-b',
      challengeId: challenge.challengeId,
      proof: rsaProof(challenge.challenge, pair.privateKey),
    })).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    clock.advance(1_000);
    await expect(registry.completeRegistration({
      tenantId: 'tenant-a',
      challengeId: challenge.challengeId,
      proof: rsaProof(challenge.challenge, pair.privateKey),
    })).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
  });

  test('increments versions on rotation and keeps old non-revoked versions addressable', async () => {
    const repository = new MemoryRecipientKeyRepository();
    const registry = createRecipientKeyRegistry({ repository, now: testClock().now });
    const first = await registerRsa(registry, 'tenant-a');
    const second = await registerRsa(registry, 'tenant-a');

    expect(second.version).toBe(2);
    await expect(registry.getCurrentKey('tenant-a')).resolves.toEqual(second);
    await expect(registry.getKeyVersion('tenant-a', 1)).resolves.toEqual(first);
    await expect(registry.listKeys('tenant-a')).resolves.toEqual([first, second]);
  });

  test('revocation is idempotent and a revoked current key never falls back to an older version', async () => {
    const repository = new MemoryRecipientKeyRepository();
    const clock = testClock();
    const registry = createRecipientKeyRegistry({ repository, now: clock.now });
    const first = await registerRsa(registry, 'tenant-a');
    const second = await registerRsa(registry, 'tenant-a');

    const revoked = await registry.revokeKey('tenant-a', second.version);
    clock.advance(5_000);
    const replayedRevoke = await registry.revokeKey('tenant-a', second.version);
    expect(replayedRevoke.revokedAt).toBe(revoked.revokedAt);
    await expect(registry.getCurrentKey('tenant-a')).rejects.toMatchObject({ code: 'KEY_REVOKED' });
    await expect(registry.getKeyVersion('tenant-a', second.version)).rejects.toMatchObject({ code: 'KEY_REVOKED' });
    await expect(registry.getKeyVersion('tenant-a', first.version)).resolves.toEqual(first);
    await expect(registry.revokeKey('tenant-a', 99)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
  });

  test('rejects reused fingerprints, malformed keys, weak RSA keys, and private PEM material', async () => {
    const repository = new MemoryRecipientKeyRepository();
    const registry = createRecipientKeyRegistry({ repository, now: testClock().now });
    const pair = rsaPair();
    await registerRsa(registry, 'tenant-a', pair);

    const duplicateChallenge = await registry.createProofChallenge({
      tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: pair.publicPem,
    });
    await expect(registry.completeRegistration({
      tenantId: 'tenant-a', challengeId: duplicateChallenge.challengeId,
      proof: rsaProof(duplicateChallenge.challenge, pair.privateKey),
    })).rejects.toMatchObject({ code: 'KEY_ALREADY_REGISTERED' });
    await expect(registry.createProofChallenge({
      tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: 'not a PEM key',
    })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
    const weak = rsaPair(1024);
    await expect(registry.createProofChallenge({
      tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: weak.publicPem,
    })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
    const privatePem = String(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await expect(registry.createProofChallenge({
      tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: privatePem,
    })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
  });

  test('requires a suite-specific verifier for X25519 and passes only public-key challenge material to it', async () => {
    const pair = generateKeyPairSync('x25519');
    const publicPem = String(pair.publicKey.export({ format: 'pem', type: 'spki' }));
    const repository = new MemoryRecipientKeyRepository();
    const registry = createRecipientKeyRegistry({
      repository,
      now: testClock().now,
      proofVerifier: ({ algorithm, publicKey, challenge, proof }) => algorithm === 'hpke-x25519'
        && publicKey.asymmetricKeyType === 'x25519'
        && challenge.equals(proof),
    });
    const challenge = await registry.createProofChallenge({
      tenantId: 'tenant-a', algorithm: 'hpke-x25519', publicKeyPem: publicPem,
    });
    const record = await registry.completeRegistration({
      tenantId: 'tenant-a', challengeId: challenge.challengeId, proof: challenge.challenge,
    });

    expect(record.algorithm).toBe('hpke-x25519');
    const noVerifier = createRecipientKeyRegistry({ repository: new MemoryRecipientKeyRepository(), now: testClock().now });
    await expect(noVerifier.createProofChallenge({
      tenantId: 'tenant-a', algorithm: 'hpke-x25519', publicKeyPem: publicPem,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROOF_ALGORITHM' });
  });

  test('refuses concurrent version allocation and fails closed when repository reads fail', async () => {
    const repository = new MemoryRecipientKeyRepository();
    let waitingReaders = 0;
    let releaseReaders: (() => void) | undefined;
    const readersReady = new Promise<void>((resolve) => { releaseReaders = resolve; });
    repository.beforeGetCurrent = async () => {
      waitingReaders += 1;
      if (waitingReaders === 2) releaseReaders?.();
      if (waitingReaders <= 2) await readersReady;
    };
    const registry = createRecipientKeyRegistry({ repository, now: testClock().now });
    const pairA = rsaPair();
    const pairB = rsaPair();
    const challengeA = await registry.createProofChallenge({ tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: pairA.publicPem });
    const challengeB = await registry.createProofChallenge({ tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: pairB.publicPem });
    const results = await Promise.allSettled([
      registry.completeRegistration({ tenantId: 'tenant-a', challengeId: challengeA.challengeId, proof: rsaProof(challengeA.challenge, pairA.privateKey) }),
      registry.completeRegistration({ tenantId: 'tenant-a', challengeId: challengeB.challengeId, proof: rsaProof(challengeB.challenge, pairB.privateKey) }),
    ]);
    repository.beforeGetCurrent = undefined;

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(registry.listKeys('tenant-a')).resolves.toHaveLength(1);

    repository.failReads = true;
    await expect(registry.getCurrentKey('tenant-a')).rejects.toBeInstanceOf(RecipientKeyRegistryError);
    await expect(registry.getCurrentKey('tenant-a')).rejects.toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
  });
});
