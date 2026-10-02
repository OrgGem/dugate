/**
 * HTTP mount for the legacy compat facade.
 *
 * ## Why the routes live here and not in server.ts
 *
 * `server.ts` is 4.2k lines and is on someone else's lease. Keeping the
 * legacy surface in one file means the mount is a single call, the surface can
 * be reviewed as a unit, and `legacyEnabled` can switch the whole facade off
 * without touching the canonical route table.
 *
 * ## Ordering matters
 *
 * The legacy paths are checked BEFORE the canonical ones because
 * `/api/v1/docs/{action}` has no canonical twin, but `/api/v1/operations` and
 * friends do — a compat handler that fell through late could never claim them.
 * `handleLegacyRoute` returns `null` for a path it does not own, and the
 * caller falls through to the canonical `if` chain unchanged.
 *
 * ## Identity
 *
 * The host resolves the caller and passes the principal IN. The compat path
 * never reads identity from the body: the legacy wire accepted an `apiKeyId`
 * form field and fell back to the oldest ADMIN key
 * (`app/api/v1/docs/workflows/route.ts:49-86`), which let a caller attach an
 * operation to someone else's profile. That is MUST-NOT-REPLICATE per
 * API-COMPAT-DUGATE-2026-09-28.md:113, so the body value is dropped.
 */

import { HttpError } from '../http/errors';
import { readMultipartBody } from './legacy-multipart';
import { LegacyFormData, legacyFieldsToRecord } from './legacy-form-bridge';
import { decodeLegacyWire, LegacyWireDecodeError, LEGACY_CORE_ACTIONS, type LegacyDecodedRequest } from './legacy-wire-decoders';
import { toLegacyEnvelope, toLegacyListItem, toLegacyListPage, type LegacyOperationRow } from './legacy-envelope';

/** Re-exported so the host adapter types its loader without reaching into the envelope module. */
export type { LegacyOperationRow } from './legacy-envelope';

const LEGACY_ERROR_BASE = 'https://dugate.vn/errors/';

/** The six core action slugs, in the legacy registry's order. */
const CORE_ACTIONS: ReadonlySet<string> = new Set(LEGACY_CORE_ACTIONS);

export interface LegacyPrincipal {
  readonly tenantId: string;
  readonly apiKeyId: string;
}

/** What the mount needs from the host, so it never reaches into server.ts. */
export interface LegacyCompatHost {
  readonly db: {
    query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
  };
  /** Reads the operation row for the legacy projection columns. */
  loadOperation(operationId: string, tenantId: string): Promise<LegacyOperationRow | null>;
  /** Raw bytes of the operation's output, or null when it lives in storage. */
  loadOutputContent(operationId: string, tenantId: string): Promise<Buffer | null>;
  /**
   * Perform the actual submit. The host owns admission, artifact creation,
   * tenant fencing and the queue — this module owns none of that, it only
   * decides the wire afterwards.
   */
  submitLegacy?(
    principal: LegacyPrincipal,
    action: string,
    decoded: LegacyDecodedRequest,
  ): Promise<{ operationId: string; replayed: boolean } | undefined>;
  /** Soft-delete an operation; resolves false when the row is absent. */
  softDeleteOperation?(operationId: string, tenantId: string): Promise<boolean>;
  /** Cancel an operation; resolves the current row after the transition. */
  cancelLegacy?(operationId: string, tenantId: string): Promise<{ ok: true; row: LegacyOperationRow } | { ok: false; status: 404 | 409 }>;
  /** Requeue a WAITING_INPUT operation; resolves null when not resumable. */
  resumeLegacy?(operationId: string, tenantId: string, body: unknown): Promise<{ ok: true } | { ok: false; status: 404 | 400; state: string }>;
  /** One page of legacy operation rows for the list route. */
  listLegacyOperations?(input: {
    tenantId: string;
    apiKeyId: string;
    pageSize: number;
    pageToken: string | null;
    states: string[];
    processors: string[];
  }): Promise<{ rows: LegacyOperationRow[]; hasMore: boolean }>;
  /** Per-key spend for the billing balance/usage routes. */
  billingFor?(apiKeyId: string): Promise<LegacyBillingSnapshot | null>;
  /**
   * The service catalogue with profile locks already applied. Returning
   * `undefined` means "not wired"; the mount answers 500 rather than an
   * empty list, because an empty catalogue reads as "you may call nothing".
   */
  serviceCatalogue?(apiKeyId: string): Record<string, unknown>[] | undefined;
}

