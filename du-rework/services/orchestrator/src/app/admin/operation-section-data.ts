/**
 * P6-06 Operation detail section data seam.
 *
 * Pure HTTP fetcher for the per-operation detail / result / artifacts /
 * cancel / resume / replay pane. Discriminated `OperationFetchResult`
 * drives the renderer.
 *
 * Design (mirrors `api-key-section-data.ts`):
 * - `operationId` empty AND in-process catalog has no entries →
 *   `kind: 'empty'`.
 * - `operationId` empty AND catalog has entries → paged `kind: 'list'`
 *   envelope (display-safe rows + page controls; no detail row, no
 *   `result`, no `artifacts`, no action affordances — W-ADMUX-01).
 * - `operationId` empty AND `jsonBaseUrl` set → the fetcher GETs
 *   `/api/v1/operations?limit=…[&cursor=…][&sort=…]` and maps the platform list
 *   envelope (`{rows,total,limit}` admin shape or `{items,nextCursor}`
 *   tenant shape) onto `kind: 'list'`. A full page without a server
 *   `nextCursor` reports `total: null` (the admin route echoes
 *   `rows.length` as `total` today — never surfaced as a true total).
 * - W-ADMUX03-SHELL-SORT-1: the list pane also carries `sort`
 *   (`<field>:<direction>`). An operations cursor is BOUND to the ordering it
 *   was minted under (T140-A1), so the shell never carries a cursor across a
 *   sort change: the toolbar form has no cursor field, cursor-carrying links
 *   echo the active sort, and a hand-crafted mismatch surfaces the route's
 *   422 remedy as `kind: 'error'` instead of silently walking a wrong order.
 * - `operationId` non-empty + row found → full detail envelope.
 * - `operationId` non-empty + row missing → `kind: 'not-found'`.
 * - With `jsonBaseUrl`, the fetcher GETs
 *   `/api/v1/operations/<operationId>` and parses the envelope.
 *   401/403 → `unauthorized`. 404 → `not-found`. Other → `error`.
 *
 * Hard rules:
 * - The wire shape carries the contracts `OperationDetail` shape; the
 *   fetcher does **not** echo any raw provider error body, raw prompt, or
 *   raw artifact payload.
 * - The fetcher is **never** authoritative for the state transition — it
 *   reflects what the server returned; the renderer surfaces the state
 *   badge but the cancel / resume / replay buttons are explicit
 *   `data-action` discriminators only.
 *
 * No DB, no Redis. `fetchImpl` is injectable. Strict TypeScript, zero
 * `any`.
 */

import { sanitizeUpstreamErrorBody } from './upstream-error-body';
import {
  formatOperationsListSort,
  isOperationsListFilterToken,
  LIST_CURSOR_MAX_LEN,
  OPERATIONS_LIST_LIMIT_DEFAULT,
  OPERATIONS_LIST_LIMIT_MAX,
  OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
  OPERATIONS_LIST_SORT_DEFAULT_FIELD,
  OPERATIONS_LIST_SORT_DIRECTIONS,
  OPERATIONS_LIST_SORT_FIELDS,
  OPERATIONS_STATE_FILTER_VALUES,
  OPERATIONS_STATE_FILTER_WIRE_STATES,
  parseOperationsListSort,
  type OperationsListSort,
  type OperationsStateFilter,
} from '@du/contracts';
import type { OperationDetail, OperationState, ArtifactRef } from '@du/contracts';
import { safeTransportErrorText } from '../../http/errors';
import { buildOperationStatusDisplay, formatOperationDetailView } from './operation-view-models';
import type { OperationDetailView, OperationStatusDisplay } from './operation-view-models';

// ---------------------------------------------------------------------------
// Wire shape (raw rows as the platform's GET would return them)
// ---------------------------------------------------------------------------

/**
 * Wire envelope for `GET /api/v1/operations/<operationId>` plus
 * `GET /api/v1/operations/<operationId>/artifacts` merged together so the
 * renderer can paint the full detail pane in a single round-trip.
 *
 * The `result` field is the `ResultEnvelope` from docs 06 — it is
 * surfaced only when the operation is SUCCEEDED. The `artifacts` array
 * is the manifest of attached artifacts with role + filename +
 * size + (relative) download URL.
 */
export interface OperationDetailWireEnvelope {
  operation?: OperationDetail;
  /** Result envelope (docs 06). `null` while not yet terminal / not yet ready. */
  result?: unknown | null;
  /** Attached artifacts (docs 06). `[]` when none. */
  artifacts?: ArtifactRef[];
  /** Wall-clock now from the server; the renderer uses this for wait-expiry. */
  serverNow?: string;
}

/**
 * List envelope for `GET /api/v1/operations`. W-ADMUX02-SRV-1 settled the
 * wire shape to `{ items, nextCursor, prevCursor, total, limit }` on both
 * the admin and the x-api-key path, where `total` is a COUNT of the filtered
 * population. The legacy admin `{ rows, … }` key is still read so an older
 * build behind the shell degrades to a readable page instead of an error.
 */
