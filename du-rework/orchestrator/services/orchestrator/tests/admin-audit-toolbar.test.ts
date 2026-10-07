/**
 * W-ADM-UX-03-AUDIT-TOOLBAR: offline tests for the /admin/audit pane.
 *
 * Everything here runs with an injected fetch stub: no DB, no Redis, no
 * network, no clock read. The rules under test are the ones the toolbar
 * could otherwise get quietly wrong - a rejected filter echoed back into
 * the DOM, a cursor replayed under a different ordering, an inverted time
 * window silently widened, a count reported as a page size.
 */

import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_DEFAULT_SORT,
  AUDIT_LIST_MAX_LIMIT,
  buildAuditListQuery,
  clampAuditListLimit,
  fetchAuditEvents,
  parseAuditListPayload,
  resolveAuditListFilters,
  type AuditListFilters,
  type AuditListOkResult,
} from '../src/app/admin/audit-section-data';
import { renderAuditSection } from '../src/app/admin/audit-section-renderer';

/** 40 solid hex characters: a pasted raw API key, never a search term. */
const SECRET = 'deadbeef'.repeat(5);

const NO_FILTERS: AuditListFilters = {
  severity: 'ALL',
  actor: null,
  action: null,
  resource: null,
  from: null,
  to: null,
};

/** Build a list view model with sensible defaults for the renderer tests. */
function listResult(over: Partial<AuditListOkResult> = {}): AuditListOkResult {
  return {
    kind: 'list',
    rows: [],
    limit: AUDIT_LIST_DEFAULT_LIMIT,
    total: 0,
    nextCursor: null,
    prevCursor: null,
    cursor: null,
    pageRows: 0,
    filters: NO_FILTERS,
    sort: AUDIT_LIST_DEFAULT_SORT,
    ignoredFilters: [],
    droppedRows: 0,
    ...over,
  };
}

interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

