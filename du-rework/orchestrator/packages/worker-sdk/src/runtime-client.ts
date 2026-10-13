import {
  ClaimResult,
  ClaimResultSchema,
  ClaimTaskRequest,
  SaveStepRequest,
  SaveStepAck,
  SaveStepAckSchema,
  SpawnChildrenRequest,
  SpawnChildrenAck,
  SpawnChildrenAckSchema,
  WaitInputRequest,
  WaitInputAck,
  WaitInputAckSchema,
  CompleteTaskRequest,
  FailTaskRequest,
  TaskReportAck,
  TaskReportAckSchema,
  TaskHeartbeatAck,
  TaskHeartbeatAckSchema,
  HeartbeatAck,
  HeartbeatAckSchema,
  WorkerHeartbeat,
  ProgressReport,
  ArtifactUploadGrantRequest,
  ArtifactUploadGrant,
  ArtifactUploadGrantSchema,
  ArtifactFinalizeRequest,
  ArtifactAccessRequest,
  ArtifactAccessGrant,
  ArtifactAccessGrantSchema,
  MultipartInitRequest,
  MultipartInitAck,
  MultipartInitAckSchema,
  MultipartPartGrantRequest,
  MultipartPartGrant,
  MultipartPartGrantSchema,
  MultipartCompleteRequest,
  MultipartCompleteAck,
  MultipartCompleteAckSchema,
  MultipartAbortRequest,
  MultipartAbortAck,
  MultipartAbortAckSchema,
  InvocationGrantRequest,
  InvocationGrant,
  InvocationGrantSchema,
  BusinessManifest,
  businessQueueName,
  validateManifest,
  ProblemDetails,
  ProblemSchema,
} from '@du/contracts';

/**
 * Runtime API HTTP client (docs 07). All reports carry the current
 * leaseEpoch; 409 LEASE_LOST aborts the delivery (no provider calls after
 * lease loss). Ambiguous responses (network error/5xx after a write) are
 * surfaced as AmbiguousReportError so the caller re-reads context instead of
 * inventing new IDs (docs 07 error rules).
 */

export class RuntimeError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem: ProblemDetails | null,
    message?: string,
    options: { retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message ?? `runtime error ${status} ${code}`);
    this.name = 'RuntimeError';
    this.retryable = options.retryable ?? (status === 0 || status === 429 || status >= 500);
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Stale lease: worker must abort the delivery and stop provider calls. */
  get isLeaseLost(): boolean {
    return this.status === 409 && this.code === 'LEASE_LOST';
  }
  get isStateConflict(): boolean {
    return this.status === 409 && this.code === 'STATE_CONFLICT';
  }
  get isTaskTerminal(): boolean {
    return this.status === 410;
  }
  get isInputHashMismatch(): boolean {
    return this.status === 409 && this.code === 'INPUT_HASH_MISMATCH';
  }
  /** Retryable transport or server failure, including a bad success response body. */
  get isRetryable(): boolean {
    return this.retryable;
  }
  /** Transport-level failure where the write MAY have been applied. */
  get isAmbiguous(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

/** A write whose outcome is unknown (lost ACK). Caller must re-read context. */
export class AmbiguousReportError extends RuntimeError {
  constructor(readonly operation: string, cause?: unknown) {
    super(0, 'TEMPORARY_UNAVAILABLE', null, `ambiguous runtime report: ${operation}`, {
      retryable: true,
      cause,
    });
    this.name = 'AmbiguousReportError';
  }
}

export interface BusinessVersionRegistrationResult {
  businessId: string;
  version: string;
  digest: string;
  queue: string;
  created: boolean;
  replayed: boolean;
}

function parseBusinessVersionRegistrationResult(raw: unknown): BusinessVersionRegistrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('business registration response must be an object');
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.businessId !== 'string'
    || typeof value.version !== 'string'
    || typeof value.digest !== 'string'
    || typeof value.queue !== 'string'
    || typeof value.created !== 'boolean'
    || typeof value.replayed !== 'boolean'
  ) {
    throw new TypeError('business registration response has an invalid shape');
  }
  return {
    businessId: value.businessId,
    version: value.version,
    digest: value.digest,
    queue: value.queue,
    created: value.created,
    replayed: value.replayed,
  };
}