export interface OperationListWireEnvelope {
  items?: OperationDetail[];
  /** Legacy admin key (pre W-ADMUX02-SRV-1); still accepted on read. */
  rows?: OperationDetail[];
  total?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Catalog (test / offline path)
// ---------------------------------------------------------------------------

/**
 * Headless fixture input — used by tests when no platform JSON API is
 * wired. Mirrors the wire shape but stays fully offline. The fetcher
 * prefers the in-process catalog when no `jsonBaseUrl` is set.
 */
export interface OperationDetailCatalogEntry {
  /** OperationDetail row from the wire. */
  operation: OperationDetail;
  /** Result envelope (when SUCCEEDED), else `null`. */
  result: unknown | null;
  /** Attached artifacts (defaults to `[]`). */
  artifacts: ArtifactRef[];
}

export interface OperationDetailCatalog {
  entries: readonly OperationDetailCatalogEntry[];
  /** Optional server-side `now` override for deterministic wait-expiry tests. */
  serverNow?: string;
}

// ---------------------------------------------------------------------------
// Fetcher input
// ---------------------------------------------------------------------------

/** Inputs the fetcher needs from the shell. */
export interface OperationFetcherInput {
  /** Operation id whose detail to load. Empty → list pane (no detail row). */
  operationId: string;
  /**
   * W-ADMUX-01 (ADM-UX-01/05): page size for the list pane. Integer,
   * clamped to 1..100 (mirrors the admin list route); default 20.
   * Ignored on the detail path.
   */
  listLimit?: number;
  /**
   * W-ADMUX-01: opaque continuation cursor for the list pane (a previous
   * page's `nextCursor`). Passed verbatim to the platform; the offline
   * catalog understands only its own `off:<base36>` shape. Ignored on
   * the detail path.
   */
  cursor?: string;
  /**
   * W-ADMUX-03-FILTER-1 / W-ADMUX02-SRV-1: raw query values for the list
   * toolbar (state enum, exact tenant id, id substring). Sanitized here —
   * invalid tokens are dropped and reported in `ignoredFilters`, never
   * reflected. The accepted values are sent to the server as its
   * allow-listed `state`/`tenant`/`id` params, so the ADM-UX-02 route
   * filters the whole population; the same filters are re-applied to the
   * returned page as defence-in-depth against a build that ignores them.
   */
  stateFilter?: string;
  /** W-ADMUX-03-FILTER-1: raw exact-tenant filter token. */
  tenantFilter?: string;
  /** W-ADMUX-03-FILTER-1: raw operation-id substring token. */
  idFilter?: string;
  /**
   * W-ADMUX03-SHELL-SORT-1: raw `?sort=` token for the list pane
   * (`<field>:<direction>`). Sanitized here with the same @du/contracts
   * parser the route uses; an invalid token is dropped and reported in
   * `ignoredFilters` as `sort`, never reflected. A valid NON-DEFAULT
   * ordering is forwarded as the route's `sort` param; the canonical
   * default (`created_at:desc`) is omitted so pre-sort deep links stay
   * byte-stable.
   *
   * T140-A1 cursor coupling: an operations cursor is bound to the ordering
   * it was minted under, and the route 422s a cursor replayed under a
   * different sort. So a caller that changes the sort MUST drop the cursor
   * (the toolbar form and renderer links enforce this structurally); the
   * fetcher does not decode the token to second-guess the operator - a
   * hand-crafted mismatch surfaces the route's 422 remedy as `kind: 'error'`.
   */
  sortFilter?: string;
  /** Base URL of the orchestrator JSON API. */
  jsonBaseUrl: string;
  /** Admin bearer token (sent verbatim as `Authorization: Bearer …`). */
  adminToken: string;
  /** Optional in-process catalog (test-only). */
  manifestCatalog?: OperationDetailCatalog;
  /** Injected fetch. Default = global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 4000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Fetcher result (discriminated union — drives the renderer's screen state)
// ---------------------------------------------------------------------------

export interface OperationDetailOkResult {
  kind: 'ok';
  /** Selected operation id (echoed back for renderers). */
  selectedOperationId: string;
  /** Full detail view model (typed, never the raw wire). */
  detail: OperationDetailView;
  /** Resolved result (display-safe projection). `null` while not yet SUCCEEDED. */
  resultDisplay: OperationResultDisplay | null;
  /** Artifact rows (already display-safe). */
  artifacts: readonly OperationArtifactDisplay[];
  /** True iff the cancel button is enabled for the current state. */
  canCancel: boolean;
  /** True iff the resume button is enabled (WAITING_INPUT + non-expired wait). */
  canResume: boolean;
  /** True iff the replay button is enabled (terminal state). */
  canReplay: boolean;
  /** The replay label contextualised by state. */
  replayLabel: string;
  /** Server-side now (used for wait-expiry countdown tests). */
  serverNow: string;
}

export interface OperationResultDisplay {
  /** Schema version (always `'1'` per docs 06). */
  schemaVersion: string;
  /** Compact JSON-safe data shape: primitives + nested objects, never functions. */
  dataJson: string;
  /** Pretty-printed data for the human-facing panel. */
  dataPretty: string;
  /** Warnings attached to the result (already strings). */
  warnings: readonly string[];
}

export interface OperationArtifactDisplay {
  artifactId: string;
  role: string;
  fileName: string;
  mimeType: string;
  sizeDisplay: string;
  downloadUrl: string | null;
}

/**
 * One display-safe row of the operations list pane (W-ADMUX-01). Never the
 * raw wire row: only fields the list table renders.
 */
export interface OperationListRow {
  id: string;
  businessId: string;
  businessVersion: string;
  action: string;
  status: OperationStatusDisplay;
  progressPercent: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string | null;
  /** Shell deep link to the row's detail pane. */
  detailHref: string;
}

/**
 * Paged list envelope for `/admin/operations` with no `operationId`.
 *
 * `total` honesty rule: a server count is surfaced verbatim (the ADM-UX-02
 * contract makes it a COUNT of the filtered population, not the row
 * count); a full page from a server that sends no count is reported as
 * `total: null` so the renderer never labels an unknown population with a
 * fabricated number. `nextCursor`/`prevCursor` are surfaced verbatim. A
 * server that supports neither leaves page 2+ unreachable and the UI says
 * so rather than pretending.
 */
export interface OperationListOkResult {
  kind: 'list';
  rows: readonly OperationListRow[];
  /** Page size actually applied (echoed back so controls can render). */
  limit: number;
  /** True population count when known; null when the server cannot say. */
  total: number | null;
  /** Opaque next-page cursor; null when unsupported or at the end. */
  nextCursor: string | null;
  /** Opaque previous-page cursor; null when unsupported or on page 1. */
  prevCursor: string | null;
  /** Cursor this page was requested with (echo; null for the first page). */
  cursor: string | null;
  /** Effective (sanitized) filters this page was rendered with. */
  filters: OperationListFilters;
  /**
   * W-ADMUX03-SHELL-SORT-1: the canonical `field:direction` ordering this
   * page is actually in (`created_at:desc` when no sort was requested or
   * the token was rejected). Links that carry a cursor MUST echo this
   * value, because the cursor is bound to it (T140-A1); links that change
   * the ordering MUST drop the cursor.
   */
  sort: string;
  /** Names of raw filter tokens that were rejected at the boundary. */
  ignoredFilters: readonly string[];
  /** Row count scanned on this page (pre-filter); ≥ rows.length. */
  pageRows: number;
  serverNow: string;
}

export type OperationFetchResult =
  | OperationDetailOkResult
  | OperationListOkResult
  | { kind: 'empty'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'not-found'; operationId: string; message: string }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read-only set of state transitions the cancel button may be shown for. */
const CANCELLABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'ACCEPTED',
  'QUEUED',
  'RUNNING',
  'WAITING_CHILDREN',
  'WAITING_INPUT',
  'RETRY_PENDING',
]);

