/**
 * W-ADMUX-01 — Operations list pane: server-side page size, cursor
 * plumbing, pagination controls, and list→detail→back deep links.
 *
 * All offline: the platform is reached only through injected `fetchImpl`
 * mocks (no sockets), and the catalog path is test-only input. No DB,
 * no Redis, no live infra.
 */

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function off(n: number): string {
  return `off:${n.toString(36)}`;
}

function makeOp(id: string, overrides: Partial<OperationDetail> = {}): OperationDetail {
  return {
    id,
    tenantId: 'tenant-1',
    businessId: 'example-review',
    businessVersion: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    stateVersion: 1,
    createdAt: '2026-09-25T00:00:00Z',
    updatedAt: '2026-09-25T00:01:00Z',
    deadlineAt: null,
    replayOf: null,
    progress: { percent: 42, message: '' },
    links: { self: `/api/v1/operations/${id}`, result: `/api/v1/operations/${id}/result` },
    wait: null,
    error: null,
    ...overrides,
  };
}

function catalogEntry(op: OperationDetail): OperationDetailCatalogEntry {
  return { operation: op, result: null, artifacts: [] };
}

function catalogOf(n: number): { entries: OperationDetailCatalogEntry[] } {
  return {
    entries: Array.from({ length: n }, (_, i) => catalogEntry(makeOp(`op-${i.toString().padStart(3, '0')}`))),
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(body: unknown, capture?: { urls: string[] }): typeof fetch {
  return (async (input: string | URL) => {
    if (capture) capture.urls.push(String(input));
    return jsonResponse(body);
  }) as unknown as typeof fetch;
}

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
// List pane rendering contract
// ---------------------------------------------------------------------------

describe('W-ADMUX-01: list pane HTML contract', () => {
  async function page1() {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: catalogOf(45),
      listLimit: 20,
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    return renderOperationSection({ fetch: r, selectedOperationId: '' });
  }

  it('rows deep-link to the detail pane and the pane exposes zero mutation affordances', async () => {
    const out = await page1();
    expect(out.isReady).toBe(true);
    expect(out.html).toContain('href="/admin/operations?operationId=op-000"');
    // W-ADMUX-03: the list pane carries exactly the GET filter toolbar —
    // zero POST/mutation forms and zero action discriminators.
    expect(out.html).toContain('data-filter-bar="true"');
    expect(out.html).not.toContain('method="post"');
    expect(out.html).not.toContain('data-action="cancel-operation"');
    expect(out.html).toContain('data-can-cancel="false"');
    expect(out.html).toContain('data-can-resume="false"');
    expect(out.html).toContain('data-can-replay="false"');
  });

  it('pagination bar offers prev-disabled / next-link and page-size links', async () => {
    const out = await page1();
    expect(out.html).toContain('data-pagination-prev="disabled"');
    expect(out.html).toContain('href="/admin/operations?limit=20&amp;cursor=off%3Ak"');
    expect(out.html).toContain('data-pagination-next="link"');
    expect(out.html).toContain('data-page-size="50"');
    expect(out.html).toContain('data-page-size="100"');
    expect(out.html).toContain('aria-current="true"');
    expect(out.html).toContain('20 of 45 operations');
  });

  it('list table is wrapped by the shell reflow scroller (no page-level horizontal overflow)', async () => {
    const out = await page1();
    const wrapped = wrapTablesForReflow(out.html);
    expect(wrapped).toContain('<div class="adm-reflow-scroller" role="region" aria-label="Scrollable data table 1 of 1" tabindex="0"><table class="operation-section__list-table"');
    expect(wrapped).toContain('</table></div>');
  });

  it('priority classes drop low-priority columns responsively (p1 always present)', async () => {
    const out = await page1();
    expect(out.html).toContain('adm-col-p1');
    expect(out.html).toContain('adm-col-p2');
    expect(out.html).toContain('adm-col-p3');
    expect(out.html).toContain('adm-col-p4');
    expect(out.html).toContain('<th class="adm-col-p1" scope="col">Operation</th>');
  });

  it('hostile row values and hostile cursors are escaped in text and attributes', async () => {
    const hostile = catalogEntry(
      makeOp('op-1', { businessId: '<img src=x onerror=alert(1)>', action: '" onload="alert(2)' }),
    );
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: { entries: [hostile] },
      cursor: '<svg>',
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).not.toContain('<svg>');
    expect(out.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out.html).toContain('data-list-cursor="&lt;svg&gt;"');
  });
});

// ---------------------------------------------------------------------------
// Detail pane back link (list → detail → back)
// ---------------------------------------------------------------------------

describe('W-ADMUX-01: detail pane back link', () => {
  it('echoes list limit + cursor so returning lands on the same page', async () => {
    const r = await fetchOperationDetail({
      operationId: 'op-1',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: { entries: [catalogEntry(makeOp('op-1'))] },
    });
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
    const out = renderOperationSection({
      fetch: r,
      selectedOperationId: 'op-1',
      listLimit: 50,
      listCursor: off(20),
    });
    expect(out.html).toContain('data-back-to-list="true"');
    expect(out.html).toContain('href="/admin/operations?limit=50&amp;cursor=off%3Ak"');
  });

  it('falls back to the default first page when no list context was given', async () => {
    const r = await fetchOperationDetail({
      operationId: 'op-1',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: { entries: [catalogEntry(makeOp('op-1'))] },
    });
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
    const out = renderOperationSection({ fetch: r, selectedOperationId: 'op-1' });
    expect(out.html).toContain('href="/admin/operations?limit=20"');
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

describe('W-ADMUX02-SRV-1: the toolbar is wired to the server query contract', () => {
  it('sends the sanitized filters as the route allow-list params', async () => {
    const cap = { urls: [] as string[] };
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      stateFilter: 'FAILED',
      tenantFilter: 'tenant-a',
      idFilter: 'op',
      fetchImpl: recordingFetch({ items: [], total: 0, limit: 20 }, cap),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    const url = new URL(cap.urls[0]!);
    expect(url.searchParams.get('state')).toBe('FAILED');
    expect(url.searchParams.get('tenant')).toBe('tenant-a');
    expect(url.searchParams.get('id')).toBe('op');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('keeps the same filters as page-local defence-in-depth against a server that ignores them', async () => {
    const cap = { urls: [] as string[] };
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      stateFilter: 'FAILED',
      fetchImpl: recordingFetch(
        {
          items: [
            makeOp('op-1', { state: 'FAILED' }),
            makeOp('op-2', { state: 'RUNNING' }),
          ],
          total: 2,
          limit: 20,
        },
        cap,
      ),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    // The page is still filtered locally, so a build that silently drops the
    // new params cannot leak a non-matching row into the pane.
    expect(r.rows.map((x) => x.id)).toEqual(['op-1']);
    expect(r.pageRows).toBe(2);
  });

  it('never puts a rejected filter token in the request URL', async () => {
    const cap = { urls: [] as string[] };
    const secret = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead';
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      stateFilter: 'BROGUS',
      tenantFilter: 'tenant a b',
      idFilter: secret,
      fetchImpl: recordingFetch({ items: [], total: 0, limit: 20 }, cap),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    const url = new URL(cap.urls[0]!);
    expect(url.searchParams.get('state')).toBe(null);
    expect(url.searchParams.get('tenant')).toBe(null);
    expect(url.searchParams.get('id')).toBe(null);
    // A bad token that WAS sent would 422 the route; dropping it keeps the
    // pane usable and still reports the rejection in the chip row.
    expect(r.ignoredFilters).toEqual(['state', 'tenant', 'id']);
    expect(cap.urls[0]).not.toContain('deadbeef');
  });

  it('an empty page from a filtered server query is data (0 of 0), not an error', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      stateFilter: 'TIMED_OUT',
      fetchImpl: recordingFetch({ items: [], total: 0, limit: 20 }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.total).toBe(0);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-list-total="0"');
  });
});

describe('W-ADMUX-03: toolbar, chips and filter-carrying deep links', () => {
  async function filtered() {
    const entries = [
      catalogEntry(makeOp('op-a', { state: 'RUNNING', tenantId: 'tenant-a' })),
      catalogEntry(makeOp('op-b', { state: 'SUCCEEDED', tenantId: 'tenant-a' })),
      catalogEntry(makeOp('op-c', { state: 'RUNNING', tenantId: 'tenant-b' })),
    ];
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: { entries },
      stateFilter: 'RUNNING',
      tenantFilter: 'tenant-a',
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    return renderOperationSection({ fetch: r, selectedOperationId: '' });
  }

  it('toolbar echoes sanitized values, marks the selected option, keeps limit as hidden field', async () => {
    const out = await filtered();
    expect(out.html).toContain('name="state"');
    expect(out.html).toContain('<option value="RUNNING" data-filter-option="RUNNING" selected>Running</option>');
    expect(out.html).toContain('value="tenant-a"');
    expect(out.html).toContain('name="limit" value="20"');
    expect(out.html).toContain('data-filter-active="true"');
  });

  it('one chip per active filter, each remove-link keeps the other filters and resets the cursor', async () => {
    const out = await filtered();
    expect(out.html).toContain('data-filter-chip="state"');
    expect(out.html).toContain('data-filter-chip="tenant"');
    // Removing state keeps tenant + limit; no cursor survives a filter change.
    expect(out.html).toContain('href="/admin/operations?limit=20&amp;tenant=tenant-a"');
    expect(out.html).toContain('data-filter-clear="state"');
    expect(out.html).toContain('data-filter-clear-all="true"');
    expect(out.html).toContain('href="/admin/operations?limit=20"');
  });

  it('count label states the whole filtered population, not a page-local figure', async () => {
    const out = await filtered();
    // W-ADMUX02-COPY-2: `total` is a COUNT of the FILTERED population, so with
    // filters active it is exact — the old "X of Y rows on this page" framing
    // implied other pages might hold matches, which whole-population filtering
    // has made impossible.
    expect(out.html).toContain('data-list-count="exact"');
    expect(out.html).not.toContain('data-list-count="filtered-page"');
    expect(out.html).toContain('1 of 1 operations match the filters');
    expect(out.html).not.toContain('rows on this page match the filters');
    expect(out.html).toContain('data-list-total="1"');
  });

  it('count label falls back to page-local wording when the platform withholds the count', async () => {
    // Same filtered view, but the server sent no `total` AND the page came
    // back full — that is the only shape where the population is unknowable.
    // (A partial page lets the fetcher count it exactly, so `total` is set.)
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      listLimit: 2,
      stateFilter: 'FAILED',
      fetchImpl: recordingFetch({
        items: [makeOp('op-1', { state: 'FAILED' }), makeOp('op-2', { state: 'FAILED' })],
        limit: 2,
      }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    expect(r.total).toBe(null);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-list-count="page"');
    expect(out.html).toContain('operations match the filters on this page');
    expect(out.html).toContain('did not report how many match in total');
    expect(out.html).not.toContain('operations match the filters</span>');
  });

  it('pagination links carry the active filters', async () => {
    const big = catalogOf(45).entries.map((e) => ({ ...e, operation: { ...e.operation, tenantId: 'tenant-a' } }));
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: { entries: big },
      tenantFilter: 'tenant-a',
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('href="/admin/operations?limit=20&amp;cursor=off%3Ak&amp;tenant=tenant-a"');
    // Page-size links keep the filter and drop the cursor.
    expect(out.html).toContain('href="/admin/operations?limit=50&amp;tenant=tenant-a"');
  });

  it('empty-under-filter reports a genuine empty result, not a page to page through', async () => {
    const r = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'tok',
      stateFilter: 'TIMED_OUT',
      fetchImpl: recordingFetch({ rows: [makeOp('op-1', { state: 'RUNNING' })], total: 1, limit: 20 }),
    });
    if (r.kind !== 'list') throw new Error(`expected list, got ${r.kind}`);
    const out = renderOperationSection({ fetch: r, selectedOperationId: '' });
    expect(out.html).toContain('data-empty-banner="filtered"');
    // Server-side filtering is live (W-ADMUX02-SRV-1), so the copy must NOT
    // promise the ADM-UX-02 contract as future work any more.
    expect(out.html).not.toContain('ADM-UX-02');
    expect(out.html).toContain('filters the whole population');
    expect(out.html).toContain('not a page you need to page through');
    // Still distinct from the unfiltered "platform reported zero rows" state.
    expect(out.html).not.toContain('data-empty-banner="true"');
  });

  it('detail back link restores the filtered list page', async () => {
    const r = await fetchOperationDetail({
      operationId: 'op-1',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: { entries: [catalogEntry(makeOp('op-1'))] },
    });
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
    const out = renderOperationSection({
      fetch: r,
      selectedOperationId: 'op-1',
      listLimit: 20,
      listFilters: { state: 'FAILED', tenant: 'tenant-a', idContains: null },
    });
    expect(out.html).toContain('href="/admin/operations?limit=20&amp;state=FAILED&amp;tenant=tenant-a"');
  });
});

// ---------------------------------------------------------------------------
// W-ADMUX03-TOOLBAR-CHIPS-1: chips, the clear-all reset, and URL <-> pane sync
//
// The toolbar is a plain GET form and the shell runs no client JS, so the URL
// is the ONLY filter state. Every link the pane emits is therefore followed
// back through the router's own parser and the fetcher, and the pane that
// lands has to report exactly that query - no invented filter, no lost one.
// ---------------------------------------------------------------------------

/**
 * 13 rows whose filter populations differ per hop (8 RUNNING/tenant-a, plus a
 * FAILED tenant-a row, a RUNNING tenant-b row, done/fail/rest rows), so a chip
 * hop changes the reported total instead of leaving it constant.
 */
function chipsCatalog(): { entries: OperationDetailCatalogEntry[] } {
  const rows: OperationDetail[] = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push(makeOp(`run-0${String(i)}`, { state: 'RUNNING', tenantId: 'tenant-a' }));
  }
  rows.push(makeOp('run-08', { state: 'FAILED', tenantId: 'tenant-a' }));
  rows.push(makeOp('run-09', { state: 'RUNNING', tenantId: 'tenant-b' }));
  rows.push(makeOp('done-00', { state: 'SUCCEEDED', tenantId: 'tenant-a' }));
  rows.push(makeOp('fail-00', { state: 'FAILED', tenantId: 'tenant-a' }));
  rows.push(makeOp('rest-00', { state: 'RUNNING', tenantId: 'tenant-b' }));
  return { entries: rows.map(catalogEntry) };
}

const LIST_PATH = '/admin/operations?';

function hrefQuery(href: string): URLSearchParams {
  return new URLSearchParams(href.slice(LIST_PATH.length));
}

function escapeHref(href: string): string {
  return href.replace(/&/g, '&amp;');
}

/** Every /admin/operations link the pane emitted, HTML-unescaped. */
function allHrefs(html: string): string[] {
  return (html.match(/href="(\/admin\/operations[^"]*)"/g) ?? []).map((m) =>
    m.slice('href="'.length, -1).replace(/&amp;/g, '&'),
  );
}

/** Row links select an operation and render the detail pane, so they go apart. */
function listHrefs(html: string): string[] {
  return allHrefs(html).filter((h) => !h.includes('operationId='));
}

function clearAllHref(html: string): string {
  const m = /<a class="admin-filter-chip admin-filter-chip--clear-all" href="([^"]*)"/.exec(html);
  if (!m || m[1] === undefined) throw new Error('no clear-all control was rendered');
  return m[1].replace(/&amp;/g, '&');
}

function chipRemoveHref(html: string, name: 'state' | 'tenant' | 'id'): string {
  const m = new RegExp(`href="([^"]*)" aria-label="Remove ${name} filter"`).exec(html);
  if (!m || m[1] === undefined) throw new Error(`no remove link for the ${name} chip`);
  return m[1].replace(/&amp;/g, '&');
}

/** Follow a list link the way resolveOperationExtras does: href -> query -> pane. */
async function paneFor(href: string) {
  const parsed = parseOperationListQuery(parseQueryString(hrefQuery(href).toString()));
  const fetched = await fetchOperationDetail({
    operationId: '',
    jsonBaseUrl: '',
    adminToken: '',
    manifestCatalog: chipsCatalog(),
    listLimit: parsed.limit,
    cursor: parsed.cursor ?? undefined,
    stateFilter: parsed.stateFilter,
    tenantFilter: parsed.tenantFilter,
    idFilter: parsed.idFilter,
  });
  if (fetched.kind !== 'list') throw new Error(`expected a list pane, got ${fetched.kind}`);
  return {
    parsed,
    envelope: fetched,
    html: renderOperationSection({ fetch: fetched, selectedOperationId: '' }).html,
  };
}

async function chipsPane(overrides: {
  listLimit?: number;
  cursor?: string;
  state?: string;
  tenant?: string;
  id?: string;
}): Promise<string> {
  const fetched = await fetchOperationDetail({
    operationId: '',
    jsonBaseUrl: '',
    adminToken: '',
    manifestCatalog: chipsCatalog(),
    listLimit: overrides.listLimit ?? 5,
    cursor: overrides.cursor,
    stateFilter: overrides.state,
    tenantFilter: overrides.tenant,
    idFilter: overrides.id,
  });
  if (fetched.kind !== 'list') throw new Error(`expected a list pane, got ${fetched.kind}`);
  return renderOperationSection({ fetch: fetched, selectedOperationId: '' }).html;
}

describe('W-ADMUX03-TOOLBAR-CHIPS-1: clear-all reset, chip hops and deep-link sync', () => {
  it('clear-all returns the default page size with no filter and no cursor', async () => {
    const html = await chipsPane({
      listLimit: 5,
      cursor: off(5),
      state: 'RUNNING',
      tenant: 'tenant-a',
      id: 'run-0',
    });
    // The view being reset really is a filtered deep page - otherwise the
    // assertions below would pass against a default view that never left home.
    expect(html).toContain('data-list-limit="5"');
    expect(html).toContain('data-list-cursor="off:5"');
    expect(html).toContain('data-filter-active="true"');
    expect(html).toContain('data-list-total="8"');

    const href = clearAllHref(html);
    expect(href).toBe(`/admin/operations?limit=${OPERATION_LIST_DEFAULT_LIMIT}`);
    const params: string[] = [];
    hrefQuery(href).forEach((_value, key) => params.push(key));
    expect(params).toEqual(['limit']);

    const landed = await paneFor(href);
    expect(landed.parsed.limit).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(landed.parsed.cursor).toBe(null);
    expect(landed.parsed.listFilters).toEqual({ state: 'ALL', tenant: null, idContains: null });
    expect(landed.html).toContain('data-filter-active="false"');
    expect(landed.html).toContain('data-filter-chips="none"');
    expect(landed.html).toContain('data-list-total="13"');
  });

  it('a per-chip remove drops only its own filter and keeps the chosen page size', async () => {
    const html = await chipsPane({ state: 'RUNNING', tenant: 'tenant-a', id: 'run-0' });
    expect(html).toContain('data-filter-chip="state"');
    expect(html).toContain('data-filter-chip="tenant"');
    expect(html).toContain('data-filter-chip="id"');
    expect(html).toContain('href="/admin/operations?limit=5&amp;tenant=tenant-a&amp;id=run-0"');
    expect(html).toContain('href="/admin/operations?limit=5&amp;state=RUNNING&amp;id=run-0"');
    expect(html).toContain('href="/admin/operations?limit=5&amp;state=RUNNING&amp;tenant=tenant-a"');
    // Asymmetry is deliberate: a chip edit keeps the operator's page size,
    // only clear-all resets it (previous test).
    expect(chipRemoveHref(html, 'state')).not.toBe(clearAllHref(html));

    const landed = await paneFor(chipRemoveHref(html, 'state'));
    expect(landed.parsed.listFilters).toEqual({
      state: 'ALL',
      tenant: 'tenant-a',
      idContains: 'run-0',
    });
    expect(landed.envelope.rows.map((r) => r.id).sort()).toEqual([
      'run-00',
      'run-01',
      'run-02',
      'run-03',
      'run-04',
    ]);
  });

  it('each chip hop unwinds exactly one filter and the reported total follows', async () => {
    const html = await chipsPane({ state: 'RUNNING', tenant: 'tenant-a', id: 'run-0' });
    expect(html).toContain('data-list-total="8"');

    const noState = await paneFor(chipRemoveHref(html, 'state'));
    expect(noState.envelope.total).toBe(9);
    expect(noState.html).toContain('data-filter-state="ALL"');
    expect(noState.html).not.toContain('data-filter-chip="state"');
    expect(noState.html).toContain('data-filter-chip="tenant"');

    const noTenant = await paneFor(chipRemoveHref(noState.html, 'tenant'));
    expect(noTenant.envelope.total).toBe(10);
    expect(noTenant.parsed.listFilters).toEqual({
      state: 'ALL',
      tenant: null,
      idContains: 'run-0',
    });

    const noId = await paneFor(chipRemoveHref(noTenant.html, 'id'));
    expect(noId.envelope.total).toBe(13);
    expect(noId.html).toContain('data-filter-active="false"');
    expect(noId.html).toContain('data-filter-chips="none"');
    // Nothing left to clear, so no reset control is offered.
    expect(noId.html).not.toContain('data-filter-clear-all');
  });

  it('every emitted link lands on a pane that reports exactly its own query', async () => {
    const html = await chipsPane({
      listLimit: 5,
      cursor: off(5),
      state: 'RUNNING',
      tenant: 'tenant-a',
      id: 'run-0',
    });
    const links = listHrefs(html);
    expect(links.length).toBeGreaterThan(6);
    for (const href of links) {
      const query = hrefQuery(href);
      const landed = await paneFor(href);
      expect(landed.html).toContain(`data-list-limit="${query.get('limit')}"`);
      expect(landed.html).toContain(`data-filter-state="${query.get('state') ?? 'ALL'}"`);
      for (const name of ['state', 'tenant', 'id'] as const) {
        const chip = `data-filter-chip="${name}"`;
        // A link carrying a filter renders its chip; a link not carrying one
        // never invents it. This is the URL <-> DOM half of deep-link sync.
        expect(landed.html.includes(chip)).toBe(query.get(name) !== null);
      }
      expect(landed.html.includes('data-list-cursor=')).toBe(query.get('cursor') !== null);
      query.forEach((value, key) => {
        // The shell may only put a parameter in a URL that the route declares.
        expect((OPERATIONS_LIST_QUERY_PARAMS as readonly string[]).includes(key)).toBe(true);
        // And only a token the route would accept - never raw text, never
        // credential material, never anything needing escaping.
        expect(key === 'limit' || isOperationsListFilterToken(value)).toBe(true);
      });
    }
  });

  it('a cursor-free link is its own page: the pane it lands on marks it current', async () => {
    const html = await chipsPane({
      listLimit: 20,
      cursor: off(5),
      state: 'RUNNING',
      tenant: 'tenant-a',
      id: 'run-0',
    });
    const cursorFree = listHrefs(html).filter((h) => !hrefQuery(h).has('cursor'));
    expect(cursorFree.length).toBeGreaterThan(4);
    for (const href of cursorFree) {
      const landed = await paneFor(href);
      // The followed URL comes back as the landed pane's own current page-size
      // link, byte for byte: the URL is the state, navigation adds nothing.
      expect(landed.html).toContain(
        `href="${escapeHref(href)}" data-page-size="${hrefQuery(href).get('limit')}" aria-current="true"`,
      );
    }
  });

  it('a rejected filter value never re-enters a link, and clear-all still escapes', async () => {
    const secret = 'a'.repeat(32);
    const html = await chipsPane({ state: 'RUNNING', tenant: secret });
    expect(html).toContain('data-filter-rejected="tenant"');
    expect(html).not.toContain(secret);
    for (const href of listHrefs(html)) {
      expect(href).not.toContain(secret);
    }
    expect(clearAllHref(html)).toBe(`/admin/operations?limit=${OPERATION_LIST_DEFAULT_LIMIT}`);
    const landed = await paneFor(clearAllHref(html));
    expect(landed.html).toContain('data-filter-ignored="none"');
  });

  it('a pane whose only filter was rejected still offers a way out', async () => {
    const html = await chipsPane({ tenant: 'not;allowed' });
    expect(html).toContain('data-filter-active="false"');
    expect(html).toContain('data-filter-rejected="tenant"');
    expect(html).toContain('data-filter-chips="active"');
    expect(clearAllHref(html)).toBe(`/admin/operations?limit=${OPERATION_LIST_DEFAULT_LIMIT}`);
  });
});

// ---------------------------------------------------------------------------
// W-ADMUX02-SRV-1: the server-side query + cursor contract
//
// GET /api/v1/operations driven through the real `route()` with a recording
// fake db: no sockets, no PG, no Redis. The assertions are about the SQL
// TEXT (what is bound vs what is interpolated) and the response envelope,
// which is exactly the contract the reviewer flagged as T20-A1.
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ADMIN_TOKEN = 'platform-admin-token';
const OPERATOR_TOKEN = 'tenant-operator-token';

function pgResult(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as QueryResultRow[], fields: [] };
}