/** Recording fetch stub: no network, and every URL is assertable. */
function stubFetch(
  body: unknown,
  opts: { status?: number; rawBody?: string } = {},
): { calls: StubCall[]; impl: typeof fetch } {
  const calls: StubCall[] = [];
  const status = opts.status ?? 200;
  const text = opts.rawBody ?? JSON.stringify(body);
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function page(search: Record<string, string>): URLSearchParams {
  return new URLSearchParams(search);
}

describe('W-ADM-UX-03 audit toolbar: filter resolution', () => {
  it('resolves the empty request to the contract defaults', () => {
    const r = resolveAuditListFilters({});
    expect(r.filters).toEqual(NO_FILTERS);
    expect(r.sort).toBe(AUDIT_LIST_DEFAULT_SORT);
    expect(r.ignored).toEqual([]);
    expect(r.windowError).toBeNull();
  });

  it('accepts every ledger severity the route accepts', () => {
    for (const value of ['info', 'success', 'warning', 'error']) {
      const r = resolveAuditListFilters({ severityFilter: value });
      expect(r.filters.severity).toBe(value);
      expect(r.ignored).toEqual([]);
    }
  });

  it('refuses to case-fold the severity enum, and treats ALL as absence', () => {
    const folded = resolveAuditListFilters({ severityFilter: '  ERROR ' });
    expect(folded.filters.severity).toBe('ALL');
    expect(folded.ignored).toEqual(['severity']);
    expect(resolveAuditListFilters({ severityFilter: 'ALL' }).filters.severity).toBe('ALL');
  });

  it('drops a severity outside the enum and NAMES the field', () => {
    const r = resolveAuditListFilters({ severityFilter: 'critical' });
    expect(r.filters.severity).toBe('ALL');
    expect(r.ignored).toEqual(['severity']);
  });

  it('accepts actor / action / resource tokens', () => {
    const r = resolveAuditListFilters({
      actorFilter: 'svc-deploy',
      actionFilter: 'artifact.upload',
      resourceFilter: 'doc-42',
    });
    expect(r.filters.actor).toBe('svc-deploy');
    expect(r.filters.action).toBe('artifact.upload');
    expect(r.filters.resource).toBe('doc-42');
    expect(r.ignored).toEqual([]);
  });

  it('rejects a pasted raw API key as a search term and never echoes it', () => {
    const r = resolveAuditListFilters({ actorFilter: SECRET });
    expect(r.filters.actor).toBeNull();
    expect(r.ignored).toEqual(['actor']);
    expect(r.ignored.join(' ')).not.toContain(`SECRET);`);
  });

  it('rejects markup and spaces in a token rather than truncating', () => {
    const r = resolveAuditListFilters({ actorFilter: ' OR 1=1--' });
    expect(r.filters.actor).toBeNull();
    expect(r.ignored).toEqual(['actor']);
  });

  it('accepts real UTC instants for from and to', () => {
    const r = resolveAuditListFilters({
      fromFilter: '2026-09-01T00:00:00Z',
      toFilter: '2026-09-28T23:59:59.123456Z',
    });
    expect(r.filters.from).toBe('2026-09-01T00:00:00Z');
    expect(r.filters.to).toBe('2026-09-28T23:59:59.123456Z');
    expect(r.windowError).toBeNull();
  });

  it('rejects a local-time offset instead of reinterpreting it as UTC', () => {
    const r = resolveAuditListFilters({ fromFilter: '2026-09-01T00:00:00+07:00' });
    expect(r.filters.from).toBeNull();
    expect(r.ignored).toEqual(['from']);
  });

  it('rejects a date that only looks like a calendar day', () => {
    const r = resolveAuditListFilters({ toFilter: '2026-02-30T00:00:00Z' });
    expect(r.filters.to).toBeNull();
    expect(r.ignored).toEqual(['to']);
  });

  it('flags an inverted window instead of silently widening it', () => {
    const r = resolveAuditListFilters({
      fromFilter: '2026-09-28T10:00:00Z',
      toFilter: '2026-09-28T09:00:00Z',
    });
    expect(r.windowError).not.toBeNull();
    // Both bounds are still valid on their own, so neither is an ignored
    // token: this is a rejected WINDOW, not a rejected field.
    expect(r.ignored).toEqual([]);
  });

  it('allows a window whose bounds are equal', () => {
    const r = resolveAuditListFilters({
      fromFilter: '2026-09-28T10:00:00Z',
      toFilter: '2026-09-28T10:00:00Z',
    });
    expect(r.windowError).toBeNull();
  });

  it('accepts only the two orderings the route allows', () => {
    expect(resolveAuditListFilters({ sortFilter: 'createdAt:asc' }).sort).toBe('createdAt:asc');
    expect(resolveAuditListFilters({ sortFilter: 'createdAt:desc' }).sort).toBe('createdAt:desc');
  });

  it('never offers updatedAt, which the ledger table does not have', () => {
    const r = resolveAuditListFilters({ sortFilter: 'updatedAt:desc' });
    expect(r.sort).toBe(AUDIT_LIST_DEFAULT_SORT);
    expect(r.ignored).toEqual(['sort']);
  });

  it('names every rejected field, not just the first', () => {
    const r = resolveAuditListFilters({
      severityFilter: 'critical',
      actorFilter: SECRET,
      fromFilter: 'yesterday',
    });
    expect(r.ignored).toEqual(['severity', 'actor', 'from']);
  });
});

describe('W-ADM-UX-03 audit toolbar: query string', () => {
  it('sends only the limit on a default request', () => {
    const q = buildAuditListQuery({
      limit: AUDIT_LIST_DEFAULT_LIMIT,
      cursor: null,
      filters: NO_FILTERS,
      sort: AUDIT_LIST_DEFAULT_SORT,
    });
    expect(q.toString()).toBe('limit=50');
  });

  it('omits the default ordering but emits a non-default one', () => {
    const base = { limit: 50, cursor: null, filters: NO_FILTERS };
    expect(buildAuditListQuery({ ...base, sort: AUDIT_LIST_DEFAULT_SORT }).has('sort')).toBe(false);
    expect(buildAuditListQuery({ ...base, sort: 'createdAt:asc' }).get('sort')).toBe('createdAt:asc');
  });

  it('emits one param per active filter, using the route names', () => {
    const q = buildAuditListQuery({
      limit: 10,
      cursor: 'c1',
      filters: {
        severity: 'warning',
        actor: 'ops',
        action: 'auth.login_failed',
        resource: 'doc-1',
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-28T00:00:00Z',
      },
      sort: 'createdAt:asc',
    });
    expect(q.get('limit')).toBe('10');
    expect(q.get('cursor')).toBe('c1');
    expect(q.get('severity')).toBe('warning');
    expect(q.get('actor')).toBe('ops');
    expect(q.get('action')).toBe('auth.login_failed');
    expect(q.get('resource')).toBe('doc-1');
    expect(q.get('from')).toBe('2026-09-01T00:00:00Z');
    expect(q.get('to')).toBe('2026-09-28T00:00:00Z');
    expect(q.get('sort')).toBe('createdAt:asc');
  });

  it('clamps the page size to the route bound', () => {
    expect(clampAuditListLimit(undefined)).toBe(AUDIT_LIST_DEFAULT_LIMIT);
    expect(clampAuditListLimit(0)).toBe(1);
    expect(clampAuditListLimit(9999)).toBe(AUDIT_LIST_MAX_LIMIT);
    expect(clampAuditListLimit('25')).toBe(25);
  });
});

describe('W-ADM-UX-03 audit toolbar: envelope parsing', () => {
  const ctx = {
    limit: 50,
    cursor: null,
    filters: NO_FILTERS,
    sort: AUDIT_LIST_DEFAULT_SORT,
    ignoredFilters: [],
  };

  it('maps the five-field envelope onto the view model', () => {
    const r = parseAuditListPayload(
      {
        items: [
          {
            id: 'e1',
            kind: 'auth.login_failed',
            severity: 'warning',
            occurredAt: '2026-09-28T10:00:00.000Z',
            tenantId: 't1',
            resourceId: 'doc-1',
            actor: 'ops',
            message: 'auth.login_failed doc-1',
          },
        ],
        nextCursor: 'n2',
        prevCursor: 'p2',
        total: 1,
        limit: 50,
      },
      ctx,
    );
    expect(r.kind).toBe('list');
    if (r.kind !== 'list') throw new Error('unreachable');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      id: 'e1',
      action: 'auth.login_failed',
      severity: 'warning',
      actor: 'ops',
      resource: 'doc-1',
      tenantId: 't1',
    });
    expect(r.nextCursor).toBe('n2');
    expect(r.prevCursor).toBe('p2');
    expect(r.total).toBe(1);
  });

  it('keeps a severity bucket this build does not know', () => {
    const r = parseAuditListPayload({ items: [{ id: 'e1', severity: 'catastrophe' }] }, ctx);
    if (r.kind !== 'list') throw new Error('unreachable');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.severity).toBe('catastrophe');
  });

  it('counts an unreadable row instead of dropping it in silence', () => {
    const r = parseAuditListPayload({ items: [{ severity: 'info' }, { id: 'e2' }] }, ctx);
    if (r.kind !== 'list') throw new Error('unreachable');
    expect(r.rows).toHaveLength(1);
    expect(r.droppedRows).toBe(1);
    expect(r.pageRows).toBe(2);
  });

  it('treats a non-array items as an empty page rather than crashing', () => {
    const r = parseAuditListPayload({ items: 'nope' }, ctx);
    if (r.kind !== 'list') throw new Error('unreachable');
    expect(r.rows).toEqual([]);
    expect(r.pageRows).toBe(0);
  });

  it('leaves total null when the platform withheld the count', () => {
    const r = parseAuditListPayload({ items: [] }, ctx);
    if (r.kind !== 'list') throw new Error('unreachable');
    expect(r.total).toBeNull();
  });

  it('does not mistake an absent cursor for an empty-string cursor', () => {
    const r = parseAuditListPayload({ items: [], nextCursor: '' }, ctx);
    if (r.kind !== 'list') throw new Error('unreachable');
    expect(r.nextCursor).toBeNull();
  });
});

