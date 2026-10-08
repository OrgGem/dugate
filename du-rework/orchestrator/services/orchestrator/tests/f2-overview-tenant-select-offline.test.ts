/**
 * F-2 — Overview tenant picker must be roster-backed (offline).
 *
 * FAIL-FIRST SUITE. On the pre-fix tree the overview emitted a free-text
 * `<input name="tenantId" placeholder="All tenants">`, and a platform
 * session with no `?tenantId=` still issued `GET /api/v1/usage` — the
 * upstream answers 422 for an admin principal without a tenant
 * (`http/routes/public.ts:191-192`), which `fetchOverview` turns into a
 * fatal `kind:'error'` for the whole pane.
 *
 * Post-fix contract:
 *  - the tenant control is a roster-backed `<select name="tenantId">`
 *    whose option labels are tenant NAMES (never raw ids);
 *  - an empty tenant selection issues NO usage/audit request and renders
 *    an explicit `data-overview-tenant-required` "Select a tenant" state;
 *  - a selected tenant keeps the existing usage + audit reads;
 *  - a roster failure is fail-closed: empty select, no error text, no
 *    fallback to an unscoped usage call.
 *
 * Scope: `overview-section-data` + `overview-section-renderer` only.
 * No listener, no DB, no network — every request is an injected `fetchImpl`.
 */

import { fetchOverview, fetchTenantOptions } from '../src/app/admin/overview-section-data';
import { renderOverviewSection } from '../src/app/admin/overview-section-renderer';

const BASE = 'http://127.0.0.1:1';
const TOKEN = 'f2-admin-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ROSTER_PAGE = {
  items: [
    { id: TENANT_A, name: 'Alpha', state: 'ACTIVE' },
    { id: TENANT_B, name: 'Beta', state: 'SUSPENDED' },
  ],
  nextCursor: null,
  prevCursor: null,
  total: 2,
  limit: 200,
};

/** Platform stub: roster + usage + audit + health + operation counts. */
function platformFetch(
  calls: string[],
  roster: Response | 'throw' = jsonResponse(ROSTER_PAGE),
): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/api/v1/admin/tenants')) {
      if (roster === 'throw') throw new Error('roster transport boom');
      return roster;
    }
    if (href.includes('/api/v1/usage')) {
      return jsonResponse({
        tenantId: TENANT_A,
        rows: [
          {
            provider: 'openai',
            model: 'gpt-4o-mini',
            operations: 1,
            inputTokens: 10,
            outputTokens: 20,
            pages: 1,
            costMicrousd: 1000,
            measurement: 'measured',
          },
        ],
        totals: { operations: 1, inputTokens: 10, outputTokens: 20, pages: 1, costMicrousd: 1000 },
      });
    }
    if (href.includes('/api/v1/admin/audit')) {
      return jsonResponse({ tenantId: TENANT_A, items: [], total: 0, limit: 50 });
    }
    if (href.includes('/api/v1/health')) {
      return jsonResponse({ status: 'ok', db: true, redis: true, activeLeases: 0 });
    }
    return jsonResponse({ items: [], total: 0, limit: 1 });
  }) as unknown as typeof fetch;
}

const countOf = (calls: string[], needle: string): number =>
  calls.filter((href) => href.includes(needle)).length;