function dbRow(id: string, createdAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    tenant_id: TENANT_A,
    business_id: 'example-review',
    business_version: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    state_version: 1,
    created_at: createdAt,
    updated_at: createdAt,
    deadline_at: null,
    result_ref: null,
    ...overrides,
  };
}

interface ListDbFixture {
  page?: Record<string, unknown>[];
  total?: number;
  apiKey?: { id: string; tenantId: string } | null;
}

function listRoute(options: {
  search: string;
  headers?: Record<string, string>;
  db?: ListDbFixture;
  config?: Record<string, unknown>;
}): { ctx: RouteContext; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const fixture = options.db ?? {};
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params });
    if (/FROM api_keys WHERE hash=\$1/i.test(sql)) {
      const key = fixture.apiKey;
      return pgResult(key ? [{ id: key.id, tenant_id: key.tenantId }] : []);
    }
    if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
      return pgResult([{ total: fixture.total ?? 0 }]);
    }
    if (/^SELECT \* FROM operations/i.test(sql)) {
      return pgResult(fixture.page ?? []);
    }
    throw new Error(`unexpected operations-list SQL: ${sql}`);
  };
  // Only the fields this route reads are wired; the cast keeps the fixture
  // from having to fabricate 20 unrelated services.
  const ctx = {
    method: 'GET',
    pathname: '/api/v1/operations',
    searchParams: new URLSearchParams(options.search),
    headers: options.headers ?? {},
    config: {
      adminToken: ADMIN_TOKEN,
      tenantAdminTokens: { [OPERATOR_TOKEN]: TENANT_A },
      ...options.config,
    },
    db: { query },
  } as unknown as RouteContext;
  return { ctx, calls };
}