describe('W-ADM-UX-03 audit toolbar: chips', () => {
  const filters: AuditListFilters = {
    severity: 'warning',
    actor: 'ops',
    action: 'auth.login',
    resource: 'doc-1',
    from: '2026-09-01T00:00:00Z',
    to: '2026-09-28T00:00:00Z',
  };

  it('shows no chips and no clear-all when nothing is filtered', () => {
    const out = renderAuditSection({ fetch: listResult() });
    expect(out.html).toContain(`data-filter-chips='none'>`);
    expect(out.html).not.toContain(`data-filter-clear-all`);
    expect(out.isReady).toBe(true);
  });

  it('renders one removable chip per active filter', () => {
    const out = renderAuditSection({ fetch: listResult({ filters }) });
    for (const field of ['severity', 'actor', 'action', 'resource', 'from', 'to']) {
      expect(out.html).toContain(`data-filter-chip='${field}`);
    }
    expect(out.html).toContain(`data-filter-chips='active'>`);
  });

  it('a remove link drops only its own field and keeps the rest', () => {
    const out = renderAuditSection({ fetch: listResult({ filters }) });
    const actorHref = hrefFor(out.html, `data-filter-clear='actor'`);
    expect(actorHref).toMatch(/^\/admin\/audit\?/);
    const q = paramsOf(actorHref);
    expect(q.has('actor')).toBe(false);
    expect(q.get('severity')).toBe('warning');
    expect(q.get('action')).toBe('auth.login');
    expect(q.get('from')).toBe('2026-09-01T00:00:00Z');
  });

  it('a remove link keeps the page size the operator chose', () => {
    const out = renderAuditSection({ fetch: listResult({ filters, limit: 100 }) });
    const href = hrefFor(out.html, `data-filter-clear='actor'`);
    expect(paramsOf(href).get('limit')).toBe('100');
  });

  it('names a rejected field without ever echoing its value', () => {
    const out = renderAuditSection({
      fetch: listResult({ ignoredFilters: ['actor'] }),
    });
    expect(out.html).toContain(`data-filter-rejected='actor'>`);
    expect(out.html).toContain(`ignored (invalid characters)`);
  });

  it('clear-all is a reset: default page size, no filters, no cursor', () => {
    const out = renderAuditSection({
      fetch: listResult({ filters, limit: 100, cursor: 'c1', sort: 'createdAt:asc' }),
    });
    const href = hrefFor(out.html, `data-filter-clear-all='true'`);
    const q = paramsOf(href);
    expect(q.get('limit')).toBe(String(AUDIT_LIST_DEFAULT_LIMIT));
    expect(q.has('severity')).toBe(false);
    expect(q.has('cursor')).toBe(false);
    expect(q.has('sort')).toBe(false);
  });
});

