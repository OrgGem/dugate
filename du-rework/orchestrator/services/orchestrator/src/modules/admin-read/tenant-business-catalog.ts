import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  TENANT_BUSINESS_CATALOG_CURSOR_MAX_LEN,
  TENANT_BUSINESS_CATALOG_QUERY_PARAMS,
  TenantBusinessCatalogQuerySchema,
  isAdminListTimeBound,
  type AdminResourceListSort,
} from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';

const CURSOR_VERSION = 1;
const CURSOR_API_VERSION = 'tenant-business-catalog-v1';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface TenantBusinessCatalogQuery {
  limit: number;
  cursor: string | null;
  sort: AdminResourceListSort;
  q: string | null;
}

interface TenantBusinessCatalogCursor {
  direction: 'next' | 'prev';
  timestamp: string;
  businessId: string;
}

export interface TenantBusinessCatalogDbRow extends Record<string, unknown> {
  business_id: string;
  enabled: boolean;
  lifecycle_revision: number | string;
  latest_version: string | null;
  latest_status: string | null;
  active_version: string | null;
  version_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  created_at_cursor: string;
  updated_at_cursor: string;
}

export interface TenantBusinessCatalogPage {
  rows: TenantBusinessCatalogDbRow[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
}

function invalidQuery(message = 'invalid tenant business catalog query'): HttpError {
  return new HttpError(400, 'INVALID_ARGUMENT', message);
}

export function parseTenantBusinessCatalogQuery(params: URLSearchParams): TenantBusinessCatalogQuery {
  const allowed = new Set<string>(TENANT_BUSINESS_CATALOG_QUERY_PARAMS);
  let unsupported = false;
  params.forEach((_value, name) => {
    if (!allowed.has(name)) unsupported = true;
  });
  if (unsupported) throw invalidQuery('unsupported tenant business catalog query parameter');

  const input: Record<string, string> = {};
  for (const name of TENANT_BUSINESS_CATALOG_QUERY_PARAMS) {
    const values = params.getAll(name);
    if (values.length > 1) throw invalidQuery(`${name} must not be repeated`);
    if (values.length === 1) input[name] = values[0]!;
  }

  const parsed = TenantBusinessCatalogQuerySchema.safeParse(input);
  if (!parsed.success) throw invalidQuery('tenant business catalog query validation failed');

  const normalized = parsed.data.q?.normalize('NFKC').trim().toLowerCase() ?? '';
  if (CONTROL_CHARACTERS.test(normalized) || normalized.length > 128) {
    throw invalidQuery('q is not an accepted prefix filter');
  }

  return {
    limit: parsed.data.limit,
    cursor: parsed.data.cursor ?? null,
    sort: parsed.data.sort,
    q: normalized || null,
  };
}

function cursorMac(
  secret: string,
  tenantId: string,
  query: Pick<TenantBusinessCatalogQuery, 'q' | 'sort'>,
  payload: string,
): Buffer {
  const context = JSON.stringify([CURSOR_API_VERSION, tenantId, query.q, query.sort, payload]);
  return createHmac('sha256', secret).update(context, 'utf8').digest();
}

function encodeCursor(
  cursor: TenantBusinessCatalogCursor,
  secret: string,
  tenantId: string,
  query: Pick<TenantBusinessCatalogQuery, 'q' | 'sort'>,
): string {
  const payload = Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    d: cursor.direction,
    t: cursor.timestamp,
    i: cursor.businessId,
  }), 'utf8').toString('base64url');
  const signature = cursorMac(secret, tenantId, query, payload).toString('base64url');
  return `${payload}.${signature}`;
}

function invalidCursor(): HttpError {
  return invalidQuery('cursor is malformed or does not match this tenant, filter, or sort');
}

function decodeCursor(
  raw: string | null,
  secret: string,
  tenantId: string,
  query: Pick<TenantBusinessCatalogQuery, 'q' | 'sort'>,
): TenantBusinessCatalogCursor | null {
  if (raw === null) return null;
  if (raw.length === 0 || raw.length > TENANT_BUSINESS_CATALOG_CURSOR_MAX_LEN) throw invalidCursor();
  const pieces = raw.split('.');
  if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(pieces[0]!) || !/^[A-Za-z0-9_-]+$/.test(pieces[1]!)) {
    throw invalidCursor();
  }

  try {
    const payloadBytes = Buffer.from(pieces[0]!, 'base64url');
    const signatureBytes = Buffer.from(pieces[1]!, 'base64url');
    if (payloadBytes.toString('base64url') !== pieces[0] || signatureBytes.toString('base64url') !== pieces[1]) {
      throw invalidCursor();
    }
    const expected = cursorMac(secret, tenantId, query, pieces[0]!);
    if (signatureBytes.length !== expected.length || !timingSafeEqual(signatureBytes, expected)) throw invalidCursor();

    const value = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4 ||
      value['v'] !== CURSOR_VERSION ||
      (value['d'] !== 'next' && value['d'] !== 'prev') ||
      typeof value['t'] !== 'string' ||
      !isAdminListTimeBound(value['t']) ||
      typeof value['i'] !== 'string' ||
      value['i'].length === 0 ||
      CONTROL_CHARACTERS.test(value['i'])
    ) {
      throw invalidCursor();
    }
    return { direction: value['d'], timestamp: value['t'], businessId: value['i'] };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidCursor();
  }
}