const TERMINAL_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonString(value: unknown): string {
  // Avoid throwing on circular / function values. Always returns a string;
  // never reflects raw prompt text or raw artifact bytes.
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function prettyPrint(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

function pickCatalog(
  input: OperationFetcherInput,
): OperationDetailCatalog | undefined {
  return input.manifestCatalog;
}

function stateBadgeClass(badge: 'success' | 'error' | 'warning' | 'info' | 'neutral'): string {
  return `status-badge status-badge--${badge}`;
}

// ---------------------------------------------------------------------------
// Replay label (display)
// ---------------------------------------------------------------------------

function replayLabelFor(state: OperationState): string {
  switch (state) {
    case 'FAILED':
      return 'Retry (new operation)';
    case 'CANCELLED':
      return 'Rerun (new operation)';
    case 'TIMED_OUT':
      return 'Retry after timeout (new operation)';
    default:
      return 'Replay (new operation)';
  }
}

// ---------------------------------------------------------------------------
// View-model adaptation
// ---------------------------------------------------------------------------

/**
 * Adapt a wire `OperationDetail` plus artifacts into the typed
 * `OperationDetailView`. We re-use the existing pure view-model from
 * `operation-view-models.ts` so the renderer never sees the raw wire.
 */
function buildDetailView(
  operation: OperationDetail,
  artifacts: readonly ArtifactRef[],
  now: string,
): OperationDetailView {
  return formatOperationDetailView(operation, [...artifacts], now);
}

// ---------------------------------------------------------------------------
// List pane (W-ADMUX-01: ADM-UX-01/05 — paged operations list)
// ---------------------------------------------------------------------------

/**
 * Page-size and cursor bounds come from @du/contracts (W-CONTRACT-ALIGN-1):
 * the shell, the list route and the published schema now read one definition,
 * so "mirrors the admin list route" is no longer a comment that can go stale.
 */
export const OPERATION_LIST_DEFAULT_LIMIT = OPERATIONS_LIST_LIMIT_DEFAULT;
export const OPERATION_LIST_MAX_LIMIT = OPERATIONS_LIST_LIMIT_MAX;
/** Opaque cursors are length-bounded before they reach URLs or logs. */
export const OPERATION_LIST_CURSOR_MAX_LEN = LIST_CURSOR_MAX_LEN;

// ---------------------------------------------------------------------------
// W-ADMUX-03-FILTER-1: list filters (ADM-UX-03 toolbar + deep links)
// ---------------------------------------------------------------------------

/**
 * UI state-filter enum. `COMPLETED` is a display label for the terminal
 * success wire state, never a new machine state. Mapping groups:
 *  RUNNING   → ACCEPTED | QUEUED | RUNNING | RETRY_PENDING |
 *              WAITING_CHILDREN | CANCEL_REQUESTED | WAITING_INPUT
 *              (everything still needing operator attention)
 *  COMPLETED → SUCCEEDED
 *  FAILED    → FAILED            TIMED_OUT → TIMED_OUT
 *  CANCELLED appears under ALL only (no operator triage value in a chip).
 */
export type OperationStateFilter = OperationsStateFilter;

export const OPERATION_STATE_FILTERS: readonly OperationStateFilter[] =
  OPERATIONS_STATE_FILTER_VALUES;

// ---------------------------------------------------------------------------
// W-ADMUX03-SHELL-SORT-1: list ordering (ADM-UX-03 sort control, T140-A1
// cursor binding)
// ---------------------------------------------------------------------------

/** A validated ordering: one of the three route keys in one of two directions. */
export type OperationListSort = OperationsListSort;

/** An ordering paired with its canonical wire text, for rendering controls. */
export interface OperationListSortOption extends OperationListSort {
  /** Canonical `field:direction` form (what `?sort=` and links carry). */
  value: string;
}

/**
 * The six orderings the route accepts, as (field x direction) pairs with
 * their canonical text. Derived from the @du/contracts allow-list arrays -
 * the same arrays the route's six literal ORDER BY fragments are keyed
 * off - so the shell control cannot offer a sort the server would 422.
 */
export const OPERATION_LIST_SORT_OPTIONS: readonly OperationListSortOption[] =
  OPERATIONS_LIST_SORT_FIELDS.flatMap((field) =>
    OPERATIONS_LIST_SORT_DIRECTIONS.map((direction) => {
      const sort: OperationsListSort = { field, direction };
      return { field, direction, value: formatOperationsListSort(sort) };
    })
  );

/** The ordering a request without `sort` gets: canonical `created_at:desc`. */
export const OPERATION_LIST_DEFAULT_SORT: string = formatOperationsListSort({
  field: OPERATIONS_LIST_SORT_DEFAULT_FIELD,
  direction: OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
});

/**
 * Canonical `field:direction` for an accepted sort token, or null for
 * anything else (the same trim/lowercase normalization the route applies).
 * Exported so the shell router can echo the effective ordering onto
 * back-links without re-implementing the rule.
 */
export function sanitizeSortFilter(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseOperationsListSort(raw);
  return parsed ? formatOperationsListSort(parsed) : null;
}

// The group expansion comes from @du/contracts, so the shell's local
// defence-in-depth filter and the server predicate accept exactly the same
// rows by construction rather than by two hand-maintained lists.
const STATE_FILTER_MATCH: Record<Exclude<OperationStateFilter, 'ALL'>, ReadonlySet<string>> = {
  RUNNING: new Set<string>(OPERATIONS_STATE_FILTER_WIRE_STATES.RUNNING),
  COMPLETED: new Set<string>(OPERATIONS_STATE_FILTER_WIRE_STATES.COMPLETED),
  FAILED: new Set<string>(OPERATIONS_STATE_FILTER_WIRE_STATES.FAILED),
  TIMED_OUT: new Set<string>(OPERATIONS_STATE_FILTER_WIRE_STATES.TIMED_OUT),
};

/** Effective (sanitized) filter set carried in the envelope and echoed to URLs. */
export interface OperationListFilters {
  state: OperationStateFilter;
  /** Exact tenant id, character-class validated; null = unfiltered. */
  tenant: string | null;
  /** Case-insensitive id substring, character-class validated. */
  idContains: string | null;
}

/**
 * Boundary for free-text filter tokens (tenant ids, operation ids):
 * starts alphanumeric, then alphanumeric + `_ . : -`, max 64 chars.
 * Anything else (spaces, quotes, markup, credential-shaped prefixes
 * beyond the class, over-long strings) is rejected — a rejected token
 * never re-enters the DOM or a link, satisfying the ADM-UX-02/03 rule
 * of not reflecting raw secrets/tokens/URLs as search terms.
 */
// Both rules live in @du/contracts as `isOperationsListFilterToken`, which is
// the same predicate the list route enforces: the shell may only put a token
// in a URL that the server would accept, and solid 32+ hex (raw API-key
// material) is rejected on both sides so a pasted secret can never act as a
// search term or be echoed back into DOM/URL.
export function sanitizeFilterToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  if (!isOperationsListFilterToken(v)) return null;
  return v;
}

/** Returns the allow-listed enum value or null for anything else. */
export function sanitizeStateFilter(raw: unknown): OperationStateFilter | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return (OPERATION_STATE_FILTERS as readonly string[]).includes(v)
    ? (v as OperationStateFilter)
    : null;
}

