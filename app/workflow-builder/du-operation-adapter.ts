// app/workflow-builder/du-operation-adapter.ts
// Client-side adapter that maps a Workflow Builder run schema into the
// DU Rework standard Operation submission contract, plus a polling helper
// that decodes `OperationView` status responses.
//
// Contract source: `du-rework/packages/contracts/src/operations.ts` (the
// canonical DU Rework DTO). Per the W32-CC packet, the adapter targets the
// standard `POST /api/v1/operations` endpoint with the DU Rework submission
// shape `{ businessId, action, input, idempotencyKey }`, and polls
// `GET /api/v1/operations/:id` returning a `OperationView`.
//
// This module is pure / dependency-injectable (no global `fetch` calls):
// tests inject a `DuFetcher` mock to exercise the submit + poll paths without
// real network I/O. The same wiring pattern as `run-schema-client.ts`.

/** Minimal `fetch`-compatible signature used by submit / poll. */
export type DuFetcher = typeof fetch;

/** Canonical DU Rework operation submission shape (per W32-CC packet + `SubmissionSchema`). */
export interface DuOperationSubmission {
  businessId: string;
  action: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

/** POST /api/v1/operations canonical response: a created OperationView. */
export interface DuOperationCreated {
  /** Operation UUID assigned by the server. */
  operationId: string;
  /** Self link — usually `/api/v1/operations/<id>`. */
  selfLink: string;
  /** Initial state — typically `ACCEPTED` or `QUEUED` immediately after submit. */
  initialState: string;
}

/** DU Rework OperationView (subset — full schema in `du-rework/packages/contracts`). */
export interface DuOperationView {
  id: string;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  action: string;
  state: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string | null;
  replayOf?: string | null;
  progress: { percent: number; message?: string };
  links: { self: string; result: string };
}

export interface DuOperationDetail extends DuOperationView {
  wait?: unknown;
  error?: { code: string; title: string; detail?: string } | null;
}

/** Terminal states per `TERMINAL_OPERATION_STATES` in the DU Rework contracts. */
export const DU_TERMINAL_STATES: readonly string[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
];

export function isTerminalState(state: string): boolean {
  return DU_TERMINAL_STATES.includes(state);
}

export interface DuSubmitOutcome {
  ok: boolean;
  status: number;
  /** Server-side reason / detail (from ProblemDetails or generic). */
  detail: string;
  title?: string;
  /** Populated on success. */
  created?: DuOperationCreated;
}

export interface DuPollOutcome {
  ok: boolean;
  status: number;
  detail: string;
  title?: string;
  /** Populated on success. */
  view?: DuOperationDetail;
  /** Convenience: `true` when `view.state` is one of DU_TERMINAL_STATES. */
  terminal?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Mapping: WorkflowBuilder run schema → DuOperationSubmission
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Workflow Builder run input (UI side). Captures the minimum surface that the
 * Run modal currently hands to the legacy `/api/v1/docs/workflows/schema`
 * route. We expose this as the typed source-of-truth so the adapter is
 * deterministic and testable.
 */
export interface WorkflowBuilderRunInput {
  /** Slug of the imported workflow schema (e.g. `disbursement`). */
  workflowSlug: string;
  /** Map of `input_schema` property keys → values. */
  inputs: Record<string, unknown>;
  /** Optional multi-file payload — adapter currently encodes as `input.files`. */
  files?: Array<{ name: string; size: number; mime: string }>;
}

/**
 * Map a Workflow Builder run input into a DU Rework canonical submission.
 *
 * Mapping rules (mirrors the existing schema-route behavior, but projected
 * onto the DU Rework business shape):
 *   - `businessId`     ← `workflowSlug` (the DU Rework business identifier
 *                        that owns the action).
 *   - `action`         ← `'run'` (the canonical business action for ad-hoc
 *                        Workflow Builder submissions).
 *   - `input`          ← `inputs`, augmented with a `files` array when files
 *                        are attached (files are referenced, not uploaded,
 *                        by this adapter — the existing `POST /api/v1/operations`
 *                        contract takes JSON, not multipart).
 *   - `idempotencyKey` ← deterministic sha256 of normalized input (when
 *                        `useDeterministicKey` is true), enabling safe client
 *                        retries without server-side 409 conflicts.
 */
export interface MapRunToSubmissionOptions {
  /** Override `businessId` derivation; defaults to `workflowSlug`. */
  businessId?: string;
  /** Override `action`; defaults to `'run'`. */
  action?: string;
  /**
   * If true, populate `idempotencyKey` with a deterministic sha256 over the
   * normalized input. Defaults to true — the canonical DU Rework contract
   * requires idempotency keys for retryable submits.
   */
  useDeterministicKey?: boolean;
}

export function mapWorkflowRunToSubmission(
  run: WorkflowBuilderRunInput,
  options: MapRunToSubmissionOptions = {},
): DuOperationSubmission {
  const businessId = options.businessId ?? run.workflowSlug;
  const action = options.action ?? 'run';
  const input: Record<string, unknown> = { ...run.inputs };
  if (run.files && run.files.length > 0) {
    input.files = run.files.map((f) => ({ name: f.name, size: f.size, mime: f.mime }));
  }

  const submission: DuOperationSubmission = { businessId, action, input };
  const useKey = options.useDeterministicKey !== false;
  if (useKey) {
    submission.idempotencyKey = computeIdempotencyKey(submission);
  }
  return submission;
}

/**
 * Alias of `mapWorkflowRunToSubmission` named for the W33-CC UI integration
 * packet. Same behavior, shorter name for call sites that consume the
 * result and immediately submit.
 */
export const toDuSubmitPayload = mapWorkflowRunToSubmission;

/**
 * Normalize a submission for hashing, then sha256 it. Stable across key
 * orderings so retries with the same logical input produce the same key.
 *
 * Uses Node 20+'s built-in `crypto.subtle.digest` is async; for a sync
 * deterministic key (needed at submit time and in tests) we use
 * `crypto.createHash`. This module is browser/Node-compatible: Node 20+'s
 * `crypto.createHash` is available globally there, and the browser shim is
 * not needed because the adapter is only invoked at click-time on the
 * Workflow Builder page (a Node process).
 */
export function computeIdempotencyKey(submission: DuOperationSubmission): string {
  const normalized = JSON.stringify(normalizeForHash(submission));
  // Synchronous hash — safe in any Node 20+ / Next.js client bundle because
  // `crypto` is a Web Crypto polyfill in Next.js edge / browser contexts.
  // We import lazily to keep the module ESM-friendly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = require('crypto') as typeof import('crypto');
  return nodeCrypto.createHash('sha256').update(normalized).digest('hex');
}

function normalizeForHash(submission: DuOperationSubmission): DuOperationSubmission {
  // Stable JSON key order is required so retries with the same input hash
  // to the same key. `JSON.stringify` on plain objects preserves insertion
  // order, but we explicitly sort the top-level keys to defend against
  // callers that pass differently-ordered objects.
  const out: DuOperationSubmission = {
    businessId: submission.businessId,
    action: submission.action,
    input: sortKeysDeep(submission.input) as Record<string, unknown>,
  };
  return out;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return value;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Submit: POST /api/v1/operations
 * ──────────────────────────────────────────────────────────────────────────── */

export const DU_OPERATIONS_ENDPOINT = '/api/v1/operations';

function makeOpView(body: unknown): DuOperationDetail | null {
  if (!body || typeof body !== 'object') return null;
  const view = body as Partial<DuOperationDetail>;
  if (typeof view.id !== 'string') return null;
  if (typeof view.state !== 'string') return null;
  if (!view.progress || typeof view.progress.percent !== 'number') return null;
  return view as DuOperationDetail;
}

function makeOpCreated(body: unknown): DuOperationCreated | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string'
    ? b.id
    : typeof b.operationId === 'string'
      ? b.operationId
      : null;
  if (!id) return null;
  const links = b.links as { self?: unknown } | undefined;
  const self = typeof links?.self === 'string'
    ? links.self
    : `/api/v1/operations/${id}`;
  const initialState = typeof b.state === 'string' ? b.state : 'ACCEPTED';
  return { operationId: id, selfLink: self, initialState };
}

/**
 * Submit a DU Rework operation. Reduces the wire response into a typed
 * `DuSubmitOutcome`. The default `fetcher` is the global `fetch`; tests
 * inject a pure mock.
 */
export async function submitDuOperation(
  submission: DuOperationSubmission,
  fetcher: DuFetcher = fetch,
): Promise<DuSubmitOutcome> {
  let response: Response;
  try {
    response = await fetcher(DU_OPERATIONS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
    });
  } catch {
    return { ok: false, status: 0, detail: 'Lỗi kết nối' };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = extractProblemDetail(body) ?? `HTTP ${response.status}`;
    const title = extractProblemTitle(body);
    return { ok: false, status: response.status, detail, title };
  }

