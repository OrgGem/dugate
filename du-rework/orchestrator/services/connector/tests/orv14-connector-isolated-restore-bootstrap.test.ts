import {
  ConnectorRestoreRuntimeConfigSchema,
  ConnectorRestoreRuntimeSecretsSchema,
  parseConnectorRestoreBootstrapArgs,
  startConnectorIsolatedRestore,
} from '../src/isolated-restore-bootstrap';

const key = Buffer.alloc(32, 7).toString('base64');
const imageDigest = `registry.invalid/connector@sha256:${'a'.repeat(64)}`;
const config = {
  schemaVersion: 1 as const,
  service: 'connector' as const,
  clusterName: 'restore-cluster',
  runtimeIdentity: 'connector-restore-blue',
  revision: 'restore-r1',
  imageDigest,
  replicaId: 'connector-restore-blue-replica',
  slot: 'blue' as const,
  bindHost: '0.0.0.0' as const,
  port: 8080,
  database: { host: '127.0.0.1', port: 55432, user: 'du_restore', sslMode: 'disable' as const },
  redis: { host: '127.0.0.1', port: 56379 },
  databaseName: 'du_restore_connector',
  targetGenerationId: '11111111-1111-4111-8111-111111111111',
};
const secrets = {
  schemaVersion: 1 as const,
  service: 'connector' as const,
  serviceRuntime: {
    slot: config.slot,
    runtimeIdentity: config.runtimeIdentity,
    replicaId: config.replicaId,
    revision: config.revision,
    imageDigest,
  },
  serviceIdentitySecretBase64: key,
  invocationGrantSecretBase64: key,
  credentialEncryptionKeyBase64: key,
  invocationEncryptionKeys: { keyRef: 'connector-invocation-v1', activeVersion: 1, keys: { '1': key } },
};

describe('ORV14 Connector isolated restore bootstrap', () => {
  it('parses only the fixed mounted files and complete digest pins', () => {
    expect(parseConnectorRestoreBootstrapArgs([
      '--config', '/run/du-restore/runtime-config.json', '--config-sha256', 'a'.repeat(64),
      '--secrets', '/run/du-restore/runtime-secrets.json', '--secrets-sha256', 'b'.repeat(64),
      '--pg-password-file', '/run/du-restore/pg-password', '--pg-password-sha256', 'c'.repeat(64),
      '--gate-dir', '/run/du-restore/start-gate', '--runtime-identity', config.runtimeIdentity,
      '--target-generation-id', config.targetGenerationId, '--image-digest', imageDigest,
    ])).toMatchObject({ runtimeIdentity: config.runtimeIdentity, targetGenerationId: config.targetGenerationId });
    expect(() => parseConnectorRestoreBootstrapArgs([
      '--config', '/tmp/runtime-config.json', '--config-sha256', 'a'.repeat(64),
      '--secrets', '/run/du-restore/runtime-secrets.json', '--secrets-sha256', 'b'.repeat(64),
      '--pg-password-file', '/run/du-restore/pg-password', '--pg-password-sha256', 'c'.repeat(64),
      '--gate-dir', '/run/du-restore/start-gate', '--runtime-identity', config.runtimeIdentity,
      '--target-generation-id', config.targetGenerationId, '--image-digest', imageDigest,
    ])).toThrow('Connector restore bootstrap pins are invalid.');
  });

  it('rejects runtime-secret extensions and mismatched per-process identity', () => {
    expect(ConnectorRestoreRuntimeConfigSchema.parse(config).targetGenerationId).toBe(config.targetGenerationId);
    expect(ConnectorRestoreRuntimeSecretsSchema.parse(secrets).serviceRuntime.runtimeIdentity).toBe(config.runtimeIdentity);
    expect(() => ConnectorRestoreRuntimeSecretsSchema.parse({ ...secrets, unexpected: 'secret' })).toThrow();
    expect(() => ConnectorRestoreRuntimeConfigSchema.parse({ ...config, service: 'orchestrator' })).toThrow();
  });

  it('waits for the protected startup gate before constructing or starting the app', async () => {
    const events: string[] = [];
    let seenConfig: import('../src/composition').ConnectorConfig | undefined;
    const composition = await startConnectorIsolatedRestore({ config, secrets, pgPassword: 'restore-only-password', gateDir: '/run/du-restore/start-gate' }, {
      waitForGate: async () => { events.push('gate'); },
      createComposition: (value) => {
        events.push('construct');
        seenConfig = value;
        return {
          start: async () => { events.push('start'); },
          shutdown: async () => {},
        };
      },
    });
    expect(events).toEqual(['gate', 'construct', 'start']);
    expect(seenConfig?.isolatedRestoreRehearsal).toBe(true);
    expect(seenConfig?.runtimeControl).toMatchObject({ replicaId: config.replicaId, runtimeIdentity: config.runtimeIdentity });
    expect(seenConfig?.vaultRuntime).toBeNull();
    expect(seenConfig?.costControl).toBeUndefined();
    expect(seenConfig?.databaseUrl).not.toContain('restore-only-password');
    expect(typeof seenConfig?.databasePassword).toBe('function');
    expect((seenConfig?.databasePassword as () => string)()).toBe('restore-only-password');
    expect(seenConfig?.redisUrl).not.toContain('restore-only-password');
    expect(composition).toBeDefined();
  });
});
