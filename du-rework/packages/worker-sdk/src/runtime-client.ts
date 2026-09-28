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
  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem: ProblemDetails | null,
    message?: string
  ) {
    super(message ?? `runtime error ${status} ${code}`);
    this.name = 'RuntimeError';
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
  /** Transport-level failure where the write MAY have been applied. */
  get isAmbiguous(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

/** A write whose outcome is unknown (lost ACK). Caller must re-read context. */
export class AmbiguousReportError extends RuntimeError {
  constructor(readonly operation: string, cause?: unknown) {
    super(0, 'TEMPORARY_UNAVAILABLE', null, `ambiguous runtime report: ${operation}`);
    this.name = 'AmbiguousReportError';
    this.cause = cause;
  }
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
    opts: { ambiguousSafe?: boolean } = {}
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure: for writes this is ambiguous (server may have applied it).
      if (method !== 'GET' && opts.ambiguousSafe !== false) {
        throw new AmbiguousReportError(`${method} ${path}`, err);
      }
      throw new RuntimeError(0, 'TEMPORARY_UNAVAILABLE', null, `transport failure: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const raw: unknown = text.length > 0 ? JSON.parse(text) : undefined;

    if (!response.ok) {
      const parsedProblem = ProblemSchema.safeParse(raw);
      const problem = parsedProblem.success ? parsedProblem.data : null;
      const code = problem?.code ?? (response.status === 409 ? 'STATE_CONFLICT' : 'TEMPORARY_UNAVAILABLE');
      if (response.status >= 500 && method !== 'GET' && opts.ambiguousSafe !== false) {
        throw new AmbiguousReportError(`${method} ${path} → ${response.status}`);
      }
      throw new RuntimeError(response.status, code, problem, problem?.detail);
    }
    return parser(raw);
  }

  /* ---------------- registration & health ---------------- */

  async heartbeatWorker(instanceId: string, hb: WorkerHeartbeat): Promise<HeartbeatAck> {
    return this.request('PUT', `/workers/${encodeURIComponent(instanceId)}/heartbeat`, hb, (raw) =>
      HeartbeatAckSchema.parse(raw)
    );
  }

  /* ---------------- task lifecycle ---------------- */

  async claimTask(taskId: string, req: ClaimTaskRequest): Promise<ClaimResult> {
    // Claim is idempotent per (taskId, deliveryId): a lost ACK replay returns
    // the same lease or 409 if fenced — safe to retry transport failures.
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/claim`, req, (raw) =>
      ClaimResultSchema.parse(raw), { ambiguousSafe: false });
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

  async requestAccessGrant(artifactId: string, req: ArtifactAccessRequest): Promise<ArtifactAccessGrant> {
    return this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/access`, req, (raw) =>
      ArtifactAccessGrantSchema.parse(raw)
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