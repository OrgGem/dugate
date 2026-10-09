import { z } from 'zod';
import { OperationStateSchema } from './operations';

/**
 * Public API DTOs (docs 06): pagination, submission response, webhook payload.
 */

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */
/* Pagination (generic)                                                */
/* ------------------------------------------------------------------ */

/**
 * Shared bound for an opaque list cursor across the platform. The orchestrator
 * and the admin shell both cap cursors at this length before they reach a URL,
 * a log line or a database parameter, so it lives here rather than being
 * restated in each consumer.
 */
export const LIST_CURSOR_MAX_LEN = 128;

/** Generic cursor+limit page request. Not the operations-list request schema. */
export const PageQuerySchema = z.object({
  cursor: z.string().max(LIST_CURSOR_MAX_LEN).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/* ------------------------------------------------------------------ */
/* Operations list — GET /api/v1/operations (W-CONTRACT-ALIGN-1)       */
/* ------------------------------------------------------------------ */

/**
 * The wire contract for the operations list route.
 *
 * This is the SINGLE source of truth for it: `server.ts` imports these symbols
 * and builds its allow-list from them, and the admin shell re-points its own
 * constants here. Before this packet the route parsed its own private copies
 * while this file still advertised a superseded three-parameter schema with a
 * 512-char cursor and a machine-typed `state`, and the helper returned the
 * two-field page the route stopped emitting. Reviewer T70-C1.
 *
 * Conformance is locked by two tests: contracts/tests/operations-list-contract
 * (shape and accept/reject rules) and the orchestrator's
 * operations-list-contract-conformance (drives the real route and validates its
 * response against OperationsListPageSchema, plus a per-parameter test built
 * from OPERATIONS_LIST_QUERY_PARAMS so a new route parameter cannot appear
 * without appearing here too).
 */

export const OPERATIONS_LIST_LIMIT_DEFAULT = 20;
export const OPERATIONS_LIST_LIMIT_MAX = 100;

/**
 * The six names the route reads. Everything else is ignored: the route never
 * echoes an unknown parameter, so this array is the allow-list, not a hint.
 */
export const OPERATIONS_LIST_QUERY_PARAMS = [
  'limit',
  'cursor',
  'state',
  'tenant',
  'id',
  'sort',
] as const;
export type OperationsListQueryParam = (typeof OPERATIONS_LIST_QUERY_PARAMS)[number];

/**
 * Operator-facing state filter. NOT the machine state: `RUNNING` is a group
 * (see OPERATIONS_STATE_FILTER_WIRE_STATES) and `COMPLETED` is the display
 * label for the `SUCCEEDED` wire state, so a machine value such as `QUEUED`
 * is a 422 on this parameter by design.
 */
export const OPERATIONS_STATE_FILTER_VALUES = [
  'ALL',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const;
export type OperationsStateFilter = (typeof OPERATIONS_STATE_FILTER_VALUES)[number];
export const OperationsStateFilterSchema = z.enum(OPERATIONS_STATE_FILTER_VALUES);

/** How each operator-facing value expands into machine states for the predicate. */
export const OPERATIONS_STATE_FILTER_WIRE_STATES: Readonly<
  Record<Exclude<OperationsStateFilter, 'ALL'>, readonly string[]>
> = {
  RUNNING: [
    'ACCEPTED',
    'QUEUED',
    'RUNNING',
    'RETRY_PENDING',
    'WAITING_CHILDREN',
    'CANCEL_REQUESTED',
    'WAITING_INPUT',
  ],
  COMPLETED: ['SUCCEEDED'],
  FAILED: ['FAILED'],
  CANCELLED: ['CANCELLED'],
  TIMED_OUT: ['TIMED_OUT'],
};

/**
 * Filter token shape for `tenant` and `id`: starts alphanumeric, then
 * alphanumeric plus `_ . : -`, at most 64 characters. Spaces, quotes, markup
 * and any longer string are rejected outright rather than truncated, so a
 * rejected value never re-enters a URL, the DOM or a log line.
 */
export const OPERATIONS_LIST_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** Solid 32+ hex is API-key material, never an operator-usable id fragment. */
export const OPERATIONS_LIST_SOLID_HEX_PATTERN = /^[0-9a-fA-F]{32,}$/;

export function isOperationsListFilterToken(value: string): boolean {
  return (
    OPERATIONS_LIST_TOKEN_PATTERN.test(value) &&
    !OPERATIONS_LIST_SOLID_HEX_PATTERN.test(value)
  );
}

/* ------------------------------------------------------------------ */
/* Operations list sort — GET /api/v1/operations?sort=<field>:<dir>     */
/* ------------------------------------------------------------------ */

/**
 * The sortable columns: every entry is a real column on operations (see
 * migrations/0001_platform_v1.sql), because the route turns the validated field
 * into one of the SIX literal ORDER BY fragments it builds from this pair of
 * arrays — the name it was given is never interpolated into SQL text.
 *
 * deadline_at is the one column 0001 declares without NOT NULL. That is not a
 * detail: a row-value keyset predicate is never true against NULL, so an
 * ORDER BY deadline_at page would silently lose every deadline-less operation
 * from the second page on. OPERATIONS_LIST_NULLABLE_SORT_FIELDS below is the
 * route's reminder to make that key total before comparing it.
 */
export const OPERATIONS_LIST_SORT_FIELDS = [
  'created_at',
  'updated_at',
  'deadline_at',
] as const;
export type OperationsListSortField = (typeof OPERATIONS_LIST_SORT_FIELDS)[number];

/**
 * Directions, lowercase only. A URL parameter has to mean one thing: 'DESC' and
 * 'Desc' are accepted (an operator may type them) and normalised, but the
 * canonical rendered form this contract emits is always lowercase, so a deep
 * link and a re-emitted link compare equal.
 */
export const OPERATIONS_LIST_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type OperationsListSortDirection =
  (typeof OPERATIONS_LIST_SORT_DIRECTIONS)[number];

/**
 * Newest first — the order the route already had before a sort parameter
 * existed, so an absent sort keeps every existing cursor and deep link valid.
 */
export const OPERATIONS_LIST_SORT_DEFAULT_FIELD: OperationsListSortField = 'created_at';
export const OPERATIONS_LIST_SORT_DEFAULT_DIRECTION: OperationsListSortDirection = 'desc';
export const OPERATIONS_LIST_SORT_DEFAULT = `${OPERATIONS_LIST_SORT_DEFAULT_FIELD}:${OPERATIONS_LIST_SORT_DEFAULT_DIRECTION}`;

export interface OperationsListSort {
  field: OperationsListSortField;
  direction: OperationsListSortDirection;
}

/**
 * Parse the sort parameter into a validated (field, direction) pair, or null
 * when it is outside the allow-list.
 *
 * ONE implementation, two callers: the schema refine below and the route's
 * parser. That is the whole point — if each side had its own check, the
 * published contract could accept a sort the route 422s, which is the exact
 * producer/consumer drift Reviewer T70-C1 was raised for.
 *
 * The split is on the LAST colon, on purpose: only the text after the final
 * colon can be the direction, so a value with an extra colon in it fails
 * outright instead of being quietly truncated into something that passes.
 */
export function parseOperationsListSort(raw: string): OperationsListSort | null {
  const value = raw.trim().toLowerCase();
  const sep = value.lastIndexOf(':');
  if (sep <= 0 || sep === value.length - 1) return null;
  const field = value.slice(0, sep);
  const direction = value.slice(sep + 1);
  if (!(OPERATIONS_LIST_SORT_FIELDS as readonly string[]).includes(field)) return null;
  if (!(OPERATIONS_LIST_SORT_DIRECTIONS as readonly string[]).includes(direction)) {
    return null;
  }
  return {
    field: field as OperationsListSortField,
    direction: direction as OperationsListSortDirection,
  };
}

/** Canonical text form, for the error message and for emitted links. */
export function formatOperationsListSort(sort: OperationsListSort): string {
  return `${sort.field}:${sort.direction}`;
}

/** Every sort the route accepts, spelled out for the 422 message. */
export const OPERATIONS_LIST_SORT_VALUES: readonly string[] =
  OPERATIONS_LIST_SORT_FIELDS.flatMap((field) =>
    OPERATIONS_LIST_SORT_DIRECTIONS.map((direction) => `${field}:${direction}`)
  );

/** Request schema as the route accepts it. Every parameter is optional. */
export const ListOperationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(OPERATIONS_LIST_LIMIT_MAX).default(OPERATIONS_LIST_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(LIST_CURSOR_MAX_LEN).optional(),
    state: OperationsStateFilterSchema.optional(),
    tenant: z.string().regex(OPERATIONS_LIST_TOKEN_PATTERN).optional(),
    id: z.string().regex(OPERATIONS_LIST_TOKEN_PATTERN).optional(),
    // Same predicate the route uses, so the schema cannot accept a sort value
    // the route would reject. It stays a string to the caller: narrowing it to
    // the pair is parseOperationsListSort's job, and it does it identically.
    sort: z
      .string()
      .refine((value) => parseOperationsListSort(value) !== null, {
        message: 'sort must be <field>:<direction>',
      })
      .default(OPERATIONS_LIST_SORT_DEFAULT),
  })
  .strict();
export type ListOperationsQuery = z.infer<typeof ListOperationsQuerySchema>;

/**
 * The five-field page envelope.
 *
 * `total` is a COUNT over the filtered population, never the number of rows
 * returned: an earlier route answered with `total = rows.length`, which made
 * every full page lie about the size of the result set.
 * `prevCursor` is null exactly when there is no page above this one; a cursor
 * carries its own walk direction inside the opaque token because the route
 * exposes a single `?cursor=` parameter.
 */
export const OperationsListPageSchema = z
  .object({
    items: z.array(z.record(z.unknown())),
    nextCursor: z.string().max(LIST_CURSOR_MAX_LEN).nullable(),
    prevCursor: z.string().max(LIST_CURSOR_MAX_LEN).nullable(),
    total: z.number().int().min(0),
    limit: z.number().int().min(1).max(OPERATIONS_LIST_LIMIT_MAX),
  })
  .strict();
export type OperationsListPage = z.infer<typeof OperationsListPageSchema>;

/**
 * Builds the operations page envelope. Delegates to the shared `listPage` so
 * the five page fields have exactly one builder across the admin lists;
 * the name is kept because the route already uses it and it reads better at
 * the operations call site.
 */
export function operationsListPage<T>(input: {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
}): OperationsListPage {
  return listPage(input);
}
/* ------------------------------------------------------------------ */
/* Shared admin list-page contract (W-ADMUX02-EXT-1)                  */
/* ------------------------------------------------------------------ */

/**
 * Keyset cursor codec shared by every admin list page.
 *
 * The operations-list token format was already live-accepted (T-CODEX-TEST-20),
 * so this is the SAME encoding moved here rather than a new one: the audit and
 * api-key routes reuse it instead of each inventing a third and fourth cursor
 * dialect — which is the duplication T70-C1 was about. Format:
 * base64url(`<canonical ISO-8601 instant>|<uuid>[|p]`), where the trailing
 * `|p` marks a BACKWARD cursor (a single `?cursor=` parameter serves both hops).
 */
export function encodeListCursor(
  createdAt: string | Date,
  id: string,
  direction: 'next' | 'prev' = 'next',
): string {
  const ts = new Date(createdAt).toISOString();
  const dir = direction === 'prev' ? '|p' : '';
  return Buffer.from(`${ts}|${id}${dir}`, 'utf8').toString('base64url');
}

export interface ListCursor {
  createdAt: string;
  id: string;
  direction: 'next' | 'prev';
}

/** Strict decode; returns null for anything the format does not define. */
export function decodeListCursor(raw: string, maxLen = LIST_CURSOR_MAX_LEN): ListCursor | null {
  if (raw.length === 0 || raw.length > maxLen) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = text.indexOf('|');
  if (sep <= 0) return null;
  const createdAt = text.slice(0, sep);
  let id = text.slice(sep + 1);
  let direction: 'next' | 'prev' = 'next';
  if (id.endsWith('|p')) {
    direction = 'prev';
    id = id.slice(0, -2);
  }
  if (!LIST_CURSOR_ID_UUID_PATTERN.test(id)) return null;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== createdAt) return null;
  return { createdAt, id: id.toLowerCase(), direction };
}

const LIST_CURSOR_ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Page bounds shared by the admin list routes. */
export const ADMIN_LIST_LIMIT_DEFAULT = 50;
export const ADMIN_LIST_LIMIT_MAX = 200;

/**
 * The five page fields every admin list route returns. Deliberately NOT
 * strict: a section may legitimately carry extra payload alongside the page
 * (the api-keys list also returns its grants). Route-specific schemas extend
 * this base and add `.strict()`, so the shared five stay one definition while
 * each surface still pins its own full shape.
 */
export const ListPageBaseSchema = z.object({
  items: z.array(z.record(z.unknown())),
  nextCursor: z.string().max(LIST_CURSOR_MAX_LEN).nullable(),
  prevCursor: z.string().max(LIST_CURSOR_MAX_LEN).nullable(),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(ADMIN_LIST_LIMIT_MAX),
});
export type ListPageBase = z.infer<typeof ListPageBaseSchema>;

/** Shared closed sort vocabulary for mutable admin resources. */
export const ADMIN_RESOURCE_LIST_SORT_FIELDS = ['createdAt', 'updatedAt'] as const;
export const ADMIN_RESOURCE_LIST_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const ADMIN_RESOURCE_LIST_SORT_VALUES = [
  'createdAt:asc',
  'createdAt:desc',
  'updatedAt:asc',
  'updatedAt:desc',
] as const;
export const ADMIN_RESOURCE_LIST_SORT_DEFAULT = 'createdAt:desc' as const;
export type AdminResourceListSort = (typeof ADMIN_RESOURCE_LIST_SORT_VALUES)[number];

export interface AdminResourceListSortCursor {
  timestamp: string;
  id: string;
  direction: 'next' | 'prev';
  sort: AdminResourceListSort;
}

function adminCursorMicros(timestamp: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(timestamp);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(6, '0');
  const millis = Number.parseInt(fraction.slice(0, 3), 10);
  const baseMillis = Date.parse(`${match[1]}.${String(millis).padStart(3, '0')}Z`);
  if (Number.isNaN(baseMillis)) return null;
  const canonical = new Date(baseMillis).toISOString();
  if (canonical.slice(0, 19) !== match[1]) return null;
  return BigInt(baseMillis) * 1000n + BigInt(fraction.slice(3));
}

function bigintToBase36(value: bigint): string {
  if (value === 0n) return '0';
  const negative = value < 0n;
  let remainder = negative ? -value : value;
  let result = '';
  while (remainder > 0n) {
    const digit = Number(remainder % 36n);
    result = '0123456789abcdefghijklmnopqrstuvwxyz'[digit]! + result;
    remainder /= 36n;
  }
  return negative ? '-' + result : result;
}

function base36ToBigint(value: string): bigint | null {
  if (!/^-?[0-9a-z]+$/.test(value)) return null;
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  let result = 0n;
  for (const character of digits) {
    const digit = BigInt('0123456789abcdefghijklmnopqrstuvwxyz'.indexOf(character));
    if (digit < 0n || digit >= 36n) return null;
    result = result * 36n + digit;
  }
  return negative ? -result : result;
}

function adminCursorTimestampFromMicros(micros: bigint): string | null {
  let millis = micros / 1000n;
  let remainder = micros % 1000n;
  if (remainder < 0n) {
    millis -= 1n;
    remainder += 1000n;
  }
  const date = new Date(Number(millis));
  if (Number.isNaN(date.getTime()) || !Number.isSafeInteger(Number(millis))) return null;
  return `${date.toISOString().slice(0, -1)}${String(remainder).padStart(3, '0')}Z`;
}

/**
 * Sort cursors carry the exact ordering they were minted for. Replaying one
 * after changing sort is rejected instead of treating a timestamp from a
 * different column as a valid page boundary.
 */
export function encodeAdminResourceListSortCursor(
  cursor: AdminResourceListSortCursor,
): string {
  const sortCode: Record<AdminResourceListSort, string> = {
    'createdAt:asc': 'cA',
    'createdAt:desc': 'cD',
    'updatedAt:asc': 'uA',
    'updatedAt:desc': 'uD',
  };
  const micros = adminCursorMicros(cursor.timestamp);
  if (micros === null) throw new Error('sortable cursor timestamp is invalid');
  const payload = [
    bigintToBase36(micros),
    encodeURIComponent(cursor.id),
    sortCode[cursor.sort],
    cursor.direction === 'prev' ? 'p' : 'n',
  ].join('|');
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Strictly decode a canonical sort-bound resource-list cursor. */
export function decodeAdminResourceListSortCursor(
  raw: string,
  maxLen = LIST_CURSOR_MAX_LEN,
): AdminResourceListSortCursor | null {
  if (raw.length === 0 || raw.length > maxLen || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) return null;
    const [encodedMillis, encodedId, sortCode, direction, ...extra] = bytes.toString('utf8').split('|');
    const sortByCode: Record<string, AdminResourceListSort> = {
      cA: 'createdAt:asc',
      cD: 'createdAt:desc',
      uA: 'updatedAt:asc',
      uD: 'updatedAt:desc',
    };
    if (
      !encodedMillis || !encodedId || !sortCode || extra.length > 0 ||
      (direction !== 'n' && direction !== 'p') ||
      !sortByCode[sortCode]
    ) return null;
    const id = decodeURIComponent(encodedId);
    if (!id || id.length > 128 || encodeURIComponent(id) !== encodedId) return null;
    const micros = base36ToBigint(encodedMillis);
    if (micros === null || bigintToBase36(micros) !== encodedMillis) return null;
    const timestamp = adminCursorTimestampFromMicros(micros);
    if (!timestamp) return null;
    return {
      timestamp,
      id,
      direction: direction === 'p' ? 'prev' : 'next',
      sort: sortByCode[sortCode]!,
    };
  } catch {
    return null;
  }
}

export const AdminResourceListSortSchema = z.enum(ADMIN_RESOURCE_LIST_SORT_VALUES);

export const ADMIN_BUSINESS_LIST_QUERY_PARAMS = ['limit', 'cursor', 'sort'] as const;
export type AdminBusinessListQueryParam = (typeof ADMIN_BUSINESS_LIST_QUERY_PARAMS)[number];
export const AdminBusinessListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ADMIN_LIST_LIMIT_MAX).default(ADMIN_LIST_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(LIST_CURSOR_MAX_LEN).optional(),
  sort: AdminResourceListSortSchema.default(ADMIN_RESOURCE_LIST_SORT_DEFAULT),
}).strict();

