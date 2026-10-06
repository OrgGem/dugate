/**
 * W-ADMUX03-SHELL-SORT-1 - wire the operations list sort parameter into
 * the Admin Shell, and keep T140-A1 cursor binding true at the link layer.
 *
 * Reviewer Turn 150 finding 4: the shell had no sort control and did not
 * pass a manually entered sort through its parser/fetcher. Since cycle 15
 * the route (server.ts) accepts six sorts and BOUNDS every keyset cursor to
 * the ordering it was minted under, rejecting a mismatch with 422. This
 * suite proves the shell honours that binding:
 * - the raw ?sort= token is validated with the ONE @du/contracts parser
 *   the route uses (no accept/422 drift), and only a NON-DEFAULT canonical
 *   ordering is forwarded (default-minted cursors stay replayable);
 * - every link that echoes a cursor also echoes the ordering, and the sort
 *   control (a GET form with no cursor field) resets the cursor on a sort
 *   change STRUCTURALLY - the shell never decodes the opaque token, and a
 *   hand-crafted mismatch surfaces the route 422 remedy as kind:error;
 * - the offline catalog mirrors the route ordering (key + id tiebreak,
 *   NULL deadlines last in both directions) so the controls are exercisable
 *   without a DB.
 *
 * All offline: injected fetchImpl only (no sockets), catalog-only pages.
 * No DB, no Redis, no live infra.
 */

import {
  fetchOperationDetail,
  sanitizeSortFilter,
  OPERATION_LIST_DEFAULT_SORT,
  OPERATION_LIST_SORT_OPTIONS,
} from '../src/app/admin/operation-section-data';
import type { OperationDetailCatalogEntry } from '../src/app/admin/operation-section-data';
import { renderOperationSection } from '../src/app/admin/operation-section-renderer';
import { parseOperationListQuery } from '../src/app/admin/shell-router';
import type { OperationDetail } from '@du/contracts';
import { OPERATIONS_LIST_SORT_VALUES } from '@du/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(id: string, overrides: Partial<OperationDetail> = {}): OperationDetail {
  return {
    id,
    tenantId: 'tenant-1',
    businessId: 'example-review',
    businessVersion: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    stateVersion: 1,
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    deadlineAt: null,
    replayOf: null,
    progress: { percent: 10, message: '' },
    links: { self: '/api/v1/operations/' + id, result: '/api/v1/operations/' + id + '/result' },
    wait: null,
    error: null,
    ...overrides,
  };
}

function catalogEntry(op: OperationDetail): OperationDetailCatalogEntry {
  return { operation: op, result: null, artifacts: [] };
}

/**
 * Deliberately out-of-order fixture: entry order c,a,b differs from every
 * derived ordering, so "default keeps fixture order" cannot pass by luck.
 */
const OP_A = makeOp('op-a', {
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  deadlineAt: null,
});
const OP_B = makeOp('op-b', {
  createdAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
  deadlineAt: '2026-12-01T00:00:00Z',
});
const OP_C = makeOp('op-c', {
  createdAt: '2026-01-03T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  deadlineAt: '2026-11-01T00:00:00Z',
});

function fixtureCatalog(): { entries: OperationDetailCatalogEntry[] } {
  return { entries: [catalogEntry(OP_C), catalogEntry(OP_A), catalogEntry(OP_B)] };
}

function off(n: number): string {
  return 'off:' + n.toString(36);
}

function qs(href: string): URLSearchParams {
  const q = href.split('?')[1] ?? '';
  return new URLSearchParams(q.replace(/&amp;/g, '&'));
}

function rowIds(r: { rows: readonly { id: string }[] }): string[] {
  return r.rows.map((x) => x.id);
}

/** Fetch a catalog list pane (offline mirror path). */
async function catalogPane(overrides: {
  sortFilter?: string;
  cursor?: string;
  listLimit?: number;
  stateFilter?: string;
}) {
  const r = await fetchOperationDetail({
    operationId: '',
    jsonBaseUrl: '',
    adminToken: '',
    manifestCatalog: fixtureCatalog(),
    listLimit: overrides.listLimit ?? 20,
    cursor: overrides.cursor,
    stateFilter: overrides.stateFilter,
    sortFilter: overrides.sortFilter,
  });
  if (r.kind !== 'list') throw new Error('expected a list pane, got ' + r.kind);
  return r;
}

