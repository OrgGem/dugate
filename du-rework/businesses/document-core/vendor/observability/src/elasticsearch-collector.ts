import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { metadataLogRecord } from './log-metadata';

const ENVIRONMENTS = new Set(['dev', 'test', 'staging', 'prod']);
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error']);
const SPOOL_FILE_PATTERN = /^(\d{12,})\.(open|ready)$/;

export type CollectorDropReason =
  | 'buffer_full'
  | 'oversize'
  | 'invalid_record'
  | 'disk_error'
  | 'recovery_prune'
  | 'elasticsearch_rejection';

export interface ElasticsearchLogCollectorOptions {
  /** HTTPS base URL for the private Elasticsearch cluster. TLS verification is mandatory. */
  endpoint: string;
  /** Elasticsearch API key with create/write permission for the log data streams only. */
  apiKey: string;
  spoolDirectory: string;
  /** Bounds the collector's segment, payload, response, and line working set. */
  maxMemoryBytes?: number;
  maxDiskBytes?: number;
  maxSegments?: number;
  maxSegmentBytes?: number;
  maxRecordBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  flushIntervalMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  onDrop?: (reason: CollectorDropReason, count: number) => void;
  onDeliveryFailure?: (code: string, retryCount: number) => void;
}

export interface ElasticsearchLogCollectorStats {
  acceptedRecords: number;
  deliveredRecords: number;
  droppedRecords: number;
  invalidRecords: number;
  retryAttempts: number;
  bufferedRecords: number;
  bufferedDiskBytes: number;
  pendingWriteBytes: number;
  lastDeliveredAt: string | null;
  ingestLagMs: number;
  lastFailureCode: string | null;
}

export interface ElasticsearchLogFlushResult {
  delivered: number;
  dropped: number;
  retrying: boolean;
  bufferedRecords: number;
}

interface LogEvent extends Record<string, unknown> {
  timestamp: string;
  level: string;
  service: string;
  environment: string;
  correlationId: string;
  message: string;
}

interface SegmentInfo {
  sequence: number;
  fileName: string;
  sizeBytes: number;
  recordCount: number;
  firstTimestampMs: number | null;
}

interface ParsedSegmentRecord {
  event: LogEvent;
  line: string;
}

const DEFAULTS = {
  maxDiskBytes: 256 * 1024 * 1024,
  maxMemoryBytes: 8 * 1024 * 1024,
  maxSegments: 4096,
  maxSegmentBytes: 256 * 1024,
  maxRecordBytes: 64 * 1024,
  maxResponseBytes: 1024 * 1024,
  requestTimeoutMs: 5000,
  flushIntervalMs: 250,
  initialRetryMs: 500,
  maxRetryMs: 30_000,
} as const;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function safeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Elasticsearch endpoint must be an HTTPS URL');
  }
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    url.search || url.hash || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new TypeError('Elasticsearch endpoint requires verified HTTPS without embedded credentials or query data');
  }
  return url.toString().replace(/\/$/, '');
}

function isLogEvent(value: unknown): value is LogEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const timestampMs = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
  const optionalIdsAreValid = ['operationId', 'taskId', 'invocationId'].every((key) =>
    event[key] === null || typeof event[key] === 'string',
  );
  return typeof event.timestamp === 'string' && Number.isFinite(timestampMs) &&
    new Date(timestampMs).toISOString() === event.timestamp &&
    typeof event.level === 'string' && LEVELS.has(event.level) &&
    typeof event.service === 'string' && event.service.length > 0 && event.service.length <= 128 &&
    typeof event.version === 'string' && event.version.length > 0 &&
    typeof event.environment === 'string' && ENVIRONMENTS.has(event.environment) &&
    typeof event.correlationId === 'string' && event.correlationId.length > 0 &&
    typeof event.message === 'string' && optionalIdsAreValid;
}

function segmentName(sequence: number, extension: 'open' | 'ready'): string {
  return `${String(sequence).padStart(12, '0')}.${extension}`;
}