describe('F-2 overview tenant picker (roster-backed, offline)', () => {
  it('does not render a free-text tenantId input', async () => {
    const calls: string[] = [];
    const result = await fetchOverview({
      tenantId: TENANT_A,
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls),
    });
    const html = renderOverviewSection({ fetch: result, selectedTenantId: TENANT_A }).html;

    expect(html).not.toContain('placeholder="All tenants"');
    expect(html).not.toMatch(/<input[^>]*name="tenantId"/);
  });

  it('renders a roster-backed select whose labels are tenant names', async () => {
    const calls: string[] = [];
    const result = await fetchOverview({
      tenantId: TENANT_A,
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls),
    });
    const html = renderOverviewSection({ fetch: result, selectedTenantId: TENANT_A }).html;

    expect(html).toContain('<select name="tenantId"');
    expect(html).toContain(`<option value="${TENANT_A}" selected>Alpha</option>`);
    expect(html).toContain(`<option value="${TENANT_B}">Beta (SUSPENDED)</option>`);
    // The id is an option VALUE only — never the visible label.
    expect(html).not.toContain(`>${TENANT_A}</option>`);
    expect(html).not.toContain(`>${TENANT_B}</option>`);
  });

  it('issues no usage or audit request when no tenant is selected', async () => {
    const calls: string[] = [];
    const result = await fetchOverview({
      tenantId: '',
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls),
    });

    expect(result.kind).toBe('ok');
    expect(countOf(calls, '/api/v1/usage')).toBe(0);
    expect(countOf(calls, '/api/v1/admin/audit')).toBe(0);

    const html = renderOverviewSection({ fetch: result, selectedTenantId: '' }).html;
    expect(html).toContain('data-overview-tenant-required="true"');
    expect(html).toContain('Select a tenant');
    expect(html).not.toContain('data-usage-tenant=');
  });

  it('keeps the usage + audit reads for a selected tenant', async () => {
    const calls: string[] = [];
    const result = await fetchOverview({
      tenantId: TENANT_A,
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls),
    });

    expect(result.kind).toBe('ok');
    expect(countOf(calls, '/api/v1/usage')).toBe(1);
    expect(countOf(calls, '/api/v1/admin/audit')).toBe(1);
    expect(countOf(calls, '/api/v1/admin/tenants')).toBe(1);

    const html = renderOverviewSection({ fetch: result, selectedTenantId: TENANT_A }).html;
    expect(html).toContain('data-usage-tenant="' + TENANT_A + '"');
    expect(html).toContain('data-usage-total="1"');
    expect(html).not.toContain('data-overview-tenant-required="true"');
  });

  it('is fail-closed when the roster read fails: empty select, no error text', async () => {
    const calls: string[] = [];
    const roster = new Response('ROSTER-BOOM <script>alert(1)</script>', { status: 500 });
    const result = await fetchOverview({
      tenantId: TENANT_A,
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls, roster),
    });
    const html = renderOverviewSection({ fetch: result, selectedTenantId: TENANT_A }).html;

    expect(html).not.toContain('ROSTER-BOOM');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<select name="tenantId"');
    expect(html).toContain('>Select a tenant</option>');
  });

  it('is fail-closed when the roster transport throws', async () => {
    const calls: string[] = [];
    const result = await fetchOverview({
      tenantId: TENANT_A,
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls, 'throw'),
    });
    const html = renderOverviewSection({ fetch: result, selectedTenantId: TENANT_A }).html;

    expect(html).not.toContain('roster transport boom');
    expect(html).toContain('<select name="tenantId"');
    expect(html).toContain('>Select a tenant</option>');
  });
});

describe('F-2 tenant roster reader (fail-closed, offline)', () => {
  it('reads no roster at all without an admin token', async () => {
    const calls: string[] = [];
    const options = await fetchTenantOptions({
      jsonBaseUrl: BASE,
      adminToken: '',
      fetchImpl: platformFetch(calls),
    });

    expect(options).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reads no roster without a base URL', async () => {
    const calls: string[] = [];
    const options = await fetchTenantOptions({
      jsonBaseUrl: '',
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls),
    });

    expect(options).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('drops rows that carry no usable id or name instead of rendering an id', async () => {
    const calls: string[] = [];
    const roster = jsonResponse({
      items: [
        { id: TENANT_A, name: 'Alpha', state: 'ACTIVE' },
        { id: 42, name: 'Numeric id' },
        { id: TENANT_B, name: '', state: 'ACTIVE' },
        null,
        'not-an-object',
      ],
      nextCursor: null,
      prevCursor: null,
      total: 5,
      limit: 200,
    });
    const options = await fetchTenantOptions({
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls, roster),
    });

    expect(options).toEqual([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }]);
  });

  it('follows the roster cursor and stops on a repeated one', async () => {
    const calls: string[] = [];
    let page = 0;
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      page += 1;
      if (page === 1) {
        return jsonResponse({
          items: [{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }],
          nextCursor: 'CURSOR-1',
          prevCursor: null,
          total: 2,
          limit: 200,
        });
      }
      // Same cursor again: a cycle must terminate, not loop.
      return jsonResponse({
        items: [{ id: TENANT_B, name: 'Beta', state: 'ACTIVE' }],
        nextCursor: 'CURSOR-1',
        prevCursor: null,
        total: 2,
        limit: 200,
      });
    }) as unknown as typeof fetch;

    const options = await fetchTenantOptions({
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl,
    });

    expect(options.map((option) => option.id)).toEqual([TENANT_A, TENANT_B]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('limit=200');
    expect(calls[1]).toContain('cursor=CURSOR-1');
  });

  it('returns no roster for an unreadable body', async () => {
    const calls: string[] = [];
    const roster = new Response('not json at all', { status: 200 });
    const options = await fetchTenantOptions({
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl: platformFetch(calls, roster),
    });

    expect(options).toEqual([]);
  });
});
