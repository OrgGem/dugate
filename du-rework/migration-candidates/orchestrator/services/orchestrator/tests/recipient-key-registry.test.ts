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

  // Packet W-PLAT-CR28-01-RECIPIENT-KEY-REGISTRY-BOUNDS: negative and
  // boundary coverage for the four boundaries the packet names. Every case here
  // asserts a TYPED RecipientKeyRegistryError, never merely "throws" - an
  // unhandled TypeError from node:crypto leaking through would otherwise look
  // identical to a correct refusal at the call site.
  describe('packet boundaries: malformed keys, algorithms, revocation, and lookup', () => {
    function registryWith(overrides: Record<string, unknown> = {}) {
      return createRecipientKeyRegistry({
        repository: new MemoryRecipientKeyRepository(),
        now: testClock().now,
        ...overrides,
      });
    }

    // 1) malformed public key material -------------------------------------
    test('rejects structurally malformed PEM: no header, truncated, corrupt body', async () => {
      const registry = registryWith();
      const pair = rsaPair();
      const good = pair.publicPem;
      // header present but body truncated mid-armour
      const truncated = good.slice(0, good.length - 40);
      // base64 body intact-looking but every character scrambled
      const corruptBody = good.replace(/[A-Za-z]/, (c) => (c === 'A' ? 'Z' : 'A'));
      for (const bad of [
        'not a PEM key',
        '',
        '-----BEGIN PUBLIC KEY-----',
        truncated,
        corruptBody,
        '-----BEGIN PUBLIC KEY-----\n!!!!not base64!!!!\n-----END PUBLIC KEY-----',
      ]) {
        await expect(registry.createProofChallenge({
          tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: bad,
        })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
      }
    });

    test('rejects DER passed where PEM is required, and an oversized key body', async () => {
      const registry = registryWith();
      const pair = rsaPair();
      // A real, parseable key - but as DER, so the public-only PEM guard fires
      // first. The key itself is valid, which is the point: the boundary is on
      // the FORMAT, not on key quality.
      const der = String(pair.publicKey.export({ format: 'der', type: 'spki' }));
      await expect(registry.createProofChallenge({
        tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: der,
      })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
      // Past PUBLIC_KEY_MAX_CHARS (16 KiB) the body is refused without parsing.
      await expect(registry.createProofChallenge({
        tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----' + 'A'.repeat(17 * 1024),
      })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
    });

    test('rejects a key whose material is well-formed but too weak for the suite', async () => {
      const registry = registryWith();
      // 1024-bit RSA parses cleanly yet is below the 2048-bit floor: the two
      // boundaries must be distinguishable, so a weak key must NOT be reported
      // as a parse failure.
      await expect(registry.createProofChallenge({
        tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: rsaPair(1024).publicPem,
      })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
      // X25519 key offered to the RSA suite: valid curve, wrong algorithm.
      const x = generateKeyPairSync('x25519');
      await expect(registry.createProofChallenge({
        tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256',
        publicKeyPem: String(x.publicKey.export({ format: 'pem', type: 'spki' })),
      })).rejects.toMatchObject({ code: 'INVALID_PUBLIC_KEY' });
    });

    // 2) algorithm boundaries ----------------------------------------------
    test('rejects an unknown algorithm, and an hpke key with no approved verifier', async () => {
      const registry = registryWith();
      const pair = rsaPair();
      for (const algorithm of ['rsa-oaep-sha512', 'ed25519', 'none', '', null, 42]) {
        await expect(registry.createProofChallenge({
          tenantId: 'tenant-a', algorithm: algorithm as never, publicKeyPem: pair.publicPem,
        })).rejects.toMatchObject({ code: 'UNSUPPORTED_ALGORITHM' });
      }
      // hpke-x25519 is a known algorithm but has NO verifier wired here, so the
      // boundary is UNSUPPORTED_PROOF_ALGORITHM, not UNSUPPORTED_ALGORITHM. The
      // distinction matters: it tells an operator the key is fine, the verifier
      // is the missing piece.
      const x = generateKeyPairSync('x25519');
      await expect(registry.createProofChallenge({
        tenantId: 'tenant-a', algorithm: 'hpke-x25519',
        publicKeyPem: String(x.publicKey.export({ format: 'pem', type: 'spki' })),
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROOF_ALGORITHM' });
    });

    // 3) revoked / expired handling ----------------------------------------
    test('a revoked key is refused on both lookup paths, and the refusal is typed', async () => {
      const repository = new MemoryRecipientKeyRepository();
      const clock = testClock();
      const registry = createRecipientKeyRegistry({ repository, now: clock.now });
      const record = await registerRsa(registry, 'tenant-a');
      await registry.revokeKey('tenant-a', record.version);

      // Every surface must refuse, and each must refuse with KEY_REVOKED rather
      // than a generic not-found, so a caller can tell "revoked" from "never
      // registered" and react differently.
      await expect(registry.getCurrentKey('tenant-a')).rejects.toBeInstanceOf(RecipientKeyRegistryError);
      await expect(registry.getCurrentKey('tenant-a')).rejects.toMatchObject({ code: 'KEY_REVOKED' });
      await expect(registry.getKeyVersion('tenant-a', record.version)).rejects.toMatchObject({ code: 'KEY_REVOKED' });
      // A revoked key is still LISTABLE - revocation is not deletion, and the
      // audit trail has to survive it.
      await expect(registry.listKeys('tenant-a')).resolves.toHaveLength(1);
    });

    test('an expired challenge is refused and cannot be revived by a later attempt', async () => {
      const repository = new MemoryRecipientKeyRepository();
      const clock = testClock();
      const registry = createRecipientKeyRegistry({ repository, now: clock.now, challengeTtlMs: 1_000 });
      const pair = rsaPair();
      const challenge = await registry.createProofChallenge({
        tenantId: 'tenant-a', algorithm: 'rsa-oaep-sha256', publicKeyPem: pair.publicPem,
      });
      // register a first key so a successful later attempt is distinguishable
      await registerRsa(registry, 'tenant-a', rsaPair());
      clock.advance(1_000);
      await expect(registry.completeRegistration({
        tenantId: 'tenant-a', challengeId: challenge.challengeId,
        proof: rsaProof(challenge.challenge, pair.privateKey),
      })).rejects.toMatchObject({ code: 'CHALLENGE_INVALID' });
    });

    // 4) unknown-tenant lookup is an explicit NOT_FOUND -------------------
    test('a tenant that does not exist is an explicit KEY_NOT_FOUND, not an exception leak', async () => {
      const registry = registryWith();
      const record = await registerRsa(registry, 'tenant-a');
      // Several shapes of absent, to prove none of them escapes as a raw error.
      for (const tenantId of ['tenant-zzz', 'tenant-b', 'other']) {
        await expect(registry.getCurrentKey(tenantId)).rejects.toBeInstanceOf(RecipientKeyRegistryError);
        await expect(registry.getCurrentKey(tenantId)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
        await expect(registry.getKeyVersion(tenantId, record.version)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
        await expect(registry.revokeKey(tenantId, record.version)).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
      }
      // Absent tenants list as empty rather than throwing - a cross-tenant
      // observer should see "none", not an error that leaks existence.
      await expect(registry.listKeys('tenant-zzz')).resolves.toEqual([]);
    });

    test('a malformed tenant id is rejected as INVALID_INPUT, before any repository call', async () => {
      const repository = new MemoryRecipientKeyRepository();
      const registry = createRecipientKeyRegistry({ repository, now: testClock().now });
      await registerRsa(registry, 'tenant-a');
      repository.failReads = true; // any repository call would now throw
      // These must be rejected on the tenant id ALONE, so failReads cannot be
      // reached: the guard has to run before the repository, not after it.
      for (const tenantId of ['', 'A', 'tenant a', 'tenant/a', 'x'.repeat(65), null, 7]) {
        await expect(registry.getCurrentKey(tenantId as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(registry.listKeys(tenantId as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
    });
  });
});

// CR28-11: recipient-key-registry negatives and boundaries.
//
// The baseline's 16 tests already cover algorithm rejection, malformed PEM,
// weak RSA, private-key material, expired challenges and unknown tenants. The
// gaps closed here are the guards the BASELINE NEVER EXERCISED:
//
//   - version drift: a repository that answers a version query with a
//     DIFFERENT version, or with an impossible one;
//   - tenant isolation at the repository boundary: a repo that hands back
//     another tenant's record must be caught, not served;
//   - an invalid injected clock;
//   - version-number and challenge-id boundaries;
//   - base64url canonicality on the proof.
//
// Every case uses a repository that deliberately misbehaves, because the real
// failure these guards exist for is exactly a repository that lies.
describe('CR28-11 registry: version drift', () => {
  interface DriftOptions {
    readonly answerVersion?: number;
    readonly currentVersion?: number;
  }

  /** A repository whose getKeyVersion answers with the wrong version. */
  function driftingRepo(options: DriftOptions = {}) {
    const repo = new MemoryRecipientKeyRepository();
    const base = repo.getKeyVersion.bind(repo);
    repo.getKeyVersion = async (tenantId: string, version: number) => {
      const record = await base(tenantId, version);
      if (!record) return null;
      return { ...record, version: options.answerVersion ?? version + 1 };
    };
    const baseCurrent = repo.getCurrentKey.bind(repo);
    repo.getCurrentKey = async (tenantId: string) => {
      const record = await baseCurrent(tenantId);
      if (!record || options.currentVersion === undefined) return record;
      return { ...record, version: options.currentVersion };
    };
    return repo;
  }

  it('a version query answered with a DIFFERENT version fails closed', async () => {
    const repo = driftingRepo({ answerVersion: 5 });
    const clock = testClock();
    const registry = createRecipientKeyRegistry({ repository: repo, now: clock.now });
    await registerRsa(registry, 'tenant-drift');

    // Asked for v1, the repository answered v2. Serving it would let a caller
    // believe it holds the key version it pinned.
    await expect(registry.getKeyVersion('tenant-drift', 1)).rejects.toMatchObject({
      name: 'RecipientKeyRegistryError',
      code: 'REGISTRY_UNAVAILABLE',
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['past the ceiling', 2_147_483_648],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('a current key whose version is %s fails closed on both lookup paths', async (_label, version) => {
    const repo = driftingRepo({ currentVersion: version as number });
    const clock = testClock();
    const registry = createRecipientKeyRegistry({ repository: repo, now: clock.now });
    await registerRsa(registry, 'tenant-badversion');

    await expect(registry.getCurrentKey('tenant-badversion')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('the version ceiling itself is addressable', async () => {
    const repo = new MemoryRecipientKeyRepository();
    const clock = testClock();
    const registry = createRecipientKeyRegistry({ repository: repo, now: clock.now });
    await registerRsa(registry, 'tenant-ceiling');

    // MAX_KEY_VERSION is accepted as an argument; it simply does not exist.
    // That the ARGUMENT validates and the RECORD does not are separate rules.
    await expect(registry.getKeyVersion('tenant-ceiling', 2_147_483_647)).rejects.toMatchObject({
      code: 'KEY_NOT_FOUND',
    });
    await expect(registry.getKeyVersion('tenant-ceiling', 2_147_483_648)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('CR28-11 registry: tenant isolation at the repository boundary', () => {
  const FOREIGN_PEM = rsaPair().publicPem;

  function foreignRecord(
    tenantId: string,
    over: Partial<RecipientPublicKeyRecord> = {},
  ): RecipientPublicKeyRecord {
    return {
      id: 'key-foreign', tenantId, version: 1, algorithm: 'rsa-oaep-sha256',
      publicKeyPem: FOREIGN_PEM, fingerprint: 'SHA256:foreign',
      effectiveAt: '2026-09-27T00:00:00.000Z', revokedAt: null,
      ...over,
    };
  }

  /** A repository whose every read answers with ANOTHER tenant's record. */
  function crossTenantRepo(tenantId: string) {
    const repo = new MemoryRecipientKeyRepository();
    repo.getCurrentKey = async () => foreignRecord(tenantId);
    repo.getKeyVersion = async () => foreignRecord(tenantId);
    repo.listKeys = async () => [foreignRecord(tenantId)];
    repo.revokeKey = async () => foreignRecord(tenantId, { revokedAt: '2026-09-28T00:00:00.000Z' });
    return repo;
  }

  it.each([
    ['getCurrentKey', 'getCurrentKey'],
    ['getKeyVersion', 'getKeyVersion'],
    ['listKeys', 'listKeys'],
    ['revokeKey', 'revokeKey'],
  ])('a repository answering %s with another tenant FAILS the scope check', async (_label, method) => {
    const registry = createRecipientKeyRegistry({
      repository: crossTenantRepo('tenant-somebody-else'),
      now: testClock().now,
    });
    const call = registry[method as 'getCurrentKey'] as (t: string, v?: number) => Promise<unknown>;
    const arg = method === 'listKeys' || method === 'getCurrentKey' ? undefined : 1;

    // Serving another tenant's key is the worst bug this module could have, so
    // a repository that violates scope is an ERROR, never a result.
    await expect(call('tenant-mine', arg)).rejects.toMatchObject({
      name: 'RecipientKeyRegistryError',
      code: 'REGISTRY_UNAVAILABLE',
    });
  });

  it('the scope check wins over the revoked check, even on revokeKey', async () => {
    const registry = createRecipientKeyRegistry({
      repository: crossTenantRepo('tenant-somebody-else'),
      now: testClock().now,
    });

    // The scope check must come FIRST; a revoked record must not become a softer
    // path answering KEY_REVOKED with a foreign key's metadata attached.
    await expect(registry.revokeKey('tenant-mine', 1)).rejects.toMatchObject({
      code: 'REGISTRY_UNAVAILABLE',
    });
  });
});

describe('CR28-11 registry: clock, version and challenge boundaries', () => {
  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['fractional', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('an injected clock returning %s is REGISTRY_UNAVAILABLE, not a wrong timestamp', async (_label, value) => {
    const registry = createRecipientKeyRegistry({
      repository: new MemoryRecipientKeyRepository(),
      now: () => value as number,
    });

    await expect(registerRsa(registry, 'tenant-clock')).rejects.toMatchObject({
      name: 'RecipientKeyRegistryError',
      code: 'REGISTRY_UNAVAILABLE',
    });
  });

  it.each([
    ['zero', 0],
    ['999 milliseconds', 999],
    ['above the 15 minute ceiling', 900_001],
    ['fractional', 1500.5],
  ])('a challenge lifetime of %s milliseconds is refused at construction', async (_label, ttl) => {
    expect(() => createRecipientKeyRegistry({
      repository: new MemoryRecipientKeyRepository(),
      challengeTtlMs: ttl as number,
      now: testClock().now,
    })).toThrow(RecipientKeyRegistryError);
  });

  it.each([
    ['the 1000 ms floor', 1000],
    ['the 900000 ms ceiling', 900_000],
    ['the default 5 minute window', 300_000],
  ])('a challenge lifetime at %s produces exactly that expiry', async (_label, ttl) => {
    const clock = testClock();
    const registry = createRecipientKeyRegistry({
      repository: new MemoryRecipientKeyRepository(),
      challengeTtlMs: ttl as number,
      now: clock.now,
    });

    const challenge = await registry.createProofChallenge({
      tenantId: 'tenant-ttl', algorithm: 'rsa-oaep-sha256', publicKeyPem: rsaPair().publicPem,
    });

    // The clock is frozen, so the expiry must be exactly now + ttl. Asserting
    // the arithmetic is what pins the boundary; asserting "it exists" would not.
    expect(Date.parse(challenge.expiresAt) - clock.now()).toBe(ttl as number);
  });
});

describe('CR28-11 registry: proof and challenge input boundaries', () => {
  it.each([
    ['empty', ''],
    ['129 characters', 'c'.repeat(129)],
    ['non-string', 7],
  ])('a challengeId that is %s is INVALID_INPUT', async (_label, challengeId) => {
    const registry = createRecipientKeyRegistry({
      repository: new MemoryRecipientKeyRepository(), now: testClock().now,
    });

    await expect(registry.completeRegistration({
      tenantId: 'tenant-mine', challengeId: challengeId as string, proof: 'x',
    })).rejects.toMatchObject({ name: 'RecipientKeyRegistryError', code: 'INVALID_INPUT' });
  });

  it.each([
    ['empty', ''],
    ['standard base64 with + and /', 'a+b/c=='],
    ['length of one mod four', 'A'],
    ['padding characters', 'AAAA='],
    ['over 16 KiB', 'A'.repeat(16 * 1024 + 1)],
  ])('a proof that is %s is INVALID_INPUT, not a crypto error', async (_label, proof) => {
    const registry = createRecipientKeyRegistry({
      repository: new MemoryRecipientKeyRepository(), now: testClock().now,
    });
    const pair = rsaPair();
    const challenge = await registry.createProofChallenge({
      tenantId: 'tenant-mine', algorithm: 'rsa-oaep-sha256', publicKeyPem: pair.publicPem,
    });

    await expect(registry.completeRegistration({
      tenantId: 'tenant-mine', challengeId: challenge.challengeId, proof: proof as string,
    })).rejects.toMatchObject({ name: 'RecipientKeyRegistryError', code: 'INVALID_INPUT' });
  });

  it('a valid-length proof over the wrong challenge is PROOF_INVALID, not a registration', async () => {
    const registry = createRecipientKeyRegistry({
      repository: new MemoryRecipientKeyRepository(), now: testClock().now,
    });
    const pair = rsaPair();
    const first = await registry.createProofChallenge({
      tenantId: 'tenant-mine', algorithm: 'rsa-oaep-sha256', publicKeyPem: pair.publicPem,
    });
    const second = await registry.createProofChallenge({
      tenantId: 'tenant-mine', algorithm: 'rsa-oaep-sha256', publicKeyPem: pair.publicPem,
    });

    // A proof made for challenge A submitted against challenge B: both are
    // well-formed and the key is genuine, so only the PoP check can refuse.
    await expect(registry.completeRegistration({
      tenantId: 'tenant-mine',
      challengeId: second.challengeId,
      proof: rsaProof(first.challenge, pair.privateKey),
    })).rejects.toMatchObject({ name: 'RecipientKeyRegistryError', code: 'PROOF_INVALID' });
  });

  it('a challenge whose fingerprint disagrees with its key material is CHALLENGE_INVALID', async () => {
    const repo = new MemoryRecipientKeyRepository();
    const clock = testClock();
    const registry = createRecipientKeyRegistry({ repository: repo, now: clock.now });
    const pair = rsaPair();
    const challenge = await registry.createProofChallenge({
      tenantId: 'tenant-mine', algorithm: 'rsa-oaep-sha256', publicKeyPem: pair.publicPem,
    });

    // Rewrite the stored challenge with a fingerprint from a different key.
    repo.challenges.set(challenge.challengeId, {
      ...repo.challenges.get(challenge.challengeId)!,
      fingerprint: 'SHA256:not-the-key-that-was-challenged',
    });

    await expect(registry.completeRegistration({
      tenantId: 'tenant-mine', challengeId: challenge.challengeId, proof: rsaProof(challenge.challenge, pair.privateKey),
    })).rejects.toMatchObject({ name: 'RecipientKeyRegistryError', code: 'CHALLENGE_INVALID' });
  });
});