function parseSequence(fileName: string): number | null {
  const match = SPOOL_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

async function countLines(filePath: string): Promise<number> {
  const input = createReadStream(filePath);
  let count = 0;
  let hasBytes = false;
  let endsWithNewline = true;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hasBytes = hasBytes || bytes.byteLength > 0;
    for (const byte of bytes) if (byte === 0x0a) count += 1;
    if (bytes.byteLength > 0) endsWithNewline = bytes[bytes.byteLength - 1] === 0x0a;
  }
  return count + (hasBytes && !endsWithNewline ? 1 : 0);
}

/**
 * Durable, bounded, at-least-once Elasticsearch delivery for JSON log streams.
 * The collector is intended to run beside a service and consume its stdout;
 * application requests only write stdout and never wait for Elasticsearch.
 */
export class ElasticsearchLogCollector {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly spoolDirectory: string;
  private readonly maxMemoryBytes: number;
  private readonly maxDiskBytes: number;
  private readonly maxSegments: number;
  private readonly maxSegmentBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly flushIntervalMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly onDrop?: (reason: CollectorDropReason, count: number) => void;
  private readonly onDeliveryFailure?: (code: string, retryCount: number) => void;

  private initialized?: Promise<void>;
  private diskTail: Promise<void> = Promise.resolve();
  private flushTask?: Promise<ElasticsearchLogFlushResult>;
  private activeFile: string | null = null;
  private activeSegmentBytes = 0;
  private sequence = 0;
  private diskBytes = 0;
  private pendingAppendBytes = 0;
  private bufferedRecords = 0;
  private acceptedRecords = 0;
  private deliveredRecords = 0;
  private droppedRecords = 0;
  private invalidRecords = 0;
  private retryAttempts = 0;
  private lastDeliveredAt: string | null = null;
  private oldestBufferedTimestampMs: number | null = null;
  private lastFailureCode: string | null = null;
  private running = false;
  private loopTask?: Promise<void>;
  private wakeResolver?: () => void;

