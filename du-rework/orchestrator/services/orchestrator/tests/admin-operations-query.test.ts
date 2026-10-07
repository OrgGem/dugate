import {
  fetchOperationDetail,
  clampListLimit,
  OPERATION_LIST_DEFAULT_LIMIT,
  OPERATION_LIST_MAX_LIMIT,
  OPERATION_LIST_CURSOR_MAX_LEN,
} from '../src/app/admin/operation-section-data';
import type { OperationDetailCatalogEntry } from '../src/app/admin/operation-section-data';
import { renderOperationSection } from '../src/app/admin/operation-section-renderer';
import { parseOperationListQuery, parseQueryString } from '../src/app/admin/shell-router';
import { wrapTablesForReflow } from '../src/app/admin/shell-render';
import { route, parseOperationsListQuery, type RouteContext } from '../src/server';
import type { QueryResult, QueryResultRow } from 'pg';
import type { OperationDetail } from '@du/contracts';
import { OPERATIONS_LIST_QUERY_PARAMS, OPERATIONS_LIST_SORT_VALUES, isOperationsListFilterToken } from '@du/contracts';
import { off, makeOp, catalogEntry, catalogOf, jsonResponse, recordingFetch } from './helpers/operations-page-fixture';



// ---------------------------------------------------------------------------
// clampListLimit
// ---------------------------------------------------------------------------

describe('W-ADMUX-01: clampListLimit', () => {
  it('defaults, clamps, truncates, and survives garbage', () => {
    expect(clampListLimit(undefined)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(null)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit('abc')).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(NaN)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit('-5')).toBe(1);
    expect(clampListLimit(999)).toBe(OPERATION_LIST_MAX_LIMIT);
    expect(clampListLimit('37')).toBe(37);
    expect(clampListLimit(49.7)).toBe(49);
  });
});



// ---------------------------------------------------------------------------
// parseOperationListQuery (shell router)
// ---------------------------------------------------------------------------

describe('W-ADMUX-01: parseOperationListQuery', () => {
  it('applies defaults when params are absent or malformed', () => {
    const allOff = { state: 'ALL', tenant: null, idContains: null };
    expect(parseOperationListQuery(undefined)).toEqual({ limit: 20, cursor: null, stateFilter: undefined, tenantFilter: undefined, idFilter: undefined, listFilters: allOff });
    expect(parseOperationListQuery({})).toEqual({ limit: 20, cursor: null, stateFilter: undefined, tenantFilter: undefined, idFilter: undefined, listFilters: allOff });
    expect(parseOperationListQuery({ limit: 'abc', cursor: '' })).toEqual({ limit: 20, cursor: null, stateFilter: undefined, tenantFilter: undefined, idFilter: undefined, listFilters: allOff });
  });

  it('clamps limit to the server range 1..100', () => {
    expect(parseOperationListQuery({ limit: '0' }).limit).toBe(1);
    expect(parseOperationListQuery({ limit: '1000000' }).limit).toBe(OPERATION_LIST_MAX_LIMIT);
    expect(parseOperationListQuery({ limit: '50' }).limit).toBe(50);
  });

  it('bounds opaque cursors to OPERATION_LIST_CURSOR_MAX_LEN characters', () => {
    const long = 'c'.repeat(500);
    const parsed = parseOperationListQuery({ cursor: long });
    expect(parsed.cursor).toBe('c'.repeat(OPERATION_LIST_CURSOR_MAX_LEN));
    expect(parsed.cursor!.length).toBe(OPERATION_LIST_CURSOR_MAX_LEN);
  });
});



// ---------------------------------------------------------------------------
// Catalog (offline) pagination
// ---------------------------------------------------------------------------

describe('W-ADMUX-01: catalog list pagination (offline, exact total)', () => {
  it('page 1 of a 45-entry catalog: limit-sized page, exact total, real next cursor', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: catalogOf(45),
      listLimit: 20,
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.rows.length).toBe(20);
    expect(r.rows[0]!.id).toBe('op-000');
    expect(r.total).toBe(45);
    expect(r.nextCursor).toBe(off(20));
    expect(r.prevCursor).toBe(null);
    expect(r.cursor).toBe(null);
    expect(r.limit).toBe(20);
  });

  it('middle page carries both prev and next cursors', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: catalogOf(45),
      listLimit: 20,
      cursor: off(20),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.rows.length).toBe(20);
    expect(r.rows[0]!.id).toBe('op-020');
    expect(r.total).toBe(45);
    expect(r.prevCursor).toBe(off(0));
    expect(r.nextCursor).toBe(off(40));
    expect(r.cursor).toBe(off(20));
  });

  it('last page is partial: no next cursor, exact total still reported', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: catalogOf(45),
      listLimit: 20,
      cursor: off(40),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.rows.length).toBe(5);
    expect(r.total).toBe(45);
    expect(r.nextCursor).toBe(null);
    expect(r.prevCursor).toBe(off(20));
  });

  it('unknown/garbage cursor falls back to the first page (never an empty population)', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: catalogOf(3),
      cursor: '<bad>',
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.rows.length).toBe(3);
    expect(r.total).toBe(3);
    expect(r.nextCursor).toBe(null);
  });
});