/**
 * Resolve the caller, mapping an auth rejection onto the legacy 401 body
 * instead of letting the canonical problem+json shape escape.
 */
async function safePrincipal(request: LegacyRouteRequest): Promise<LegacyPrincipal | null> {
  try {
    return await request.resolvePrincipal();
  } catch (error: unknown) {
    // Both "no key" and "bad key" are 401 in the legacy surface; the
    // canonical HttpError is discarded so its message cannot leak whether a
    // key exists.
    void error;
    return null;
  }
}

/**
 * True when the caller presented an admin bearer rather than a public API key.
 *
 * The Admin shell fetches `/api/v1/operations` and `/api/v1/operations/{id}`
 * with `Authorization: Bearer <adminToken>` and no `x-api-key` (ADM-BASE-01).
 * Those are not legacy clients, so the facade returns null and lets the
 * canonical route answer with the canonical envelope. Distinguishing on the
 * admin token's presence — not on which one resolves first — keeps the check
 * free of a principal resolution the facade does not need to do.
 */
function hasAdminBearer(request: LegacyRouteRequest): boolean {
  const auth = request.headers['authorization'];
  return typeof auth === 'string' && auth.trim().toLowerCase().startsWith('bearer ');
}

/**
 * Legacy download content type. The old route derived it from
 * `outputFormat` for the inline branch and from the file extension for the
 * file branch; only the inline branch is reachable from an operation row.
 */
function legacyDownloadContentType(outputFormat: string | null | undefined): string {
  if (outputFormat === 'html') return 'text/html; charset=utf-8';
  if (outputFormat === 'json') return 'application/json; charset=utf-8';
  return 'text/markdown; charset=utf-8';
}

export interface LegacyRouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly headers: Record<string, string>;
  /** Streamed body; consumed exactly once. */
  readonly bodyStream?: AsyncIterable<Uint8Array>;
  /** Resolved by the host from `x-api-key`. Never read from the body. */
  resolvePrincipal(): Promise<LegacyPrincipal>;
  /** Pre-parsed JSON body, for the routes that take no upload. */
  body?: unknown;
}

export interface LegacyRouteResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

/**
 * The legacy problem+json body, field for field as `apiError()` built it
 * (`lib/endpoints/runner.ts:18-28`): `type`, `title`, `status`, `detail` and
 * nothing else. No `code`, no `errors` array — the canonical
 * `application/problem+json` shape is a different surface.
 */
