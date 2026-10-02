export interface LcCheckerProcessConfig {
  runtimeUrl: string;
  runtimeToken: string;
  connectorUrl: string;
  connectorServiceToken: string;
  redisUrl: string;
  concurrency: number;
  heartbeatIntervalMs: number;
  workerInstanceId?: string;
  imageDigest?: string;
  shutdownGraceMs: number;
  maxArtifactBytes: number;
}

function requireValue(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(name + ' is required');
  }
  return value;
}

function parseUrl(value: string, name: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(name + ' must be a valid URL');
  }
}

function parseInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
  minimum: number
): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(name + ' must be an integer greater than or equal to ' + minimum);
  }
  return parsed;
}

export function parseWorkerConfig(
  env: Record<string, string | undefined> = process.env
): LcCheckerProcessConfig {
  return {
    runtimeUrl: parseUrl(requireValue(env, 'RUNTIME_URL'), 'RUNTIME_URL'),
    runtimeToken: requireValue(env, 'RUNTIME_TOKEN'),
    connectorUrl: parseUrl(requireValue(env, 'CONNECTOR_URL'), 'CONNECTOR_URL'),
    connectorServiceToken: requireValue(env, 'CONNECTOR_SERVICE_TOKEN'),
    redisUrl: requireValue(env, 'REDIS_URL'),
    concurrency: parseInteger(env['CONCURRENCY'], 1, 'CONCURRENCY', 1),
    heartbeatIntervalMs: parseInteger(env['HEARTBEAT_INTERVAL_MS'], 10_000, 'HEARTBEAT_INTERVAL_MS', 100),
    workerInstanceId: env['WORKER_INSTANCE_ID'] || undefined,
    imageDigest: env['IMAGE_DIGEST'] || undefined,
    shutdownGraceMs: parseInteger(env['SHUTDOWN_GRACE_MS'], 15_000, 'SHUTDOWN_GRACE_MS', 0),
    // DATA-04 band: one LC document is a PDF; 64 MiB is the single-request ceiling.
    maxArtifactBytes: parseInteger(env['MAX_ARTIFACT_BYTES'], 64 * 1024 * 1024, 'MAX_ARTIFACT_BYTES', 1024),
  };
}
