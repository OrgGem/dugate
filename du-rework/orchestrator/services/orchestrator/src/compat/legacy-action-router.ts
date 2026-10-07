/**
 * COMP-03: isolated route handler for the six legacy core action endpoints.
 *
 * Legacy external clients POST multipart to {@code /api/v1/docs/{ingest,extract,
 * analyze,transform,generate,compare}} with snake_case fields, a service
 * discriminator and {@code ?sync=true}. This module decodes that wire and
 * dispatches into the canonical submission service, then projects the result
 * back onto the LEGACY response envelope.
 *
 * ## Isolation contract
 *
 * This file imports nothing from {@code server.ts} and nothing from
 * {@code packages/contracts/public-api.ts}, so it can be adopted without either
 * file changing first. The only sibling import is the COMP-02 wire decoder,
 * which is itself a pure function. Everything that touches the database, the
 * queue or the identity of the caller arrives through injected ports, so this
 * module is unit-testable with no live infrastructure.
 *
 * ## Wire shape (measured from the legacy system, not from documentation)
 *
 * The submit envelope is the one emitted by {@code formatOperationResponse()}:
 *
 *   { name: 'operations/{id}', done, metadata: { state, pipeline, current_step,
 *     progress_percent, progress_message, create_time, update_time,
 *     pipeline_steps }, result?, error? }
 *
 * It is NOT {@code { operation_id, status }}. That shape appears nowhere in the
 * six core submit responses; {@code operation_id} is emitted only by internal
 * pipeline engine step events, never on this wire. See the COMP-03 receipt for
 * the MISMATCH record.
 *
 * Status selection is the legacy rule verbatim: 200 when the call was
 * synchronous or an idempotent replay, 202 otherwise. Operation-Location is
 * attached to the 202 only, because a 200 response already carries the
 * settled operation inline.
 *
 * ## Security posture
 *
 * Tenant and key identity come ONLY from {@link LegacyActionPrincipalResolver},
 * which the host wires to its own authentication. The request type carries no
 * identity field at all, so a hostile body cannot express one; the decoder
 * independently drops identity-looking body fields. The test suite pins both.
 *
 * Unexpected dispatcher failures return a fixed message plus the correlation
 * id and never the raw {@code err.message}, per ADM-BASE-03. The legacy system
 * did echo the raw message into its 500 body; that is a security regression we
 * are deliberately not reproducing (recorded as a hardening deviation).
 */

import { randomUUID } from 'node:crypto';
import {
  decodeLegacyWire,
  LegacyWireDecodeError,
  LEGACY_CORE_ACTIONS,
  type LegacyCoreAction,
  type LegacyDecodedSubmission,
  type LegacyFilePart,
  type LegacyWireRequest,
} from './legacy-wire-decoders';

/* ------------------------------------------------------------------ */
/* Wire constants                                                       */
/* ------------------------------------------------------------------ */

/** The legacy prefix. The guide also shows {@code /api/v1/{action}}, which the
 * legacy code never mounted - that is a known MISMATCH, and matching it here
 * would be a NEW surface rather than a compat one. */
export const LEGACY_ACTION_PATH_PREFIX = '/api/v1/docs/';

/** Header the legacy runner attached to every 202. */
export const LEGACY_OPERATION_LOCATION_HEADER = 'Operation-Location';

const LEGACY_ERROR_BASE = 'https://dugate.vn/errors/';

const TERMINAL_OPERATION_STATES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

/* ------------------------------------------------------------------ */
/* Ports                                                                */
/* ------------------------------------------------------------------ */

/**
 * The authenticated caller, as resolved by the host. Never derived from the
 * request body, the multipart fields, or any body-supplied identity key.
 */
export interface LegacyActionPrincipal {
  readonly tenantId: string;
  readonly apiKeyId: string;
}

/**
 * Resolves the caller from transport headers. A real deployment wires this to
 * the orchestrator's own API-key resolution; returning {@code null} produces a
 * legacy 401 rather than an unhandled throw.
 */
export type LegacyActionPrincipalResolver = (
  headers: LegacyWireRequest['headers'],
) => LegacyActionPrincipal | null | Promise<LegacyActionPrincipal | null>;