export interface RuntimeClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Transport retry for idempotent GETs only. Writes are never blind-retried. */
  timeoutMs?: number;
}

export class RuntimeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RuntimeClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    parser: (raw: unknown) => T,
    opts: { ambiguousSafe?: boolean; signal?: AbortSignal } = {}
  ): Promise<T> {
    // Serialize before starting the deadline. A local JSON error cannot have
    // reached the server and therefore cannot represent an ambiguous write.
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    const callerSignal = opts.signal;
    if (callerSignal?.aborted) throw abortReason(callerSignal);

    let rejectDeadline!: (reason: unknown) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    let rejectCallerAbort: ((reason: unknown) => void) | undefined;
    const callerAbort = callerSignal
      ? new Promise<never>((_resolve, reject) => {
          rejectCallerAbort = reject;
        })
      : undefined;
    const onCallerAbort = (): void => {
      const reason = callerSignal ? abortReason(callerSignal) : new Error('request aborted');
      controller.abort(reason);
      rejectCallerAbort?.(reason);
    };

    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    // Close the small gap between the first check and listener registration.
    if (callerSignal?.aborted) {
      callerSignal.removeEventListener('abort', onCallerAbort);
      throw abortReason(callerSignal);
    }

    let timedOut = false;
    const deadlineAt = Date.now() + this.timeoutMs;
    const timeoutError = new Error(`runtime request timed out after ${this.timeoutMs}ms`);
    timeoutError.name = 'TimeoutError';
    const assertBeforeDeadline = (): void => {
      if (Date.now() < deadlineAt) return;
      timedOut = true;
      controller.abort(timeoutError);
      throw timeoutError;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      rejectDeadline(timeoutError);
    }, this.timeoutMs);
    let response: Response | undefined;

    const operation = async (): Promise<T> => {
      const received = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.token}`,
        },
        body: serializedBody,
        signal: controller.signal,
      });
      response = received;
      assertBeforeDeadline();

      // A 5xx write can have committed before the server failed to serialize
      // its response. Do not make error-body parsing decide that outcome.
      if (!received.ok && received.status >= 500 && method !== 'GET') {
        if (opts.ambiguousSafe !== false) {
          throw new AmbiguousReportError(`${method} ${path} → ${received.status}`);
        }
        throw new RuntimeError(
          received.status,
          'TEMPORARY_UNAVAILABLE',
          null,
          `runtime request failed: ${method} ${path} (HTTP ${received.status})`,
          { retryable: true }
        );
      }

      if (!received.ok) {
        let problem: ProblemDetails | null = null;
        try {
          const text = await received.text();
          const raw: unknown = text.length > 0 ? JSON.parse(text) : undefined;
          const parsed = ProblemSchema.safeParse(raw);
          problem = parsed.success ? parsed.data : null;
        } catch {
          // HTTP status is authoritative even when an error body is malformed,
          // unreadable, or still streaming at the request deadline.
        }
        const code = problem?.code ?? fallbackRuntimeCode(received.status);
        throw new RuntimeError(
          received.status,
          code,
          problem,
          problem?.detail ?? `runtime request failed: ${method} ${path} (HTTP ${received.status})`,
          { retryable: received.status === 429 || received.status >= 500 }
        );
      }

      const text = await received.text();
      assertBeforeDeadline();
      const raw: unknown = text.length > 0 ? JSON.parse(text) : undefined;
      const parsed = parser(raw);
      assertBeforeDeadline();
      return parsed;
    };

    try {
      const races: Promise<T>[] = [operation(), deadline];
      if (callerAbort) races.push(callerAbort);
      return await Promise.race(races);
    } catch (err) {
      if (err instanceof AmbiguousReportError) throw err;
      // The operation throws this typed error after parsing a valid HTTP
      // problem. Re-throw it, while unparsed/read-failed responses are mapped
      // below using the status already observed in the headers.
      if (err instanceof RuntimeError && response && !response.ok) throw err;

      const cause = err ?? (timedOut ? new Error('runtime request timed out') : undefined);
      if (response) {
        const status = response.status;
        if (!response.ok) {
          if (status >= 500 && method !== 'GET' && opts.ambiguousSafe !== false) {
            throw new AmbiguousReportError(`${method} ${path} → ${status}`, cause);
          }
          throw new RuntimeError(
            status,
            fallbackRuntimeCode(status),
            null,
            `runtime response could not be read: ${method} ${path} (HTTP ${status})`,
            { retryable: status === 429 || status >= 500, cause }
          );
        }

        if (method !== 'GET' && opts.ambiguousSafe !== false) {
          throw new AmbiguousReportError(`${method} ${path} → ${status}`, cause);
        }
        throw new RuntimeError(
          status,
          'TEMPORARY_UNAVAILABLE',
          null,
          `runtime response could not be validated: ${method} ${path} (HTTP ${status})`,
          { retryable: true, cause }
        );
      }

      if (method !== 'GET' && opts.ambiguousSafe !== false) {
        throw new AmbiguousReportError(`${method} ${path}`, cause);
      }
      throw new RuntimeError(
        0,
        'TEMPORARY_UNAVAILABLE',
        null,
        `runtime transport failure: ${method} ${path}`,
        { retryable: true, cause }
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /* ---------------- registration & health ---------------- */

  async registerBusinessVersion(
    manifest: BusinessManifest,
    signal?: AbortSignal
  ): Promise<BusinessVersionRegistrationResult> {
    const validation = validateManifest(manifest);
    if (!validation.ok) {
      throw new RuntimeError(422, 'INVALID_SCHEMA', null, 'business manifest failed SDK validation');
    }
    const expected = validation.manifest;
    const registration = await this.request(
      'PUT',
      `/businesses/${encodeURIComponent(expected.businessId)}/versions/${encodeURIComponent(expected.version)}`,
      expected,
      parseBusinessVersionRegistrationResult,
      { signal }
    );
    const expectedQueue = businessQueueName(expected.businessId, expected.version);
    if (
      registration.businessId !== expected.businessId
      || registration.version !== expected.version
      || registration.digest !== validation.digest
      || registration.queue !== expectedQueue
    ) {
      throw new RuntimeError(
        200,
        'REGISTRATION_RESPONSE_MISMATCH',
        null,
        'runtime registration response does not match the submitted manifest',
        { retryable: false }
      );
    }
    return registration;
  }

  async heartbeatWorker(instanceId: string, hb: WorkerHeartbeat, signal?: AbortSignal): Promise<HeartbeatAck> {
    return this.request(
      'PUT',
      `/workers/${encodeURIComponent(instanceId)}/heartbeat`,
      hb,
      parseHeartbeatAck,
      { signal }
    );
  }

  /** Retire this boot's exact registered identity after the consumer drains. */
  async retireWorker(
    instanceId: string,
    identity: { businessId: string; businessVersion: string; manifestDigest: string }
  ): Promise<void> {
    await this.request(
      'POST',
      `/workers/${encodeURIComponent(instanceId)}/retire`,
      identity,
      () => undefined,
      { ambiguousSafe: false }
    );
  }

  /* ---------------- task lifecycle ---------------- */

  async claimTask(taskId: string, req: ClaimTaskRequest): Promise<ClaimResult> {
    // Claim is idempotent per (taskId, deliveryId): a lost ACK replay returns
    // the same lease or a denial if no claim committed. Ambiguous responses
    // are safe to reconcile with the exact same identity, including after a
    // version cutover.
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/claim`, req, (raw) =>
      ClaimResultSchema.parse(raw), { ambiguousSafe: true });
  }

  async heartbeatTask(taskId: string, leaseEpoch: number): Promise<TaskHeartbeatAck> {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/heartbeat`, { leaseEpoch }, (raw) =>
      TaskHeartbeatAckSchema.parse(raw)
    , { ambiguousSafe: false });
  }

  async saveStep(taskId: string, stepKey: string, req: SaveStepRequest): Promise<SaveStepAck> {
    // Idempotent: identical replay returns 200 with replayed=true.
    return this.request(
      'PUT',
      `/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepKey)}`,
      req,
      (raw) => SaveStepAckSchema.parse(raw)
    );
  }

  async reportProgress(taskId: string, req: ProgressReport): Promise<void> {
    // Progress is best-effort: ambiguity tolerated (coalesced anyway).
    await this.request('POST', `/tasks/${encodeURIComponent(taskId)}/progress`, req, () => undefined, {
      ambiguousSafe: false,
    }).catch((err) => {
      if (err instanceof RuntimeError && (err.isLeaseLost || err.isTaskTerminal)) throw err;
      // swallow transient progress failures
    });
  }

  async spawnChildren(taskId: string, req: SpawnChildrenRequest): Promise<SpawnChildrenAck> {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/children`, req, (raw) =>
      SpawnChildrenAckSchema.parse(raw)
    );
  }

  async waitInput(taskId: string, req: WaitInputRequest): Promise<WaitInputAck> {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/wait-input`, req, (raw) =>
      WaitInputAckSchema.parse(raw)
    );
  }

  async completeTask(taskId: string, req: CompleteTaskRequest): Promise<TaskReportAck> {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/complete`, req, (raw) =>
      TaskReportAckSchema.parse(raw)
    );
  }

  async failTask(taskId: string, req: FailTaskRequest): Promise<TaskReportAck> {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/fail`, req, (raw) =>
      TaskReportAckSchema.parse(raw)
    );
  }

  /* ---------------- artifacts ---------------- */

  async requestUploadGrant(taskId: string, req: ArtifactUploadGrantRequest): Promise<ArtifactUploadGrant> {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/artifacts`, req, (raw) =>
      ArtifactUploadGrantSchema.parse(raw)
    );
  }

  async finalizeArtifact(artifactId: string, req: ArtifactFinalizeRequest): Promise<void> {
    await this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/finalize`, req, () => undefined);
  }

  async requestAccessGrant(
    artifactId: string,
    req: ArtifactAccessRequest,
    opts: { signal?: AbortSignal } = {}
  ): Promise<ArtifactAccessGrant> {
    return this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/access`, req, (raw) =>
      ArtifactAccessGrantSchema.parse(raw),
      { signal: opts.signal }
    );
  }

  /* ---------------- multipart upload lifecycle (DATA-00-M / DATA-04) ------ */

  async multipartInit(taskId: string, req: MultipartInitRequest): Promise<MultipartInitAck> {
    // uploadToken in the body is the server-side replay key: a lost ACK is
    // recovered by retrying with the SAME token (200 replayed), never by
    // minting a second provider upload.
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/artifacts/multipart`, req, (raw) =>
      MultipartInitAckSchema.parse(raw)
    );
  }

  async multipartPartGrant(artifactId: string, req: MultipartPartGrantRequest): Promise<MultipartPartGrant> {
    return this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/multipart/part`, req, (raw) =>
      MultipartPartGrantSchema.parse(raw)
    );
  }

  async multipartComplete(artifactId: string, req: MultipartCompleteRequest): Promise<MultipartCompleteAck> {
    return this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/multipart/complete`, req, (raw) =>
      MultipartCompleteAckSchema.parse(raw)
    );
  }

  async multipartAbort(artifactId: string, req: MultipartAbortRequest): Promise<MultipartAbortAck> {
    return this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/multipart/abort`, req, (raw) =>
      MultipartAbortAckSchema.parse(raw)
    );
  }

  /* ---------------- invocation grants ---------------- */

  async requestInvocationGrant(taskId: string, req: InvocationGrantRequest): Promise<InvocationGrant> {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/invocation-grants`, req, (raw) =>
      InvocationGrantSchema.parse(raw)
    );
  }
}

/**
 * Keep the established heartbeat controls usable when a server sends an
 * unknown or malformed additive version-admission tuple. The worker will
 * close new task admission until it receives a complete, valid tuple, while
 * still applying the independently parsed control and backup-fence state to
 * already-running work.
 */
function parseHeartbeatAck(raw: unknown): HeartbeatAck {
  const parsed = HeartbeatAckSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const base = HeartbeatAckSchema.omit({
    activeVersion: true,
    activationRevision: true,
    admissionEligible: true,
    admissionReason: true,
  }).parse(raw);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const revision = (raw as Record<string, unknown>).activationRevision;
  return Number.isSafeInteger(revision) && (revision as number) >= 1
    ? { ...base, activationRevision: revision as number }
    : base;
}

function fallbackRuntimeCode(status: number): string {
  if (status === 409) return 'STATE_CONFLICT';
  if (status === 410) return 'TASK_TERMINAL';
  return 'TEMPORARY_UNAVAILABLE';
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