function stateFilterWasProvidedButInvalid(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim().length > 0 && sanitizeStateFilter(raw) === null;
}

/**
 * Sanitize the raw filter trio + ordering token into the effective filters,
 * the effective ordering, and the list of raw tokens rejected at the
 * boundary. `sort` is validated with the ONE @du/contracts parser the route
 * uses, so the shell can never accept an ordering the server would 422.
 */
function resolveListFilters(raw: {
  stateFilter?: string;
  tenantFilter?: string;
  idFilter?: string;
  sortFilter?: string;
}): { filters: OperationListFilters; ignored: string[]; sort: OperationsListSort } {
  const ignored: string[] = [];
  let state: OperationStateFilter = 'ALL';
  const stateRaw = raw.stateFilter;
  if (typeof stateRaw === 'string' && stateRaw.trim().length > 0) {
    const ok = sanitizeStateFilter(stateRaw);
    if (ok) state = ok;
    else if (stateFilterWasProvidedButInvalid(stateRaw)) ignored.push('state');
  }
  let tenant: string | null = null;
  if (typeof raw.tenantFilter === 'string' && raw.tenantFilter.trim().length > 0) {
    tenant = sanitizeFilterToken(raw.tenantFilter);
    if (tenant === null) ignored.push('tenant');
  }
  let idContains: string | null = null;
  if (typeof raw.idFilter === 'string' && raw.idFilter.trim().length > 0) {
    idContains = sanitizeFilterToken(raw.idFilter);
    if (idContains === null) ignored.push('id');
  }
  let sort: OperationsListSort = {
    field: OPERATIONS_LIST_SORT_DEFAULT_FIELD,
    direction: OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
  };
  if (typeof raw.sortFilter === 'string' && raw.sortFilter.trim().length > 0) {
    const ok = parseOperationsListSort(raw.sortFilter);
    if (ok) sort = ok;
    else ignored.push('sort');
  }
  return { filters: { state, tenant, idContains }, ignored, sort };
}