export const ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS = ['limit', 'cursor', 'sort'] as const;
export type AdminBusinessVersionListQueryParam = (typeof ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS)[number];
export const AdminBusinessVersionListQuerySchema = AdminBusinessListQuerySchema;

/* ------------------------------------------------------------------ */
/* Admin audit list — GET /api/v1/admin/audit                         */
/* ------------------------------------------------------------------ */

export const ADMIN_AUDIT_LIST_QUERY_PARAMS = [
  'tenantId',
  'limit',
  'cursor',
  'severity',
  'action',
  'actor',
  'resource',
  'from',
  'to',
  'sort',
] as const;
export type AdminAuditListQueryParam = (typeof ADMIN_AUDIT_LIST_QUERY_PARAMS)[number];

/**
 * Audit sort is a SUBSET of ADMIN_RESOURCE_LIST_SORT_VALUES, not a copy of it:
 * admin_audit_events (migration 0010) has created_at and no updated_at, so an
 * `updatedAt:*` value on this route would name a column the table does not
 * have. The cursor codec is shared, so these values still encode and decode
 * through encode/decodeAdminResourceListSortCursor unchanged.
 */
export const ADMIN_AUDIT_LIST_SORT_VALUES = [
  'createdAt:asc',
  'createdAt:desc',
] as const;
export const ADMIN_AUDIT_LIST_SORT_DEFAULT = 'createdAt:desc' as const;
export type AdminAuditListSort = (typeof ADMIN_AUDIT_LIST_SORT_VALUES)[number];
export const AdminAuditListSortSchema = z.enum(ADMIN_AUDIT_LIST_SORT_VALUES);