/** Everything the dispatcher is allowed to see about a legacy request. */
export interface LegacyActionDispatchInput {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly businessId: string;
  readonly action: LegacyCoreAction;
  readonly variant: string;
  readonly submission: LegacyDecodedSubmission;
  readonly files: readonly LegacyFilePart[];
  readonly fileUrls: readonly Record<string, unknown>[];
  readonly idempotencyKey?: string;
  readonly correlationId: string;
  readonly executeSync: boolean;
}

/** Usage counters as the canonical side records them. */
export interface LegacyActionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly pagesProcessed?: number;
  readonly modelUsed?: string | null;
  readonly costUsd?: number;
  readonly breakdown?: unknown;
}

export interface LegacyActionFailure {
  readonly code: string;
  readonly message: string;
  readonly failedStep?: number | null;
}

/**
 * The settled state of a dispatched operation, as far as the LEGACY wire is
 * concerned. Every optional field is optional because the submit path answers
 * before any of them exist; the legacy 202 body carried the same partial shape.
 */
export interface LegacyActionDispatchResult {
  readonly operationId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True when this call replayed an existing operation. Drives 200 vs 202. */
  readonly replayed: boolean;
  readonly progressPercent?: number;
  readonly progressMessage?: string | null;
  readonly currentStep?: number;
  readonly pipeline?: readonly string[];
  readonly pipelineSteps?: unknown;
  readonly outputFormat?: string;
  readonly outputContent?: string | null;
  readonly extractedData?: unknown;
  readonly usage?: LegacyActionUsage;
  readonly failure?: LegacyActionFailure | null;
}

/**
 * The canonical submission seam. A real deployment injects the orchestrator's
 * submission service; tests inject a stub. It owns admission, profile policy,
 * tenant fencing, storage and the queue - this module owns none of that.
 */
export interface LegacyActionDispatchPort {
  submit(input: LegacyActionDispatchInput): Promise<LegacyActionDispatchResult>;
}

export interface LegacyActionRouterOptions {
  readonly dispatch: LegacyActionDispatchPort;
  /** Canonical business the six core actions route into. */
  readonly businessId?: string;
  readonly resolvePrincipal: LegacyActionPrincipalResolver;
  /** Injected for deterministic tests; defaults to crypto.randomUUID. */
  readonly newCorrelationId?: () => string;
}

export const DEFAULT_LEGACY_ACTION_BUSINESS_ID = 'document-core';

/* ------------------------------------------------------------------ */
/* Request / response                                                   */
/* ------------------------------------------------------------------ */

/**
 * A legacy request, already split by the host. Note the absence of any
 * identity field: tenant and key cannot be expressed here, only resolved.
 */
export interface LegacyActionRouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly headers?: LegacyWireRequest['headers'];
  readonly query?: LegacyWireRequest['query'];
  readonly form?: unknown;
  readonly body?: unknown;
}

export interface LegacyActionRouteResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

export interface LegacyActionRouter {
  /** True when this router owns the path. Mount ahead of the canonical route. */
  handles(pathname: string): boolean;
  /**
   * Returns {@code null} for a path this router does not own, so the host can
   * fall through to the canonical route instead of this module claiming
   * traffic it was not given.
   */
  handle(request: LegacyActionRouteRequest): Promise<LegacyActionRouteResponse | null>;
  /** Same as handle but rejects instead of returning null on a foreign path. */
  handleOwned(request: LegacyActionRouteRequest): Promise<LegacyActionRouteResponse>;
}

/* ------------------------------------------------------------------ */
/* Path + error projection                                              */
/* ------------------------------------------------------------------ */

/** Extract the legacy core action from a pathname, or null when foreign. */
export function parseLegacyActionPath(pathname: string): LegacyCoreAction | null {
  if (!pathname.startsWith(LEGACY_ACTION_PATH_PREFIX)) return null;
  const rest = pathname.slice(LEGACY_ACTION_PATH_PREFIX.length);
  if (rest === '' || rest.includes('/')) return null;
  return (LEGACY_CORE_ACTIONS as readonly string[]).includes(rest)
    ? (rest as LegacyCoreAction)
    : null;
}