export async function listTenantBusinessCatalogPage(input: {
  db: Db;
  tenantId: string;
  query: TenantBusinessCatalogQuery;
  cursorSecret: string;
}): Promise<TenantBusinessCatalogPage> {
  if (!input.cursorSecret) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'tenant business catalog cursor signing is unavailable');

  const cursor = decodeCursor(input.query.cursor, input.cursorSecret, input.tenantId, input.query);

  const tenant = await input.db.query<{ id: string }>(
    'SELECT id FROM tenants WHERE id = $1::uuid LIMIT 1',
    [input.tenantId],
  );
  if (!tenant.rowCount) throw new HttpError(404, 'NOT_FOUND', 'tenant not found');
  const filterParams: unknown[] = [input.tenantId];
  const clauses = ['c.owner_tenant_id = $1::uuid'];
  if (input.query.q !== null) {
    filterParams.push(input.query.q);
    // business_catalog currently has no approved display-name column, so the
    // documented fallback is used and the prefix match is over business_id.
    clauses.push(`left(lower(c.business_id), char_length($${filterParams.length}::text)) = $${filterParams.length}::text`);
  }
  const where = clauses.join(' AND ');

  const countResult = await input.db.query<{ total: number | string }>(
    `SELECT count(*)::int AS total FROM business_catalog c WHERE ${where}`,
    filterParams,
  );

  const sortField = input.query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at';
  const sortColumn = `c.${sortField}`;
  const sortDirection = input.query.sort.endsWith(':asc') ? 'ASC' : 'DESC';
  const backwards = cursor?.direction === 'prev';
  const scanDirection = backwards ? (sortDirection === 'ASC' ? 'DESC' : 'ASC') : sortDirection;

  const pageParams = [...filterParams];
  let cursorClause = '';
  if (cursor) {
    pageParams.push(cursor.timestamp, cursor.businessId);
    const comparison = (sortDirection === 'DESC') !== backwards ? '<' : '>';
    cursorClause = ` AND (${sortColumn}, c.business_id) ${comparison} ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::text)`;
  }
  pageParams.push(input.query.limit + 1);

  const pageResult = await input.db.query<TenantBusinessCatalogDbRow>(
    `SELECT c.business_id,
            c.enabled,
            c.lifecycle_revision,
            latest.latest_version,
            latest.latest_status,
            active.active_version,
            versions.version_count,
            c.created_at,
            c.updated_at,
            to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
            to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor
     FROM business_catalog c
     LEFT JOIN LATERAL (
       SELECT version AS latest_version, status AS latest_status
       FROM business_versions
       WHERE business_id = c.business_id
       ORDER BY created_at DESC, version DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT version AS active_version
       FROM business_versions
       WHERE business_id = c.business_id AND is_active = true
       ORDER BY version DESC
       LIMIT 1
     ) active ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS version_count
       FROM business_versions
       WHERE business_id = c.business_id
     ) versions ON true
     WHERE ${where}${cursorClause}
     ORDER BY ${sortColumn} ${scanDirection}, c.business_id ${scanDirection}
     LIMIT $${pageParams.length}`,
    pageParams,
  );

  const rawRows = pageResult.rows;
  const hasMore = rawRows.length > input.query.limit;
  const window = hasMore ? rawRows.slice(0, input.query.limit) : rawRows;
  const rows = (backwards ? window.slice().reverse() : window) as TenantBusinessCatalogDbRow[];
  const first = rows[0];
  const last = rows[rows.length - 1];
  const timestampKey = sortField === 'created_at' ? 'created_at_cursor' : 'updated_at_cursor';
  const cursorFor = (row: TenantBusinessCatalogDbRow, direction: 'next' | 'prev'): string => encodeCursor({
    direction,
    timestamp: row[timestampKey],
    businessId: row.business_id,
  }, input.cursorSecret, input.tenantId, input.query);

  const nextCursor = (backwards ? input.query.cursor !== null : hasMore) && last
    ? cursorFor(last, 'next')
    : null;
  const prevCursor = (backwards ? hasMore : input.query.cursor !== null) && first
    ? cursorFor(first, 'prev')
    : null;

  return {
    rows,
    nextCursor,
    prevCursor,
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}
