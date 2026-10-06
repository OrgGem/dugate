import {
  authenticateLocalPassword,
  createLocalLoginGuard,
  hashLocalPassword,
  mintLocalSession,
  readLocalSession,
  verifyLocalPassword,
  type LocalCredentialReader,
  type LocalCredentialRecord,
  type LocalSessionRecord,
  type LocalSessionRepository,
} from '../src/modules/auth/local-primitives';

const PASSWORD = 'correct horse battery staple';
const DUMMY_PASSWORD = 'reserved dummy verifier value';

let passwordHash: string;
let dummyPasswordHash: string;

beforeAll(async () => {
  passwordHash = await hashLocalPassword(PASSWORD);
  dummyPasswordHash = await hashLocalPassword(DUMMY_PASSWORD);
});

function credentialReader(
  record: LocalCredentialRecord | null,
): jest.Mocked<LocalCredentialReader> {
  return {
    findByLogin: jest.fn(async (_login: string) => record),
  };
}

function authDependencies(
  credentials: LocalCredentialReader,
  loginGuard = createLocalLoginGuard(),
) {
  return {
    credentials,
    loginGuard,
    dummyPasswordHash,
    subjectKeyForLogin: (login: string) => login.trim().toLowerCase(),
  };
}

function validAccount(overrides: Partial<LocalCredentialRecord> = {}): LocalCredentialRecord {
  return {
    subjectId: 'user-17',
    passwordHash,
    role: 'admin',
    tenantId: 'tenant-4',
    ...overrides,
  };
}

class MemorySessionRepository implements LocalSessionRepository {
  readonly records = new Map<string, LocalSessionRecord>();

  async insert(tokenDigest: string, record: Omit<LocalSessionRecord, 'tokenDigest'>): Promise<void> {
    this.records.set(tokenDigest, { tokenDigest, ...record });
  }

  async findByTokenDigest(tokenDigest: string): Promise<LocalSessionRecord | null> {
    return this.records.get(tokenDigest) ?? null;
  }
}

describe('local auth primitives', () => {
  test('uses a salted verifier and verifies correct and incorrect passwords', async () => {
    const independentHash = await hashLocalPassword(PASSWORD);

    expect(independentHash).not.toBe(passwordHash);
    await expect(verifyLocalPassword(PASSWORD, passwordHash)).resolves.toBe(true);
    await expect(verifyLocalPassword('incorrect password', passwordHash)).resolves.toBe(false);
  });

  test('returns a server-derived local principal for valid credentials', async () => {
    const credentials = credentialReader(validAccount());
    const result = await authenticateLocalPassword(
      { login: ' Alice ', password: PASSWORD },
      authDependencies(credentials),
    );

    expect(result).toEqual({
      authenticated: true,
      principal: {
        issuer: 'du-local',
        sub: 'user-17',
        role: 'admin',
        tenantId: 'tenant-4',
      },
    });
  });

  test('uses the same generic 401 result for unknown users and wrong passwords', async () => {
    const knownUserReader = credentialReader(validAccount());
    const unknownUserReader = credentialReader(null);
    const wrongPassword = await authenticateLocalPassword(
      { login: 'alice', password: 'wrong password' },
      authDependencies(knownUserReader),
    );
    const unknownUser = await authenticateLocalPassword(
      { login: 'nobody', password: 'wrong password' },
      authDependencies(unknownUserReader),
    );

    expect(wrongPassword).toBe(unknownUser);
    expect(wrongPassword).toEqual({
      authenticated: false,
      status: 401,
      body: { error: 'Invalid credentials' },
    });
    expect(knownUserReader.findByLogin).toHaveBeenCalledTimes(1);
    expect(unknownUserReader.findByLogin).toHaveBeenCalledTimes(1);
  });

  test('locks an identity after the configured number of password failures', async () => {
    const credentials = credentialReader(validAccount());
    let now = 1_000;
    const guard = createLocalLoginGuard({
      maxAttemptsPerWindow: 10,
      maxFailures: 2,
      windowMs: 60_000,
      lockoutMs: 5_000,
      maxSubjects: 10,
      now: () => now,
    });
    const dependencies = authDependencies(credentials, guard);

    const first = await authenticateLocalPassword(
      { login: 'alice', password: 'bad one' },
      dependencies,
    );
    const second = await authenticateLocalPassword(
      { login: 'alice', password: 'bad two' },
      dependencies,
    );
    const locked = await authenticateLocalPassword(
      { login: 'alice', password: PASSWORD },
      dependencies,
    );

    expect(first).toEqual(second);
    expect(locked).toBe(first);
    expect(credentials.findByLogin).toHaveBeenCalledTimes(2);

    now += 5_000;
    await expect(guard.beginAttempt('alice')).resolves.toMatchObject({ allowed: true });
  });

  test('bounds rate attempts and retained subject state, failing closed at capacity', async () => {
    let now = 2_000;
    const guard = createLocalLoginGuard({
      maxAttemptsPerWindow: 1,
      maxFailures: 1,
      windowMs: 1_000,
      lockoutMs: 1_000,
      maxSubjects: 1,
      now: () => now,
    });

    await expect(guard.beginAttempt('alice')).resolves.toMatchObject({ allowed: true });
    await expect(guard.beginAttempt('alice')).resolves.toMatchObject({ reason: 'rate-limited' });
    await expect(guard.beginAttempt('bob')).resolves.toMatchObject({ reason: 'capacity' });

    now += 1_000;
    await expect(guard.beginAttempt('bob')).resolves.toMatchObject({ allowed: true });
  });

  test('mints an opaque token with du-local issuer and rejects it at expiry', async () => {
    const repository = new MemorySessionRepository();
    let now = 10_000;
    const minted = await mintLocalSession(
      { sub: 'user-17', role: 'admin', tenantId: 'tenant-4' },
      repository,
      { ttlMs: 2_000, now: () => now },
    );
    const [storedDigest, storedRecord] = [...repository.records.entries()][0] ?? [];

    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.token).not.toContain('.');
    expect(minted.token.split('.')).toHaveLength(1);
    expect(storedDigest).not.toBe(minted.token);
    expect(storedRecord).toMatchObject({
      tokenDigest: storedDigest,
      issuer: 'du-local',
      sub: 'user-17',
      role: 'admin',
      tenantId: 'tenant-4',
      issuedAt: 10_000,
      expiresAt: 12_000,
    });

    now = 11_999;
    await expect(readLocalSession(minted.token, repository, { now: () => now })).resolves.toEqual({
      issuer: 'du-local',
      sub: 'user-17',
      role: 'admin',
      tenantId: 'tenant-4',
    });
    now = 12_000;
    await expect(readLocalSession(minted.token, repository, { now: () => now })).resolves.toBeNull();
  });
});