/** The legacy error body: apiError() from the legacy runner, field for field. */
export function legacyErrorBody(
  status: number,
  title: string,
  detail: string,
): Record<string, unknown> {
  return {
    type: LEGACY_ERROR_BASE + title.toLowerCase().replace(/\s+/g, '-'),
    title,
    status,
    detail,
  };
}

function legacyErrorResponse(
  status: number,
  title: string,
  detail: string,
  correlationId?: string,
): LegacyActionRouteResponse {
  const body = legacyErrorBody(status, title, detail);
  if (correlationId !== undefined) body.correlationId = correlationId;
  return { status, body, headers: {} };
}

/**
 * Project a decoder rejection onto the legacy error surface.
 *
 * Every decoder rejection the six core actions can raise is a 400 Invalid
 * Parameter, which is what the legacy runner answered for a bad or unknown
 * discriminator. UNSUPPORTED_ACTION is a 404 only for completeness: the router
 * matches paths itself, so an unknown action never reaches the decoder.
 */
export function toLegacyDecodeError(error: LegacyWireDecodeError): {
  status: number;
  title: string;
  detail: string;
} {
  if (error.code === 'UNSUPPORTED_ACTION') {
    return { status: 404, title: 'Service Not Found', detail: error.message };
  }
  return { status: 400, title: 'Invalid Parameter', detail: error.message };
}

/* ------------------------------------------------------------------ */
/* Envelope projection                                                  */
/* ------------------------------------------------------------------ */

function isDone(state: string): boolean {
  return TERMINAL_OPERATION_STATES.has(state);
}

/**
 * Build the legacy success body.
 *
 * The result/error blocks are gated on state exactly as the legacy formatter
 * gated them on done && state. A CANCELLED or TIMED_OUT operation is
 * done: true with NEITHER block - that is legacy behaviour, and inventing an
 * error object for a cancellation would be a wire change.
 *
 * The FAILED partial-result block deliberately omits pages_processed and
 * model_used: the legacy formatter emitted the short usage shape on failure.
 */
export function toLegacyOperationEnvelope(
  result: LegacyActionDispatchResult,
): Record<string, unknown> {
  const state = result.state;
  const done = isDone(state);
  const steps = result.pipelineSteps ?? [];
  const format = result.outputFormat ?? 'json';

  const body: Record<string, unknown> = {
    name: 'operations/' + result.operationId,
    done,
    metadata: {
      state,
      pipeline: [...(result.pipeline ?? [])],
      current_step: result.currentStep ?? 0,
      progress_percent: result.progressPercent ?? 0,
      progress_message: result.progressMessage ?? null,
      create_time: result.createdAt,
      update_time: result.updatedAt,
      pipeline_steps: steps,
    },
  };

  if (done && state === 'SUCCEEDED') {
    const usage = result.usage ?? {};
    body.result = {
      output_format: format,
      content: result.outputContent ?? null,
      extracted_data: result.extractedData ?? null,
      pipeline_steps: steps,
      usage: {
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        pages_processed: usage.pagesProcessed ?? 0,
        model_used: usage.modelUsed ?? null,
        cost_usd: usage.costUsd ?? 0,
        breakdown: usage.breakdown ?? [],
      },
      download_url: '/api/v1/operations/' + result.operationId + '/download',
    };
  }

  if (done && state === 'FAILED') {
    const usage = result.usage ?? {};
    body.error = {
      code: result.failure?.code ?? 'FAILED',
      message: result.failure?.message ?? 'operation failed',
      failed_step: result.failure?.failedStep ?? null,
    };
    body.result = {
      pipeline_steps: steps,
      usage: {
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        cost_usd: usage.costUsd ?? 0,
        breakdown: usage.breakdown ?? [],
      },
    };
  }

  return body;
}

/* ------------------------------------------------------------------ */
/* Router                                                               */
/* ------------------------------------------------------------------ */

/**
 * Build the router. Nothing happens until createLegacyActionRouter is called,
 * so importing this module has no side effects.
 */
