import { fetchOverview } from '../src/app/admin/overview-section-data';
import { renderOverviewSection } from '../src/app/admin/overview-section-renderer';
import { parseOperationListQuery } from '../src/app/admin/shell-router';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('admin overview triage viewport', () => {
  it('renders real operation and queue counts, filtered links, UTC presets, and unavailable connector health', async () => {
    const tenantId = 'tenant_a';
    const calls: string[] = [];
    const lastSweepAt = new Date().toISOString();
    const fetchImpl = (async (url: unknown) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('/api/v1/usage')) {
        return jsonResponse({ tenantId, rows: [], totals: {} });
      }
      if (href.includes('/api/v1/admin/audit')) {
        return jsonResponse({ tenantId, items: [], total: 0, limit: 50 });
      }
      if (href.includes('/api/v1/health')) {
        return jsonResponse({
          status: 'degraded',
          db: true,
          redis: false,
          activeLeases: 2,
          queueIntegrity: {
            state: 'SUSPECT',
            stalled: 2,
            lastSweepAt,
          },
        }, 503);
      }
      const state = new URL(href).searchParams.get('state');
      const counts: Record<string, number> = { FAILED: 4, TIMED_OUT: 0, RUNNING: 7 };
      return jsonResponse({ items: [], total: counts[state ?? ''] ?? 0, limit: 1 });
    }) as unknown as typeof fetch;

    const before = Date.now();
    const result = await fetchOverview({
      tenantId,
      timePreset: '24h',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: 'test-token',
      fetchImpl,
    });
    const after = Date.now();

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected overview result');
    expect(result.bundle.triage?.failed).toMatchObject({ status: 'available', value: 4 });
    expect(result.bundle.triage?.timedOut).toMatchObject({ status: 'available', value: 0 });
    expect(result.bundle.triage?.pending).toMatchObject({ status: 'available', value: 7 });
    expect(result.bundle.triage?.queueLag).toMatchObject({
      status: 'available',
      value: 2,
      detail: 'Integrity SUSPECT',
    });
    expect(result.bundle.triage?.connectorDegradations).toMatchObject({
      status: 'unavailable',
      value: null,
    });
    expect(new Date(result.from).getTime()).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 1000);
    expect(new Date(result.to).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(result.to).getTime()).toBeLessThanOrEqual(after + 1000);
    expect(calls).toHaveLength(6);
    expect(calls.filter((url) => url.includes('/api/v1/operations')).every((url) =>
      new URL(url).searchParams.get('tenant') === tenantId,
    )).toBe(true);

    const rendered = renderOverviewSection({
      fetch: result,
      selectedTenantId: tenantId,
      selectedTimePreset: '24h',
    });
    expect(rendered.html).toContain('data-overview-triage="true"');
    expect(rendered.html).toContain('data-overview-updated-at=');
    expect(rendered.html).toContain('value="24h" selected');
    expect(rendered.html).toContain('Last 24 hours (UTC)');
    expect(rendered.html).toContain('href="/admin"');
    expect(rendered.html).toContain('href="/admin/operations?state=FAILED&amp;tenant=tenant_a"');
    expect(rendered.html).toContain('href="/admin/operations?state=TIMED_OUT&amp;tenant=tenant_a"');
    expect(parseOperationListQuery({ state: 'FAILED', tenant: tenantId }).listFilters).toMatchObject({
      state: 'FAILED',
      tenant: tenantId,
    });
    expect(rendered.html).toContain('data-overview-metric="connector-degradations" data-metric-status="unavailable"');
    expect(rendered.html).toContain('Source unavailable');
    expect(rendered.html).toContain('No usage was recorded in this window.');
  });

  it('marks old queue snapshots stale and never turns missing totals into zero', async () => {
    const fetchImpl = (async (url: unknown) => {
      const href = String(url);
      if (href.includes('/api/v1/usage')) return jsonResponse({ rows: [], totals: {} });
      if (href.includes('/api/v1/admin/audit')) return jsonResponse({ items: [], total: 0 });
      if (href.includes('/api/v1/health')) {
        return jsonResponse({
          status: 'ok',
          db: true,
          redis: true,
          activeLeases: 0,
          queueIntegrity: {
            state: 'OK',
            stalled: 0,
            lastSweepAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          },
        });
      }
      const state = new URL(href).searchParams.get('state');
      return state === 'FAILED'
        ? jsonResponse({ items: [], total: 0 })
        : jsonResponse({ items: [], limit: 1 });
    }) as unknown as typeof fetch;

    const result = await fetchOverview({
      tenantId: '',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: 'test-token',
      fetchImpl,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected overview result');
    expect(result.bundle.triage?.failed).toMatchObject({ status: 'available', value: 0 });
    expect(result.bundle.triage?.timedOut.status).toBe('unavailable');
    expect(result.bundle.triage?.pending.status).toBe('unavailable');
    expect(result.bundle.triage?.queueLag).toMatchObject({ status: 'stale', value: 0 });

    const rendered = renderOverviewSection({ fetch: result });
    expect(rendered.html).toContain('data-overview-metric="failed" data-metric-status="available"');
    expect(rendered.html).toContain('data-overview-metric="queue-lag" data-metric-status="stale"');
    expect(rendered.html).toContain('data-overview-metric="pending" data-metric-status="unavailable"');
    expect(rendered.html).toContain('Stale snapshot');
    expect(rendered.html).toContain('Unavailable');
  });
});
