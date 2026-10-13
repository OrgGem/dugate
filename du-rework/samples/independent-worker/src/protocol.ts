import { createHash } from 'node:crypto';
import type { BusinessManifest } from './manifest.js';
import { canonicalize } from './manifest.js';

export type JsonRecord = Record<string, unknown>;

export interface BusinessJobV1 {
  contractVersion: '1';
  deliveryId: string;
  taskId: string;
  operationId: string;
  businessId: string;
  businessVersion: string;
  action: string;
  kind: string;
  correlationId: string;
  priority?: number;
}

export interface HeartbeatAck {
  health: 'HEALTHY' | 'DEGRADED' | 'OFFLINE';
  leaseExpiresAt: string;
  capacity: number;
  controlRevision: number;
  controlState: 'OPEN' | 'PAUSED' | 'DRAINING';
  activeVersion?: string | null;
  activationRevision?: number;
  admissionEligible?: boolean;
  admissionReason?: 'ELIGIBLE'
    | 'BUSINESS_DISABLED'
    | 'NO_ACTIVE_VERSION'
    | 'VERSION_NOT_ACTIVE'
    | 'VERSION_NOT_ENABLED';
  backupEffectFence?: {
    state: 'OPEN' | 'HELD' | 'UNKNOWN';
    revision: number;
    acknowledged: boolean;
  };
}

export interface ExecutionSnapshot {
  operationId: string;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  action: string;
  schemaDigest: string;
  manifestDigest: string;
  resolvedInputRef: JsonRecord;
  pinned: JsonRecord & { connectorBindings?: Record<string, string> };
  taskKey: string;
  kind: string;
  payloadRef: JsonRecord;
  deadlineAt: string | null;
  cancelRequested: boolean;
}

export interface ClaimResult {
  taskId: string;
  operationId: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
  attempt: number;
  deadlineAt: string | null;
  executionSnapshot: ExecutionSnapshot;
  checkpointRefs: unknown[];
}

export interface TaskHeartbeatAck {
  leaseExpiresAt: string;
  cancelRequested: boolean;
}

export interface TaskReportAck {
  taskId: string;
  state: 'PENDING_INGESTION' | 'READY' | 'RUNNING' | 'WAITING_CHILDREN' | 'WAITING_INPUT' | 'RETRY_PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  operationState: 'PENDING_INGESTION' | 'ACCEPTED' | 'QUEUED' | 'RUNNING' | 'WAITING_CHILDREN' | 'WAITING_INPUT' | 'RETRY_PENDING' | 'CANCEL_REQUESTED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  replayed: boolean;
  nextAttemptAt?: string | null;
}

export class RuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly ambiguous: boolean,
  ) {
    super(`Runtime request failed (${status || 'network'} ${code})`);
    this.name = 'RuntimeHttpError';
  }

  get isLeaseLost(): boolean {
    return this.status === 409 && this.code === 'LEASE_LOST';
  }

  get isTaskTerminal(): boolean {
    return this.status === 410 || this.code === 'TASK_TERMINAL';
  }
}

export class WorkerFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'WorkerFailure';
  }
}

export class TaskLeaseError extends Error {
  constructor(readonly reason: 'lease-lost' | 'cancel' | 'task-terminal' | 'shutdown' | 'compatibility') {
    super(`task stopped: ${reason}`);
    this.name = 'TaskLeaseError';
  }
}

