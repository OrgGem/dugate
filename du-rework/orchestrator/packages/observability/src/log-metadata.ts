import { redact, REDACTED, safeErrorForLog } from './redaction';
import { SAFE_LOG_MESSAGES } from './log-events';

const IDENTIFIERS = new Set([
  'service', 'version', 'environment', 'level', 'correlationId', 'operationId', 'taskId', 'invocationId',
  'tenantId', 'businessId', 'businessVersion', 'stepKey', 'workerInstanceId', 'queueName', 'subsystem',
  'action', 'state', 'status', 'kind', 'code', 'errorCode', 'errorClass', 'errorName', 'reason', 'event',
  'method', 'routeId', 'component', 'slot', 'handlerKind', 'signal',
]);
const COUNTERS = new Set(['address', 'count', 'generation', 'leaseEpoch', 'capacity', 'revision', 'concurrency']);
const COUNTER_SUFFIX = /(?:Count|Bytes|Ms|Seconds|Percent|Attempts|Retries|Latency|Duration)$/;
const FLAGS = new Set(['metadata', 'publicUpload', 'cancelRequested', 'retryable', 'replayed']);
const PAYLOAD = /^(?:input|output|request|response|body|payload|content|prompt|result|data)(?:$|[A-Z_-])/;
const SECRETS = new Set(['authorization', 'apiKey', 'secret', 'password', 'credential', 'token', 'cookie']);

/** Allow metadata by shape; no arbitrary strings/objects survive any sink. */
export function metadataLogRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'message') {
      out.message = typeof child === 'string' && SAFE_LOG_MESSAGES.has(child) ? child : REDACTED;
    } else if (key === 'error' || key === 'cause') {
      out[key] = safeErrorForLog(child);
    } else if ((COUNTERS.has(key) || COUNTER_SUFFIX.test(key)) && typeof child === 'number' && Number.isFinite(child)) {
      out[key] = child;
    } else if (PAYLOAD.test(key)) {
      // Content is omitted even if its value happens to look like metadata.
    } else if (IDENTIFIERS.has(key)) {
      if (child === null) out[key] = null;
      else if (typeof child === 'string' && /^[A-Za-z0-9_.:@/+\-]{1,160}$/.test(child)) out[key] = child;
      else if (typeof child === 'number' && Number.isFinite(child)) out[key] = child;
    } else if (key === 'timestamp' && typeof child === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(child)) {
      out[key] = child;
    } else if (FLAGS.has(key) && typeof child === 'boolean') {
      out[key] = child;
    } else if (SECRETS.has(key)) {
      out[key] = REDACTED;
    }
  }
  return redact(out);
}
