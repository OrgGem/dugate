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
import { off, makeOp, catalogEntry, catalogOf, recordingFetch } from './helpers/operations-page-fixture';



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