/**
 * Half-open-free instant bound: a UTC ISO-8601 second, with optional micros.
 * Anchored on Z so a local-time string can never be silently reinterpreted
 * as UTC, which is what a ledger time filter must not do.
 */
export const ADMIN_LIST_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * True only for an instant that is BOTH shaped like the pattern AND a real
 * point on the calendar: Date.parse happily rolls 2026-02-30T00:00:00Z over
 * into March, so the parsed value is compared back against the input prefix.
 */
export function isAdminListTimeBound(value: string): boolean {
  if (!ADMIN_LIST_TIME_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Severity bucket written by the ledger (see migrations/0010). */
export const AUDIT_SEVERITY_VALUES = ['info', 'success', 'warning', 'error'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITY_VALUES)[number];
export const AuditSeveritySchema = z.enum(AUDIT_SEVERITY_VALUES);

export const AdminAuditListQuerySchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(ADMIN_LIST_LIMIT_MAX).default(ADMIN_LIST_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(LIST_CURSOR_MAX_LEN).optional(),
    severity: AuditSeveritySchema.optional(),
    action: z.string().regex(OPERATIONS_LIST_TOKEN_PATTERN).optional(),
    actor: z.string().regex(OPERATIONS_LIST_TOKEN_PATTERN).optional(),
    resource: z.string().regex(OPERATIONS_LIST_TOKEN_PATTERN).optional(),
    from: z.string().regex(ADMIN_LIST_TIME_PATTERN).optional(),
    to: z.string().regex(ADMIN_LIST_TIME_PATTERN).optional(),
    sort: AdminAuditListSortSchema.default(ADMIN_AUDIT_LIST_SORT_DEFAULT),
  })
  .strict();
export type AdminAuditListQuery = z.infer<typeof AdminAuditListQuerySchema>;

export const AdminAuditPageSchema = ListPageBaseSchema.extend({
  items: z.array(z.record(z.unknown())),
})
  .strict();
export type AdminAuditPage = ListPageBase;

/* ------------------------------------------------------------------ */
/* Admin API-key list — GET /api/v1/admin/api-keys                    */
/* ------------------------------------------------------------------ */

export const API_KEY_LIST_QUERY_PARAMS = [
  'tenantId',
  'limit',
  'cursor',
  'status',
  'prefix',
  'sort',
] as const;
export type ApiKeyListQueryParam = (typeof API_KEY_LIST_QUERY_PARAMS)[number];

/** Key lifecycle states (api-key-view-models ApiKeyStatus). */
export const API_KEY_STATUS_VALUES = ['ACTIVE', 'REVOKING', 'REVOKED'] as const;
export type ApiKeyStatusValue = (typeof API_KEY_STATUS_VALUES)[number];
export const ApiKeyStatusValueSchema = z.enum(API_KEY_STATUS_VALUES);

export const ApiKeyListQuerySchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(ADMIN_LIST_LIMIT_MAX).default(ADMIN_LIST_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(LIST_CURSOR_MAX_LEN).optional(),
    status: ApiKeyStatusValueSchema.optional(),
    prefix: z.string().regex(OPERATIONS_LIST_TOKEN_PATTERN).optional(),
    sort: AdminResourceListSortSchema.default(ADMIN_RESOURCE_LIST_SORT_DEFAULT),
  })
  .strict();