export function areListFiltersActive(f: OperationListFilters): boolean {
  return f.state !== 'ALL' || f.tenant !== null || f.idContains !== null;
}

/** Apply the effective filters to normalised rows (page-local, pre-projection). */
function applyListFilters(
  ops: readonly OperationDetail[],
  f: OperationListFilters,
): OperationDetail[] {
  const stateMatch = f.state === 'ALL' ? null : STATE_FILTER_MATCH[f.state];
  const needle = f.idContains ? f.idContains.toLowerCase() : null;
  return ops.filter((op) => {
    if (stateMatch && !stateMatch.has(op.state)) return false;
    if (f.tenant !== null && op.tenantId !== f.tenant) return false;
    if (needle !== null && !op.id.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * W-ADMUX03-SHELL-SORT-1: offline mirror of the route's ORDER BY keyset -
 * `(<key>, id)` in the requested direction, with NULL deadlines ordered
 * LAST in both directions, because the route COALESCEs the column over a
 * bound sentinel (`0001-01-01T00:00:00.000Z` walking desc,
 * `9999-12-31T23:59:59.999Z` walking asc) so a keyset predicate is never
 * true against NULL. The DEFAULT ordering keeps the fixture author's entry
 * order (W-ADMUX-01 behaviour: catalogs are written newest-first), so
 * existing offline pages are unchanged; alternate orderings derive
 * position from the key. Positions therefore shift when the ordering
 * changes - catalog cursors stay catalog-internal (`off:<base36>`) and are
 * not the server's sort-bound keyset token.
 */
const CATALOG_NULL_DEADLINE_SENTINEL: Record<'asc' | 'desc', string> = {
  desc: '0001-01-01T00:00:00.000Z',
  asc: '9999-12-31T23:59:59.999Z',
};

function catalogSortKey(op: OperationDetail, field: OperationsListSort['field'], missing: string): string {
  if (field === 'updated_at') return op.updatedAt;
  if (field === 'deadline_at') return op.deadlineAt ?? missing;
  return op.createdAt;
}

function sortCatalogPopulation(
  ops: OperationDetail[],
  sort: OperationsListSort,
): OperationDetail[] {
  if (
    sort.field === OPERATIONS_LIST_SORT_DEFAULT_FIELD &&
    sort.direction === OPERATIONS_LIST_SORT_DEFAULT_DIRECTION
  ) {
    return ops;
  }
  const factor = sort.direction === 'asc' ? 1 : -1;
  const missing = CATALOG_NULL_DEADLINE_SENTINEL[sort.direction];
  return [...ops].sort((a, b) => {
    const ka = catalogSortKey(a, sort.field, missing);
    const kb = catalogSortKey(b, sort.field, missing);
    if (ka !== kb) return ka < kb ? -factor : factor;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -factor : factor;
  });
}

/** Normalise a requested page size: integer 1..100, default 20. Never throws. */
export function clampListLimit(raw: number | string | undefined | null): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return OPERATION_LIST_DEFAULT_LIMIT;
  return Math.min(OPERATION_LIST_MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

function detailHrefFor(id: string): string {
  return `/admin/operations?operationId=${encodeURIComponent(id)}`;
}

function toListRow(op: OperationDetail): OperationListRow {
  return {
    id: op.id,
    businessId: op.businessId,
    businessVersion: op.businessVersion,
    action: op.action,
    status: buildOperationStatusDisplay(op.state),
    progressPercent: Math.max(0, Math.min(100, op.progress.percent)),
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    deadlineAt: op.deadlineAt,
    detailHref: detailHrefFor(op.id),
  };
}

/** Catalog cursors are `off:<base36>`; anything else is treated as absent. */
function parseCatalogCursor(cursor: string | undefined | null): number | null {
  if (!cursor) return null;
  const m = /^off:([0-9a-z]+)$/.exec(cursor);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 36);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function formatCatalogCursor(offset: number): string {
  return `off:${offset.toString(36)}`;
}

/**
 * Offline-catalog list page. The catalog is test/fixture-only input, so the
 * filtered population is fully known — `total` is exact and the offset
 * cursors are real. This is what makes the pagination and filter controls
 * exercisable without a live platform; it is never a substitute for the
 * ADM-UX-02 server contract, only an offline mirror of it.
 */
interface RawListFilterInput {
  stateFilter?: string;
  tenantFilter?: string;
  idFilter?: string;
  /** W-ADMUX03-SHELL-SORT-1: raw sort token (see OperationFetcherInput). */
  sortFilter?: string;
}

function buildListFromCatalog(
  catalog: OperationDetailCatalog,
  listLimit: number | string | undefined | null,
  cursor: string | undefined | null,
  rawFilters: RawListFilterInput,
  serverNow?: string,
): OperationListOkResult {
  const limit = clampListLimit(listLimit);
  const { filters, ignored, sort } = resolveListFilters(rawFilters);
  // W-ADMUX02-SRV-1: filter the WHOLE fixture population, THEN page it —
  // the same order the server applies. Paging first would make an offline
  // catalog page mean something different from a live page, and would report
  // the unfiltered population as the total.
  const population = applyListFilters(
    catalog.entries.map((e) => e.operation),
    filters
  );
  const total = population.length;
  const offset = Math.min(parseCatalogCursor(cursor) ?? 0, total);
  const page = sortCatalogPopulation(population, sort).slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    kind: 'list',
    rows: page.map(toListRow),
    limit,
    total,
    nextCursor: nextOffset < total ? formatCatalogCursor(nextOffset) : null,
    prevCursor: offset > 0 ? formatCatalogCursor(Math.max(0, offset - limit)) : null,
    cursor: cursor && cursor.length > 0 ? cursor : null,
    filters,
    sort: formatOperationsListSort(sort),
    ignoredFilters: ignored,
    pageRows: page.length,
    serverNow: serverNow ?? catalog.serverNow ?? new Date().toISOString(),
  };
}

/**
 * Map the platform list envelope onto `OperationListOkResult`. Current
 * contract (W-ADMUX02-SRV-1): `{ items, nextCursor, prevCursor, total,
 * limit }`; the legacy admin `{ rows, total, limit }` and the older tenant
 * `{ items, nextCursor }` are both still read. Malformed rows are dropped,
 * never rendered as placeholders. Invalid payload → `kind: 'error'`.
 */
function parseListPayload(
  raw: unknown,
  requestedLimit: number,
  cursor: string | null,
  serverNow: string,
  rawFilters: RawListFilterInput,
): OperationFetchResult {
  if (!isRecord(raw)) {
    return {
      kind: 'error',
      message: 'Platform returned an unexpected payload shape (not an object).',
    };
  }
  const rawRows = Array.isArray(raw['rows'])
    ? (raw['rows'] as unknown[])
    : Array.isArray(raw['items'])
      ? (raw['items'] as unknown[])
      : null;
  if (!rawRows) {
    return {
      kind: 'error',
      message: 'Platform returned an operations payload without a rows/items array.',
    };
  }
  const pageOps = rawRows
    .map(normaliseOperation)
    .filter((o): o is OperationDetail => o !== null && o.id.length > 0);
  const { filters, ignored, sort } = resolveListFilters(rawFilters);
  const rows = applyListFilters(pageOps, filters).map(toListRow);
  const limit = typeof raw['limit'] === 'number' && Number.isFinite(raw['limit'] as number)
    ? clampListLimit(raw['limit'])
    : requestedLimit;
  const nextRaw = raw['nextCursor'];
  const prevRaw = raw['prevCursor'];
  const nextCursor = typeof nextRaw === 'string' && nextRaw.length > 0 ? nextRaw : null;
  const prevCursor = typeof prevRaw === 'string' && prevRaw.length > 0 ? prevRaw : null;
  const serverTotal = typeof raw['total'] === 'number' && Number.isFinite(raw['total'] as number)
    ? (raw['total'] as number)
    : null;
  let total: number | null;
  if (serverTotal !== null) {
    // W-ADMUX02-SRV-1 (ADM-UX-02): the route contract makes `total` a COUNT
    // over the whole filtered population, never the returned-row count, so
    // it is surfaced verbatim. The floor keeps a short count from
    // under-reporting rows that are literally in hand.
    total = Math.max(serverTotal, pageOps.length);
  } else if (pageOps.length < limit) {
    // No count and a partial page ⇒ the whole population is on this page.
    total = pageOps.length;
  } else {
    // No count and a full page ⇒ population unknown. Never invent a number.
    total = null;
  }
  return {
    kind: 'list',
    rows,
    limit,
    total,
    nextCursor,
    prevCursor,
    cursor,
    filters,
    sort: formatOperationsListSort(sort),
    ignoredFilters: ignored,
    pageRows: rawRows.length,
    serverNow,
  };
}

// ---------------------------------------------------------------------------
// Catalog → ok result
// ---------------------------------------------------------------------------

function buildOkFromCatalog(
  catalog: OperationDetailCatalog,
  operationId: string,
): OperationFetchResult {
  if (operationId.length === 0) {
    // W-ADMUX-01: the paged list pane is built by buildListFromCatalog in
    // the fetcher's offline branch. Reaching here means a caller bypassed
    // the fetcher; stay honest — never fabricate a selected row.
    return {
      kind: 'empty',
      message:
        'No operations have been recorded yet. Submit one via the public API to see it here.',
    };
  }

  const hit = catalog.entries.find((e) => e.operation.id === operationId);
  if (!hit) {
    return {
      kind: 'not-found',
      operationId,
      message: `Operation '${operationId}' is not in the in-process catalog.`,
    };
  }
  return buildOkForEntry(hit, operationId, catalog.serverNow ?? new Date().toISOString(), true);
}

function buildOkForEntry(
  entry: OperationDetailCatalogEntry,
  operationId: string,
  serverNow: string,
  withActions: boolean,
): OperationDetailOkResult {
  const detail = buildDetailView(entry.operation, entry.artifacts, serverNow);
  const resultDisplay = formatResultDisplay(entry.result, detail.status.terminal);
  const artifacts = entry.artifacts.map(toArtifactDisplay);
  const state = detail.status.state;
  const canCancel = withActions && CANCELLABLE_STATES.has(state);
  const canResume =
    withActions &&
    state === 'WAITING_INPUT' &&
    !!detail.humanWaitForm &&
    !detail.humanWaitForm.isExpired;
  const canReplay = withActions && TERMINAL_STATES.has(state);
  const replayLabel = replayLabelFor(state);
  return {
    kind: 'ok',
    selectedOperationId: operationId.length > 0 ? operationId : detail.id,
    detail,
    resultDisplay,
    artifacts,
    canCancel,
    canResume,
    canReplay,
    replayLabel,
    serverNow,
  };
}

function toArtifactDisplay(ref: ArtifactRef): OperationArtifactDisplay {
  return {
    artifactId: ref.artifactId,
    role: ref.role ?? 'output',
    fileName: ref.fileName ?? ref.artifactId,
    mimeType: ref.mimeType ?? 'application/octet-stream',
    sizeDisplay: formatSize(ref.sizeBytes),
    downloadUrl: ref.download ?? null,
  };
}

function formatSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatResultDisplay(
  raw: unknown,
  terminal: boolean,
): OperationResultDisplay | null {
  if (!terminal) return null;
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return null;
  const schemaVersion =
    typeof raw['schemaVersion'] === 'string' ? (raw['schemaVersion'] as string) : '1';
  const data = raw['data'];
  const warningsRaw = Array.isArray(raw['warnings']) ? (raw['warnings'] as unknown[]) : [];
  const warnings = warningsRaw
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.slice(0, 256));
  return {
    schemaVersion,
    dataJson: safeJsonString(data),
    dataPretty: prettyPrint(data),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Wire → ok result
// ---------------------------------------------------------------------------

function normaliseOperation(raw: unknown): OperationDetail | null {
  if (!isRecord(raw)) return null;
  const state = raw['state'];
  if (
    state !== 'ACCEPTED' &&
    state !== 'QUEUED' &&
    state !== 'RUNNING' &&
    state !== 'WAITING_CHILDREN' &&
    state !== 'WAITING_INPUT' &&
    state !== 'RETRY_PENDING' &&
    state !== 'CANCEL_REQUESTED' &&
    state !== 'SUCCEEDED' &&
    state !== 'FAILED' &&
    state !== 'CANCELLED' &&
    state !== 'TIMED_OUT'
  ) {
    return null;
  }
  const progressRaw = raw['progress'];
  const progress = isRecord(progressRaw)
    ? {
        percent:
          typeof progressRaw['percent'] === 'number'
            ? (progressRaw['percent'] as number)
            : 0,
        message:
          typeof progressRaw['message'] === 'string'
            ? (progressRaw['message'] as string)
            : undefined,
      }
    : { percent: 0, message: undefined };
  const linksRaw = raw['links'];
  const links = isRecord(linksRaw)
    ? {
        self: typeof linksRaw['self'] === 'string' ? (linksRaw['self'] as string) : '',
        result: typeof linksRaw['result'] === 'string' ? (linksRaw['result'] as string) : '',
      }
    : { self: '', result: '' };
  const waitRaw = raw['wait'];
  let wait: OperationDetail['wait'] = null;
  if (isRecord(waitRaw)) {
    wait = {
      waitId: typeof waitRaw['waitId'] === 'string' ? (waitRaw['waitId'] as string) : '',
      inputSchema: isRecord(waitRaw['inputSchema'])
        ? (waitRaw['inputSchema'] as Record<string, unknown>)
        : {},
      uiSchema: isRecord(waitRaw['uiSchema'])
        ? (waitRaw['uiSchema'] as Record<string, unknown>)
        : undefined,
      expiresAt: typeof waitRaw['expiresAt'] === 'string' ? (waitRaw['expiresAt'] as string) : '',
    };
  }
  const errorRaw = raw['error'];
  let error: OperationDetail['error'] = null;
  if (isRecord(errorRaw)) {
    error = {
      code: typeof errorRaw['code'] === 'string' ? (errorRaw['code'] as string) : '',
      title: typeof errorRaw['title'] === 'string' ? (errorRaw['title'] as string) : '',
      detail:
        typeof errorRaw['detail'] === 'string' ? (errorRaw['detail'] as string) : undefined,
    };
  }
  return {
    id: typeof raw['id'] === 'string' ? (raw['id'] as string) : '',
    tenantId: typeof raw['tenantId'] === 'string' ? (raw['tenantId'] as string) : '',
    businessId: typeof raw['businessId'] === 'string' ? (raw['businessId'] as string) : '',
    businessVersion:
      typeof raw['businessVersion'] === 'string' ? (raw['businessVersion'] as string) : '',
    action: typeof raw['action'] === 'string' ? (raw['action'] as string) : '',
    state,
    stateVersion:
      typeof raw['stateVersion'] === 'number' ? (raw['stateVersion'] as number) : 0,
    createdAt: typeof raw['createdAt'] === 'string' ? (raw['createdAt'] as string) : '',
    updatedAt: typeof raw['updatedAt'] === 'string' ? (raw['updatedAt'] as string) : '',
    deadlineAt:
      typeof raw['deadlineAt'] === 'string' ? (raw['deadlineAt'] as string) : null,
    replayOf: typeof raw['replayOf'] === 'string' ? (raw['replayOf'] as string) : null,
    progress,
    links,
    wait,
    error,
  };
}

function normaliseArtifact(raw: unknown): ArtifactRef | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw['artifactId'] === 'string' ? (raw['artifactId'] as string) : '';
  if (!id) return null;
  return {
    artifactId: id,
    role: typeof raw['role'] === 'string' ? (raw['role'] as string) : 'output',
    fileName: typeof raw['fileName'] === 'string' ? (raw['fileName'] as string) : undefined,
    mimeType: typeof raw['mimeType'] === 'string' ? (raw['mimeType'] as string) : undefined,
    sizeBytes:
      typeof raw['sizeBytes'] === 'number' ? (raw['sizeBytes'] as number) : undefined,
    hashSha256:
      typeof raw['hashSha256'] === 'string' ? (raw['hashSha256'] as string) : undefined,
    download: typeof raw['download'] === 'string' ? (raw['download'] as string) : undefined,
  };
}

function parseFetchPayload(
  raw: unknown,
  operationId: string,
  serverNow: string,
): OperationFetchResult {
  if (!isRecord(raw)) {
    return {
      kind: 'error',
      message: 'Platform returned an unexpected payload shape (not an object).',
    };
  }
  const operation = normaliseOperation(raw['operation']);
  if (!operation) {
    return {
      kind: 'not-found',
      operationId,
      message: `Operation '${operationId}' is not on the server.`,
    };
  }
  const rawArtifacts = Array.isArray(raw['artifacts']) ? (raw['artifacts'] as unknown[]) : [];
  const artifacts: ArtifactRef[] = rawArtifacts
    .map(normaliseArtifact)
    .filter((a): a is ArtifactRef => a !== null);
  const result = raw['result'] ?? null;
  const state = operation.state;
  const now = typeof raw['serverNow'] === 'string' ? (raw['serverNow'] as string) : serverNow;
  const detail = buildDetailView(operation, artifacts, now);
  const resultDisplay = formatResultDisplay(result, detail.status.terminal);
  const artifactDisplay = artifacts.map(toArtifactDisplay);
  const canCancel = CANCELLABLE_STATES.has(state);
  const canResume =
    state === 'WAITING_INPUT' && !!detail.humanWaitForm && !detail.humanWaitForm.isExpired;
  const canReplay = TERMINAL_STATES.has(state);
  return {
    kind: 'ok',
    selectedOperationId: operationId,
    detail,
    resultDisplay,
    artifacts: artifactDisplay,
    canCancel,
    canResume,
    canReplay,
    replayLabel: replayLabelFor(state),
    serverNow: now,
  };
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the operation detail (or list, when `operationId` is empty) for
 * the shell. Returns a discriminated result the renderer can map onto a
 * screen state. **Never throws** — transport errors collapse into
 * `{ kind: 'error', ... }`.
 */
export async function fetchOperationDetail(
  input: OperationFetcherInput,
): Promise<OperationFetchResult> {
  const operationId = input.operationId;
  const catalog = pickCatalog(input);

  // Offline path.
  if (!input.jsonBaseUrl) {
    if (!catalog || catalog.entries.length === 0) {
      return {
        kind: 'empty',
        message:
          'No operations have been recorded yet. Submit one via the public API to see it here.',
      };
    }
    if (operationId.length === 0) {
      return buildListFromCatalog(catalog, input.listLimit, input.cursor, input);
    }
    return buildOkFromCatalog(catalog, operationId);
  }

  if (!input.adminToken) {
    return {
      kind: 'unauthorized',
      message: 'Admin bearer token is not configured.',
    };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 4000;
  const nowMs = Date.now();

  const listLimit = clampListLimit(input.listLimit);
  const listCursor =
    input.cursor && input.cursor.length > 0
      ? input.cursor.slice(0, OPERATION_LIST_CURSOR_MAX_LEN)
      : null;

  let url: URL;
  try {
    const path =
      operationId.length > 0
        ? `/api/v1/operations/${encodeURIComponent(operationId)}`
        : `/api/v1/operations`;
    url = new URL(path, input.jsonBaseUrl);
    if (operationId.length === 0) {
      // W-ADMUX-01: server-side page size + keyset cursor; the browser never
      // filters or trims the population client-side.
      url.searchParams.set('limit', String(listLimit));
      if (listCursor) url.searchParams.set('cursor', listCursor);
      // W-ADMUX02-SRV-1 (ADM-UX-02): the toolbar filters now travel as the
      // route's allow-listed query params, so the server filters the WHOLE
      // population instead of this page only. Rejected tokens are dropped
      // here and never reach the URL.
      const { filters: listFilters, sort: listSort } = resolveListFilters(input);
      if (listFilters.state !== 'ALL') url.searchParams.set('state', listFilters.state);
      if (listFilters.tenant !== null) url.searchParams.set('tenant', listFilters.tenant);
      if (listFilters.idContains !== null) url.searchParams.set('id', listFilters.idContains);
      // W-ADMUX03-SHELL-SORT-1: forward the effective ordering. The canonical
      // default is omitted so default-order deep links and default-minted
      // cursors stay byte-compatible with pre-sort builds (T140-A1: the
      // route resolves an absent sort as created_at:desc, exactly what a
      // default cursor is bound to).
      const sortCanonical = formatOperationsListSort(listSort);
      if (sortCanonical !== OPERATION_LIST_DEFAULT_SORT) url.searchParams.set('sort', sortCanonical);
    }
  } catch {
    return {
      kind: 'error',
      message: 'Invalid platform JSON API base URL.',
    };
  }

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
    if (res.status === 404) {
      return {
        kind: 'not-found',
        operationId,
        message:
          operationId.length > 0
            ? `Operation '${operationId}' is not on the server.`
            : 'Platform returned 404 for the operations list.',
      };
    }
    if (!res.ok) {
      const body = sanitizeUpstreamErrorBody(await res.text().catch(() => ''));
      return {
        kind: 'error',
        message: `Platform returned HTTP ${res.status}${body ? `: ${body}` : ''}`,
      };
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: 'error',
        message: 'Platform returned non-JSON for the operation detail endpoint.',
      };
    }
    const serverNow = new Date(nowMs).toISOString();
    if (operationId.length === 0) {
      return parseListPayload(parsed, listLimit, listCursor, serverNow, input);
    }
    return parseFetchPayload(parsed, operationId, serverNow);
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
  normaliseOperation,
  normaliseArtifact,
  parseFetchPayload,
  parseListPayload,
  buildOkFromCatalog,
  buildListFromCatalog,
  clampListLimit,
  resolveListFilters,
  applyListFilters,
  formatResultDisplay,
  stateBadgeClass,
  replayLabelFor,
};

/** Type guard for the renderer / tests. */
export function isOperationOkResult(
  f: OperationFetchResult,
): f is OperationDetailOkResult {
  return f.kind === 'ok';
}