export interface RuntimeClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class RuntimeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RuntimeClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('RUNTIME_URL must be an HTTP URL without userinfo, query, or fragment');
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (options.token.trim().length === 0) throw new Error('RUNTIME_TOKEN is required');
  }

  async registerBusinessVersion(manifest: BusinessManifest): Promise<JsonRecord> {
    const body = await this.request(
      'PUT',
      `/businesses/${encodeURIComponent(manifest.businessId)}/versions/${encodeURIComponent(manifest.version)}`,
      manifest,
    );
    if (
      body.businessId !== manifest.businessId
      || body.version !== manifest.version
      || body.digest !== manifestDigestFor(manifest)
      || body.queue !== businessQueueNameFor(manifest)
      || typeof body.created !== 'boolean'
      || typeof body.replayed !== 'boolean'
    ) {
      throw new Error('Runtime registration response does not match the submitted manifest');
    }
    return body;
  }

  async heartbeatWorker(instanceId: string, body: JsonRecord): Promise<HeartbeatAck> {
    return parseHeartbeatAck(await this.request(
      'PUT',
      `/workers/${encodeURIComponent(instanceId)}/heartbeat`,
      body,
    ));
  }

  async retireWorker(
    instanceId: string,
    identity: { businessId: string; businessVersion: string; manifestDigest: string },
  ): Promise<void> {
    const body = await this.request('POST', `/workers/${encodeURIComponent(instanceId)}/retire`, identity);
    if (body.retired !== true) throw new Error('Runtime retirement response is invalid');
  }

  async claimTask(taskId: string, body: {
    deliveryId: string;
    workerInstanceId: string;
    businessId: string;
  }): Promise<ClaimResult> {
    const response = await this.request('POST', `/tasks/${encodeURIComponent(taskId)}/claim`, body);
    try {
      return parseClaimResult(response);
    } catch {
      // A malformed 2xx may follow a committed claim. Preserve the exact
      // identity and let the worker reconcile it with an idempotent replay.
      throw new RuntimeHttpError(200, 'INVALID_RUNTIME_RESPONSE', true, true);
    }
  }

  async heartbeatTask(taskId: string, leaseEpoch: number, signal?: AbortSignal): Promise<TaskHeartbeatAck> {
    return parseTaskHeartbeatAck(await this.request(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/heartbeat`,
      { leaseEpoch },
      signal,
    ));
  }

  async completeTask(taskId: string, body: {
    leaseEpoch: number;
    resultRef: string;
    resultHash: string;
    outputArtifactIds: string[];
  }): Promise<TaskReportAck> {
    return this.requestTaskReport(taskId, `/tasks/${encodeURIComponent(taskId)}/complete`, body);
  }

  async failTask(taskId: string, body: {
    leaseEpoch: number;
    errorCode: string;
    retryable: boolean;
    retryAfterMs?: number;
    detail?: string;
  }): Promise<TaskReportAck> {
    return this.requestTaskReport(taskId, `/tasks/${encodeURIComponent(taskId)}/fail`, body);
  }

  private async requestTaskReport(taskId: string, path: string, body: unknown): Promise<TaskReportAck> {
    const response = await this.request('POST', path, body);
    try {
      return parseTaskReportAck(response, taskId);
    } catch {
      // A 2xx response may follow a committed write. Treat malformed ACKs as
      // ambiguous so callers retry this exact settlement or defer recovery.
      throw new RuntimeHttpError(200, 'INVALID_RUNTIME_RESPONSE', true, true);
    }
  }

  private async request(
    method: 'PUT' | 'POST',
    path: string,
    requestBody: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    const serialized = JSON.stringify(requestBody);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) throw signal.reason ?? new Error('request aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), this.timeoutMs);
    timer.unref?.();

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            'content-type': 'application/json',
          },
          body: serialized,
          signal: controller.signal,
        });
      } catch {
        if (signal?.aborted) throw signal.reason ?? new Error('request aborted');
        throw new RuntimeHttpError(0, 'TEMPORARY_UNAVAILABLE', true, true);
      }

      let parsed: unknown;
      try {
        const responseText = await response.text();
        parsed = responseText.length > 0 ? JSON.parse(responseText) as unknown : {};
      } catch {
        if (!response.ok) parsed = {};
        else throw new RuntimeHttpError(response.status, 'TEMPORARY_UNAVAILABLE', true, true);
      }

      if (!response.ok) {
        const code = safeCode(parsed, response.status);
        const retryable = response.status === 429 || response.status >= 500;
        throw new RuntimeHttpError(response.status, code, retryable, response.status >= 500);
      }
      if (!isRecord(parsed)) throw new RuntimeHttpError(response.status, 'TEMPORARY_UNAVAILABLE', true, true);
      return parsed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

const SAFE_ACK_CLAIM_CODES = new Set([
  'NOT_FOUND',
  'TASK_TERMINAL',
  'TASK_WAITING',
  'TASK_LEASE_ACTIVE',
]);

export function isAckSafeClaimError(error: RuntimeHttpError): boolean {
  if (error.code === 'TASK_ATTEMPTS_EXHAUSTED') return error.status === 410;
  return SAFE_ACK_CLAIM_CODES.has(error.code);
}

export function parseBusinessJob(value: unknown): BusinessJobV1 {
  if (!isRecord(value)) throw new Error('queue payload must be an object');
  const allowed = new Set([
    'contractVersion', 'deliveryId', 'taskId', 'operationId', 'businessId',
    'businessVersion', 'action', 'kind', 'correlationId', 'priority',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('queue payload contains unsupported fields');
  if (
    value.contractVersion !== '1'
    || !nonEmptyString(value.deliveryId)
    || !uuid(value.taskId)
    || !uuid(value.operationId)
    || !nonEmptyString(value.businessId)
    || !nonEmptyString(value.businessVersion)
    || !nonEmptyString(value.action)
    || !nonEmptyString(value.kind)
    || !nonEmptyString(value.correlationId)
    || value.priority !== undefined && (typeof value.priority !== 'number' || !Number.isFinite(value.priority))
  ) throw new Error('queue payload does not match BusinessJobV1');
  return value as unknown as BusinessJobV1;
}

export function parseClaimResult(value: unknown): ClaimResult {
  if (!isRecord(value) || !isRecord(value.executionSnapshot)) throw new Error('claim response is invalid');
  const snapshot = value.executionSnapshot;
  if (
    !uuid(value.taskId)
    || !uuid(value.operationId)
    || !Number.isSafeInteger(value.leaseEpoch) || (value.leaseEpoch as number) < 1
    || !validTimestamp(value.leaseExpiresAt)
    || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1
    || value.deadlineAt !== null && !validTimestamp(value.deadlineAt)
    || !uuid(snapshot.operationId)
    || !nonEmptyString(snapshot.tenantId)
    || !nonEmptyString(snapshot.businessId)
    || !nonEmptyString(snapshot.businessVersion)
    || !nonEmptyString(snapshot.action)
    || !nonEmptyString(snapshot.schemaDigest)
    || !nonEmptyString(snapshot.manifestDigest)
    || !isRecord(snapshot.resolvedInputRef)
    || !isRecord(snapshot.pinned)
    || !Number.isSafeInteger(snapshot.pinned.profileRevision)
    || (snapshot.pinned.profileRevision as number) < 0
    || !isRecord(snapshot.payloadRef)
    || !nonEmptyString(snapshot.taskKey)
    || !nonEmptyString(snapshot.kind)
    || snapshot.deadlineAt !== null && !validTimestamp(snapshot.deadlineAt)
    || typeof snapshot.cancelRequested !== 'boolean'
    || !Array.isArray(value.checkpointRefs)
  ) throw new Error('claim response does not match the supported Runtime v1 claim shape');
  const bindings = snapshot.pinned.connectorBindings;
  if (bindings !== undefined && !isStringRecord(bindings)) throw new Error('claim connector bindings are invalid');
  const promptRevisions = snapshot.pinned.promptRevisions;
  if (promptRevisions !== undefined && !isStringRecord(promptRevisions)) throw new Error('claim prompt revisions are invalid');
  const promptOverrides = snapshot.pinned.promptOverrides;
  if (promptOverrides !== undefined && promptOverrides !== null && !Array.isArray(promptOverrides)) {
    throw new Error('claim prompt overrides are invalid');
  }
  const profilePolicy = snapshot.pinned.profilePolicy;
  if (profilePolicy !== undefined && profilePolicy !== null && !isRecord(profilePolicy)) {
    throw new Error('claim profile policy is invalid');
  }
  const tenantDefaults = snapshot.pinned.tenantDefaults;
  if (tenantDefaults !== undefined && tenantDefaults !== null && !isRecord(tenantDefaults)) {
    throw new Error('claim tenant defaults are invalid');
  }
  return value as unknown as ClaimResult;
}

function parseHeartbeatAck(value: unknown): HeartbeatAck {
  if (!isRecord(value)) throw new Error('worker heartbeat response is invalid');
  const controlRevision = value.controlRevision;
  const controlState = value.controlState;
  let backupEffectFence: HeartbeatAck['backupEffectFence'];
  if (value.backupEffectFence !== undefined) {
    const backup = value.backupEffectFence;
    if (
      !isRecord(backup)
      || !['OPEN', 'HELD', 'UNKNOWN'].includes(String(backup.state))
      || !Number.isSafeInteger(backup.revision) || (backup.revision as number) < 0
      || typeof backup.acknowledged !== 'boolean'
    ) throw new Error('worker heartbeat backup fence response is invalid');
    backupEffectFence = {
      state: backup.state as 'OPEN' | 'HELD' | 'UNKNOWN',
      revision: backup.revision as number,
      acknowledged: backup.acknowledged,
    };
  }
  if (
    !['HEALTHY', 'DEGRADED', 'OFFLINE'].includes(String(value.health))
    || !validTimestamp(value.leaseExpiresAt)
    || !Number.isSafeInteger(value.capacity) || (value.capacity as number) < 0
    || !Number.isSafeInteger(controlRevision) || (controlRevision as number) < 0
    || !['OPEN', 'PAUSED', 'DRAINING'].includes(String(controlState))
  ) throw new Error('worker heartbeat response does not match Runtime v1');
  const activationRevision = Number.isSafeInteger(value.activationRevision)
    && (value.activationRevision as number) >= 1
    ? value.activationRevision as number
    : undefined;
  const activeVersion = typeof value.activeVersion === 'string' || value.activeVersion === null
    ? value.activeVersion as string | null
    : undefined;
  const admissionEligible = typeof value.admissionEligible === 'boolean'
    ? value.admissionEligible
    : undefined;
  const admissionReasons = [
    'ELIGIBLE',
    'BUSINESS_DISABLED',
    'NO_ACTIVE_VERSION',
    'VERSION_NOT_ACTIVE',
    'VERSION_NOT_ENABLED',
  ] as const;
  const admissionReason = admissionReasons.includes(value.admissionReason as (typeof admissionReasons)[number])
    ? value.admissionReason as HeartbeatAck['admissionReason']
    : undefined;
  return {
    health: value.health as HeartbeatAck['health'],
    leaseExpiresAt: value.leaseExpiresAt as string,
    capacity: value.capacity as number,
    controlRevision: controlRevision as number,
    controlState: controlState as HeartbeatAck['controlState'],
    ...(activationRevision === undefined ? {} : { activationRevision }),
    ...(activeVersion === undefined ? {} : { activeVersion }),
    ...(admissionEligible === undefined ? {} : { admissionEligible }),
    ...(admissionReason === undefined ? {} : { admissionReason }),
    ...(backupEffectFence ? { backupEffectFence } : {}),
  };
}

function parseTaskHeartbeatAck(value: unknown): TaskHeartbeatAck {
  if (!isRecord(value) || !validTimestamp(value.leaseExpiresAt)) throw new Error('task heartbeat response is invalid');
  if (value.cancelRequested !== undefined && typeof value.cancelRequested !== 'boolean') {
    throw new Error('task heartbeat cancel flag is invalid');
  }
  return { leaseExpiresAt: value.leaseExpiresAt as string, cancelRequested: value.cancelRequested === true };
}

function parseTaskReportAck(value: unknown, expectedTaskId: string): TaskReportAck {
  const taskStates = new Set([
    'PENDING_INGESTION', 'READY', 'RUNNING', 'WAITING_CHILDREN', 'WAITING_INPUT',
    'RETRY_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED',
  ]);
  const operationStates = new Set([
    'PENDING_INGESTION', 'ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_CHILDREN',
    'WAITING_INPUT', 'RETRY_PENDING', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED',
    'CANCELLED', 'TIMED_OUT',
  ]);
  if (
    !isRecord(value)
    || value.taskId !== expectedTaskId
    || typeof value.state !== 'string' || !taskStates.has(value.state)
    || typeof value.operationState !== 'string' || !operationStates.has(value.operationState)
    || typeof value.replayed !== 'boolean'
    || value.nextAttemptAt !== undefined && value.nextAttemptAt !== null && !validTimestamp(value.nextAttemptAt)
  ) throw new Error('task report acknowledgement is invalid');
  return {
    taskId: value.taskId,
    state: value.state as TaskReportAck['state'],
    operationState: value.operationState as TaskReportAck['operationState'],
    replayed: value.replayed,
    ...(value.nextAttemptAt === undefined ? {} : { nextAttemptAt: value.nextAttemptAt as string | null }),
  };
}

function safeCode(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code)) return value.code;
  if (status === 409) return 'STATE_CONFLICT';
  if (status === 410) return 'TASK_TERMINAL';
  return 'TEMPORARY_UNAVAILABLE';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function businessQueueNameFor(manifest: BusinessManifest): string {
  return `du-business-${manifest.businessId}-${manifest.version}`;
}

function manifestDigestFor(manifest: BusinessManifest): string {
  return `sha256:${createHash('sha256').update(canonicalize(manifest)).digest('hex')}`;
}
