import { currentContext, CorrelationContext } from './context';
import { redact } from './redaction';

/**
 * Structured JSON logger (docs 12). One JSON line per record to stdout;
 * redaction applied to all fields by default. No secret/prompt/document
 * content is ever emitted.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
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
  component: string;
  level?: LogLevel;
  sink?: LogSink;
  /** Fixed fields added to every record (bounded labels only). */
  baseFields?: Record<string, unknown>;
  now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly component: string;
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly baseFields: Record<string, unknown>;
  private readonly now: () => Date;

  constructor(opts: LoggerOptions) {
    this.component = opts.component;
    this.level = opts.level ?? 'info';
    this.sink = opts.sink ?? consoleSink;
    this.baseFields = opts.baseFields ?? {};
    this.now = opts.now ?? (() => new Date());
  }

  child(fields: Record<string, unknown>): Logger {
    return new Logger({
      component: this.component,
      level: this.level,
      sink: this.sink,
      baseFields: { ...this.baseFields, ...fields },
      now: this.now,
    });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const ctx: CorrelationContext | undefined = currentContext();
    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      component: this.component,
      msg,
      ...this.baseFields,
    };
    if (ctx) {
      record.correlationId = ctx.correlationId;
      if (ctx.operationId) record.operationId = ctx.operationId;
      if (ctx.taskId) record.taskId = ctx.taskId;
      if (ctx.stepKey) record.stepKey = ctx.stepKey;
      if (ctx.invocationId) record.invocationId = ctx.invocationId;
      if (ctx.businessId) record.businessId = ctx.businessId;
      if (ctx.businessVersion) record.businessVersion = ctx.businessVersion;
      if (ctx.leaseEpoch !== undefined) record.leaseEpoch = ctx.leaseEpoch;
      if (ctx.tenantId) record.tenantId = ctx.tenantId;
    }
    if (fields) Object.assign(record, fields);
    const safe = redact(record) as Record<string, unknown>;
    this.sink.write(JSON.stringify(safe));
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new Logger(opts);
}