export function legacyError(
  status: number,
  title: string,
  detail: string,
  correlationId?: string,
): LegacyRouteResponse {
  const body: Record<string, unknown> = {
    type: `${LEGACY_ERROR_BASE}${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
  };
  if (correlationId !== undefined) body.correlationId = correlationId;
  return { status, body, headers: {} };
}

/**
 * Every decoder rejection the legacy facade can raise is a 400 Invalid
 * Parameter, which is what the old runner answered for a bad or unknown
 * discriminator. UNSUPPORTED_ACTION never reaches here because the mount
 * matches the slug itself.
 */
function decodeErrorResponse(
  error: LegacyWireDecodeError,
  correlationId: string | undefined,
): LegacyRouteResponse {
  if (error.code === 'UNSUPPORTED_ACTION') {
    return legacyError(404, 'Service Not Found', error.message, correlationId);
  }
  return legacyError(400, 'Invalid Parameter', error.message, correlationId);
}

/** `/api/v1/docs/{action}` — the six core submits, plus the two workflow routes. */
export function parseLegacyDocsPath(pathname: string): { kind: 'action'; action: string } | { kind: 'workflows' | 'workflow-schema' } | null {
  if (!pathname.startsWith('/api/v1/docs/')) return null;
  const rest = pathname.slice('/api/v1/docs/'.length);
  if (rest === '') return null;
  if (rest === 'workflows') return { kind: 'workflows' };
  if (rest === 'workflows/schema') return { kind: 'workflow-schema' };
  if (rest.includes('/')) return null;
  if (!CORE_ACTIONS.has(rest)) return null;
  return { kind: 'action', action: rest };
}

function correlationIdOf(request: LegacyRouteRequest): string | undefined {
  const raw = request.headers['x-correlation-id'];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * `idempotency-key` and `sync` are the two header/query values the legacy
 * submit contract defined; both are read here so the decoder's `presence`
 * record stays accurate even when the mount forwards it verbatim.
 */
function submitOptions(request: LegacyRouteRequest): { idempotencyKey?: string; executeSync: boolean } {
  const key = request.headers['idempotency-key'];
  return {
    ...(typeof key === 'string' && key !== '' ? { idempotencyKey: key } : {}),
    executeSync: request.searchParams.get('sync') === 'true',
  };
}

export interface LegacySubmitOutcome {
  readonly operationId: string;
  readonly replayed: boolean;
}

/**
 * Submit handler shared by the six core actions and the workflow facade.
 *
 * The host owns the actual submit (artifacts, admission, queue); this decides
 * the WIRE: status code, the `Operation-Location` header and which envelope to
 * project. Those three are the parity surface, and they are reproduced from
 * `runner.ts:256-277` rather than from the canonical route.
 *
 * `?sync=true` returns 200 with the operation still `done: false`. The old
 * runner did exactly that, and clients branch on `done` in the body —
 * answering 202 there would change their behaviour, which is the opposite of
 * parity. See docs/39-legacy-parity-contract.md section 4.1.
 */
export function legacySubmitResponse(input: {
  decoded: {
    idempotencyKey?: string;
    executeSync: boolean;
    correlationId?: string;
  };
  row: LegacyOperationRow;
  replayed: boolean;
}): LegacyRouteResponse {
  const settled = input.decoded.executeSync || input.replayed;
  const body = toLegacyEnvelope(input.row);
  if (settled) return { status: 200, body, headers: {} };
  return {
    status: 202,
    body,
    headers: {
      'Operation-Location': `/api/v1/operations/${input.row.id}`,
    },
  };
}

/**
 * Read a multipart body and run the legacy decoder over it.
 *
 * Auth precedes decoding, matching the old runner: it resolved the key before
 * it ever looked at the body, so an unauthenticated caller cannot use a decode
 * error to probe the request shape.
 */
export async function decodeLegacyMultipart(
  action: string,
  request: LegacyRouteRequest,
): Promise<{ decoded: ReturnType<typeof decodeLegacyWire>; correlationId: string }> {
  if (request.bodyStream === undefined) {
    throw new HttpError(400, 'MALFORMED_BODY', 'multipart body stream is required');
  }
  const contentType = request.headers['content-type'];
  const parsed = await readMultipartBody(
    request.bodyStream as AsyncIterable<Buffer>,
    contentType,
  );
  const form = LegacyFormData.fromMultipart(parsed);
  const record = legacyFieldsToRecord(parsed);
  const decoded = decodeLegacyWire(action, {
    form,
    body: record,
    headers: request.headers,
    query: Object.fromEntries(request.searchParams.entries()),
  });
  const { idempotencyKey, executeSync } = submitOptions(request);
  return {
    decoded: { ...decoded, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), executeSync },
    correlationId: decoded.correlationId ?? correlationIdOf(request) ?? '',
  };
}

/** Map a DB error onto the legacy surface without echoing driver text. */
function internalError(correlationId: string | undefined): LegacyRouteResponse {
  const id = correlationId ?? '';
  return legacyError(
    500,
    'Internal Error',
    `The request could not be completed (correlationId ${id}).`,
    id === '' ? undefined : id,
  );
}

/**
 * The legacy `filter` grammar: CSV of `key=value`, where only `state` and
 * `processor` are honoured and any other key is ignored rather than rejected
 * (`app/api/v1/operations/route.ts:41-52`). An invalid `state` IS a 400, and
 * the body is `{error}` — not problem+json — so a client that parses
 * `detail` would otherwise read `undefined`.
 */
const LEGACY_LIST_STATES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'PENDING'] as const;

function parseLegacyListFilter(raw: string | null):
  | { ok: true; states: string[]; processors: string[] }
  | { ok: false; message: string } {
  if (raw === null || raw === '') return { ok: true, states: [], processors: [] };
  const states: string[] = [];
  const processors: string[] = [];
  for (const part of raw.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 'state') {
      if (value === undefined || !(LEGACY_LIST_STATES as readonly string[]).includes(value)) {
        return {
          ok: false,
          message: `Invalid state filter. Must be one of: ${LEGACY_LIST_STATES.join(', ')}`,
        };
      }
      states.push(value);
    } else if (key === 'processor') {
      if (value !== undefined) processors.push(value);
    }
  }
  return { ok: true, states, processors };
}

export interface LegacyBillingSnapshot {
  readonly name: string | null;
  readonly spendingLimit: number;
  readonly totalUsed: number;
  /** One row per model for the billing/usage breakdown. */
  readonly byModel: readonly LegacyUsageRow[];
  /** Number of SUCCEEDED operations in the window, not the number of models. */
  readonly operationCount: number;
}

export interface LegacyUsageRow {
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly pagesProcessed: number;
  readonly costUsd: number;
}

/** A legacy HttpError title, so a parser failure keeps the legacy vocabulary. */
function titleForStatus(status: number): string {
  if (status === 400) return 'Invalid Parameter';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 409) return 'Conflict';
  if (status === 413) return 'Payload Too Large';
  if (status === 415) return 'Unsupported Media Type';
  if (status === 503) return 'Service Not Available';
  return 'Internal Error';
}

/** The correlation id to stamp on a decode failure, before decoding succeeded. */
function decoded0CorrelationId(request: LegacyRouteRequest): string | undefined {
  return correlationIdOf(request);
}


/**
 * Handle one request against the legacy surface.
 *
 * Returns `null` for every path the facade does not own, so the caller falls
 * through to the canonical route table without a special "did compat claim
 * it" flag. The path table is deliberately closed: an unknown `/api/v1/docs/*`
 * slug is a 404 here rather than falling through to the canonical 404, which
 * would return a different `type` namespace than legacy clients parse.
 */
export async function handleLegacyRoute(
  request: LegacyRouteRequest,
  host: LegacyCompatHost,
): Promise<LegacyRouteResponse | null> {
  const { method, pathname } = request;
  const correlationId = correlationIdOf(request);

  // ---- Submit: the six core actions -------------------------------------
  const docs = parseLegacyDocsPath(pathname);
  if (docs !== null) {
    if (method !== 'POST') {
      const label = docs.kind === 'action' ? docs.action : 'workflows';
      return legacyError(405, 'Method Not Allowed', `${label} accepts POST only`, correlationId);
    }
    if (docs.kind !== 'action') {
      // The workflow facade is a separate task (COMP-09): it needs the three
      // legacy workflow businesses registered, and the mapping table is not
      // in this repo yet. Answering 503 keeps the path claimed and the
      // failure explicit instead of silently 404ing a documented endpoint.
      return legacyError(
        503,
        'Service Not Available',
        'The legacy workflow facade is not available on this deployment.',
        correlationId,
      );
    }

    let principal: LegacyPrincipal;
    try {
      principal = await request.resolvePrincipal();
    } catch {
      return internalError(correlationId);
    }

    let decoded;
    try {
      decoded = await decodeLegacyMultipart(docs.action, request);
    } catch (error: unknown) {
      if (error instanceof LegacyWireDecodeError) {
        return decodeErrorResponse(error, decoded0CorrelationId(request));
      }
      if (error instanceof HttpError) {
        return legacyError(error.status, titleForStatus(error.status), error.message, correlationId);
      }
      return internalError(correlationId);
    }

    if (decoded.decoded.presence.fileFields.length > 0 && decoded.decoded.files.length === 0) {
      return legacyError(
        400,
        'Missing Files',
        'A document is required for this action.',
        correlationId,
      );
    }

    // The host owns admission, artifact creation and the queue. It receives
    // the operation row so the wire projection below is the only thing this
    // module decides.
    const outcome = await host.submitLegacy?.(
      principal,
      docs.action,
      decoded.decoded,
    );
    if (outcome === undefined) return internalError(correlationId);
    const row = await host.loadOperation(outcome.operationId, principal.tenantId);
    if (row === null) return internalError(correlationId);
    return legacySubmitResponse({
      decoded: decoded.decoded,
      row,
      replayed: outcome.replayed,
    });
  }

  // ---- Operations: read / list / download / delete / cancel / resume ----
  //
  // The canonical routes accept an admin bearer as an ALTERNATE auth path for
  // the Admin shell (ADM-BASE-01/02). That caller wants the canonical envelope
  // and the canonical queries, so the facade must decline it rather than claim
  // the path and answer with the legacy body. Only an `x-api-key` caller is a
  // legacy client.
  if (hasAdminBearer(request)) return null;

  const read = /^\/api\/v1\/operations\/([^/]+)$/.exec(pathname);
  if (read !== null) {
    const id = decodeURIComponent(read[1]!);
    if (method === 'DELETE') {
      const principal = await safePrincipal(request);
      if (principal === null) return internalError(correlationId);
      if (host.softDeleteOperation === undefined) return internalError(correlationId);
      const ok = await host.softDeleteOperation(id, principal.tenantId);
      if (!ok) {
        return legacyError(404, 'Not Found', `Operation '${id}' not found.`, correlationId);
      }
      // 204 with an empty body — not a JSON envelope.
      return { status: 204, body: {}, headers: {} };
    }
    if (method !== 'GET') {
      return legacyError(405, 'Method Not Allowed', 'operations/{id} accepts GET and DELETE', correlationId);
    }
    const principal = await safePrincipal(request);
    if (principal === null) return internalError(correlationId);
    const row = await host.loadOperation(id, principal.tenantId);
    if (row === null) {
      return {
        status: 404,
        body: {
          type: `${LEGACY_ERROR_BASE}operation-not-found`,
          title: 'Operation Not Found',
          status: 404,
          detail: `Operation '${id}' not found.`,
          requested_id: id,
        },
        headers: {},
      };
    }
    return { status: 200, body: toLegacyEnvelope(row), headers: {} };
  }

  const list = /^\/api\/v1\/operations$/.exec(pathname);
  if (list !== null) {
    if (method !== 'GET') {
      return legacyError(405, 'Method Not Allowed', 'operations accepts GET', correlationId);
    }
    const principal = await safePrincipal(request);
    if (principal === null) return internalError(correlationId);
    const filter = parseLegacyListFilter(request.searchParams.get('filter'));
    if (!filter.ok) {
      // `{error}`, not problem+json — the legacy list route used NextResponse.json
      // directly here and never went through apiError().
      return { status: 400, body: { error: filter.message }, headers: {} };
    }
    if (host.listLegacyOperations === undefined) return internalError(correlationId);
    const pageSize = Math.min(
      parseInt(request.searchParams.get('page_size') ?? '20', 10) || 20,
      100,
    );
    const page = await host.listLegacyOperations({
      tenantId: principal.tenantId,
      apiKeyId: principal.apiKeyId,
      pageSize,
      pageToken: request.searchParams.get('page_token'),
      states: filter.states,
      processors: filter.processors,
    });
    const serialized = toLegacyListPage(page.rows, page.hasMore);
    return {
      status: 200,
      body: serialized as unknown as Record<string, unknown>,
      headers: {},
    };
  }

  const sub = /^\/api\/v1\/operations\/([^/]+)\/(cancel|resume|download)$/.exec(pathname);
  if (sub !== null) {
    const id = decodeURIComponent(sub[1]!);
    const which = sub[2]!;
    const principal = await safePrincipal(request);
    if (principal === null) return internalError(correlationId);

    if (which === 'cancel') {
      if (method !== 'POST') {
        return legacyError(405, 'Method Not Allowed', 'cancel accepts POST only', correlationId);
      }
      if (host.cancelLegacy === undefined) return internalError(correlationId);
      const outcome = await host.cancelLegacy(id, principal.tenantId);
      if (!outcome.ok) {
        return outcome.status === 404
          ? legacyError(404, 'Not Found', `Operation '${id}' not found.`, correlationId)
          : legacyError(409, 'Already Completed', 'Cannot cancel a completed operation.', correlationId);
      }
      return { status: 200, body: toLegacyEnvelope(outcome.row), headers: {} };
    }

    if (which === 'resume') {
      if (method !== 'POST') {
        return legacyError(405, 'Method Not Allowed', 'resume accepts POST only', correlationId);
      }
      if (host.resumeLegacy === undefined) return internalError(correlationId);
      const outcome = await host.resumeLegacy(id, principal.tenantId, request.body);
      if (!outcome.ok) {
        // The legacy resume route used NextResponse.json directly for both
        // branches, so its error bodies are `{error}` — NOT problem+json. A
        // client reading `detail` here would get undefined, so the shape has to
        // be reproduced exactly rather than normalised.
        if (outcome.status === 404) {
          return { status: 404, body: { error: 'Operation not found' }, headers: {} };
        }
        return {
          status: 400,
          body: {
            error: `Operation is in state ${outcome.state}, cannot resume. Must be WAITING_USER_INPUT.`,
          },
          headers: {},
        };
      }
      return {
        status: 200,
        body: { success: true, message: 'Resumed successfully' },
        headers: {},
      };
    }

    // download
    if (method !== 'GET') {
      return legacyError(405, 'Method Not Allowed', 'download accepts GET only', correlationId);
    }
    const row = await host.loadOperation(id, principal.tenantId);
    if (row === null) {
      return legacyError(404, 'Not Found', `Operation '${id}' not found.`, correlationId);
    }
    if (!row.done || row.state !== 'SUCCEEDED') {
      return legacyError(409, 'Not Ready', 'Operation has not completed successfully.', correlationId);
    }
    const bytes = await host.loadOutputContent(id, principal.tenantId);
    if (bytes === null) {
      return legacyError(404, 'No Output', 'No output content or file available.', correlationId);
    }
    return {
      status: 200,
      body: {},
      headers: {
        'content-type': legacyDownloadContentType(row.outputFormat),
        'content-length': String(bytes.length),
      },
    };
  }

  // ---- Billing: balance + usage -----------------------------------------
  const balance = /^\/api\/v1\/billing\/balance$/.exec(pathname);
  if (balance !== null) {
    if (method !== 'GET') {
      return legacyError(405, 'Method Not Allowed', 'billing/balance accepts GET', correlationId);
    }
    const principal = await safePrincipal(request);
    if (principal === null) return internalError(correlationId);
    if (host.billingFor === undefined) return internalError(correlationId);
    const snapshot = await host.billingFor(principal.apiKeyId);
    if (snapshot === null) {
      return { status: 404, body: { error: 'API key not found' }, headers: {} };
    }
    // spending_limit > 0 means a real limit; 0 means none set, and the legacy
    // route returned a NULL balance in that case rather than a negative one.
    const hasLimit = snapshot.spendingLimit > 0;
    return {
      status: 200,
      body: {
        object: 'billing_balance',
        api_key_id: principal.apiKeyId,
        api_key_name: snapshot.name,
        currency: 'USD',
        details: {
          spending_limit: hasLimit ? snapshot.spendingLimit : null,
          total_used: snapshot.totalUsed,
          balance: hasLimit ? snapshot.spendingLimit - snapshot.totalUsed : null,
        },
        updated_at: new Date().toISOString(),
      },
      headers: {},
    };
  }

  const usageRoute = /^\/api\/v1\/billing\/usage$/.exec(pathname);
  if (usageRoute !== null) {
    if (method !== 'GET') {
      return legacyError(405, 'Method Not Allowed', 'billing/usage accepts GET', correlationId);
    }
    const principal = await safePrincipal(request);
    if (principal === null) return internalError(correlationId);
    const startRaw = request.searchParams.get('start_date');
    const endRaw = request.searchParams.get('end_date');
    const start = startRaw !== null ? new Date(startRaw) : new Date(Date.now() - 30 * 864e5);
    // The legacy route appended T23:59:59Z so `end_date` covered the whole day.
    const end = endRaw !== null ? new Date(`${endRaw}T23:59:59Z`) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return {
        status: 400,
        body: { error: 'Invalid date format. Use YYYY-MM-DD.' },
        headers: {},
      };
    }
    if (host.billingFor === undefined) return internalError(correlationId);
    const snapshot = await host.billingFor(principal.apiKeyId);
    if (snapshot === null) {
      return { status: 404, body: { error: 'API key not found' }, headers: {} };
    }
    return {
      status: 200,
      body: {
        object: 'billing_usage',
        start_date: start.toISOString().split('T')[0],
        end_date: end.toISOString().split('T')[0],
        total_cost_usd: snapshot.totalUsed,
        total_input_tokens: snapshot.byModel.reduce((a, r) => a + r.promptTokens, 0),
        total_output_tokens: snapshot.byModel.reduce((a, r) => a + r.completionTokens, 0),
        total_operations: snapshot.operationCount,
        usage: snapshot.byModel.map((r) => ({
          model: r.model,
          prompt_tokens: r.promptTokens,
          completion_tokens: r.completionTokens,
          pages_processed: r.pagesProcessed,
          cost_usd: r.costUsd,
        })),
      },
      headers: {},
    };
  }

  // ---- Discoverability ----------------------------------------------------
  if (pathname === '/api/v1/services') {
    if (method !== 'GET') {
      return legacyError(405, 'Method Not Allowed', 'services accepts GET', correlationId);
    }
    const principal = await safePrincipal(request);
    if (principal === null) return internalError(correlationId);
    const catalogue = host.serviceCatalogue?.(principal.apiKeyId);
    if (catalogue === undefined) return internalError(correlationId);
    return {
      status: 200,
      body: {
        status: 200,
        message: 'Lấy danh sách các dịch vụ AI khả dụng thành công.',
        services: catalogue,
      },
      headers: {},
    };
  }

  return null;
}






