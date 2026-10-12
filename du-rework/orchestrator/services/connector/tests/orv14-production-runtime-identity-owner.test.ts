import { connectorRuntimeControlFromEnvironment, connectorRuntimeIdentityFromEnvironment } from '../src/runtime-control-environment';

describe('Connector production runtime-control identity configuration', () => {
  it('fails before composition when a production runtime tuple is missing', () => {
    expect(() => connectorRuntimeControlFromEnvironment({ NODE_ENV: 'production' }))
      .toThrow('Connector runtime-control identity is required in production.');
  });

  it('keeps local/test environments optional and validates production tuples strictly', () => {
    expect(connectorRuntimeIdentityFromEnvironment({ NODE_ENV: 'test' })).toBeUndefined();
    const identity = connectorRuntimeIdentityFromEnvironment({
      CONNECTOR_RUNTIME_SLOT: 'blue',
      CONNECTOR_RUNTIME_IDENTITY: 'connector-blue-1',
      CONNECTOR_REPLICA_ID: 'connector-replica-1',
      CONNECTOR_RUNTIME_REVISION: 'release-14',
      CONNECTOR_RUNTIME_IMAGE_DIGEST: `registry.example/connector@sha256:${'a'.repeat(64)}`,
    }, { required: true });
    expect(identity).toEqual({
      slot: 'blue', runtimeIdentity: 'connector-blue-1', replicaId: 'connector-replica-1',
      revision: 'release-14', imageDigest: `registry.example/connector@sha256:${'a'.repeat(64)}`,
    });
    expect(() => connectorRuntimeIdentityFromEnvironment({ NODE_ENV: 'production', CONNECTOR_RUNTIME_SLOT: 'blue' }, { required: true }))
      .toThrow('all-or-none');
  });

  it('still requires an exact identity for source-off restore rehearsal', () => {
    expect(() => connectorRuntimeControlFromEnvironment({
      NODE_ENV: 'production', CONNECTOR_ISOLATED_RUNTIME_MODE: 'restore-rehearsal',
    })).toThrow('Connector restore rehearsal requires an exact runtime-control identity.');
    expect(connectorRuntimeControlFromEnvironment({
      NODE_ENV: 'production', CONNECTOR_ISOLATED_RUNTIME_MODE: 'restore-rehearsal',
      CONNECTOR_RUNTIME_SLOT: 'green',
      CONNECTOR_RUNTIME_IDENTITY: 'connector-restore-green',
      CONNECTOR_REPLICA_ID: 'connector-restore-replica',
      CONNECTOR_RUNTIME_REVISION: 'restore-r14',
      CONNECTOR_RUNTIME_IMAGE_DIGEST: `registry.example/connector@sha256:${'b'.repeat(64)}`,
    }).isolatedRestoreRehearsal).toBe(true);
  });
});
