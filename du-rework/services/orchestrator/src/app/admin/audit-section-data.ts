/**
 * W-ADM-UX-03-AUDIT-TOOLBAR: audit ledger list pane - data layer.
 *
 * Pure fetch + sanitisation + view-model projection for the /admin/audit
 * pane. It reads the contract landed in Muc 30 - GET /api/v1/admin/audit
 * answering the five-field envelope { items, nextCursor, prevCursor, total,
 * limit } over a tenant-scoped keyset, with the severity / action /
 * actor / resource / from / to / sort filters - and turns that page into
 * the toolbar chips and rows.
 *
 * Hard rules, inherited from the operations pane (Muc 13/16/19):
 * - A rejected filter token is NAMED, never echoed. An operator who pastes
 *   an API secret into the actor box is told the actor filter was ignored;
 *   the secret never re-enters the DOM, a link, or a URL.
 * - Only values the route would accept ever reach a URL, and the param
 *   names are the routes own, so the shell cannot invent a filter the
 *   server does not have.
 * - A keyset cursor is bound to the ordering it was minted under
 *   (T140-A1), so every link that echoes a cursor echoes that ordering, and
 *   the toolbar form carries no cursor field at all: changing any filter or
 *   the ordering structurally restarts at page 1.
 * - total is a COUNT of the FILTERED population, so the pagination line
 *   says how many events match the filters, not how many fit on a page.
 *
 * The pane ships unwired from the shell router (see the packet delta): this
 * module is complete and offline-testable, but nothing mounts it yet.
 *
 * No DB, no Redis, no clock read at import. fetchImpl is injectable and the
 * query string is built by buildAuditListQuery, so every rule above is
 * exercisable offline against a recording fetch stub. Strict TypeScript, no
 * any.
 */

import {
  ADMIN_AUDIT_LIST_SORT_DEFAULT,
  ADMIN_AUDIT_LIST_SORT_VALUES,
  ADMIN_LIST_LIMIT_DEFAULT,
  ADMIN_LIST_LIMIT_MAX,
  AUDIT_SEVERITY_VALUES,
  isAdminListTimeBound,
  isOperationsListFilterToken,
  LIST_CURSOR_MAX_LEN,
  type AuditSeverity,
} from '@du/contracts';
import { safeTransportErrorText } from '../../http/errors';

// ---------------------------------------------------------------------------
// Pane constants (every value mirrors the route, none is a local invention)
// ---------------------------------------------------------------------------

/** Page size the route serves when limit is absent (Muc 30: 50). */
export const AUDIT_LIST_DEFAULT_LIMIT = ADMIN_LIST_LIMIT_DEFAULT;
/** Page-size ceiling the route clamps to (Muc 30: 200). */
export const AUDIT_LIST_MAX_LIMIT = ADMIN_LIST_LIMIT_MAX;
/** Opaque cursors are length-bounded before they reach a URL or a log line. */
export const AUDIT_LIST_CURSOR_MAX_LEN = LIST_CURSOR_MAX_LEN;
/**
 * The two orderings the route accepts. This is a SUBSET of the resource-list
 * sort set, not a copy: admin_audit_events (migration 0010) has created_at
 * and no updated_at, so offering updatedAt:* in the toolbar would advertise
 * a sort the route rejects with 422.
 */
export const AUDIT_LIST_SORT_OPTIONS: readonly string[] = ADMIN_AUDIT_LIST_SORT_VALUES;
/** The ordering a request without sort gets; omitted from default links. */
export const AUDIT_LIST_DEFAULT_SORT: string = ADMIN_AUDIT_LIST_SORT_DEFAULT;

// ---------------------------------------------------------------------------
// Filter model
// ---------------------------------------------------------------------------

/**
 * UI severity enum. ALL is the absence of a filter, never a wire value - the
 * ledger buckets are the four AUDIT_SEVERITY_VALUES only, so ALL is omitted
 * from every URL and the default chips row stays byte-stable.
 */
export type AuditSeverityFilter = 'ALL' | AuditSeverity;

export const AUDIT_SEVERITY_FILTERS: readonly AuditSeverityFilter[] = [
  'ALL',
  ...AUDIT_SEVERITY_VALUES,
];