/** Fetch through an injected HTTP platform that records the request URL. */
async function httpPane(
  body: unknown,
  overrides: { sortFilter?: string; cursor?: string; status?: number; contentType?: string; stateFilter?: string },
) {
  const urls: string[] = [];
  const res = await fetchOperationDetail({
    operationId: '',
    jsonBaseUrl: 'http://platform.test',
    adminToken: 'bearer-token',
    listLimit: 20,
    cursor: overrides.cursor,
    sortFilter: overrides.sortFilter,
    stateFilter: overrides.stateFilter,
    fetchImpl: (async (input: string | URL) => {
      urls.push(String(input));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: overrides.status ?? 200,
        headers: { 'content-type': overrides.contentType ?? 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  if (urls.length !== 1) throw new Error('expected exactly one platform request');
  return { res, url: new URL(urls[0]!) };
}

function listPayload(items: readonly OperationDetail[], extra: Record<string, unknown> = {}) {
  return { items, nextCursor: null, prevCursor: null, total: items.length, limit: 20, ...extra };
}

// ---------------------------------------------------------------------------
// 1. One normalization rule, shared with the route
// ---------------------------------------------------------------------------

describe('W-ADMUX03-SHELL-SORT-1: sanitizeSortFilter accepts exactly the route allow-list', () => {
  it('has exactly the six canonical orderings, matching @du/contracts', () => {
    expect(OPERATION_LIST_SORT_OPTIONS.map((o) => o.value)).toEqual([...OPERATIONS_LIST_SORT_VALUES]);
    expect(OPERATION_LIST_SORT_OPTIONS.length).toBe(6);
  });

  it.each([...OPERATIONS_LIST_SORT_VALUES])('canonical %s round-trips unchanged', (value) => {
    expect(sanitizeSortFilter(value)).toBe(value);
  });

  it('applies the same trim/lowercase normalization the route does', () => {
    expect(sanitizeSortFilter(' DEADLINE_AT:Asc ')).toBe('deadline_at:asc');
    expect(sanitizeSortFilter('Created_At:DESC')).toBe('created_at:desc');
  });

  it('names the default ordering exactly like the route resolves an absent sort', () => {
    expect(OPERATION_LIST_DEFAULT_SORT).toBe('created_at:desc');
    expect(sanitizeSortFilter('CREATED_AT:DESC')).toBe(OPERATION_LIST_DEFAULT_SORT);
  });

  it.each([
    'rubbish:asc',
    'created_at:sideways',
    'created_at',
    ':asc',
    'created_at:',
    'name:foo:asc',
    'created_at:asc:desc',
    'deadline_at:asc; DROP',
    '',
    '   ',
  ])('rejects %o without inventing an ordering', (raw) => {
    expect(sanitizeSortFilter(raw)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(sanitizeSortFilter(undefined)).toBeNull();
    expect(sanitizeSortFilter(null)).toBeNull();
    expect(sanitizeSortFilter(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Fetcher -> route: the sort travels; the default stays byte-stable
// ---------------------------------------------------------------------------

describe('W-ADMUX03-SHELL-SORT-1: fetcher forwards the ordering to GET /api/v1/operations', () => {
  it('sends a valid non-default sort and echoes it canonically', async () => {
    const { res, url } = await httpPane(listPayload([OP_A]), { sortFilter: 'deadline_at:asc' });
    expect(url.searchParams.get('sort')).toBe('deadline_at:asc');
    expect(res.kind).toBe('list');
    if (res.kind !== 'list') return;
    expect(res.sort).toBe('deadline_at:asc');
    expect(res.ignoredFilters).toEqual([]);
  });

  it('normalizes a typed-in token before it reaches the URL', async () => {
    const { url } = await httpPane(listPayload([OP_A]), { sortFilter: ' Updated_At:DESC ' });
    expect(url.searchParams.get('sort')).toBe('updated_at:desc');
  });

  it('omits the canonical default so pre-sort deep links stay byte-stable', async () => {
    const absent = await httpPane(listPayload([OP_A]), {});
    expect(absent.url.searchParams.has('sort')).toBe(false);
    const explicitDefault = await httpPane(listPayload([OP_A]), { sortFilter: 'CREATED_AT:desc' });
    expect(explicitDefault.url.searchParams.has('sort')).toBe(false);
    if (explicitDefault.res.kind === 'list') {
      expect(explicitDefault.res.sort).toBe(OPERATION_LIST_DEFAULT_SORT);
    }
  });

  it('drops an invalid sort token: never sent, named in ignoredFilters, never echoed', async () => {
    const junk = 'hunter2:asc';
    const { res, url } = await httpPane(listPayload([OP_A]), { sortFilter: junk });
    expect(url.searchParams.has('sort')).toBe(false);
    expect(url.toString()).not.toContain('hunter2');
    if (res.kind !== 'list') throw new Error('expected a list pane');
    expect(res.ignoredFilters).toContain('sort');
    expect(res.sort).toBe(OPERATION_LIST_DEFAULT_SORT);
  });

  it('sends sort alongside the allow-listed filters', async () => {
    const { url } = await httpPane(listPayload([OP_A]), { sortFilter: 'updated_at:asc', stateFilter: 'RUNNING' });
    expect(url.searchParams.get('sort')).toBe('updated_at:asc');
    expect(url.searchParams.get('state')).toBe('RUNNING');
  });

  it('does not touch the detail path with a list-only parameter', async () => {
    const urls: string[] = [];
    await fetchOperationDetail({
      operationId: 'op-a',
      jsonBaseUrl: 'http://platform.test',
      adminToken: 'bearer-token',
      sortFilter: 'deadline_at:asc',
      fetchImpl: (async (input: string | URL) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ operation: OP_A }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(urls[0]).toContain('/api/v1/operations/op-a');
    expect(urls[0]!).not.toContain('sort');
  });

  it('surfaces the route 422 (hand-crafted cross-sort cursor replay) as an honest error', async () => {
    const problem = {
      type: 'https://du.example/problems/invalid-request',
      title: 'Request validation failed',
      status: 422,
      code: 'INVALID_SCHEMA',
      detail:
        'cursor was issued for sort=created_at:desc and cannot page sort=deadline_at:asc; ' +
        'drop the cursor parameter to start this ordering at its first page',
    };
    const { res } = await httpPane(JSON.stringify(problem), {
      status: 422,
      contentType: 'application/problem+json',
      sortFilter: 'deadline_at:asc',
      cursor: 'eyJhIjoxfQ',
    });
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') return;
    expect(res.message).toContain('HTTP 422');
    expect(res.message).toContain('drop the cursor parameter');
  });
});


// ---------------------------------------------------------------------------
// 3. Shell router: ?sort= is part of the pane query state
// ---------------------------------------------------------------------------

describe('W-ADMUX03-SHELL-SORT-1: parseOperationListQuery carries the raw sort token', () => {
  it('leaves sortFilter undefined when absent or blank', () => {
    expect(parseOperationListQuery({}).sortFilter).toBeUndefined();
    expect(parseOperationListQuery({ sort: '   ' }).sortFilter).toBeUndefined();
  });

  it('reads a raw token without validating it (the fetcher owns validation)', () => {
    expect(parseOperationListQuery({ sort: 'DEADLINE_AT:asc' }).sortFilter).toBe('DEADLINE_AT:asc');
    expect(parseOperationListQuery({ sort: 'anything:goes' }).sortFilter).toBe('anything:goes');
  });

  it('keeps the cursor bound to the sort when a rendered link is re-parsed', async () => {
    const pane = await catalogPane({ sortFilter: 'deadline_at:asc', listLimit: 1 });
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    const href = /<a class="admin-pagination__next" href="([^"]*)"/.exec(html)![1]!;
    const parsed = parseOperationListQuery(Object.fromEntries(qs(href)));
    expect(parsed.sortFilter).toBe('deadline_at:asc');
    expect(parsed.cursor).toBe(pane.nextCursor);
    const next = await catalogPane({ sortFilter: parsed.sortFilter, cursor: parsed.cursor ?? undefined, listLimit: 1 });
    expect(rowIds(next)).toEqual(['op-b']);
    expect(next.sort).toBe('deadline_at:asc');
  });
});

// ---------------------------------------------------------------------------
// 4. Toolbar: the sort control exists and resets the cursor structurally
// ---------------------------------------------------------------------------

describe('W-ADMUX03-SHELL-SORT-1: toolbar sort control (T140-A1 reset is structural)', () => {
  it('renders a sort select with all six options and marks the effective one', async () => {
    const pane = await catalogPane({ sortFilter: 'deadline_at:asc' });
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    expect(html).toContain('<select id="adm-filter-sort" name="sort" data-filter-sort-select>');
    expect(html).toContain('<option value="deadline_at:asc" data-sort-option="deadline_at:asc" selected>Deadline soonest first</option>');
    const optionNeedles = html.match(/data-sort-option="([^"]*)"/g) ?? [];
    expect(optionNeedles.length).toBe(6);
    expect(html).toContain('data-list-sort="deadline_at:asc"');
  });

  it('submits WITHOUT a cursor field, so changing the sort starts page 1', async () => {
    const pane = await catalogPane({ sortFilter: 'deadline_at:asc', cursor: off(1) });
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    const start = html.indexOf('data-filter-bar="true"');
    const end = html.indexOf('</form>', start);
    expect(start).toBeGreaterThanOrEqual(0);
    const form = html.slice(start, end);
    expect(form).toContain('name="sort"');
    expect(form).not.toContain('name="cursor"');
    // The requested page-2 cursor stays on the envelope but can never ride
    // into the next sort change.
    expect(pane.cursor).toBe(off(1));
  });

  it('keeps the default ordering selected when no sort was requested', async () => {
    const pane = await catalogPane({});
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    expect(html).toContain('<option value="created_at:desc" data-sort-option="created_at:desc" selected>Newest first</option>');
  });
});


// ---------------------------------------------------------------------------
// 5. Cursor-carrying links echo the ordering (and vice versa)
// ---------------------------------------------------------------------------

describe('W-ADMUX03-SHELL-SORT-1: links keep cursor and sort together', () => {
  it('next and prev links echo the active sort next to the cursor', async () => {
    // A middle page: page 1 has no prev, the last page has no next.
    const pane = await catalogPane({ sortFilter: 'deadline_at:asc', listLimit: 1, cursor: off(1) });
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    const next = qs(/<a class="admin-pagination__next" href="([^"]*)"/.exec(html)![1]!);
    expect(next.get('sort')).toBe('deadline_at:asc');
    expect(next.get('cursor')).toBe(pane.nextCursor);
    const prev = qs(/<a class="admin-pagination__prev" href="([^"]*)"/.exec(html)![1]!);
    expect(prev.get('sort')).toBe('deadline_at:asc');
    expect(prev.get('cursor')).toBe(pane.prevCursor);
  });

  it('omits sort on default-ordering cursor links (absent means created_at:desc)', async () => {
    const pane = await catalogPane({ listLimit: 1 });
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    const next = qs(/<a class="admin-pagination__next" href="([^"]*)"/.exec(html)![1]!);
    expect(next.has('cursor')).toBe(true);
    expect(next.has('sort')).toBe(false);
  });

  it('page-size links keep the ordering and drop the cursor', async () => {
    const pane = await catalogPane({ sortFilter: 'updated_at:asc', listLimit: 1 });
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    const size50 = qs(/<a href="([^"]*)" data-page-size="50"/.exec(html)![1]!);
    expect(size50.get('sort')).toBe('updated_at:asc');
    expect(size50.has('cursor')).toBe(false);
  });

  it('filter-chip removal keeps the ordering; clear-all drops sort, cursor and filters', async () => {
    const pane = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: fixtureCatalog(),
      listLimit: 20,
      cursor: off(1),
      stateFilter: 'RUNNING',
      sortFilter: 'deadline_at:desc',
    });
    if (pane.kind !== 'list') throw new Error('expected a list pane');
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    const chip = qs(/href="([^"]*)" aria-label="Remove state filter"/.exec(html)![1]!);
    expect(chip.get('sort')).toBe('deadline_at:desc');
    expect(chip.has('cursor')).toBe(false);
    const clearAll = qs(/admin-filter-chip--clear-all" href="([^"]*)"/.exec(html)![1]!);
    expect(clearAll.has('sort')).toBe(false);
    expect(clearAll.has('cursor')).toBe(false);
    expect(clearAll.has('state')).toBe(false);
  });

  it('the back-to-list link re-requests the ordering the echoed cursor belongs to', async () => {
    const detail = await fetchOperationDetail({
      operationId: 'op-a',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: fixtureCatalog(),
      sortFilter: 'deadline_at:asc',
    });
    if (detail.kind !== 'ok') throw new Error('expected a detail pane');
    const html = renderOperationSection({
      fetch: detail,
      selectedOperationId: 'op-a',
      listLimit: 1,
      listCursor: off(1),
      listSort: 'deadline_at:asc',
    }).html;
    const back = qs(/<a href="([^"]*)" data-back-to-list="true"/.exec(html)![1]!);
    expect(back.get('sort')).toBe('deadline_at:asc');
    expect(back.get('cursor')).toBe(off(1));
  });

  it('an invalid typed sort never re-enters a link', async () => {
    const pane = await catalogPane({ sortFilter: 'oops:asc', listLimit: 1 });
    const html = renderOperationSection({ fetch: pane, selectedOperationId: '' }).html;
    expect(html).not.toContain('oops');
    expect(pane.ignoredFilters).toContain('sort');
    const next = qs(/<a class="admin-pagination__next" href="([^"]*)"/.exec(html)![1]!);
    expect(next.has('sort')).toBe(false);
    expect(next.get('cursor')).toBe(pane.nextCursor);
  });
});

// ---------------------------------------------------------------------------
// 6. Offline catalog mirrors the route ordering (controls are exercisable)
// ---------------------------------------------------------------------------

describe('W-ADMUX03-SHELL-SORT-1: catalog order mirrors the route', () => {
  it('keeps the fixture order under the default ordering (W-ADMUX-01 stable)', async () => {
    const pane = await catalogPane({});
    expect(rowIds(pane)).toEqual(['op-c', 'op-a', 'op-b']);
  });

  it.each([
    ['created_at:asc', ['op-a', 'op-b', 'op-c']],
    ['updated_at:desc', ['op-a', 'op-b', 'op-c']],
    ['deadline_at:asc', ['op-c', 'op-b', 'op-a']],
    ['deadline_at:desc', ['op-b', 'op-c', 'op-a']],
  ] as const)('%s orders the population %j', async (sort, want) => {
    const pane = await catalogPane({ sortFilter: sort });
    expect(rowIds(pane)).toEqual([...want]);
    expect(pane.total).toBe(3);
    expect(pane.sort).toBe(sort);
  });

  it('orders NULL deadlines LAST in both directions (sentinel mirror)', async () => {
    const expected: Record<string, readonly string[]> = {
      'deadline_at:asc': ['op-c', 'op-b', 'op-a'],
      'deadline_at:desc': ['op-b', 'op-c', 'op-a'],
    };
    for (const sort of ['deadline_at:asc', 'deadline_at:desc']) {
      const walk: string[] = [];
      let cursor: string | undefined;
      for (let hop = 0; hop < 5; hop += 1) {
        const page = await catalogPane({ sortFilter: sort, listLimit: 1, cursor });
        walk.push(...rowIds(page));
        cursor = page.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(walk).toEqual([...expected[sort]!]);
      expect(walk.at(-1)).toBe('op-a');
    }
  });

  it('pages a sorted walk end-to-end: every row exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let hop = 0; hop < 5; hop += 1) {
      const page = await catalogPane({ sortFilter: 'created_at:asc', listLimit: 1, cursor });
      expect(page.sort).toBe('created_at:asc');
      seen.push(...rowIds(page));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(['op-a', 'op-b', 'op-c']);
  });

  it('filters still scope the sorted population (filter -> order -> page)', async () => {
    const mixed = await fetchOperationDetail({
      operationId: '',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: {
        entries: [
          catalogEntry(makeOp('op-d', { state: 'SUCCEEDED', deadlineAt: '2026-10-01T00:00:00Z' })),
          catalogEntry(OP_C),
          catalogEntry(OP_B),
        ],
      },
      listLimit: 20,
      sortFilter: 'deadline_at:asc',
      stateFilter: 'RUNNING',
    });
    if (mixed.kind !== 'list') throw new Error('expected a list pane');
    expect(mixed.total).toBe(2);
    expect(rowIds(mixed)).toEqual(['op-c', 'op-b']);
  });
});



