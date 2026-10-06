// VENDORED from @du/observability @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/observability/src/logger.ts (lines=169) sha256=E8C320758120E1CC57997A8D7511D2F8269F0E0E42E92A9409E52D676F73A7C5
// why: createLogger for src/main.ts

import { randomUUID } from 'node:crypto';
import { currentContext, CorrelationContext } from './context';
import { metadataLogRecord } from './log-metadata';

/** One JSON line per record; required schema fields are always emitted. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type LogEnvironment = 'dev' | 'test' | 'staging' | 'prod';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  service: string;
  version: string;
  environment: LogEnvironment;
  correlationId: string;
  operationId: string | null;
  taskId: string | null;
  invocationId: string | null;
  message: string;
  [key: string]: unknown;
}

export interface LogSink {
  write(line: string): void;
}

export const consoleSink: LogSink = {
  write(line: string): void {
    process.stdout.write(line + '\n');
  },
};

export interface LoggerOptions {
  /** Preferred stable service identifier. */
  service?: string;
  /** Deploy version; defaults to DU_SERVICE_VERSION, APP_VERSION, or `unknown`. */
  version?: string;
  /** @deprecated Compatibility alias for `service`. */
  component?: string;
  environment?: LogEnvironment;
  level?: LogLevel;
  sink?: LogSink;
  /** Fixed additional fields added to every record (all are redacted). */
  baseFields?: Record<string, unknown>;
  now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 5, debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED_FIELDS = new Set([
  'component', 'ts', 'msg', 'timestamp', 'level', 'service', 'version', 'environment',
  'correlationId', 'operationId', 'taskId', 'invocationId', 'message',
]);

function resolveEnvironment(value?: LogEnvironment): LogEnvironment {
  const configured = value ?? process.env.DU_ENVIRONMENT ?? process.env.APP_ENV ?? process.env.NODE_ENV;
  switch (configured?.toLowerCase()) {
    case 'test':
      return 'test';
    case 'staging':
      return 'staging';
    case 'prod':
    case 'production':
      return 'prod';
    case 'dev':
    case 'development':
    default:
      return 'dev';
  }
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveVersion(value?: string): string {
  const configured = value ?? process.env.DU_SERVICE_VERSION ?? process.env.APP_VERSION;
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : 'unknown';
}

export class Logger {
  private readonly service: string;
  private readonly version: string;
  private readonly environment: LogEnvironment;
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly baseFields: Record<string, unknown>;
  private readonly now: () => Date;

  constructor(opts: LoggerOptions) {
    const service = opts.service ?? opts.component;
    if (!service || !service.trim()) throw new TypeError('logger service is required');
    this.service = service;
    this.version = resolveVersion(opts.version);
    this.environment = resolveEnvironment(opts.environment);
    this.level = opts.level ?? 'info';
    this.sink = opts.sink ?? consoleSink;
    this.baseFields = opts.baseFields ?? {};
    this.now = opts.now ?? (() => new Date());
  }

  child(fields: Record<string, unknown>): Logger {
    return new Logger({
      service: this.service,
      version: this.version,
      environment: this.environment,
      level: this.level,
      sink: this.sink,
      baseFields: { ...this.baseFields, ...fields },
      now: this.now,
    });
  }

  trace(message: string, fields?: Record<string, unknown>): void {
    this.emit('trace', message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.emit('error', message, fields);
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const context: CorrelationContext | undefined = currentContext();
    const combinedFields: Record<string, unknown> = {
      ...this.baseFields,
      ...(context?.operationId ? { operationId: context.operationId } : {}),
      ...(context?.tenantId ? { tenantId: context.tenantId } : {}),
      ...(context?.businessId ? { businessId: context.businessId } : {}),
      ...(context?.businessVersion ? { businessVersion: context.businessVersion } : {}),
      ...(context?.stepKey ? { stepKey: context.stepKey } : {}),
      ...(context?.leaseEpoch !== undefined ? { leaseEpoch: context.leaseEpoch } : {}),
      ...fields,
    };
    const correlationId = context?.correlationId ?? optionalId(combinedFields.correlationId) ?? randomUUID();
    const operationId = optionalId(context?.operationId ?? combinedFields.operationId);
    const taskId = optionalId(context?.taskId ?? combinedFields.taskId);
    const invocationId = optionalId(context?.invocationId ?? combinedFields.invocationId);
    for (const key of RESERVED_FIELDS) delete combinedFields[key];

    const record: LogRecord = {
      ...combinedFields,
      timestamp: this.now().toISOString(),
      level,
      service: this.service,
      version: this.version,
      environment: this.environment,
      correlationId,
      operationId,
      taskId,
      invocationId,
      message,
    };
    this.sink.write(JSON.stringify(metadataLogRecord(record)));
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new Logger(opts);
}