export function createLegacyActionRouter(options: LegacyActionRouterOptions): LegacyActionRouter {
  const businessId = options.businessId ?? DEFAULT_LEGACY_ACTION_BUSINESS_ID;
  const newCorrelationId = options.newCorrelationId ?? (() => randomUUID());

  const handles = (pathname: string): boolean => parseLegacyActionPath(pathname) !== null;

  const run = async (
    request: LegacyActionRouteRequest,
    action: LegacyCoreAction,
  ): Promise<LegacyActionRouteResponse> => {
    if (request.method !== 'POST') {
      return legacyErrorResponse(405, 'Method Not Allowed', action + ' accepts POST only');
    }

    const correlationId = readCorrelation(request.headers) ?? newCorrelationId();

    // Authentication precedes decoding, exactly as the legacy runner resolved
    // the key before it looked at the body. A missing identity is a 401.
    let principal: LegacyActionPrincipal | null;
    try {
      principal = await options.resolvePrincipal(request.headers);
    } catch {
      return internalErrorResponse(correlationId);
    }
    if (principal === null || principal === undefined) {
      return legacyErrorResponse(401, 'Unauthorized', 'missing or invalid api key', correlationId);
    }

    let decoded;
    try {
      decoded = decodeLegacyWire(action, {
        body: request.body,
        form: request.form,
        headers: request.headers,
        query: request.query,
      });
    } catch (error: unknown) {
      if (error instanceof LegacyWireDecodeError) {
        const projected = toLegacyDecodeError(error);
        return legacyErrorResponse(
          projected.status,
          projected.title,
          projected.detail,
          correlationId,
        );
      }
      // A decoder bug must not surface its message.
      return internalErrorResponse(correlationId);
    }

    let result: LegacyActionDispatchResult;
    try {
      result = await options.dispatch.submit({
        tenantId: principal.tenantId,
        apiKeyId: principal.apiKeyId,
        businessId,
        action: decoded.action,
        variant: decoded.variant,
        submission: decoded.submission,
        files: decoded.files,
        fileUrls: decoded.fileUrls,
        ...(decoded.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: decoded.idempotencyKey }),
        correlationId,
        executeSync: decoded.executeSync,
      });
    } catch {
      return internalErrorResponse(correlationId);
    }

    // 200 for a sync call or an idempotent replay, 202 otherwise - the legacy
    // rule, including the detail that the header rides on the 202 only.
    const settled = decoded.executeSync || result.replayed;
    if (settled) {
      return { status: 200, body: toLegacyOperationEnvelope(result), headers: {} };
    }
    return {
      status: 202,
      body: toLegacyOperationEnvelope(result),
      headers: {
        [LEGACY_OPERATION_LOCATION_HEADER]: '/api/v1/operations/' + result.operationId,
      },
    };
  };

  return {
    handles,
    async handle(request) {
      const action = parseLegacyActionPath(request.pathname);
      if (action === null) return null;
      return run(request, action);
    },
    async handleOwned(request) {
      const action = parseLegacyActionPath(request.pathname);
      if (action === null) {
        throw new Error('legacy-action-router does not own ' + request.pathname);
      }
      return run(request, action);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * 500 body. ADM-BASE-03: a stable code and the correlation id only. The raw
 * error message never crosses this boundary.
 */
function internalErrorResponse(correlationId: string): LegacyActionRouteResponse {
  return legacyErrorResponse(
    500,
    'Internal Error',
    'The request could not be completed (correlationId ' + correlationId + ').',
    correlationId,
  );
}

/** Read x-correlation-id from a native Headers or a plain record. */
function readCorrelation(headers: LegacyWireRequest['headers']): string | undefined {
  if (headers === undefined || headers === null) return undefined;
  const candidate = headers as { get?: unknown };
  if (typeof candidate.get === 'function') {
    const value = (candidate.get as (name: string) => unknown).call(headers, 'x-correlation-id');
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
  if (typeof headers !== 'object') return undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== 'x-correlation-id') continue;
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === 'string' && single !== '' ? single : undefined;
  }
  return undefined;
}