// ---------------------------------------------------------------------------
// Live list envelope mapping
// ---------------------------------------------------------------------------

describe('W-ADMUX-01: live list fetch (injected fetchImpl, no sockets)', () => {
  it('partial page: rows < limit ⇒ exact total, next disabled as end', async () => {
    const cap = { urls: [] as string[] };
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      fetchImpl: recordingFetch({ rows: [makeOp('op-a')], total: 1, limit: 20 }, cap),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.rows.map((x) => x.id)).toEqual(['op-a']);
    expect(r.total).toBe(1);
    expect(r.nextCursor).toBe(null);
    expect(cap.urls[0]).toContain('limit=20');
    expect(cap.urls[0]).not.toContain('cursor=');
  });

  it('W-ADMUX02-SRV-1: a full page with no server count ⇒ total unknown, never fabricated', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      listLimit: 2,
      fetchImpl: recordingFetch({ rows: [makeOp('op-a'), makeOp('op-b')], limit: 2 }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.total).toBe(null);
    expect(r.rows.length).toBe(2);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-list-total="unknown"');
    expect(out.html).toContain('data-pagination-next="disabled"');
    expect(out.html).toContain('data-pagination-cursor-unavailable="true"');
    // W-ADMUX02-COPY-2: the note must state the limit and the way out. It must
    // NOT claim more rows are known to exist (we cannot know that without a
    // count) and must NOT promise the cursor contract as future work.
    expect(out.html).toContain('no continuation cursor');
    expect(out.html).toContain('narrow the filters or raise the page size');
    expect(out.html).not.toContain('ADM-UX-02');
    expect(out.html).not.toContain('More operations exist beyond this page');
  });

  it('W-ADMUX02-SRV-1: a server count on a full page is a population count, surfaced verbatim', async () => {
    // The ADM-UX-02 contract makes `total` a COUNT of the filtered
    // population, so a count equal to the page size is a real "these are all
    // of them", not an echo to second-guess.
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      listLimit: 2,
      fetchImpl: recordingFetch({ rows: [makeOp('op-a'), makeOp('op-b')], total: 2, limit: 2 }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.total).toBe(2);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-list-total="2"');
  });

  it('W-ADMUX02-SRV-1: a count that under-reports the rows in hand never shrinks the total', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      listLimit: 5,
      fetchImpl: recordingFetch({
        items: [makeOp('op-a'), makeOp('op-b'), makeOp('op-c')],
        total: 0,
        limit: 5,
      }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.total).toBe(3);
  });

  it('server asserting a larger total than the page holds ⇒ total surfaced', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      listLimit: 2,
      fetchImpl: recordingFetch({ rows: [makeOp('op-a'), makeOp('op-b')], total: 137, limit: 2 }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.total).toBe(137);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-list-total="137"');
    expect(out.html).toContain('2 of 137 operations');
  });

  it('ADM-UX-02 forward shape {items, nextCursor} ⇒ Next link carries the cursor', async () => {
    const cap = { urls: [] as string[] };
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      listLimit: 50,
      cursor: off(20),
      fetchImpl: recordingFetch(
        { items: [makeOp('op-x'), makeOp('op-y')], nextCursor: 'tok-2', prevCursor: off(20) },
        cap,
      ),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.nextCursor).toBe('tok-2');
    expect(r.cursor).toBe(off(20));
    // Requested page size + cursor go to the server as query params.
    const url = new URL(cap.urls[0]!);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('cursor')).toBe(off(20));
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-pagination-next="link"');
    expect(out.html).toContain('href="/admin/operations?limit=50&amp;cursor=tok-2"');
    // Prev link deep-links back to THIS page's cursor, not page 1.
    expect(out.html).toContain('data-pagination-prev="link"');
    expect(out.html).toContain('href="/admin/operations?limit=50&amp;cursor=off%3Ak"');
  });

  it('malformed rows are dropped, not rendered as placeholders', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      fetchImpl: recordingFetch({
        rows: [makeOp('op-ok'), { nope: true }, makeOp(''), null],
        total: 4,
        limit: 20,
      }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.rows.map((x) => x.id)).toEqual(['op-ok']);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-operation-row="op-ok"');
    expect(out.html).not.toContain('data-operation-row=""');
  });

  it('payload without rows/items collapses to a sanitized error, not an empty list', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      fetchImpl: recordingFetch({ unexpected: 'shape' }),
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.message).toContain('rows/items');
  });

  it('explicitly empty population renders as data (0 rows), not as unavailable', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      fetchImpl: recordingFetch({ rows: [], total: 0, limit: 20 }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.total).toBe(0);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-empty-banner="true"');
    expect(out.html).toContain('data-list-count="exact"');
  });
});



// ---------------------------------------------------------------------------
// W-ADMUX-03-FILTER-1 — state / tenant / id filters, chips, deep links
// ---------------------------------------------------------------------------