/**
 * The effective (sanitized) filter set carried in the envelope and echoed
 * onto links. actor / action / resource are case-insensitive SUBSTRING
 * filters server-side (strpos(lower(col), lower(n)) > 0), which is why the
 * chips say contains - severity is the one exact match. from / to are
 * inclusive UTC instants.
 */
export interface AuditListFilters {
  severity: AuditSeverityFilter;
  /** Case-insensitive substring of the ledger actor column. */
  actor: string | null;
  /** Case-insensitive substring of the action column. */
  action: string | null;
  /** Case-insensitive substring of the resource column. */
  resource: string | null;
  /** Inclusive lower bound, YYYY-MM-DDTHH:MM:SS[.ffffff]Z. */
  from: string | null;
  /** Inclusive upper bound, same shape. */
  to: string | null;
}

/** Raw toolbar query values, straight off the request - never trusted. */
export interface AuditListFilterInput {
  severityFilter?: string;
  actorFilter?: string;
  actionFilter?: string;
  resourceFilter?: string;
  fromFilter?: string;
  toFilter?: string;
  sortFilter?: string;
}

export interface ResolvedAuditListQuery {
  filters: AuditListFilters;
  /** Canonical field:direction; the route default when none is valid. */
  sort: string;
  /** Field names whose raw value was provided but rejected. */
  ignored: string[];
  /**
   * Non-null when the operator typed a window the route would reject (from
   * strictly after to). The caller MUST NOT issue the query: an inverted
   * window silently widened to no-time-filter would let an operator read
   * nothing-happened-in-that-range off a list that is in fact unfiltered.
   */
  windowError: string | null;
}

// ---------------------------------------------------------------------------
// Sanitisers - the shell may only put a value in a URL the route accepts
// ---------------------------------------------------------------------------

/** Returns the allow-listed severity or ALL, or null for anything else. */
export function sanitizeAuditSeverityFilter(raw: unknown): AuditSeverityFilter | null {
  if (typeof raw !== 'string') return null;
  // Case is NOT folded: severity is an enum, not free text, and the route
  // accepts exactly these four lowercase buckets. Accepting ERROR here would
  // let the shell put a value in a URL the route rejects, which is the one
  // thing this boundary exists to prevent.
  const v = raw.trim();
  if (v === 'ALL') return 'ALL';
  return (AUDIT_SEVERITY_VALUES as readonly string[]).includes(v)
    ? (v as AuditSeverity)
    : null;
}

/**
 * Boundary for the free-text filters. Same rule as the route action /
 * actor / resource params: the shared token class, which rejects solid 32+
 * hex so a pasted raw API key can never act as a search term, and rejects
 * rather than truncates so a rejected value never re-enters a URL.
 */
export function sanitizeAuditFilterToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  return isOperationsListFilterToken(v) ? v : null;
}

/**
 * A UTC instant the route isAdminListTimeBound accepts - a real point on the
 * calendar, anchored on Z so a local-time string can never be silently
 * reinterpreted as UTC by a ledger time filter.
 */
export function sanitizeAuditTimeBound(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  return isAdminListTimeBound(v) ? v : null;
}

/** Canonical ordering text, or null for a token outside the allow-list. */
export function sanitizeAuditSortFilter(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return (ADMIN_AUDIT_LIST_SORT_VALUES as readonly string[]).includes(v) ? v : null;
}

