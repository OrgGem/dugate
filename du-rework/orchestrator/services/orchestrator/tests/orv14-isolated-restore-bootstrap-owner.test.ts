import {
  buildIsolatedRestoreServerConfig,
  parseIsolatedOrchestratorRuntimeConfig,
  parseIsolatedOrchestratorRuntimeSecrets,
  parseIsolatedRestoreBootstrapArgs,
  type IsolatedOrchestratorRuntimeSecrets,
} from '../src/isolated-restore-bootstrap';

const targetGenerationId = '11111111-1111-4111-8111-111111111111';
const runtimeIdentity = 'orch-restore-runtime';
const imageDigest = `orchestrator@sha256:${'a'.repeat(64)}`;
const runtimeConfig = {
  schemaVersion: 1,
  service: 'orchestrator',
  clusterName: 'orchestrator-isolated',
  runtimeIdentity,
  revision: 'build-restore-1',
  imageDigest,
  slot: 'green',
  bindHost: '0.0.0.0',
  port: 3000,
  internalHost: '127.0.0.1',
  internalPort: 3002,
  adminShellHost: '127.0.0.1',
  adminShellPort: 3001,
  database: { host: '127.0.0.1', port: 5432, user: 'restore_user', sslMode: 'disable' },
  redis: { host: '127.0.0.1', port: 6379 },
  databaseName: 'du_orchestrator_restore',
  targetGenerationId,
} as const;

const secrets: IsolatedOrchestratorRuntimeSecrets = {
  schemaVersion: 1,
  service: 'orchestrator',
  serviceRuntime: {
    serviceRuntimeId: runtimeIdentity,
    runtimeIdentity,
    replicaId: runtimeIdentity,
    slot: 'green',
    revision: 'build-restore-1',
    imageDigest,
    controlToken: 'control-token-012345678901234567890123456789',
  },
  admin: {
    localServiceSecret: 'local-service-012345678901234567890123456789',
    shellCookieSecret: 'shell-cookie-012345678901234567890123456789',
  },
  vaultTransit: {
    vaultAddress: 'https://vault.example.test',
    allowedKeyRefs: { 'transit/metadata': 'metadata', 'transit/uploads': 'uploads' },
    metadataKeyRef: 'transit/metadata',
    publicUploadKeyRef: 'transit/uploads',
    encryptToken: 'encrypt-token-012345678901234567890123456789',
    decryptToken: 'decrypt-token-012345678901234567890123456789',
  },
  secretCatalogKeyring: { activeVersion: 'catalog-v1', keys: { 'catalog-v1': Buffer.alloc(32, 7).toString('base64') } },
  profileCipherKey: 'profile-cipher-key-012345678901234567890123456789',
};

const args: string[] = [
  '--config', '/run/du-restore/runtime-config.json',
  '--config-sha256', 'a'.repeat(64),
  '--secrets', '/run/du-restore/runtime-secrets.json',
  '--secrets-sha256', 'b'.repeat(64),
  '--pg-password-file', '/run/du-restore/pg-password',
  '--pg-password-sha256', 'c'.repeat(64),
  '--gate-dir', '/run/du-restore/start-gate',
  '--runtime-identity', runtimeIdentity,
  '--target-generation-id', targetGenerationId,
  '--image-digest', imageDigest,
];

describe('Orchestrator isolated restore bootstrap', () => {
  test('accepts only the fixed complete CLI shape', () => {
    expect(parseIsolatedRestoreBootstrapArgs(args).runtimeIdentity).toBe(runtimeIdentity);
    expect(() => parseIsolatedRestoreBootstrapArgs([...args, '--unexpected', 'value']))
      .toThrow('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
    expect(() => parseIsolatedRestoreBootstrapArgs([...args, '--config', '/tmp/other']))
      .toThrow('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
    expect(() => parseIsolatedRestoreBootstrapArgs(args.slice(0, -2)))
      .toThrow('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
  });

  test('binds runtime config to the explicit target and loopback-only control listeners', () => {
    const parsed = parseIsolatedOrchestratorRuntimeConfig(runtimeConfig, parseIsolatedRestoreBootstrapArgs(args));
    expect(parsed.adminShellPort).toBe(3001);
    expect(() => parseIsolatedOrchestratorRuntimeConfig({ ...runtimeConfig, adminShellHost: '0.0.0.0' }, parseIsolatedRestoreBootstrapArgs(args)))
      .toThrow('RESTORE_BOOTSTRAP_RUNTIME_CONFIG_INVALID');
    expect(() => parseIsolatedOrchestratorRuntimeConfig({ ...runtimeConfig, targetGenerationId: '22222222-2222-4222-8222-222222222222' }, parseIsolatedRestoreBootstrapArgs(args)))
      .toThrow('RESTORE_BOOTSTRAP_RUNTIME_CONFIG_INVALID');
  });

  test('strictly binds protected secrets to the pinned process and refuses cross-service or malformed pins', () => {
    const config = parseIsolatedOrchestratorRuntimeConfig(runtimeConfig, parseIsolatedRestoreBootstrapArgs(args));
    expect(parseIsolatedOrchestratorRuntimeSecrets(secrets, config, secrets.serviceRuntime.controlToken).service)
      .toBe('orchestrator');
    expect(() => parseIsolatedOrchestratorRuntimeSecrets(secrets, config, 'different-control-token-01234567890123456789'))
      .toThrow('RESTORE_BOOTSTRAP_RUNTIME_IDENTITY_MISMATCH');
    expect(() => parseIsolatedOrchestratorRuntimeSecrets({ ...secrets, unexpected: 'value' }, config, secrets.serviceRuntime.controlToken))
      .toThrow('RESTORE_BOOTSTRAP_RUNTIME_SECRETS_INVALID');
    expect(() => parseIsolatedOrchestratorRuntimeSecrets({
      ...secrets,
      secretCatalogKeyring: { activeVersion: 'catalog-v1', keys: { 'catalog-v1': 'not-a-32-byte-key' } },
    }, config, secrets.serviceRuntime.controlToken)).toThrow('RESTORE_BOOTSTRAP_SECRET_KEYRING_INVALID');
  });

  test('builds isolated server config in memory without mutating process environment', () => {
    const config = parseIsolatedOrchestratorRuntimeConfig(runtimeConfig, parseIsolatedRestoreBootstrapArgs(args));
    const parsedSecrets = parseIsolatedOrchestratorRuntimeSecrets(secrets, config, secrets.serviceRuntime.controlToken);
    const before = process.env.ENCRYPTION_KEY;
    const result = buildIsolatedRestoreServerConfig(config, parsedSecrets, 'p@ss:/?# value');
    expect(result.databaseUrl).toContain('p%40ss%3A%2F%3F%23%20value');
    expect(result.isolatedRuntimeMode).toBe('restore-rehearsal');
    expect(result.autoMigrate).toBe(false);
    expect(result.autoDispatch).toBe(false);
    expect(result.profileCipherKey).toBe(secrets.profileCipherKey);
    expect(result.adminShellHost).toBe('127.0.0.1');
    expect(process.env.ENCRYPTION_KEY).toBe(before);
    expect(result.serviceRuntime?.controlToken).toBe(secrets.serviceRuntime.controlToken);
    expect(result.databaseUrl).not.toContain(secrets.serviceRuntime.controlToken);
    expect(result.redisUrl).not.toContain(secrets.vaultTransit.encryptToken);
  });
});