  const created = makeOpCreated(body);
  if (!created) {
    return {
      ok: false,
      status: response.status,
      detail: 'Response thiếu operation id',
      title: extractProblemTitle(body),
    };
  }
  return { ok: true, status: response.status, detail: 'OK', created };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Poll: GET /api/v1/operations/:id
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Poll the status of a DU Rework operation. Returns the typed `OperationView`
 * plus a `terminal` flag derived from `DU_TERMINAL_STATES`.
 *
 * Polling interval and timeout are caller-driven: this helper is a single
 * read, not a long-poll loop. Tests advance the operation through several
 * poll cycles by feeding a sequence of fetcher responses.
 */
export async function pollDuOperation(
  operationId: string,
  fetcher: DuFetcher = fetch,
): Promise<DuPollOutcome> {
  const endpoint = `${DU_OPERATIONS_ENDPOINT}/${encodeURIComponent(operationId)}`;
  let response: Response;
  try {
    response = await fetcher(endpoint, { method: 'GET' });
  } catch {
    return { ok: false, status: 0, detail: 'Lỗi kết nối' };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = extractProblemDetail(body) ?? `HTTP ${response.status}`;
    const title = extractProblemTitle(body);
    return { ok: false, status: response.status, detail, title };
  }

  const view = makeOpView(body);
  if (!view) {
    return {
      ok: false,
      status: response.status,
      detail: 'Response không phải OperationView hợp lệ',
      title: extractProblemTitle(body),
    };
  }
  return {
    ok: true,
    status: response.status,
    detail: 'OK',
    view,
    terminal: isTerminalState(view.state),
  };
}

/**
 * Convenience: run `pollDuOperation` repeatedly until the operation reaches
 * a terminal state, the deadline expires, or `maxAttempts` is reached.
 * Honors a `signal` for cancellation.
 *
 * Pure helper: each iteration is a single `pollDuOperation` call; tests
 * inject a fetcher whose responses advance the operation through the
 * state machine.
 */
export interface PollUntilTerminalOptions {
  maxAttempts?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export async function pollUntilTerminal(
  operationId: string,
  fetcher: DuFetcher,
  options: PollUntilTerminalOptions = {},
): Promise<DuPollOutcome> {
  const maxAttempts = options.maxAttempts ?? 30;
  const intervalMs = options.intervalMs ?? 0;
  let last: DuPollOutcome | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    if (options.signal?.aborted) {
      return { ok: false, status: 0, detail: 'Polling đã bị hủy' };
    }
    last = await pollDuOperation(operationId, fetcher);
    if (!last.ok) return last;
    if (last.terminal) return last;
    if (intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return (
    last ?? {
      ok: false,
      status: 0,
      detail: 'Đã đạt số lần thử tối đa',
    }
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * ProblemDetails extraction helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function extractProblemDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === 'string' && detail.length > 0 ? detail : null;
}

function extractProblemTitle(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const title = (body as { title?: unknown }).title;
  return typeof title === 'string' ? title : undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * High-level pipeline: mapping → submit → poll-to-terminal
 * (W33-CC UI integration boundary)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface RunDuPipelineInput {
  run: WorkflowBuilderRunInput;
  options?: MapRunToSubmissionOptions;
  poll?: PollUntilTerminalOptions;
}

export type RunDuPipelineOutcome =
  | {
      ok: true;
      status: 202;
      operationId: string;
      operationUrl: string;
      /** Terminal state observed at the end of polling (one of DU_TERMINAL_STATES). */
      terminalState: string;
      /** Final OperationView snapshot (always present when ok=true). */
      view: DuOperationDetail;
    }
  | {
      ok: false;
      /** 0 on network error, otherwise the upstream HTTP status. */
      status: number;
      detail: string;
      /** Phase at which the pipeline failed: 'submit' or 'poll'. */
      phase: 'submit' | 'poll';
      title?: string;
    };

/**
 * Pure orchestration: mapping → submit → poll-to-terminal. The `fetcher`
 * parameter is injected so tests can drive the full pipeline through a
 * mock without real network I/O. The UI page (`page.tsx`) is a thin caller
 * of this helper; this is the boundary the W33-CC packet exercises.
 */
export async function runDuSubmitPipeline(
  input: RunDuPipelineInput,
  fetcher: DuFetcher = fetch,
): Promise<RunDuPipelineOutcome> {
  const submission = toDuSubmitPayload(input.run, input.options);
  const submitOutcome = await submitDuOperation(submission, fetcher);
  if (!submitOutcome.ok || !submitOutcome.created) {
    return {
      ok: false,
      status: submitOutcome.status,
      detail: submitOutcome.detail,
      phase: 'submit',
      title: submitOutcome.title,
    };
  }
  const opId = submitOutcome.created.operationId;
  const pollResult = await pollUntilTerminal(opId, fetcher, input.poll);
  if (!pollResult.ok || !pollResult.view) {
    return {
      ok: false,
      status: pollResult.status,
      detail: pollResult.detail,
      phase: 'poll',
    };
  }
  return {
    ok: true,
    status: 202,
    operationId: opId,
    operationUrl: `/operations/${opId}`,
    terminalState: pollResult.view.state,
    view: pollResult.view,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * W34-CC: Run-modal engine selector (typed dispatch boundary)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The two execution engines the Workflow Builder Run modal can dispatch to.
 * The string values are stable identifiers used by the toggle component
 * and by the typed dispatch boundary below.
 */
export type RunEngine = 'du_adapter' | 'legacy';

export interface RunEngineDecisionInput {
  /** Schema-declared default (from `WorkflowSchema.useDuAdapter`). */
  schemaDefault: boolean;
  /** User's current toggle choice inside the Run modal. */
  userToggle: RunEngine;
}

export interface RunEngineDecision {
  engine: RunEngine;
  reason: 'user_toggle' | 'schema_default_legacy' | 'schema_default_du';
  businessId: string;
  action: string;
}

/**
 * Pure typed boundary that decides which execution engine a Run submit
 * uses. The user toggle wins when set to either value; the schema default
 * only applies when the toggle state is absent. Mirrors the UI rules:
 *
 *   user toggle === 'du_adapter' → use DU adapter (always).
 *   user toggle === 'legacy'     → use Legacy Runner (always).
 *
 * This helper takes the schema-level `useDuAdapter` as the prefill value
 * and the user's current toggle selection, then returns the resolved
 * engine + the canonical `businessId`/`action` overrides (schema > default).
 */
export function decideRunEngine(
  schema: { useDuAdapter?: boolean; slug: string; businessId?: string; action?: string },
  userToggle: RunEngine,
  fallback: RunEngine = 'du_adapter',
): RunEngineDecision {
  const engine: RunEngine =
    userToggle === 'du_adapter' || userToggle === 'legacy'
      ? userToggle
      : schema.useDuAdapter === true
        ? 'du_adapter'
        : schema.useDuAdapter === false
          ? 'legacy'
          : fallback;

  const reason: RunEngineDecision['reason'] =
    userToggle === 'du_adapter'
      ? 'user_toggle'
      : userToggle === 'legacy'
        ? 'user_toggle'
        : engine === 'du_adapter'
          ? 'schema_default_du'
          : 'schema_default_legacy';

  return {
    engine,
    reason,
    businessId: schema.businessId ?? schema.slug,
    action: schema.action ?? 'run',
  };
}

/**
 * Convenience: build the DU submission payload for a given workflow + user
 * inputs using the engine-decision result. This keeps the page-side submit
 * flow thin: decide → build → submit.
 */
export function buildSubmissionForEngine(
  schema: { useDuAdapter?: boolean; slug: string; businessId?: string; action?: string },
  decision: RunEngineDecision,
  inputs: Record<string, unknown>,
  files?: Array<{ name: string; size: number; mime: string }>,
): DuOperationSubmission {
  return toDuSubmitPayload(
    { workflowSlug: decision.businessId, inputs, files },
    { businessId: decision.businessId, action: decision.action },
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * W36-CC: Human-in-the-Loop resume — POST /api/v1/operations/:id/resume
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DuResumeRequest {
  /** Optional step index the resume applies to. Mirrors the legacy route. */
  step?: number;
  /** Edited / confirmed `extracted_data` payload to apply before resume. */
  extracted_data?: unknown;
}

export interface DuResumeAccepted {
  ok: true;
  status: number;
  replayed: boolean;
  view?: DuOperationDetail;
  state: string;
}

export interface DuResumeRejected {
  ok: false;
  status: number;
  detail: string;
  title?: string;
  conflict: boolean;
  message: string;
}

export interface DuResumeNetworkError {
  ok: false;
  status: 0;
  detail: 'Lỗi kết nối';
  conflict: false;
  message: string;
}

export type DuResumeOutcome =
  | DuResumeAccepted
  | DuResumeRejected
  | DuResumeNetworkError;

/**
 * Resume a paused DU operation. Calls
 * `POST /api/v1/operations/${encodeURIComponent(operationId)}/resume` with
 * a JSON body of `{ step?, extracted_data? }`. The default `fetcher`
 * is the global `fetch`; tests inject a pure mock.
 */
export async function resumeDuOperation(
  operationId: string,
  payload: DuResumeRequest = {},
  fetcher: DuFetcher = fetch,
): Promise<DuResumeOutcome> {
  if (!operationId || !operationId.trim()) {
    return {
      ok: false,
      status: 400,
      detail: 'operationId is required',
      conflict: false,
      message: 'operationId is required',
    };
  }
  const endpoint = `${DU_OPERATIONS_ENDPOINT}/${encodeURIComponent(operationId)}/resume`;
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Lỗi kết nối',
      conflict: false,
      message: 'Lỗi kết nối',
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = extractProblemDetail(body) ?? `HTTP ${response.status}`;
    const title = extractProblemTitle(body);
    const conflict = response.status === 409;
    return {
      ok: false,
      status: response.status,
      detail,
      title,
      conflict,
      message: detail,
    };
  }

  const replayed = Boolean(
    body && typeof body === 'object' && (body as { replayed?: unknown }).replayed,
  );
  const view = makeOpView(body) ?? undefined;
  const state = view?.state ?? 'RUNNING';
  return { ok: true, status: response.status, replayed, view, state };
}

/**
 * Convenience: after a successful submit + poll cycle reaches a non-terminal
 * state (e.g. `WAITING_INPUT`), this helper performs the resume call and
 * resumes polling until the operation reaches a terminal state.
 *
 * The function preserves the existing `pollUntilTerminal` contract and
 * does NOT change the upstream fetcher between phases — the same `fetcher`
 * argument is reused so the mocked seam remains a single dependency.
 */
export async function resumeDuAndPollUntilTerminal(
  operationId: string,
  payload: DuResumeRequest,
  fetcher: DuFetcher,
  pollOptions: PollUntilTerminalOptions = {},
): Promise<RunDuPipelineOutcome> {
  const resumeOutcome = await resumeDuOperation(operationId, payload, fetcher);
  if (!resumeOutcome.ok) {
    return {
      ok: false,
      status: resumeOutcome.status,
      detail: resumeOutcome.detail,
      phase: 'poll',
      ...('title' in resumeOutcome ? { title: resumeOutcome.title } : {}),
    };
  }
  const pollResult = await pollUntilTerminal(operationId, fetcher, pollOptions);
  if (!pollResult.ok || !pollResult.view) {
    return {
      ok: false,
      status: pollResult.status,
      detail: pollResult.detail,
      phase: 'poll',
    };
  }
  return {
    ok: true,
    status: 202,
    operationId,
    operationUrl: `/operations/${operationId}`,
    terminalState: pollResult.view.state,
    view: pollResult.view,
  };
}