  constructor(options: ElasticsearchLogCollectorOptions) {
    if (!options.apiKey || !options.apiKey.trim()) throw new TypeError('Elasticsearch API key is required');
    if (!options.spoolDirectory || !options.spoolDirectory.trim()) throw new TypeError('spoolDirectory is required');
    this.endpoint = safeEndpoint(options.endpoint);
    this.apiKey = options.apiKey;
    this.spoolDirectory = path.resolve(options.spoolDirectory);
    this.maxMemoryBytes = positiveInteger(options.maxMemoryBytes, DEFAULTS.maxMemoryBytes, 'maxMemoryBytes');
    this.maxDiskBytes = positiveInteger(options.maxDiskBytes, DEFAULTS.maxDiskBytes, 'maxDiskBytes');
    this.maxSegments = positiveInteger(options.maxSegments, DEFAULTS.maxSegments, 'maxSegments');
    this.maxSegmentBytes = positiveInteger(options.maxSegmentBytes, DEFAULTS.maxSegmentBytes, 'maxSegmentBytes');
    this.maxRecordBytes = positiveInteger(options.maxRecordBytes, DEFAULTS.maxRecordBytes, 'maxRecordBytes');
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULTS.maxResponseBytes, 'maxResponseBytes');
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 'requestTimeoutMs');
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, DEFAULTS.flushIntervalMs, 'flushIntervalMs');
    this.initialRetryMs = positiveInteger(options.initialRetryMs, DEFAULTS.initialRetryMs, 'initialRetryMs');
    this.maxRetryMs = positiveInteger(options.maxRetryMs, DEFAULTS.maxRetryMs, 'maxRetryMs');
    if (this.maxSegmentBytes > this.maxDiskBytes || this.maxRecordBytes > this.maxSegmentBytes) {
      throw new TypeError('buffer limits must satisfy maxRecordBytes <= maxSegmentBytes <= maxDiskBytes');
    }
    if (this.maxSegmentBytes * 8 + this.maxResponseBytes + this.maxRecordBytes > this.maxMemoryBytes) {
      throw new TypeError('maxMemoryBytes must cover eight spool segments, one response, and one input record');
    }
    if (this.maxRetryMs < this.initialRetryMs) throw new TypeError('maxRetryMs must be at least initialRetryMs');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.onDrop = options.onDrop;
    this.onDeliveryFailure = options.onDeliveryFailure;
  }

  stats(): ElasticsearchLogCollectorStats {
    const nowMs = this.now().getTime();
    const ingestLagMs = this.bufferedRecords > 0 && this.oldestBufferedTimestampMs !== null
      ? Math.max(0, nowMs - this.oldestBufferedTimestampMs)
      : 0;
    return {
      acceptedRecords: this.acceptedRecords,
      deliveredRecords: this.deliveredRecords,
      droppedRecords: this.droppedRecords,
      invalidRecords: this.invalidRecords,
      retryAttempts: this.retryAttempts,
      bufferedRecords: this.bufferedRecords,
      bufferedDiskBytes: this.diskBytes,
      pendingWriteBytes: this.pendingAppendBytes,
      lastDeliveredAt: this.lastDeliveredAt,
      ingestLagMs,
      lastFailureCode: this.lastFailureCode,
    };
  }

  /**
   * Consume newline-delimited JSON with bounded carry memory. Awaiting local
   * spool writes pauses the input stream, providing backpressure to the host
   * collector without making service requests depend on Elasticsearch.
   */
  async consume(source: AsyncIterable<Uint8Array | string>): Promise<void> {
    await this.ensureInitialized();
    let carry = Buffer.alloc(0);
    let discardingOversizeRecord = false;

    for await (const rawChunk of source) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.byteLength : newline;
        const part = chunk.subarray(offset, end);
        if (discardingOversizeRecord) {
          if (newline < 0) break;
          discardingOversizeRecord = false;
          carry = Buffer.alloc(0);
          offset = newline + 1;
          continue;
        }

        if (carry.byteLength + part.byteLength > this.maxRecordBytes) {
          this.recordDrop('oversize');
          carry = Buffer.alloc(0);
          discardingOversizeRecord = newline < 0;
          if (newline >= 0) offset = newline + 1;
          else break;
          continue;
        }
        const line = carry.byteLength === 0 ? part : Buffer.concat([carry, part]);
        if (newline >= 0) {
          await this.ingestLine(line.toString('utf8'));
          carry = Buffer.alloc(0);
          offset = newline + 1;
        } else {
          carry = Buffer.from(line);
          break;
        }
      }
    }

    if (!discardingOversizeRecord && carry.byteLength > 0) {
      await this.ingestLine(carry.toString('utf8'));
    }
  }

  /** Add one JSON line to the bounded disk spool; never performs network I/O. */
  async ingestLine(rawLine: string): Promise<boolean> {
    await this.ensureInitialized();
    const trimmed = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!trimmed.trim()) return true;
    if (Buffer.byteLength(trimmed, 'utf8') > this.maxRecordBytes) {
      this.recordDrop('oversize');
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      this.recordDrop('invalid_record');
      return false;
    }
    const safe = metadataLogRecord(parsed);
    if (!isLogEvent(safe)) {
      this.recordDrop('invalid_record');
      return false;
    }
    const serialized = JSON.stringify(safe);
    const lineBytes = Buffer.byteLength(serialized, 'utf8') + 1;
    if (lineBytes > this.maxRecordBytes || lineBytes > this.maxSegmentBytes) {
      this.recordDrop('oversize');
      return false;
    }
    const pendingWriteLimit = Math.floor(this.maxMemoryBytes / 4);
    if (this.pendingAppendBytes + lineBytes > pendingWriteLimit) {
      this.recordDrop('buffer_full');
      return false;
    }

    let rotated = false;
    let persisted = false;
    this.pendingAppendBytes += lineBytes;
    let accepted: boolean;
    try {
      accepted = await this.withDiskLock(async () => {
        if (this.diskBytes + lineBytes > this.maxDiskBytes) {
          this.recordDrop('buffer_full');
          return false;
        }
        if (this.activeFile && this.activeSegmentBytes + lineBytes > this.maxSegmentBytes) {
          await this.sealActiveSegment();
          rotated = true;
        }
        if (!this.activeFile) {
          if (await this.readySegmentCount() >= this.maxSegments) {
            this.recordDrop('buffer_full');
            return false;
          }
          await this.openActiveSegment();
        }
        const priorSegmentBytes = this.activeSegmentBytes;
        try {
          const spoolFile = await fs.open(this.activeFile!, 'a', 0o600);
          try {
            await spoolFile.writeFile(`${serialized}\n`, { encoding: 'utf8' });
            await spoolFile.sync();
            persisted = true;
          } finally {
            await spoolFile.close().catch(() => undefined);
          }
        } catch {
          await fs.truncate(this.activeFile!, priorSegmentBytes).catch(() => undefined);
          this.recordDrop('disk_error');
          return false;
        }
        this.activeSegmentBytes += lineBytes;
        this.diskBytes += lineBytes;
        this.bufferedRecords += 1;
        this.acceptedRecords += 1;
        const timestampMs = Date.parse(safe.timestamp);
        if (this.oldestBufferedTimestampMs === null || timestampMs < this.oldestBufferedTimestampMs) {
          this.oldestBufferedTimestampMs = timestampMs;
        }
        if (this.activeSegmentBytes >= this.maxSegmentBytes) {
          await this.sealActiveSegment();
          rotated = true;
        }
        return true;
      }).catch(() => {
        if (persisted) return true;
        this.recordDrop('disk_error');
        return false;
      });
    } finally {
      this.pendingAppendBytes = Math.max(0, this.pendingAppendBytes - lineBytes);
    }
    if (rotated) this.wake();
    return accepted;
  }

  /** Attempt one bounded bulk request. Failures are retained for retry/replay. */
  flushOnce(): Promise<ElasticsearchLogFlushResult> {
    if (this.flushTask) return this.flushTask;
    this.flushTask = this.flushOne().finally(() => { this.flushTask = undefined; });
    return this.flushTask;
  }

  /** Start background retries; safe to call repeatedly. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopTask = this.runLoop().finally(() => { this.loopTask = undefined; });
  }

  /** Stop retries and optionally make bounded best-effort delivery before exit. */
  async stop(options: { drainTimeoutMs?: number } = {}): Promise<void> {
    await this.ensureInitialized();
    this.running = false;
    this.wake();
    await this.loopTask;
    await this.withDiskLock(() => this.sealActiveSegment());
    const drainTimeoutMs = options.drainTimeoutMs ?? 0;
    const deadline = Date.now() + Math.max(0, drainTimeoutMs);
    while (drainTimeoutMs > 0 && this.bufferedRecords > 0 && Date.now() < deadline) {
      const result = await this.flushOnce();
      if (result.retrying || result.delivered === 0 && result.dropped === 0) break;
    }
  }

  private async flushOne(): Promise<ElasticsearchLogFlushResult> {
    await this.ensureInitialized();
    const segment = await this.withDiskLock(async () => {
      await this.sealActiveSegment();
      return (await this.listReadySegments())[0] ?? null;
    });
    if (!segment) return this.flushResult(0, 0, false);

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(this.spoolDirectory, segment.fileName));
    } catch {
      this.lastFailureCode = 'SPOOL_READ_FAILED';
      this.recordRetry(this.lastFailureCode);
      return this.flushResult(0, 0, true);
    }

    const valid: ParsedSegmentRecord[] = [];
    let invalidCount = 0;
    for (const raw of bytes.toString('utf8').split('\n')) {
      if (!raw) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        const safe = metadataLogRecord(parsed);
        if (!isLogEvent(safe)) {
          invalidCount += 1;
          continue;
        }
        valid.push({ event: safe, line: JSON.stringify(safe) });
      } catch {
        invalidCount += 1;
      }
    }

    if (invalidCount > 0) {
      await this.withDiskLock(async () => {
        await this.replaceSegment(segment, valid.map((record) => record.line));
        this.bufferedRecords = Math.max(0, this.bufferedRecords - invalidCount);
        this.invalidRecords += invalidCount;
        this.droppedRecords += invalidCount;
        this.notifyDrop('invalid_record', invalidCount);
        await this.refreshOldestBufferedTimestamp();
      });
    }
    if (valid.length === 0) {
      if (invalidCount === 0) {
        await this.withDiskLock(async () => {
          await fs.unlink(path.join(this.spoolDirectory, segment.fileName));
          this.diskBytes = Math.max(0, this.diskBytes - segment.sizeBytes);
        });
      }
      return this.flushResult(0, invalidCount, false);
    }

    const body = valid.map(({ event }) =>
      `${JSON.stringify({ create: { _index: `du-logs-${event.environment}` } })}\n${JSON.stringify({
        ...event,
        '@timestamp': event.timestamp,
      })}`,
    ).join('\n') + '\n';

    let outcomes: Array<'delivered' | 'retry' | 'drop'>;
    try {
      outcomes = await this.sendBulk(body, valid.length);
    } catch (error) {
      const code = error instanceof CollectorDeliveryError ? error.code : 'TRANSPORT_UNAVAILABLE';
      this.lastFailureCode = code;
      this.recordRetry(code);
      return this.flushResult(0, invalidCount, true);
    }

    const retryLines: string[] = [];
    let delivered = 0;
    let dropped = invalidCount;
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index]!;
      if (outcome === 'delivered') delivered += 1;
      else if (outcome === 'retry') retryLines.push(valid[index]!.line);
      else dropped += 1;
    }
    await this.withDiskLock(async () => {
      await this.replaceSegment(segment, retryLines);
      this.deliveredRecords += delivered;
      this.bufferedRecords = Math.max(0, this.bufferedRecords - delivered - (dropped - invalidCount));
      if (delivered > 0) this.lastDeliveredAt = this.now().toISOString();
      const permanentDropCount = dropped - invalidCount;
      if (permanentDropCount > 0) {
        this.droppedRecords += permanentDropCount;
        this.notifyDrop('elasticsearch_rejection', permanentDropCount);
      }
      this.lastFailureCode = retryLines.length > 0 ? 'PARTIAL_BULK_RETRY' : null;
      await this.refreshOldestBufferedTimestamp();
    });
    if (retryLines.length > 0) this.recordRetry('PARTIAL_BULK_RETRY');
    return this.flushResult(delivered, dropped, retryLines.length > 0);
  }

  private async sendBulk(body: string, recordCount: number): Promise<Array<'delivered' | 'retry' | 'drop'>> {
    const response = await this.fetcher(`${this.endpoint}/_bulk`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `ApiKey ${this.apiKey}`,
        'content-type': 'application/x-ndjson',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CollectorDeliveryError(`HTTP_${response.status}`);
    }
    const responseText = await readResponseBody(response, this.maxResponseBytes);
    let result: unknown;
    try {
      result = JSON.parse(responseText) as unknown;
    } catch {
      throw new CollectorDeliveryError('INVALID_BULK_RESPONSE');
    }
    if (result === null || typeof result !== 'object' || !Array.isArray((result as { items?: unknown }).items)) {
      throw new CollectorDeliveryError('INVALID_BULK_RESPONSE');
    }
    const items = (result as { items: unknown[] }).items;
    if (items.length !== recordCount) throw new CollectorDeliveryError('INVALID_BULK_RESPONSE');
    const outcomes: Array<'delivered' | 'retry' | 'drop'> = [];
    for (const item of items) {
      if (item === null || typeof item !== 'object') throw new CollectorDeliveryError('INVALID_BULK_RESPONSE');
      const create = (item as { create?: unknown }).create;
      if (create === null || typeof create !== 'object') throw new CollectorDeliveryError('INVALID_BULK_RESPONSE');
      const status = (create as { status?: unknown }).status;
      if (typeof status !== 'number' || !Number.isInteger(status)) throw new CollectorDeliveryError('INVALID_BULK_RESPONSE');
      if (status >= 200 && status < 300) outcomes.push('delivered');
      else if (status === 408 || status === 425 || status === 429 || status >= 500) outcomes.push('retry');
      else outcomes.push('drop');
    }
    return outcomes;
  }

  private async runLoop(): Promise<void> {
    let retryDelay = this.initialRetryMs;
    while (this.running) {
      let result: ElasticsearchLogFlushResult;
      try {
        result = await this.flushOnce();
      } catch {
        this.lastFailureCode = 'SPOOL_UNAVAILABLE';
        this.recordRetry(this.lastFailureCode);
        result = this.flushResult(0, 0, true);
      }
      let waitMs: number;
      if (result.retrying) {
        waitMs = retryDelay;
        retryDelay = Math.min(this.maxRetryMs, retryDelay * 2);
      } else if (result.delivered > 0 || result.dropped > 0) {
        retryDelay = this.initialRetryMs;
        waitMs = 0;
      } else {
        retryDelay = this.initialRetryMs;
        waitMs = this.flushIntervalMs;
      }
      if (this.running) await this.waitOrWake(waitMs);
    }
  }

  private async waitOrWake(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.wakeResolver = undefined;
        resolve();
      }, delayMs);
      this.wakeResolver = () => {
        clearTimeout(timeout);
        this.wakeResolver = undefined;
        resolve();
      };
      timeout.unref?.();
    });
  }

  private wake(): void {
    this.wakeResolver?.();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.initializeSpool();
    return this.initialized;
  }

  private async initializeSpool(): Promise<void> {
    await fs.mkdir(this.spoolDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.spoolDirectory, 0o700).catch(() => undefined);
    const names = await fs.readdir(this.spoolDirectory);
    const found: SegmentInfo[] = [];
    for (const fileName of names) {
      if (fileName.endsWith('.tmp')) {
        await fs.unlink(path.join(this.spoolDirectory, fileName)).catch(() => undefined);
        continue;
      }
      const sequence = parseSequence(fileName);
      if (sequence === null) continue;
      const originalPath = path.join(this.spoolDirectory, fileName);
      const readyName = fileName.replace(/\.open$/, '.ready');
      if (fileName.endsWith('.open')) await fs.rename(originalPath, path.join(this.spoolDirectory, readyName));
      const activeName = fileName.endsWith('.open') ? readyName : fileName;
      const activePath = path.join(this.spoolDirectory, activeName);
      const stat = await fs.stat(activePath);
      if (stat.size > this.maxSegmentBytes || stat.size > this.maxDiskBytes) {
        const prunedRecords = await countLines(activePath).catch(() => 1);
        await fs.unlink(activePath);
        this.recordDrop('recovery_prune', Math.max(1, prunedRecords));
        continue;
      }
      const raw = await fs.readFile(activePath);
      const lines = raw.toString('utf8').split('\n').filter(Boolean);
      const firstTimestampMs = this.timestampFromLine(lines[0]);
      found.push({
        sequence,
        fileName: activeName,
        sizeBytes: stat.size,
        recordCount: lines.length,
        firstTimestampMs,
      });
      this.sequence = Math.max(this.sequence, sequence);
    }
    found.sort((left, right) => left.sequence - right.sequence);
    while (found.length > this.maxSegments) {
      const oldest = found.shift()!;
      await fs.unlink(path.join(this.spoolDirectory, oldest.fileName));
      this.recordDrop('recovery_prune', Math.max(1, oldest.recordCount));
    }
    for (const file of found) {
      if (file.sizeBytes > this.maxSegmentBytes || file.sizeBytes > this.maxDiskBytes) {
        await fs.unlink(path.join(this.spoolDirectory, file.fileName));
        this.recordDrop('recovery_prune', Math.max(1, file.recordCount));
        continue;
      }
      this.diskBytes += file.sizeBytes;
      this.bufferedRecords += file.recordCount;
      if (this.oldestBufferedTimestampMs === null && file.firstTimestampMs !== null) {
        this.oldestBufferedTimestampMs = file.firstTimestampMs;
      }
    }
    while (this.diskBytes > this.maxDiskBytes) {
      const oldest = (await this.listReadySegments())[0];
      if (!oldest) break;
      await fs.unlink(path.join(this.spoolDirectory, oldest.fileName));
      this.diskBytes -= oldest.sizeBytes;
      this.bufferedRecords = Math.max(0, this.bufferedRecords - oldest.recordCount);
      this.recordDrop('recovery_prune', Math.max(1, oldest.recordCount));
      await this.refreshOldestBufferedTimestamp();
    }
  }

  private async openActiveSegment(): Promise<void> {
    this.sequence += 1;
    const fileName = segmentName(this.sequence, 'open');
    const filePath = path.join(this.spoolDirectory, fileName);
    await fs.writeFile(filePath, '', { flag: 'wx', mode: 0o600 });
    this.activeFile = filePath;
    this.activeSegmentBytes = 0;
  }

  private async sealActiveSegment(): Promise<void> {
    if (!this.activeFile) return;
    const readyPath = this.activeFile.replace(/\.open$/, '.ready');
    await fs.rename(this.activeFile, readyPath);
    this.activeFile = null;
    this.activeSegmentBytes = 0;
  }

  private async listReadySegments(): Promise<SegmentInfo[]> {
    const names = await fs.readdir(this.spoolDirectory);
    const segments: SegmentInfo[] = [];
    for (const fileName of names) {
      const sequence = parseSequence(fileName);
      if (sequence === null || !fileName.endsWith('.ready')) continue;
      const stat = await fs.stat(path.join(this.spoolDirectory, fileName));
      const raw = await fs.readFile(path.join(this.spoolDirectory, fileName));
      const lines = raw.toString('utf8').split('\n').filter(Boolean);
      segments.push({
        sequence,
        fileName,
        sizeBytes: stat.size,
        recordCount: lines.length,
        firstTimestampMs: this.timestampFromLine(lines[0]),
      });
    }
    return segments.sort((left, right) => left.sequence - right.sequence);
  }

  private async readySegmentCount(): Promise<number> {
    const names = await fs.readdir(this.spoolDirectory);
    return names.filter((name) => parseSequence(name) !== null && name.endsWith('.ready')).length;
  }

  private async replaceSegment(segment: SegmentInfo, lines: string[]): Promise<void> {
    const filePath = path.join(this.spoolDirectory, segment.fileName);
    if (lines.length === 0) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.diskBytes = Math.max(0, this.diskBytes - segment.sizeBytes);
      return;
    }
    const next = `${lines.join('\n')}\n`;
    const tempPath = path.join(this.spoolDirectory, `${segment.fileName}.${randomUUID()}.tmp`);
    await fs.writeFile(tempPath, next, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(tempPath, filePath);
    this.diskBytes += Buffer.byteLength(next, 'utf8') - segment.sizeBytes;
  }

  private async refreshOldestBufferedTimestamp(): Promise<void> {
    const segments = await this.listReadySegments();
    const firstReady = segments[0];
    let timestampMs = firstReady?.firstTimestampMs ?? null;
    if (this.activeFile) {
      try {
        const text = await fs.readFile(this.activeFile, 'utf8');
        const firstLine = text.split('\n').find(Boolean);
        const activeTimestamp = this.timestampFromLine(firstLine);
        if (activeTimestamp !== null && (timestampMs === null || activeTimestamp < timestampMs)) {
          timestampMs = activeTimestamp;
        }
      } catch {
        // The stat and append path report disk errors; a missing oldest hint is safe.
      }
    }
    this.oldestBufferedTimestampMs = timestampMs;
  }

  private timestampFromLine(line?: string): number | null {
    if (!line) return null;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object' && typeof (value as { timestamp?: unknown }).timestamp === 'string') {
        const parsed = Date.parse((value as { timestamp: string }).timestamp);
        return Number.isFinite(parsed) ? parsed : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  private async withDiskLock<T>(action: () => Promise<T>): Promise<T> {
    const next = this.diskTail.then(action, action);
    this.diskTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private recordDrop(reason: CollectorDropReason, count = 1): void {
    if (reason === 'invalid_record') this.invalidRecords += count;
    this.droppedRecords += count;
    this.notifyDrop(reason, count);
  }

  private notifyDrop(reason: CollectorDropReason, count: number): void {
    try {
      this.onDrop?.(reason, count);
    } catch {
      // Alert hooks cannot be allowed to stop collection.
    }
  }

  private recordRetry(code: string): void {
    this.retryAttempts += 1;
    try {
      this.onDeliveryFailure?.(code, this.retryAttempts);
    } catch {
      // Failure reporting is deliberately isolated from the spool and retry loop.
    }
  }

  private flushResult(delivered: number, dropped: number, retrying: boolean): ElasticsearchLogFlushResult {
    return { delivered, dropped, retrying, bufferedRecords: this.bufferedRecords };
  }
}

class CollectorDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CollectorDeliveryError';
  }
}

export function createElasticsearchLogCollector(
  options: ElasticsearchLogCollectorOptions,
): ElasticsearchLogCollector {
  return new ElasticsearchLogCollector(options);
}
