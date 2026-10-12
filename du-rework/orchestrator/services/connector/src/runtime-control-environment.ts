import { ConnectorReplicaIdentitySchema } from '@du/contracts';
import { connectorIsolatedRestoreModeFromEnvironment } from './isolated-mode';

const RUNTIME_CONTROL_ENV_KEYS = [
  'CONNECTOR_RUNTIME_SLOT',
  'CONNECTOR_RUNTIME_IDENTITY',
  'CONNECTOR_REPLICA_ID',
  'CONNECTOR_RUNTIME_REVISION',
  'CONNECTOR_RUNTIME_IMAGE_DIGEST',
] as const;

export function connectorRuntimeIdentityFromEnvironment(
  env: NodeJS.ProcessEnv,
  options: { required?: boolean } = {},
) {
  const present = RUNTIME_CONTROL_ENV_KEYS.filter((key) => env[key] !== undefined && env[key] !== '');
  if (present.length === 0) {
    if (options.required) throw new Error('Connector runtime-control identity is required in production.');
    return undefined;
  }
  if (present.length !== RUNTIME_CONTROL_ENV_KEYS.length) {
    throw new Error('Connector runtime-control environment must be configured all-or-none.');
  }
  return ConnectorReplicaIdentitySchema.parse({
    slot: env.CONNECTOR_RUNTIME_SLOT,
    runtimeIdentity: env.CONNECTOR_RUNTIME_IDENTITY,
    replicaId: env.CONNECTOR_REPLICA_ID,
    revision: env.CONNECTOR_RUNTIME_REVISION,
    imageDigest: env.CONNECTOR_RUNTIME_IMAGE_DIGEST,
  });
}

export function connectorRuntimeControlFromEnvironment(env: NodeJS.ProcessEnv) {
  const isolatedRestoreRehearsal = connectorIsolatedRestoreModeFromEnvironment(env);
  const runtimeControl = connectorRuntimeIdentityFromEnvironment(env, {
    required: env.NODE_ENV === 'production' && !isolatedRestoreRehearsal,
  });
  if (isolatedRestoreRehearsal && !runtimeControl) {
    throw new Error('Connector restore rehearsal requires an exact runtime-control identity.');
  }
  return { runtimeControl, isolatedRestoreRehearsal };
}