describe('W-ADMUX-03: parseOperationListQuery filter trio', () => {
  it('carries raw values through and echoes the sanitized set', () => {
    const q = parseOperationListQuery({ state: 'failed', tenant: 'tenant-a', id: 'ab12' });
    expect(q.stateFilter).toBe('failed');
    expect(q.tenantFilter).toBe('tenant-a');
    expect(q.idFilter).toBe('ab12');
    expect(q.listFilters).toEqual({ state: 'FAILED', tenant: 'tenant-a', idContains: 'ab12' });
  });

  it('invalid state does not leak into the echo (falls back to ALL; raw stays for the fetcher to report)', () => {
    const q = parseOperationListQuery({ state: 'running; DROP' });
    expect(q.listFilters.state).toBe('ALL');
    expect(q.stateFilter).toBe('running; DROP');
  });
});



describe('W-ADMUX-03: envelope filtering (catalog, offline)', () => {
  const MIXED: OperationDetailCatalogEntry[] = [
    catalogEntry(makeOp('op-acc', { state: 'ACCEPTED' as OperationDetail['state'] })),
    catalogEntry(makeOp('op-run', { state: 'RUNNING' })),
    catalogEntry(makeOp('op-wait', { state: 'WAITING_INPUT' })),
    catalogEntry(makeOp('op-succ', { state: 'SUCCEEDED' })),
    catalogEntry(makeOp('op-fail', { state: 'FAILED' })),
    catalogEntry(makeOp('op-canc', { state: 'CANCELLED' })),
    catalogEntry(makeOp('op-tout', { state: 'TIMED_OUT' })),
  ];

  async function fetchList(extra: { stateFilter?: string; tenantFilter?: string; idFilter?: string }, entries = MIXED) {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: { entries },
      ...extra,
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    return r;
  }

  it('RUNNING chip matches the whole attention group, not just RUNNING', async () => {
    const r = await fetchList({ stateFilter: 'RUNNING' });
    expect(r.rows.map((x) => x.id).sort()).toEqual(['op-acc', 'op-run', 'op-wait']);
    expect(r.filters.state).toBe('RUNNING');
    // W-ADMUX02-SRV-1: the catalog filters the population BEFORE paging (the
    // server's order), so the page holds only matches and `total` is the
    // filtered population, not the fixture size.
    expect(r.pageRows).toBe(3);
    expect(r.total).toBe(3);
    expect(r.ignoredFilters).toEqual([]);
  });

  it('COMPLETED is the SUCCEEDED display label; CANCELLED lives only under ALL', async () => {
    const r = await fetchList({ stateFilter: 'COMPLETED' });
    expect(r.rows.map((x) => x.id)).toEqual(['op-succ']);
    const all = await fetchList({});
    expect(all.rows.map((x) => x.id)).toContain('op-canc');
  });

  it('invalid state enum is dropped and named in ignoredFilters (never echoed)', async () => {
    const r = await fetchList({ stateFilter: 'BROGUS<img>' });
    expect(r.filters.state).toBe('ALL');
    expect(r.ignoredFilters).toEqual(['state']);
    expect(JSON.stringify(r)).not.toContain('BROGUS');
  });

  it('tenant filter is exact-match on the wire row', async () => {
    const entries = [
      catalogEntry(makeOp('op-a1', { tenantId: 'tenant-a' })),
      catalogEntry(makeOp('op-a2', { tenantId: 'tenant-a' })),
      catalogEntry(makeOp('op-b1', { tenantId: 'tenant-b' })),
    ];
    const r = await fetchList({ tenantFilter: 'tenant-b' }, entries);
    expect(r.rows.map((x) => x.id)).toEqual(['op-b1']);
  });

  it('id filter is a case-insensitive substring', async () => {
    const r = await fetchList({ idFilter: 'SUCC' });
    expect(r.rows.map((x) => x.id)).toEqual(['op-succ']);
  });

  it('pasted raw key material (32+ solid hex) is rejected, not searched or echoed', async () => {
    const secret = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead';
    const r = await fetchList({ idFilter: secret });
    expect(r.filters.idContains).toBe(null);
    expect(r.ignoredFilters).toEqual(['id']);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).not.toContain('deadbeef');
    expect(out.html).toContain('data-filter-rejected="id"');
  });

  it('combined filters intersect (state AND tenant AND id)', async () => {
    const entries = [
      catalogEntry(makeOp('op-x1', { state: 'RUNNING', tenantId: 't-1' })),
      catalogEntry(makeOp('op-x2', { state: 'RUNNING', tenantId: 't-2' })),
      catalogEntry(makeOp('op-x3', { state: 'SUCCEEDED', tenantId: 't-1' })),
    ];
    const r = await fetchList({ stateFilter: 'RUNNING', tenantFilter: 't-1', idFilter: 'x' }, entries);
    expect(r.rows.map((x) => x.id)).toEqual(['op-x1']);
  });
});