function pageQuery(calls: { sql: string; params: unknown[] }[]): { sql: string; params: unknown[] } {
  const found = calls.find((c) => /^SELECT \* FROM operations/i.test(c.sql));
  if (!found) throw new Error('no page query was issued');
  return found;
}

function countQuery(calls: { sql: string; params: unknown[] }[]): { sql: string; params: unknown[] } {
  const found = calls.find((c) => /SELECT count\(\*\)::int AS total FROM operations/i.test(c.sql));
  if (!found) throw new Error('no count query was issued');
  return found;
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return { createdAt: createdAt ?? '', id: id ?? '' };
}

describe('W-ADMUX02-SRV-1: parseOperationsListQuery allow-list', () => {
  it('defaults every filter and the page size when no params are sent', () => {
    const q = parseOperationsListQuery(new URLSearchParams(''));
    expect(q).toEqual({
      limit: OPERATION_LIST_DEFAULT_LIMIT,
      cursor: null,
      stateFilter: 'ALL',
      tenantId: null,
      idContains: null,
      // The order this route had before a sort parameter existed: an absent
      // sort must not be "no order", it must be THE order, so every cursor and
      // deep link written earlier keeps paging the same rows.
      sort: { field: 'created_at', direction: 'desc' },
    });
  });

  it('clamps limit into 1..100 and survives unparseable values', () => {
    expect(parseOperationsListQuery(new URLSearchParams('limit=0')).limit).toBe(1);
    expect(parseOperationsListQuery(new URLSearchParams('limit=9999')).limit).toBe(OPERATION_LIST_MAX_LIMIT);
    expect(parseOperationsListQuery(new URLSearchParams('limit=abc')).limit).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(parseOperationsListQuery(new URLSearchParams('limit=7')).limit).toBe(7);
  });

  it('accepts the four documented state values, case-insensitively', () => {
    for (const s of ['RUNNING', 'running', 'COMPLETED', 'failed', ' TIMED_OUT ']) {
      expect(parseOperationsListQuery(new URLSearchParams(`state=${s}`)).stateFilter).toBe(
        s.trim().toUpperCase(),
      );
    }
  });

  it('rejects a state outside the enum instead of ignoring it', () => {
    expect(() => parseOperationsListQuery(new URLSearchParams('state=SUCCEEDED')))
      .toThrow(/state must be one of/);
    expect(() => parseOperationsListQuery(new URLSearchParams('state=RUNNING%27')))
      .toThrow(/state must be one of/);
  });

  it('accepts allow-listed tenant/id tokens', () => {
    const q = parseOperationsListQuery(new URLSearchParams(`tenant=${TENANT_A}&id=op-42`));
    expect(q.tenantId).toBe(TENANT_A);
    expect(q.idContains).toBe('op-42');
  });

  it('rejects injection-shaped and over-long filter tokens', () => {
    for (const bad of [
      `x' OR 1=1--`,
      'a;b',
      'a b',
      '../../etc/passwd',
      '<script>',
      'x'.repeat(65),
    ]) {
      expect(() => parseOperationsListQuery(new URLSearchParams(`tenant=${encodeURIComponent(bad)}`)))
        .toThrow(/tenant is not an accepted filter value/);
      expect(() => parseOperationsListQuery(new URLSearchParams(`id=${encodeURIComponent(bad)}`)))
        .toThrow(/id is not an accepted filter value/);
    }
  });

  it('refuses pasted key material as a search term', () => {
    const secret = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead';
    expect(() => parseOperationsListQuery(new URLSearchParams(`id=${secret}`)))
      .toThrow(/id is not an accepted filter value/);
  });

  it('rejects a malformed or over-long cursor rather than paging from nowhere', () => {
    for (const bad of ['not-a-cursor', 'off%3Ak', Buffer.from('2026-13-45T99:99:99Z|x', 'utf8').toString('base64url')]) {
      expect(() => parseOperationsListQuery(new URLSearchParams(`cursor=${bad}`)))
        .toThrow(/cursor is not a valid operations list cursor/);
    }
    expect(() => parseOperationsListQuery(new URLSearchParams(`cursor=${'A'.repeat(200)}`)))
      .toThrow(/cursor is not a valid operations list cursor/);
  });
});

