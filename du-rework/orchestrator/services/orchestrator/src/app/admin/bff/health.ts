/** Platform-wide health snapshot for the Admin Web health strip. */
import type { ServerResponse } from 'node:http';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { writeJson, writeProblem, relayUpstream, callUpstream, type BffRuntimeConfig } from './upstream';

type HealthState = 'ok' | 'degraded' | 'unknown';
type QueueIntegrityState = 'OK' | 'RECONSTRUCTING' | 'SUSPECT';

interface QueueIntegritySnapshot {
  state: QueueIntegrityState;
  orphansLast: number | null;
  stalled: number | null;
  lastSweepAt: string | null;
}

interface HealthSnapshot {
  status: HealthState;
  db: boolean | null;
  redis: boolean | null;
  activeLeases: number | null;
  queueIntegrity: QueueIntegritySnapshot | null;
  outboxBacklog: number | null;
  sampledAt: string;
}

export async function handleHealthRoute(
  res: ServerResponse,
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'administrator role is required', correlationId);
    return;
  }

  const credential = runtime.adminToken;
  if (typeof credential !== 'string' || credential.length === 0 || !hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const response = await callUpstream(runtime, new URL('/api/v1/health', runtime.jsonBaseUrl), {
    method: 'GET',
    credential,
    correlationId,
  });
  // The platform health endpoint uses 503 for an unhealthy dependency while
  // returning the useful dependency detail in JSON. Keep that detail for the
  // strip, but never relay its body wholesale.
  if (response.status !== 200 && response.status !== 503) {
    await relayUpstream(res, response, correlationId);
    return;
  }

  const payload = await readJson(response);
  const sampledAt = new Date().toISOString();
  const snapshot = payload === null ? null : normalizeSnapshot(payload, sampledAt, response.status === 503);
  if (snapshot === null) {
    writeProblem(res, 502, 'UPSTREAM_INVALID_RESPONSE', 'the admin API returned invalid health data', correlationId);
    return;
  }
  writeJson(res, 200, snapshot, correlationId);
}

function normalizeSnapshot(value: unknown, sampledAt: string, upstreamDegraded: boolean): HealthSnapshot | null {
  const source = record(value);
  if (source === null) return null;

  const db = booleanOrNull(source.db);
  const redis = booleanOrNull(source.redis);
  const queueIntegrity = normalizeQueueIntegrity(source.queueIntegrity);
  const upstreamStatus = source.status === 'ok' || source.status === 'degraded' ? source.status : 'unknown';
  let status: HealthState = upstreamStatus;
  if (upstreamDegraded || db === false || redis === false || queueIntegrity?.state === 'SUSPECT') status = 'degraded';
  else if (db === null || redis === null) status = 'unknown';

  return {
    status,
    db,
    redis,
    // The platform health route reports a synthetic zero when its DB query
    // fails. Do not present that fallback as a measured lease count.
    activeLeases: db === true ? nonnegativeIntegerOrNull(source.activeLeases) : null,
    queueIntegrity,
    // The current health contract does not publish an outbox backlog. Preserve
    // an explicit future value when available; otherwise show unavailable.
    outboxBacklog: nonnegativeIntegerOrNull(source.outboxBacklog),
    sampledAt,
  };
}

function normalizeQueueIntegrity(value: unknown): QueueIntegritySnapshot | null {
  const source = record(value);
  if (source === null) return null;
  if (source.state !== 'OK' && source.state !== 'RECONSTRUCTING' && source.state !== 'SUSPECT') return null;
  return {
    state: source.state,
    orphansLast: nonnegativeIntegerOrNull(source.orphansLast),
    stalled: nonnegativeIntegerOrNull(source.stalled),
    lastSweepAt: validTimestampOrNull(source.lastSweepAt),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validTimestampOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

async function readJson(response: Response): Promise<unknown | null> {
  const text = await response.text().catch(() => '');
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function hasJsonBase(runtime: BffRuntimeConfig): runtime is BffRuntimeConfig & { jsonBaseUrl: string } {
  return typeof runtime.jsonBaseUrl === 'string' && runtime.jsonBaseUrl.length > 0;
}