export type ApiKeyListQuery = z.infer<typeof ApiKeyListQuerySchema>;

/**
 * Grants ride alongside the page because the shell's key pane needs them; the
 * five page fields themselves are inherited from ListPageBaseSchema, so they
 * cannot drift from the other admin lists. The raw key is never on the wire —
 * only the stored prefix, which is why `prefix` is a safe search term.
 */
export const AdminApiKeysPageSchema = ListPageBaseSchema.extend({
  grants: z.array(z.record(z.unknown())),
  createCopyOnce: z.record(z.unknown()).nullable(),
})
  .strict();
export type AdminApiKeysPage = ListPageBase & {
  grants: Array<Record<string, unknown>>;
  createCopyOnce: Record<string, unknown> | null;
};

/* ------------------------------------------------------------------ */
/* Admin tenant list — GET /api/v1/admin/tenants                      */
/* ------------------------------------------------------------------ */

/**
 * The tenant roster is ordered by NAME, not by a timestamp: its only consumer
 * is the tenant picker, and a picker that is not alphabetical is unusable.
 * The shared `AdminResourceListSort` vocabulary is created_at/updated_at only,
 * and `tenants` (migration 0001) has no updated_at column at all, so this list
 * exposes no `sort` parameter — the order is fixed by the endpoint as
 * `(lower(name), id)`. The keyset cursor therefore cannot be the shared
 * timestamp dialect (encodeListCursor / encodeAdminResourceListSortCursor,
 * which encode a micros instant); the tenant module carries a small
 * id+direction token bounded by LIST_CURSOR_MAX_LEN instead.
 */