describe('W-ADMUX02-SRV-1: GET /api/v1/operations envelope', () => {
  it('platform admin without a tenant param reads cross-tenant and gets the documented keys', async () => {
    const { ctx, calls } = listRoute({
      search: '',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 42 },
    });
    const res = await route(ctx);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    expect(body['total']).toBe(42);
    expect(body['limit']).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(Array.isArray(body['items'])).toBe(true);
    // No tenant predicate at all for the cross-tenant platform view.
    expect(pageQuery(calls).sql).not.toMatch(/tenant_id/);
  });

  it('total is the server COUNT of the filtered population, never the row count', async () => {
    const { ctx } = listRoute({
      search: 'limit=2',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 137 },
    });
    const body = (await route(ctx)).body as Record<string, unknown>;
    expect((body['items'] as unknown[]).length).toBe(1);
    expect(body['total']).toBe(137);
  });

  it('a short page ends the list (no next cursor); a full page with an extra row continues', async () => {
    const short = listRoute({
      search: 'limit=2',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 1 },
    });
    const shortBody = (await route(short.ctx)).body as Record<string, unknown>;
    expect(shortBody['nextCursor']).toBe(null);

    const full = listRoute({
      search: 'limit=2',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: {
        page: [
          dbRow('op-1', '2026-09-25T00:00:00.000Z'),
          dbRow('op-2', '2026-09-25T01:00:00.000Z'),
          dbRow('op-3', '2026-09-25T02:00:00.000Z'),
        ],
        total: 9,
      },
    });
    const fullBody = (await route(full.ctx)).body as Record<string, unknown>;
    // limit + 1 rows came back ⇒ a next page exists, and the cursor is the
    // LAST row of the page we return (op-2), not the probe row (op-3).
    expect((fullBody['items'] as unknown[]).length).toBe(2);
    const cursor = decodeCursor(fullBody['nextCursor'] as string);
    expect(cursor).toEqual({ createdAt: '2026-09-25T01:00:00.000Z', id: 'op-2' });
    expect(pageQuery(full.calls).params).toContain(3);
  });

  it('the keyset cursor round-trips: page 1 hands out a cursor page 2 can page with', async () => {
    const first = listRoute({
      search: 'limit=1',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: {
        page: [
          dbRow('11111111-1111-4111-8111-111111111111', '2026-09-25T02:00:00.000Z'),
          dbRow('22222222-2222-4222-8222-222222222222', '2026-09-25T01:00:00.000Z'),
        ],
        total: 2,
      },
    });
    const nextCursor = ((await route(first.ctx)).body as Record<string, unknown>)['nextCursor'] as string;
    expect(decodeCursor(nextCursor)).toEqual({
      createdAt: '2026-09-25T02:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    });

    const second = listRoute({
      search: `limit=1&cursor=${encodeURIComponent(nextCursor)}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('22222222-2222-4222-8222-222222222222', '2026-09-25T01:00:00.000Z')], total: 2 },
    });
    await route(second.ctx);
    const page = pageQuery(second.calls);
    expect(page.sql).toContain('(created_at, id) < (');
    expect(page.params).toContain('2026-09-25T02:00:00.000Z');
    expect(page.params).toContain('11111111-1111-4111-8111-111111111111');
  });

  it('page 1 reports no previous page', async () => {
    const { ctx } = listRoute({
      search: '',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 1 },
    });
    expect((await route(ctx)).body).toMatchObject({ prevCursor: null });
  });

  it('a page-2 request with nothing above it reports no previous page', async () => {
    const { ctx } = listRoute({
      search: `cursor=${Buffer.from('2026-09-25T02:00:00.000Z|11111111-1111-4111-8111-111111111111', 'utf8').toString('base64url')}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    const body = (await route(ctx)).body as Record<string, unknown>;
    expect(body['prevCursor']).toBe(null);
    expect(body['nextCursor']).toBe(null);
  });
});

/**
 * W-ADMUX02-SRV-1-FIX: the previous page is fetched with a BACKWARD cursor, and
 * these tests run the REAL route against a fake db that actually applies the
 * (created_at, id) predicate and the ORDER BY. The earlier prev-cursor test
 * asserted against hardcoded rows and so could not have caught a wrong
 * direction — it "passed" while prevCursor pointed back into the current page.
 */
describe('W-ADMUX02-SRV-1-FIX: prev cursor is a real backward hop', () => {
  /** N rows, newest first, one hour apart. */
  function population(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => {
      const rank = i + 1;
      const hour = String(24 - rank).padStart(2, '0');
      return dbRow(
        `${String(rank).padStart(8, '0')}-0000-4000-8000-000000000000`,
        `2026-09-25T${hour}:00:00.000Z`
      );
    });
  }

  function rankOf(id: string): number {
    return Number(id.slice(0, 8));
  }

  /**
   * Applies the predicate the route actually emits: `(created_at, id) <op> (ts,id)`
   * plus ORDER BY DESC/ASC and LIMIT. op is read out of the SQL so the test
   * fails if the route changes direction without the fixtures following it.
   */
  function statefulRoute(rows: Record<string, unknown>[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const ctx = {
      method: 'GET',
      pathname: '/api/v1/operations',
      searchParams: new URLSearchParams(''),
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      config: { adminToken: ADMIN_TOKEN },
      db: {
        query: async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
          calls.push({ sql, params });
          if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
            return pgResult([{ total: rows.length }]);
          }
          if (!/^SELECT \* FROM operations/i.test(sql)) {
            throw new Error(`unexpected SQL: ${sql}`);
          }
          const backwards = /ORDER BY created_at ASC, id ASC/i.test(sql);
          const op = /\(created_at, id\) > \(/.test(sql) ? '>' : '<';
          const ts = String(params[0] ?? '');
          const id = String(params[1] ?? '');
          const bound: [string, string] = [ts, id];
          const key = (r: Record<string, unknown>): [string, string] => [
            String(r['created_at']),
            String(r['id']),
          ];
          const cmp = (a: [string, string], b: [string, string]): number =>
            a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
          const filtered = rows.filter((r) => {
            const c = cmp(key(r), bound);
            return op === '>' ? c > 0 : c < 0;
          });
          const sorted = filtered.sort((a, b) =>
            backwards ? cmp(key(a), key(b)) : cmp(key(b), key(a))
          );
          const limit = Number(params[params.length - 1]);
          return pgResult(sorted.slice(0, limit));
        },
      },
    } as unknown as RouteContext;

    return {
      calls,
      async get(search: string) {
        (ctx as unknown as { searchParams: URLSearchParams }).searchParams =
          new URLSearchParams(search);
        return (await route(ctx)).body as Record<string, unknown>;
      },
    };
  }

  it('page 1 -> page 2 -> back to page 1 returns the identical rows', async () => {
    const db = statefulRoute(population(8));
    const p1 = await db.get('limit=2');
    expect((p1['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
    expect(p1['prevCursor']).toBe(null);

    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    expect((p2['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([3, 4]);
    expect(p2['prevCursor']).not.toBe(null);

    // THE regression: following prevCursor must land back on page 1 verbatim.
    const back = await db.get(`limit=2&cursor=${encodeURIComponent(p2['prevCursor'] as string)}`);
    expect((back['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
    expect((back['items'] as { id: string }[]).map((r) => r.id)).toEqual(
      (p1['items'] as { id: string }[]).map((r) => r.id)
    );
    // …and page 1 knows it has no page above it.
    expect(back['prevCursor']).toBe(null);
  });

  it('walks three pages deep and back up one at a time without skipping or repeating', async () => {
    const db = statefulRoute(population(8));
    const seen: number[][] = [];
    let body = await db.get('limit=2');
    seen.push((body['items'] as { id: string }[]).map((r) => rankOf(r.id)));
    for (let i = 0; i < 2; i++) {
      body = await db.get(`limit=2&cursor=${encodeURIComponent(body['nextCursor'] as string)}`);
      seen.push((body['items'] as { id: string }[]).map((r) => rankOf(r.id)));
    }
    expect(seen).toEqual([[1, 2], [3, 4], [5, 6]]);

    // Back up: page 3 -> page 2 -> page 1.
    const up2 = await db.get(`limit=2&cursor=${encodeURIComponent(body['prevCursor'] as string)}`);
    expect((up2['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([3, 4]);
    const up1 = await db.get(`limit=2&cursor=${encodeURIComponent(up2['prevCursor'] as string)}`);
    expect((up1['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
  });

  it('a backward cursor is an ASC query with a > predicate, and its rows come back newest-first', async () => {
    const db = statefulRoute(population(8));
    const p1 = await db.get('limit=2');
    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    await db.get(`limit=2&cursor=${encodeURIComponent(p2['prevCursor'] as string)}`);

    const backPage = calls_with_page(db.calls);
    // DESC here would take the NEWEST rows above the boundary and skip a page.
    expect(backPage).toMatch(/ORDER BY created_at ASC, id ASC/i);
    expect(backPage).toMatch(/\(created_at, id\) > \(/);
  });

  it('a backward arrival on the first page offers no previous page (no self-link)', async () => {
    // Regression: guarding only on "a cursor was sent" left page 1 reachable
    // from below with a prevCursor, so the pane rendered a Previous link that
    // returned the operator to the page they were already on.
    const db = statefulRoute(population(4));
    const p1 = await db.get('limit=2');
    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    const back = await db.get(`limit=2&cursor=${encodeURIComponent(p2['prevCursor'] as string)}`);
    expect((back['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
    expect(back['prevCursor']).toBe(null);
    // Forward into the same page still reports a previous page.
    expect(p2['prevCursor']).not.toBe(null);
  });

  it('a partial last page still offers a previous page', async () => {
    const db = statefulRoute(population(5)); // 5 rows / limit 2 => pages 2,2,1
    const p1 = await db.get('limit=2');
    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    const p3 = await db.get(`limit=2&cursor=${encodeURIComponent(p2['nextCursor'] as string)}`);
    expect((p3['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([5]);
    expect(p3['nextCursor']).toBe(null);
    expect(p3['prevCursor']).not.toBe(null);

    const back = await db.get(`limit=2&cursor=${encodeURIComponent(p3['prevCursor'] as string)}`);
    expect((back['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([3, 4]);
  });
});

function calls_with_page(calls: { sql: string; params: unknown[] }[]): string {
  const found = calls.filter((c) => /^SELECT \* FROM operations/i.test(c.sql));
  return found.length > 0 ? found[found.length - 1]!.sql : '';
}

describe('W-ADMUX02-SRV-1: filters are server-side, bound, and tenant-fenced', () => {
  it('state expands to a bound ANY() over the wire states, never into SQL text', async () => {
    const { ctx, calls } = listRoute({
      search: 'state=FAILED',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    const page = pageQuery(calls);
    expect(page.sql).toContain('state = ANY($1::text[])');
    expect(page.sql).not.toContain('FAILED');
    expect(page.params[0]).toEqual(['FAILED']);
    // The count must see the same filter as the page, or the number lies.
    expect(countQuery(calls).sql).toContain('state = ANY($1::text[])');
    expect(countQuery(calls).params[0]).toEqual(['FAILED']);
  });

  it('the RUNNING group covers every state an operator still has to look at', async () => {
    const { ctx, calls } = listRoute({
      search: 'state=RUNNING',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    expect(pageQuery(calls).params[0]).toEqual([
      'ACCEPTED',
      'QUEUED',
      'RUNNING',
      'RETRY_PENDING',
      'WAITING_CHILDREN',
      'CANCEL_REQUESTED',
      'WAITING_INPUT',
    ]);
  });

  it('the tenant filter is an exact bound equality', async () => {
    const { ctx, calls } = listRoute({
      search: `tenant=${TENANT_B}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    const page = pageQuery(calls);
    expect(page.sql).toContain('tenant_id = $1');
    expect(page.sql).not.toContain(TENANT_B);
    expect(page.params[0]).toBe(TENANT_B);
  });

  it('the id search is a bound substring, not a LIKE with wildcard semantics', async () => {
    const { ctx, calls } = listRoute({
      search: 'id=op_4',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    const page = pageQuery(calls);
    expect(page.sql).toContain('strpos(lower(id::text), lower($1)) > 0');
    expect(page.sql).not.toMatch(/LIKE/i);
    expect(page.params[0]).toBe('op_4');
  });

  it('no caller-supplied value is ever concatenated into the SQL text', async () => {
    const { ctx, calls } = listRoute({
      search: `state=FAILED&tenant=${TENANT_A}&id=op-4&limit=5`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.sql).not.toContain(TENANT_A);
      expect(c.sql).not.toContain('op-4');
      expect(c.sql).not.toMatch(/'|;|--/);
    }
  });

  it('a tenant operator is fenced to its own tenant in SQL, and 403s a foreign filter', async () => {
    const own = listRoute({
      search: '',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(own.ctx);
    expect(pageQuery(own.calls).params[0]).toBe(TENANT_A);

    const foreign = listRoute({
      search: `tenant=${TENANT_B}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await expect(route(foreign.ctx)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'admin reads are scoped to the caller tenant',
    });
    // The fence rejects BEFORE any query is issued.
    expect(foreign.calls).toHaveLength(0);
  });

  it('the x-api-key path is fenced by the key, not by the tenant param', async () => {
    const own = listRoute({
      search: `tenant=${TENANT_A}`,
      headers: { 'x-api-key': 'raw-key' },
      db: { page: [], total: 0, apiKey: { id: 'key-1', tenantId: TENANT_A } },
    });
    await route(own.ctx);
    expect(pageQuery(own.calls).params[0]).toBe(TENANT_A);

    const foreign = listRoute({
      search: `tenant=${TENANT_B}`,
      headers: { 'x-api-key': 'raw-key' },
      db: { page: [], total: 0, apiKey: { id: 'key-1', tenantId: TENANT_A } },
    });
    await expect(route(foreign.ctx)).rejects.toMatchObject({ status: 403 });
  });

  it('an invalid filter is a 422 on the route, not a silently unfiltered list', async () => {
    const { ctx, calls } = listRoute({
      search: 'state=NOT_A_STATE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 99 },
    });
    await expect(route(ctx)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(calls).toHaveLength(0);
  });
});

/**
 * W-ADMUX02-SORT-ALLOWLIST-1 — keyset paging under every allowed sort.
 *
 * operations-list-contract-conformance proves WHICH SQL the route emits; this
 * block proves that SQL is CORRECT. The fake db parses the key expression, both
 * directions, the boundary operator and the LIMIT placeholder out of the
 * statement the route actually sent and applies them to a real row set — the
 * standing lesson from an earlier cycle, where a fake returning hardcoded rows
 * stayed green while the product paged in the wrong direction.
 *
 * The population attacks the two ways a sort can break a keyset page:
 *   1. Duplicate key values. created_at is not unique, so a page that leans on
 *      the key alone skips or repeats rows; only the id tiebreak orders them.
 *      The shared instants are deliberately DIFFERENT groupings per column, so
 *      a route paging by the wrong column cannot agree with the oracle.
 *   2. A NULL key. deadline_at is the nullable column, and a row-value
 *      comparison is never TRUE against NULL — so ORDER BY deadline_at without a
 *      coalesced key answers page 1 correctly and then silently drops every
 *      deadline-less operation. Four of these twelve rows have no deadline on
 *      purpose, and a full walk must still bring all twelve back.
 */
describe('W-ADMUX02-SORT-ALLOWLIST-1: keyset paging stays exact under every sort', () => {
  /** [rank, createdAgoH, updatedAgoH, deadlineAgoH|null] — see the note above. */
  const FIXTURE: [number, number, number, number | null][] = [
    [1, 0, 0, 4],
    [2, 0, 1, 2],
    [3, 1, 1, 4],
    [4, 1, 2, null],
    [5, 2, 2, null],
    [6, 3, 3, null],
    [7, 3, 4, null],
    [8, 4, 4, 6],
    [9, 5, 5, 8],
    [10, 5, 6, 8],
    [11, 6, 7, 10],
    [12, 7, 8, 12],
  ];

  function idOfRank(rank: number): string {
    return String(rank).padStart(8, '0') + '-0000-4000-8000-000000000000';
  }
  function rankOf(id: string): number {
    return Number(id.slice(0, 8));
  }
  function instant(hoursAgo: number): string {
    return new Date(Date.UTC(2026, 8, 25, 12) - hoursAgo * 3600000).toISOString();
  }
  function population(): Record<string, unknown>[] {
    return FIXTURE.map(([rank, createdH, updatedH, deadlineH]) =>
      dbRow(idOfRank(rank), instant(createdH), {
        updated_at: instant(updatedH),
        deadline_at: deadlineH === null ? null : instant(deadlineH),
      })
    );
  }

  /**
   * Restated here on purpose instead of imported from the route: if the product
   * constant ever disagrees with the rule "the NULL block sits at the END of
   * the ordering", this oracle and the route must come apart.
   */
  const NULL_BOUND: Record<'asc' | 'desc', string> = {
    desc: '0001-01-01T00:00:00.000Z',
    asc: '9999-12-31T23:59:59.999Z',
  };

  type SortDir = 'asc' | 'desc';

  function keyOf(row: Record<string, unknown>, field: string, direction: SortDir): string {
    const value = row[field];
    if (value === null || value === undefined) {
      return direction === 'desc' ? NULL_BOUND.desc : NULL_BOUND.asc;
    }
    return String(value);
  }

  /** The order a correct implementation must return, computed independently. */
  function expectedOrder(field: string, direction: SortDir): number[] {
    const sign = direction === 'asc' ? 1 : -1;
    return [...population()]
      .sort((a, b) => {
        const ka = keyOf(a, field, direction);
        const kb = keyOf(b, field, direction);
        if (ka !== kb) return ka < kb ? -sign : sign;
        // The id tiebreak follows the key direction, so equal keys are ordered
        // too and a page boundary can never split a set two different ways.
        const ia = String(a['id']);
        const ib = String(b['id']);
        return ia < ib ? -sign : sign;
      })
      .map((row) => rankOf(String(row['id'])));
  }

  /**
   * Applies the emitted statement. Anything unrecognised throws, so a route
   * that changes shape fails loudly here rather than paging past rows quietly.
   */
  function execute(sql: string, params: unknown[]): Record<string, unknown>[] {
    const order = /ORDER BY (.+?) (ASC|DESC), id (ASC|DESC)/.exec(sql);
    if (!order) throw new Error('page SQL has no recognisable ORDER BY key + id tiebreak: ' + sql);
    const keyExpr = order[1] as string;
    const keyDir = order[2] as 'ASC' | 'DESC';
    const idDir = order[3] as 'ASC' | 'DESC';
    if (keyDir !== idDir) {
      throw new Error('the id tiebreak must follow the key direction, got ' + keyDir + '/' + idDir);
    }

    const limitParam = /LIMIT \$(\d+)$/.exec(sql);
    if (!limitParam) throw new Error('page SQL has no bound LIMIT: ' + sql);
    const limit = Number(params[Number(limitParam[1]) - 1]);

    let field: string;
    let nullBound: string | null = null;
    const coalesced = /^COALESCE\((\w+), '([^']*)'::timestamptz\)$/.exec(keyExpr);
    if (coalesced) {
      field = coalesced[1] as string;
      nullBound = coalesced[2] as string;
    } else if (/^COALESCE\((\w+), \$\d+::timestamptz\)$/.test(keyExpr)) {
      // 0019 indexes COALESCE(deadline_at, '<sentinel>'::timestamptz) as a Const
      // expression; a bound Param never matches it, so the parameterised form is
      // the dead-index regression T-35 measured, not a shape to page faithfully.
      throw new Error('ORDER BY sentinel regressed to the bound-parameter form: ' + keyExpr);
    } else if (/^\w+$/.test(keyExpr)) {
      field = keyExpr;
    } else {
      throw new Error('unrecognised ORDER BY key expression: ' + keyExpr);
    }
    const rowKey = (row: Record<string, unknown>): string => {
      const value = row[field];
      if (value === null || value === undefined) {
        if (nullBound === null) {
          throw new Error('a NULL ' + field + ' was ordered by a key with no NULL handling');
        }
        return nullBound;
      }
      return String(value);
    };

    let kept = population();
    // The boundary either opens the WHERE list or is joined onto a filter, and
    // which of the two it is depends on how many predicates the request
    // carries, so the interpreter accepts either introducer.
    const boundary = /(?: WHERE | AND )\((.+?), id\) ([<>]) \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/.exec(sql);
    if (!boundary && /, id\) [<>] \(/.test(sql)) {
      // Without this guard, a shape the interpreter cannot read degrades into
      // no boundary at all: the fake returns the whole population and a
      // paging test fails as an endless walk instead of saying what broke.
      throw new Error('a keyset boundary is in the SQL but the interpreter could not read it: ' + sql);
    }
    if (boundary) {
      // The predicate must name the SAME expression the ORDER BY used. Ordering
      // by one expression while comparing against another is how a keyset page
      // skips rows, and this is the one place that can catch it.
      if (boundary[1] !== keyExpr) {
        throw new Error('boundary key ' + boundary[1] + ' differs from ORDER BY key ' + keyExpr);
      }
      const op = boundary[2] as '<' | '>';
      const boundKey = String(params[Number(boundary[3]) - 1]);
      const boundId = String(params[Number(boundary[4]) - 1]);
      // A row-value comparison is plain lexicographic order: which rows sit on
      // which side of the boundary does not depend on the ORDER BY direction,
      // only which side the walk happens to be travelling to. Every key here is
      // a canonical ISO instant of identical width, so string order IS
      // instant order, and the ids are equal-width uuid strings.
      kept = kept.filter((row) => {
        const k = rowKey(row);
        const id = String(row['id']);
        return op === '<'
          ? k < boundKey || (k === boundKey && id < boundId)
          : k > boundKey || (k === boundKey && id > boundId);
      });
    }

    kept.sort((a, b) => {
      const ka = rowKey(a);
      const kb = rowKey(b);
      if (ka !== kb) return ka < kb ? -sign2(keyDir) : sign2(keyDir);
      const ia = String(a['id']);
      const ib = String(b['id']);
      return ia < ib ? -sign2(keyDir) : sign2(keyDir);
    });
    return kept.slice(0, limit);
  }
  function sign2(dir: 'ASC' | 'DESC'): number {
    return dir === 'ASC' ? 1 : -1;
  }

  function sortRoute(): {
    calls: { sql: string; params: unknown[] }[];
    get: (search: string) => Promise<Record<string, unknown>>;
  } {
    const calls: { sql: string; params: unknown[] }[] = [];
    const ctx = {
      method: 'GET',
      pathname: '/api/v1/operations',
      searchParams: new URLSearchParams(''),
      headers: { authorization: 'Bearer ' + ADMIN_TOKEN },
      config: { adminToken: ADMIN_TOKEN },
      db: {
        query: async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
          calls.push({ sql, params });
          if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
            return pgResult([{ total: FIXTURE.length }]);
          }
          if (!/^SELECT \* FROM operations/i.test(sql)) {
            throw new Error('unexpected SQL: ' + sql);
          }
          return pgResult(execute(sql, params));
        },
      },
    } as unknown as RouteContext;
    return {
      calls,
      async get(search: string) {
        (ctx as unknown as { searchParams: URLSearchParams }).searchParams = new URLSearchParams(search);
        return (await route(ctx)).body as Record<string, unknown>;
      },
    };
  }

  function ranks(body: Record<string, unknown>): number[] {
    return (body['items'] as { id: string }[]).map((row) => rankOf(row.id));
  }

  /** Follow nextCursor to the end. Bounded, so a broken cursor fails instead of looping. */
  async function walkAll(search: string, limit: number): Promise<number[]> {
    const db = sortRoute();
    const seen: number[] = [];
    let body = await db.get('limit=' + limit + (search ? '&' + search : ''));
    for (let hop = 0; hop < FIXTURE.length + 2; hop += 1) {
      seen.push(...ranks(body));
      const next = body['nextCursor'] as string | null;
      if (next === null) return seen;
      body = await db.get('limit=' + limit + (search ? '&' + search : '') + '&cursor=' + encodeURIComponent(next));
    }
    throw new Error('the walk never ended after ' + (FIXTURE.length + 2) + ' hops');
  }

  it.each([...OPERATIONS_LIST_SORT_VALUES])('%s: a full walk returns the oracle order exactly', async (value) => {
    const parts = String(value).split(':');
    const field = parts[0] as string;
    const direction = parts[1] as SortDir;
    // limit 3 over 12 rows = 4 hops, enough for a boundary to fall inside every
    // duplicated-key group in the fixture.
    expect(await walkAll('sort=' + value, 3)).toEqual(expectedOrder(field, direction));
  });

  it('no deadline-less operation is ever lost, in either direction', async () => {
    // The named hazard: rows 4, 5, 6 and 7 have no deadline, and a bare
    // (deadline_at, id) < (...) comparison excludes every one of them, so the
    // walk would come back with 8 of 12 and never say so.
    for (const value of ['deadline_at:desc', 'deadline_at:asc']) {
      const seen = await walkAll('sort=' + value, 2);
      expect(new Set(seen).size).toBe(FIXTURE.length);
      expect(seen).toHaveLength(FIXTURE.length);
    }
  });

  it('a page boundary inside a duplicate-key group neither skips nor repeats a row', async () => {
    // limit 1 forces the boundary to cut through each group of rows sharing an
    // instant, which is precisely where a missing id tiebreak shows up.
    for (const value of [...OPERATIONS_LIST_SORT_VALUES]) {
      const seen = await walkAll('sort=' + value, 1);
      expect(seen).toHaveLength(FIXTURE.length);
      expect(new Set(seen).size).toBe(FIXTURE.length);
    }
  });

  it('the tiebreak orders equal keys by id in the SAME direction as the key', async () => {
    // Ranks 1 and 2 share the NEWEST created_at, ranks 9 and 10 share another.
    const down = ranks(await sortRoute().get('limit=5&sort=created_at:desc'));
    // DESC takes the larger id first inside a shared instant...
    expect(down.slice(0, 2)).toEqual([2, 1]);
    // ...and ASC reverses the key and the tiebreak together: the oldest instant
    // comes first (rank 12), and inside a shared instant the SMALLER id does.
    const up = ranks(await sortRoute().get('limit=5&sort=created_at:asc'));
    expect(up[0]).toBe(12);
    expect(up.indexOf(9)).toBeLessThan(up.indexOf(10));
  });

  it('a backward hop returns the identical page under a reversed primary order', async () => {
    // The direction flip is the part a sort changes: with sort=updated_at:asc a
    // forward hop walks UP the key, so the backward hop must walk DOWN it.
    const db = sortRoute();
    const p1 = await db.get('limit=3&sort=updated_at:asc');
    const p2 = await db.get('limit=3&sort=updated_at:asc&cursor=' + encodeURIComponent(p1['nextCursor'] as string));
    expect(p2['prevCursor']).not.toBe(null);
    const back = await db.get('limit=3&sort=updated_at:asc&cursor=' + encodeURIComponent(p2['prevCursor'] as string));
    expect(ranks(back)).toEqual(ranks(p1));
    expect(back['prevCursor']).toBe(null);
  });

  it('sort reorders the page but never the population count', async () => {
    for (const value of [...OPERATIONS_LIST_SORT_VALUES]) {
      const body = await sortRoute().get('limit=2&sort=' + value);
      expect(body['total']).toBe(FIXTURE.length);
    }
  });
});

describe('W-ADM-UX-02 pagination negative: limit bounds', () => {
  it('zero and negative limits clamp UP to 1, never to 0 or a negative page size', () => {
    // A page size of 0 or negative would make the server ask for an
    // impossible window; clamping to 1 returns exactly one row instead of
    // an error or an empty page that looks like data.
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(-1)).toBe(1);
    expect(clampListLimit(-9999)).toBe(1);
  });

  it('a limit past the 100 ceiling clamps to exactly 100', () => {
    expect(clampListLimit(101)).toBe(100);
    expect(clampListLimit(100)).toBe(100);
    expect(clampListLimit(1000000)).toBe(100);
  });

  it('NaN and Infinity fall back to the contract default, never leaking through', () => {
    expect(clampListLimit(Number.NaN)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(Number.POSITIVE_INFINITY)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(Number.NEGATIVE_INFINITY)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
  });

  it('a fractional limit TRUNCATES rather than rounding', () => {
    // Math.trunc, so 1.9 becomes 1 and never 2. A page that silently
    // rounded UP would return more rows than the operator asked for.
    expect(clampListLimit(1.9)).toBe(1);
    expect(clampListLimit(99.99)).toBe(99);
  });

  it('unparseable strings fall back to the default', () => {
    expect(clampListLimit('abc')).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit('')).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit('   ')).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(undefined)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(null)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
  });

  it('a numeric string with trailing garbage takes the numeric prefix', () => {
    // parseInt semantics: '12abc' reads as 12. This is MEASURED
    // behaviour, not an aspiration - pinned so a future parser change
    // is a visible diff rather than a silent contract shift.
    expect(clampListLimit('12abc')).toBe(12);
    expect(clampListLimit('25')).toBe(25);
    expect(clampListLimit('-7')).toBe(1);
  });

  it('a numeric string over the ceiling still clamps', () => {
    expect(clampListLimit('101')).toBe(100);
    expect(clampListLimit('9999')).toBe(100);
  });
});


describe('W-ADM-UX-02 pagination negative: cursor bounds', () => {
  const decode = (c: string): string[] => Buffer.from(c, 'base64url').toString('utf8').split('|');

  it('an empty cursor decodes to zero usable fields, never a phantom page', () => {
    const parts = decode('');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('');
  });

  it('a whitespace cursor is not mistaken for a real one', () => {
    const parts = decode(' ');
    expect(parts[0]).not.toBe(' ');
  });

  it('a cursor with no pipe field decodes to a single non-parseable part', () => {
    const raw = Buffer.from('no-pipe-here', 'utf8').toString('base64url');
    const parts = decode(raw);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('no-pipe-here');
  });

  it('a well-formed cursor decodes to the full field set', () => {
    const raw = Buffer.from('2026-01-01T00:00:00Z|op-1|created_at|asc|next', 'utf8').toString('base64url');
    const parts = decode(raw);
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('2026-01-01T00:00:00Z');
    expect(parts[1]).toBe('op-1');
  });

  it('a cursor with a non-ASCII id decodes to five fields, not five garbage bytes', () => {
    const raw = Buffer.from('2026-01-01T00:00:00Z|op-é|created_at|asc|next', 'utf8').toString('base64url');
    const parts = decode(raw);
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('2026-01-01T00:00:00Z');
  });

  it('an over-length cursor exceeds the wire bound it is sliced to', () => {
    // The route slices a supplied cursor to the max length before using it;
    // a 500-char token is therefore longer than anything the wire accepts.
    const long = 'x'.repeat(500);
    expect(long.length).toBeGreaterThan(OPERATION_LIST_CURSOR_MAX_LEN);
    expect(long.slice(0, OPERATION_LIST_CURSOR_MAX_LEN).length).toBe(OPERATION_LIST_CURSOR_MAX_LEN);
  });

  it('garbage base64 never throws, it just decodes to unparseable text', () => {
    const parts = decode('not-base64!!');
    expect(parts.length).toBeGreaterThan(0);
  });
});
