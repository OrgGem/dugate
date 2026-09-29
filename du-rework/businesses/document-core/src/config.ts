import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const WorkerEnvSchema = z.object({
  RUNTIME_URL: z.string().url({ message: 'RUNTIME_URL must be a valid URL' }),
  RUNTIME_TOKEN: z.string().min(1, { message: 'RUNTIME_TOKEN is required' }),
  REDIS_URL: z.string().min(1, { message: 'REDIS_URL is required' }),
  CONNECTOR_URL: z.string().url({ message: 'CONNECTOR_URL must be a valid URL' }).optional(),
  CONNECTOR_SERVICE_TOKEN: z.string().refine((value) => value.trim().length > 0, {
    message: 'CONNECTOR_SERVICE_TOKEN must not be empty',
  }).optional(),
  CONCURRENCY: z
    .string()
    .optional()
    .transform((val) => (val !== undefined && val !== '' ? parseInt(val, 10) : 1))
    .pipe(z.number().int().min(1, { message: 'CONCURRENCY must be at least 1' })),
  HEARTBEAT_INTERVAL_MS: z
    .string()
    .optional()
    .transform((val) => (val !== undefined && val !== '' ? parseInt(val, 10) : 10_000))
    .pipe(z.number().int().min(100, { message: 'HEARTBEAT_INTERVAL_MS must be at least 100ms' })),
  WORKER_INSTANCE_ID: z.string().optional(),
  IMAGE_DIGEST: z.string().optional(),
  SHUTDOWN_GRACE_MS: z
    .string()
    .optional()
    .transform((val) => (val !== undefined && val !== '' ? parseInt(val, 10) : 15_000))
    .pipe(z.number().int().min(0, { message: 'SHUTDOWN_GRACE_MS cannot be negative' })),
}).superRefine((value, context) => {
  if (value.CONNECTOR_URL && !value.CONNECTOR_SERVICE_TOKEN) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CONNECTOR_SERVICE_TOKEN'],
      message: 'CONNECTOR_SERVICE_TOKEN is required when CONNECTOR_URL is configured',
    });
  }
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export interface DocumentCoreServiceConfig {
  runtimeUrl: string;
  runtimeToken: string;
  redisUrl: string;
  connectorUrl?: string;
  connectorServiceToken?: string;
  concurrency: number;
  heartbeatIntervalMs: number;
  workerInstanceId: string;
  imageDigest: string;
  shutdownGraceMs: number;
}

/**
 * Validates and parses environment variables into DocumentCoreServiceConfig.
 * Throws a formatted Error if required variables are missing or invalid.
 */
export function parseWorkerConfig(env: Record<string, string | undefined> = process.env): DocumentCoreServiceConfig {
  const result = WorkerEnvSchema.safeParse(env);
  if (!result.success) {
    const errorMessages = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid worker configuration: ${errorMessages}`);
  }

  const data = result.data;
  return {
    runtimeUrl: data.RUNTIME_URL,
    runtimeToken: data.RUNTIME_TOKEN,
    redisUrl: data.REDIS_URL,
    connectorUrl: data.CONNECTOR_URL,
    connectorServiceToken: data.CONNECTOR_SERVICE_TOKEN,
    concurrency: data.CONCURRENCY,
    heartbeatIntervalMs: data.HEARTBEAT_INTERVAL_MS,
    workerInstanceId: data.WORKER_INSTANCE_ID || `worker-document-core-${randomUUID()}`,
    imageDigest: data.IMAGE_DIGEST || 'sha256:placeholder-document-core-v1',
    shutdownGraceMs: data.SHUTDOWN_GRACE_MS,
  };
}

/**
 * Returns a sanitized copy of DocumentCoreServiceConfig with secrets redacted for safe logging.
 */
export function getRedactedConfig(config: DocumentCoreServiceConfig): Record<string, unknown> {
  return {
    runtimeUrl: config.runtimeUrl,
    runtimeToken: '[REDACTED]',
    redisUrl: config.redisUrl,
    connectorUrl: config.connectorUrl,
    connectorServiceToken: config.connectorServiceToken === undefined ? undefined : '[REDACTED]',
    concurrency: config.concurrency,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    workerInstanceId: config.workerInstanceId,
    imageDigest: config.imageDigest,
    shutdownGraceMs: config.shutdownGraceMs,
  };
}