export const TENANT_LIST_QUERY_PARAMS = ['limit', 'cursor'] as const;
export type TenantListQueryParam = (typeof TENANT_LIST_QUERY_PARAMS)[number];

/** One roster row; the full wire item (nothing else is projected). */
export const AdminTenantSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    state: z.string(),
  })
  .strict();
export type AdminTenant = z.infer<typeof AdminTenantSchema>;

export const AdminTenantsPageSchema = ListPageBaseSchema.extend({
  items: z.array(AdminTenantSchema),
}).strict();
export type AdminTenantsPage = ListPageBase & { items: AdminTenant[] };

/** Builds any admin list page so no producer can drop a page field by hand. */
export function listPage<T>(input: {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
}): ListPageBase {
  return {
    items: input.items as unknown as ListPageBase['items'],
    nextCursor: input.nextCursor,
    prevCursor: input.prevCursor,
    total: input.total,
    limit: input.limit,
  };
}
/* ------------------------------------------------------------------ */
/* Submission response                                                 */
/* ------------------------------------------------------------------ */

export const SubmitAckSchema = z.object({
  operationId: z.string().uuid(),
  state: OperationStateSchema,
  stateVersion: z.number().int().min(0),
  /** true when an idempotent replay returned an existing operation (200 vs 202). */
  replayed: z.boolean().default(false),
  correlationId: z.string(),
  links: z.object({
    self: z.string(),
    result: z.string(),
  }),
});
export type SubmitAck = z.infer<typeof SubmitAckSchema>;