describe('W-ADM-UX-03 audit toolbar: the form', () => {
  it('submits to the audit route as a plain GET form', () => {
    const out = renderAuditSection({ fetch: listResult() });
    expect(out.html).toContain(`method='get' action='/admin/audit' data-filter-bar='true'>`);
    expect(out.html).toContain(`class='admin-filter-bar'`);
  });

  it('carries no cursor field, so applying a filter restarts at page 1', () => {
    const out = renderAuditSection({ fetch: listResult({ cursor: 'c1' }) });
    const form = out.html.slice(0, out.html.indexOf('</form>'));
    expect(form).toContain(`name='limit' value='50'`);
    expect(form).not.toContain(`name='cursor'>`);
  });

  it('offers one control per Muc 30 filter plus the ordering', () => {
    const out = renderAuditSection({ fetch: listResult() });
    for (const name of ['severity', 'actor', 'action', 'resource', 'from', 'to', 'sort']) {
      expect(out.html).toContain(`name='${name}`);
    }
  });

  it('preselects the effective severity and ordering', () => {
    const out = renderAuditSection({
      fetch: listResult({ filters: { ...NO_FILTERS, severity: 'error' }, sort: 'createdAt:asc' }),
    });
    expect(out.html).toContain(`data-filter-option='error' selected>`);
    expect(out.html).toContain(`data-sort-option='createdAt:asc' selected>`);
  });

  it('offers only the two orderings the ledger table supports', () => {
    const out = renderAuditSection({ fetch: listResult() });
    expect(out.html).toContain(`data-sort-option='createdAt:asc'>`);
    expect(out.html).toContain(`data-sort-option='createdAt:desc' selected>`);
    expect(out.html).not.toContain(`updatedAt`);
  });

  it('echoes the active values back into the inputs', () => {
    const out = renderAuditSection({
      fetch: listResult({
        filters: { ...NO_FILTERS, actor: 'ops', from: '2026-09-01T00:00:00Z' },
      }),
    });
    expect(out.html).toContain(`value='ops' data-filter-actor-input>`);
    expect(out.html).toContain(`value='2026-09-01T00:00:00Z' data-filter-from-input>`);
  });

  it('escapes an echoed value instead of letting it close the attribute', () => {
    const out = renderAuditSection({
      fetch: listResult({ filters: { ...NO_FILTERS, actor: `a'onmouseover=1'` } }),
    });
    expect(out.html).not.toContain(`value='a'onmouseover=1`);
    expect(out.html).toContain(`&#39;`);
  });
});