/** Normalise a requested page size: integer 1..200, default 50. Never throws. */
export function clampAuditListLimit(raw: number | string | undefined | null): number {
  const n =
    typeof raw === 'string'
      ? Number.parseInt(raw, 10)
      : typeof raw === 'number'
        ? raw
        : NaN;
  if (!Number.isFinite(n)) return AUDIT_LIST_DEFAULT_LIMIT;
  return Math.min(AUDIT_LIST_MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

export function areAuditListFiltersActive(f: AuditListFilters): boolean {
  return (
    f.severity !== 'ALL' ||
    f.actor !== null ||
    f.action !== null ||
    f.resource !== null ||
    f.from !== null ||
    f.to !== null
  );
}

function provided(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim().length > 0;
}
/**
 * Sanitize the raw filter set + ordering into the effective filters, the
 * effective ordering, the names of the fields that were rejected, and the
 * inverted-window verdict. A rejected field is dropped AND named, never
 * echoed - the same rule the operations toolbar uses.
 */
export function resolveAuditListFilters(raw: AuditListFilterInput): ResolvedAuditListQuery {
  const ignored: string[] = [];

  let severity: AuditSeverityFilter = 'ALL';
  if (provided(raw.severityFilter)) {
    const ok = sanitizeAuditSeverityFilter(raw.severityFilter);
    if (ok) severity = ok;
    else ignored.push('severity');
  }

  const token = (value: unknown, name: string): string | null => {
    if (!provided(value)) return null;
    const ok = sanitizeAuditFilterToken(value);
    if (ok === null) ignored.push(name);
    return ok;
  };
  const actor = token(raw.actorFilter, 'actor');
  const action = token(raw.actionFilter, 'action');
  const resource = token(raw.resourceFilter, 'resource');

  const bound = (value: unknown, name: string): string | null => {
    if (!provided(value)) return null;
    const ok = sanitizeAuditTimeBound(value);
    if (ok === null) ignored.push(name);
    return ok;
  };
  const from = bound(raw.fromFilter, 'from');
  const to = bound(raw.toFilter, 'to');

  // Both bounds survived validation: check the ORDER too. A window that runs
  // backwards is a client mistake the route rejects, not an empty ledger.
  let windowError: string | null = null;
  if (from !== null && to !== null && from > to) {
    windowError = 'from must not be after to';
  }

  let sort: string = AUDIT_LIST_DEFAULT_SORT;
  if (provided(raw.sortFilter)) {
    const ok = sanitizeAuditSortFilter(raw.sortFilter);
    if (ok) sort = ok;
    else ignored.push('sort');
  }

  return {
    filters: { severity, actor, action, resource, from, to },
    sort,
    ignored,
    windowError,
  };
}

// ---------------------------------------------------------------------------
// Query string - the ONE place the pane decides what a request looks like
// ---------------------------------------------------------------------------

export interface AuditListQueryParts {
  limit: number;
  cursor: string | null;
  filters: AuditListFilters;
  sort: string;
}

/**
 * Build the route query string from EFFECTIVE values only. Param names and
 * accept-conditions come from the Muc 30 contract, so the toolbar can only
 * ever produce a URL the route understands. Absent filters are omitted
 * rather than sent empty so a default link stays stable, and the canonical
 * default ordering is omitted because the route resolves an absent sort to
 * exactly what a default-minted cursor is bound to.
 */
export function buildAuditListQuery(parts: AuditListQueryParts): URLSearchParams {
  const params = new URLSearchParams();
  params.set('limit', String(parts.limit));
  if (parts.cursor !== null && parts.cursor.length > 0) {
    params.set('cursor', parts.cursor);
  }
  const f = parts.filters;
  if (f.severity !== 'ALL') params.set('severity', f.severity);
  if (f.actor !== null) params.set('actor', f.actor);
  if (f.action !== null) params.set('action', f.action);
  if (f.resource !== null) params.set('resource', f.resource);
  if (f.from !== null) params.set('from', f.from);
  if (f.to !== null) params.set('to', f.to);
  if (parts.sort !== AUDIT_LIST_DEFAULT_SORT) params.set('sort', parts.sort);
  return params;
}

// ---------------------------------------------------------------------------
// Wire shape (raw rows as the platforms GET returns them)
// ---------------------------------------------------------------------------

/**
 * One ledger row as toAuditWire projects it. The pane declares the shape
 * itself rather than importing the route private interface: the wire is the
 * contract, and a section must not reach into the server module.
 *
 * kind is the action and resourceId the resource - the platforms own names
 * for the two columns the toolbar also filters on.
 */
export interface AuditWireRow {
  id?: unknown;
  kind?: unknown;
  severity?: unknown;
  occurredAt?: unknown;
  tenantId?: unknown;
  resourceId?: unknown;
  actor?: unknown;
  message?: unknown;
}

/** The five-field envelope the route answers with. */
export interface AuditListWireEnvelope {
  items?: unknown;
  nextCursor?: unknown;
  prevCursor?: unknown;
  total?: unknown;
  limit?: unknown;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface AuditListRow {
  id: string;
  occurredAt: string;
  /**
   * Kept as the wire string rather than the enum: a ledger row written by a
   * newer producer may carry a bucket this build does not know, and the
   * table must still render it instead of dropping the row.
   */
  severity: string;
  actor: string;
  action: string;
  resource: string;
  tenantId: string | null;
  message: string;
}

export interface AuditListOkResult {
  kind: 'list';
  rows: readonly AuditListRow[];
  limit: number;
  /** COUNT of the FILTERED population, or null when withheld. */
  total: number | null;
  nextCursor: string | null;
  prevCursor: string | null;
  /** The cursor this page was requested with, echoed for the links. */
  cursor: string | null;
  pageRows: number;
  filters: AuditListFilters;
  sort: string;
  /** Field names rejected at the boundary; rendered, never echoed. */
  ignoredFilters: string[];
  /**
   * Rows the page carried that were not shaped like a ledger row. Surfaced
   * rather than dropped silently: a shrinking table the operator did not ask
   * for is a data problem they need to see.
   */
  droppedRows: number;
}

export type AuditFetchResult =
  | AuditListOkResult
  | { kind: 'empty'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'error'; message: string };

/** Type guard for the renderer / tests. */
export function isAuditListOkResult(f: AuditFetchResult): f is AuditListOkResult {
  return f.kind === 'list';
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Project one wire row, or null when it carries no usable id. Every other
 * field degrades to an explicit placeholder instead of undefined leaking
 * into the DOM as null or undefined.
 */
export function toAuditListRow(value: unknown): AuditListRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as AuditWireRow;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  return {
    id: row.id,
    occurredAt: textOr(row.occurredAt, '(unknown time)'),
    severity: textOr(row.severity, 'unknown'),
    actor: textOr(row.actor, '(unknown actor)'),
    action: textOr(row.kind, '(unknown action)'),
    resource: textOr(row.resourceId, '(unknown resource)'),
    tenantId:
      typeof row.tenantId === 'string' && row.tenantId.length > 0
        ? row.tenantId
        : null,
    message: textOr(row.message, ''),
  };
}

function optionalCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
export interface AuditListEnvelopeContext {
  limit: number;
  cursor: string | null;
  filters: AuditListFilters;
  sort: string;
  ignoredFilters: readonly string[];
}

/**
 * Parse the route five-field envelope into the pane view model. A missing
 * or non-array items is an empty page, not a crash; a total that is not a
 * finite number stays null so the pagination line can say the platform did
 * not report a count rather than inventing one.
 */
export function parseAuditListPayload(
  payload: unknown,
  ctx: AuditListEnvelopeContext,
): AuditListOkResult {
  const envelope: AuditListWireEnvelope =
    typeof payload === 'object' && payload !== null
      ? (payload as AuditListWireEnvelope)
      : {};
  const rawItems = Array.isArray(envelope.items) ? envelope.items : [];
  const rows: AuditListRow[] = [];
  let droppedRows = 0;
  for (const item of rawItems) {
    const row = toAuditListRow(item);
    if (row === null) droppedRows += 1;
    else rows.push(row);
  }
  const total =
    typeof envelope.total === 'number' && Number.isFinite(envelope.total)
      ? envelope.total
      : null;
  return {
    kind: 'list',
    rows,
    limit: ctx.limit,
    total,
    nextCursor: optionalCursor(envelope.nextCursor),
    prevCursor: optionalCursor(envelope.prevCursor),
    cursor: ctx.cursor,
    pageRows: rawItems.length,
    filters: ctx.filters,
    sort: ctx.sort,
    ignoredFilters: [...ctx.ignoredFilters],
    droppedRows,
  };
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

export interface AuditFetcherInput extends AuditListFilterInput {
  /** Page size; clamped to 1..200, default 50. */
  listLimit?: number;
  /** Opaque keyset cursor, passed verbatim to the platform. */
  cursor?: string;
  /** Base URL of the orchestrator JSON API. */
  jsonBaseUrl: string;
  /** Admin bearer token, sent verbatim as an Authorization header. */
  adminToken: string;
  /** Injected fetch. Default = globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 4000. */
  timeoutMs?: number;
}

/**
 * GET the ledger page the toolbar describes.
 *
 * The pane is a read-only GET surface, so every rejection is answered the
 * same way the operations toolbar answers one: drop the field, name it in
 * ignoredFilters, and issue the request anyway - with ONE exception, the
 * inverted time window, which fails closed (see windowError). Issuing that
 * request unfiltered in time would hand the operator a full ledger under the
 * heading of the range they asked for.
 */
export async function fetchAuditEvents(input: AuditFetcherInput): Promise<AuditFetchResult> {
  const { filters, sort, ignored, windowError } = resolveAuditListFilters(input);
  if (windowError !== null) {
    return {
      kind: 'error',
      message:
        `The requested time window cannot be used: ${windowError}. ` +
        `Narrow the range and try again.`,
    };
  }

  if (!input.jsonBaseUrl) {
    // Not an empty ledger: without a platform base URL the pane has no way to
    // ask. Reporting empty here would dress a wiring gap up as data.
    return { kind: 'error', message: 'Audit ledger platform URL is not configured.' };
  }
  if (!input.adminToken) {
    return { kind: 'unauthorized', message: 'Admin bearer token is not configured.' };
  }

  const limit = clampAuditListLimit(input.listLimit);
  const cursor =
    input.cursor && input.cursor.length > 0
      ? input.cursor.slice(0, AUDIT_LIST_CURSOR_MAX_LEN)
      : null;

  let url: URL;
  try {
    url = new URL('/api/v1/admin/audit', input.jsonBaseUrl);
    url.search = buildAuditListQuery({ limit, cursor, filters, sort }).toString();
  } catch {
    return { kind: 'error', message: 'Invalid platform JSON API base URL.' };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 4000;
  const nowMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.adminToken}`,
        accept: 'application/json',
        'x-correlation-id': `p6-06-${nowMs.toString(36)}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'unauthorized',
        message: `Platform rejected the admin token (HTTP ${res.status}).`,
      };
    }
    if (!res.ok) {
      // W-ADM-UX-03-AUDIT-QUERY (Delta 143): surface the route's own remedy
      // text when it sent one. The route answers 422 with a ProblemDetails
      // body whose message names the fix (drop cursor, etc.); a bare status
      // code gives the operator nothing to act on. Only the message field
      // is read - a raw body is never projected into the page.
      let detail = '';
      if (res.status === 422 || res.status === 400) {
        try {
          const raw: unknown = JSON.parse(await res.text().catch(() => ''));
          if (
            typeof raw === 'object' &&
            raw !== null &&
            typeof (raw as { message?: unknown }).message === 'string'
          ) {
            detail = (raw as { message: string }).message;
          }
        } catch {
          // Body was not JSON; fall through to the bare status code.
        }
      }
      return {
        kind: 'error',
        message:
          detail.length > 0
            ? 'Platform rejected the audit request: ' + detail
            : 'Platform returned HTTP ' + res.status.toString() + ' for the audit ledger.',
      };
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: 'error',
        message: 'Platform returned non-JSON for the audit ledger endpoint.',
      };
    }
    return parseAuditListPayload(parsed, {
      limit,
      cursor,
      filters,
      sort,
      ignoredFilters: ignored,
    });
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    return {
      kind: 'error',
      message: aborted
        ? `Timed out after ${timeoutMs}ms waiting for the platform.`
        : safeTransportErrorText('Network error contacting the platform'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers re-exported for tests
// ---------------------------------------------------------------------------

export const __test = {
  buildAuditListQuery,
  parseAuditListPayload,
  resolveAuditListFilters,
  sanitizeAuditSeverityFilter,
  sanitizeAuditFilterToken,
  sanitizeAuditTimeBound,
  sanitizeAuditSortFilter,
  clampAuditListLimit,
  toAuditListRow,
};