/* ------------------------------------------------------------------ */
/* Webhook (docs 06): at-least-once, signed, dedup by deliveryId       */
/* ------------------------------------------------------------------ */

export const WebhookEventTypes = [
  'operation.succeeded',
  'operation.failed',
  'operation.cancelled',
  'operation.timed-out',
] as const;
export type WebhookEventType = (typeof WebhookEventTypes)[number];

export const WebhookPayloadSchema = z
  .object({
    deliveryId: z.string().min(1),
    eventType: z.enum(WebhookEventTypes),
    operationId: z.string().uuid(),
    state: OperationStateSchema,
    stateVersion: z.number().int().min(0),
    occurredAt: z.string(),
  })
  .strict();
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

/** Webhook signature scheme: HMAC-SHA256 over `{timestamp}.{body}`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-du-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-du-timestamp';
export const WEBHOOK_DELIVERY_HEADER = 'x-du-delivery-id';

export function webhookSigningPayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/* ------------------------------------------------------------------ */
/* Artifact metadata (public GET /artifacts/{id})                      */
/* ------------------------------------------------------------------ */

export const ArtifactState = ['STAGING', 'READY', 'EXPIRED', 'DELETED'] as const;
export type ArtifactState = (typeof ArtifactState)[number];
export const ArtifactStateSchema = z.enum(ArtifactState);

export const ArtifactMetadataSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  operationId: z.string().uuid().nullable().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  state: ArtifactStateSchema,
  fileName: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string().nullable().optional(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

/* ------------------------------------------------------------------ */
/* Business catalog (public GET /businesses)                           */
/* ------------------------------------------------------------------ */

export const PublicBusinessActionSchema = z.object({
  businessId: z.string(),
  version: z.string(),
  action: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  capabilities: z.object({ cancel: z.boolean(), resume: z.boolean() }),
  artifactPolicy: z.object({
    minFiles: z.number().int(),
    maxFiles: z.number().int(),
    acceptedMimeTypes: z.array(z.string()).optional(),
  }),
});
export type PublicBusinessAction = z.infer<typeof PublicBusinessActionSchema>;