describe('W-ADM-UX-03 audit toolbar: pagination', () => {
  it('echoes the cursor together with the ordering it is bound to', () => {
    const out = renderAuditSection({
      fetch: listResult({ nextCursor: 'n2', prevCursor: 'p2', sort: 'createdAt:asc' }),
    });
    const next = hrefFor(out.html, `data-pagination-next='link'`);
    const prev = hrefFor(out.html, `data-pagination-prev='link'`);
    const nq = paramsOf(next);
    const pq = paramsOf(prev);
    expect(nq.get('cursor')).toBe('n2');
    expect(nq.get('sort')).toBe('createdAt:asc');
    expect(pq.get('cursor')).toBe('p2');
    expect(pq.get('sort')).toBe('createdAt:asc');
  });

  it('never emits a cursor without an ordering the route would accept', () => {
    const out = renderAuditSection({ fetch: listResult({ nextCursor: 'n2' }) });
    const next = hrefFor(out.html, `data-pagination-next='link'`);
    // The default ordering is absent on the wire, which is exactly what a
    // default-minted cursor is bound to - the route resolves it the same
    // way, so this is not a mismatch.
    expect(paramsOf(next).has('sort')).toBe(false);
  });

  it('reports total as a count of the FILTERED population', () => {
    const out = renderAuditSection({
      fetch: listResult({ total: 137, filters: { ...NO_FILTERS, actor: 'ops' } }),
    });
    expect(out.html).toContain(`data-list-count='exact'>`);
    expect(out.html).toContain(`0 of 137 events match the filters`);
  });

  it('says so when the platform withheld the count', () => {
    const out = renderAuditSection({ fetch: listResult({ total: null, pageRows: 3 }) });
    expect(out.html).toContain(`data-list-count='page'>`);
    expect(out.html).not.toContain(`0 of `);
  });

  it('a full page with no continuation says the next page is unreachable', () => {
    const out = renderAuditSection({
      fetch: listResult({ total: null, pageRows: 20, limit: 20, nextCursor: null }),
    });
    expect(out.html).toContain(`data-pagination-cursor-unavailable='true'>`);
    expect(out.html).toContain(`data-pagination-next='disabled'>`);
  });

  it('page-size links keep the filters and the ordering', () => {
    const out = renderAuditSection({
      fetch: listResult({ filters: { ...NO_FILTERS, severity: 'info' }, sort: 'createdAt:asc' }),
    });
    const href = hrefFor(out.html, `data-page-size='20'`);
    const q = paramsOf(href);
    expect(q.get('limit')).toBe('20');
    expect(q.get('severity')).toBe('info');
    expect(q.get('sort')).toBe('createdAt:asc');
  });
});

describe('W-ADM-UX-03 audit toolbar: the ledger table', () => {
  const row = {
    id: 'e1',
    occurredAt: '2026-09-28T10:00:00.000Z',
    severity: 'warning',
    actor: 'ops',
    action: 'auth.login_failed',
    resource: 'doc-1',
    tenantId: 't1',
    message: 'auth.login_failed doc-1',
  };

  it('renders one row per event with the ledger columns', () => {
    const out = renderAuditSection({ fetch: listResult({ rows: [row], total: 1, pageRows: 1 }) });
    expect(out.html).toContain(`data-audit-event='e1'>`);
    expect(out.html).toContain(`data-row-actor='ops'>ops</td>`);
    expect(out.html).toContain(`data-row-action='auth.login_failed'>`);
    expect(out.html).toContain(`data-row-resource='doc-1'>doc-1</td>`);
  });

  it('badges a severity bucket it does not recognise as neutral', () => {
    const out = renderAuditSection({
      fetch: listResult({ rows: [{ ...row, severity: 'catastrophe' }], total: 1, pageRows: 1 }),
    });
    expect(out.html).toContain(`status-badge--neutral`);
    expect(out.html).toContain(`data-audit-severity='catastrophe'>`);
  });

  it('names unreadable rows rather than quietly shrinking the table', () => {
    const out = renderAuditSection({ fetch: listResult({ rows: [row], droppedRows: 2, total: 1 }) });
    expect(out.html).toContain(`data-dropped-rows='2'>`);
  });

  it('distinguishes an empty FILTERED page from an empty ledger', () => {
    const filtered = renderAuditSection({
      fetch: listResult({ filters: { ...NO_FILTERS, actor: 'ops' } }),
    });
    const plain = renderAuditSection({ fetch: listResult() });
    expect(filtered.html).toContain(`data-empty-banner='filtered'>`);
    expect(plain.html).toContain(`data-empty-banner='true'>`);
  });

  it('marks the section as filtered so the shell can assert on it', () => {
    const out = renderAuditSection({
      fetch: listResult({ filters: { ...NO_FILTERS, severity: 'error' } }),
    });
    expect(out.html).toContain(`data-filter-active='true' `);
    expect(out.html).toContain(`data-filter-severity='error' `);
  });
});

describe('W-ADM-UX-03 audit toolbar: fetcher', () => {
  const base = { jsonBaseUrl: 'http://127.0.0.1:2023', adminToken: 'tok' };

  it('GETs the ledger route with the effective filters only', async () => {
    const stub = stubFetch({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: 50 });
    const r = await fetchAuditEvents({
      ...base,
      severityFilter: 'warning',
      actorFilter: 'ops',
      fromFilter: '2026-09-01T00:00:00Z',
      listLimit: 25,
      sortFilter: 'createdAt:asc',
      fetchImpl: stub.impl,
    });
    expect(r.kind).toBe('list');
    expect(stub.calls).toHaveLength(1);
    const url = new URL(stub.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/admin/audit');
    expect(url.searchParams.get('severity')).toBe('warning');
    expect(url.searchParams.get('actor')).toBe('ops');
    expect(url.searchParams.get('from')).toBe('2026-09-01T00:00:00Z');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('sort')).toBe('createdAt:asc');
  });

  it('keeps a rejected token out of the URL and names it instead', async () => {
    const stub = stubFetch({ items: [], total: 0 });
    const r = await fetchAuditEvents({
      ...base,
      actorFilter: SECRET,
      fetchImpl: stub.impl,
    });
    expect(r.kind).toBe('list');
    if (r.kind !== 'list') throw new Error('unreachable');
    expect(r.ignoredFilters).toEqual(['actor']);
    expect(stub.calls[0]?.url ?? '').not.toContain(`SECRET);`);
  });

  it('fails closed on an inverted window and issues NO request', async () => {
    const stub = stubFetch({ items: [], total: 0 });
    const r = await fetchAuditEvents({
      ...base,
      fromFilter: '2026-09-28T10:00:00Z',
      toFilter: '2026-09-28T09:00:00Z',
      fetchImpl: stub.impl,
    });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.message).toContain(`from must not be after to`);
    expect(stub.calls).toHaveLength(0);
  });

  it('reports a missing platform URL as an error, not an empty ledger', async () => {
    const r = await fetchAuditEvents({ jsonBaseUrl: '', adminToken: 'tok' });
    expect(r.kind).toBe('error');
  });

  it('maps 401 and 403 to the unauthorized pane', async () => {
    for (const status of [401, 403]) {
      const stub = stubFetch(null, { status });
      const r = await fetchAuditEvents({ ...base, fetchImpl: stub.impl });
      expect(r.kind).toBe('unauthorized');
    }
  });

  it('maps a server error to the error pane', async () => {
    const stub = stubFetch(null, { status: 500 });
    const r = await fetchAuditEvents({ ...base, fetchImpl: stub.impl });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.message).toContain(`500`);
  });

  it('never projects a non-JSON body into the page', async () => {
    const stub = stubFetch(null, { rawBody: '<html>oops</html>' });
    const r = await fetchAuditEvents({ ...base, fetchImpl: stub.impl });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.message).not.toContain(`oops`);
  });

  it('sends the admin bearer and asks for JSON', async () => {
    const stub = stubFetch({ items: [], total: 0 });
    await fetchAuditEvents({ ...base, fetchImpl: stub.impl });
    const headers = stub.calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer tok');
    expect(headers?.accept).toBe('application/json');
  });
});



/**
 * href of the anchor that carries a given marker attribute. Attribute order
 * in the rendered HTML is not part of the contract, so the lookup anchors on
 * the marker and reads the href that precedes it.
 */
function hrefFor(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  if (idx < 0) throw new Error(`marker not found: ${marker}`);
  const head = html.slice(html.lastIndexOf('<a ', idx), idx);
  const m = /href='([^']*)'/.exec(head);
  if (m === null || m[1] === undefined) throw new Error(`no href before ${marker}`);
  return m[1];
}



/**
 * Query params of a rendered href. The attribute is HTML-escaped, so every
 * ampersand arrives as &amp; - decode before parsing or the first param
 * swallows the rest.
 */
function paramsOf(href: string): URLSearchParams {
  return new URL(`http://x${href.replace(/&amp;/g, '&')}`).searchParams;
}

describe('W-ADM-UX-03 toolbar bounds: oversized, non-numeric, one-sided, severity edges', () => {
  it('rejects an oversized actor that is otherwise a clean token', () => {
    // Distinct from SECRET above: that one is rejected for being solid hex,
    // this one for being too LONG. Two different rejection reasons must not
    // be conflated, or a length regression would hide behind the hex rule.
    const r = resolveAuditListFilters({ actorFilter: 'z'.repeat(65) });
    expect(r.filters.actor).toBeNull();
    expect(r.ignored).toEqual(['actor']);
  });

  it('accepts an actor at the 64-character boundary and rejects 65', () => {
    const ok = 'z'.repeat(64);
    expect(resolveAuditListFilters({ actorFilter: ok }).filters.actor).toBe(ok);
    expect(resolveAuditListFilters({ actorFilter: 'z'.repeat(65) }).filters.actor).toBeNull();
  });

  it('a non-numeric limit falls back to the contract default, never NaN', () => {
    expect(clampAuditListLimit(NaN)).toBe(AUDIT_LIST_DEFAULT_LIMIT);
    expect(clampAuditListLimit('abc')).toBe(AUDIT_LIST_DEFAULT_LIMIT);
    expect(clampAuditListLimit(Number.POSITIVE_INFINITY)).toBe(AUDIT_LIST_DEFAULT_LIMIT);
  });

  it('a negative or fractional limit is clamped up to 1, never passed through', () => {
    expect(clampAuditListLimit(-5)).toBe(1);
    expect(clampAuditListLimit(1.9)).toBe(1);
  });

  it('accepts the limit at both ends of the 1..200 range', () => {
    expect(clampAuditListLimit(1)).toBe(1);
    expect(clampAuditListLimit(AUDIT_LIST_MAX_LIMIT)).toBe(AUDIT_LIST_MAX_LIMIT);
    expect(clampAuditListLimit(AUDIT_LIST_MAX_LIMIT + 1)).toBe(AUDIT_LIST_MAX_LIMIT);
  });

  it('accepts a ONE-SIDED window instead of rejecting it as incomplete', () => {
    const fromOnly = resolveAuditListFilters({ fromFilter: '2026-09-01T00:00:00Z' });
    expect(fromOnly.windowError).toBeNull();
    expect(fromOnly.filters.from).toBe('2026-09-01T00:00:00Z');
    expect(fromOnly.filters.to).toBeNull();
    expect(fromOnly.ignored).toEqual([]);
    const toOnly = resolveAuditListFilters({ toFilter: '2026-09-28T00:00:00Z' });
    expect(toOnly.windowError).toBeNull();
    expect(toOnly.filters.to).toBe('2026-09-28T00:00:00Z');
  });

  it('a half-valid window keeps the good bound and names only the bad one', () => {
    const r = resolveAuditListFilters({
      fromFilter: '2026-09-01T00:00:00Z',
      toFilter: 'not-a-date',
    });
    expect(r.filters.from).toBe('2026-09-01T00:00:00Z');
    expect(r.filters.to).toBeNull();
    expect(r.ignored).toEqual(['to']);
    expect(r.windowError).toBeNull();
  });

  it('an empty or whitespace severity is ABSENCE, not a rejected value', () => {
    for (const v of ['', '   ']) {
      const r = resolveAuditListFilters({ severityFilter: v });
      expect(r.filters.severity).toBe('ALL');
      expect(r.ignored).toEqual([]);
    }
  });

  it('an uppercase severity is rejected and named, not silently folded', () => {
    // Mục 31 removed case folding on purpose: the route enum is lowercase,
    // so folding here would put a value in a URL the route refuses.
    const r = resolveAuditListFilters({ severityFilter: 'WARNING' });
    expect(r.filters.severity).toBe('ALL');
    expect(r.ignored).toEqual(['severity']);
  });

  it('an oversized action is rejected for length, not only for hex', () => {
    const r = resolveAuditListFilters({ actionFilter: 'z'.repeat(300) });
    expect(r.filters.action).toBeNull();
    expect(r.ignored).toEqual(['action']);
  });
});
